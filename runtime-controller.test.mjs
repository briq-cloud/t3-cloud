import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeControllerProcess, controllerEnvironment, controllerStagePaths } from './runtime-controller-process.mjs';

const source = 'a'.repeat(40), identity = `sha256:${'a'.repeat(64)}`;
const journal = { current: 'bootstrap', staged: null, desired: null, phase: 'running', receipt: null };
async function fixture(t) {
  const state = await mkdtemp(join(tmpdir(), 'controller-test-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  return state;
}
function realController(state, options = {}) {
  return runtimeControllerProcess({ root: '/selected', state, currentSource: source, status: async () => journal,
    activity: async () => ({ idle: true }), stage: async () => ({}), activate: async () => ({}), completeDrain: async () => ({}),
    spawnProcess: (_command, _args, settings) => spawn(process.execPath, [new URL('./runtime-controller.mjs', import.meta.url).pathname], settings), ...options });
}

test('controller uses selected release Node and entry with no inherited credentials or preload', async t => {
  const state = await fixture(t);
  let captured;
  const controller = realController(state, { env: { OPENAI_API_KEY: 'secret', GH_TOKEN: 'secret', T3_CLOUD_OWNER_KEY: 'secret', BRIQ_API_KEY: 'secret', NODE_OPTIONS: '--inspect', HOME: '/owner' },
    spawnProcess(command, args, settings) { captured = { command, args, settings }; return spawn(process.execPath, [new URL('./runtime-controller.mjs', import.meta.url).pathname], settings); } });
  t.after(() => controller.stop());
  assert.equal(captured.command, '/selected/opt/t3/node');
  assert.deepEqual(captured.args, ['/selected/opt/t3-cloud/runtime-controller.mjs']);
  assert.deepEqual(captured.settings.env, controllerEnvironment());
  assert.equal((await controller.initialize()).currentSource, source);
  assert.equal((await controller.setAutomatic(false)).automatic, false);
  await controller.stop(); assert.equal(controller.alive, false);
});

test('recovery controller reads status but cannot enable scheduling, check, or activate', async t => {
  const state = await fixture(t);
  const controller = realController(state, { recovery: true }); t.after(() => controller.stop());
  await controller.initialize(); await controller.start();
  await assert.rejects(controller.check(), /unavailable/);
  await assert.rejects(controller.update(), /unavailable/);
  await assert.rejects(controller.setAutomatic(true), /unavailable/);
  assert.equal((await controller.status()).automatic, false);
});

test('new controller reconciles committed durable receipt without replaying an activation', async t => {
  const state = await fixture(t);
  await mkdir(join(state, 'updates'));
  await writeFile(join(state, 'updates/preferences.json'), JSON.stringify({ protocol: 1, automatic: false, checkedAt: null,
    available: null, outcome: 'pending', attempted: null, staged: { source, identity } }));
  let activations = 0;
  const controller = realController(state, { status: async () => ({ ...journal, current: identity, staged: identity, receipt: { from: 'bootstrap', to: identity, status: 'committed' } }),
    activate: async () => { activations++; } }); t.after(() => controller.stop());
  const status = await controller.initialize();
  assert.equal(status.outcome, 'activated'); assert.equal(activations, 0);
});

test('stage capability accepts only its generated download pair, never arbitrary paths', () => {
  const state = '/state';
  assert.equal(controllerStagePaths(state, ['/state/updates/download-Abc123/manifest.json', '/state/updates/download-Abc123/blobs']), true);
  for (const paths of [['/etc/passwd', '/state/blobs'], ['/state/updates/download-Abc123/../manifest.json', '/state/updates/download-Abc123/blobs'],
    ['/state/updates/download-Abc123/manifest.json', '/state/updates/download-Different/blobs']]) assert.equal(controllerStagePaths(state, paths), false);
});

class FakeChild extends EventEmitter {
  connected = true;
  messages = [];
  send(value, callback) { this.messages.push(value); callback?.(); }
  kill() { this.killed = true; }
}
test('wrong session and malformed responses fail closed and cannot resolve an unknown command', async () => {
  for (const patch of [{ session: 'other' }, { extra: 'path' }, { ok: 'yes' }]) {
    const child = new FakeChild();
    const controller = runtimeControllerProcess({ root: '/', state: '/state', spawnProcess: () => child });
    const pending = controller.initialize(); const sent = child.messages[0];
    child.emit('message', { protocol: 1, channel: 'runtime-controller', session: sent.session, kind: 'result', id: sent.id, ok: true, result: {}, ...patch });
    await assert.rejects(pending, /outcome unknown/);
    assert.equal(child.killed, true);
    await assert.rejects(controller.status(), /unavailable/);
    child.emit('exit');
  }
});

test('controller exit rejects its exact live command without replay', async () => {
  const child = new FakeChild();
  const controller = runtimeControllerProcess({ root: '/', state: '/state', spawnProcess: () => child });
  const pending = controller.initialize(); child.emit('exit');
  await assert.rejects(pending, /outcome unknown/);
  assert.equal(child.messages.length, 1);
});

test('controller stop joins its active activation and saves terminal preferences before exit', async t => {
  const state = await fixture(t), entry = join(state, 'controller-fixture.mjs');
  const nextSource = 'b'.repeat(40);
  await writeFile(entry, `import { serveRuntimeController } from ${JSON.stringify(new URL('./runtime-controller.mjs', import.meta.url).href)};
    import { RuntimeUpdates } from ${JSON.stringify(new URL('./runtime-updates.mjs', import.meta.url).href)};
    serveRuntimeController(process, { createUpdates(options) {
      const updates = new RuntimeUpdates({ ...options, consumer: {
        check: async () => ({ tag: 'runtime-${nextSource}', source: '${nextSource}', publishedAt: '2026-11-09T00:00:00Z', sizes: { 'manifest.json': 1, 'runtime-blobs.tar': 1 } }),
        stage: async () => ({ identity: '${identity}' }) } });
      const initialize = updates.initialize.bind(updates);
      updates.initialize = async () => { await initialize(); await updates.check(); };
      return updates;
    } });`);
  let entered, complete;
  const activation = new Promise(resolve => { entered = resolve; });
  const result = new Promise(resolve => { complete = resolve; });
  const controller = realController(state, { activate: async () => { entered(); return result; },
    spawnProcess: (_command, _args, settings) => spawn(process.execPath, [entry], settings) });
  t.after(() => controller.stop());
  await controller.initialize();
  const update = controller.update(); await activation;
  let stopped = false;
  const stopping = controller.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  complete({ identity });
  assert.equal((await update).outcome, 'activated');
  await stopping; assert.equal(controller.alive, false);
});

test('recovery remains inspectable for unknown preference migrations without rewriting them', async t => {
  const state = await fixture(t);
  await mkdir(join(state, 'updates'));
  const file = join(state, 'updates/preferences.json');
  await writeFile(file, '{"protocol":999}');
  const controller = realController(state, { recovery: true }); t.after(() => controller.stop());
  assert.equal((await controller.initialize()).phase, 'running');
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(file, 'utf8'), '{"protocol":999}');
});
