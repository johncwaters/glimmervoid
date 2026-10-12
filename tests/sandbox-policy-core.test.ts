import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';
import { buildSandboxLaunchPlan, sandboxPolicyProbePaths } from '../server/core/sandbox-policy-core.ts';
import type { SandboxHost, SandboxLaunchPlan, SandboxNetworkAccess, SandboxRole } from '../server/core/sandbox-policy-core.ts';
import { HOOK_VIA_SANDBOX_PROXY_ENV } from '../session/core/sandbox-proxy-core.ts';

const homeDir = path.resolve('/home/operator');
const glimmervoidHome = path.join(homeDir, '.glimmervoid');
const tempDir = path.join(glimmervoidHome, 'sandbox-temp', 'session-one');
const launchHomeDir = path.join(glimmervoidHome, 'sandbox-homes', 'session-one');
const agentSessionId = 'agent-session-one';
const worktree = path.resolve('/work/worktree');
const commonGitDir = path.resolve('/work/repo/.git');
const hostPaths = {
  homeDir,
  glimmervoidHome,
  tempDir,
  launchHomeDir,
  homeEntryNames: ['.claude', '.claude.json', '.claude.json.backup', '.codex', '.codex.old', 'Projects'],
  vendorLocations: {
    claude: { stateFolder: path.join(homeDir, '.claude'), configFiles: [path.join(homeDir, '.claude.json')], otherHomes: [path.join(homeDir, '.config', 'claude')] },
    codex: { stateFolder: path.join(homeDir, '.codex'), configFiles: [], otherHomes: [] },
  },
  unwrappedVendorHomes: [path.join(homeDir, '.grok')],
  relocatedXdgConfigHome: null,
};

const networkByName: Record<string, SandboxNetworkAccess> = {
  none: { access: 'none' },
  allowlist: { access: 'allowlist', domains: ['api.github.com'], hookPort: 4199 },
  open: { access: 'open' },
};

function roleWith(overrides: Partial<SandboxRole> = {}): SandboxRole {
  return {
    vendors: ['claude'], vendorHome: { scope: 'launch', cwd: worktree, agentSessionId }, network: { access: 'allowlist', domains: [], hookPort: 4199 },
    writableRoots: [], lockedCheckouts: [], commitCheckouts: [], readDenied: [], readableWithinDenied: [], ...overrides,
  };
}

function hostWhereEveryProbedPathExists(role: SandboxRole): SandboxHost {
  return { ...hostPaths, existingPaths: new Set(sandboxPolicyProbePaths(role, hostPaths)) };
}

function planFor(role: SandboxRole, host: SandboxHost = hostWhereEveryProbedPathExists(role)): SandboxLaunchPlan {
  const built = buildSandboxLaunchPlan(role, host);
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
  const { policy, sandboxedEnv } = planFor(roleWith({ network: networkByName.allowlist }));
  assert.deepEqual('allowedDomains' in policy.network && policy.network.allowedDomains, ['127.0.0.1:4199', 'api.anthropic.com', 'platform.claude.com', 'api.github.com']);
  assert.equal('strictAllowlist' in policy.network && policy.network.strictAllowlist, true);
  assert.equal('allowLocalBinding' in policy.network && policy.network.allowLocalBinding, false);
  assert.equal(sandboxedEnv.NO_PROXY?.split(',').includes('127.0.0.1'), false);
  assert.equal(sandboxedEnv.no_proxy, sandboxedEnv.NO_PROXY);
  assert.equal(sandboxedEnv[HOOK_VIA_SANDBOX_PROXY_ENV], '1');
});

test('an open network role carries no domain list, and a check role carries an empty one with no local binding', () => {
  const openPlan = planFor(roleWith({ network: networkByName.open }));
  assert.equal(openPlan.launcher, 'open-network');
  assert.equal('allowedDomains' in openPlan.policy.network, false);
  assert.deepEqual(openPlan.sandboxedEnv, { TMPDIR: tempDir });
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
  assert.equal(buildSandboxLaunchPlan(roleWith({ vendorHome: { scope: 'launch', cwd: worktree, agentSessionId: '../escape' } }), { ...hostPaths, existingPaths: new Set() }).ok, false);
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
  const plan = planFor(role, { ...relocatedPaths, existingPaths: new Set(sandboxPolicyProbePaths(role, relocatedPaths)) });
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
  assert.equal(buildSandboxLaunchPlan(checkRole, { ...relativeRelocation, existingPaths: new Set() }).ok, false);
  const stateFolderOverHome = { ...relocatedPaths, vendorLocations: { ...relocatedPaths.vendorLocations, claude: { stateFolder: homeDir, configFiles: [], otherHomes: [] } } };
  assert.equal(buildSandboxLaunchPlan(role, { ...stateFolderOverHome, existingPaths: new Set() }).ok, false);
});

test('a writable path inside a read-denied region is re-allowed by its exact path, and an ancestor re-allow is refused', () => {
  const laneFolder = path.join(glimmervoidHome, 'lanes', 'one');
  const { filesystem } = planFor(roleWith({ writableRoots: [laneFolder] })).policy;
  assert.deepEqual(entryPaths(filesystem.allowRead), [tempDir, laneFolder]);
  const role = roleWith({ writableRoots: [laneFolder], readableWithinDenied: [path.join(glimmervoidHome, 'lanes')] });
  const refused = buildSandboxLaunchPlan(role, hostWhereEveryProbedPathExists(role));
  assert.equal(refused.ok, false);
});

test('a writable root that contains the home folder or the Glimmervoid home is refused', () => {
  for (const root of [homeDir, path.dirname(homeDir), glimmervoidHome]) {
    const role = roleWith({ writableRoots: [root] });
    assert.equal(buildSandboxLaunchPlan(role, hostWhereEveryProbedPathExists(role)).ok, false, root);
  }
});

test('each session gets its own temp folder and the shared one is write-denied', () => {
  const plan = planFor(roleWith());
  assert.equal(plan.launchEnv.CLAUDE_CODE_TMPDIR, tempDir);
  assert.equal(plan.requiredDirectories.includes(tempDir), true);
  assert.equal(entryPaths(plan.policy.filesystem.allowWrite).includes(tempDir), true);
  assert.equal(entryPaths(plan.policy.filesystem.denyWrite).includes('/tmp/claude'), true);
});
