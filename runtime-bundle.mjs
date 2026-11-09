import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const safePath = value => typeof value === 'string' && value.length <= 512 && value.length > 0 &&
  !isAbsolute(value) && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..') &&
  normalize(value) === value;
const inside = (root, path) => path === root || path.startsWith(root + sep);

const resourceMonitorPath = 'opt/t3/resource-monitor/linux-x64/t3-resource-monitor';
export const REQUIRED_BUNDLE_PATHS = Object.freeze([
  'opt/t3/t3', 'opt/t3/node', 'opt/t3/source.json',
  resourceMonitorPath,
  'opt/t3/dist/bin.mjs', 'opt/t3/node_modules/@anthropic-ai/claude-agent-sdk/manifest.json',
  'opt/t3-cloud/manager-main.mjs', 'opt/t3-cloud/prepare.mjs',
  'opt/t3-cloud/runtime-controller.mjs', 'opt/t3-cloud/runtime-controller-process.mjs', 'opt/t3-cloud/runtime-updates.mjs',
  'opt/t3-cloud/bin/release-shims/node', 'opt/t3-cloud/bin/release-shims/briq',
  'opt/t3-cloud/bin/release-shims/claude', 'opt/t3-cloud/bin/release-shims/codex',
  'opt/t3-cloud/node_modules/ws/package.json', 'opt/codex/bin/codex',
  'opt/briq-cli/node_modules/.bin/briq', 'usr/local/bin/claude',
  'usr/local/bin/ttyd', 'usr/local/bin/t3-cloud-start',
  'usr/local/bin/show-url', 'opt/t3-cloud/bin/codex-remote',
  'etc/claude-code/managed-settings.json', 'etc/codex/config.toml',
]);

export const BUNDLE_ROOTS = Object.freeze([
  'opt/t3', 'opt/t3-cloud', 'opt/codex', 'opt/briq-cli',
  'usr/local/bin/claude', 'usr/local/bin/ttyd', 'usr/local/bin/t3-cloud-start',
  'usr/local/bin/show-url',
  'etc/claude-code', 'etc/codex', 'etc/t3-cloud',
]);

// Resolve each path component as the filesystem does, including links before '..'.
// The signed physical inventory is the only namespace available to links.
export function resolveBundlePath(files, path) {
  const entries = new Map(files.map(entry => [entry.path, entry]));
  const queue = path.split('/'), resolved = [];
  let links = 0;
  while (queue.length) {
    const part = queue.shift();
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!resolved.length) throw Error('Release link escapes root');
      resolved.pop(); continue;
    }
    const name = [...resolved, part].join('/'), entry = entries.get(name);
    if (!entry) throw Error('Dangling release path');
    if (entry.type === 'symlink') {
      if (++links > 40) throw Error('Cyclic release link');
      queue.unshift(...entry.target.split('/'));
    } else {
      if (queue.length && entry.type !== 'directory') throw Error('Invalid release traversal');
      resolved.push(part);
    }
  }
  return entries.get(resolved.join('/'));
}

