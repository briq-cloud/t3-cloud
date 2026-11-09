import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, chmod, rename, readFile, lstat, readdir, readlink } from 'node:fs/promises';
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


test('finished-image normalization breaks only declared hardlinks before the unchanged packaging verifier runs', async t => {
  const f = await imageFixture(t);
  const spacedRoot = `${f.root} exported image`; await rename(f.root, spacedRoot); f.root = spacedRoot;
  const sourceFile = join(f.root, 'opt/t3/node');
  const sibling = join(f.root, 'opt/t3/node-copy'), crossRoot = join(f.root, 'opt/codex/bin/codex');
  const symlinkFile = join(f.root, 'opt/t3/node-link');
  const longName = join(f.root, 'opt/t3', 'x'.repeat(240));
  await link(sourceFile, sibling); await link(sourceFile, longName); await rm(crossRoot); await link(sourceFile, crossRoot);
  await symlink('node', symlinkFile);
  // An excluded path can share the original inode. Assembly must neither copy
  // that directory nor change its contents, mode, link target or inode.
  const outside = join(f.root, 'work/preserved-alias'); await mkdir(dirname(outside), { mode: 0o700 }); await link(sourceFile, outside);
  const outsideBefore = await lstat(outside), before = await lstat(sourceFile), bytes = await readFile(sourceFile);
  assert.deepEqual(await packageRuntimeRelease({ ...f, output: `${f.output}-raw` }), { stage: 'inventory', category: 'hardlink' });
  const helper = new URL('./normalize-runtime-image', import.meta.url).pathname;
  const result = await run('bash', [helper, f.root]);
  assert.equal(result.stderr, ''); assert.equal(result.stdout, `Runtime image normalized: roots=${BUNDLE_ROOTS.length} hardlinks=0\n`);
  for (const path of [sourceFile, sibling, crossRoot, longName]) {
    const after = await lstat(path);
    assert.equal(after.nlink, 1); assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.deepEqual(await readFile(path), bytes);
  }
  assert.equal(await readlink(symlinkFile), 'node');
  assert.equal((await lstat(outside)).ino, outsideBefore.ino); assert.equal((await lstat(outside)).mode, outsideBefore.mode);
  assert.deepEqual(await readFile(outside), bytes);
  async function noHardlinks(path) {
    const info = await lstat(path);
    if (info.isDirectory()) for (const child of await readdir(path)) await noHardlinks(join(path, child));
    else if (info.isFile()) assert.equal(info.nlink, 1);
  }
  for (const path of BUNDLE_ROOTS) await noHardlinks(join(f.root, path));
  assert.equal(await packageRuntimeRelease(f), null);
  await run(process.execPath, [new URL('./check-runtime-release.mjs', import.meta.url).pathname, f.output]);
  // Repeating assembly is idempotent and does not copy already independent files.
  const normalizedInode = (await lstat(sourceFile)).ino;
  await run('bash', [helper, f.root]); assert.equal((await lstat(sourceFile)).ino, normalizedInode);
});

test('image normalization never follows a directory symlink or changes excluded data', async t => {
  const f = await imageFixture(t), outsideDirectory = join(f.root, 'work/data'); await mkdir(outsideDirectory, { recursive: true });
  const outside = join(outsideDirectory, 'independent'), alias = join(outsideDirectory, 'alias');
  await writeFile(outside, 'excluded image fixture', { mode: 0o600 }); await link(outside, alias);
  await symlink('../../work/data', join(f.root, 'opt/t3/excluded-link'));
  const before = await lstat(outside);
  const helper = new URL('./normalize-runtime-image', import.meta.url).pathname;
  await run('bash', [helper, f.root]);
  assert.equal((await lstat(outside)).ino, before.ino); assert.equal((await lstat(outside)).nlink, 2);
  assert.equal((await lstat(alias)).ino, before.ino); assert.equal(await readlink(join(f.root, 'opt/t3/excluded-link')), '../../work/data');
});

test('image normalization fails closed when a declared root is missing', async t => {
  const f = await imageFixture(t); await rm(join(f.root, BUNDLE_ROOTS[0]), { recursive: true });
  await assert.rejects(run('bash', [new URL('./normalize-runtime-image', import.meta.url).pathname, f.root]), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, ''); assert.equal(error.stderr, 'Runtime image normalization failed: stage=copy\n'); return true;
  });
});


test('tar-exported hardlinks normalize into a packable snapshot without changing the checked source or excluded alias', async t => {
  const f = await imageFixture(t), sourceFile = join(f.root, 'opt/t3/node');
  const sibling = join(f.root, 'opt/t3/export-alias'), outside = join(f.root, 'work/preserved-alias');
  await mkdir(dirname(outside), { mode: 0o700 }); await link(sourceFile, sibling); await link(sourceFile, outside);
  await symlink('node', join(f.root, 'opt/t3/node-link'));
  const sourceBefore = await lstat(sourceFile), sourceBytes = await readFile(sourceFile);
  const archive = `${f.output}.export.tar`, exported = `${f.root}-exported`; await mkdir(exported, { mode: 0o700 });
  await run('tar', ['-cf', archive, '-C', f.root, '.']);
  const archiveBytes = await readFile(archive);
  await run('tar', ['-xf', archive, '-C', exported]);
  const exportedSource = join(exported, 'opt/t3/node'), exportedOutside = join(exported, 'work/preserved-alias');
  const outsideBefore = await lstat(exportedOutside), exportedBefore = await lstat(exportedSource);
  assert.equal(exportedBefore.nlink, 3); assert.equal(exportedBefore.ino, outsideBefore.ino);
  assert.deepEqual(await packageRuntimeRelease({ ...f, root: exported, output: `${f.output}-raw-export` }), { stage: 'inventory', category: 'hardlink' });
  await run('bash', [new URL('./normalize-runtime-image', import.meta.url).pathname, exported]);
  assert.equal((await lstat(exportedSource)).nlink, 1); assert.equal((await lstat(join(exported, 'opt/t3/export-alias'))).nlink, 1);
  assert.equal((await lstat(exportedSource)).mode, exportedBefore.mode); assert.deepEqual(await readFile(exportedSource), sourceBytes);
  assert.equal(await readlink(join(exported, 'opt/t3/node-link')), 'node');
  assert.equal((await lstat(exportedOutside)).ino, outsideBefore.ino); assert.equal((await lstat(exportedOutside)).mode, outsideBefore.mode);
  assert.deepEqual(await readFile(exportedOutside), sourceBytes);
  assert.equal((await lstat(sourceFile)).ino, sourceBefore.ino); assert.equal((await lstat(sourceFile)).nlink, sourceBefore.nlink);
  assert.deepEqual(await readFile(sourceFile), sourceBytes); assert.deepEqual(await readFile(archive), archiveBytes);
  assert.equal(await packageRuntimeRelease({ ...f, root: exported }), null);
  await run(process.execPath, [new URL('./check-runtime-release.mjs', import.meta.url).pathname, f.output]);
});
