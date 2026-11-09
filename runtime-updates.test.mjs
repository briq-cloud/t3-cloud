import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeUpdates, readReleaseAsset, runtimeReleaseConsumer, selectRuntimeRelease } from './runtime-updates.mjs';

const source = 'a'.repeat(40), currentSource = 'b'.repeat(40), digest = `sha256:${'c'.repeat(64)}`;
const release = () => ({ tag_name: `runtime-${source}`, draft: false, prerelease: false, published_at: '2026-11-09T00:00:00Z', assets: [
  { name: 'manifest.json', size: 2, state: 'uploaded' }, { name: 'runtime-blobs.tar', size: 1024, state: 'uploaded' },
] });
const selected = () => selectRuntimeRelease([release()]);
const asset = name => `https://github.com/briq-cloud/t3-cloud/releases/download/runtime-${source}/${name}`;
async function fixture(t, changes = {}) {
  const state = await mkdtemp(join(tmpdir(), 't3-update-test-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const journal = { current: 'bootstrap', staged: null, desired: null, phase: 'running' }, calls = [];
  let clock = 100;
  const options = { state, currentSource, now: () => clock, status: async () => journal, activity: async () => ({ idle: true }),
    activate: async () => { calls.push('activate'); return { pending: false, identity: digest }; },
    completeDrain: async () => { calls.push('complete'); return { pending: true }; },
    consumer: { check: async () => { calls.push('check'); return selected(); }, stage: async () => { calls.push('stage'); journal.staged = digest; return { identity: digest }; } }, ...changes };
  const controller = new RuntimeUpdates(options);
  await controller.initialize();
  return { controller, state, journal, calls, options, setClock: value => { clock = value; } };
}

test('release selection pins canonical source and rejects oversized or duplicate assets', () => {
  const row = release();
  assert.equal(selected().source, source);
  assert.equal(selectRuntimeRelease([{ ...row, tag_name: '../bad' }]), null);
  assert.equal(selectRuntimeRelease([{ ...row, prerelease: true }]), null);
  assert.throws(() => selectRuntimeRelease([{ ...row, assets: [...row.assets, row.assets[0]] }]));
  assert.throws(() => selectRuntimeRelease([{ ...row, assets: row.assets.map(a => ({ ...a, size: 2_000_000_000 })) }]));
});

test('transport rejects arbitrary URLs and hostile redirects without following them', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://attacker.example/archive' } }); };
  await assert.rejects(readReleaseAsset('https://attacker.example/archive', { limit: 10, fetch }));
  assert.equal(calls, 0);
  await assert.rejects(readReleaseAsset(asset('manifest.json'), { limit: 10, fetch }));
  assert.equal(calls, 1);
  for (const url of [asset('manifest.json') + '?token=secret', asset('manifest.json').replace('github.com', 'github.com.evil.example'), asset('manifest.json').replace('https:', 'http:')]) {
    await assert.rejects(readReleaseAsset(url, { limit: 10, fetch }));
  }
  assert.equal(calls, 1);
});

test('transport allows bounded GitHub asset redirects without authorization headers', async () => {
  const seen = [];
  const fetch = async (url, options) => {
    seen.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.authorization, undefined);
    return seen.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/1450999885/archive?signature=opaque' } }) : new Response('ok');
  };
  assert.equal((await readReleaseAsset(asset('manifest.json'), { limit: 2, expectedSize: 2, fetch })).toString(), 'ok');
  assert.equal(seen.length, 2);
  await assert.rejects(readReleaseAsset(asset('manifest.json'), { limit: 2, fetch: async () => new Response('too big') }));
  await assert.rejects(readReleaseAsset(asset('manifest.json'), { limit: 20, expectedSize: 2, fetch: async () => new Response('x') }));
});

test('consumer pins manifest source before fetching archive and cleans failed downloads', async t => {
  const { state } = await fixture(t);
  const calls = [];
  const consumer = runtimeReleaseConsumer({ state, stage: async () => { calls.push('stage'); },
    fetch: async url => { calls.push(url); return new Response('{}'); },
    verifyManifest: async () => ({ manifest: { source: currentSource } }), verifyArchive: async () => { calls.push('archive'); } });
  await assert.rejects(consumer.stage(selected()));
  assert.deepEqual(calls, [asset('manifest.json')]);
  assert.deepEqual((await readdir(join(state, 'updates'))).filter(name => name.startsWith('download-')), []);
});