async function hashFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Error('Release contains an unsafe file');
    if (info.nlink !== 1) throw Error('Release contains a hardlinked file');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return { size: info.size, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

// The source is the finished image filesystem. Only the declared application roots
// enter a release; /work, homes and credentials are never candidates.
export async function inventoryBundle(root, paths = BUNDLE_ROOTS) {
  if (!isAbsolute(root)) throw Error('Absolute image root required');
  const entries = [];
  const parents = new Set();
  for (const path of paths) for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) parents.add(parent);
  for (const path of [...parents].sort()) entries.push({ path, type: 'directory', mode: 0o700 });
  async function visit(path) {
    if (!safePath(path)) throw Error('Unsafe release path');
    const source = join(root, path), info = await lstat(source);
    if (info.isDirectory()) {
      entries.push({ path, type: 'directory', mode: info.mode & 0o777 });
      for (const name of (await readdir(source)).sort()) await visit(`${path}/${name}`);
    } else if (info.isFile()) {
      const { size, sha256 } = await hashFile(source);
      entries.push({ path, type: 'file', mode: info.mode & 0o777, size, sha256 });
    } else if (info.isSymbolicLink()) {
      const link = await readlink(source);
      if (isAbsolute(link) || !inside(resolve(root), resolve(root, dirname(path), link))) throw Error('Unsafe release link');
      entries.push({ path, type: 'symlink', target: link });
    } else throw Error('Release contains an unsupported file');
  }
  for (const path of paths) await visit(path);
  const names = new Set(entries.map(entry => entry.path));
  if (names.size !== entries.length) throw Error('Duplicate release path');
  for (const path of REQUIRED_BUNDLE_PATHS) {
    try {
      const entry = resolveBundlePath(entries, path);
      if (entry?.type !== 'file' || (path === resourceMonitorPath && !(entry.mode & 0o111))) throw Error();
    }
    catch { throw Error(`Incomplete release: ${path}`); }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function validateManifest(manifest) {
  if (!exact(manifest, ['protocol', 'project', 'platform', 'baseImage', 'source', 'childImage', 'files']) ||
      manifest.protocol !== 1 || manifest.project !== 'briq-cloud/t3-cloud' || manifest.platform !== 'linux/amd64' ||
      !/^sha256:[a-f0-9]{64}$/.test(manifest.baseImage) || !commit(manifest.source) || !/^ghcr\.io\/briq-cloud\/t3-cloud@sha256:[a-f0-9]{64}$/.test(manifest.childImage ?? '') ||
      !Array.isArray(manifest.files) || manifest.files.length < REQUIRED_BUNDLE_PATHS.length || manifest.files.length > 100000)
    throw Error('Invalid release manifest');
  const names = new Set();
  let total = 0;
  for (const entry of manifest.files) {
    if (!safePath(entry?.path) || names.has(entry.path)) throw Error('Invalid release path');
    names.add(entry.path);
    if (entry.type === 'file') {
      if (!exact(entry, ['path', 'type', 'mode', 'size', 'sha256']) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 1_000_000_000 || !sha(entry.sha256)) throw Error('Invalid release file');
      total += entry.size;
    } else if (entry.type === 'directory') {
      if (!exact(entry, ['path', 'type', 'mode'])) throw Error('Invalid release directory');
    } else if (entry.type === 'symlink') {
      if (!exact(entry, ['path', 'type', 'target']) || typeof entry.target !== 'string' || isAbsolute(entry.target) ||
          !inside('/bundle', resolve('/bundle', dirname(entry.path), entry.target))) throw Error('Invalid release link');
    } else throw Error('Invalid release entry');
    if (entry.type !== 'symlink' && (!Number.isInteger(entry.mode) || entry.mode < 0o400 || entry.mode > 0o755 || entry.mode & 0o022 || entry.mode & 0o4000)) throw Error('Unsafe release mode');
  }
  if (total > 4_000_000_000) throw Error('Release exceeds capacity limit');
  for (const entry of manifest.files) if (entry.type === 'symlink') resolveBundlePath(manifest.files, entry.path);
  for (const path of REQUIRED_BUNDLE_PATHS) {
    try {
      const entry = resolveBundlePath(manifest.files, path);
      if (entry?.type !== 'file' || (path === resourceMonitorPath && !(entry.mode & 0o111))) throw Error();
    }
    catch { throw Error(`Incomplete release: ${path}`); }
  }
  const types = new Map(manifest.files.map(entry => [entry.path, entry.type]));
  for (const entry of manifest.files) {
    for (let parent = dirname(entry.path); parent !== '.'; parent = dirname(parent)) {
      if (types.get(parent) !== 'directory') throw Error('Invalid release parent');
    }
  }
  return `sha256:${digest(Buffer.from(JSON.stringify(manifest)))}`;
}

export const RUNTIME_ATTESTATION_ASSET = 'runtime-attestation.jsonl';
export const MAX_RUNTIME_ATTESTATION_BYTES = 16_000_000;

// Capture bounded, ordinary bytes before invoking gh. The release supplies
// evidence, never a trust root; gh bootstraps its standard authenticated TUF roots.
export async function snapshotAttestation(bundleFile, scratch) {
  if (!isAbsolute(bundleFile)) throw Error('Absolute attestation path required');
  const input = await open(bundleFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const info = await input.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > MAX_RUNTIME_ATTESTATION_BYTES) throw Error('Invalid attestation size');
    bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await input.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size !== info.size) throw Error('Attestation changed during capture');
    bytes = bytes.subarray(0, size);
  } finally { await input.close(); }
  const snapshot = join(scratch, RUNTIME_ATTESTATION_ASSET);
  await writeFile(snapshot, bytes, { flag: 'wx', mode: 0o400 });
  return snapshot;
}

export function attestationEnvironment(scratch) {
  // Do not consult owner login state, even when verification is run manually.
  const env = { ...process.env, HOME: '/nonexistent', GH_CONFIG_DIR: '/nonexistent',
    XDG_CACHE_HOME: join(scratch, 'cache'), GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[key];
  return env;
}

export async function verifyManifestAttestation(manifestFile, { run = promisify(execFile), cli = 'gh', bundleFile = join(dirname(manifestFile), RUNTIME_ATTESTATION_ASSET) } = {}) {
  if (!isAbsolute(manifestFile)) throw Error('Absolute manifest path required');
  const bytes = await readFile(manifestFile);
  if (bytes.length > 16_000_000) throw Error('Release manifest exceeds capacity limit');
  const manifest = JSON.parse(bytes.toString('utf8'));
  const identity = validateManifest(manifest);
  const snapshot = await mkdtemp(join(tmpdir(), 't3-attestation-'));
  try {
  const bundleSnapshot = await snapshotAttestation(bundleFile, snapshot);
  const snapshotFile = join(snapshot, 'manifest.json');
  await writeFile(snapshotFile, bytes, { flag: 'wx', mode: 0o400 });
  const { stdout } = await run(cli, ['attestation', 'verify', snapshotFile, '--bundle', bundleSnapshot,
    '-R', 'briq-cloud/t3-cloud', '--signer-workflow', 'briq-cloud/t3-cloud/.github/workflows/image.yml',
    '--source-ref', 'refs/heads/main', '--source-digest', manifest.source, '--format', 'json'],
    { timeout: 30000, maxBuffer: 1_000_000, env: attestationEnvironment(snapshot) });
  if (!bytes.equals(await readFile(snapshotFile))) throw Error('Release manifest changed during verification');
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows) || !rows.some(row => {
    const certificate = row?.verificationResult?.signature?.certificate;
    return String(certificate?.sourceRepositoryIdentifier) === '1450999885' &&
      certificate?.sourceRepositoryRef === 'refs/heads/main';
  })) throw Error('Release provenance unavailable');
  return { manifest, identity };
  } finally { await rm(snapshot, { recursive: true, force: true }); }
}

