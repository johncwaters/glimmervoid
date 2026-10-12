import path from 'node:path';
import { isPathInside } from '../../shared/paths.ts';
import { LANE_CONFIG_EDIT_DENY_RULES, LANE_ENVIRONMENT_ARGS } from './lane-permissions-core.ts';
import { CREDENTIAL_HOME_ENTRIES } from './sandbox-policy-core.ts';

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
  network: { hookEndpoint: { host: string; port: number }; domains: readonly string[] };
  allowCommands: readonly string[];
  extraDeny: readonly string[];
  denyRead: readonly string[];
  scrubCredentials: boolean;
};

export type LanePosturePaths = {
  tempDir?: string;
  cwd?: string;
  commonGitDir?: string;
  privateHome?: string;
  privateHomeToolFolders?: readonly string[];
};

export const LANE_CREDENTIAL_ENV = Object.freeze({
  SSH_AUTH_SOCK: '', SSH_ASKPASS: '', GIT_ASKPASS: '', GIT_SSH_COMMAND: 'false', GIT_TERMINAL_PROMPT: '0',
  GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
});

export const LANE_CREDENTIAL_DENY_READ = Object.freeze(CREDENTIAL_HOME_ENTRIES.map((entry) => `~/${entry}`));

export const LANE_READABLE_HOME_FOLDERS = Object.freeze(['bin', path.join('factory', 'bin')]);

function privateHomeReadRules(paths: LanePosturePaths, laneFolders: readonly string[]): { denyRead: string[]; allowRead: string[] } {
  const { privateHome } = paths;
  if (!privateHome) return { denyRead: [], allowRead: [] };
  const laneFoldersInsideHome = laneFolders.filter((folder) => isPathInside(privateHome, folder, { allowEqual: false }));
  return { denyRead: [privateHome], allowRead: [...(paths.privateHomeToolFolders ?? []), ...laneFoldersInsideHome] };
}

export function buildLanePosture(spec: LanePostureSpec, paths: LanePosturePaths = {}) {
  const writableRoots = spec.access === 'read-only' ? [] : [...new Set(spec.writableRoots)];
  const allowWrite = paths.tempDir ? [paths.tempDir, ...writableRoots] : [...writableRoots];
  const denyWrite = paths.commonGitDir ? [paths.commonGitDir] : [];
  if (spec.access === 'read-only' && paths.cwd) denyWrite.push(paths.cwd);
  denyWrite.push(...writableRoots.flatMap(checkoutUnwritablePaths));
  const homeReadRules = privateHomeReadRules(paths, paths.cwd ? [paths.cwd, ...writableRoots] : writableRoots);
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
      filesystem: {
        allowWrite: [...new Set(allowWrite)], denyWrite: [...new Set(denyWrite)],
        denyRead: [...new Set([...spec.denyRead, ...homeReadRules.denyRead])], allowRead: [...new Set(homeReadRules.allowRead)],
      },
    },
    extraClaudeArgs: [...LANE_ENVIRONMENT_ARGS],
    spawnEnv: spec.scrubCredentials ? { ...LANE_CREDENTIAL_ENV } : {},
    requiresSaneYolo: true as const,
  };
}
