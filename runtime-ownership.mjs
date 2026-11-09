// Local kernel ownership and durable evidence are separate. A free lock proves
// exclusivity now; it never proves that an old owner's descendants have ended.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { durableJson } from './runtime-supervisor.mjs';

export const ownershipRevision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bindingValid = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/.test(value);
export async function linuxIdentity() {
  const [bootId, pidNamespace, proc] = await Promise.all([
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'), stat('/proc/self/ns/pid'), readFile('/proc/self/stat', 'utf8'),
  ]);
  const fields = proc.slice(proc.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (!/^[a-f0-9-]{36}$/.test(bootId.trim()) || !/^\d+$/.test(fields[19])) throw Error('Kernel identity unavailable');
  return { bootId: bootId.trim(), pidNamespace: String(pidNamespace.ino), pid: process.pid, procStartTicks: fields[19] };
}

// The lock inode is never renamed or unlinked. flock inherits only its explicit
// descriptor; native descendants cannot inherit it. Closing stdin ends the
// helper, while closing both descriptors releases kernel ownership on a crash.
export async function kernelLock(file, { spawnProcess = spawn, binary = '/usr/bin/flock' } = {}) {
  const handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  if (!(await handle.stat()).isFile()) { await handle.close(); throw Error('Invalid ownership inode'); }
  const child = spawnProcess('/bin/sh', ['-c',
    '"$1" --exclusive --nonblock --conflict-exit-code 73 3 || exit $?; printf "owned\\n"; /bin/cat >/dev/null', 'runtime-ownership', binary], { stdio: ['pipe', 'pipe', 'ignore', handle.fd] });
  child.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      child.once('error', reject);
      child.once('exit', () => reject(Error('Runtime ownership unavailable')));
      child.stdout.on('data', bytes => { output += bytes; if (output === 'owned\n') resolve(); else if (output.length > 6) reject(Error('Invalid ownership handshake')); });
    });
  } catch (error) { child.stdin.destroy(); await handle.close(); throw error; }
  let closed = false;
  return { async close() {
    if (closed) return; closed = true;
    const ended = new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    child.stdin.end(); await ended; await handle.close();
  } };
}

export async function acquireRuntimeOwnership({ directory, name, environmentBinding, legacy,
  identity = linuxIdentity, lock = kernelLock }) {
  if (!['loader', 'central'].includes(name)) throw Error('Invalid ownership role');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lease = await lock(join(directory, `${name}.ownership.lock`));
  const file = join(directory, `${name}.ownership.json`);
  try {
    let previous = null, malformed = false, legacyExists = false, local = null, claimed = false, original = null;
    try { original = await readFile(file, 'utf8'); previous = JSON.parse(original); } catch (error) { if (error.code !== 'ENOENT') malformed = true; }
    if (legacy) { try { await stat(legacy); legacyExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    try { local = await identity(); } catch { /* Inspection remains available without proof. */ }
    const valid = previous?.protocol === 1 && bindingValid(previous.environmentBinding) &&
      /^[a-f0-9-]{36}$/.test(previous.generation ?? '') && /^[a-f0-9-]{36}$/.test(previous.bootId ?? '') &&
      /^\d+$/.test(previous.pidNamespace ?? '') && Number.isSafeInteger(previous.pid) && previous.pid > 0 &&
      /^\d+$/.test(previous.procStartTicks ?? '') && ['active', 'clean'].includes(previous.state);
    let evidence = 'unknown';
    if (bindingValid(environmentBinding) && local && !malformed && !legacyExists) {
      if (original === null && !legacyExists) evidence = 'fresh';
      else if (valid && previous.environmentBinding === environmentBinding) {
        if (previous.bootId !== local.bootId) evidence = 'cold';
        else if (previous.state === 'clean' && previous.pidNamespace === local.pidNamespace) evidence = 'clean';
        else evidence = 'orphan';
      }
    }
    // Preserve the original uncertain evidence across any number of inspections.
    // A new inspection must never make a copied/legacy binding look authoritative.
    let record = previous;
    const claim = async () => {
      if (!['fresh', 'clean', 'cold'].includes(evidence)) throw Error('Ownership requires reconciliation');
      record = { protocol: 1, generation: randomUUID(), environmentBinding, ...local, state: 'active' };
      await durableJson(file, record); claimed = true;
    };
    if (['fresh', 'clean'].includes(evidence)) await claim();
    let closed = false;
    return { evidence, get revision() { return ownershipRevision({ record, original, malformed, legacyExists, evidence }); },
      async reconcile(expectedRevision) {
        if (expectedRevision !== this.revision || evidence !== 'cold') throw Error('Ownership evidence changed or unresolved');
        if (await readFile(file, 'utf8') !== original) throw Error('Ownership record changed');
        await claim();
      },
      async close({ clean = false } = {}) {
        if (closed) return; closed = true;
        try {
          // Never erase a successor's durable record (or a legacy directory).
          if (clean && claimed && record) {
            const current = JSON.parse(await readFile(file, 'utf8'));
            if (current.generation !== record.generation) throw Error('Ownership generation changed');
            await durableJson(file, { ...record, state: 'clean' });
          }
        } finally { await lease.close(); }
      },
    };
  } catch (error) { await lease.close(); throw error; }
}
