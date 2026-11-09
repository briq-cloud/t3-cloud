import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareBootstrapMigration, readBootstrapMigration, recoverBootstrapMigration } from './runtime-bootstrap-migration.mjs';
import { RuntimeSupervisor } from './runtime-supervisor.mjs';
import { acquireRuntimeOwnership } from './runtime-ownership.mjs';
import { testLock, testIdentity } from './fixtures/runtime-ownership.mjs';
const oldBoot = testIdentity.bootId, newBoot = '22222222-2222-2222-2222-222222222222';
const baseImage = `sha256:${'a'.repeat(64)}`, runtimeIdentity = `sha256:${'b'.repeat(64)}`;
const oldImage = `ghcr.io/briq-cloud/t3-cloud@sha256:${'c'.repeat(64)}`;
const targetImage = `ghcr.io/briq-cloud/t3-cloud@sha256:${'d'.repeat(64)}`;
const source = 'e'.repeat(40);
async function fixture(t) {
  const state = await mkdtemp(join(tmpdir(), 't3-initial-migration-'));
  const leases = []; t.after(async () => { for (const lease of leases) await lease.close(); await rm(state, { recursive: true, force: true }); });
  await mkdir(join(state, 'central.lock')); await writeFile(join(state, 'central.lock/pid'), 'do not use this persisted PID');
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
