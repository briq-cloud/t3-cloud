import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUNDLE_ROOTS, REQUIRED_BUNDLE_PATHS, packBundle, stageBundle, validateManifest, verifyManifestAttestation } from './runtime-bundle.mjs';

const contents = Buffer.from('release test bytes');
const fileHash = createHash('sha256').update(contents).digest('hex');
const certificate = { sourceRepositoryIdentifier: '1450999885', sourceRepositoryRef: 'refs/heads/main', sourceRepository: 'briq-cloud/t3-cloud' };
const verified = value => ({ stdout: JSON.stringify([{ verificationResult: { signature: { certificate: value } } }]) });
const run = async (_cli, args) => {
  assert.equal(args[0], 'attestation');
  assert.equal(args[1], 'verify');
  assert.ok(args.includes('briq-cloud/t3-cloud/.github/workflows/image.yml'));
  assert.ok(args.includes('refs/heads/main'));
  assert.ok(args.includes('b'.repeat(40)));
  return verified(certificate);
};
function fixture() {
  const dirs = new Set();
  for (const path of REQUIRED_BUNDLE_PATHS) for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) dirs.add(parent);
  const files = [...dirs].map(path => ({ path, type: 'directory', mode: 0o700 }));
  for (const path of REQUIRED_BUNDLE_PATHS) files.push({ path, type: 'file', mode: 0o700, size: contents.length, sha256: fileHash });
  return { protocol: 1, project: 'briq-cloud/t3-cloud', platform: 'linux/amd64', baseImage: `sha256:${'a'.repeat(64)}`,
    source: 'b'.repeat(40), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

test('attested complete release stages exact bytes under immutable digest', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blobs = join(root, 'blobs'), releases = join(root, 'releases'), manifestFile = join(root, 'manifest.json');
  await mkdir(blobs);
  await writeFile(join(blobs, fileHash), contents);
  await writeFile(manifestFile, JSON.stringify(fixture()));
  const staged = await stageBundle(manifestFile, blobs, releases, { run });
  assert.equal(staged.identity, validateManifest(fixture()));
  assert.deepEqual(await readFile(join(staged.path, 'opt/t3/node')), contents);
  await assert.rejects(stageBundle(manifestFile, blobs, releases, { run }), /already exists/);
});

test('wrong repository identity and failed attestation fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'manifest.json');
  await writeFile(file, JSON.stringify(fixture()));
  await assert.rejects(verifyManifestAttestation(file, { run: async () => verified({ ...certificate, sourceRepositoryIdentifier: '1' }) }), /provenance/);
  await assert.rejects(verifyManifestAttestation(file, { run: async () => { throw Error('verification failed'); } }), /verification failed/);
});

test('incomplete inventory and unsafe paths fail validation', () => {
  const missing = fixture(); missing.files = missing.files.filter(file => file.path !== 'opt/codex/bin/codex');
  assert.throws(() => validateManifest(missing), /Incomplete release/);
  const traversal = fixture(); traversal.files.push({ path: '../outside', type: 'file', mode: 0o700, size: 0, sha256: fileHash });
  assert.throws(() => validateManifest(traversal), /Invalid release path/);
});

test('bad blob never creates a visible release', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blobs = join(root, 'blobs'), releases = join(root, 'releases'), manifestFile = join(root, 'manifest.json');
  await mkdir(blobs);
  await writeFile(join(blobs, fileHash), 'wrong bytes');
  await writeFile(manifestFile, JSON.stringify(fixture()));
  await assert.rejects(stageBundle(manifestFile, blobs, releases, { run }), /blob mismatch/);
  assert.deepEqual(await readdir(releases), []);
});

test('image inventory packs only declared application roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of REQUIRED_BUNDLE_PATHS) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents, { mode: 0o700 });
  }
  for (const path of BUNDLE_ROOTS) {
    try { await mkdir(join(root, path), { recursive: true }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  await writeFile(join(root, 'work-secret'), 'must stay out');
  const output = join(root, 'published');
  const manifest = await packBundle(root, output, { baseImage: `sha256:${'a'.repeat(64)}`, source: 'b'.repeat(40) });
  validateManifest(manifest);
  assert.equal(manifest.files.some(entry => entry.path === 'work-secret' || entry.path.startsWith('published/')), false);
  assert.deepEqual(await readFile(join(output, 'blobs', fileHash)), contents);
});
