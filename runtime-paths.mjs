import { isAbsolute, join, relative } from 'node:path';

export function runtimePath(env, path) {
  if (typeof path !== 'string' || !/^[a-z0-9][a-z0-9./-]*$/.test(path) || path.split('/').includes('..'))
    throw Error('Invalid runtime path');
  const root = env.T3_RELEASE_ROOT ?? '/';
  const state = env.T3_CLOUD_STATE;
  if (!isAbsolute(root) || root !== '/' && (!isAbsolute(state) ||
      !/^releases\/sha256-[a-f0-9]{64}$/.test(relative(state, root))))
    throw Error('Invalid release root');
  return join(root, path);
}

export function runtimePathEnv(env) {
  if (!env.T3_RELEASE_ROOT) return env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const bin = runtimePath(env, 'opt/t3-cloud/bin/release-shims');
  return `${bin}:/usr/bin:/bin`;
}
