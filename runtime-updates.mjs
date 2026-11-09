import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { durableJson } from './runtime-supervisor.mjs';
import { verifyManifestAttestation } from './runtime-bundle.mjs';
import { MAX_RUNTIME_ARCHIVE_BYTES, verifyAndUnpackRuntimeArchive } from './bin/runtime-archive.mjs';

const API = 'https://api.github.com/repos/briq-cloud/t3-cloud/releases?per_page=10';
const PERIOD = 6 * 60 * 60 * 1000;
const MANIFEST_LIMIT = 16_000_000;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const identity = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const tagSource = value => /^runtime-[a-f0-9]{40}$/.test(value ?? '') ? value.slice(8) : null;

export function selectRuntimeRelease(rows) {
  if (!Array.isArray(rows) || rows.length > 10) throw Error('Invalid release response');
  return rows.filter(row => row?.draft === false && row?.prerelease === false && tagSource(row.tag_name))
    .map(row => {
      if (!Number.isFinite(Date.parse(row.published_at)) || !Array.isArray(row.assets) || row.assets.length > 32) throw Error('Invalid runtime release');
      const sizes = {};
      for (const [name, limit] of [['manifest.json', MANIFEST_LIMIT], ['runtime-blobs.tar', MAX_RUNTIME_ARCHIVE_BYTES]]) {
        const assets = row.assets.filter(asset => asset.name === name);
        if (assets.length !== 1 || !Number.isSafeInteger(assets[0].size) || assets[0].size <= 0 || assets[0].size > limit || assets[0].state !== 'uploaded') throw Error('Incomplete runtime release');
        sizes[name] = assets[0].size;
      }
      return { tag: row.tag_name, source: tagSource(row.tag_name), publishedAt: row.published_at, sizes };
    }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0] ?? null;
}

function safeTransportUrl(url, initial, asset) {
  const value = new URL(url);
  if (value.protocol !== 'https:' || value.username || value.password || value.port || value.hash) throw Error('Unsafe release transport');
  if (value.href === initial) return value.href;
  if (asset && value.hostname === 'release-assets.githubusercontent.com' && value.pathname.startsWith('/github-production-release-asset/')) return value.href;
  throw Error('Unsafe release redirect');
}

// Public GitHub reads only. No owner, vendor or platform credentials enter fetch.
export async function readReleaseAsset(url, { limit, expectedSize, file, fetch: fetcher = globalThis.fetch, timeout = 30000 } = {}) {
  const initial = new URL(url);
  const asset = initial.origin === 'https://github.com' && /^\/briq-cloud\/t3-cloud\/releases\/download\/runtime-[a-f0-9]{40}\/(manifest\.json|runtime-blobs\.tar)$/.test(initial.pathname) && !initial.search;
  if (!asset && initial.href !== API) throw Error('Unknown release URL');
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RUNTIME_ARCHIVE_BYTES) throw Error('Invalid transfer bound');
  const signal = AbortSignal.timeout(timeout);
  let target = initial.href, response;
  for (let count = 0; count <= 3; count++) {
    safeTransportUrl(target, initial.href, asset);
    response = await fetcher(target, { redirect: 'manual', credentials: 'omit', signal,
      headers: { accept: asset ? 'application/octet-stream' : 'application/vnd.github+json', 'user-agent': 't3-cloud-runtime-updater' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || count === 3) throw Error('Invalid release redirect');
    target = safeTransportUrl(new URL(location, target).href, initial.href, asset);
  }
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw Error('Release download unavailable'); }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit || expectedSize !== undefined && Number(length) !== expectedSize)) {
    await response.body.cancel(); throw Error('Invalid release length');
  }
  let output, total = 0;
  const chunks = [];
  try {
    if (file) output = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    for await (const chunk of response.body) {
      if (signal.aborted) throw Error('Release transfer expired');
      total += chunk.byteLength;
      if (total > limit || expectedSize !== undefined && total > expectedSize) throw Error('Release exceeds transfer bound');
      if (output) {
        let offset = 0;
        while (offset < chunk.byteLength) offset += (await output.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
      } else chunks.push(Buffer.from(chunk));
    }
    if (expectedSize !== undefined && total !== expectedSize) throw Error('Incomplete release transfer');
    if (output) await output.sync();
    return file ? undefined : Buffer.concat(chunks);
  } finally { await output?.close(); }
}

