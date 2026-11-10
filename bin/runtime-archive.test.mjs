import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REQUIRED_BUNDLE_PATHS } from '../runtime-bundle.mjs';
import { MAX_RUNTIME_ARCHIVE_BYTES, runtimeArchiveVerificationTimeout, packRuntimeArchive, unpackRuntimeArchive, verifyAndUnpackRuntimeArchive } from './runtime-archive.mjs';

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

test('archive verification budget rounds size up and remains capped', () => {
  const mib = 1024 * 1024;
  for (const [bytes, timeout] of [[1, 31000], [16 * mib - 1, 31000], [16 * mib, 31000],
    [16 * mib + 1, 32000], [1429248000, 116000], [MAX_RUNTIME_ARCHIVE_BYTES, 144000],
    [149 * 16 * mib, 179000], [149 * 16 * mib + 1, 180000], [150 * 16 * mib, 180000], [151 * 16 * mib, 180000]]) {
    assert.equal(runtimeArchiveVerificationTimeout(bytes), timeout);
  }
  for (const bytes of [0, -1, NaN, Infinity, 1.5, '1024', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => runtimeArchiveVerificationTimeout(bytes), /Invalid release archive size/);
  }
});

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
    assert.equal(options.timeout, runtimeArchiveVerificationTimeout((await stat(f.archive)).size));
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

test('archive verification uses a private independent snapshot on the download filesystem when TMPDIR is unusable', async t => {
  const f = await fixture(t);
  const sentinel = join(f.root, 'unsuitable-tmpdir');
  await writeFile(sentinel, 'not a directory');
  const previous = process.env.TMPDIR;
  let snapshot;
  try {
    process.env.TMPDIR = sentinel;
    await assert.rejects(verifyAndUnpackRuntimeArchive(f.archive, f.output, manifest(), { run: async (_cli, args) => {
      snapshot = args[2];
      const directory = dirname(snapshot), original = await stat(f.archive), copied = await stat(snapshot);
      assert.equal(dirname(directory), dirname(f.archive));
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal(copied.dev, original.dev);
      assert.notEqual(copied.ino, original.ino);
      assert.equal(copied.nlink, 1);
      assert.deepEqual(await readFile(snapshot), await readFile(f.archive));
      throw Error('Unverifiable archive');
    } }), /Unverifiable archive/);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'not a directory');
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
  await assert.rejects(stat(dirname(snapshot)), { code: 'ENOENT' });
});

test('archive verification refuses a writable download directory before creating scratch', async t => {
  const f = await fixture(t);
  const { chmod } = await import('node:fs/promises');
  await chmod(f.root, 0o777);
  try {
    await assert.rejects(verifyAndUnpackRuntimeArchive(f.archive, f.output, manifest(), {
      run: async () => assert.fail('unsafe directory must not reach verification'),
    }), /Unsafe release archive directory/);
    assert.equal((await readdir(f.root)).some(name => name.startsWith('t3-archive-verify-')), false);
    await assert.rejects(stat(f.output), { code: 'ENOENT' });
  } finally { await chmod(f.root, 0o700); }
});

test('large sparse archive gets its size-derived native budget; timeout prevents extraction', async t => {
  const f = await fixture(t);
  // Extending creates a hole, avoiding a material write of the published 1.4 GB asset.
  const bytes = 32 * 1024 * 1024 + 512;
  await truncate(f.archive, bytes);
  let snapshot;
  const timeout = Object.assign(Error('verification expired'), { code: 'ETIMEDOUT' });
  await assert.rejects(verifyAndUnpackRuntimeArchive(f.archive, f.output, manifest(), { run: async (_cli, args, options) => {
    snapshot = args[2];
    assert.notEqual(snapshot, f.archive);
    assert.equal((await stat(snapshot)).size, bytes);
    assert.equal(options.timeout, 33000);
    throw timeout;
  } }), error => error === timeout);
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
  await assert.rejects(stat(dirname(snapshot)), { code: 'ENOENT' });
  assert.equal((await stat(f.archive)).size, bytes);
});

test('extended verification budget never admits an oversized archive', async t => {
  const f = await fixture(t);
  await truncate(f.archive, MAX_RUNTIME_ARCHIVE_BYTES + 1);
  await assert.rejects(verifyAndUnpackRuntimeArchive(f.archive, f.output, manifest(), {
    run: async () => assert.fail('oversized archive must not reach native verification'),
  }), /Invalid release archive size/);
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('native success still requires the pinned certificate before extraction', async t => {
  const f = await fixture(t);
  for (const certificate of [
    { sourceRepositoryIdentifier: '1', sourceRepositoryRef: 'refs/heads/main' },
    { sourceRepositoryIdentifier: '1450999885', sourceRepositoryRef: 'refs/heads/other' },
  ]) {
    await assert.rejects(verifyAndUnpackRuntimeArchive(f.archive, f.output, manifest(), {
      run: async () => ({ stdout: JSON.stringify([{ verificationResult: { signature: { certificate } } }]) }),
    }), /Release archive provenance unavailable/);
    await assert.rejects(stat(f.output), { code: 'ENOENT' });
  }
});

test('verified snapshot extracts authenticated bytes even when the original changes', async t => {
  const f = await fixture(t);
  await verifyAndUnpackRuntimeArchive(f.archive, f.output, manifest(), { run: async (_cli, args) => {
    assert.deepEqual(await readFile(args[2]), await readFile(f.archive));
    await writeFile(f.archive, 'changed original');
    return { stdout: JSON.stringify([{ verificationResult: { signature: { certificate: {
      sourceRepositoryIdentifier: '1450999885', sourceRepositoryRef: 'refs/heads/main',
    } } } }]) };
  } });
  assert.deepEqual(await readdir(f.output), [hash]);
  assert.deepEqual(await readFile(join(f.output, hash)), contents);
  assert.equal((await stat(join(f.output, hash))).mode & 0o777, 0o400);
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
