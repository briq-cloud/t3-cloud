#!/usr/bin/env node
// CI conformance check; this deliberately does not stand in for provenance verification.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { unpackRuntimeArchive } from './runtime-archive.mjs';

const [bundle] = process.argv.slice(2);
if (process.argv.length !== 3 || !bundle || !isAbsolute(bundle)) {
  process.stderr.write('Usage: check-runtime-release <release-assets-directory>\n');
  process.exitCode = 2;
} else {
  const scratch = await mkdtemp(join(tmpdir(), 't3-runtime-check-'));
  try {
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
    await unpackRuntimeArchive(join(bundle, 'runtime-blobs.tar'), join(scratch, 'blobs'), manifest);
  } catch {
    process.stderr.write('Runtime archive conformance failed\n');
    process.exitCode = 1;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
