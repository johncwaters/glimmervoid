import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildLanePosture } from '../server/core/lane-posture-core.ts';
import { LANE_CREDENTIAL_ENV } from '../server/core/sandbox-roles-core.ts';
import type { LanePostureSpec } from '../server/core/lane-posture-core.ts';
import { LANE_CONFIG_EDIT_DENY_RULES, LANE_ENVIRONMENT_ARGS } from '../server/core/lane-permissions-core.ts';

const checkout = path.resolve('/work/checkout');
const commonGitDir = path.resolve('/repo/.git');
const spec: LanePostureSpec = {
  access: 'own-worktree', writableRoots: [checkout],
  network: { hookEndpoint: { host: '127.0.0.1', port: 4199 }, domains: ['api.example.test', '127.0.0.1:4199'] },
  allowCommands: ['npm test'], extraDeny: ['Bash(git push:*)'],
  denyRead: ['~/.ssh', '/private/credentials'], scrubCredentials: true,
};

for (const access of ['read-only', 'own-worktree', 'own-checkout'] as const) {
  test(`${access} keeps tool, git, network and credential boundaries in managed settings`, () => {
    const posture = buildLanePosture({ ...spec, access }, { tempDir: '/tmp', cwd: checkout, commonGitDir });
    assert.equal(posture.settingsPermissions.defaultMode, 'dontAsk');
    assert.deepEqual(posture.settingsPermissions.allow, [
      ...(access === 'read-only' ? [] : [`Edit(/${checkout.replace(/\\/g, '/')}/**)`]),
      'Bash(npm test:*)',
    ]);
    assert.deepEqual(posture.settingsPermissions.deny, ['Bash(git push:*)', ...LANE_CONFIG_EDIT_DENY_RULES]);
    assert.deepEqual(posture.settingsSandbox.filesystem.allowWrite, ['/tmp', ...(access === 'read-only' ? [] : [checkout])]);
    assert.deepEqual(posture.settingsSandbox.filesystem.denyWrite, [
      commonGitDir, ...(access === 'read-only' ? [checkout] : [path.join(checkout, '.git'), path.join(checkout, '.claude')]),
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

test('a posture outside a repository or without credential scrubbing still allows only its hook endpoint', () => {
  const posture = buildLanePosture({ ...spec, access: 'own-checkout', writableRoots: [checkout, checkout],
    network: { hookEndpoint: { host: '127.0.0.1', port: 4200 }, domains: [] }, scrubCredentials: false });
  assert.deepEqual(posture.settingsSandbox.filesystem.allowWrite, [checkout]);
  assert.deepEqual(posture.settingsSandbox.filesystem.denyWrite, [path.join(checkout, '.git'), path.join(checkout, '.claude')]);
  assert.deepEqual(posture.settingsSandbox.network.allowedDomains, ['127.0.0.1:4200']);
  assert.deepEqual(posture.spawnEnv, {});
});

test('a posture before its worktree is known writes only temp and denies the whole shared git folder', () => {
  const posture = buildLanePosture({ ...spec, writableRoots: [] }, { tempDir: '/tmp', commonGitDir });
  assert.deepEqual(posture.settingsSandbox.filesystem.allowWrite, ['/tmp']);
  assert.deepEqual(posture.settingsSandbox.filesystem.denyWrite, [commonGitDir]);
});
