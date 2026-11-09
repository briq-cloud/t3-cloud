// One initial image replacement, explicitly acknowledged by the owner after a
// kernel boot change. This protocol never copies roots or reads login material.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { durableJson } from './runtime-supervisor.mjs';
import { linuxIdentity, acquireRuntimeOwnership } from './runtime-ownership.mjs';
import { stageBundle, verifyInstalledBundle } from './runtime-bundle.mjs';

const image = value => /^ghcr\.io\/briq-cloud\/t3-cloud@sha256:[a-f0-9]{64}$/.test(value ?? '');
const binding = value => /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/.test(value ?? '');
const sha = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
const boot = value => /^[a-f0-9-]{36}$/.test(value ?? '');
const revision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const names = ['central.lock', 'updates/loader.lock'];
const fileFor = state => join(state, 'updates/bootstrap-migration.json');
async function absent(path) { try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }
async function fingerprint(path) {
  if (await absent(path)) return null;
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Invalid legacy lock directory');
  // Bound the inventory to direct lock entries, and hash metadata only. Do not
  // open any legacy file: persisted PIDs confer no process authority.
  const entries = await readdir(path);
  if (entries.length > 16) throw Error('Legacy lock inventory exceeds limit');
  const children = [];
  for (const name of entries.sort()) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(name)) throw Error('Invalid legacy lock entry');
    const child = await lstat(join(path, name));
    if (!child.isFile() || child.isSymbolicLink()) throw Error('Invalid legacy lock entry');
    children.push({ name, dev: String(child.dev), ino: String(child.ino), size: child.size, mode: child.mode, mtimeMs: child.mtimeMs });
  }
  return revision({ dev: String(info.dev), ino: String(info.ino), mode: info.mode, children });
}
async function noHistory(state) {
  for (const name of ['updates/activation.json', 'updates/loader.ownership.json', 'central.ownership.json'])
    if (!await absent(join(state, name))) throw Error('Historical runtime state contradicts initial migration');
}
export async function readBootstrapMigration(state) {
  let record;
  try {
    const handle = await open(fileFor(state), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 65536 || info.mode & 0o077) throw Error('Unsafe bootstrap receipt');
      const bytes = Buffer.alloc(info.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size) throw Error('Bootstrap receipt changed');
      record = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw Error('Bootstrap migration receipt unavailable'); }
  if (record?.protocol !== 1 || record.kind !== 'initial-bootstrap' || !boot(record.id) ||
      !Number.isSafeInteger(record.revision) || record.revision < 1 || !['prepared', 'recovering', 'completed'].includes(record.phase) ||
      !binding(record.environmentBinding) || !boot(record.preparationBootId) ||
      !(record.observedColdBootId === null || boot(record.observedColdBootId)) ||
      !image(record.sourceImage) || !image(record.targetImage) || !/^[a-f0-9]{40}$/.test(record.targetSource ?? '') ||
      !sha(record.runtimeIdentity) || !sha(record.baseImage) || !Array.isArray(record.legacyEvidence) ||
      record.legacyEvidence.length !== names.length || record.legacyEvidence.some((item, i) => item.path !== names[i] || !(item.fingerprint === null || /^[a-f0-9]{64}$/.test(item.fingerprint)))) throw Error('Invalid bootstrap migration receipt');
  return record;
}
export async function prepareBootstrapMigration(env = process.env, { identity = linuxIdentity, stage = stageBundle, verify = verifyInstalledBundle } = {}) {
  const state = env.T3_CLOUD_STATE;
  if (!state?.startsWith('/') || !binding(env.T3_CLOUD_OWNER_ID) || !image(env.T3_CLOUD_CHILD_IMAGE)) throw Error('Trusted deployment identity required');
  await mkdir(join(state, 'updates'), { recursive: true, mode: 0o700 });
  if (!sha(env.T3_CLOUD_BOOTSTRAP_BASE_IMAGE)) throw Error('Pinned target base required');
  if (!await absent('/opt/t3-bootstrap/runtime-loader.mjs')) throw Error('Preparation requires legacy bootstrap');
  if (await readBootstrapMigration(state)) throw Error('Bootstrap migration already prepared');
  await noHistory(state);
  const local = await identity();
  const input = join(state, 'updates/bootstrap-input');
  const staged = await stage(join(input, 'manifest.json'), join(input, 'blobs'), join(state, 'releases'), { reuseVerifiedExisting: true });
  const manifest = await verify(staged.path, staged.identity, env.T3_CLOUD_BOOTSTRAP_BASE_IMAGE);
  if (manifest.childImage === env.T3_CLOUD_CHILD_IMAGE) throw Error('Replacement image must differ');
  const legacyEvidence = [];
  for (const path of names) legacyEvidence.push({ path, fingerprint: await fingerprint(join(state, path)) });
  if (!legacyEvidence.some(item => item.fingerprint !== null)) throw Error('Legacy ownership evidence required');
  await noHistory(state);
  const record = { protocol: 1, kind: 'initial-bootstrap', id: randomUUID(), revision: 1, phase: 'prepared',
    environmentBinding: env.T3_CLOUD_OWNER_ID, preparationBootId: local.bootId, observedColdBootId: null,
    sourceImage: env.T3_CLOUD_CHILD_IMAGE, targetImage: manifest.childImage, targetSource: manifest.source,
    runtimeIdentity: staged.identity, baseImage: manifest.baseImage, legacyEvidence };
  // Exclusive receipt reservation prevents two preparations from replacing proof.
  const reservation = await open(fileFor(state), 'wx', 0o600);
  try { await reservation.writeFile(JSON.stringify(record)); await reservation.sync(); } finally { await reservation.close(); }
  const directory = await open(join(state, 'updates'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  return { id: record.id, revision: record.revision, phase: record.phase };
}
export async function recoverBootstrapMigration({ state, env, source, baseImage, supervisor, ownership, input,
  identity = linuxIdentity, acquireOwnership = acquireRuntimeOwnership, evidenceFs = { mkdir, open, rename } }) {
  return supervisor.exclusive(async () => {
    let record = await readBootstrapMigration(state);
    if (!record || record.phase === 'completed' || input.action !== 'recover-bootstrap-migration' || input.expectedMigrationId !== record.id ||
        input.expectedMigrationRevision !== record.revision || input.expectedJournalRevision !== supervisor.journal.revision ||
        input.expectedOwnershipRevision !== ownership.revision) throw Error('Bootstrap migration evidence changed');
    const local = await identity();
    if (record.environmentBinding !== env.T3_CLOUD_OWNER_ID || record.preparationBootId === local.bootId || record.phase === 'recovering' && record.observedColdBootId === local.bootId ||
        record.targetImage !== env.T3_CLOUD_CHILD_IMAGE || record.targetSource !== source || record.baseImage !== baseImage) throw Error('Bootstrap replacement identity unresolved');
    const release = await supervisor.verifyRelease(record.runtimeIdentity);
    if (!release.files?.some(entry => entry.path === 'opt/t3-cloud/runtime-recovery.json' && entry.type === 'file' && entry.sha256 === createHash('sha256').update('{"protocol":1,"persistedBindings":"quarantine"}\n').digest('hex')) || release.source !== source || release.childImage !== record.targetImage) throw Error('Bootstrap artifact changed');
    const j = supervisor.journal;
    if (j.initialMigration !== record.id || !boot(j.initialJournalGeneration) ||
        record.phase === 'recovering' && record.journalGeneration !== j.initialJournalGeneration || j.receipt !== null || j.desired !== null ||
        !(j.current === 'bootstrap' && j.phase === 'stopped' || j.current === record.runtimeIdentity && j.initialInstall === record.id && ['starting', 'running', 'recovery-required', 'stopped'].includes(j.phase))) throw Error('Contradictory initial activation journal');
    if (JSON.stringify(JSON.parse(await readFile(supervisor.file, 'utf8'))) !== JSON.stringify(j)) throw Error('Activation journal changed');
    if (record.phase === 'prepared') {
      for (const item of record.legacyEvidence) if (await fingerprint(join(state, item.path)) !== item.fingerprint) throw Error('Legacy lock evidence changed');
      record = { ...record, phase: 'recovering', journalGeneration: j.initialJournalGeneration, observedColdBootId: local.bootId, revision: record.revision + 1 };
      await durableJson(fileFor(state), record);
    }
    if (record.observedColdBootId !== local.bootId) {
      record = { ...record, observedColdBootId: local.bootId, revision: record.revision + 1 };
      await durableJson(fileFor(state), record);
    }
    const evidence = join(state, 'updates/bootstrap-evidence', record.id);
    const syncEvidenceDirectory = async path => {
      const dir = await evidenceFs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
    };
    await evidenceFs.mkdir(evidence, { recursive: true, mode: 0o700 });
    // Persist every new directory entry before removing any original evidence.
    // Sync existing parents too: a prior attempt may have stopped before fsync.
    for (const path of [evidence, join(evidence, '..'), join(state, 'updates')]) await syncEvidenceDirectory(path);
    for (const [index, item] of record.legacyEvidence.entries()) {
      const original = join(state, item.path), saved = join(evidence, `${index}.lock`);
      if (item.fingerprint === null) { if (!await absent(original) || !await absent(saved)) throw Error('Unexpected legacy evidence'); continue; }
      if (!await absent(original)) {
        if (!await absent(saved) || await fingerprint(original) !== item.fingerprint) throw Error('Legacy lock evidence changed');
        await evidenceFs.rename(original, saved);
        for (const path of [join(original, '..'), evidence]) await syncEvidenceDirectory(path);
      }
      if (await fingerprint(saved) !== item.fingerprint) throw Error('Quarantined evidence changed');
    }
    await ownership.claimBootstrap({ id: record.id, preparationBootId: record.preparationBootId, expectedRevision: ownership.revision });
    const central = await acquireOwnership({ directory: state, name: 'central', environmentBinding: env.T3_CLOUD_OWNER_ID, deferClaim: true, legacy: join(state, 'central.lock') });
    try { await central.claimBootstrap({ id: record.id, preparationBootId: record.preparationBootId, expectedRevision: central.revision }); }
    finally { await central.close({ clean: true }); }
    await supervisor.save({ current: record.runtimeIdentity, staged: null, desired: null, receipt: null,
      initialInstall: record.id, phase: 'starting', recovery: 'persisted-bindings-quarantined' });
    try {
      await supervisor.driver.start(supervisor.releaseRoot(record.runtimeIdentity), release, { recovery: true });
      await supervisor.driver.health();
      await supervisor.save({ phase: 'running' });
      await durableJson(fileFor(state), { ...record, phase: 'completed', observedColdBootId: local.bootId, revision: record.revision + 1 });
      supervisor.admitting = true;
    } catch (error) {
      await supervisor.save({ phase: 'recovery-required' });
      try { await supervisor.driver.stop(); } catch {}
      throw error;
    }
  });
}
