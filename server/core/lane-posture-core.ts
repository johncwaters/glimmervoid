import path from 'node:path';
import { LANE_CONFIG_EDIT_DENY_RULES, LANE_ENVIRONMENT_ARGS } from './lane-permissions-core.ts';

export const COMMON_GIT_DIR_UNWRITABLE_ENTRIES = Object.freeze(['hooks', 'config', 'config.worktree']);

export const WORKTREE_ADMIN_DIR_UNWRITABLE_ENTRIES = Object.freeze(['commondir', 'gitdir', 'config.worktree']);

export function isSafeBranchName(branch: string): boolean {
  return /^[\w.-]+(\/[\w.-]+)*$/.test(branch)
    && branch.split('/').every((segment) => !segment.startsWith('.') && !segment.endsWith('.lock') && !segment.endsWith('.'));
}

function branchRefPath(commonGitDir: string, branch: string): string {
  return path.join(commonGitDir, 'refs', 'heads', ...branch.split('/'));
}

function branchCommitPaths(commonGitDir: string, branch: string): string[] {
  const branchRef = branchRefPath(commonGitDir, branch);
  return [path.join(commonGitDir, 'objects'), branchRef, `${branchRef}.lock`, path.join(commonGitDir, 'logs', 'refs', 'heads', ...branch.split('/'))];
}

function sharedRefUnwritablePaths(commonGitDir: string, integrationBranch: string): string[] {
  const integrationRefPath = branchRefPath(commonGitDir, integrationBranch);
  return [integrationRefPath, `${integrationRefPath}.lock`, path.join(commonGitDir, 'refs', 'replace'),
    path.join(commonGitDir, 'packed-refs'), path.join(commonGitDir, 'packed-refs.lock')];
}

function commonDirUnwritablePaths(commonGitDir: string): string[] {
  return COMMON_GIT_DIR_UNWRITABLE_ENTRIES.map((entry) => path.join(commonGitDir, entry));
}

function worktreeAdminUnwritablePaths(worktreeAdminDir: string): string[] {
  return WORKTREE_ADMIN_DIR_UNWRITABLE_ENTRIES.map((entry) => path.join(worktreeAdminDir, entry));
}

function checkoutUnwritablePaths(checkoutPath: string): string[] {
  return [path.join(checkoutPath, '.git'), path.join(checkoutPath, '.claude')];
}

export function absolutePathEditRule(absolutePath: string): string {
  const posixPath = absolutePath
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, (_drive, driveLetter: string) => `/${driveLetter.toLowerCase()}`)
    .replace(/\/+$/, '');
  return `Edit(/${posixPath}/**)`;
}

export function parseGitdirPointer(gitFileText: string): string | null {
  const gitdir = /^gitdir:\s*(.+)$/m.exec(gitFileText)?.[1]?.trim();
  return gitdir && path.isAbsolute(gitdir) ? path.resolve(gitdir) : null;
}

export function isWorktreeAdminDirOf({ adminDir, commonGitDir }: { adminDir: string; commonGitDir: string }): boolean {
  return path.dirname(path.resolve(adminDir)) === path.resolve(commonGitDir, 'worktrees');
}

export type LanePostureSpec = {
  access: 'read-only' | 'own-worktree' | 'own-checkout';
  writableRoots: readonly string[];
  gitCommit?: { commonDir: string; worktreeAdminDir: string; branch: string };
  network: { hookEndpoint: { host: string; port: number }; domains: readonly string[] };
  allowCommands: readonly string[];
  extraDeny: readonly string[];
  denyRead: readonly string[];
  scrubCredentials: boolean;
};

export type LanePosturePaths = {
  tempDir?: string;
  cwd?: string;
  gitWorktree?: { commonDir: string; integrationBranch: string };
};

export const LANE_CREDENTIAL_ENV = Object.freeze({
  SSH_AUTH_SOCK: '', SSH_ASKPASS: '', GIT_ASKPASS: '', GIT_SSH_COMMAND: 'false', GIT_TERMINAL_PROMPT: '0',
  GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
});

export const LANE_CREDENTIAL_DENY_READ = Object.freeze(['~/.ssh', '~/.config/gh', '~/Library/Keychains', '~/.git-credentials']);

export function buildLanePosture(spec: LanePostureSpec, paths: LanePosturePaths = {}) {
  const writableRoots = spec.access === 'read-only' ? [] : [...new Set(spec.writableRoots)];
  const commonDir = paths.gitWorktree?.commonDir ?? spec.gitCommit?.commonDir;
  const allowWrite = paths.tempDir ? [paths.tempDir, ...writableRoots] : [...writableRoots];
  if (spec.access === 'own-worktree' && spec.gitCommit) {
    allowWrite.push(spec.gitCommit.worktreeAdminDir, ...branchCommitPaths(spec.gitCommit.commonDir, spec.gitCommit.branch));
  }
  const denyWrite = commonDir ? commonDirUnwritablePaths(commonDir) : [];
  if (spec.gitCommit) denyWrite.push(...worktreeAdminUnwritablePaths(spec.gitCommit.worktreeAdminDir));
  if (paths.gitWorktree) denyWrite.push(...sharedRefUnwritablePaths(paths.gitWorktree.commonDir, paths.gitWorktree.integrationBranch));
  if (spec.access === 'read-only' && paths.cwd) denyWrite.push(paths.cwd);
  denyWrite.push(...writableRoots.flatMap(checkoutUnwritablePaths));
  return {
    settingsPermissions: {
      defaultMode: 'dontAsk' as const,
      allow: [...writableRoots.map(absolutePathEditRule), ...spec.allowCommands.map((prefix) => `Bash(${prefix}:*)`)],
      deny: [...new Set([...spec.extraDeny, ...LANE_CONFIG_EDIT_DENY_RULES])],
    },
    settingsSandbox: {
      enabled: true as const,
      failIfUnavailable: true as const,
      allowUnsandboxedCommands: false as const,
      enableWeakerNetworkIsolation: true as const,
      network: {
        strictAllowlist: true as const,
        allowLocalBinding: true as const,
        allowAllUnixSockets: false as const,
        allowedDomains: [...new Set([`${spec.network.hookEndpoint.host}:${spec.network.hookEndpoint.port}`, ...spec.network.domains])],
      },
      filesystem: { allowWrite: [...new Set(allowWrite)], denyWrite, denyRead: [...spec.denyRead] },
    },
    extraClaudeArgs: [...LANE_ENVIRONMENT_ARGS],
    spawnEnv: spec.scrubCredentials ? { ...LANE_CREDENTIAL_ENV } : {},
    requiresSaneYolo: true as const,
  };
}
