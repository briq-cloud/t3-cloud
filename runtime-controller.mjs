import { RuntimeUpdates } from './runtime-updates.mjs';
import { controllerEnvelope, controllerPacket } from './runtime-controller-process.mjs';

// This entry and its imports run with the selected release's Node, never by an
// in-process import into the fixed bootstrap. No vendor credentials are inherited.
export function serveRuntimeController(channel = process, { createUpdates = options => new RuntimeUpdates(options), timeout = 660000 } = {}) {
  let session, updates, recovery, stopped = false, closed = false, sequence = 0, highwater = 0;
  const pending = new Map(), operations = new Set();
  const send = value => { try { channel.send(value, error => { if (error) close(); }); } catch { close(); } };
  const close = () => {
    stopped = true; closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Supervisor outcome unknown')); }
    pending.clear();
    void updates?.stop().catch(() => {});
    channel.off('message', receive);
  };
  const request = (method, ...args) => new Promise((resolve, reject) => {
    if (closed || !channel.connected || pending.size >= 8) return reject(Error('Supervisor unavailable'));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Supervisor outcome unknown')); }, timeout); timer.unref?.();
    pending.set(id, { resolve, reject, timer }); send(controllerPacket(session, 'supervisor', id, { method, args }));
  });
  const receive = value => {
    if (session && controllerEnvelope(value, session, 'supervisor-result') && typeof value.ok === 'boolean' &&
        Object.keys(value).every(key => ['protocol', 'channel', 'session', 'kind', 'id', 'ok', 'result'].includes(key))) {
      const item = pending.get(value.id); if (!item) return close();
      pending.delete(value.id); clearTimeout(item.timer);
      value.ok ? item.resolve(value.result) : item.reject(Error('Supervisor operation unavailable')); return;
    }
    const first = !session && value?.method === 'initialize' && typeof value.session === 'string' && /^[a-f0-9-]{36}$/.test(value.session);
    if (!controllerEnvelope(value, session ?? (first ? value.session : null), 'command') || value.id <= highwater ||
        Object.keys(value).some(key => !['protocol', 'channel', 'session', 'kind', 'id', 'method', 'args'].includes(key)) ||
        !['initialize', 'status', 'check', 'update', 'automatic', 'start', 'stop', 'tick'].includes(value.method) || !Array.isArray(value.args) ||
        (value.method === 'initialize' ? !first || value.args.length !== 1 : value.method === 'automatic' ? value.args.length !== 1 || typeof value.args[0] !== 'boolean' : value.args.length !== 0) || operations.size >= 8) return close();
    highwater = value.id; session ??= value.session;
    const operation = Promise.resolve().then(async () => {
      if (value.method === 'initialize') {
        const config = value.args[0];
        if (!config || Object.keys(config).some(key => !['state', 'currentSource', 'recovery', 'session'].includes(key)) || config.session !== session || typeof config.recovery !== 'boolean') throw Error('Invalid controller initialization');
        recovery = config.recovery;
        updates = createUpdates({ state: config.state, currentSource: config.currentSource,
          status: () => request('status'), activity: () => request('activity'), stage: (...args) => request('stage', ...args),
          activate: () => request('activate'), completeDrain: () => request('completeDrain') });
        const tick = updates.tick.bind(updates);
        updates.tick = (...args) => tick(...args).finally(() => setImmediate(() => { if (!closed) send(controllerPacket(session, 'terminal', ++sequence, {})); }));
        // Unknown migrations must still leave a read-only owner inspection surface.
        if (!recovery) await updates.initialize();
        // Read the durable receipt before timers can run. A committed activation
        // survives loss of the old controller reply; a pending one is never replayed.
        const journal = await request('status');
        if (!recovery && journal.receipt?.status === 'committed' && journal.receipt.to === journal.current && updates.record.staged?.identity === journal.current)
          await updates.save({ outcome: 'activated' });
        return updates.status();
      }
      if (!updates || stopped && value.method !== 'stop') throw Error('Controller unavailable');
      if (value.method === 'status') return updates.status();
      if (value.method === 'stop') { stopped = true; await updates.stop(); return {}; }
      if (recovery) { if (value.method === 'start') return {}; throw Error('Controller is read only'); }
      if (value.method === 'start') { updates.start(); return {}; }
      if (value.method === 'automatic') return updates.setAutomatic(value.args[0]);
      return updates[value.method]();
    });
    operations.add(operation);
    operation.then(result => send(controllerPacket(session, 'result', value.id, { ok: true, result })),
      () => send(controllerPacket(session, 'result', value.id, { ok: false }))).finally(() => operations.delete(operation));
  };
  channel.on('message', receive); channel.once('disconnect', close);
  return { close };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  serveRuntimeController();
  process.once('disconnect', () => { process.exitCode = 0; });
}
