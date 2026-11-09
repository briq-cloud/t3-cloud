#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const sha256 = /^sha256:[a-f0-9]{64}$/;

// docker push's successful receipt identifies the uploaded manifest. A later tag
// lookup is not a receipt: another writer may have moved that tag already.
export function pushedRuntimeDigest(receipt) {
  if (typeof receipt !== 'string' || Buffer.byteLength(receipt) > 1_000_000) throw Error('Invalid runtime push receipt');
  const rows = receipt.split(/\r?\n/).filter(line => /: digest: /.test(line));
  if (rows.length !== 1) throw Error('Ambiguous runtime push receipt');
  const match = /^[^\s]+: digest: (sha256:[a-f0-9]{64}) size: [1-9][0-9]*$/.exec(rows[0]);
  if (!match) throw Error('Invalid runtime push digest');
  return match[1];
}

export function verifyRuntimeImageManifest(manifest, checkedImageID) {
  if (!sha256.test(checkedImageID) || manifest?.schemaVersion !== 2 ||
      !['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(manifest.mediaType) ||
      manifest.config?.digest !== checkedImageID || !Array.isArray(manifest.layers)) throw Error('Published runtime differs from checked image');
  return checkedImageID;
}

async function boundedText(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 1_000_000) throw Error('Runtime publication receipt exceeds capacity limit');
  const bytes = await readFile(path);
  if (bytes.length > 1_000_000) throw Error('Runtime publication receipt exceeds capacity limit');
  return bytes.toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, file, checkedImageID] = process.argv.slice(2);
    if (mode === 'receipt' && process.argv.length === 4) process.stdout.write(`${pushedRuntimeDigest(await boundedText(file))}\n`);
    else if (mode === 'manifest' && process.argv.length === 5) verifyRuntimeImageManifest(JSON.parse(await boundedText(file)), checkedImageID);
    else throw Error('Invalid runtime publication verification arguments');
  } catch {
    process.stderr.write('Runtime publication identity verification failed\n');
    process.exitCode = 1;
  }
}
