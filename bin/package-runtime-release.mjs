#!/usr/bin/env node
import { packBundle } from '../runtime-bundle.mjs';
import { packRuntimeArchive } from './runtime-archive.mjs';
import { join, isAbsolute } from 'node:path';
import { mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// Diagnostics are a closed vocabulary. Never print exception text, filesystem
// paths, child-process output or environment values from a failed image package.
export function packagingFailureCategory(error) {
  const codes = { ENOENT: 'missing-entry', EACCES: 'permission-denied', EPERM: 'permission-denied',
    ENOSPC: 'storage-capacity', EDQUOT: 'storage-capacity', EEXIST: 'destination-conflict',
    ENOTEMPTY: 'destination-conflict', ELOOP: 'unsafe-link', ETIMEDOUT: 'timeout' };
  if (Object.hasOwn(codes, error?.code)) return codes[error.code];
  const messages = {
    'Invalid release inputs': 'invalid-input',
    'Absolute image root required': 'invalid-input',
    'Unsafe release path': 'unsafe-path',
    'Unsafe release link': 'unsafe-link',
    'Invalid release link': 'unsafe-link',
    'Release link escapes root': 'unsafe-link',
    'Dangling release path': 'unsafe-link',
    'Cyclic release link': 'unsafe-link',
    'Invalid release traversal': 'unsafe-link',
    'Release contains an unsafe file': 'unsafe-file',
    'Release contains a hardlinked file': 'hardlink',
    'Release contains an unsupported file': 'unsupported-file',
    'Unsafe release mode': 'unsafe-mode',
    'Duplicate release path': 'duplicate-entry',
    'Invalid release manifest': 'invalid-manifest',
    'Invalid release path': 'invalid-manifest',
    'Invalid release file': 'invalid-manifest',
    'Invalid release directory': 'invalid-manifest',
    'Invalid release entry': 'invalid-manifest',
    'Invalid release parent': 'invalid-manifest',
    'Release exceeds capacity limit': 'bundle-capacity',
    'Release archive exceeds capacity limit': 'archive-capacity',
    'Release source changed while packing': 'source-changed',
    'Conflicting release blob': 'blob-mismatch',
    'Unexpected release blob': 'blob-mismatch',
    'Unsafe release blob': 'unsafe-file',
  };
  if (Object.hasOwn(messages, error?.message)) return messages[error.message];
  if (typeof error?.message === 'string' && error.message.startsWith('Incomplete release: ')) return 'missing-required-entry';
  return 'unknown';
}

export async function packageRuntimeRelease({ root, output, baseImage, source, childImage }, {
  pack = packBundle, archive = packRuntimeArchive, scratchDirectory = () => mkdtemp(join(tmpdir(), 't3-runtime-release-')),
  createOutput = path => mkdir(path, { mode: 0o700 }), copyManifest = copyFile, cleanup = rm,
} = {}) {
  let stage = 'scratch', scratch, diagnostic = null;
  try {
    scratch = await scratchDirectory();
    stage = 'output'; await createOutput(output);
    stage = 'bundle';
    await pack(root, join(scratch, 'bundle'), { baseImage, source, childImage,
      onPhase(value) { if (['inventory', 'manifest', 'blobs'].includes(value)) stage = value; } });
    stage = 'archive'; await archive(join(scratch, 'bundle'), join(output, 'runtime-blobs.tar'));
    stage = 'manifest-copy'; await copyManifest(join(scratch, 'bundle/manifest.json'), join(output, 'manifest.json'));
  } catch (error) { diagnostic = { stage, category: packagingFailureCategory(error) }; }
  finally {
    if (scratch) try { await cleanup(scratch, { recursive: true, force: true }); }
    catch (error) { diagnostic ??= { stage: 'cleanup', category: packagingFailureCategory(error) }; }
  }
  return diagnostic;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, output, baseImage, source, childImage] = process.argv.slice(2);
  if (process.argv.length !== 7 || !root || !isAbsolute(root) || !output || !isAbsolute(output)) {
    process.stderr.write('Usage: package-runtime-release <image-root> <output> <base-image-digest> <source-commit> <child-image-digest>\n');
    process.exitCode = 2;
  } else {
    const diagnostic = await packageRuntimeRelease({ root, output, baseImage, source, childImage });
    if (diagnostic) {
      process.stderr.write(`Runtime release packaging failed: stage=${diagnostic.stage} category=${diagnostic.category}\n`);
      process.exitCode = 1;
    }
  }
}
