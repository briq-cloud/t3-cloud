import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoader } from './runtime-loader.mjs';
import { runtimeProcess } from './runtime-process.mjs';
import { RuntimeSupervisor } from './runtime-supervisor.mjs';
import { RuntimeUpdates } from './runtime-updates.mjs';
import { createCloudManager } from './manager.mjs';

const key = 'owner-key-for-integration-test-1234567890123456';
const origin = 'https://cloud.example';
const identity = `sha256:${'a'.repeat(64)}`;
const source = 'b'.repeat(40);
async function unusedPort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function fixture(t, { recovery = false, unknown = false } = {}) {
  const state = await mkdtemp(join(tmpdir(), 't3-loader-integration-'));
  let loader;
  t.after(async () => { await loader?.close(); await rm(state, { recursive: true, force: true }); });
  const baseImageFile = join(state, 'base-image'), sourceFile = join(state, 'source');
  await writeFile(baseImageFile, `sha256:${'c'.repeat(64)}`);
  if (!unknown) await writeFile(sourceFile, 'd'.repeat(40));
  if (recovery) {
    const { mkdir } = await import('node:fs/promises'); await mkdir(join(state, 'updates'));
    await writeFile(join(state, 'updates/activation.json'), JSON.stringify({ protocol: 1, current: 'bootstrap', staged: identity,
      desired: identity, phase: 'starting', receipt: { from: 'bootstrap', to: identity, status: 'pending' } }));
  }
  // A real Node child runs the real authenticated HTTP manager and IPC client.
  // The native process and release verifier are bounded test doubles; no vendor
  // process, credential, remote endpoint or downloaded binary is involved.
  const childFile = join(state, 'manager-fixture.mjs');
  await writeFile(childFile, `
    import { createCloudManager } from ${JSON.stringify(new URL('./manager.mjs', import.meta.url).href)};
    import { runtimeUpdateClient } from ${JSON.stringify(new URL('./runtime-process.mjs', import.meta.url).href)};
    let draining = false, afterDrain = 0;
    const updates = runtimeUpdateClient();
    const server = createCloudManager({ role: 'central', ownerId: 'owner', ownerKey: process.env.T3_CLOUD_OWNER_KEY,
      publicOrigin: process.env.T3_CLOUD_PUBLIC_ORIGIN, connections: {}, allocator: { allocate() {} }, broker: { ownerRequest() {} },
      runtimeUpdates: updates, ready: () => !draining, nativeAdmitting: () => !draining });
    const listening = new Promise(resolve => server.listen(8082, '127.0.0.1', resolve));
    process.on('message', async value => {
      if (value.channel !== undefined || value.protocol !== 1) return;
      await listening;
      let result = {};
      if (value.method === 'drain') { draining = true; afterDrain = 0; }
      if (value.method === 'activity') result = { idle: !draining || afterDrain++ > 0 };
      if (value.method === 'stop') { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); updates.close(); }
      process.send({ protocol: 1, id: value.id, ok: true, result });
    });
    process.once('disconnect', () => process.exit(0));
  `);
  let starts = 0, updateWork;
  const port = await unusedPort();
  loader = await startLoader({ PORT: String(port), T3_HOST: '127.0.0.1', T3_CWD: state, T3_CLOUD_STATE: state,
    T3_CLOUD_PUBLIC_ORIGIN: origin, T3_CLOUD_OWNER_KEY: key, T3_CLOUD_OWNER_ID: 'owner' }, {
    baseImageFile, sourceFile,
    createDriver: env => runtimeProcess(env, { spawnProcess: (_command, _args, options) => {
      starts++; return spawn(process.execPath, [childFile], options);
    } }),
    createSupervisor: options => new RuntimeSupervisor({ ...options, verify: async () => ({ source }), stage: async () => ({ identity }) }),
    createUpdates: options => {
      const updates = new RuntimeUpdates({ ...options, schedule: () => ({ unref() {} }), cancel() {},
      consumer: { check: async () => ({ tag: `runtime-${source}`, source, publishedAt: '2026-11-09T00:00:00Z', sizes: {} }),
        stage: () => options.stage('/bounded/manifest', '/bounded/blobs') } });
      const update = updates.update.bind(updates); updates.update = () => (updateWork = update()); return updates;
    },
    createRecoveryManager: options => createCloudManager(options),
  });
  const send = async (path, { method = 'GET', input, auth = true, requestOrigin = origin, cookie } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { ...(auth ? { authorization: `Bearer ${key}` } : {}), ...(cookie ? { cookie } : {}),
        ...(method === 'POST' ? { origin: requestOrigin, 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(input ?? {}) } : {}) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, value: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  return { state, loader, send, starts: () => starts, waitUpdate: async () => { await new Promise(resolve => setImmediate(resolve)); await updateWork; } };
}

test('authenticated owner update crosses real IPC; drain status stays available and committed receipt survives manager replacement', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('/_cloud/updates/status', { auth: false })).status, 401);
  assert.equal((await f.send('/_cloud/updates/check', { method: 'POST', requestOrigin: 'https://evil.example' })).status, 403);
  assert.equal((await f.send('/_cloud/updates/check', { method: 'POST', input: { url: 'https://evil.example' } })).status, 400);
  const login = await f.send('/_cloud/login', { method: 'POST', auth: false, input: { key } });
  const cookie = login.headers.get('set-cookie'); assert.equal(login.status, 200);
  assert.equal((await f.send('/_cloud/updates/status', { auth: false, cookie })).status, 200);
  assert.equal((await f.send('/_cloud/updates/check', { method: 'POST' })).value.outcome, 'available');
  assert.equal((await f.send('/_cloud/updates/automatic', { method: 'POST', input: { enabled: true } })).value.automatic, true);
  assert.equal((await f.send('/_cloud/updates/update', { method: 'POST' })).value.accepted, true);
  // Local in-memory completion event, no timer polling or network replay.
  await f.waitUpdate();
  assert.equal(f.loader.supervisor.journal.phase, 'draining');
  const status = await f.send('/_cloud/updates/status'); assert.equal(status.status, 200); assert.equal(status.value.phase, 'draining');
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal((await f.send('/native')).status, 503);
  assert.equal((await f.send('/_cloud/threads', { method: 'POST', input: { threadId: 'test' } })).status, 503);
  assert.equal((await f.send('/_cloud/briq/mcp', { method: 'POST' })).status, 503);
  await f.loader.updates.tick();
  assert.equal(f.starts(), 2);
  const committed = await f.send('/_cloud/updates/status'); assert.equal(committed.status, 200);
  assert.equal(committed.value.current, identity); assert.equal(committed.value.receipt.status, 'committed');
  assert.deepEqual(JSON.parse(await readFile(join(f.state, 'updates/activation.json'), 'utf8')).receipt,
    { from: 'bootstrap', to: identity, status: 'committed' });
  // Cookie belongs to the old manager generation and cannot authorize the new one.
  assert.equal((await f.send('/_cloud/updates/status', { auth: false, cookie })).status, 401);
});

test('ambiguous restart exposes only owner-authenticated recovery UI without starting native or central runtime', async t => {
  const f = await fixture(t, { recovery: true, unknown: true });
  assert.equal(f.starts(), 0); assert.equal(f.loader.status.recoveryRequired, true);
  assert.equal((await f.send('/_cloud/')).status, 200);
  assert.equal((await f.send('/_cloud/updates/status', { auth: false })).status, 401);
  const status = await f.send('/_cloud/updates/status');
  assert.equal(status.value.currentSource, null); assert.equal(status.value.desired, identity); assert.equal(status.value.receipt.status, 'pending');
  assert.equal((await f.send('/_cloud/updates/update', { method: 'POST', requestOrigin: 'https://evil.example' })).status, 403);
  assert.equal((await f.send('/native')).status, 503);
  assert.equal((await f.send('/_cloud/connections')).status, 503);
  assert.equal((await f.send('/_cloud/briq/mcp', { method: 'POST' })).status, 503);
  assert.equal((await f.send('/_cloud/terminal/')).status, 503);
  await f.loader.updates.update(); assert.equal(f.loader.supervisor.journal.phase, 'starting'); assert.equal(f.starts(), 0);
});
