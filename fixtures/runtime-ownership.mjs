import { acquireRuntimeOwnership } from '../runtime-ownership.mjs';
const held = new Set();
export const testIdentity = { bootId: '11111111-1111-1111-1111-111111111111', pidNamespace: '100', pid: 1, procStartTicks: '20' };
export async function testLock(file) {
  if (held.has(file)) throw Object.assign(Error('Runtime ownership unavailable'), { code: 'EEXIST' });
  held.add(file);
  return { async close() { held.delete(file); } };
}
export const testOwnership = options => acquireRuntimeOwnership({ environmentBinding: 'test-environment', ...options,
  environmentBinding: options.environmentBinding ?? 'test-environment', lock: testLock, identity: async () => testIdentity });
