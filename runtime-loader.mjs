// Stable bootstrap protocol: no application dependencies, credential access or
// vendor tools. Released Node and manager code own the running application.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeSupervisor } from './runtime-supervisor.mjs';
import { runtimeProcess } from './runtime-process.mjs';

export function loaderFrontdoor({ port, host, target, admitting }) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (!admitting()) { res.writeHead(503, { 'cache-control': 'no-store', connection: 'close' }); return res.end(); }
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

export async function startLoader(env = process.env) {
  const state = env.T3_CLOUD_STATE;
  if (!state?.startsWith('/')) throw Error('Absolute durable state required');
  const baseImage = (await readFile('/etc/t3-cloud/base-image', 'utf8')).trim();
  await mkdir(join(state, 'updates'), { recursive: true, mode: 0o700 });
  // Stale ownership requires explicit reconciliation. A timeout or old PID
  // never licenses another runtime or killing an unrelated process.
  const lock = join(state, 'updates', 'loader.lock');
  await mkdir(lock, { mode: 0o700 });
  const driver = runtimeProcess(env);
  const supervisor = new RuntimeSupervisor({ state, baseImage, driver });
  const listeners = [loaderFrontdoor({ port: Number(env.PORT ?? 8080), host: env.T3_HOST ?? '0.0.0.0', target: 8082,
    admitting: () => supervisor.admitting && driver.alive })];
  if ((env.T3_CLOUD_ROLE ?? 'central') === 'central' && env.T3_CLOUD_NATIVE_ORIGIN) listeners.push(loaderFrontdoor({
    port: 8081, host: env.T3_HOST ?? '0.0.0.0', target: 8083, admitting: () => supervisor.admitting && driver.alive }));
  try {
    for (const listener of listeners) await listener.listen();
    const status = await supervisor.initialize();
    return { supervisor, status, async close() {
      supervisor.admitting = false;
      for (const listener of listeners) listener.fence();
      await supervisor.shutdown();
      await Promise.all(listeners.map(listener => listener.close()));
      await rm(lock, { recursive: true });
    } };
  } catch (error) {
    supervisor.admitting = false;
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
