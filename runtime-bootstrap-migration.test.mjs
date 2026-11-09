import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rename, writeFile, rm, stat, chmod, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareBootstrapMigration, readBootstrapMigration, recoverBootstrapMigration } from './runtime-bootstrap-migration.mjs';
import { stageBundle, REQUIRED_BUNDLE_PATHS, validateManifest } from './runtime-bundle.mjs';
import { RuntimeSupervisor } from './runtime-supervisor.mjs';
import { acquireRuntimeOwnership } from './runtime-ownership.mjs';
import { testLock, testIdentity } from './fixtures/runtime-ownership.mjs';
const oldBoot = testIdentity.bootId, newBoot = '22222222-2222-2222-2222-222222222222';
const baseImage = `sha256:${'a'.repeat(64)}`, runtimeIdentity = `sha256:${'b'.repeat(64)}`;
const oldImage = `ghcr.io/briq-cloud/t3-cloud@sha256:${'c'.repeat(64)}`;
const targetImage = `ghcr.io/briq-cloud/t3-cloud@sha256:${'d'.repeat(64)}`;
const source = 'e'.repeat(40);
async function fixture(t, { loaderEvidence = false } = {}) {
  const state = await mkdtemp(join(tmpdir(), 't3-initial-migration-'));
  const leases = []; t.after(async () => { for (const lease of leases) await lease.close(); await rm(state, { recursive: true, force: true }); });
  await mkdir(join(state, 'central.lock')); await writeFile(join(state, 'central.lock/pid'), 'do not use this persisted PID');
  if (loaderEvidence) await mkdir(join(state, 'updates/loader.lock'), { recursive: true });
  const env = { T3_CLOUD_STATE: state, T3_CLOUD_OWNER_ID: 'owner', T3_CLOUD_CHILD_IMAGE: oldImage, T3_CLOUD_BOOTSTRAP_BASE_IMAGE: baseImage };
  const manifest = { baseImage, childImage: targetImage, source, files: [{ path: 'opt/t3-cloud/runtime-recovery.json', type: 'file', sha256: createHash('sha256').update('{"protocol":1,"persistedBindings":"quarantine"}\n').digest('hex') }] };
  await prepareBootstrapMigration(env, { identity: async () => ({ ...testIdentity, bootId: oldBoot }), stage: async () => ({ identity: runtimeIdentity, path: '/mock-staged' }), verify: async () => manifest });
  let bootId = newBoot, healthFails = false; const starts = [];
  const acquire = async options => { const lease = await acquireRuntimeOwnership({ ...options, identity: async () => ({ ...testIdentity, bootId }), lock: testLock }); leases.push(lease); return lease; };
  const ownership = await acquire({ directory: join(state, 'updates'), name: 'loader', environmentBinding: 'owner', deferClaim: true, legacy: join(state, 'updates/loader.lock') });
  const supervisor = new RuntimeSupervisor({ state, baseImage, verify: async () => manifest, driver: { start: async (...args) => starts.push(args), health: async () => { if (healthFails) throw Error('unhealthy'); }, stop: async () => {} } });
  const receipt = await readBootstrapMigration(state);
  assert.deepEqual(await supervisor.initialize({ ownership, bootstrapMigration: receipt.id }), { recoveryRequired: true });
  const options = { state, env: { ...env, T3_CLOUD_CHILD_IMAGE: targetImage }, source, baseImage, supervisor, ownership,
    identity: async () => ({ ...testIdentity, bootId }), acquireOwnership: acquire };
  const input = async () => { const r = await readBootstrapMigration(state); return { action: 'recover-bootstrap-migration', expectedMigrationId: r.id, expectedMigrationRevision: r.revision, expectedJournalRevision: supervisor.journal.revision, expectedOwnershipRevision: ownership.revision }; };
  return { state, starts, manifest, supervisor, ownership, options, input, setBoot: value => { bootId = value; }, acquire, healthy: () => { healthFails = false; }, failHealth: () => { healthFails = true; } };
}
test('explicit changed-boot recovery adopts verified release without activation history and preserves lock evidence', async t => {
  const f = await fixture(t); assert.equal(f.starts.length, 0); assert.equal(f.supervisor.admitting, false);
  await recoverBootstrapMigration({ ...f.options, input: await f.input() });
  assert.equal(f.starts.length, 1); assert.equal(f.starts[0][1].childImage, targetImage); assert.deepEqual(f.starts[0][2], { recovery: true });
  assert.equal(f.supervisor.journal.current, runtimeIdentity); assert.equal(f.supervisor.journal.receipt, null); assert.ok(f.supervisor.journal.initialInstall);
  const receipt = await readBootstrapMigration(f.state); assert.equal(receipt.phase, 'completed'); assert.equal(f.supervisor.admitting, true);
  assert.equal(await readFile(join(f.state, 'updates/bootstrap-evidence', receipt.id, '0.lock/pid'), 'utf8'), 'do not use this persisted PID');
  await assert.rejects(stat(join(f.state, 'central.lock')), { code: 'ENOENT' });
});
function observedEvidenceFs(events, failSync = () => false) {
  return {
    mkdir: async (...args) => { events.push(['mkdir', args[0]]); return mkdir(...args); },
    rename: async (...args) => { events.push(['rename', ...args]); return rename(...args); },
    open: async (path, flags) => {
      assert.equal(flags, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const handle = await open(path, flags);
      return {
        sync: async () => { events.push(['sync', path]); if (failSync(path)) throw Error('Injected directory fsync failure'); await handle.sync(); },
        close: async () => { events.push(['close', path]); await handle.close(); },
      };
    },
  };
}
test('quarantine durably publishes its parent chain before either legacy rename and syncs both rename parents', async t => {
  const f = await fixture(t, { loaderEvidence: true }), events = [];
  const receipt = await readBootstrapMigration(f.state);
  const updates = join(f.state, 'updates'), root = join(updates, 'bootstrap-evidence'), evidence = join(root, receipt.id);
  await recoverBootstrapMigration({ ...f.options, input: await f.input(), evidenceFs: observedEvidenceFs(events) });
  const synced = path => [['sync', path], ['close', path]];
  assert.deepEqual(events, [
    ['mkdir', evidence], ...synced(evidence), ...synced(root), ...synced(updates),
    ['rename', join(f.state, 'central.lock'), join(evidence, '0.lock')], ...synced(f.state), ...synced(evidence),
    ['rename', join(updates, 'loader.lock'), join(evidence, '1.lock')], ...synced(updates), ...synced(evidence),
  ]);
});
for (const failedDirectory of ['leaf', 'evidence parent', 'updates parent']) {
  test(`failure syncing ${failedDirectory} leaves all original evidence and retry syncs existing parents`, async t => {
    const f = await fixture(t, { loaderEvidence: true }), events = [];
    const receipt = await readBootstrapMigration(f.state), updates = join(f.state, 'updates');
    const root = join(updates, 'bootstrap-evidence'), evidence = join(root, receipt.id);
    const chain = [evidence, root, updates], failedPath = chain[['leaf', 'evidence parent', 'updates parent'].indexOf(failedDirectory)];
    await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.input(), evidenceFs: observedEvidenceFs(events, path => path === failedPath) }), /Injected directory fsync failure/);
    assert.deepEqual(events.filter(event => event[0] === 'sync').map(event => event[1]), chain.slice(0, chain.indexOf(failedPath) + 1));
    assert.deepEqual(events.at(-1), ['close', failedPath]);
    assert.equal(events.some(event => event[0] === 'rename'), false);
    assert.equal(await readFile(join(f.state, 'central.lock/pid'), 'utf8'), 'do not use this persisted PID');
    assert.equal((await stat(join(updates, 'loader.lock'))).isDirectory(), true);
    await assert.rejects(stat(join(evidence, '0.lock')), { code: 'ENOENT' });
    await assert.rejects(stat(join(evidence, '1.lock')), { code: 'ENOENT' });
    assert.equal(f.starts.length, 0); assert.equal(f.supervisor.admitting, false);
    assert.equal((await readBootstrapMigration(f.state)).phase, 'recovering');
    events.length = 0; f.setBoot('33333333-3333-3333-3333-333333333333');
    await recoverBootstrapMigration({ ...f.options, input: await f.input(), evidenceFs: observedEvidenceFs(events) });
    assert.deepEqual(events.filter(event => event[0] === 'sync').slice(0, 3).map(event => event[1]), chain);
    assert.ok(events.findIndex(event => event[0] === 'rename') > events.findIndex(event => event[0] === 'close' && event[1] === updates));
    assert.equal((await readBootstrapMigration(f.state)).phase, 'completed');
  });
}
for (const failure of ['same boot', 'copied binding', 'changed image', 'changed artifact', 'legacy tamper', 'stale CAS', 'contradictory journal']) {
  test(`${failure} keeps bootstrap recovery closed without starting native work`, async t => {
    const f = await fixture(t); const input = await f.input();
    if (failure === 'same boot') f.setBoot(oldBoot);
    if (failure === 'copied binding') f.options.env.T3_CLOUD_OWNER_ID = 'other';
    if (failure === 'changed image') f.options.env.T3_CLOUD_CHILD_IMAGE = oldImage;
    if (failure === 'changed artifact') f.manifest.childImage = oldImage;
    if (failure === 'legacy tamper') await writeFile(join(f.state, 'central.lock/pid'), 'changed');
    if (failure === 'stale CAS') input.expectedMigrationRevision++;
    if (failure === 'contradictory journal') await f.supervisor.save({ receipt: { status: 'committed' } });
    await assert.rejects(recoverBootstrapMigration({ ...f.options, input }));
    assert.equal(f.starts.length, 0); assert.equal(f.supervisor.admitting, false); assert.equal((await readBootstrapMigration(f.state)).phase, 'prepared');
  });
}
test('health failure retains recovering receipt and fences retries with unknown live ownership', async t => {
  const f = await fixture(t); f.failHealth();
  await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.input() }), /unhealthy/);
  assert.equal((await readBootstrapMigration(f.state)).phase, 'recovering'); assert.equal(f.supervisor.journal.phase, 'recovery-required'); assert.equal(f.supervisor.admitting, false);
  await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.input() }), /unresolved/);
  assert.equal(f.starts.length, 1);
});
test('lost migration journal cannot fabricate a fresh initial journal during recovering operation', async t => {
  const f = await fixture(t); f.failHealth(); await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.input() }));
  f.setBoot('33333333-3333-3333-3333-333333333333');
  await rm(f.supervisor.file);
  const next = new RuntimeSupervisor({ state: f.state, baseImage, driver: { start() { assert.fail(); } }, verify: async () => f.manifest });
  await next.initialize({ ownership: f.ownership, bootstrapMigration: (await readBootstrapMigration(f.state)).id });
  const input = { ...await f.input(), expectedJournalRevision: next.journal.revision };
  await assert.rejects(recoverBootstrapMigration({ ...f.options, supervisor: next, input }), /Contradictory/);
});


