// Offline image smoke: actual pinned Codex initialization, no sign-in or turns.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { managedSkillPredecessor } from '../runtime-supervisor.mjs';

export async function checkManagedSkillUpgrade({ application = '/opt/t3-cloud', binary = '/opt/codex/bin/codex' } = {}) {
  const directory = await realpath(await mkdtemp('/tmp/t3-skill-upgrade-'));
  try {
    const state = join(directory, 'state'), home = join(state, 'codex');
    await mkdir(join(state, 'updates'), { recursive: true });
    const baseImage = `sha256:${'c'.repeat(64)}`;
    const manifest = { baseImage, files: [{ path: 'opt/t3-cloud/skills/briq', type: 'directory' },
      { path: 'opt/t3-cloud/skills/briq/SKILL.md', type: 'file' }] };
    const identities = [`sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`, `sha256:${'b'.repeat(64)}`];
    const roots = [application, ...identities.map(id => join(state, 'releases', id.replace(':', '-'), 'opt/t3-cloud'))];
    for (const root of roots.slice(1)) await cp(application, root, { recursive: true });
    await writeFile(join(state, 'releases', identities[0].replace(':', '-'), '.release-manifest.json'), JSON.stringify(manifest), { mode: 0o400 });
    let previousSkillSource;
    let config;
    for (let index = 0; index < roots.length; index++) {
      if (index === 1) {
        // This is the journal/environment contract emitted by the original loader.
        await writeFile(join(state, 'updates/activation.json'), JSON.stringify({ protocol: 1, current: 'bootstrap',
          desired: identities[0], staged: identities[0], phase: 'starting', receipt: { from: 'bootstrap', to: identities[0], status: 'pending' } }), { mode: 0o600 });
        previousSkillSource = await managedSkillPredecessor({ state, selected: identities[0], baseImage });
        assert.equal(previousSkillSource, join(application, 'skills/briq'));
      } else if (index === 2) {
        await writeFile(join(state, 'updates/activation.json'), JSON.stringify({ protocol: 1, current: identities[0],
          desired: identities[1], staged: identities[1], phase: 'starting', receipt: { from: identities[0], to: identities[1], status: 'pending' } }));
        previousSkillSource = await managedSkillPredecessor({ state, selected: identities[1], baseImage });
        assert.equal(previousSkillSource, join(roots[1], 'skills/briq'));
      }
      const { startAppServer } = await import(pathToFileURL(join(roots[index], 'broker.mjs')));
      const app = await startAppServer({ binary, home, previousSkillSource });
      try { assert.equal(app.version, '0.166.0'); assert.ok(app.initialized); }
      finally { await app.close(); }
      assert.equal(await readlink(join(home, '.agents/skills/briq')), join(roots[index], 'skills/briq'));
      const content = await readFile(join(home, 'config.toml'), 'utf8');
      if (config !== undefined) assert.equal(content, config);
      config = content;
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await checkManagedSkillUpgrade();
