import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGitWorkspace, runHardenedGit } from '../server/git-workspace.ts';
import { resolveLanePosture } from '../server/lane-posture.ts';
import type { LanePostureInput } from '../server/lane-posture.ts';

const input: LanePostureInput = {
  access: 'own-worktree', cwd: '/missing', writableRoots: [],
  network: { domains: [] }, getHookPort: () => 3911, allowCommands: ['npm test'],
  extraDeny: [], denyRead: [], scrubCredentials: true,
};

for (const hookTools of [null, []]) {
  test(`missing Sane YOLO refuses before resolving filesystem paths with ${JSON.stringify(hookTools)}`, async () => {
    assert.deepEqual(await resolveLanePosture(input, { resolveSaneYoloHookTools: () => hookTools }),
      { ok: false, reason: 'Sane YOLO is unavailable' });
  });
}

test('the shell canonicalizes linked paths and denies the whole shared git folder to every lane inside a repository', async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lane-posture-shell-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  await mkdir(repository);
  const git = (args: string[]) => runHardenedGit(args, { cwd: repository, timeout: 30_000 });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'lane@example.test']);
  await git(['config', 'user.name', 'Lane test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(repository, 'initial.txt'), 'initial\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
  const workspace = await createGitWorkspace().create({ projectPath: repository, teamId: 'lane', label: 'worker', baseBranch: 'main',
    configuredIntegrationBranch: 'main', worktreeBase: root, shareList: [] });
  assert.equal(workspace.isGit, true);
  const alias = path.join(root, 'alias');
  await symlink(workspace.cwd, alias, 'junction');
  const tools = { resolveSaneYoloHookTools: () => [{ id: 'saneYolo' as const, binPath: '/cc-safety-net' }] };
  const worker = await resolveLanePosture({ ...input, cwd: alias, writableRoots: [alias] }, tools);
  assert.equal(worker.ok, true);
  if (!worker.ok) return;
  assert.equal(worker.sessionOverrides.settingsPermissions.allow[0], `Edit(/${workspace.cwd}/**)`);
  const commonDir = path.join(repository, '.git');
  assert.deepEqual(worker.sessionOverrides.settingsSandbox.filesystem.allowWrite, [await realpath(os.tmpdir()), workspace.cwd]);
  assert.deepEqual(worker.sessionOverrides.settingsSandbox.filesystem.denyWrite, [commonDir, path.join(workspace.cwd, '.git'), path.join(workspace.cwd, '.claude')]);
  const nestedDirectory = path.join(workspace.cwd, 'nested');
  await mkdir(nestedDirectory);
  const reviewer = await resolveLanePosture({ ...input, access: 'read-only', cwd: nestedDirectory }, tools);
  assert.equal(reviewer.ok, true);
  if (!reviewer.ok) return;
  assert.deepEqual(reviewer.sessionOverrides.settingsSandbox.filesystem.denyWrite, [commonDir, nestedDirectory]);
  assert.equal(reviewer.sessionOverrides.settingsPermissions.allow.some((rule) => rule.startsWith('Edit(')), false);
  const deferred = await resolveLanePosture({ ...input, cwd: repository, deferWorktree: true }, tools);
  assert.equal(deferred.ok, true);
  if (!deferred.ok) return;
  const originalPermissions = deferred.sessionOverrides.settingsPermissions;
  const originalSandbox = deferred.sessionOverrides.settingsSandbox;
  deferred.scopeWorktree({ worktreeDir: alias, branch: workspace.branch ?? null, base: 'main' });
  assert.equal(deferred.sessionOverrides.settingsPermissions, originalPermissions);
  assert.equal(deferred.sessionOverrides.settingsSandbox, originalSandbox);
  assert.deepEqual(originalPermissions, worker.sessionOverrides.settingsPermissions);
  assert.deepEqual(originalSandbox, worker.sessionOverrides.settingsSandbox);
  assert.throws(() => deferred.scopeWorktree({ worktreeDir: alias, branch: 'main', base: 'main' }), /integration branch/);
});
