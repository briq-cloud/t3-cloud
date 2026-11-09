import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRuntimeOwnership } from './runtime-ownership.mjs';
import { testIdentity, testLock, testOwnership } from './fixtures/runtime-ownership.mjs';
import { startLoader } from './runtime-loader.mjs';
import { prepareBootstrapMigration, recoverBootstrapMigration } from './runtime-bootstrap-migration.mjs';
import { createHash } from 'node:crypto';
import { runtimeProcess } from './runtime-process.mjs';
import { runtimeControllerProcess } from './runtime-controller-process.mjs';
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
async function fixture(t, { recovery = false, unknown = false, journal, ownershipEvidence, bootstrapMigration = false, releaseController = false, expectedCloseFailure = false } = {}) {
  const state = await mkdtemp(join(tmpdir(), 't3-loader-integration-'));
  let loader;
  t.after(async () => {
    try { await loader?.close(); } catch (error) { if (!expectedCloseFailure) throw error; }
    finally {
      if (expectedCloseFailure) await loader?.supervisor.driver.stop();
      await rm(state, { recursive: true, force: true });
    }
  });
  const baseImageFile = join(state, 'base-image'), sourceFile = join(state, 'source');
  await writeFile(baseImageFile, `sha256:${'c'.repeat(64)}`);
  if (!unknown) await writeFile(sourceFile, 'd'.repeat(40));
  if (recovery || journal) {
    const { mkdir } = await import('node:fs/promises'); await mkdir(join(state, 'updates'));
    await writeFile(join(state, 'updates/activation.json'), JSON.stringify(journal ?? { protocol: 1, current: 'bootstrap', staged: identity,
      desired: identity, phase: 'starting', receipt: { from: 'bootstrap', to: identity, status: 'pending' } }));
  }
  if (ownershipEvidence) {
    const prior = await testOwnership({ directory: join(state, 'updates'), name: 'loader', environmentBinding: 'owner' });
    await prior.close();
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
  const controllerEntries = {};
  if (releaseController) for (const version of ['base-controller', 'released-controller']) {
    const entry = join(state, `${version}.mjs`); controllerEntries[version] = entry;
    await writeFile(entry, `
      import { serveRuntimeController } from ${JSON.stringify(new URL('./runtime-controller.mjs', import.meta.url).href)};
      import { RuntimeUpdates } from ${JSON.stringify(new URL('./runtime-updates.mjs', import.meta.url).href)};
      serveRuntimeController(process, { createUpdates(options) {
        const updates = new RuntimeUpdates({ ...options, schedule: () => ({ unref() {} }), cancel() {}, consumer: {
          check: async () => ({ tag: 'runtime-${source}', source: '${source}', publishedAt: '2026-11-09T00:00:00Z', sizes: { 'manifest.json': 1, 'runtime-blobs.tar': 1, 'runtime-attestation.jsonl': 1 } }),
          stage: () => options.stage(${JSON.stringify(join(state, 'updates/download-Abc123/manifest.json'))}, ${JSON.stringify(join(state, 'updates/download-Abc123/blobs'))}) } });
        const status = updates.status.bind(updates);
        updates.status = async () => ({ ...await status(), controllerVersion: '${version}' });
        return updates;
      } });`);
  }
  const childImage = `ghcr.io/briq-cloud/t3-cloud@sha256:${'e'.repeat(64)}`;
  const manifest = { source, childImage, files: [{ path: 'opt/t3-cloud/runtime-recovery.json', type: 'file', sha256: createHash('sha256').update('{"protocol":1,"persistedBindings":"quarantine"}\n').digest('hex') }] };
  const migratedOwnership = options => acquireRuntimeOwnership({ ...options, lock: testLock, identity: async () => ({ ...testIdentity, bootId: '22222222-2222-2222-2222-222222222222' }) });
  if (bootstrapMigration) {
    const { mkdir } = await import('node:fs/promises'); await mkdir(join(state, 'central.lock'));
    await writeFile(sourceFile, source);
    await prepareBootstrapMigration({ T3_CLOUD_STATE: state, T3_CLOUD_OWNER_ID: 'owner', T3_CLOUD_CHILD_IMAGE: `ghcr.io/briq-cloud/t3-cloud@sha256:${'f'.repeat(64)}`, T3_CLOUD_BOOTSTRAP_BASE_IMAGE: `sha256:${'c'.repeat(64)}` }, {
      identity: async () => testIdentity, stage: async () => ({ identity, path: '/staged-fixture' }), verify: async () => ({ ...manifest, baseImage: `sha256:${'c'.repeat(64)}` }) });
  }
  let starts = 0, updateWork, controllerWork, controllerTerminal; const recoveries = [], controllers = [];
  const port = await unusedPort();
  loader = await startLoader({ PORT: String(port), T3_HOST: '127.0.0.1', T3_CWD: state, T3_CLOUD_STATE: state,
    T3_CLOUD_PUBLIC_ORIGIN: origin, T3_CLOUD_OWNER_KEY: key, T3_CLOUD_OWNER_ID: 'owner', T3_CLOUD_CHILD_IMAGE: childImage }, {
    baseImageFile, sourceFile, acquireOwnership: bootstrapMigration ? migratedOwnership : ownershipEvidence ? options => acquireRuntimeOwnership({ ...options, lock: testLock, identity: async () => ({ ...testIdentity, ...(ownershipEvidence === 'cold' ? { bootId: '22222222-2222-2222-2222-222222222222' } : {}) }) }) : testOwnership,
    recoverMigration: options => recoverBootstrapMigration({ ...options, identity: async () => ({ ...testIdentity, bootId: '22222222-2222-2222-2222-222222222222' }), acquireOwnership: migratedOwnership }),
    createDriver: env => runtimeProcess(env, { spawnProcess: (_command, _args, options) => {
      starts++; recoveries.push(options.env.T3_CLOUD_RECOVERY); return spawn(process.execPath, [childFile], options);
    } }),
    createSupervisor: options => new RuntimeSupervisor({ ...options, verify: async () => manifest, stage: async () => ({ identity }) }),
    createUpdates: options => {
      controllerTerminal = options.onTerminal;
      if (releaseController) {
        const controller = runtimeControllerProcess({ ...options,
          onTerminal: () => (controllerWork = options.onTerminal()),
          spawnProcess(command, args, settings) {
            controllers.push({ command, entry: args[0] });
            return spawn(process.execPath, [controllerEntries[options.root === '/' ? 'base-controller' : 'released-controller']], settings);
          } });
        const update = controller.update; controller.update = () => (updateWork = update()); return controller;
      }
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
  return { state, port, loader, send, recoveries, controllers, controllerTerminal: () => controllerTerminal(), waitController: async () => { await new Promise(resolve => setImmediate(resolve)); await controllerWork; }, starts: () => starts, waitUpdate: async () => { await new Promise(resolve => setImmediate(resolve)); await updateWork; } };
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

test('owner cold reconciliation CAS recovers verified current and preserves staged state without implicit startup', async t => {
  const f = await fixture(t, { ownershipEvidence: 'cold', journal: { protocol: 1, revision: 10, current: 'bootstrap',
    desired: null, staged: identity, phase: 'running', receipt: null } });
  assert.equal(f.starts(), 0);
  const status = (await f.send('/_cloud/updates/status')).value;
  assert.equal(status.recovery.available, true); assert.equal(status.recovery.ownership, 'cold');
  const input = { action: 'recover-known-current', expectedJournalRevision: status.recovery.journalRevision,
    expectedOwnershipRevision: status.recovery.ownershipRevision };
  assert.equal((await f.send('/_cloud/updates/reconcile', { method: 'POST', input, auth: false })).status, 401);
  assert.equal((await f.send('/_cloud/updates/reconcile', { method: 'POST', input, requestOrigin: 'https://evil.example' })).status, 403);
  assert.notEqual((await f.send('/_cloud/updates/reconcile', { method: 'POST', input: { ...input, expectedJournalRevision: 9 } })).status, 200);
  assert.equal(f.starts(), 0);
  assert.equal((await f.send('/_cloud/updates/reconcile', { method: 'POST', input })).status, 200);
  assert.equal(f.starts(), 1); assert.deepEqual(f.recoveries, ['1']);
  assert.equal(f.loader.supervisor.journal.phase, 'running'); assert.equal(f.loader.supervisor.journal.staged, identity);
  assert.equal(f.loader.supervisor.journal.receipt, null); assert.equal(f.loader.supervisor.admitting, true);
  assert.notEqual((await f.send('/_cloud/updates/reconcile', { method: 'POST', input })).status, 200);
});

test('same-boot orphan manager on 8082 receives no traffic from the recovery frontdoor', async t => {
  const { createServer } = await import('node:http'); let oldRequests = 0;
  const old = createServer((_req, res) => { oldRequests++; res.end('unowned manager'); });
  await new Promise(resolve => old.listen(8082, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => old.close(resolve)));
  const f = await fixture(t, { ownershipEvidence: 'orphan', journal: { protocol: 1, revision: 1,
    current: 'bootstrap', desired: null, staged: null, phase: 'running', receipt: null } });
  const status = await f.send('/_cloud/updates/status');
  assert.equal(status.status, 200); assert.equal(status.value.recovery.ownership, 'orphan'); assert.equal(status.value.recovery.available, false);
  assert.equal((await f.send('/native')).status, 503); assert.equal(f.starts(), 0); assert.equal(oldRequests, 0);
});


test('committed activation joins old updater and launches the selected release controller code and Node', async t => {
  const f = await fixture(t, { releaseController: true });
  assert.equal((await f.send('/_cloud/updates/status')).value.controllerVersion, 'base-controller');
  assert.equal((await f.send('/_cloud/updates/check', { method: 'POST' })).value.outcome, 'available');
  await f.send('/_cloud/updates/update', { method: 'POST' }); await f.waitUpdate();
  assert.equal(f.loader.supervisor.journal.phase, 'draining');
  assert.equal(f.controllers.length, 1);
  const old = f.loader.updates;
  await old.tick(); await f.waitController();
  assert.equal(old.alive, false);
  const selectedRoot = f.loader.supervisor.releaseRoot(identity);
  assert.deepEqual(f.controllers, [
    { command: '/opt/t3/node', entry: '/opt/t3-cloud/runtime-controller.mjs' },
    { command: join(selectedRoot, 'opt/t3/node'), entry: join(selectedRoot, 'opt/t3-cloud/runtime-controller.mjs') },
  ]);
  const current = (await f.send('/_cloud/updates/status')).value;
  assert.equal(current.controllerVersion, 'released-controller');
  assert.equal(current.currentSource, source);
  assert.equal(current.receipt.status, 'committed');
  assert.equal(current.outcome, 'activated');
});


test('loader shutdown immediately fences established sockets even when updater stop is unknown', async t => {
  const f = await fixture(t, { expectedCloseFailure: true });
  assert.equal(f.loader.supervisor.admitting, true);
  const socket = connect(f.port, '127.0.0.1');
  socket.on('error', () => {}); t.after(() => socket.destroy());
  await once(socket, 'connect');
  // Keep an admitted HTTP connection established across shutdown.
  socket.write('GET /native HTTP/1.1\r\nHost: cloud.example\r\n');
  await new Promise(resolve => setImmediate(resolve));
  const closed = new Promise(resolve => socket.once('close', resolve));
  let stopCalls = 0;
  f.loader.updates.stop = async () => { stopCalls++; throw Error('Runtime controller termination unknown'); };
  const closing = f.loader.close();
  assert.equal(f.loader.supervisor.admitting, false);
  await assert.rejects(closing, /termination unknown/);
  await closed;
  assert.equal(stopCalls, 1);
  assert.equal(f.loader.supervisor.driver.alive, true);
  assert.equal(f.loader.supervisor.journal.phase, 'running');
  await assert.rejects(f.loader.close(), /termination unknown/);
  assert.equal(stopCalls, 1);
});


test('failed controller replacement fences established sockets and retains recovery state', async t => {
  const f = await fixture(t, { expectedCloseFailure: true });
  const socket = connect(f.port, '127.0.0.1');
  socket.on('error', () => {}); t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('GET /native HTTP/1.1\r\nHost: cloud.example\r\n');
  await new Promise(resolve => setImmediate(resolve));
  const closed = new Promise(resolve => socket.once('close', resolve));
  f.loader.updates.stop = async () => { throw Error('Runtime controller termination unknown'); };
  await f.loader.supervisor.save({ current: identity, desired: null, receipt: { from: 'bootstrap', to: identity, status: 'committed' } });
  await assert.rejects(f.controllerTerminal(), /termination unknown/);
  await closed;
  assert.equal(f.loader.supervisor.admitting, false);
  assert.equal(f.loader.supervisor.journal.phase, 'recovery-required');
  assert.equal((await f.send('/native')).status, 503);
  assert.equal(f.loader.supervisor.driver.alive, true);
});


test('prepared bootstrap migration stays management-only until owner action crosses authenticated HTTP and owned health', async t => {
  const f = await fixture(t, { bootstrapMigration: true });
  assert.equal(f.starts(), 0);
  assert.equal((await f.send('/native')).status, 503);
  assert.equal((await f.send('/_cloud/threads', { method: 'POST', input: { threadId: 'old' } })).status, 503);
  const status = (await f.send('/_cloud/updates/status')).value;
  const input = { action: 'recover-bootstrap-migration', expectedMigrationId: status.recovery.migration.id,
    expectedMigrationRevision: status.recovery.migration.revision, expectedJournalRevision: status.recovery.journalRevision,
    expectedOwnershipRevision: status.recovery.ownershipRevision };
  assert.equal((await f.send('/_cloud/updates/reconcile', { method: 'POST', input, auth: false })).status, 401);
  assert.equal((await f.send('/_cloud/updates/reconcile', { method: 'POST', input, requestOrigin: 'https://evil.example' })).status, 403);
  assert.equal((await f.send('/_cloud/updates/reconcile', { method: 'POST', input: { ...input, destination: '/tmp/untrusted' } })).status, 400);
  assert.equal(f.starts(), 0);
  const response = await f.send('/_cloud/updates/reconcile', { method: 'POST', input });
  assert.equal(response.status, 200); assert.equal(f.starts(), 1); assert.deepEqual(f.recoveries, ['1']);
  const journal = f.loader.supervisor.journal;
  assert.equal(journal.current, identity); assert.equal(journal.receipt, null); assert.ok(journal.initialInstall);
  const receipt = JSON.parse(await readFile(join(f.state, 'updates/bootstrap-migration.json'), 'utf8'));
  assert.equal(receipt.phase, 'completed'); assert.equal(f.loader.supervisor.admitting, true);
});
