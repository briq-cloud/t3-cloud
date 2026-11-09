import { spawn } from 'node:child_process';
import { join } from 'node:path';

// The handle is the only process authority. Persisted PIDs never authorize kill.
export function runtimeProcess(env, { spawnProcess = spawn } = {}) {
  let child, sequence = 0, exited = true;
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
    async start(root, release) {
      if (!exited) throw Error('Owned manager already running');
      const selected = { ...env, PORT: '8082', T3_HOST: '127.0.0.1', T3_CLOUD_NATIVE_PORT: '8083', T3_CLOUD_SUPERVISED: '1',
        ...(release ? { T3_CLOUD_CHILD_IMAGE: release.childImage } : {}) };
      if (root === '/') delete selected.T3_RELEASE_ROOT; else selected.T3_RELEASE_ROOT = root;
      const shims = join(root, 'opt/t3-cloud/bin/release-shims');
      selected.PATH = `${shims}:/usr/bin:/bin`;
      selected.BROWSER = join(root, 'usr/local/bin/show-url');
      exited = false;
      child = spawnProcess(join(root, 'opt/t3/node'), [join(root, 'opt/t3-cloud/manager-main.mjs')],
        { cwd: env.T3_CWD, env: selected, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.on('message', value => {
        if (value?.protocol !== 1) return;
        const entry = pending.get(value.id); if (!entry) return;
        pending.delete(value.id); clearTimeout(entry.timer);
        if (value.ok) entry.resolve(value.result); else entry.reject(Error('Manager operation unavailable'));
      });
      child.once('exit', () => { exited = true; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Owned manager exited')); } pending.clear(); });
      child.on('error', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Owned manager failed')); } pending.clear(); });
      await request('health');
    },
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
  };
}
