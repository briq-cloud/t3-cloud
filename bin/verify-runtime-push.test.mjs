import test from 'node:test';
import assert from 'node:assert/strict';
import { pushedRuntimeDigest, verifyRuntimeImageManifest } from './verify-runtime-push.mjs';

const configID = `sha256:${'a'.repeat(64)}`, manifestID = `sha256:${'b'.repeat(64)}`;
const receipt = `The push refers to repository [ghcr.io/briq-cloud/t3-cloud]\nabc123: Pushed\n2026-11-09: digest: ${manifestID} size: 1987\n`;
const manifest = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: configID }, layers: [] };

test('successful push receipt and immutable manifest bind companion to checked image ID', () => {
  assert.equal(pushedRuntimeDigest(receipt), manifestID);
  assert.equal(verifyRuntimeImageManifest(manifest, configID), configID);
  assert.equal(verifyRuntimeImageManifest({ ...manifest, mediaType: 'application/vnd.docker.distribution.manifest.v2+json' }, configID), configID);
});

test('rejects missing, ambiguous, malformed or oversized push receipts', () => {
  for (const bad of ['', 'digest: ' + manifestID, receipt + receipt,
    receipt.replace(manifestID, manifestID.toUpperCase()), receipt.replace('size: 1987', 'size: zero'),
    receipt.replace('size: 1987', 'size: 1987 extra'), receipt.replace('size: 1987', 'size: 0'),
    'a'.repeat(1_000_001)]) assert.throws(() => pushedRuntimeDigest(bad));
});

test('rejects another config digest, image indexes, missing configuration and malformed identity', () => {
  for (const bad of [
    { ...manifest, config: { digest: manifestID } },
    { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] },
    { ...manifest, config: undefined }, { ...manifest, schemaVersion: 1 }, { ...manifest, layers: undefined },
  ]) assert.throws(() => verifyRuntimeImageManifest(bad, configID));
  assert.throws(() => verifyRuntimeImageManifest(manifest, 'not-an-image-id'));
});