export async function packBundle(root, output, { baseImage, source, childImage, onPhase = () => {} }) {
  if (!isAbsolute(output) || !/^sha256:[a-f0-9]{64}$/.test(baseImage) || !commit(source)) throw Error('Invalid release inputs');
  onPhase('inventory');
  const files = await inventoryBundle(root);
  const manifest = { protocol: 1, project: 'briq-cloud/t3-cloud', platform: 'linux/amd64',
    baseImage, source, childImage, files };
  onPhase('manifest');
  validateManifest(manifest);
  onPhase('blobs');
  const blobs = join(output, 'blobs');
  await mkdir(blobs, { recursive: true, mode: 0o700 });
  for (const entry of files) {
    if (entry.type !== 'file') continue;
    const target = join(blobs, entry.sha256);
    try { await copyFile(join(root, entry.path), target, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const actual = await hashFile(target);
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw Error('Release source changed while packing');
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  return manifest;
}

// Blobs are named by digest, never by archive-supplied paths. Staged bytes are
// rehashed after copying, before the immutable directory is made visible.
export async function stageBundle(manifestFile, blobs, releases, options) {
  const { manifest, identity } = await verifyManifestAttestation(manifestFile, options);
  if (!isAbsolute(blobs) || !isAbsolute(releases)) throw Error('Absolute release directories required');
  const destination = join(releases, identity.replace(':', '-'));
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const existing = await stat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    if (!options?.reuseVerifiedExisting) throw Error('Release already exists');
    // Reusing a preparation interrupted after publication requires both fresh
    // publisher verification above and a full rehash of that exact inventory.
    await verifyInstalledBundle(destination, identity, manifest.baseImage);
    return { identity, path: destination };
  }
  const temporary = `${destination}.staging-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const entry of manifest.files) {
      const target = join(temporary, entry.path);
      if (entry.type === 'directory') await mkdir(target, { recursive: true, mode: 0o700 });
      else if (entry.type === 'file') {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(join(blobs, entry.sha256), target, constants.COPYFILE_EXCL);
        const actual = await hashFile(target);
        if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw Error('Release blob mismatch');
        await chmod(target, entry.mode & ~0o222);
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
      } else {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await symlink(entry.target, target);
      }
    }
    await writeFile(join(temporary, '.release-manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o400 });
    const metadata = await open(join(temporary, '.release-manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await metadata.sync(); } finally { await metadata.close(); }
    for (const entry of [...manifest.files].filter(entry => entry.type === 'directory').sort((a, b) => b.path.length - a.path.length)) {
      const path = join(temporary, entry.path);
      await chmod(path, entry.mode & ~0o222);
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    }
    const seal = await open(temporary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await seal.sync(); } finally { await seal.close(); }
    await chmod(temporary, 0o500);
    await rename(temporary, destination);
    const dir = await open(releases, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
    return { identity, path: destination };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

// Content addressing does not protect against the owning UID changing permissions.
// Rehash every cold start and activation; no executable is trusted by filename alone.
export async function verifyInstalledBundle(root, identity, baseImage) {
  if (!(await lstat(root)).isDirectory()) throw Error('Release root is not a physical directory');
  const manifest = JSON.parse(await readFile(join(root, '.release-manifest.json'), 'utf8'));
  if (validateManifest(manifest) !== identity || manifest.baseImage !== baseImage) throw Error('Release identity or base OS mismatch');
  const expected = new Map(manifest.files.map(entry => [entry.path, entry]));
  async function visit(path) {
    const info = await lstat(join(root, path));
    const entry = expected.get(path);
    if (!entry) throw Error('Unexpected release entry');
    expected.delete(path);
    if (entry.type === 'directory') {
      if (!info.isDirectory() || (info.mode & 0o777) !== (entry.mode & ~0o222)) throw Error('Release directory mismatch');
      for (const name of await readdir(join(root, path))) await visit(`${path}/${name}`);
    } else if (entry.type === 'symlink') {
      if (!info.isSymbolicLink() || await readlink(join(root, path)) !== entry.target) throw Error('Release link mismatch');
    } else {
      if (!info.isFile() || (info.mode & 0o777) !== (entry.mode & ~0o222)) throw Error('Release file mismatch');
      const actual = await hashFile(join(root, path));
      if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw Error('Release file digest mismatch');
    }
  }
  for (const name of await readdir(root)) if (name !== '.release-manifest.json') await visit(name);
  if (expected.size) throw Error('Incomplete installed release');
  return manifest;
}
