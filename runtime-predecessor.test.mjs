import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedSkillPredecessor } from './runtime-supervisor.mjs';

const selected = `sha256:${'a'.repeat(64)}`, previous = `sha256:${'b'.repeat(64)}`, baseImage = `sha256:${'c'.repeat(64)}`;
test('predecessor authority survives manager replacement and cold starts without new loader fields', async t => {
  const state = await mkdtemp(join(tmpdir(), 't3-predecessor-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  await mkdir(join(state, 'updates'));
  const input = { state, selected, baseImage, environmentBinding: 'owner' };
  const journal = { protocol: 1, current: 'bootstrap', desired: selected, staged: selected, phase: 'starting', receipt: { from: 'bootstrap', to: selected, status: 'pending' } };
  const save = () => writeFile(join(state, 'updates/activation.json'), JSON.stringify(journal), { mode: 0o600 });
  await save();
  assert.equal(await managedSkillPredecessor(input), '/opt/t3-cloud/skills/briq');
  journal.current = selected; journal.desired = null; journal.staged = null; journal.receipt.status = 'committed'; await save();
  assert.equal(await managedSkillPredecessor(input), '/opt/t3-cloud/skills/briq');
  journal.receipt.from = previous; await save();
  const checks = [];
  assert.equal(await managedSkillPredecessor(input, { verify: async (...args) => { checks.push(args); } }),
    join(state, 'releases', previous.replace(':', '-'), 'opt/t3-cloud/skills/briq'));
  assert.deepEqual(checks, [[join(state, 'releases', previous.replace(':', '-')), previous, baseImage]]);
  await assert.rejects(managedSkillPredecessor(input, { verify: async () => { throw Error('corrupt prior release'); } }), /corrupt prior/);
  journal.receipt.to = previous; await save();
  await assert.rejects(managedSkillPredecessor(input), /predecessor unavailable/);
});

test('prior manifest authority rejects malformed journals, changed inventory and physical parent substitution', async t => {
  const state = await mkdtemp(join(tmpdir(), 't3-predecessor-manifest-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  await mkdir(join(state, 'updates'));
  const manifest = { baseImage, files: [{ path: 'opt/t3-cloud/skills/briq', type: 'directory' },
    { path: 'opt/t3-cloud/skills/briq/SKILL.md', type: 'file' }] };
  const from = `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
  const root = join(state, 'releases', from.replace(':', '-'));
  await mkdir(join(root, 'opt/t3-cloud/skills/briq'), { recursive: true });
  const manifestPath = join(root, '.release-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o400 });
  const journalPath = join(state, 'updates/activation.json');
  const journal = { protocol: 1, current: from, desired: selected, staged: selected, phase: 'starting',
    receipt: { from, to: selected, status: 'pending' } };
  const input = { state, selected, baseImage };
  await writeFile(journalPath, '{', { mode: 0o600 });
  await assert.rejects(managedSkillPredecessor(input), SyntaxError);
  await writeFile(journalPath, JSON.stringify(journal));
  assert.equal(await managedSkillPredecessor(input), join(root, 'opt/t3-cloud/skills/briq'));
  await assert.rejects(managedSkillPredecessor({ ...input, baseImage: previous }), /identity mismatch/);
  await rm(manifestPath); await writeFile(manifestPath, JSON.stringify({ ...manifest, files: [] }), { mode: 0o400 });
  await assert.rejects(managedSkillPredecessor(input), /identity mismatch/);
  await rm(manifestPath); await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o400 });
  const source = join(state, 'replacement'); await mkdir(source);
  await rm(join(root, 'opt/t3-cloud/skills/briq'), { recursive: true });
  await symlink(source, join(root, 'opt/t3-cloud/skills/briq'));
  await assert.rejects(managedSkillPredecessor(input), /Unsafe skill predecessor directory/);
});

test('bootstrap predecessor without activation receipt requires matching initial migration history', async t => {
  const state = await mkdtemp(join(tmpdir(), 't3-predecessor-migration-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  await mkdir(join(state, 'updates'));
  const id = '11111111-1111-4111-8111-111111111111', generation = '22222222-2222-4222-8222-222222222222';
  const journal = { protocol: 1, current: selected, desired: null, staged: null, phase: 'starting', receipt: null,
    initialMigration: id, initialInstall: id, initialJournalGeneration: generation, recovery: 'persisted-bindings-quarantined' };
  await writeFile(join(state, 'updates/activation.json'), JSON.stringify(journal), { mode: 0o600 });
  const input = { state, selected, baseImage, environmentBinding: 'owner' };
  const migration = { id, phase: 'recovering', environmentBinding: 'owner', runtimeIdentity: selected, baseImage, journalGeneration: generation };
  const readMigration = async () => migration;
  assert.equal(await managedSkillPredecessor(input, { readMigration }), '/opt/t3-cloud/skills/briq');
  migration.phase = 'completed';
  assert.equal(await managedSkillPredecessor(input, { readMigration }), '/opt/t3-cloud/skills/briq');
  for (const patch of [{ environmentBinding: 'other' }, { runtimeIdentity: previous }, { journalGeneration: id }, { phase: 'prepared' }])
    assert.equal(await managedSkillPredecessor(input, { readMigration: async () => ({ ...migration, ...patch }) }), undefined);
});
