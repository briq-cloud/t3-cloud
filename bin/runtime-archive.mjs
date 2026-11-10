import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { validateManifest, RUNTIME_ATTESTATION_ASSET, snapshotAttestation, attestationEnvironment } from '../runtime-bundle.mjs';

const runFile = promisify(execFile);
// Keep one downloadable release asset below GitHub's 2 GiB asset limit.
export const MAX_RUNTIME_ARCHIVE_BYTES = 1_900_000_000;
const hashName = /^[a-f0-9]{64}$/;
const zero = bytes => bytes.every(byte => byte === 0);

export function runtimeArchiveVerificationTimeout(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw Error('Invalid release archive size');
  // Native verification hashes the whole archive; allow one second per 16 MiB
  // in addition to startup, with a fixed ceiling independent of release input.
  return Math.min(180000, 30000 + Math.ceil(bytes / (16 * 1024 * 1024)) * 1000);
}

function expectedBlobs(manifest) {
  validateManifest(manifest);
  const expected = new Map();
  for (const entry of manifest.files) if (entry.type === 'file') {
    if (expected.has(entry.sha256) && expected.get(entry.sha256) !== entry.size) throw Error('Conflicting release blob');
    expected.set(entry.sha256, entry.size);
  }
  return expected;
}

// GNU/BSD tar produces standard USTAR; only digest-named regular files enter it.
export async function packRuntimeArchive(bundle, archive, { run = runFile } = {}) {
  if (!isAbsolute(bundle) || !isAbsolute(archive)) throw Error('Absolute release paths required');
  const expected = expectedBlobs(JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')));
  const blobs = join(bundle, 'blobs');
  const names = (await readdir(blobs)).sort();
  if (names.length !== expected.size || names.some(name => !hashName.test(name) || !expected.has(name))) throw Error('Unexpected release blob');
  let size = 10240;
  for (const name of names) {
    const info = await lstat(join(blobs, name));
    if (!info.isFile() || info.nlink !== 1 || info.size !== expected.get(name)) throw Error('Unsafe release blob');
    size += 512 + Math.ceil(info.size / 512) * 512;
  }
  if (size > MAX_RUNTIME_ARCHIVE_BYTES) throw Error('Release archive exceeds capacity limit');
  const scratch = await mkdtemp(join(tmpdir(), 't3-archive-list-'));
  try {
    const list = join(scratch, 'files');
    await writeFile(list, `${names.join('\n')}\n`, { mode: 0o600 });
    // No shell and no remote filenames or archive-controlled options.
    await run('tar', ['--format=ustar', '-cf', archive, '-C', blobs, '-T', list], { timeout: 300000, maxBuffer: 65536 });
    const info = await lstat(archive);
    if (!info.isFile() || info.size > MAX_RUNTIME_ARCHIVE_BYTES) throw Error('Release archive exceeds capacity limit');
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

function field(header, offset, length) {
  const bytes = header.subarray(offset, offset + length), end = bytes.indexOf(0);
  if (end !== -1 && !zero(bytes.subarray(end))) throw Error('Invalid release archive field');
  return bytes.subarray(0, end === -1 ? length : end).toString('ascii');
}
function octal(header, offset, length) {
  const text = header.subarray(offset, offset + length).toString('ascii').replace(/[\0 ]+$/g, '').trimStart();
  if (!/^[0-7]+$/.test(text)) throw Error('Invalid release archive number');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw Error('Invalid release archive number');
  return value;
}

// Never pass an untrusted archive to a filesystem extractor. Accept only regular
// USTAR members whose names, lengths and bytes match the authenticated manifest.
export async function unpackRuntimeArchive(archive, output, manifest) {
  if (!isAbsolute(archive) || !isAbsolute(output)) throw Error('Absolute release paths required');
  const expected = expectedBlobs(manifest);
  const input = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  let created = false;
  try {
    const info = await input.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 1024 || info.size > MAX_RUNTIME_ARCHIVE_BYTES || info.size % 512) throw Error('Invalid release archive size');
    await mkdir(output, { mode: 0o700 });
    created = true;
    let position = 0, ended = false, zeroBlocks = 0;
    const buffer = Buffer.alloc(65536);
    async function read(length) {
      let offset = 0;
      while (offset < length) {
        const result = await input.read(buffer, offset, length - offset, position + offset);
        if (!result.bytesRead) throw Error('Truncated release archive');
        offset += result.bytesRead;
      }
      position += length;
      return buffer.subarray(0, length);
    }
    while (position < info.size) {
      const header = Buffer.from(await read(512));
      if (zero(header)) { ended = true; zeroBlocks++; continue; }
      if (ended) throw Error('Trailing release archive data');
      const name = field(header, 0, 100), size = octal(header, 124, 12);
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
      if (checksum !== octal(header, 148, 8) || field(header, 257, 6) !== 'ustar' ||
          !hashName.test(name) || !expected.has(name) || expected.get(name) !== size ||
          ![0, 48].includes(header[156]) || field(header, 157, 100) || field(header, 345, 155)) throw Error('Invalid release archive member');
      if (position + Math.ceil(size / 512) * 512 > info.size) throw Error('Truncated release archive');
      const target = await open(join(output, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
      const hash = createHash('sha256');
      try {
        for (let remaining = size; remaining > 0;) {
          const chunk = await read(Math.min(buffer.length, remaining));
          hash.update(chunk);
          let written = 0;
          while (written < chunk.length) written += (await target.write(chunk, written, chunk.length - written)).bytesWritten;
          remaining -= chunk.length;
        }
      } finally { await target.close(); }
      if (hash.digest('hex') !== name) throw Error('Release archive blob mismatch');
      const padding = (512 - size % 512) % 512;
      if (padding && !zero(await read(padding))) throw Error('Invalid release archive padding');
      expected.delete(name);
    }
    if (zeroBlocks < 2 || expected.size) throw Error('Incomplete release archive');
  } catch (error) {
    if (created) await rm(output, { recursive: true, force: true });
    throw error;
  } finally { await input.close(); }
}

// Verify a private copy and consume that copy. The manifest authenticates every
// extracted byte as well; neither transport URLs nor release tags are authorities.
export async function verifyAndUnpackRuntimeArchive(archive, output, manifest, { run = runFile, cli = 'gh', bundleFile = join(dirname(archive), RUNTIME_ATTESTATION_ASSET) } = {}) {
  expectedBlobs(manifest);
  if (!isAbsolute(archive)) throw Error('Absolute release path required');
  const info = await lstat(archive);
  if (!info.isFile() || info.nlink !== 1 || info.size > MAX_RUNTIME_ARCHIVE_BYTES) throw Error('Invalid release archive size');
  // Releases can exceed the guest's temporary filesystem. Keep the independent
  // verification copy beside the admitted download, on its owned update volume.
  const parent = dirname(archive), parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.getuid() || parentInfo.mode & 0o022)
    throw Error('Unsafe release archive directory');
  const scratch = await mkdtemp(join(parent, 't3-archive-verify-'));
  try {
    const bundleSnapshot = await snapshotAttestation(bundleFile, scratch);
    const snapshot = join(scratch, 'runtime-blobs.tar');
    await copyFile(archive, snapshot, constants.COPYFILE_EXCL);
    const snapshotInfo = await lstat(snapshot);
    if (!snapshotInfo.isFile() || snapshotInfo.nlink !== 1 || snapshotInfo.size !== info.size) throw Error('Release archive changed during snapshot');
    const { stdout } = await run(cli, ['attestation', 'verify', snapshot, '--bundle', bundleSnapshot, '-R', 'briq-cloud/t3-cloud',
      '--signer-workflow', 'briq-cloud/t3-cloud/.github/workflows/image.yml',
      '--source-ref', 'refs/heads/main', '--source-digest', manifest.source, '--format', 'json'],
    { timeout: runtimeArchiveVerificationTimeout(snapshotInfo.size), maxBuffer: 1_000_000, env: attestationEnvironment(scratch) });
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows) || !rows.some(row => {
      const certificate = row?.verificationResult?.signature?.certificate;
      return String(certificate?.sourceRepositoryIdentifier) === '1450999885' && certificate?.sourceRepositoryRef === 'refs/heads/main';
    })) throw Error('Release archive provenance unavailable');
    await unpackRuntimeArchive(snapshot, output, manifest);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
