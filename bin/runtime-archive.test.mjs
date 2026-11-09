import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REQUIRED_BUNDLE_PATHS } from '../runtime-bundle.mjs';
import { packRuntimeArchive, unpackRuntimeArchive, verifyAndUnpackRuntimeArchive } from './runtime-archive.mjs';

const contents = Buffer.from('archive contract fixture\n');
const hash = createHash('sha256').update(contents).digest('hex');
function manifest() {
  const dirs = new Set();
  for (const path of REQUIRED_BUNDLE_PATHS) for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) dirs.add(parent);
  return { protocol: 1, project: 'briq-cloud/t3-cloud', platform: 'linux/amd64', baseImage: `sha256:${'a'.repeat(64)}`,
    childImage: `ghcr.io/briq-cloud/t3-cloud@sha256:${'c'.repeat(64)}`, source: 'b'.repeat(40),
    files: [...dirs].map(path => ({ path, type: 'directory', mode: 0o700 })).concat(REQUIRED_BUNDLE_PATHS.map(path => ({ path, type: 'file', mode: 0o500, size: contents.length, sha256: hash }))) };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 't3-archive-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle');
  await mkdir(join(bundle, 'blobs'), { recursive: true });
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify(manifest()));
  await writeFile(join(bundle, 'blobs', hash), contents);
  await writeFile(join(root, 'runtime-attestation.jsonl'), 'untrusted evidence fixture');
  const archive = join(root, 'runtime-blobs.tar');
  await packRuntimeArchive(bundle, archive);
  return { root, bundle, archive, output: join(root, 'extracted') };
}
function fixChecksum(bytes) {
  bytes.fill(32, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += bytes[i];
  bytes.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
}

test('standard USTAR round trip deduplicates manifest blobs and seals output files', async t => {
  const f = await fixture(t);
  await unpackRuntimeArchive(f.archive, f.output, manifest());
  assert.deepEqual(await readdir(f.output), [hash]);
  assert.deepEqual(await readFile(join(f.output, hash)), contents);
  assert.equal((await stat(join(f.output, hash))).mode & 0o777, 0o400);
});

for (const [name, mutate] of [
  ['traversal', bytes => { bytes.fill(0, 0, 100); bytes.write('../outside', 0); fixChecksum(bytes); }],
  ['symlink', bytes => { bytes[156] = 50; fixChecksum(bytes); }],
  ['PAX metadata', bytes => { bytes[156] = 120; fixChecksum(bytes); }],
  ['checksum corruption', bytes => { bytes[0] ^= 1; }],
  ['payload corruption', bytes => { bytes[512] ^= 1; }],
  ['nonzero padding', bytes => { bytes[512 + contents.length] = 1; }],
  ['archive prefix', bytes => { bytes.write('outside', 345); fixChecksum(bytes); }],
  ['trailing nonzero block', bytes => { bytes[bytes.length - 512] = 1; }],
]) test(`rejects ${name} and removes partial extraction`, async t => {
  const f = await fixture(t);
  const bytes = await readFile(f.archive); mutate(bytes);
  await writeFile(f.archive, bytes);
  await assert.rejects(unpackRuntimeArchive(f.archive, f.output, manifest()));
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('rejects duplicate, missing and truncated members', async t => {
  const f = await fixture(t);
  const bytes = await readFile(f.archive);
  for (const [name, changed] of [
    ['duplicate', Buffer.concat([bytes.subarray(0, 1024), bytes])],
    ['missing', Buffer.alloc(1024)],
    ['truncated', bytes.subarray(0, 512)],
  ]) {
    const path = join(f.root, name);
    await writeFile(path, changed);
    await assert.rejects(unpackRuntimeArchive(path, f.output, manifest()));
  }
});

test('rejects unexpected source blobs and symlinked archive paths', async t => {
  const f = await fixture(t);
  await writeFile(join(f.bundle, 'blobs', 'unexpected'), 'private');
  await assert.rejects(packRuntimeArchive(f.bundle, join(f.root, 'bad.tar')), /Unexpected/);
  const link = join(f.root, 'link');
  await symlink(f.archive, link);
  await assert.rejects(unpackRuntimeArchive(link, f.output, manifest()));
});

test('real verifier failure prevents extraction; invocation pins source and identity', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyAndUnpackRuntimeArchive(f.archive, f.output, manifest(), { run: async (cli, args, options) => {
    assert.equal(await readFile(args[args.indexOf('--bundle') + 1], 'utf8'), 'untrusted evidence fixture');
    assert.equal(options.env.HOME, '/nonexistent');
    assert.equal(options.env.GH_CONFIG_DIR, '/nonexistent');
    assert.equal(options.env.GH_TOKEN, undefined);
    assert.equal(cli, 'gh');
    assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
    assert.notEqual(args[2], f.archive);
    assert.ok(args.includes('briq-cloud/t3-cloud/.github/workflows/image.yml'));
    assert.ok(args.includes('refs/heads/main'));
    assert.ok(args.includes('b'.repeat(40)));
    throw Error('No real attestation available');
  } }), /No real attestation/);
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('release packaging CLI carries source/base/companion identity into the checked assets', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { BUNDLE_ROOTS } = await import('../runtime-bundle.mjs');
  const root = await mkdtemp(join(tmpdir(), 't3-release-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = join(root, 'image'), output = join(root, 'assets');
  for (const path of REQUIRED_BUNDLE_PATHS) {
    await mkdir(dirname(join(image, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(image, path), contents, { mode: 0o500 });
  }
  for (const path of BUNDLE_ROOTS) {
    try { await mkdir(join(image, path), { recursive: true, mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  await mkdir(join(image, 'work'), { mode: 0o700 });
  await writeFile(join(image, 'work', 'credentials'), 'excluded fixture');
  const expected = manifest();
  const packageTool = new URL('./package-runtime-release.mjs', import.meta.url);
  await promisify(execFile)(process.execPath, [packageTool.pathname, image, output, expected.baseImage, expected.source, expected.childImage]);
  assert.deepEqual((await readdir(output)).sort(), ['manifest.json', 'runtime-blobs.tar']);
  const packed = JSON.parse(await readFile(join(output, 'manifest.json')));
  for (const key of ['baseImage', 'source', 'childImage']) assert.equal(packed[key], expected[key]);
  assert.equal(packed.files.some(entry => entry.path.startsWith('work')), false);
  await promisify(execFile)(process.execPath, [new URL('./check-runtime-release.mjs', import.meta.url).pathname, output]);
});