test('the same operation resumes after an interrupted owned launch only on another cold boot', async t => {
  const f = await fixture(t); f.failHealth();
  await assert.rejects(recoverBootstrapMigration({ ...f.options, input: await f.input() }), /unhealthy/);
  const before = await readBootstrapMigration(f.state);
  await f.ownership.close();
  f.setBoot('33333333-3333-3333-3333-333333333333'); f.healthy();
  const ownership = await f.acquire({ directory: join(f.state, 'updates'), name: 'loader', environmentBinding: 'owner', deferClaim: true, legacy: join(f.state, 'updates/loader.lock') });
  const next = new RuntimeSupervisor({ state: f.state, baseImage, driver: f.supervisor.driver, verify: async () => f.manifest });
  await next.initialize({ ownership, bootstrapMigration: before.id });
  await recoverBootstrapMigration({ ...f.options, supervisor: next, ownership, input: { ...await f.input(), expectedOwnershipRevision: ownership.revision, expectedJournalRevision: next.journal.revision } });
  const completed = await readBootstrapMigration(f.state);
  assert.equal(completed.id, before.id); assert.equal(completed.phase, 'completed'); assert.equal(completed.observedColdBootId, '33333333-3333-3333-3333-333333333333');
  assert.equal(f.starts.length, 2); assert.equal(next.admitting, true);
});

