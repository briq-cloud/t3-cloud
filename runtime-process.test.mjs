import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, cp, realpath, symlink, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeProcess } from './runtime-process.mjs';
import { runtimeProcess as originalRuntimeProcess } from './fixtures/runtime-process-v1.mjs';
import { createHash } from 'node:crypto';

test('real manager startup failure reports a fixed stage and exits instead of retaining its IPC queue', async t => {
  const directory = await mkdtemp(join(tmpdir(), 't3-failed-manager-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let exited;
  const driver = runtimeProcess({ T3_CWD: directory }, {
    spawnProcess: (_command, _args, options) => {
      const child = spawn(process.execPath, [new URL('./manager-main.mjs', import.meta.url).pathname], options);
      exited = new Promise(resolve => child.once('exit', resolve)); return child;
    },
  });
  t.after(() => driver.stop());
  await assert.rejects(driver.start('/'), /Manager operation unavailable|Owned manager exited/);
  await exited;
  assert.equal(driver.alive, false); assert.equal(driver.startupFailure, 'preparing');
});

test('original bootstrap process protocol starts relocated manager configuration without new environment authority', async t => {
  const state = await realpath(await mkdtemp(join(tmpdir(), 't3-original-process-')));
  t.after(() => rm(state, { recursive: true, force: true }));
  const baseImage = `sha256:${'b'.repeat(64)}`;
  // Unrelated archive-sized payload is deliberately absent: predecessor
  // authorization must not read or hash old executables inside the 40s IPC gate.
  const priorManifest = { baseImage, files: [
    { path: 'opt/t3-cloud/skills/briq', type: 'directory', mode: 0o700 },
    { path: 'opt/t3-cloud/skills/briq/SKILL.md', type: 'file', size: 1, mode: 0o600, sha256: '0'.repeat(64) },
    { path: 'opt/old-native', type: 'file', size: 1_400_000_000, mode: 0o700, sha256: '0'.repeat(64) },
  ] };
  const selected = `sha256:${createHash('sha256').update(JSON.stringify(priorManifest)).digest('hex')}`;
  const root = join(state, 'releases', selected.replace(':', '-'));
  const app = join(root, 'opt/t3-cloud'), home = join(state, 'codex');
  await mkdir(app, { recursive: true }); await mkdir(join(state, 'updates'));
  for (const path of ['codex-config.mjs', 'briq-native.mjs', 'skills']) await cp(new URL(path, import.meta.url), join(app, path), { recursive: true });
  await writeFile(join(root, '.release-manifest.json'), JSON.stringify(priorManifest), { mode: 0o400 });
  await mkdir(join(home, '.agents/skills'), { recursive: true });
  await symlink('/opt/t3-cloud/skills/briq', join(home, '.agents/skills/briq'));
  await writeFile(join(state, 'updates/activation.json'), JSON.stringify({ protocol: 1, current: 'bootstrap', desired: selected,
    staged: selected, phase: 'starting', receipt: { from: 'bootstrap', to: selected, status: 'pending' } }), { mode: 0o600 });
  const entry = join(app, 'manager-fixture.mjs');
  await writeFile(entry, `import { managedSkillPredecessor } from ${JSON.stringify(new URL('./runtime-supervisor.mjs', import.meta.url).href)};
    import { prepareExecutingCodex } from './codex-config.mjs';
    if (process.env.T3_CLOUD_PREVIOUS_SKILL_SOURCE !== undefined) throw Error('unexpected new authority');
    const selected = 'sha256:' + process.env.T3_RELEASE_ROOT.slice(-64);
    const previousSkillSource = await managedSkillPredecessor({state: process.env.T3_CLOUD_STATE, selected, baseImage: '${baseImage}'});
    await prepareExecutingCodex({home: ${JSON.stringify(home)}, previousSkillSource});
    process.on('message', value => process.send({protocol: 1, id: value.id, ok: true, result: {ready: true}}));
    process.once('disconnect', () => process.exit(0));`);
  const driver = originalRuntimeProcess({ T3_CWD: state, T3_CLOUD_STATE: state }, {
    spawnProcess: (_command, _args, options) => spawn(process.execPath, [entry], options),
  });
  t.after(() => driver.stop());
  await driver.start(root, { childImage: `image@sha256:${'c'.repeat(64)}` });
  assert.deepEqual(await driver.health(), { ready: true });
  assert.equal(await readlink(join(home, '.agents/skills/briq')), join(app, 'skills/briq'));
  await driver.stop(); assert.equal(driver.alive, false);
  const second = `sha256:${'d'.repeat(64)}`, secondRoot = join(state, 'releases', second.replace(':', '-'));
  await mkdir(join(secondRoot, 'opt'), { recursive: true });
  await cp(app, join(secondRoot, 'opt/t3-cloud'), { recursive: true });
  await writeFile(join(state, 'updates/activation.json'), JSON.stringify({ protocol: 1, current: selected, desired: second,
    staged: second, phase: 'starting', receipt: { from: selected, to: second, status: 'pending' } }), { mode: 0o600 });
  const secondEntry = join(secondRoot, 'opt/t3-cloud/manager-fixture.mjs');
  const nextDriver = originalRuntimeProcess({ T3_CWD: state, T3_CLOUD_STATE: state }, {
    spawnProcess: (_command, _args, options) => spawn(process.execPath, [secondEntry], options),
  });
  t.after(() => nextDriver.stop());
  await nextDriver.start(secondRoot, { childImage: `image@sha256:${'e'.repeat(64)}` });
  assert.deepEqual(await nextDriver.health(), { ready: true });
  assert.equal(await readlink(join(home, '.agents/skills/briq')), join(secondRoot, 'opt/t3-cloud/skills/briq'));
  await nextDriver.stop(); assert.equal(nextDriver.alive, false);
});

test('owned process uses selected Node, dependencies and child image, then acknowledges descendant shutdown', async t => {
  const directory = await mkdtemp(join(tmpdir(), 't3-owned-process-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'manager.mjs');
  await writeFile(file, `process.on('message', message => {
    process.send({ protocol: 1, id: message.id, ok: true, result: message.method === 'activity' ? { idle: true } : {} });
  }); process.on('disconnect', () => process.exit(0));`);
  let captured;
  const driver = runtimeProcess({ T3_CWD: directory, T3_CLOUD_STATE: directory, T3_CLOUD_CHILD_IMAGE: 'old' }, {
    spawnProcess(command, args, options) { captured = { command, args, options }; return spawn(process.execPath, [file], options); },
  });
  t.after(() => driver.stop());
  const root = join(directory, `releases/sha256-${'a'.repeat(64)}`);
  await driver.start(root, { childImage: 'new-image@sha256:trusted' });
  assert.equal(captured.command, `${root}/opt/t3/node`);
  assert.equal(captured.args[0], `${root}/opt/t3-cloud/manager-main.mjs`);
  assert.equal(captured.options.env.T3_CLOUD_CHILD_IMAGE, 'new-image@sha256:trusted');
  assert.equal(captured.options.env.PATH, `${root}/opt/t3-cloud/bin/release-shims:/usr/bin:/bin`);
  assert.equal(captured.options.env.T3_RELEASE_ROOT, root);
  assert.equal(captured.options.env.PORT, '8082');
  await driver.drain(); assert.deepEqual(await driver.activity(), { idle: true });
  await driver.stop(); assert.equal(driver.alive, false);
});

test('owned IPC rejects unrecognized methods, paths and malformed identities before calling updater', async t => {
  const directory = await mkdtemp(join(tmpdir(), 't3-owned-update-ipc-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'manager.mjs');
  await writeFile(file, `let sent = false, responses = [];
    process.on('message', value => {
      if (value.channel === 'runtime-updates') { responses.push(value); return; }
      process.send({ protocol: 1, id: value.id, ok: true, result: value.method === 'activity' ? responses : {} });
      if (value.method === 'health' && !sent) {
        sent = true;
        const base = { protocol: 1, channel: 'runtime-updates', id: 1, method: 'status' };
        for (const patch of [{ method: 'stop' }, { id: -1 }, { path: '/private/credential' }, { method: 'automatic', enabled: 'yes' }, { enabled: true }]) process.send({ ...base, ...patch });
        process.send({ ...base, id: 2 });
      }
    }); process.on('disconnect', () => process.exit(0));`);
  const methods = [];
  let done; const called = new Promise(resolve => { done = resolve; });
  const driver = runtimeProcess({ T3_CWD: directory }, { spawnProcess: (_command, _args, options) => spawn(process.execPath, [file], options) });
  driver.setUpdates(async method => { methods.push(method); done(); return { phase: 'running' }; });
  t.after(() => driver.stop()); await driver.start('/'); await called; await driver.health();
  const responses = await driver.activity();
  assert.deepEqual(methods, ['status']);
  assert.deepEqual(responses.map(value => ({ id: value.id, result: value.result })), [{ id: 2, result: { phase: 'running' } }]);
});
