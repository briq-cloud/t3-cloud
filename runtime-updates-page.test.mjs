import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { runtimeUpdatesPage } from './runtime-updates-page.mjs';

async function page(operation, { available = true, mutation = async () => ({}), updateStatus } = {}) {
  const nodes = new Map(), requests = [], timers = new Map(); let sequence = 0;
  const element = id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
  const status = updateStatus ?? { busy: operation?.outcome === 'in-progress', phase: 'stopped', current: 'bootstrap', checkedAt: null,
    recovery: { required: true, available, journalRevision: 1, ownershipRevision: 'a'.repeat(64), operation } };
  const context = vm.createContext({
    document: { getElementById: element }, window: { addEventListener() {} },
    location: { replace() {} },
    setTimeout: callback => { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (path, options) => {
      requests.push({ path, method: options.method });
      if (options.method === 'POST') {
        const result = await mutation();
        return { ok: true, json: async () => result };
      }
      return { ok: true, json: async () => status };
    },
  });
  const html = runtimeUpdatesPage({ nonce: 'test', authorized: true });
  const script = html.match(/<script nonce="test">([\s\S]*)<\/script>/)[1];
  await vm.runInContext(script, context);
  return { element, requests, timers, refresh: () => vm.runInContext('refresh()', context) };
}

test('recovery page displays current-process stage and unresolved outcome without enabling retry', async () => {
  const p = await page({ outcome: 'unresolved', stage: 'materializing', processLocal: true });
  assert.match(p.element('recovery-operation').textContent, /Installing prepared runtime: Outcome unresolved/);
  assert.match(p.element('recovery-operation').textContent, /current process observation/);
  assert.equal(p.element('recover').disabled, true);
  await p.element('recover').onclick();
  assert.equal(p.requests.filter(r => r.method === 'POST').length, 0);
});

test('recovery page polls GET status while POST is pending and never repeats an unknown request', async () => {
  let reject, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const p = await page(null, { mutation: () => { entered(); return new Promise((_, fail) => { reject = fail; }); } });
  const pending = p.element('recover').onclick();
  await started;
  assert.equal(p.timers.size, 1); assert.equal(p.element('recover').disabled, true);
  await [...p.timers.values()][0]();
  assert.equal(p.requests.filter(r => r.path.endsWith('/status')).length, 2);
  assert.equal(p.element('recover').disabled, true);
  await p.element('recover').onclick();
  assert.equal(p.requests.filter(r => r.method === 'POST').length, 1);
  reject(Error('Transport outcome unknown')); await pending;
  await p.refresh();
  await p.element('recover').onclick();
  assert.equal(p.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(p.element('recover').disabled, true);
});

test('recovery page renders live and completed stages through text content', async () => {
  for (const [outcome, stage, label] of [['in-progress', 'verifying', 'Verifying installed runtime: In progress'], ['completed', 'completed', 'Recovery complete: Completed']]) {
    const p = await page({ outcome, stage, processLocal: true }, { available: false });
    assert.match(p.element('recovery-operation').textContent, new RegExp(label));
    assert.equal(p.element('recover').disabled, true);
  }
});

test('update page observes GET status during a pending POST and fences stale-status duplicates', async () => {
  let resolve, entered;
  const started = new Promise(done => { entered = done; });
  const status = { busy: false, phase: 'running', outcome: 'available', available: { version: 'next' }, checkedAt: null };
  const p = await page(null, { updateStatus: status, mutation: () => {
    entered(); return new Promise(done => { resolve = done; });
  } });
  assert.equal(p.element('update').disabled, false);
  const pending = p.element('update').onclick();
  await p.element('update').onclick();
  await started;
  assert.equal(p.timers.size, 1);
  await [...p.timers.values()][0]();
  assert.equal(p.requests.filter(r => r.path.endsWith('/status')).length, 2);
  assert.equal(p.element('update').disabled, true);
  await p.element('update').onclick();
  assert.equal(p.requests.filter(r => r.method === 'POST').length, 1);
  status.outcome = 'activated'; status.currentSource = 'b'.repeat(64);
  await [...p.timers.values()][0]();
  assert.equal(p.element('status').textContent, 'Update complete');
  assert.equal(p.element('current').textContent, 'Current version: ' + 'b'.repeat(12));
  resolve({}); await pending;
  assert.equal(p.requests.filter(r => r.method === 'POST').length, 1);
});

test('update page keeps GET observation and its duplicate fence after a disconnected POST reply', async () => {
  let reject, entered;
  const started = new Promise(done => { entered = done; });
  const p = await page(null, { updateStatus: {
    busy: false, phase: 'running', outcome: 'available', available: { version: 'next' }, checkedAt: null,
  }, mutation: () => { entered(); return new Promise((_, fail) => { reject = fail; }); } });
  const pending = p.element('update').onclick();
  await started;
  reject(Error('Transport outcome unknown')); await pending;
  assert.equal(p.timers.size, 1);
  await [...p.timers.values()][0]();
  assert.equal(p.requests.filter(r => r.path.endsWith('/status')).length, 2);
  assert.equal(p.element('update').disabled, true);
  await p.element('update').onclick();
  assert.equal(p.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(p.timers.size, 1);
});
