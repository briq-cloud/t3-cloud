// Stable bootstrap protocol: no application dependencies, credential access or
// vendor tools. Released Node and manager code own the running application.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeSupervisor } from './runtime-supervisor.mjs';
import { runtimeProcess } from './runtime-process.mjs';

export function loaderFrontdoor({ port, host, target, admitting, managing = () => false }) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    let management = false;
    try { management = ['/_cloud', '/_cloud/', '/_cloud/login', '/_cloud/logout', '/_cloud/updates', '/_cloud/updates/status', '/_cloud/updates/check', '/_cloud/updates/update', '/_cloud/updates/automatic'].includes(new URL(req.url, 'http://localhost').pathname); } catch {}
    if (!admitting() && !(management && managing())) { res.writeHead(503, { 'cache-control': 'no-store', connection: 'close' }); return res.end(); }
    // Preserve the original Host/Origin/cookies. Existing manager/frontdoor
    // authorization and WebSocket validation run behind this byte-forwarder.
    const upstream = request({ hostname: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (!admitting()) return socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    const upstream = connect(target, '127.0.0.1', () => {
      const headers = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
  });
  return { server, async listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); },
    fence() { for (const socket of sockets) socket.destroy(); },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

export async function startLoader(env = process.env, {
  baseImageFile = '/etc/t3-cloud/base-image', sourceFile = '/etc/t3-cloud/source',
  createDriver = runtimeProcess, createSupervisor = options => new RuntimeSupervisor(options),
  createUpdates = async options => new (await import('/opt/t3-cloud/runtime-updates.mjs')).RuntimeUpdates(options),
  createRecoveryManager = async options => (await import('/opt/t3-cloud/manager.mjs')).createCloudManager(options),
} = {}) {
  const state = env.T3_CLOUD_STATE;
  if (!state?.startsWith('/')) throw Error('Absolute durable state required');
  const baseImage = (await readFile(baseImageFile, 'utf8')).trim();
  await mkdir(join(state, 'updates'), { recursive: true, mode: 0o700 });
  // Stale ownership requires explicit reconciliation. A timeout or old PID
  // never licenses another runtime or killing an unrelated process.
  const lock = join(state, 'updates', 'loader.lock');
  await mkdir(lock, { mode: 0o700 });
  const driver = createDriver(env);
  const supervisor = createSupervisor({ state, baseImage, driver });
  let updates, recoveryServer, closing, updateScheduled = false;
  const operations = async (method, enabled) => {
    if (!updates || closing) throw Error('Runtime updater unavailable');
    if (method === 'status') return updates.status();
    if (method === 'check') return updates.check();
    if (method === 'automatic') return updates.setAutomatic(enabled);
    if (method !== 'update') throw Error('Unknown runtime update operation');
    // Activation replaces the caller's manager. Acknowledge first; clients poll
    // durable status after reconnecting rather than replaying an unknown request.
    const status = await updates.status();
    if (!updateScheduled && !status.busy) {
      updateScheduled = true;
      setImmediate(() => {
        if (closing) { updateScheduled = false; return; }
        void updates.update().catch(() => {}).finally(() => { updateScheduled = false; });
      });
    }
    return { ...status, accepted: true };
  };
  driver.setUpdates(operations);
  const listeners = [loaderFrontdoor({ port: Number(env.PORT ?? 8080), host: env.T3_HOST ?? '0.0.0.0', target: 8082,
    admitting: () => supervisor.admitting && driver.alive, managing: () => driver.alive || Boolean(recoveryServer?.listening) })];
  if ((env.T3_CLOUD_ROLE ?? 'central') === 'central' && env.T3_CLOUD_NATIVE_ORIGIN) listeners.push(loaderFrontdoor({
    port: 8081, host: env.T3_HOST ?? '0.0.0.0', target: 8083, admitting: () => supervisor.admitting && driver.alive }));
  try {
    for (const listener of listeners) await listener.listen();
    const status = await supervisor.initialize();
    const selected = supervisor.journal.current === 'bootstrap' ? null : await supervisor.verifyRelease(supervisor.journal.current);
    let bootstrapSource = null;
    try { bootstrapSource = (await readFile(sourceFile, 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const currentSource = selected?.source ?? bootstrapSource;
    if (currentSource !== null && !/^[a-f0-9]{40}$/.test(currentSource)) throw Error('Pinned bootstrap source required');
    updates = await createUpdates({ state, currentSource, status: async () => supervisor.journal,
      activity: () => driver.activity(), stage: (file, blobs) => supervisor.stageRelease(file, blobs),
      activate: () => supervisor.activate(), completeDrain: () => supervisor.completeDrain() });
    await updates.initialize();
    if (status.recoveryRequired) {
      // Quarantine never starts the central runtime, credentials, native service
      // or terminal. Only the image's owner-authenticated update surface runs.
      recoveryServer = await createRecoveryManager({ role: env.T3_CLOUD_ROLE ?? 'central', publicOrigin: env.T3_CLOUD_PUBLIC_ORIGIN,
        ownerKey: env.T3_CLOUD_OWNER_KEY, ownerId: env.T3_CLOUD_OWNER_ID, managementOnly: true,
        runtimeUpdates: { status: () => operations('status'), check: () => operations('check'),
          update: () => operations('update'), automatic: enabled => operations('automatic', enabled) } });
      await new Promise((resolve, reject) => { recoveryServer.once('error', reject); recoveryServer.listen(8082, '127.0.0.1', resolve); });
    } else updates.start();
    return { supervisor, updates, status, close() {
      return closing ??= (async () => {
        await updates.stop();
        supervisor.admitting = false;
        for (const listener of listeners) listener.fence();
        if (recoveryServer) { recoveryServer.closeAllConnections(); await new Promise(resolve => recoveryServer.close(resolve)); }
        await supervisor.shutdown();
        await Promise.all(listeners.map(listener => listener.close()));
        await rm(lock, { recursive: true });
      })();
    } };
  } catch (error) {
    await updates?.stop();
    if (recoveryServer) { recoveryServer.closeAllConnections(); recoveryServer.close(); }
    supervisor.admitting = false;
    if (supervisor.journal && driver.alive) {
      await supervisor.save({ phase: 'recovery-required' });
      try { await driver.stop(); } catch { /* The lock retains ambiguous ownership. */ }
    }
    await Promise.all(listeners.map(listener => listener.close()));
    // A failed start may already have migrated state or spawned a child. Keep
    // the ownership lock and durable recovery phase for explicit reconciliation.
    throw error;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const loader = await startLoader();
    if (loader.status.recoveryRequired) process.stderr.write('T3 Cloud update requires explicit recovery; admission is closed\n');
    process.once('SIGTERM', () => { void loader.close().catch(() => { process.exitCode = 1; }); });
    process.once('SIGINT', () => { void loader.close().catch(() => { process.exitCode = 1; }); });
  } catch { process.stderr.write('T3 Cloud loader failed; inspect durable update state\n'); process.exitCode = 1; }
}
