import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUNDLE_ROOTS, REQUIRED_BUNDLE_PATHS, packBundle, stageBundle, validateManifest, verifyManifestAttestation, verifyInstalledBundle } from './runtime-bundle.mjs';

async function cleanup(path) {
  const info = await lstat(path);
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await cleanup(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
}

const contents = Buffer.from('release test bytes');
const fileHash = createHash('sha256').update(contents).digest('hex');
const certificate = { sourceRepositoryIdentifier: '1450999885', sourceRepositoryRef: 'refs/heads/main', sourceRepository: 'briq-cloud/t3-cloud' };
const verified = value => ({ stdout: JSON.stringify([{ verificationResult: { signature: { certificate: value } } }]) });
const run = async (_cli, args, options) => {
  const bundle = args[args.indexOf('--bundle') + 1];
  assert.equal(await readFile(bundle, 'utf8'), 'untrusted evidence fixture');
  assert.equal((await lstat(bundle)).mode & 0o777, 0o400);
  assert.equal(options.env.HOME, '/nonexistent');
  assert.equal(options.env.GH_CONFIG_DIR, '/nonexistent');
  assert.equal(options.env.GH_TOKEN, undefined);
  assert.ok(options.env.XDG_CACHE_HOME.startsWith(dirname(bundle)));
  assert.equal(args.includes('--custom-trusted-root'), false);
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
    source: 'b'.repeat(40), childImage: `ghcr.io/briq-cloud/t3-cloud@sha256:${'c'.repeat(64)}`, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

test('attested complete release stages exact bytes under immutable digest', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-release-'));
  t.after(() => cleanup(root));
  await writeFile(join(root, 'runtime-attestation.jsonl'), 'untrusted evidence fixture');
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
  t.after(() => cleanup(root));
  await writeFile(join(root, 'runtime-attestation.jsonl'), 'untrusted evidence fixture');
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

test('manifest requires the Linux resource monitor file beneath its release directories', () => {
  const path = 'opt/t3/resource-monitor/linux-x64/t3-resource-monitor';
  const manifest = fixture();
  assert.equal(manifest.files.find(entry => entry.path === 'opt/t3/resource-monitor').type, 'directory');
  assert.match(validateManifest(manifest), /^sha256:/);
  manifest.files.find(entry => entry.path === path).mode = 0o644;
  assert.throws(() => validateManifest(manifest), /Incomplete release/);
  manifest.files = manifest.files.map(entry => entry.path === path ? { path, type: 'directory', mode: 0o700 } : entry);
  assert.throws(() => validateManifest(manifest), /Incomplete release/);
});

test('bad blob never creates a visible release', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-release-'));
  t.after(() => cleanup(root));
  await writeFile(join(root, 'runtime-attestation.jsonl'), 'untrusted evidence fixture');
  const blobs = join(root, 'blobs'), releases = join(root, 'releases'), manifestFile = join(root, 'manifest.json');
  await mkdir(blobs);
  await writeFile(join(blobs, fileHash), 'wrong bytes');
  await writeFile(manifestFile, JSON.stringify(fixture()));
  await assert.rejects(stageBundle(manifestFile, blobs, releases, { run }), /blob mismatch/);
  assert.deepEqual(await readdir(releases), []);
});

test('image inventory packs only declared application roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-image-'));
  t.after(() => cleanup(root));
  await writeFile(join(root, 'runtime-attestation.jsonl'), 'untrusted evidence fixture');
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
  const manifest = await packBundle(root, output, { baseImage: `sha256:${'a'.repeat(64)}`, source: 'b'.repeat(40), childImage: fixture().childImage });
  validateManifest(manifest);
  assert.equal(manifest.files.some(entry => entry.path === 'work-secret' || entry.path.startsWith('published/')), false);
  assert.deepEqual(await readFile(join(output, 'blobs', fileHash)), contents);
});