for (const contradiction of ['missing', 'fresh bootstrap', 'wrong migration', 'wrong journal generation', 'wrong installed runtime']) {
  test(`completed migration with ${contradiction} activation history never starts or invents bootstrap state`, async t => {
    const f = await fixture(t);
    await recoverBootstrapMigration({ ...f.options, input: await f.input() });
    await f.supervisor.shutdown();
    const receipt = await readBootstrapMigration(f.state);
    if (contradiction === 'missing') await rm(f.supervisor.file);
    else {
      const journal = contradiction === 'fresh bootstrap' ? { protocol: 1, current: 'bootstrap', staged: null, desired: null, phase: 'stopped', receipt: null } : { ...f.supervisor.journal };
      if (contradiction === 'wrong migration') journal.initialMigration = '44444444-4444-4444-4444-444444444444';
      if (contradiction === 'wrong journal generation') journal.initialJournalGeneration = '44444444-4444-4444-4444-444444444444';
      if (contradiction === 'wrong installed runtime') journal.current = `sha256:${'f'.repeat(64)}`;
      await writeFile(f.supervisor.file, JSON.stringify(journal));
    }
    const original = await readFile(f.supervisor.file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const starts = [];
    const next = new RuntimeSupervisor({ state: f.state, baseImage, driver: { start: async (...args) => starts.push(args), health: async () => {} }, verify: async () => f.manifest });
    assert.deepEqual(await next.initialize({ ownership: { evidence: 'cold' }, initialMigrationReceipt: receipt }), { recoveryRequired: true });
    assert.equal(next.admitting, false); assert.deepEqual(starts, []); assert.equal(next.recoverable(), false);
    if (original === null) await assert.rejects(readFile(next.file), { code: 'ENOENT' });
    else assert.equal(await readFile(next.file, 'utf8'), original);
  });
}
test('completed migration with matching stopped history resumes only the installed release in recovery mode', async t => {
  const f = await fixture(t);
  await recoverBootstrapMigration({ ...f.options, input: await f.input() }); await f.supervisor.shutdown();
  const receipt = await readBootstrapMigration(f.state), starts = [];
  const next = new RuntimeSupervisor({ state: f.state, baseImage, driver: { start: async (...args) => starts.push(args), health: async () => {} }, verify: async () => f.manifest });
  assert.deepEqual(await next.initialize({ initialMigrationReceipt: receipt }), { recoveryRequired: false });
  assert.equal(starts.length, 1); assert.equal(starts[0][0], next.releaseRoot(runtimeIdentity)); assert.deepEqual(starts[0][2], { recovery: true });
});

async function publishedPreparationFixture(t) {
  const state = await mkdtemp(join(tmpdir(), 't3-prepare-interruption-'));
  async function writable(path) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(path, entry.name));
  }
  t.after(async () => { await writable(state); await rm(state, { recursive: true, force: true }); });
  await mkdir(join(state, 'central.lock'));
  const input = join(state, 'updates/bootstrap-input'); await mkdir(join(input, 'blobs'), { recursive: true });
  const bytes = Buffer.from('fixed published runtime fixture'), hash = createHash('sha256').update(bytes).digest('hex');
  const directories = new Set();
  for (const path of REQUIRED_BUNDLE_PATHS) for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) directories.add(parent);
  const files = [...directories].map(path => ({ path, type: 'directory', mode: 0o700 }));
  for (const path of REQUIRED_BUNDLE_PATHS) files.push({ path, type: 'file', mode: 0o700, size: bytes.length, sha256: hash });
  const manifest = { protocol: 1, project: 'briq-cloud/t3-cloud', platform: 'linux/amd64', baseImage, source, childImage: targetImage, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  const manifestFile = join(input, 'manifest.json');
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(join(input, 'blobs', hash), bytes);
  await writeFile(join(input, 'runtime-attestation.jsonl'), 'signed fixture evidence');
  let verifications = 0, rejectAttestation = false;
  const run = async () => {
    verifications++;
    if (rejectAttestation) throw Error('Publisher verification failed');
    return { stdout: JSON.stringify([{ verificationResult: { signature: { certificate: { sourceRepositoryIdentifier: '1450999885', sourceRepositoryRef: 'refs/heads/main' } } } }]) };
  };
  const options = { identity: async () => ({ ...testIdentity, bootId: oldBoot }),
    stage: (file, blobs, releases, options) => stageBundle(file, blobs, releases, { ...options, run }) };
  const env = { T3_CLOUD_STATE: state, T3_CLOUD_OWNER_ID: 'owner', T3_CLOUD_CHILD_IMAGE: oldImage, T3_CLOUD_BOOTSTRAP_BASE_IMAGE: baseImage };
  const release = join(state, 'releases', validateManifest(manifest).replace(':', '-'));
  return { state, input, env, options, release, verifications: () => verifications, rejectAttestation: () => { rejectAttestation = true; } };
}
test('preparation resumes after durable release publication without a receipt by rechecking attestation and every installed byte', async t => {
  const f = await publishedPreparationFixture(t);
  await assert.rejects(prepareBootstrapMigration(f.env, { ...f.options, verify: async () => { throw Error('Interrupted after release publication'); } }), /Interrupted/);
  assert.equal((await stat(f.release)).isDirectory(), true); assert.equal(await readBootstrapMigration(f.state), null);
  assert.equal(f.verifications(), 1);
  const receipt = await prepareBootstrapMigration(f.env, f.options);
  assert.equal(receipt.phase, 'prepared'); assert.equal(f.verifications(), 2);
  assert.equal((await readBootstrapMigration(f.state)).runtimeIdentity, `sha256:${f.release.split('sha256-').at(-1)}`);
});
for (const contradiction of ['rejected publisher', 'changed installed bytes', 'changed manifest']) {
  test(`interrupted preparation rejects ${contradiction} without publishing a receipt`, async t => {
    const f = await publishedPreparationFixture(t);
    await assert.rejects(prepareBootstrapMigration(f.env, { ...f.options, verify: async () => { throw Error('Interrupted after release publication'); } }), /Interrupted/);
    if (contradiction === 'rejected publisher') f.rejectAttestation();
    if (contradiction === 'changed installed bytes') {
      const file = join(f.release, 'opt/t3/node'); await chmod(file, 0o700); await writeFile(file, 'changed runtime bytes'); await chmod(file, 0o500);
    }
    if (contradiction === 'changed manifest') {
      const file = join(f.release, '.release-manifest.json'); await chmod(file, 0o600);
      const manifest = JSON.parse(await readFile(file, 'utf8')); manifest.childImage = oldImage; await writeFile(file, JSON.stringify(manifest)); await chmod(file, 0o400);
    }
    await assert.rejects(prepareBootstrapMigration(f.env, f.options));
    assert.equal(await readBootstrapMigration(f.state), null); assert.equal(f.verifications(), 2);
  });
}
