import { edgeToken, withoutEdgeEnvironment } from './edge-auth.mjs';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createNativeFrontdoor, nativeOrigin } from './native-frontdoor.mjs';
import { createCloudManager } from './manager.mjs';
import { nativeConnections } from './native-connections.mjs';
import { publicOrigin, createOwnerAuth } from './cloud-auth.mjs';
import { withoutExecutingMcpEnvironment } from './briq-native.mjs';
import { runtimeUpdateClient } from './runtime-process.mjs';
import { runtimePath, runtimePathEnv } from './runtime-paths.mjs';

// Management and native admission have separate listeners; native processes stay loopback.
export async function startManager(env = process.env, { centralRuntime, spawnProcess = spawn, updates } = {}) {
  const role = env.T3_CLOUD_ROLE ?? 'central';
  if (!['central', 'standalone'].includes(role)) throw Error('Manager role must be central or standalone');
  const origin = publicOrigin(env.T3_CLOUD_PUBLIC_ORIGIN);
  const ownerAuth = createOwnerAuth({key:env.T3_CLOUD_OWNER_KEY,origin});
  if (role === 'central' && !/^[a-zA-Z0-9_-]{1,128}$/.test(env.T3_CLOUD_OWNER_ID ?? '')) throw Error('A stable owner identity is required');
  if (role === 'central' && edgeToken(env.T3_CLOUD_EDGE_TOKEN) === env.T3_CLOUD_OWNER_KEY) throw Error('Distinct private edge credential required');
  const phoneOrigin = role === 'central' && env.T3_CLOUD_NATIVE_ORIGIN ? nativeOrigin(env.T3_CLOUD_NATIVE_ORIGIN, origin) : undefined;
  const port = Number(env.PORT ?? 8080);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || [3773,7681,8081].includes(port)) throw Error('Invalid public port');
  const allocatorToken = randomBytes(32).toString('base64url');
  let runtime, connections, server, nativeServer;
  const runtimeUpdates = updates ?? (env.T3_CLOUD_SUPERVISED === '1' && process.send ? runtimeUpdateClient() : undefined);
  const children = [];
  const sockets = new Set();
  let stopping = false, draining = false;
  let closing;
  function close() {
    return closing ??= (async () => {
    stopping = true;
    nativeServer?.invalidateConnections();
    for (const socket of sockets) socket.destroy();
    server?.closeAllConnections(); server?.close(); nativeServer?.closeAllConnections(); nativeServer?.close(); connections?.close();
    await Promise.all(children.map(child => new Promise((resolve, reject) => {
      if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return resolve();
      if (!Number.isInteger(child.pid)) { child.kill('SIGTERM'); return resolve(); } // Injected test handles own no OS process.
      const timer = setTimeout(() => reject(Error('Owned native child termination unknown')), 10000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
    })));
    runtimeUpdates?.close?.();
    await runtime?.close?.();
    })();
  }
  try {
    if (role === 'central') {
      const factory = centralRuntime ?? (await import('./central-runtime.mjs')).createCentralRuntime;
      runtime = await factory(env);
    }
    connections = nativeConnections(env, { claudeCredentialOwner: runtime?.claudeCredentialOwner, briqCredentialOwner: runtime?.briqCredentialOwner });
    server = createCloudManager({ role, publicOrigin: origin, ownerKey: env.T3_CLOUD_OWNER_KEY,
      ownerId: env.T3_CLOUD_OWNER_ID, nativeOrigin: phoneOrigin,
      invalidateNativeConnections: () => { if (!nativeServer) throw Error('Native transport unavailable'); nativeServer.invalidateConnections(); }, allocatorToken, connections, ...runtime, runtimeUpdates, nativeAdmitting: () => !draining && !stopping, ready: () => !draining && !stopping && (runtime?.ready?.() ?? true) });
    if (phoneOrigin) nativeServer = createNativeFrontdoor({ publicOrigin: phoneOrigin, primaryOrigin: origin, ready: () => !draining && !stopping && runtime.ready(), ownerBearer: req => ownerAuth.ownerBearer(req) });
    for (const listener of [server, nativeServer].filter(Boolean)) {
      listener.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
      listener.on('error',()=>{process.exitCode=1;void close();});
    }
  const nativeEnv = { ...withoutExecutingMcpEnvironment(env), T3_CLOUD_ROLE: role };
  for (const key of Object.keys(nativeEnv)) if (key.startsWith('T3_CLOUD_')) delete nativeEnv[key];
  nativeEnv.T3_CLOUD_ROLE = role;
  nativeEnv.PATH = runtimePathEnv(env);
  if (role === 'central') {
    nativeEnv.T3_CLOUD_ALLOCATOR_URL = `http://127.0.0.1:${port}/_cloud/threads`;
    nativeEnv.T3_CLOUD_ALLOCATOR_TOKEN = allocatorToken;
    nativeEnv.T3_CLOUD_ADMITTED_PROVIDERS = JSON.stringify(runtime.admittedProviders ?? ['codex']);
  }
  function launch(command, args, childEnv) {
    const child = spawnProcess(command,args,{env:childEnv,cwd:env.T3_CWD,stdio:'ignore'});
    children.push(child);
    child.once('error',()=>{process.exitCode=1;void close();});
    child.once('exit',()=>{if(!stopping){process.exitCode=1;void close();}});
  }
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,env.T3_HOST ?? '0.0.0.0',resolve);});
    await runtime?.restore?.();
    launch(runtimePath(env, 'opt/t3/t3'),['serve','--host','127.0.0.1','--port','3773','--base-dir',env.T3_STATE,'--no-browser',env.T3_CWD],nativeEnv);
    const terminalEnv=withoutExecutingMcpEnvironment(withoutEdgeEnvironment(env));delete terminalEnv.T3_CLOUD_OWNER_KEY;delete terminalEnv.T3_CLOUD_ALLOCATOR_TOKEN;
    terminalEnv.PATH = runtimePathEnv(env);
    launch(env.T3_RELEASE_ROOT ? runtimePath(env, 'usr/local/bin/ttyd') : 'ttyd',
      ['--interface','127.0.0.1','--port','7681','--base-path','/_cloud/terminal','--writable','tmux','new-session','-A','-s','t3-cloud'],terminalEnv);
    if (nativeServer) await new Promise((resolve,reject)=>{nativeServer.once('error',reject);nativeServer.listen(Number(env.T3_CLOUD_NATIVE_PORT ?? 8081),env.T3_HOST ?? '0.0.0.0',resolve);});
    return {server,nativeServer,close,
      async drain() {
        if (role !== 'central' || !runtime?.drain || !runtime?.updateActivity) throw Error('Idle evidence unavailable');
        draining = true; runtime.drain(); nativeServer?.invalidateConnections();
      },
      async activity() {
        if (role !== 'central' || !runtime?.updateActivity || stopping) return { idle: false };
        const status = await runtime.updateActivity();
        return { ...status, idle: status.idle && server.updateRequests.size === 0 && !server.updateTerminalUsed && connections.updateIdle?.() === true };
      },
      async health() {
        if (stopping || !(runtime?.ready?.() ?? true)) throw Error('Runtime unavailable');
        const deadline = Date.now() + 30000;
        while (true) {
          try {
            await new Promise((resolve, reject) => {
              const req = get('http://127.0.0.1:3773/', res => { res.resume(); res.statusCode >= 200 && res.statusCode < 400 ? resolve() : reject(Error('Native health unavailable')); });
              req.setTimeout(1000, () => req.destroy()); req.once('error', reject);
            });
            return { ready: true };
          } catch { if (Date.now() >= deadline) throw Error('Native health unavailable'); }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      },
    };
  } catch(error) {await close();throw error;}
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const queued = [];
  const queue = value => { if (queued.length < 8) queued.push(value); };
  if (process.send) process.on('message', queue);
  try {
    if (process.env.T3_CLOUD_SUPERVISED === '1') (await import('./prepare.mjs')).prepare();
    const manager=await startManager();
    process.once('SIGTERM',()=>void manager.close());process.once('SIGINT',()=>void manager.close());
    if (process.send && process.env.T3_CLOUD_SUPERVISED === '1') {
      process.off('message', queue);
      const receive = async value => {
        if (value?.protocol !== 1 || !Number.isSafeInteger(value.id) || !['health','drain','activity','stop'].includes(value.method)) return;
        try {
          const result = value.method === 'stop' ? await manager.close() : await manager[value.method]();
          process.send?.({ protocol: 1, id: value.id, ok: true, result });
        } catch { process.send?.({ protocol: 1, id: value.id, ok: false }); }
      };
      process.on('message', receive);
      for (const value of queued) void receive(value);
      process.once('disconnect', () => { void manager.close().then(() => process.exit(0), () => process.exit(1)); });
    }
  } catch { process.stderr.write('T3 Cloud startup failed: verify private runtime configuration\n');process.exitCode=1; }
}
