import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { FilesystemConfigSchema, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';
import { buildGuardrailsLaunchPlan, guardrailsPolicyProbePaths, standardWriteBlockCandidates } from '../server/guardrails/core/guardrails-policy-core.ts';
import type { GuardrailsNetworkAccess } from '../server/guardrails/core/guardrails-policy-core.ts';
import { isSessionGuarded, sessionRole } from '../server/guardrails/core/guardrails-roles-core.ts';
import { homeDir, glimmervoidHome, tempDir, launchHomeDir, agentSessionId, worktree, hostPaths, roleWith, hostWhereEveryProbedPathExists, planFor, entryPaths } from './helpers/guardrails-host.ts';

const networkByName: Record<string, GuardrailsNetworkAccess> = {
  none: { access: 'none' },
  allowlist: { access: 'allowlist', domains: ['api.github.com'], hookPort: 4199 },
  open: { access: 'open' },
};

test('roles with a network policy produce a settings file the pinned sandbox runtime accepts', () => {
  for (const network of [networkByName.none, networkByName.allowlist]) {
    const { launcher, policy } = planFor(roleWith({ network, vendors: ['claude', 'codex'], lockedCheckouts: [worktree] }));
    assert.equal(launcher, 'runtime-cli');
    const parsed = SandboxRuntimeConfigSchema.safeParse(policy);
    assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
  }
});

test('an ordinary Claude session is guarded unless it or a folder above it is marked unguarded, and is blocked only from credentials and Glimmervoid state', () => {
  const claudeSession = { usageVendor: 'claude', isMarkedUnguarded: false, sessionFolders: [path.resolve('/work/repo')], unguardedRepos: [] };
  assert.equal(isSessionGuarded(claudeSession), true);
  assert.equal(isSessionGuarded({ ...claudeSession, isMarkedUnguarded: true }), false);
  assert.equal(isSessionGuarded({ ...claudeSession, unguardedRepos: [path.resolve('/work')] }), false);
  assert.equal(isSessionGuarded({ ...claudeSession, unguardedRepos: [path.resolve('/work/other')] }), true);
  assert.equal(isSessionGuarded({ ...claudeSession, usageVendor: 'codex' }), false);
  assert.equal(isSessionGuarded({ ...claudeSession, usageVendor: null }), false);

  const hookScratch = path.join(glimmervoidHome, 'scratch', 'glimmervoid-hooks', 'session-one');
  const githubLogin = path.join(homeDir, '.config', 'gh');
  const listedSecret = path.resolve('/work/secrets');
  const listedBlocked = path.resolve('/work/protected');
  const role = sessionRole({ writableRoots: [hookScratch], readDenied: [listedSecret], readablePaths: [githubLogin], blockedPaths: [listedBlocked] });
  const blocked = standardWriteBlockCandidates(role, hostPaths);
  assert.equal(blocked.includes(listedBlocked), true);
  for (const blockedPath of ['.ssh', '.config/gh', '.config/coderv2', '.aws', '.git-credentials', '.glimmervoid/config.json', '.glimmervoid/bin', '.glimmervoid/guardrails-policies']) {
    assert.equal(blocked.includes(path.join(homeDir, blockedPath)), true, blockedPath);
  }
  for (const writablePath of ['.claude', '.claude/hooks', '.zshrc', '.gitconfig', 'Library/Keychains', '.glimmervoid/guardrails-temp', '.glimmervoid/scratch']) {
    assert.equal(blocked.includes(path.join(homeDir, writablePath)), false, writablePath);
  }
  const linkedTarget = path.resolve('/dotfiles/ssh');
  const { policy } = planFor(role, { ...hostWhereEveryProbedPathExists(role), writeBlockedPaths: [...blocked, linkedTarget] });
  const { network, filesystem } = policy;
  assert.equal(FilesystemConfigSchema.safeParse(filesystem).success, true);
  assert.equal('allowedDomains' in network, false);
  assert.deepEqual(entryPaths(filesystem.allowWrite).slice(0, 2), ['/', tempDir]);
  assert.deepEqual(entryPaths(filesystem.denyWrite), [...blocked, linkedTarget]);
  assert.equal(entryPaths(filesystem.denyRead).includes(listedSecret), true);
  assert.equal(entryPaths(filesystem.denyRead).includes(path.join(homeDir, '.ssh')), true);
  assert.equal(entryPaths(filesystem.allowRead).includes(githubLogin), true);
  assert.equal(entryPaths(filesystem.denyRead).includes(path.join(homeDir, '.codex')), false);
  assert.equal(entryPaths(filesystem.denyRead).includes(path.join(homeDir, 'Library/Keychains')), false);
  assert.deepEqual(network, { allowAllUnixSockets: true, allowMachLookup: ['*'] });
  assert.equal(policy.terminalScope, 'any');
  assert.equal(policy.allowAppleEvents, true);
  assert.equal(policy.allowMachRegister, true);
  const strictPolicy = planFor(roleWith({ network: networkByName.open })).policy;
  assert.deepEqual(strictPolicy.network, { allowAllUnixSockets: false });
  assert.equal(strictPolicy.terminalScope, 'own');
  assert.equal(strictPolicy.allowAppleEvents, false);
  assert.equal(strictPolicy.allowMachRegister, false);
  assert.equal(entryPaths(strictPolicy.filesystem.denyRead).includes(path.join(homeDir, 'Library/Keychains')), true);
});

test('vendor homes: a lane writes only its own transcript folder, session env folder and login, a session writes state but not config, other vendors stay unreadable', () => {
  const lanePolicy = planFor(roleWith()).policy.filesystem;
  assert.deepEqual(entryPaths(lanePolicy.allowWrite).filter((writable) => writable.startsWith(path.join(homeDir, '.claude'))), [
    path.join(homeDir, '.claude', 'projects', '-work-worktree'), path.join(homeDir, '.claude', 'session-env', agentSessionId), path.join(homeDir, '.claude', '.credentials.json'),
  ]);
  const shellSnapshotFolder = path.join(homeDir, '.claude', 'shell-snapshots');
  assert.equal(entryPaths(lanePolicy.denyRead).includes(shellSnapshotFolder), true);
  assert.equal(planFor(roleWith()).requiredDirectories.includes(shellSnapshotFolder), true);
  assert.equal(entryPaths(planFor(roleWith({ vendorHome: { scope: 'state' } })).policy.filesystem.denyRead).includes(shellSnapshotFolder), false);
  assert.equal(buildGuardrailsLaunchPlan(roleWith({ vendorHome: { scope: 'launch', cwd: worktree, agentSessionId: '../escape' } }), { ...hostPaths, existingPaths: new Set() }).ok, false);
  const codexLanePlan = planFor(roleWith({ vendors: ['codex'] }));
  const codexLaunchHome = path.join(launchHomeDir, 'codex');
  const codexHome = path.join(homeDir, '.codex');
  assert.deepEqual(entryPaths(codexLanePlan.policy.filesystem.allowWrite).filter((writable) => writable.startsWith(codexHome) || writable.startsWith(launchHomeDir)), [
    codexLaunchHome, path.join(codexHome, 'auth.json'),
  ]);
  assert.equal(codexLanePlan.launchEnv.CODEX_HOME, codexLaunchHome);
  assert.equal(codexLanePlan.requiredDirectories.includes(codexLaunchHome), true);
  assert.deepEqual(codexLanePlan.launchHomeLinks.filter((link) => link.isLogin), [{ linkPath: path.join(codexLaunchHome, 'auth.json'), targetPath: path.join(codexHome, 'auth.json'), isLogin: true }]);
  assert.equal(codexLanePlan.launchHomeLinks.some((link) => link.targetPath === path.join(codexHome, 'config.toml') && !link.isLogin), true);
  assert.deepEqual(planFor(roleWith({ vendors: ['codex'] }), { ...hostPaths, existingPaths: new Set() }).launchHomeLinks, []);
  const laneDenied = entryPaths(lanePolicy.denyRead);
  for (const unreadable of ['.codex', '.grok', '.ssh', '.config/gh', '.config/coderv2', 'Library/Application Support/coderv2', '.git-credentials', '.aws', '.npmrc', '.glimmervoid']) {
    assert.equal(laneDenied.includes(path.join(homeDir, unreadable)), true, unreadable);
  }
  assert.equal(laneDenied.includes(path.join(homeDir, '.claude')), false);
  assert.equal(laneDenied.includes(path.join(homeDir, '.codex.old')), true);
  assert.equal(laneDenied.includes(path.join(homeDir, '.claude.json.backup')), false);
  const sessionPolicy = planFor(roleWith({ vendorHome: { scope: 'state' } })).policy.filesystem;
  assert.equal(entryPaths(sessionPolicy.allowWrite).includes(path.join(homeDir, '.claude')), true);
  for (const config of ['settings.json', 'hooks', 'skills', 'plugins', 'commands', 'agents', 'CLAUDE.md']) {
    assert.equal(entryPaths(sessionPolicy.denyWrite).includes(path.join(homeDir, '.claude', config)), true, config);
  }
  const checkDenied = entryPaths(planFor(roleWith({ vendors: [] })).policy.filesystem.denyRead);
  for (const unreadable of ['.claude.json', '.claude.json.backup']) {
    assert.equal(checkDenied.includes(path.join(homeDir, unreadable)), true, unreadable);
  }
  assert.equal(checkDenied.includes(path.join(homeDir, 'Projects')), false);
});

test('a relocated vendor home is unreadable to other roles and holds its own role state, and relocated gh, coderv2 and gcloud folders are unreadable', () => {
  const claudeHome = path.resolve('/srv/claude-home');
  const codexHome = path.resolve('/srv/codex-home');
  const xdgConfigHome = path.resolve('/srv/xdg');
  const grokHome = path.resolve('/srv/grok-home');
  const relocatedPaths = {
    ...hostPaths,
    vendorLocations: {
      claude: { stateFolder: claudeHome, configFiles: [path.join(claudeHome, '.claude.json')], otherHomes: [path.join(xdgConfigHome, 'claude')] },
      codex: { stateFolder: codexHome, configFiles: [], otherHomes: [] },
    },
    unwrappedVendorHomes: [grokHome],
    relocatedXdgConfigHome: xdgConfigHome,
  };
  const role = roleWith({ vendorHome: { scope: 'state' } });
  const plan = planFor(role, { ...relocatedPaths, existingPaths: new Set(guardrailsPolicyProbePaths(role, relocatedPaths)) });
  const { denyRead, allowWrite, denyWrite } = plan.policy.filesystem;
  for (const unreadable of [codexHome, path.join(homeDir, '.codex'), path.join(xdgConfigHome, 'gh'), path.join(xdgConfigHome, 'coderv2'), path.join(xdgConfigHome, 'gcloud'), path.join(homeDir, '.config', 'gh')]) {
    assert.equal(entryPaths(denyRead).includes(unreadable), true, unreadable);
  }
  assert.equal(entryPaths(allowWrite).includes(claudeHome), true);
  assert.equal(entryPaths(allowWrite).includes(path.join(homeDir, '.claude')), false);
  for (const unwritable of ['settings.json', '.claude.json']) {
    assert.equal(entryPaths(denyWrite).includes(path.join(claudeHome, unwritable)), true, unwritable);
  }
  assert.equal(plan.requiredDirectories.includes(claudeHome), true);
  const checkRole = roleWith({ vendors: [] });
  const checkDenied = entryPaths(planFor(checkRole, { ...relocatedPaths, existingPaths: new Set() }).policy.filesystem.denyRead);
  for (const unreadable of [claudeHome, path.join(xdgConfigHome, 'claude'), path.join(homeDir, '.claude'), grokHome]) {
    assert.equal(checkDenied.includes(unreadable), true, unreadable);
  }
  const relativeRelocation = { ...relocatedPaths, relocatedXdgConfigHome: 'relative-config' };
  assert.equal(buildGuardrailsLaunchPlan(checkRole, { ...relativeRelocation, existingPaths: new Set() }).ok, false);
  const stateFolderOverHome = { ...relocatedPaths, vendorLocations: { ...relocatedPaths.vendorLocations, claude: { stateFolder: homeDir, configFiles: [], otherHomes: [] } } };
  assert.equal(buildGuardrailsLaunchPlan(role, { ...stateFolderOverHome, existingPaths: new Set() }).ok, false);
});
