// Stable bootstrap protocol: no application dependencies, credential access or
// vendor tools. Released Node and manager code own the running application.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeSupervisor } from './runtime-supervisor.mjs';
import { runtimeProcess } from './runtime-process.mjs';
import { runtimeControllerProcess } from './runtime-controller-process.mjs';
import { readBootstrapMigration, recoverBootstrapMigration } from './runtime-bootstrap-migration.mjs';
import { acquireRuntimeOwnership } from './runtime-ownership.mjs';

export function loaderFrontdoor({ port, host, target, admitting, managing = () => false }) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    let management = false;
    try { management = ['/_cloud', '/_cloud/', '/_cloud/login', '/_cloud/logout', '/_cloud/updates', '/_cloud/updates/status', '/_cloud/updates/check', '/_cloud/updates/update', '/_cloud/updates/automatic', '/_cloud/updates/reconcile'].includes(new URL(req.url, 'http://localhost').pathname); } catch {}
    if (!admitting() && !(management && managing())) { res.writeHead(503, { 'cache-control': 'no-store', connection: 'close' }); return res.end(); }
    // Preserve the original Host/Origin/cookies. Existing manager/frontdoor
    // authorization and WebSocket validation run behind this byte-forwarder.
    const upstream = request({ agent: false, hostname: '127.0.0.1', port: typeof target === 'function' ? target() : target, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (!admitting()) return socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    const upstream = connect(typeof target === 'function' ? target() : target, '127.0.0.1', () => {
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
  environmentBinding = env.T3_CLOUD_OWNER_ID, acquireOwnership = acquireRuntimeOwnership,
  baseImageFile = '/etc/t3-cloud/base-image', sourceFile = '/etc/t3-cloud/source',
  readMigration = readBootstrapMigration, recoverMigration = recoverBootstrapMigration,
  createDriver = runtimeProcess, createSupervisor = options => new RuntimeSupervisor(options),
  createUpdates = options => runtimeControllerProcess(options),
  createRecoveryManager = async options => (await import('/opt/t3-cloud/manager.mjs')).createCloudManager(options),
} = {}) {
  const state = env.T3_CLOUD_STATE;
  if (!state?.startsWith('/')) throw Error('Absolute durable state required');
  const baseImage = (await readFile(baseImageFile, 'utf8')).trim();
  await mkdir(join(state, 'updates'), { recursive: true, mode: 0o700 });
  let migration;
  try { migration = await readMigration(state); } catch { migration = { phase: 'invalid' }; }
  const migrationPending = migration && migration.phase !== 'completed';
  const ownership = await acquireOwnership({ directory: join(state, 'updates'), name: 'loader', environmentBinding, deferClaim: Boolean(migrationPending), legacy: join(state, 'updates', 'loader.lock') });
  const driver = createDriver(env);
  const supervisor = createSupervisor({ state, baseImage, driver });
  let updates, recoveryServer, closing, controllerIdentity, controllerRecovery, controllerFault = false, bootstrapSource = null, transition, updateScheduled = false;
  const fenceAdmission = () => { controllerFault = true; supervisor.admitting = false; for (const listener of listeners) listener.fence(); };
  const createController = async recovery => {
    const current = supervisor.journal.current;
    const selected = !recovery && current !== 'bootstrap' ? await supervisor.verifyRelease(current) : null;
    const currentSource = selected?.source ?? (current === 'bootstrap' ? bootstrapSource : null);
    if (currentSource !== null && !/^[a-f0-9]{40}$/.test(currentSource)) throw Error('Pinned bootstrap source required');
    const controller = await createUpdates({ root: recovery ? '/' : supervisor.releaseRoot(current), state, currentSource, recovery, env,
      status: async () => supervisor.journal, activity: () => driver.activity(),
      stage: (file, blobs) => supervisor.stageRelease(file, blobs), activate: () => supervisor.activate(),
      completeDrain: () => supervisor.completeDrain(), onTerminal: () => replaceController(false),
      onFailure: fenceAdmission });
    try { await controller.initialize(); } catch (error) { try { await controller.stop(); } catch {} throw error; }
    controllerIdentity = current; controllerRecovery = recovery;
    return controller;
  };
  const replaceController = (force = false) => {
    if (closing) return Promise.resolve();
    if (transition) return transition;
    const journal = supervisor.journal;
    if (!force && (controllerIdentity === journal.current || journal.desired || journal.receipt?.status !== 'committed' || journal.receipt.to !== journal.current)) return Promise.resolve();
    // The child has sent its terminal response. Join its owned process before
    // reading preferences or allowing the next release's scheduler to run.
    transition = (async () => {
      await updates.stop();
      if (closing) return;
      updates = await createController(false);
      await updates.start();
    })().catch(async error => {
      fenceAdmission();
      await supervisor.save({ phase: 'recovery-required' });
      throw error;
    }).finally(() => { transition = null; });
    return transition;
  };
  const operations = async (method, enabled) => {
    if (transition) await transition;
    if (!updates || closing) throw Error('Runtime updater unavailable');
    if (method === 'status' && migrationPending && recoveryServer) {
      try { migration = await readMigration(state) ?? { phase: 'invalid' }; } catch { migration = { phase: 'invalid' }; }
    }
    if (method === 'status') return { ...await updates.status(), recovery: { ownership: ownership.evidence, ownershipRevision: ownership.revision, journalRevision: supervisor.journal.revision ?? 0, bindingsQuarantined: Boolean(supervisor.journal.recovery), required: Boolean(recoveryServer), available: migrationPending ? migration.phase !== 'invalid' : supervisor.recoverable(), ...(migrationPending && recoveryServer ? { migration: { id: migration.id, revision: migration.revision } } : {}) } };
    if (method === 'reconcile') {
      if (!recoveryServer || closing) throw Error('Recovery management unavailable');
      // The recovery surface owns 8084; the explicitly recovered manager uses
      // 8082. Close it after the HTTP acknowledgement has been forwarded.
      if (migrationPending) await recoverMigration({ state, env, source: bootstrapSource, baseImage, supervisor, ownership, input: enabled });
      else await supervisor.reconcile(enabled);
      migration = await readMigration(state);
      const prior = recoveryServer; recoveryServer = null;
      setImmediate(() => prior.close());
      await replaceController(controllerRecovery);
      return operations('status');
    }
    if (migrationPending && recoveryServer) throw Error('Initial bootstrap recovery required');
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
  const listeners = [loaderFrontdoor({ port: Number(env.PORT ?? 8080), host: env.T3_HOST ?? '0.0.0.0', target: () => recoveryServer ? 8084 : 8082,
    admitting: () => !controllerFault && supervisor.admitting && driver.alive, managing: () => driver.alive || Boolean(recoveryServer?.listening) })];
  if ((env.T3_CLOUD_ROLE ?? 'central') === 'central' && env.T3_CLOUD_NATIVE_ORIGIN) listeners.push(loaderFrontdoor({
    port: 8081, host: env.T3_HOST ?? '0.0.0.0', target: 8083, admitting: () => !controllerFault && supervisor.admitting && driver.alive }));
  try {
    for (const listener of listeners) await listener.listen();
    const status = await supervisor.initialize({ ownership, bootstrapMigration: migrationPending ? migration.id ?? 'invalid' : false, initialMigrationReceipt: migration?.id ?? null });
    try { bootstrapSource = (await readFile(sourceFile, 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    updates = await createController(Boolean(status.recoveryRequired));
    if (status.recoveryRequired) {
      // Quarantine never starts the central runtime, credentials, native service
      // or terminal. Only the image's owner-authenticated update surface runs.
      recoveryServer = await createRecoveryManager({ role: env.T3_CLOUD_ROLE ?? 'central', publicOrigin: env.T3_CLOUD_PUBLIC_ORIGIN,
        ownerKey: env.T3_CLOUD_OWNER_KEY, ownerId: env.T3_CLOUD_OWNER_ID, managementOnly: true,
        runtimeUpdates: { status: () => operations('status'), check: () => operations('check'),
          update: () => operations('update'), automatic: enabled => operations('automatic', enabled), reconcile: input => operations('reconcile', input) } });
      await new Promise((resolve, reject) => { recoveryServer.once('error', reject); recoveryServer.listen(8084, '127.0.0.1', resolve); });
    } else await updates.start();
    return { supervisor, get updates() { return updates; }, status, close() {
      if (closing) return closing;
      // Fence before joining either updater work or a release transition. An
      // unknown stop must never leave established sockets serving native work.
      fenceAdmission();
      return closing = (async () => {
        let stopped = false;
        try {
          await transition;
          await updates.stop();
          stopped = true;
          await supervisor.shutdown();
        } finally {
          if (recoveryServer) { recoveryServer.closeAllConnections(); await new Promise(resolve => recoveryServer.close(resolve)); }
          await Promise.all(listeners.map(listener => listener.close()));
          // A failed join retains ambiguous durable ownership; no replay or
          // supervisor mutation is attempted while updater work is unknown.
          await ownership.close({ clean: stopped && !driver.alive });
        }
      })();
    } };
  } catch (error) {
    fenceAdmission();
    try { await updates?.stop(); } catch { /* Preserve unknown ownership and the original startup failure. */ }
    if (recoveryServer) { recoveryServer.closeAllConnections(); recoveryServer.close(); }
    supervisor.admitting = false;
    if (supervisor.journal && driver.alive) {
      await supervisor.save({ phase: 'recovery-required' });
      try { await driver.stop(); } catch { /* The lock retains ambiguous ownership. */ }
    }
    await Promise.all(listeners.map(listener => listener.close()));
    // A failed start may already have migrated state or spawned a child. Keep
    // the ownership lock and durable recovery phase for explicit reconciliation.
    await ownership.close();
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
