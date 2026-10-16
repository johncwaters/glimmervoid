import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { FilesystemConfigSchema, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';
import { buildGuardrailsLaunchPlan, guardrailsPolicyProbePaths, standardWriteBlockCandidates } from '../server/guardrails/core/guardrails-policy-core.ts';
import type { GuardrailsHost, GuardrailsLaunchPlan, GuardrailsNetworkAccess, GuardrailsRole } from '../server/guardrails/core/guardrails-policy-core.ts';
import { isSessionGuarded, sessionRole } from '../server/guardrails/core/guardrails-roles-core.ts';
import { HOOK_VIA_GUARDRAILS_PROXY_ENV } from '../session/core/guardrails-proxy-core.ts';

const homeDir = path.resolve('/home/operator');
const glimmervoidHome = path.join(homeDir, '.glimmervoid');
const tempDir = path.join(glimmervoidHome, 'guardrails-temp', 'session-one');
const launchHomeDir = path.join(glimmervoidHome, 'guardrails-homes', 'session-one');
const agentSessionId = 'agent-session-one';
const worktree = path.resolve('/work/worktree');
const commonGitDir = path.resolve('/work/repo/.git');
const hostPaths = {
  homeDir,
  glimmervoidHome,
  glimmervoidConfigFile: path.join(glimmervoidHome, 'config.json'),
  tempDir,
  launchHomeDir,
  homeEntryNames: ['.claude', '.claude.json', '.claude.json.backup', '.codex', '.codex.old', 'Projects'],
  glimmervoidHomeEntryNames: ['config.json', 'guardrails-policies', 'guardrails-temp', 'scratch'],
  writeBlockedPaths: [] as string[],
  vendorLocations: {
    claude: { stateFolder: path.join(homeDir, '.claude'), configFiles: [path.join(homeDir, '.claude.json')], otherHomes: [path.join(homeDir, '.config', 'claude')] },
    codex: { stateFolder: path.join(homeDir, '.codex'), configFiles: [], otherHomes: [] },
  },
  unwrappedVendorHomes: [path.join(homeDir, '.grok')],
  relocatedXdgConfigHome: null,
};

const networkByName: Record<string, GuardrailsNetworkAccess> = {
  none: { access: 'none' },
  allowlist: { access: 'allowlist', domains: ['api.github.com'], hookPort: 4199 },
  open: { access: 'open' },
};

function roleWith(overrides: Partial<GuardrailsRole> = {}): GuardrailsRole {
  return {
    vendors: ['claude'], vendorHome: { scope: 'launch', cwd: worktree, agentSessionId }, network: { access: 'allowlist', domains: [], hookPort: 4199 },
    writableRoots: [], lockedCheckouts: [], commitCheckouts: [], readDenied: [], readableWithinDenied: [], ...overrides,
  };
}

function hostWhereEveryProbedPathExists(role: GuardrailsRole): GuardrailsHost {
  return { ...hostPaths, existingPaths: new Set(guardrailsPolicyProbePaths(role, hostPaths)) };
}

function planFor(role: GuardrailsRole, host: GuardrailsHost = hostWhereEveryProbedPathExists(role)): GuardrailsLaunchPlan {
  const built = buildGuardrailsLaunchPlan(role, host);
  if (!built.ok) throw new Error(built.reason);
  return built.plan;
}

function entryPaths(entries: readonly (string | { path: string })[] | undefined): string[] {
  return (entries ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.path));
}

for (const [networkName, network] of Object.entries(networkByName)) {
  test(`${networkName} network role never allows unix sockets and names every path literally`, () => {
    const { policy } = planFor(roleWith({ network, lockedCheckouts: [worktree] }));
    assert.equal(policy.network.allowAllUnixSockets, false);
    const { denyRead, allowRead, allowWrite, denyWrite } = policy.filesystem;
    for (const entry of [...denyRead, ...(allowRead ?? []), ...allowWrite, ...denyWrite]) {
      assert.equal(typeof entry === 'object' && entry.literal, true);
    }
  });
}

