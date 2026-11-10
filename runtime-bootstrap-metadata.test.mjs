import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, writeFile, rm, chmod, lstat, readlink, symlink, link } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareBootstrapMetadata, readBootstrapMigration, recoverBootstrapMigration } from './runtime-bootstrap-migration.mjs';
import { REQUIRED_BUNDLE_PATHS, stageImageBundle, validateManifest, verifyManifestAttestation, verifyInstalledBundle } from './runtime-bundle.mjs';
import { RuntimeSupervisor } from './runtime-supervisor.mjs';
import { acquireRuntimeOwnership } from './runtime-ownership.mjs';
import { testLock, testIdentity } from './fixtures/runtime-ownership.mjs';
const oldBoot = testIdentity.bootId, newBoot = '22222222-2222-2222-2222-222222222222';
const baseImage = `sha256:${'a'.repeat(64)}`, oldImage = `ghcr.io/briq-cloud/t3-cloud@sha256:${'c'.repeat(64)}`;
const targetImage = `ghcr.io/briq-cloud/t3-cloud@sha256:${'d'.repeat(64)}`, source = 'e'.repeat(40);
const marker = '{"protocol":1,"persistedBindings":"quarantine"}\n';
const generousSpace = async () => ({ bsize: 1n, bavail: 8n * 1073741824n, files: 100000n, ffree: 100000n });
async function writable(path) {
  const info = await lstat(path); if (!info.isDirectory()) return;
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await writable(join(path, name));
}
async function fixture(t, { rejectSignature = false, prepare = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 't3-metadata-migration-')), state = join(root, 'home'), imageRoot = join(root, 'image');
  const leases = [];
  t.after(async () => { for (const lease of leases) await lease.close(); await writable(root); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(state, 'central.lock'), { recursive: true });
  await writeFile(join(state, 'central.lock/pid'), 'metadata only: never consume this PID');
  const input = join(state, 'updates/bootstrap-image-input'); await mkdir(input, { recursive: true });
  const paths = [...REQUIRED_BUNDLE_PATHS, 'opt/t3-cloud/runtime-recovery.json'], dirs = new Set();
  for (const path of paths) for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) dirs.add(parent);
  const files = [...dirs].map(path => ({ path, type: 'directory', mode: 0o700 }));
  for (const path of paths) {
    const bytes = Buffer.from(path.endsWith('runtime-recovery.json') ? marker : 'fixed image application bytes');
    files.push({ path, type: 'file', mode: 0o700, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await mkdir(dirname(join(imageRoot, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(imageRoot, path), bytes, { mode: 0o700 });
  }
  // Inventory's synthetic ancestors have canonical output modes, independent of
  // the image's physical /opt, /usr and /etc parent directory modes.
  for (const path of ['opt', 'usr', 'etc']) await chmod(join(imageRoot, path), 0o755);
  const manifest = { protocol: 1, project: 'briq-cloud/t3-cloud', platform: 'linux/amd64', baseImage, source, childImage: targetImage,
    files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  await writeFile(join(input, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(input, 'runtime-attestation.jsonl'), 'publisher evidence fixture');
  const signedIdentity = validateManifest(manifest); let signatureCalls = 0;
  const run = async () => { signatureCalls++; if (rejectSignature) throw Error('Invalid publisher evidence'); return { stdout: JSON.stringify([{ verificationResult: { signature: { certificate: {
    sourceRepositoryIdentifier: '1450999885', sourceRepositoryRef: 'refs/heads/main',
  } } } }]) }; };
  const env = { T3_CLOUD_STATE: state, T3_CLOUD_OWNER_ID: 'owner', T3_CLOUD_CHILD_IMAGE: oldImage, T3_CLOUD_BOOTSTRAP_BASE_IMAGE: baseImage };
  const preparation = { identity: async () => ({ ...testIdentity, bootId: oldBoot }), verifyManifest: file => verifyManifestAttestation(file, { run }) };
  if (prepare) await prepareBootstrapMetadata(env, preparation);
  let bootId = newBoot; const starts = [];
  const acquire = async options => { const lease = await acquireRuntimeOwnership({ ...options, identity: async () => ({ ...testIdentity, bootId }), lock: testLock }); leases.push(lease); return lease; };
  const ownership = await acquire({ directory: join(state, 'updates'), name: 'loader', environmentBinding: 'owner', deferClaim: true, legacy: join(state, 'updates/loader.lock') });
  const supervisor = new RuntimeSupervisor({ state, baseImage, driver: { start: async (...args) => starts.push(args), health: async () => {}, stop: async () => {} } });
  const imageFs = { lstat: path => lstat(join(imageRoot, path)), readlink: path => readlink(join(imageRoot, path)), open: (path, flags) => open(join(imageRoot, path), flags) };
  const stage = (file, releases, options) => stageImageBundle(file, releases, { ...options, run, imageFs, space: generousSpace });
  const options = { state, env: { ...env, T3_CLOUD_CHILD_IMAGE: targetImage }, source, baseImage, supervisor, ownership,
    identity: async () => ({ ...testIdentity, bootId }), acquireOwnership: acquire, materialize: stage };
  const initialize = async () => { const receipt = await readBootstrapMigration(state); return supervisor.initialize({ ownership, bootstrapMigration: receipt.id, initialMigrationReceipt: receipt }); };
  const inputFor = async () => { const receipt = await readBootstrapMigration(state); return { action: 'recover-bootstrap-migration', expectedMigrationId: receipt.id,
    expectedMigrationRevision: receipt.revision, expectedJournalRevision: supervisor.journal.revision, expectedOwnershipRevision: ownership.revision }; };
  return { state, env, preparation, imageRoot, imageFs, manifest, signedIdentity, run, stage, starts, options, initialize, inputFor, signatureCalls: () => signatureCalls,
    setBoot: value => { bootId = value; } };
}
async function fenced(f) {
  assert.equal(f.starts.length, 0); assert.equal(f.options.supervisor.admitting, false);
  assert.equal((await lstat(join(f.state, 'central.lock'))).isDirectory(), true);
  assert.equal((await readBootstrapMigration(f.state)).phase, 'metadata-prepared');
}
test('small-disk preparation records signed metadata only, then explicit recovery materializes the exact image', async t => {
  const f = await fixture(t), receipt = await readBootstrapMigration(f.state);
  assert.equal(receipt.protocol, 2); assert.equal(receipt.mode, 'target-image'); assert.equal(receipt.phase, 'metadata-prepared');
  assert.equal(receipt.runtimeIdentity, f.signedIdentity); assert.equal(receipt.targetImage, targetImage);
  await assert.rejects(lstat(join(f.state, 'releases')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.state, 'updates/bootstrap-input')), { code: 'ENOENT' });
  assert.deepEqual((await readdir(join(f.state, 'updates/bootstrap-metadata'))).sort(), ['manifest.json', 'runtime-attestation.jsonl']);
  assert.ok(f.signatureCalls() >= 2);
  assert.deepEqual(await f.initialize(), { recoveryRequired: true }); await fenced(f);
  await recoverBootstrapMigration({ ...f.options, input: await f.inputFor() });
  const release = f.options.supervisor.releaseRoot(f.signedIdentity);
  await verifyInstalledBundle(release, f.signedIdentity, baseImage);
  assert.equal(f.starts.length, 1); assert.equal(f.starts[0][0], release); assert.deepEqual(f.starts[0][2], { recovery: true });
  assert.equal((await readBootstrapMigration(f.state)).phase, 'completed');
});
test('rejected publisher metadata never publishes an initial-migration receipt', async t => {
  const f = await fixture(t, { rejectSignature: true, prepare: false });
  await assert.rejects(prepareBootstrapMetadata(f.env, f.preparation), /Invalid publisher/);
  assert.equal(await readBootstrapMigration(f.state), null); assert.equal(f.starts.length, 0);
  await assert.rejects(lstat(join(f.state, 'releases')), { code: 'ENOENT' });
});
for (const failure of ['same boot', 'wrong image', 'wrong source', 'wrong base', 'wrong owner', 'stale CAS', 'contradictory journal', 'legacy tamper']) {
  test(`metadata recovery rejects ${failure} before materialization or legacy claim`, async t => {
    const f = await fixture(t); await f.initialize(); const input = await f.inputFor(); let materializations = 0;
    if (failure === 'same boot') f.setBoot(oldBoot);
    if (failure === 'wrong image') f.options.env.T3_CLOUD_CHILD_IMAGE = oldImage;
    if (failure === 'wrong source') f.options.source = 'f'.repeat(40);
    if (failure === 'wrong base') f.options.baseImage = `sha256:${'f'.repeat(64)}`;
    if (failure === 'wrong owner') f.options.env.T3_CLOUD_OWNER_ID = 'other';
    if (failure === 'stale CAS') input.expectedMigrationRevision++;
    if (failure === 'contradictory journal') await f.options.supervisor.save({ desired: f.signedIdentity });
    if (failure === 'legacy tamper') await writeFile(join(f.state, 'central.lock/pid'), 'changed');
    await assert.rejects(recoverBootstrapMigration({ ...f.options, input, materialize: async () => { materializations++; assert.fail(); } }));
    assert.equal(materializations, 0); await fenced(f);
  });
}
for (const failure of ['changed bytes', 'missing file', 'symlink file', 'symlink parent', 'wrong mode', 'bytes capacity', 'inodes capacity']) {
  test(`image materialization rejects ${failure} before quarantine and native work`, async t => {
    const f = await fixture(t); await f.initialize(); const file = join(f.imageRoot, 'opt/t3/node');
    if (failure === 'changed bytes') await writeFile(file, 'tampered');
    if (failure === 'missing file' || failure === 'symlink file') await rm(file);
    if (failure === 'symlink file') await symlink('source.json', file);
    if (failure === 'symlink parent') { await rm(join(f.imageRoot, 'opt/t3'), { recursive: true }); await symlink('codex', join(f.imageRoot, 'opt/t3')); }
    if (failure === 'wrong mode') await chmod(file, 0o600);
    const space = async () => ({ ...await generousSpace(), ...(failure === 'bytes capacity' ? { bavail: 1n } : failure === 'inodes capacity' ? { ffree: 1n } : {}) });
    await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.inputFor(), materialize: (path, releases, options) => stageImageBundle(path, releases, { ...options, run: f.run, imageFs: f.imageFs, space }) }));
    await fenced(f);
  });
}
test('interrupted partial image installation remains evidence and blocks a second copy', async t => {
  const f = await fixture(t); await f.initialize();
  const imageFs = { ...f.imageFs, open: async (path, flags) => { if (path === '/opt/t3/node') throw Error('Injected materialization interruption'); return f.imageFs.open(path, flags); } };
  await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.inputFor(), materialize: (path, releases, options) => stageImageBundle(path, releases, { ...options, run: f.run, imageFs, space: generousSpace }) }), /Injected/);
  const releases = join(f.state, 'releases'), before = await readdir(releases);
  assert.equal(before.length, 1); assert.match(before[0], /\.staging-/); await fenced(f);
  await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.inputFor() }), /requires inspection/);
  assert.deepEqual(await readdir(releases), before); await fenced(f);
});
test('same signed operation reuses a complete publication after interruption without overwriting it', async t => {
  const f = await fixture(t); await f.initialize();
  await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.inputFor(), materialize: async (...args) => { await f.stage(...args); throw Error('Interrupted after publication'); } }), /Interrupted/);
  const destination = f.options.supervisor.releaseRoot(f.signedIdentity), inode = (await lstat(destination)).ino;
  await fenced(f);
  await recoverBootstrapMigration({ ...f.options, input: await f.inputFor() });
  assert.equal((await lstat(destination)).ino, inode); assert.equal(f.starts.length, 1);
  assert.equal((await readBootstrapMigration(f.state)).phase, 'completed');
});
test('publication sync failure stays fenced on verified reuse until the releases parent is durable', async t => {
  const f = await fixture(t); await f.initialize();
  const releases = join(f.state, 'releases'); await mkdir(releases, { mode: 0o700 });
  const parent = await open(releases), parentInfo = await parent.stat(), prototype = Object.getPrototypeOf(parent);
  const originalSync = prototype.sync; await parent.close();
  let failSync = true, publicationSyncs = 0;
  t.mock.method(prototype, 'sync', async function () {
    const info = await this.stat();
    if (info.dev === parentInfo.dev && info.ino === parentInfo.ino) {
      publicationSyncs++;
      if (failSync) throw Error('Injected release publication fsync failure');
    }
    return originalSync.call(this);
  });
  const journal = await readFile(f.options.supervisor.file, 'utf8'), revision = f.options.ownership.revision;
  const recover = async () => recoverBootstrapMigration({ ...f.options, input: await f.inputFor() });
  const unchanged = async () => {
    await fenced(f);
    assert.equal(f.options.ownership.revision, revision);
    assert.equal(await readFile(f.options.supervisor.file, 'utf8'), journal);
    await assert.rejects(lstat(join(f.state, 'updates/bootstrap-evidence')), { code: 'ENOENT' });
  };
  // Rename succeeds, but its publication barrier fails before any legacy move.
  await assert.rejects(recover(), /Injected release publication fsync failure/);
  const destination = f.options.supervisor.releaseRoot(f.signedIdentity), inode = (await lstat(destination)).ino;
  await unchanged(); assert.equal(publicationSyncs, 1);
  // Rehashing a visible destination cannot stand in for a successful fsync.
  await assert.rejects(recover(), /Injected release publication fsync failure/);
  await unchanged(); assert.equal(publicationSyncs, 2);
  failSync = false; await recover();
  assert.equal(publicationSyncs, 3); assert.equal((await lstat(destination)).ino, inode);
  assert.equal(f.starts.length, 1); assert.equal((await readBootstrapMigration(f.state)).phase, 'completed');
});
test('versioned metadata receipt rejects an unknown mode and cannot impersonate staged preparation', async t => {
  const f = await fixture(t), path = join(f.state, 'updates/bootstrap-migration.json');
  const receipt = await readBootstrapMigration(f.state);
  for (const patch of [{ mode: 'other' }, { protocol: 3 }, { phase: 'prepared' }]) {
    await writeFile(path, JSON.stringify({ ...receipt, ...patch }));
    await assert.rejects(readBootstrapMigration(f.state), /Invalid bootstrap/);
  }
});

