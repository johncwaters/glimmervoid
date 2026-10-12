import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { glimmervoidHomeDir } from '../server/config-store.ts';
import { workRole } from '../server/core/sandbox-roles-core.ts';
import { prepareSandboxLaunch } from '../server/sandbox-launch.ts';

async function launchLockedCheckout(checkout: string, launchId: string) {
  const prepared = await prepareSandboxLaunch({ role: workRole({ vendor: 'claude', cwd: checkout, checkout, agentSessionId: null, readablePaths: [] }), launchId });
  assert.ok(prepared.ok, prepared.ok ? '' : prepared.reason);
  return prepared.launch;
}

test('a locked checkout with a project .claude folder gets the runtime deny mount points created for the launch and left in place after', async (context) => {
  const factoryFolder = await mkdtemp(path.join(glimmervoidHomeDir(), 'factory-'));
  context.after(() => rm(factoryFolder, { recursive: true, force: true }));
  const checkout = path.join(factoryFolder, 'repo');
  await mkdir(path.join(checkout, '.claude'), { recursive: true });
  await writeFile(path.join(checkout, '.claude', 'release-profile.json'), '{}\n');
  const bareCheckout = path.join(factoryFolder, 'bare');
  await mkdir(bareCheckout);

  const launch = await launchLockedCheckout(checkout, 'locked-claude-launch');
  await launch.wrap('/bin/true', []);
  assert.deepEqual((await readdir(path.join(checkout, '.claude'))).sort(), ['agents', 'commands', 'release-profile.json']);
  await launch.dispose();
  assert.deepEqual((await readdir(path.join(checkout, '.claude'))).sort(), ['agents', 'commands', 'release-profile.json']);

  const bareLaunch = await launchLockedCheckout(bareCheckout, 'locked-bare-launch');
  await bareLaunch.wrap('/bin/true', []);
  assert.deepEqual(await readdir(bareCheckout), []);
  await bareLaunch.dispose();
});
