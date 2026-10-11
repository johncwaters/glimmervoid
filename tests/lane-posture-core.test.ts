import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildLanePosture, isSafeBranchName, LANE_CREDENTIAL_ENV } from '../server/core/lane-posture-core.ts';
import type { LanePostureSpec } from '../server/core/lane-posture-core.ts';
import { LANE_CONFIG_EDIT_DENY_RULES, LANE_ENVIRONMENT_ARGS } from '../server/core/lane-permissions-core.ts';

const checkout = path.resolve('/work/checkout');
const commonDir = path.resolve('/repo/.git');
const worktreeAdminDir = path.join(commonDir, 'worktrees', 'checkout');
const spec: LanePostureSpec = {
  access: 'own-worktree', writableRoots: [checkout],
  gitCommit: { commonDir, worktreeAdminDir, branch: 'lane/worker' },
  network: { hookEndpoint: { host: '127.0.0.1', port: 4199 }, domains: ['api.example.test', '127.0.0.1:4199'] },
  allowCommands: ['git add', 'git commit', 'npm test'], extraDeny: ['Bash(git push:*)'],
  denyRead: ['~/.ssh', '/private/credentials'], scrubCredentials: true,
};

for (const access of ['read-only', 'own-worktree', 'own-checkout'] as const) {
  test(`${access} keeps tool, git, network and credential boundaries in managed settings`, () => {
    const posture = buildLanePosture({ ...spec, access }, { tempDir: '/tmp', cwd: checkout, gitWorktree: { commonDir, integrationBranch: 'release/main' } });
    assert.equal(posture.settingsPermissions.defaultMode, 'dontAsk');
    assert.deepEqual(posture.settingsPermissions.allow, [
      ...(access === 'read-only' ? [] : [`Edit(/${checkout.replace(/\\/g, '/')}/**)`]),
      'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(npm test:*)',
    ]);
    assert.deepEqual(posture.settingsPermissions.deny, ['Bash(git push:*)', ...LANE_CONFIG_EDIT_DENY_RULES]);
    const workerRef = path.join(commonDir, 'refs', 'heads', 'lane', 'worker');
    assert.deepEqual(posture.settingsSandbox.filesystem.allowWrite, [
      '/tmp', ...(access === 'read-only' ? [] : [checkout]),
      ...(access === 'own-worktree' ? [worktreeAdminDir, path.join(commonDir, 'objects'), workerRef, `${workerRef}.lock`, path.join(commonDir, 'logs', 'refs', 'heads', 'lane', 'worker')] : []),
    ]);
    for (const sharedPath of ['refs', path.join('refs', 'heads'), 'logs', 'packed-refs', 'worktrees']) {
      assert.equal(posture.settingsSandbox.filesystem.allowWrite.includes(path.join(commonDir, sharedPath)), false, sharedPath);
    }
    assert.equal(posture.settingsSandbox.filesystem.allowWrite.includes(commonDir), false);
    const integrationRef = path.join(commonDir, 'refs', 'heads', 'release', 'main');
    assert.deepEqual(posture.settingsSandbox.filesystem.denyWrite, [
      ...['hooks', 'config', 'config.worktree'].map((entry) => path.join(commonDir, entry)),
      ...['commondir', 'gitdir', 'config.worktree'].map((entry) => path.join(worktreeAdminDir, entry)),
      integrationRef, `${integrationRef}.lock`, ...['refs/replace', 'packed-refs', 'packed-refs.lock'].map((entry) => path.join(commonDir, entry)),
      ...(access === 'read-only' ? [checkout] : [path.join(checkout, '.git'), path.join(checkout, '.claude')]),
    ]);
    assert.deepEqual(posture.settingsSandbox.filesystem.denyRead, spec.denyRead);
    assert.deepEqual(posture.settingsSandbox.network, {
      strictAllowlist: true, allowLocalBinding: true, allowAllUnixSockets: false,
      allowedDomains: ['127.0.0.1:4199', 'api.example.test'],
    });
    assert.equal(posture.settingsSandbox.enabled, true);
    assert.equal(posture.settingsSandbox.failIfUnavailable, true);
    assert.equal(posture.settingsSandbox.allowUnsandboxedCommands, false);
    assert.deepEqual(posture.extraClaudeArgs, LANE_ENVIRONMENT_ARGS);
    assert.deepEqual(posture.spawnEnv, LANE_CREDENTIAL_ENV);
    assert.equal(posture.requiresSaneYolo, true);
  });
}

test('a posture without commit access or credential scrubbing grants no git metadata and still allows only its hook endpoint', () => {
  const posture = buildLanePosture({ ...spec, access: 'own-checkout', writableRoots: [checkout, checkout], gitCommit: undefined,
    network: { hookEndpoint: { host: '127.0.0.1', port: 4200 }, domains: [] }, scrubCredentials: false });
  assert.deepEqual(posture.settingsSandbox.filesystem.allowWrite, [checkout]);
  assert.deepEqual(posture.settingsSandbox.filesystem.denyWrite, [path.join(checkout, '.git'), path.join(checkout, '.claude')]);
  assert.deepEqual(posture.settingsSandbox.network.allowedDomains, ['127.0.0.1:4200']);
  assert.deepEqual(posture.spawnEnv, {});
});

test('safe branch names accept nested lane branches and reject path escapes and lock names', () => {
  for (const branch of ['main', 'release/main', 'glimmervoid/session/lane-work-1']) assert.equal(isSafeBranchName(branch), true, branch);
  for (const branch of ['', '../main', 'a/../b', 'a//b', '/main', 'main/', '.hidden', 'main.lock', 'main.', 'a b', 'a\\b']) {
    assert.equal(isSafeBranchName(branch), false, branch);
  }
});

test('a posture before its worktree is known writes only temp and still denies common git hooks and config', () => {
  const posture = buildLanePosture({ ...spec, writableRoots: [], gitCommit: undefined },
    { tempDir: '/tmp', gitWorktree: { commonDir, integrationBranch: 'release/main' } });
  assert.deepEqual(posture.settingsSandbox.filesystem.allowWrite, ['/tmp']);
  const integrationRef = path.join(commonDir, 'refs', 'heads', 'release', 'main');
  assert.deepEqual(posture.settingsSandbox.filesystem.denyWrite, [
    ...['hooks', 'config', 'config.worktree'].map((entry) => path.join(commonDir, entry)),
    integrationRef, `${integrationRef}.lock`, ...['refs/replace', 'packed-refs', 'packed-refs.lock'].map((entry) => path.join(commonDir, entry)),
  ]);
});
