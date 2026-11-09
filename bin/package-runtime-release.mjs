#!/usr/bin/env node
import { packBundle } from '../runtime-bundle.mjs';
import { packRuntimeArchive } from './runtime-archive.mjs';
import { join, isAbsolute } from 'node:path';
import { mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const [root, output, baseImage, source, childImage] = process.argv.slice(2);
if (process.argv.length !== 7 || !root || !isAbsolute(root) || !output || !isAbsolute(output)) {
  process.stderr.write('Usage: package-runtime-release <image-root> <output> <base-image-digest> <source-commit> <child-image-digest>\n');
  process.exitCode = 2;
} else {
  const scratch = await mkdtemp(join(tmpdir(), 't3-runtime-release-'));
  try {
    await mkdir(output, { mode: 0o700 });
    await packBundle(root, join(scratch, 'bundle'), { baseImage, source, childImage });
    await packRuntimeArchive(join(scratch, 'bundle'), join(output, 'runtime-blobs.tar'));
    await copyFile(join(scratch, 'bundle/manifest.json'), join(output, 'manifest.json'));
  } catch {
    process.stderr.write('Runtime release packaging failed\n');
    process.exitCode = 1;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
