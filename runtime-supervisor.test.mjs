import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeSupervisor } from './runtime-supervisor.mjs';

const version = `sha256:${'a'.repeat(64)}`, baseImage = `sha256:${'b'.repeat(64)}`;
async function fixture(t) {
  const state = await mkdtemp(join(tmpdir(), 't3-activate-')); t.after(() => rm(state, { recursive: true, force: true }));
  const calls = []; let idle = true, failHealth = false;
  const driver = { start: async root => calls.push(['start', root]), stop: async () => calls.push(['stop']),
    health: async () => { calls.push(['health']); if (failHealth) throw Error('unhealthy'); },
    drain: async () => calls.push(['drain']), activity: async () => ({ idle }) };
  const supervisor = new RuntimeSupervisor({ state, baseImage, driver,
    stage: async () => ({ identity: version }), verify: async () => { calls.push(['verify']); return { childImage: 'image' }; } });
  await supervisor.initialize();
  return { state, calls, driver, supervisor, idle: value => { idle = value; }, failHealth: () => { failHealth = true; },
    journal: async () => JSON.parse(await readFile(join(state, 'updates/activation.json'), 'utf8')) };
}

test('activation persists desired and fences admission until real drain and health succeed', async t => {
  const f = await fixture(t); await f.supervisor.stageRelease('/manifest', '/blobs'); f.idle(false);
  assert.deepEqual(await f.supervisor.activate(), { pending: true, reason: 'owned-activity' });
  assert.equal(f.supervisor.admitting, false); assert.equal((await f.journal()).desired, version);
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 0);
  f.idle(true); assert.deepEqual(await f.supervisor.completeDrain(), { pending: false, identity: version });
  const j = await f.journal(); assert.equal(j.current, version); assert.equal(j.receipt.status, 'committed');
  assert.equal(j.desired, null); assert.equal(f.supervisor.admitting, true);
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
});

test('ambiguous running or interrupted activation restart never resumes a native session', async t => {
  const f = await fixture(t);
  const next = new RuntimeSupervisor({ state: f.state, baseImage, driver: { start() { assert.fail('must not start'); } } });
  assert.deepEqual(await next.initialize(), { recoveryRequired: true }); assert.equal(next.admitting, false);
  await f.supervisor.stageRelease('/manifest', '/blobs'); f.idle(false); await f.supervisor.activate();
  const interrupted = new RuntimeSupervisor({ state: f.state, baseImage, driver: { start() { assert.fail('must not replay'); } } });
  assert.deepEqual(await interrupted.initialize(), { recoveryRequired: true });
});

test('new runtime health failure retains old current and desired without automatic rollback', async t => {
  const f = await fixture(t); await f.supervisor.stageRelease('/manifest', '/blobs'); f.failHealth();
  await assert.rejects(f.supervisor.activate(), /unhealthy/);
  const j = await f.journal(); assert.equal(j.current, 'bootstrap'); assert.equal(j.desired, version);
  assert.equal(j.phase, 'recovery-required'); assert.equal(f.supervisor.admitting, false);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 2);
});

test('clean shutdown allows the same committed runtime on next boot', async t => {
  const f = await fixture(t); await f.supervisor.shutdown();
  assert.equal((await f.journal()).phase, 'stopped');
  const next = new RuntimeSupervisor({ state: f.state, baseImage, driver: f.driver });
  assert.deepEqual(await next.initialize(), { recoveryRequired: false });
});