test('roles with a network policy produce a settings file the pinned sandbox runtime accepts', () => {
  for (const network of [networkByName.none, networkByName.allowlist]) {
    const { launcher, policy } = planFor(roleWith({ network, vendors: ['claude', 'codex'], lockedCheckouts: [worktree] }));
    assert.equal(launcher, 'runtime-cli');
    const parsed = SandboxRuntimeConfigSchema.safeParse(policy);
    assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
  }
});

test('an allowlist role reaches one loopback port and the vendor API, and sends 127.0.0.1 through the proxy', () => {
  const { policy, guardedEnv } = planFor(roleWith({ network: networkByName.allowlist }));
  assert.deepEqual('allowedDomains' in policy.network && policy.network.allowedDomains, ['127.0.0.1:4199', 'api.anthropic.com', 'platform.claude.com', 'api.github.com']);
  assert.equal('strictAllowlist' in policy.network && policy.network.strictAllowlist, true);
  assert.equal('allowLocalBinding' in policy.network && policy.network.allowLocalBinding, false);
  assert.equal(guardedEnv.NO_PROXY?.split(',').includes('127.0.0.1'), false);
  assert.equal(guardedEnv.no_proxy, guardedEnv.NO_PROXY);
  assert.equal(guardedEnv[HOOK_VIA_GUARDRAILS_PROXY_ENV], '1');
});

test('an open network role carries no domain list, and a check role carries an empty one with no local binding', () => {
  const openPlan = planFor(roleWith({ network: networkByName.open }));
  assert.equal(openPlan.launcher, 'open-network');
  assert.equal('allowedDomains' in openPlan.policy.network, false);
  assert.deepEqual(openPlan.guardedEnv, { TMPDIR: tempDir });
  const checkPlan = planFor(roleWith({ network: networkByName.none, vendors: [] }));
  assert.deepEqual(checkPlan.policy.network, { allowedDomains: [], deniedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false });
});

test('a lane checkout is writable while its git pointer, its agent folder and the common git dir are not', () => {
  const { filesystem } = planFor(roleWith({ lockedCheckouts: [worktree] })).policy;
  const writable = entryPaths(filesystem.allowWrite);
  assert.equal(writable.includes(worktree), true);
  assert.equal(writable.includes(commonGitDir), false);
  assert.deepEqual(entryPaths(filesystem.denyWrite).filter((denied) => denied.startsWith(worktree)), [path.join(worktree, '.git'), path.join(worktree, '.claude')]);
});