test('logical required SDK path resolves pnpm links while chained escapes and cycles fail', () => {
  const manifest = fixture();
  const logical = 'opt/t3/node_modules/@anthropic-ai/claude-agent-sdk';
  const physical = 'opt/t3/node_modules/.pnpm/sdk';
  manifest.files = manifest.files.filter(entry => entry.path !== logical && entry.path !== `${logical}/manifest.json`);
  manifest.files.push({ path: 'opt/t3/node_modules/.pnpm', type: 'directory', mode: 0o700 },
    { path: physical, type: 'directory', mode: 0o700 },
    { path: `${physical}/manifest.json`, type: 'file', mode: 0o700, size: contents.length, sha256: fileHash },
    { path: logical, type: 'symlink', target: '../.pnpm/sdk' });
  assert.match(validateManifest(manifest), /^sha256:/);
  manifest.files.push({ path: 'opt/t3/link', type: 'symlink', target: '../..' },
    { path: 'opt/t3/escape', type: 'symlink', target: 'link/../../../work' });
  assert.throws(() => validateManifest(manifest), /escapes/);
  manifest.files.pop();
  manifest.files.push({ path: 'opt/t3/cycle', type: 'symlink', target: 'cycle' });
  assert.throws(() => validateManifest(manifest), /Cyclic/);
});

test('attestation consumes captured private bytes even when original input changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-captured-')); t.after(() => cleanup(root));
  await writeFile(join(root, 'runtime-attestation.jsonl'), 'untrusted evidence fixture');
  const file = join(root, 'manifest.json'), original = JSON.stringify(fixture());
  await writeFile(file, original);
  const result = await verifyManifestAttestation(file, { run: async (_cli, args) => {
    assert.notEqual(args[2], file);
    assert.equal(await readFile(args[2], 'utf8'), original);
    const captured = args[args.indexOf('--bundle') + 1];
    assert.notEqual(captured, join(root, 'runtime-attestation.jsonl'));
    await writeFile(join(root, 'runtime-attestation.jsonl'), 'changed');
    assert.equal(await readFile(captured, 'utf8'), 'untrusted evidence fixture');
    await writeFile(file, '{}');
    return verified(certificate);
  } });
  assert.equal(result.identity, validateManifest(fixture()));
});

test('sealed staging persists manifest and cold verification rejects tampering and base mismatch', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-cold-')); t.after(() => cleanup(root));
  await writeFile(join(root, 'runtime-attestation.jsonl'), 'untrusted evidence fixture');
  const blobs = join(root, 'blobs'), file = join(root, 'manifest.json'); await mkdir(blobs);
  await writeFile(join(blobs, fileHash), contents); await writeFile(file, JSON.stringify(fixture()));
  const staged = await stageBundle(file, blobs, join(root, 'releases'), { run });
  assert.equal((await lstat(join(staged.path, 'opt/t3'))).mode & 0o777, 0o500);
  assert.equal((await verifyInstalledBundle(staged.path, staged.identity, fixture().baseImage)).childImage, fixture().childImage);
  await assert.rejects(verifyInstalledBundle(staged.path, staged.identity, `sha256:${'e'.repeat(64)}`), /base OS/);
  const target = join(staged.path, 'opt/t3/node'); await chmod(target, 0o700); await writeFile(target, 'tampered'); await chmod(target, 0o500);
  await assert.rejects(verifyInstalledBundle(staged.path, staged.identity, fixture().baseImage), /digest/);
});

test('missing, oversized and symlinked attestation evidence fail before invoking gh', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-evidence-')); t.after(() => cleanup(root));
  const file = join(root, 'manifest.json'), bundleFile = join(root, 'runtime-attestation.jsonl');
  await writeFile(file, JSON.stringify(fixture()));
  let calls = 0;
  const options = { run: async () => { calls++; return verified(certificate); } };
  await assert.rejects(verifyManifestAttestation(file, options), { code: 'ENOENT' });
  await writeFile(bundleFile, Buffer.alloc(16_000_001));
  await assert.rejects(verifyManifestAttestation(file, options), /attestation size/);
  await rm(bundleFile); await symlink(file, bundleFile);
  await assert.rejects(verifyManifestAttestation(file, options));
  assert.equal(calls, 0);
});
