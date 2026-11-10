import { spawn } from 'node:child_process';
import { join } from 'node:path';

// The handle is the only process authority. Persisted PIDs never authorize kill.
export function runtimeProcess(env, { spawnProcess = spawn } = {}) {
  let child, sequence = 0, exited = true, updates;
  let updateRequests = 0;
  let startupFailure = null;
  const pending = new Map();
  function request(method) {
    if (!child || exited) return Promise.reject(Error('Owned manager unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('Manager outcome unknown')); }, 40000);
      pending.set(id, { resolve, reject, timer });
      child.send({ protocol: 1, id, method }, error => {
        if (error && pending.delete(id)) { clearTimeout(timer); reject(Error('Manager IPC unavailable')); }
      });
    });
  }
  return {
    async start(root, release, { recovery = false } = {}) {
      if (!exited) throw Error('Owned manager already running');
      const selected = { ...env, T3_CLOUD_RECOVERY: recovery ? '1' : '0', PORT: '8082', T3_HOST: '127.0.0.1', T3_CLOUD_NATIVE_PORT: '8083', T3_CLOUD_SUPERVISED: '1',
        ...(release ? { T3_CLOUD_CHILD_IMAGE: release.childImage } : {}) };
      if (root === '/') delete selected.T3_RELEASE_ROOT; else selected.T3_RELEASE_ROOT = root;
      const shims = join(root, 'opt/t3-cloud/bin/release-shims');
      selected.PATH = `${shims}:/usr/bin:/bin`;
      selected.BROWSER = join(root, 'usr/local/bin/show-url');
      exited = false;
      startupFailure = null;
      child = spawnProcess(join(root, 'opt/t3/node'), [join(root, 'opt/t3-cloud/manager-main.mjs')],
        { cwd: env.T3_CWD, env: selected, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.on('message', value => {
        if (value?.protocol !== 1) return;
        if (value.channel === 'runtime-startup') {
          if (Object.keys(value).length === 3 && ['preparing', 'configuration', 'central-runtime', 'management', 'listening', 'restoring', 'native'].includes(value.stage)) startupFailure = value.stage;
          return;
        }
        if (value.channel === 'runtime-updates') {
          const current = child;
          const respond = payload => {
            if (!current.connected) return;
            try { current.send({ protocol: 1, channel: 'runtime-updates', id: value.id, ...payload }, () => {}); } catch {}
          };
          if (!Number.isSafeInteger(value.id) || value.id < 1 || !['status', 'check', 'update', 'automatic'].includes(value.method) ||
              Object.keys(value).some(key => !['protocol', 'channel', 'id', 'method', 'enabled'].includes(key)) ||
              (value.method === 'automatic' ? typeof value.enabled !== 'boolean' : value.enabled !== undefined)) return;
          if (!updates || updateRequests >= 8) { respond({ ok: false }); return; }
          updateRequests++;
          Promise.resolve().then(() => updates(value.method, value.enabled)).then(
            result => respond({ ok: true, result }),
            () => respond({ ok: false }),
          ).finally(() => updateRequests--);
          return;
        }
        if (value.channel !== undefined) return;
        const entry = pending.get(value.id); if (!entry) return;
        pending.delete(value.id); clearTimeout(entry.timer);
        if (!value.ok && ['preparing', 'configuration', 'central-runtime', 'management', 'listening', 'restoring', 'native'].includes(value.startupStage)) startupFailure = value.startupStage;
        if (value.ok) entry.resolve(value.result); else entry.reject(Error('Manager operation unavailable'));
      });
      child.once('exit', () => { exited = true; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Owned manager exited')); } pending.clear(); });
      child.on('error', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Owned manager failed')); } pending.clear(); });
      await request('health');
    },
    setUpdates(handler) { updates = handler; },
    health: () => request('health'), drain: () => request('drain'), activity: () => request('activity'),
    async stop() {
      if (!child || exited) return;
      const current = child;
      await request('stop');
      if (exited) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Owned manager termination unknown')), 10000);
        current.once('exit', () => { clearTimeout(timer); resolve(); });
        // Acknowledged shutdown closes descendants first. No group/process-name
        // signal can accidentally kill another shell, sandbox or owner process.
        current.disconnect();
      });
    },
    get alive() { return Boolean(child && !exited); },
    get startupFailure() { return startupFailure; },
  };
}

// This channel is inherited only by the owned manager, never HTTP callers or
// native descendants. Callers can select operations, never paths or URLs.
export function runtimeUpdateClient(channel = process) {
  let sequence = 0;
  const pending = new Map();
  const receive = value => {
    if (value?.protocol !== 1 || value.channel !== 'runtime-updates') return;
    const entry = pending.get(value.id); if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    value.ok ? entry.resolve(value.result) : entry.reject(Error('Runtime update unavailable'));
  };
  const close = () => {
    channel.off('message', receive);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Runtime update channel closed')); }
    pending.clear();
  };
  channel.on('message', receive); channel.once('disconnect', close);
  const call = (method, enabled) => new Promise((resolve, reject) => {
    if (!channel.connected || !channel.send || pending.size >= 8) return reject(Error('Runtime update unavailable'));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Runtime update outcome unknown')); }, 40000);
    pending.set(id, { resolve, reject, timer });
    channel.send({ protocol: 1, channel: 'runtime-updates', id, method, ...(method === 'automatic' ? { enabled } : {}) }, error => {
      if (error && pending.delete(id)) { clearTimeout(timer); reject(Error('Runtime update channel unavailable')); }
    });
  });
  return { status: () => call('status'), check: () => call('check'), update: () => call('update'), automatic: enabled => call('automatic', enabled), close };
}