test('a commit checkout may write its git dir except hooks, config and the worktree pointer', () => {
  const { filesystem } = planFor(roleWith({ commitCheckouts: [{ checkout: worktree, gitDir: commonGitDir }] })).policy;
  assert.equal(entryPaths(filesystem.allowWrite).includes(commonGitDir), true);
  const denied = entryPaths(filesystem.denyWrite);
  for (const protectedPath of [path.join(worktree, '.git'), path.join(commonGitDir, 'hooks'), path.join(commonGitDir, 'config')]) {
    assert.equal(denied.includes(protectedPath), true, protectedPath);
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
  for (const blockedPath of ['.ssh', '.config/gh', '.aws', '.git-credentials', '.glimmervoid/config.json', '.glimmervoid/bin', '.glimmervoid/guardrails-policies']) {
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
  const strictPolicy = planFor(roleWith({ network: networkByName.open })).policy;
  assert.deepEqual(strictPolicy.network, { allowAllUnixSockets: false });
  assert.equal(strictPolicy.terminalScope, 'own');
  assert.equal(strictPolicy.allowAppleEvents, false);
  assert.equal(entryPaths(strictPolicy.filesystem.denyRead).includes(path.join(homeDir, 'Library/Keychains')), true);
});

test('every config sibling file the server names is write-blocked for a session beside the config file, wherever the config lives', async () => {
  const serverFolder = path.join(import.meta.dirname, '..', 'server');
  const serverFiles = (await readdir(serverFolder, { recursive: true })).filter((file) => file.endsWith('.ts'));
  const sources = await Promise.all(serverFiles.map((file) => readFile(path.join(serverFolder, file), 'utf8')));
  const siblingNames = sources.flatMap((source) => [...source.matchAll(/configSiblingPath\([^,()]*,\s*'([^']+)'\)/g)].map((match) => match[1]));
  assert.ok(siblingNames.includes('pairings.json'));
  const role = sessionRole({ writableRoots: [], readDenied: [], readablePaths: [], blockedPaths: [] });
  for (const configFolder of [glimmervoidHome, path.resolve('/etc/glimmervoid')]) {
    const glimmervoidConfigFile = path.join(configFolder, 'settings.json');
    const blocked = standardWriteBlockCandidates(role, { ...hostPaths, glimmervoidConfigFile, glimmervoidHomeEntryNames: [] });
    for (const blockedPath of [glimmervoidConfigFile, ...siblingNames.map((name) => path.join(configFolder, name))]) assert.equal(blocked.includes(blockedPath), true, blockedPath);
  }
});

test('an absent path is never write-denied and an absent login file is never made writable', () => {
  const role = roleWith({ vendors: ['claude', 'codex'], vendorHome: { scope: 'state' }, commitCheckouts: [{ checkout: worktree, gitDir: commonGitDir }] });
  const { filesystem } = planFor(role, { ...hostPaths, existingPaths: new Set() }).policy;
  assert.deepEqual(entryPaths(filesystem.denyWrite), []);
  assert.equal(entryPaths(filesystem.allowWrite).includes(path.join(homeDir, '.claude', '.credentials.json')), false);
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
  for (const unreadable of ['.codex', '.grok', '.ssh', '.config/gh', '.git-credentials', '.aws', '.npmrc', '.glimmervoid']) {
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

test('a relocated vendor home is unreadable to other roles and holds its own role state, and relocated gh and gcloud folders are unreadable', () => {
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
  for (const unreadable of [codexHome, path.join(homeDir, '.codex'), path.join(xdgConfigHome, 'gh'), path.join(xdgConfigHome, 'gcloud'), path.join(homeDir, '.config', 'gh')]) {
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

test('a writable path inside a read-denied region is re-allowed by its exact path, and an ancestor re-allow is refused', () => {
  const laneFolder = path.join(glimmervoidHome, 'lanes', 'one');
  const { filesystem } = planFor(roleWith({ writableRoots: [laneFolder] })).policy;
  assert.deepEqual(entryPaths(filesystem.allowRead), [tempDir, laneFolder]);
  const role = roleWith({ writableRoots: [laneFolder], readableWithinDenied: [path.join(glimmervoidHome, 'lanes')] });
  const refused = buildGuardrailsLaunchPlan(role, hostWhereEveryProbedPathExists(role));
  assert.equal(refused.ok, false);
});

test('a writable root that contains the home folder or the Glimmervoid home is refused', () => {
  for (const root of [homeDir, path.dirname(homeDir), glimmervoidHome]) {
    const role = roleWith({ writableRoots: [root] });
    assert.equal(buildGuardrailsLaunchPlan(role, hostWhereEveryProbedPathExists(role)).ok, false, root);
  }
});

test('each session gets its own temp folder and the shared one is write-denied', () => {
  const plan = planFor(roleWith());
  assert.equal(plan.launchEnv.CLAUDE_CODE_TMPDIR, tempDir);
  assert.equal(plan.requiredDirectories.includes(tempDir), true);
  assert.equal(entryPaths(plan.policy.filesystem.allowWrite).includes(tempDir), true);
  assert.equal(entryPaths(plan.policy.filesystem.denyWrite).includes('/tmp/claude'), true);
});
