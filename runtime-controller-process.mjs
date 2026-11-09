import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute, dirname, basename } from 'node:path';

const CHANNEL = 'runtime-controller';
const LIMIT = 65536;
export function controllerEnvelope(value, session, kind) {
  return value && value.protocol === 1 && value.channel === CHANNEL && value.session === session && value.kind === kind &&
    Number.isSafeInteger(value.id) && value.id > 0 && Buffer.byteLength(JSON.stringify(value)) <= LIMIT;
}
export function controllerPacket(session, kind, id, fields) { return { protocol: 1, channel: CHANNEL, session, kind, id, ...fields }; }
export function controllerEnvironment(env = {}) {
  // An allowlist also removes unknown future vendor keys and Node preload flags.
  return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', GH_CONFIG_DIR: '/nonexistent',
    ...(env.LANG ? { LANG: env.LANG } : {}), ...(env.TZ ? { TZ: env.TZ } : {}) };
}
export function controllerStagePaths(state, args) {
  if (!Array.isArray(args) || args.length !== 2 || args.some(value => typeof value !== 'string' || !isAbsolute(value))) return false;
  const scratch = dirname(args[0]);
  return dirname(scratch) === join(state, 'updates') && /^download-[A-Za-z0-9]{6}$/.test(basename(scratch)) &&
    args[0] === join(scratch, 'manifest.json') && args[1] === join(scratch, 'blobs');
}

// The bootstrap owns these handles; release code can request only this protocol.
export function runtimeControllerProcess({ root = '/', state, currentSource, recovery = false, status, activity, stage, activate, completeDrain,
  onTerminal = () => {}, env = process.env, spawnProcess = spawn, timeout = 660000 }) {
  if (!isAbsolute(root) || !isAbsolute(state)) throw Error('Absolute controller paths required');
  const session = randomUUID(), pending = new Map();
  let child, sequence = 0, highwater = 0, failed = false, exited = false, inflight = 0, stopPromise;
  const fail = () => {
    const first = !failed;
    failed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Runtime controller outcome unknown')); }
    pending.clear();
    // Only this owned child handle is terminated. Its unknown command is never replayed.
    if (first && child && !exited) { try { child.kill('SIGTERM'); } catch {} }
  };
  const send = value => {
    if (exited || !child.connected) return;
    try { child.send(value, error => { if (error) fail(); }); } catch { fail(); }
  };
  const call = (method, args = []) => new Promise((resolve, reject) => {
    if (failed || exited || pending.size >= 8) return reject(Error('Runtime controller unavailable'));
    const id = ++sequence;
    const timer = setTimeout(() => { fail(); }, timeout); timer.unref?.();
    pending.set(id, { resolve, reject, timer, method });
    send(controllerPacket(session, 'command', id, { method, args }));
  });
  const callbacks = { status, activity, stage, activate, completeDrain };
  const receive = value => {
    if (failed || exited) return;
    if (controllerEnvelope(value, session, 'terminal') && Object.keys(value).length === 5 && value.id > highwater) {
      highwater = value.id; Promise.resolve().then(onTerminal).catch(fail); return;
    }
    if (controllerEnvelope(value, session, 'result') && Object.keys(value).every(key => ['protocol', 'channel', 'session', 'kind', 'id', 'ok', 'result'].includes(key)) && typeof value.ok === 'boolean') {
      const entry = pending.get(value.id);
      // Late replies cannot resolve a new session or a different command.
      if (!entry) { fail(); return; }
      pending.delete(value.id); clearTimeout(entry.timer);
      value.ok ? entry.resolve(value.result) : entry.reject(Error('Runtime controller operation unavailable'));
      if (entry.method === 'update' || entry.method === 'tick') Promise.resolve().then(onTerminal).catch(fail);
      return;
    }
    if (!controllerEnvelope(value, session, 'supervisor') ||
        Object.keys(value).some(key => !['protocol', 'channel', 'session', 'kind', 'id', 'method', 'args'].includes(key)) ||
        !Object.hasOwn(callbacks, value.method) || !Array.isArray(value.args) ||
        (value.method === 'stage' ? !controllerStagePaths(state, value.args) : value.args.length !== 0) || value.id <= highwater || inflight >= 8) { fail(); return; }
    highwater = value.id;
    inflight++;
    Promise.resolve().then(() => {
      if (failed || recovery && value.method !== 'status') throw Error('Runtime controller is read only');
      return callbacks[value.method](...value.args);
    }).then(result => send(controllerPacket(session, 'supervisor-result', value.id, { ok: true, result })),
      () => send(controllerPacket(session, 'supervisor-result', value.id, { ok: false }))).finally(() => inflight--);
  };
  child = spawnProcess(join(root, 'opt/t3/node'), [join(root, 'opt/t3-cloud/runtime-controller.mjs')],
    { cwd: '/', env: controllerEnvironment(env), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.on('message', receive);
  child.once('exit', () => { exited = true; fail(); }); child.on('error', fail); child.once('disconnect', fail);
  return {
    initialize: () => call('initialize', [{ state, currentSource, recovery, session }]),
    status: () => call('status'), check: () => call('check'), update: () => call('update'),
    setAutomatic: enabled => { if (typeof enabled !== 'boolean') throw Error('Invalid automatic update preference'); return call('automatic', [enabled]); },
    start: () => call('start'),
    stop() {
      return stopPromise ??= (async () => {
        if (exited) return;
        if (failed) throw Error('Runtime controller termination unknown');
        await call('stop');
        if (exited) return;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Runtime controller termination unknown')), 10000); timer.unref?.();
          child.once('exit', () => { clearTimeout(timer); resolve(); });
          child.disconnect();
        });
      })();
    },
    get alive() { return !exited; },
  };
}