test('journal changed during materialization stays fenced before legacy quarantine', async t => {
  const f = await fixture(t); await f.initialize();
  await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.inputFor(), materialize: async (...args) => {
    const result = await f.stage(...args);
    await writeFile(f.options.supervisor.file, JSON.stringify({ ...f.options.supervisor.journal, revision: 999 }));
    return result;
  } }), /evidence changed during verification/);
  await fenced(f);
});


for (const mismatch of ['base', 'replacement']) test(`metadata preparation rejects invalid ${mismatch} binding`, async t => {
  const f = await fixture(t, { prepare: false });
  const input = join(f.state, 'updates/bootstrap-image-input/manifest.json');
  const manifest = { ...f.manifest, ...(mismatch === 'base' ? { baseImage: `sha256:${'f'.repeat(64)}` } : { childImage: oldImage }) };
  await writeFile(input, JSON.stringify(manifest));
  await assert.rejects(prepareBootstrapMetadata(f.env, f.preparation), /metadata identity mismatch/);
  assert.equal(await readBootstrapMigration(f.state), null);
});

test('a signed path outside application roots never copies home data', async t => {
  const f = await fixture(t, { prepare: false }), bytes = Buffer.from('home sentinel');
  f.manifest.files.push({ path: 'work', type: 'directory', mode: 0o700 },
    { path: 'work/sentinel', type: 'file', mode: 0o600, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  await writeFile(join(f.state, 'updates/bootstrap-image-input/manifest.json'), JSON.stringify(f.manifest));
  await prepareBootstrapMetadata(f.env, f.preparation); await f.initialize();
  let readHome = false;
  const imageFs = { ...f.imageFs, open: (path, flags) => { if (path.startsWith('/work')) readHome = true; return f.imageFs.open(path, flags); } };
  await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.inputFor(), materialize: (path, releases, options) => stageImageBundle(path, releases, { ...options, run: f.run, imageFs, space: generousSpace }) }), /outside application roots/);
  assert.equal(readHome, false); await fenced(f);
});