test('consumer verifies both assets before passing private paths to supervisor stage', async t => {
  const { state } = await fixture(t), order = [];
  const consumer = runtimeReleaseConsumer({ state,
    fetch: async url => { order.push(url.endsWith('.tar') ? 'download-archive' : 'download-manifest'); return new Response(url.endsWith('.tar') ? Buffer.alloc(1024) : '{}'); },
    verifyManifest: async file => { assert.equal((await stat(file)).mode & 0o777, 0o600); order.push('manifest-proof'); return { manifest: { source } }; },
    verifyArchive: async (_archive, _output, manifest) => { assert.equal(manifest.source, source); order.push('archive-proof'); },
    stage: async (file, blobs) => { assert.ok(file.startsWith(join(state, 'updates', 'download-'))); assert.equal(blobs, join(file, '..', 'blobs')); order.push('stage'); return { identity: digest }; } });
  assert.deepEqual(await consumer.stage(selected()), { identity: digest });
  assert.deepEqual(order, ['download-manifest', 'manifest-proof', 'download-archive', 'archive-proof', 'stage']);
});

test('preferences default off and persist with private permissions across restart', async t => {
  const { controller, state, options } = await fixture(t);
  assert.equal((await controller.status()).automatic, false);
  await controller.setAutomatic(true);
  await controller.check();
  const file = join(state, 'updates', 'preferences.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const restored = new RuntimeUpdates(options);
  assert.equal((await restored.initialize()).automatic, true);
  assert.equal((await restored.status()).available.source, source);
  assert.ok(!JSON.stringify(await restored.status()).includes(state));
  assert.throws(() => restored.setAutomatic('true'));
});

test('status does not check network and unknown/active idle blocks manual and automatic activation', async t => {
  for (const activity of [async () => ({}), async () => ({ idle: false })]) {
    const { controller, calls } = await fixture(t, { activity });
    await controller.status(); await controller.status();
    assert.deepEqual(calls, []);
    await controller.check();
    assert.equal((await controller.update()).outcome, 'blocked');
    await controller.setAutomatic(true); await controller.tick();
    assert.deepEqual(calls, ['check']);
  }
});

test('activity acquired during download blocks activation and reuses staged release when idle', async t => {
  let queries = 0;
  const { controller, calls, options } = await fixture(t, { activity: async () => ({ idle: ++queries !== 2 }) });
  await controller.check(); await controller.setAutomatic(true); await controller.tick();
  assert.equal((await controller.status()).outcome, 'blocked');
  assert.deepEqual(calls, ['check', 'stage']);
  await controller.tick();
  assert.equal((await controller.status()).outcome, 'activated');
  assert.deepEqual(calls, ['check', 'stage', 'activate']);
  assert.equal(options.currentSource, currentSource);
});

test('concurrent requests stage once and a failed automatic attempt is not replayed', async t => {
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const { controller, calls, options } = await fixture(t);
  options.consumer.stage = async () => { calls.push('stage'); await gate; throw Error('secret raw provider output'); };
  await controller.check(); await controller.setAutomatic(true);
  const updating = controller.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await controller.update()).busy, true);
  unblock(); await updating;
  assert.equal((await controller.status()).outcome, 'failed');
  await controller.tick();
  assert.deepEqual(calls, ['check', 'stage']);
  const saved = await readFile(join(options.state, 'updates', 'preferences.json'), 'utf8');
  assert.ok(!saved.includes('secret'));
});

test('failed checks are rate limited and pending activation completes only its live drain', async t => {
  const { controller, options, calls, setClock, journal } = await fixture(t);
  options.consumer.check = async () => { calls.push('check'); throw Error('network'); };
  await controller.tick(); await controller.tick();
  assert.deepEqual(calls, ['check']);
  setClock(6 * 60 * 60 * 1000 + 101); await controller.tick();
  assert.deepEqual(calls, ['check', 'check']);
  options.consumer.check = async () => selected();
  await controller.check();
  controller.activate = async () => { calls.push('activate'); journal.desired = digest; journal.phase = 'draining'; return { pending: true }; };
  await controller.update(); await controller.tick(); await controller.tick();
  assert.deepEqual(calls.slice(2), ['stage', 'activate', 'complete', 'complete']);
});

test('unknown bootstrap source is explicit and already installed identity is never reactivated', async t => {
  const { controller, journal, calls } = await fixture(t, { currentSource: null });
  assert.equal((await controller.status()).currentSource, null);
  journal.current = digest;
  await controller.check(); await controller.update();
  assert.equal((await controller.status()).currentSource, source);
  assert.equal((await controller.status()).outcome, 'current');
  assert.deepEqual(calls, ['check', 'stage']);
});

