import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, chmod, rename, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { BUNDLE_ROOTS, REQUIRED_BUNDLE_PATHS } from '../runtime-bundle.mjs';
import { packageRuntimeRelease, packagingFailureCategory } from './package-runtime-release.mjs';

const run = promisify(execFile), tool = new URL('./package-runtime-release.mjs', import.meta.url).pathname;
const baseImage = `sha256:${'a'.repeat(64)}`, source = 'b'.repeat(40), childImage = `ghcr.io/briq-cloud/t3-cloud@sha256:${'c'.repeat(64)}`;
async function imageFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 't3-package-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'image'), output = join(directory, 'assets');
  for (const path of REQUIRED_BUNDLE_PATHS) {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), 'fixed fixture runtime bytes', { mode: 0o500 });
  }
  for (const path of BUNDLE_ROOTS) {
    try { await mkdir(join(root, path), { recursive: true, mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return { root, output, baseImage, source, childImage };
}
async function cliFailure(options) {
  try { await run(process.execPath, [tool, options.root, options.output, options.baseImage, options.source, options.childImage]); assert.fail('Expected packaging failure'); }
  catch (error) {
    assert.equal(error.code, 1); assert.equal(error.stdout, '');
    assert.match(error.stderr, /^Runtime release packaging failed: stage=[a-z-]+ category=[a-z-]+\n$/);
    assert.equal(error.stderr.includes(options.root), false); assert.equal(error.stderr.includes(options.output), false);
    return error.stderr;
  }
}

test('packaging preserves relative release shims, deployed SDK and npm CLI symlinks', async t => {
  const f = await imageFixture(t), shims = join(f.root, 'opt/t3-cloud/bin/release-shims');
  await writeFile(join(shims, 'runtime-command'), 'fixed shim fixture', { mode: 0o500 });
  for (const name of ['node', 'briq', 'claude', 'codex']) { await rm(join(shims, name)); await symlink('runtime-command', join(shims, name)); }
  const sdk = join(f.root, 'opt/t3/node_modules/@anthropic-ai/claude-agent-sdk');
  const physical = join(f.root, 'opt/t3/node_modules/.pnpm/sdk'); await mkdir(physical, { recursive: true, mode: 0o700 });
  await rename(join(sdk, 'manifest.json'), join(physical, 'manifest.json')); await rm(sdk, { recursive: true }); await symlink('../.pnpm/sdk', sdk);
  const briq = join(f.root, 'opt/briq-cli/node_modules/.bin/briq');
  const target = join(f.root, 'opt/briq-cli/node_modules/@briq-cloud/cli/dist/index.js');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, 'fixed CLI fixture', { mode: 0o500 });
  await rm(briq); await symlink('../@briq-cloud/cli/dist/index.js', briq);
  assert.equal(await packageRuntimeRelease(f), null);
  const manifest = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.find(entry => entry.path === 'opt/t3-cloud/bin/release-shims/node'), { path: 'opt/t3-cloud/bin/release-shims/node', type: 'symlink', target: 'runtime-command' });
  await run(process.execPath, [new URL('./check-runtime-release.mjs', import.meta.url).pathname, f.output]);
});
for (const [kind, expected] of [
  ['missing input', 'stage=inventory category=missing-entry'],
  ['absolute link', 'stage=inventory category=unsafe-link'],
  ['hardlink', 'stage=inventory category=hardlink'],
  ['unsafe mode', 'stage=manifest category=unsafe-mode'],
  ['dangling link', 'stage=manifest category=unsafe-link'],
]) test(`packaging failure identifies ${kind} without emitting paths or error text`, async t => {
  const f = await imageFixture(t);
  if (kind === 'missing input') f.root = join(f.root, 'sensitive-missing-root');
  if (kind === 'absolute link') await symlink('/private/config/secret-value', join(f.root, 'opt/t3/unsafe-link'));
  if (kind === 'hardlink') await link(join(f.root, 'opt/t3/node'), join(f.root, 'opt/t3/linked-node'));
  if (kind === 'unsafe mode') await chmod(join(f.root, 'opt/t3/node'), 0o777);
  if (kind === 'dangling link') await symlink('missing-sensitive-target', join(f.root, 'opt/t3/missing-link'));
  const stderr = await cliFailure(f); assert.equal(stderr, `Runtime release packaging failed: ${expected}\n`);
  assert.equal(stderr.includes('secret'), false); assert.equal(stderr.includes('sensitive'), false);
});
test('all operation stages and cleanup errors expose only fixed diagnostics', async () => {
  const sensitive = Error('credential=private-value /private/config'); sensitive.code = 'remote-private-error'; sensitive.stderr = 'secret subprocess output';
  for (const stage of ['scratch', 'output', 'bundle', 'inventory', 'manifest', 'blobs', 'archive', 'manifest-copy', 'cleanup']) {
    const options = { root: '/unused-image', output: '/unused-output', baseImage, source, childImage };
    const dependencies = { scratchDirectory: async () => '/unused-private-scratch', createOutput: async () => {}, pack: async () => {}, archive: async () => {}, copyManifest: async () => {}, cleanup: async () => {} };
    const fail = async () => { throw sensitive; };
    if (stage === 'scratch') dependencies.scratchDirectory = fail;
    else if (stage === 'output') dependencies.createOutput = fail;
    else if (stage === 'archive') dependencies.archive = fail;
    else if (stage === 'manifest-copy') dependencies.copyManifest = fail;
    else if (stage === 'cleanup') dependencies.cleanup = fail;
    else dependencies.pack = async (_root, _output, { onPhase }) => { if (stage !== 'bundle') onPhase(stage); onPhase('untrusted-secret-stage'); throw sensitive; };
    assert.deepEqual(await packageRuntimeRelease(options, dependencies), { stage, category: 'unknown' });
  }
});
test('capacity, storage, permission and process categories remain fixed without changing their limits', () => {
  for (const [error, expected] of [
    [Error('Release exceeds capacity limit'), 'bundle-capacity'],
    [Error('Release archive exceeds capacity limit'), 'archive-capacity'],
    [Object.assign(Error('sensitive error'), { code: 'ENOSPC' }), 'storage-capacity'],
    [Object.assign(Error('sensitive error'), { code: 'EPERM' }), 'permission-denied'],
    [Object.assign(Error('sensitive error'), { code: 'ETIMEDOUT' }), 'timeout'],
    [Error('Incomplete release: sensitive path'), 'missing-required-entry'],
    [Error('credential=private-value'), 'unknown'],
  ]) assert.equal(packagingFailureCategory(error), expected);
});