test('a lost journal after an owned protocol-2 launch never fabricates a new bootstrap journal', async t => {
  const f = await fixture(t); await f.initialize();
  f.options.supervisor.driver.health = async () => { throw Error('unhealthy'); };
  await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.inputFor() }), /unhealthy/);
  const receipt = await readBootstrapMigration(f.state); assert.equal(receipt.phase, 'recovering');
  await rm(f.options.supervisor.file); f.setBoot('33333333-3333-3333-3333-333333333333');
  const supervisor = new RuntimeSupervisor({ state: f.state, baseImage, driver: { start() { assert.fail(); } } });
  assert.deepEqual(await supervisor.initialize({ ownership: f.options.ownership, bootstrapMigration: receipt.id, initialMigrationReceipt: receipt }), { recoveryRequired: true });
  await assert.rejects(recoverBootstrapMigration({ ...f.options, supervisor, input: { ...await f.inputFor(), expectedJournalRevision: supervisor.journal.revision } }), /Contradictory/);
  await assert.rejects(lstat(supervisor.file), { code: 'ENOENT' }); assert.equal(f.starts.length, 1);
});


test('hardlinked image source is copied to an independent single-link verified release', async t => {
  const f = await fixture(t); await f.initialize();
  const source = join(f.imageRoot, 'opt/t3/node'), alias = join(dirname(f.state), 'image-node-alias');
  await link(source, alias);
  assert.equal((await lstat(source)).nlink, 2);
  await recoverBootstrapMigration({ ...f.options, input: await f.inputFor() });
  const root = f.options.supervisor.releaseRoot(f.signedIdentity), installed = join(root, 'opt/t3/node');
  const target = await lstat(installed), original = await lstat(source);
  assert.equal(target.nlink, 1); assert.notEqual(target.ino, original.ino);
  await verifyInstalledBundle(root, f.signedIdentity, baseImage);
  await writeFile(alias, Buffer.alloc(original.size, 120));
  await verifyInstalledBundle(root, f.signedIdentity, baseImage);
  // Independently created target files must still have no other hardlinks.
  await link(installed, join(dirname(f.state), 'installed-node-alias'));
  await assert.rejects(verifyInstalledBundle(root, f.signedIdentity, baseImage), /hardlinked/);
  assert.equal(f.starts.length, 1);
});

test('corrupted hardlinked image source fails its signed hash before publication or quarantine', async t => {
  const f = await fixture(t); await f.initialize();
  const source = join(f.imageRoot, 'opt/t3/node'), alias = join(dirname(f.state), 'image-node-alias');
  await link(source, alias);
  await writeFile(alias, Buffer.alloc((await lstat(source)).size, 120));
  assert.equal((await lstat(source)).nlink, 2);
  await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.inputFor() }), /Release blob mismatch/);
  await assert.rejects(lstat(f.options.supervisor.releaseRoot(f.signedIdentity)), { code: 'ENOENT' });
  await fenced(f);
});