test('restart never resumes an inherited drain and unknown completion is not retried', async t => {
  const { controller, journal, options, calls } = await fixture(t);
  await controller.check();
  controller.activate = async () => { journal.phase = 'draining'; journal.desired = digest; return { pending: true }; };
  await controller.update();
  const inherited = new RuntimeUpdates(options);
  await inherited.initialize(); await inherited.tick();
  assert.deepEqual(calls, ['check', 'stage']);
  controller.completeDrain = async () => { calls.push('complete'); throw Error('unknown'); };
  await controller.tick(); await controller.tick();
  assert.deepEqual(calls, ['check', 'stage', 'complete']);
  assert.equal((await controller.status()).outcome, 'failed');
});

test('release checks during a drain do not change activation source attribution', async t => {
  const { controller, journal, options } = await fixture(t);
  await controller.check();
  controller.activate = async () => { journal.phase = 'draining'; journal.desired = digest; return { pending: true }; };
  await controller.update();
  options.consumer.check = async () => ({ ...selected(), source: 'd'.repeat(40), tag: `runtime-${'d'.repeat(40)}` });
  await controller.check();
  controller.completeDrain = async () => ({ pending: false, identity: digest });
  await controller.tick();
  assert.equal((await controller.status()).currentSource, source);
  assert.equal((await controller.status()).outcome, 'available');
});

test('shutdown joins the held update once and fences new operations until it settles', async t => {
  for (const held of ['stage', 'activate']) {
    const { controller, options, calls, journal } = await fixture(t);
    await controller.check();
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const hold = async () => {
      calls.push(held); entered(); await gate;
      if (held === 'stage') journal.staged = digest;
      return { pending: false, identity: digest };
    };
    if (held === 'stage') options.consumer.stage = hold;
    else controller.activate = hold;
    const update = controller.update();
    await started;
    let stopped = false;
    const stopping = controller.stop();
    stopping.then(() => { stopped = true; });
    assert.equal(controller.stop(), stopping);
    await assert.rejects(controller.check(), /stopping/);
    await assert.rejects(controller.update(), /stopping/);
    await assert.rejects(controller.setAutomatic(true), /stopping/);
    await controller.tick(); controller.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false, `shutdown must await ${held}`);
    release();
    await Promise.all([update, stopping]);
    assert.equal(stopped, true);
    assert.equal((await controller.status()).outcome, 'activated');
    assert.deepEqual(calls, ['check', 'stage', 'activate']);
  }
});

test('shutdown joins a held periodic check and prevents its automatic update or timer reschedule', async t => {
  const callbacks = [], cancelled = [];
  const { controller, options, calls } = await fixture(t, {
    schedule: callback => { callbacks.push(callback); return callbacks.length; }, cancel: timer => { cancelled.push(timer); },
  });
  await controller.setAutomatic(true);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  options.consumer.check = async () => { calls.push('check'); entered(); await gate; return selected(); };
  controller.start();
  const scheduled = callbacks[0]();
  await started;
  let stopped = false;
  const stopping = controller.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  release(); await Promise.all([scheduled, stopping]);
  assert.deepEqual(calls, ['check']);
  assert.deepEqual(cancelled, [1]);
  assert.equal(callbacks.length, 1);
  assert.equal((await controller.status()).outcome, 'available');
  await callbacks[0](); controller.start(); await controller.tick();
  assert.equal(callbacks.length, 1);
  assert.deepEqual(calls, ['check']);
});

test('committed activation receipt repairs only exact selected-release preferences', async t => {
  const f = await fixture(t); await f.controller.check();
  await f.controller.save({ outcome: 'pending', staged: { source, identity: digest } });
  Object.assign(f.journal, { protocol: 1, current: digest, desired: null, staged: null, phase: 'running',
    receipt: { from: 'bootstrap', to: digest, status: 'committed' } });
  const repaired = new RuntimeUpdates({ ...f.options, currentSource: source }); await repaired.initialize();
  assert.equal((await repaired.status()).outcome, 'activated'); assert.equal(repaired.record.staged, null);
  await repaired.save({ outcome: 'pending' }); f.journal.phase = 'starting';
  const ambiguous = new RuntimeUpdates({ ...f.options, currentSource: source }); await ambiguous.initialize();
  assert.equal((await ambiguous.status()).outcome, 'pending');
});
