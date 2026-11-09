import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimePath, runtimePathEnv } from './runtime-paths.mjs';

test('default image paths retain the current startup contract', () => {
  assert.equal(runtimePath({}, 'opt/t3/t3'), '/opt/t3/t3');
  assert.equal(runtimePathEnv({}), '/usr/local/bin:/usr/bin:/bin');
});

test('selected immutable release paths stay under central state', () => {
  const root = `/work/.t3-cloud/releases/sha256-${'a'.repeat(64)}`;
  const env = { T3_CLOUD_STATE: '/work/.t3-cloud', T3_RELEASE_ROOT: root };
  assert.equal(runtimePath(env, 'opt/t3/t3'), `${root}/opt/t3/t3`);
  assert.equal(runtimePathEnv(env), `${root}/opt/t3-cloud/bin/release-shims:/usr/bin:/bin`);
  assert.throws(() => runtimePath({ ...env, T3_RELEASE_ROOT: '/tmp/untrusted' }, 'opt/t3/t3'), /Invalid release root/);
  assert.throws(() => runtimePath(env, '../secrets'), /Invalid runtime path/);
});