export function runtimeReleaseConsumer({ state, stage, fetch: fetcher = globalThis.fetch,
  verifyManifest = verifyManifestAttestation, verifyArchive = verifyAndUnpackRuntimeArchive } = {}) {
  if (!isAbsolute(state) || typeof stage !== 'function') throw Error('Runtime release dependencies required');
  return {
    async check() {
      const bytes = await readReleaseAsset(API, { limit: 1_000_000, fetch: fetcher });
      return selectRuntimeRelease(JSON.parse(bytes.toString('utf8')));
    },
    async stage(release) {
      // Revalidate persisted metadata; callers cannot supply a URL or local path.
      const selected = selectRuntimeRelease([{ tag_name: release.tag, draft: false, prerelease: false, published_at: release.publishedAt,
        assets: Object.entries(release.sizes).map(([name, size]) => ({ name, size, state: 'uploaded' })) }]);
      if (!selected || selected.source !== release.source) throw Error('Invalid selected release');
      const directory = join(state, 'updates');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const scratch = await mkdtemp(join(directory, 'download-'));
      try {
        let manifest;
        for (const [name, limit] of [['manifest.json', MANIFEST_LIMIT], ['runtime-blobs.tar', MAX_RUNTIME_ARCHIVE_BYTES]]) {
          await readReleaseAsset(`https://github.com/briq-cloud/t3-cloud/releases/download/${selected.tag}/${name}`,
            { limit, expectedSize: selected.sizes[name], file: join(scratch, name), fetch: fetcher, timeout: name.endsWith('.tar') ? 300000 : 30000 });
          if (name === 'manifest.json') {
            ({ manifest } = await verifyManifest(join(scratch, name)));
            if (manifest.source !== selected.source) throw Error('Release source mismatch');
          }
        }
        // Core verification is repeated before stage by the supervisor itself.
        await verifyArchive(join(scratch, 'runtime-blobs.tar'), join(scratch, 'blobs'), manifest);
        return await stage(join(scratch, 'manifest.json'), join(scratch, 'blobs'));
      } finally { await rm(scratch, { recursive: true, force: true }); }
    },
  };
}

