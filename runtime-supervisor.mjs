import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { stageBundle, verifyInstalledBundle } from './runtime-bundle.mjs';

const identity = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
export async function durableJson(path, value) {
  const temporary = `${path}.${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(join(path, '..'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

// One loader owns this journal. desired is durable before admission closes and
// before any child is stopped. An interrupted transition never starts a process.
export class RuntimeSupervisor {
  constructor({ state, baseImage, driver, stage = stageBundle, verify = verifyInstalledBundle }) {
    if (!isAbsolute(state) || !identity(baseImage)) throw Error('Absolute state and pinned base OS required');
    Object.assign(this, { state, baseImage, driver, stage, verify });
    this.file = join(state, 'updates', 'activation.json');
    this.admitting = false;
    this.busy = false;
  }
  async save(patch) {
    const next = { ...this.journal, ...patch };
    await durableJson(this.file, next);
    this.journal = next;
  }
  releaseRoot(value) { return value === 'bootstrap' ? '/' : join(this.state, 'releases', value.replace(':', '-')); }
  async verifyRelease(value) {
    if (value !== 'bootstrap') {
      if (!identity(value)) throw Error('Invalid selected release');
      return this.verify(this.releaseRoot(value), value, this.baseImage);
    }
  }
  async initialize() {
    await mkdir(join(this.state, 'updates'), { recursive: true, mode: 0o700 });
    try { this.journal = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.journal = { protocol: 1, current: 'bootstrap', staged: null, desired: null, phase: 'stopped', receipt: null };
      await this.save({});
    }
    const j = this.journal;
    if (j.protocol !== 1 ||
        j.current !== 'bootstrap' && !identity(j.current)) throw Error('Invalid activation journal');
    // A loader/manager crash can leave provider outcomes ambiguous even when the
    // selected version did not change. No native session is resumed implicitly.
    if (j.phase !== 'stopped' || j.desired) return { recoveryRequired: true };
    const release = await this.verifyRelease(j.current);
    await this.save({ phase: 'starting' });
    try {
      await this.driver.start(this.releaseRoot(j.current), release);
      await this.driver.health();
      await this.save({ phase: 'running' });
      this.admitting = true;
      return { recoveryRequired: false };
    } catch (error) {
      await this.save({ phase: 'recovery-required' });
      try { await this.driver.stop(); } catch { /* Unknown lifetime remains quarantined. */ }
      throw error;
    }
  }
  async exclusive(work) {
    if (this.busy) throw Error('Update already in progress');
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
  async stageRelease(manifestFile, blobs, options) {
    return this.exclusive(async () => {
      if (this.journal.desired) throw Error('Activation requires reconciliation');
      const staged = await this.stage(manifestFile, blobs, join(this.state, 'releases'), options);
      await this.verifyRelease(staged.identity);
      await this.save({ staged: staged.identity });
      return { identity: staged.identity };
    });
  }
  async activate() {
    return this.exclusive(async () => {
      if (this.journal.phase !== 'running' || this.journal.desired || !identity(this.journal.staged)) throw Error('No activatable staged release');
      const desired = this.journal.staged;
      await this.verifyRelease(desired);
      // Fence first. Drain queries existing real runtime ledgers; it does not
      // interrupt active turns, infer idleness from sockets, or replay sessions.
      this.admitting = false;
      await this.save({ desired, phase: 'draining', receipt: { from: this.journal.current, to: desired, status: 'pending' } });
      try {
        await this.driver.drain();
        const activity = await this.driver.activity();
        if (activity.idle !== true) {
          // Fence remains shut. The caller may inspect/retry completion, but no
          // unrelated request can sneak between the proof and termination.
          return { pending: true, reason: 'owned-activity' };
        }
        return await this.finishActivation();
      } catch (error) { await this.save({ phase: 'recovery-required' }); throw error; }
    });
  }
  async completeDrain() {
    return this.exclusive(async () => {
      if (this.journal.phase !== 'draining' || !this.journal.desired) throw Error('No live drain');
      if ((await this.driver.activity()).idle !== true) return { pending: true, reason: 'owned-activity' };
      return this.finishActivation();
    });
  }
  async finishActivation() {
    const desired = this.journal.desired;
    try {
      await this.save({ phase: 'stopping' });
      await this.driver.stop();
      const release = await this.verifyRelease(desired);
      await this.save({ phase: 'starting' });
      await this.driver.start(this.releaseRoot(desired), release);
      await this.driver.health();
      await this.save({ current: desired, desired: null, staged: null, phase: 'running',
        receipt: { ...this.journal.receipt, status: 'committed' } });
      this.admitting = true;
      return { pending: false, identity: desired };
    } catch (error) {
      // The new app may have migrated state. Never restart the previous version.
      this.admitting = false;
      await this.save({ phase: 'recovery-required' });
      try { await this.driver.stop(); } catch { /* Unknown lifetime remains quarantined. */ }
      throw error;
    }
  }
  async shutdown() {
    this.admitting = false;
    await this.driver.stop();
    // A pending or failed activation must remain quarantined across reboot.
    if (!this.journal.desired && this.journal.phase === 'running') await this.save({ phase: 'stopped' });
  }
}
