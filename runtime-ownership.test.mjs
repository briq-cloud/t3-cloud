import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRuntimeOwnership, kernelLock } from './runtime-ownership.mjs';
import { testIdentity, testLock } from './fixtures/runtime-ownership.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 't3-ownership-'));
  const leases = [];
  t.after(async () => { for (const lease of leases) await lease.close(); await rm(directory, { recursive: true, force: true }); });
  const options = { directory, name: 'loader', environmentBinding: 'environment-1', identity: async () => testIdentity, lock: testLock };
  const acquire = async patch => { const lease = await acquireRuntimeOwnership({ ...options, ...patch }); leases.push(lease); return lease; };
  return { directory, acquire, file: join(directory, 'loader.ownership.json') };
}
test('exclusive lease rejects duplicate owner and clean release keeps stable evidence', async t => {
  const f = await fixture(t); const owner = await f.acquire();
  assert.equal(owner.evidence, 'fresh');
  await assert.rejects(f.acquire(), /ownership unavailable/);
  await owner.close({ clean: true });
  assert.equal((await f.acquire()).evidence, 'clean');
});
test('same boot orphan remains unknown across repeated inspections; no PID signal is used', async t => {
  const f = await fixture(t); await (await f.acquire()).close();
  const original = await readFile(f.file, 'utf8');
  const orphan = await f.acquire(); assert.equal(orphan.evidence, 'orphan');
  await assert.rejects(orphan.reconcile(orphan.revision), /unresolved/);
  await orphan.close({ clean: true });
  assert.equal(await readFile(f.file, 'utf8'), original);
  assert.equal((await f.acquire()).evidence, 'orphan');
});
test('only changed boot with identical trusted environment binding permits explicit claim', async t => {
  const f = await fixture(t); await (await f.acquire()).close();
  const identity = async () => ({ ...testIdentity, bootId: '22222222-2222-2222-2222-222222222222' });
  const copied = await f.acquire({ environmentBinding: 'copied-environment', identity });
  assert.equal(copied.evidence, 'unknown'); await copied.close();
  const cold = await f.acquire({ identity }); assert.equal(cold.evidence, 'cold');
  const previous = JSON.parse(await readFile(f.file, 'utf8'));
  await assert.rejects(cold.reconcile('stale-revision'), /changed/);
  await cold.reconcile(cold.revision);
  const current = JSON.parse(await readFile(f.file, 'utf8'));
  assert.notEqual(current.generation, previous.generation); assert.equal(current.bootId, '22222222-2222-2222-2222-222222222222');
});
for (const input of ['missing-binding', 'legacy', 'malformed']) {
  test(`${input} is preserved and cannot become proof after inspection`, async t => {
    const f = await fixture(t); const legacy = join(f.directory, 'loader.lock');
    if (input === 'legacy') await mkdir(legacy);
    if (input === 'malformed') await writeFile(f.file, '{broken');
    const patch = { legacy, ...(input === 'missing-binding' ? { environmentBinding: undefined } : {}) };
    const unknown = await f.acquire(patch); assert.equal(unknown.evidence, 'unknown');
    await unknown.close({ clean: true });
    const again = await f.acquire(patch); assert.equal(again.evidence, 'unknown');
    await assert.rejects(again.reconcile(again.revision), /unresolved/);
  });
}
test('reconciliation rejects concurrent modification of the durable owner record', async t => {
  const f = await fixture(t); await (await f.acquire()).close();
  const cold = await f.acquire({ identity: async () => ({ ...testIdentity, bootId: '33333333-3333-3333-3333-333333333333' }) });
  await writeFile(f.file, JSON.stringify({ ...JSON.parse(await readFile(f.file, 'utf8')), generation: 'replacement' }));
  await assert.rejects(cold.reconcile(cold.revision), /record changed/);
});
test('Linux flock holds one stable inode across acquisition/release', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t); const file = join(f.directory, 'kernel.lock');
  const first = await kernelLock(file); t.after(() => first.close());
  await assert.rejects(kernelLock(file), /ownership unavailable/);
  await first.close(); const second = await kernelLock(file); await second.close();
});

test('clean release never overwrites a successor generation', async t => {
  const f = await fixture(t); const owner = await f.acquire();
  const successor = { ...JSON.parse(await readFile(f.file, 'utf8')), generation: '44444444-4444-4444-4444-444444444444' };
  await writeFile(f.file, JSON.stringify(successor));
  await assert.rejects(owner.close({ clean: true }), /generation changed/);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), successor);
});