export class RuntimeUpdates {
  constructor({ state, currentSource, status, activity, stage, activate, completeDrain, consumer,
    now = Date.now, random = Math.random, schedule = setTimeout, cancel = clearTimeout }) {
    if (!isAbsolute(state) || currentSource !== null && !sha(currentSource) || [status, activity, activate, completeDrain].some(fn => typeof fn !== 'function')) throw Error('Runtime update dependencies required');
    Object.assign(this, { state, currentSource, getRuntime: status, activity, activate, completeDrain, now, random, schedule, cancel });
    this.consumer = consumer ?? runtimeReleaseConsumer({ state, stage });
    this.file = join(state, 'updates', 'preferences.json');
    this.busy = false;
    this.liveDrain = null;
    this.record = { protocol: 1, automatic: false, checkedAt: null, available: null, outcome: 'unchecked', attempted: null, staged: null };
  }
  async initialize() {
    await mkdir(join(this.state, 'updates'), { recursive: true, mode: 0o700 });
    let input;
    try {
      const file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if ((await file.stat()).size > 65536) throw Error('Invalid update preferences'); input = JSON.parse(await file.readFile('utf8')); }
      finally { await file.close(); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (input) {
      if (input.protocol !== 1 || typeof input.automatic !== 'boolean' || !['unchecked', 'current', 'available', 'blocked', 'failed', 'activated', 'pending', 'no-release'].includes(input.outcome) ||
        input.checkedAt !== null && (!Number.isSafeInteger(input.checkedAt) || input.checkedAt < 0) || input.attempted !== null && !tagSource(input.attempted) ||
        input.staged !== null && (!sha(input.staged?.source) || !identity(input.staged?.identity))) throw Error('Invalid update preferences');
      if (input.available !== null) {
        const release = input.available;
        const selected = selectRuntimeRelease([{ tag_name: release.tag, draft: false, prerelease: false, published_at: release.publishedAt,
          assets: Object.entries(release.sizes).map(([name, size]) => ({ name, size, state: 'uploaded' })) }]);
        if (!selected || selected.source !== release.source) throw Error('Invalid update preferences');
      }
      this.record = Object.fromEntries(Object.keys(this.record).map(key => [key, input[key]]));
    }
    await this.save({});
    return this.status();
  }
  async save(patch) { const next = { ...this.record, ...patch }; await durableJson(this.file, next); this.record = next; }
  async exclusive(work) {
    if (this.busy) return { ...(await this.status()), busy: true };
    this.busy = true;
    try { await work(); } catch { await this.save({ outcome: 'failed' }); }
    finally { this.busy = false; }
    return this.status();
  }
  async status() {
    const runtime = await this.getRuntime();
    return { automatic: this.record.automatic, checkedAt: this.record.checkedAt, outcome: this.record.outcome,
      available: this.record.available ? { version: this.record.available.source.slice(0, 12), source: this.record.available.source } : null,
      currentSource: this.currentSource, staged: identity(runtime.staged) ? runtime.staged : null,
      desired: identity(runtime.desired) ? runtime.desired : null,
      receipt: runtime.receipt && ['pending', 'committed'].includes(runtime.receipt.status) &&
        (runtime.receipt.from === 'bootstrap' || identity(runtime.receipt.from)) && identity(runtime.receipt.to)
        ? { from: runtime.receipt.from, to: runtime.receipt.to, status: runtime.receipt.status } : null,
      current: identity(runtime.current) ? runtime.current : 'bootstrap', phase: ['running', 'draining', 'stopping', 'starting', 'stopped', 'recovery-required'].includes(runtime.phase) ? runtime.phase : 'unavailable', busy: this.busy };
  }
  check() { return this.exclusive(async () => {
    // A failed network attempt still consumes this period, avoiding retry storms.
    await this.save({ checkedAt: this.now() });
    const available = await this.consumer.check();
    await this.save({ available, checkedAt: this.now(), outcome: !available ? 'no-release' : available.source !== this.currentSource ? 'available' : 'current' });
  }); }
  setAutomatic(automatic) {
    if (typeof automatic !== 'boolean') throw Error('Invalid automatic update preference');
    return this.exclusive(() => this.save({ automatic }));
  }
  update() { return this.exclusive(() => this.apply(false)); }
  async apply(automatic) {
    const runtime = await this.getRuntime();
    if (runtime.desired || runtime.phase !== 'running') { await this.save({ outcome: runtime.phase === 'draining' ? 'pending' : 'blocked' }); return; }
    const available = this.record.available;
    if (!available || available.source === this.currentSource) return;
    // Unknown activity is a blocker, including standalone and terminal use.
    if ((await this.activity())?.idle !== true) { await this.save({ outcome: 'blocked' }); return; }
    if (automatic && this.record.attempted === available.tag) return;
    await this.save({ attempted: available.tag });
    const staged = this.record.staged?.source === available.source && runtime.staged === this.record.staged.identity
      ? this.record.staged : await this.consumer.stage(available);
    if (!identity(staged?.identity)) throw Error('Release staging unavailable');
    await this.save({ staged: { source: available.source, identity: staged.identity } });
    if (staged.identity === runtime.current) { this.currentSource = available.source; await this.save({ outcome: 'current' }); return; }
    // Recheck after downloads; supervisor fences and proves idle again atomically.
    if ((await this.activity())?.idle !== true) { await this.save({ outcome: 'blocked', attempted: null }); return; }
    const result = await this.activate();
    if (result.pending === true) { this.liveDrain = staged.identity; await this.save({ outcome: 'pending' }); }
    else if (result.identity === staged.identity) { this.currentSource = available.source; await this.save({ outcome: 'activated' }); }
    else throw Error('Activation outcome unknown');
  }
  async tick() {
    if (this.busy) return;
    const runtime = await this.getRuntime();
    // A live drain has a single durable handle; complete it without replaying activation.
    if (runtime.phase === 'draining' && runtime.desired && this.liveDrain === runtime.desired) {
      return this.exclusive(async () => {
        const desired = this.liveDrain;
        // Only an acknowledged pending result retains the live handle. Unknown
        // completion never licenses another attempt, including after a reboot.
        this.liveDrain = null;
        const result = await this.completeDrain();
        if (result.pending === true) { this.liveDrain = desired; await this.save({ outcome: 'pending' }); return; }
        if (result.identity !== desired) throw Error('Drain completion outcome unknown');
        this.currentSource = this.record.staged?.identity === desired ? this.record.staged.source : null;
        await this.save({ outcome: this.record.available && this.record.available.source !== this.currentSource ? 'available' : 'activated' });
      });
    }
    if (runtime.phase !== 'running' || runtime.desired) return;
    if (this.record.checkedAt === null || this.now() - this.record.checkedAt >= PERIOD) await this.check();
    if (this.record.automatic && ['available', 'blocked'].includes(this.record.outcome)) await this.exclusive(() => this.apply(true));
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    const run = async () => {
      try { await this.tick(); } catch { /* Persisted status is inspected by the owner. No raw error leaves this process. */ }
      if (!this.stopped) { this.timer = this.schedule(run, 60000); this.timer?.unref?.(); }
    };
    this.timer = this.schedule(run, Math.floor(this.random() * 60000)); this.timer?.unref?.();
  }
  stop() { this.stopped = true; this.cancel(this.timer); this.timer = null; }
}
