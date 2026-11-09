import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeProcess } from './runtime-process.mjs';

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
