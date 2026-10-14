import path from 'node:path';
import { isPathInside } from '../../../shared/paths.ts';
import type { SandboxRole } from './sandbox-policy-core.ts';

type SandboxRoleVendor = SandboxRole['vendors'][number];

interface JudgeRoleFacts {
  vendor: SandboxRoleVendor;
  cwd: string;
  hookPort: number | null;
  readablePaths: readonly string[];
  agentSessionId: string | null;
}

interface WorkRoleFacts {
  vendor: SandboxRoleVendor;
  cwd: string;
  checkout: string;
  readablePaths: readonly string[];
  writablePaths?: readonly string[];
  agentSessionId: string | null;
}

interface SessionRoleFacts {
  writableRoots: readonly string[];
  readDenied: readonly string[];
  readablePaths: readonly string[];
  blockedPaths: readonly string[];
}

interface SessionConfinementFacts {
  usageVendor: string | null;
  isMarkedUnconfined: boolean;
  sessionFolders: readonly string[];
  unconfinedRepos: readonly string[];
}

const SESSION_VENDORS: readonly SandboxRoleVendor[] = Object.freeze(['claude', 'codex']);
const CONFINED_SESSION_VENDORS: readonly string[] = Object.freeze(['claude']);

const LANE_CREDENTIAL_ENV: Readonly<Record<string, string>> = Object.freeze({
  SSH_AUTH_SOCK: '', SSH_ASKPASS: '', GIT_ASKPASS: '', GIT_SSH_COMMAND: 'false', GIT_TERMINAL_PROMPT: '0',
  GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
});

const LANE_READABLE_HOME_FOLDERS: readonly string[] = Object.freeze(['bin', path.join('factory', 'bin')]);

function judgeRole({ vendor, cwd, hookPort, readablePaths, agentSessionId }: JudgeRoleFacts): SandboxRole {
  return {
    vendors: [vendor],
    vendorHome: { scope: 'launch', cwd, agentSessionId },
    network: { access: 'allowlist', domains: [], hookPort },
    writableRoots: [cwd],
    lockedCheckouts: [],
    commitCheckouts: [],
    readDenied: [],
    readableWithinDenied: [...readablePaths],
  };
}

function workRole({ vendor, cwd, checkout, readablePaths, writablePaths = [], agentSessionId }: WorkRoleFacts): SandboxRole {
  return {
    vendors: [vendor],
    vendorHome: { scope: 'launch', cwd, agentSessionId },
    network: { access: 'open' },
    writableRoots: [...writablePaths],
    lockedCheckouts: [checkout],
    commitCheckouts: [],
    readDenied: [],
    readableWithinDenied: [...readablePaths],
  };
}

function sessionRole({ writableRoots, readDenied, readablePaths, blockedPaths }: SessionRoleFacts): SandboxRole {
  return {
    guardrailLevel: 'standard',
    blockedPaths: [...blockedPaths],
    vendors: SESSION_VENDORS,
    vendorHome: { scope: 'state' },
    network: { access: 'open' },
    writableRoots: [...new Set(writableRoots)],
    lockedCheckouts: [],
    commitCheckouts: [],
    readDenied: [...readDenied],
    readableWithinDenied: [...readablePaths],
  };
}

function isConfinedSessionVendor(usageVendor: string | null): boolean {
  return usageVendor !== null && CONFINED_SESSION_VENDORS.includes(usageVendor);
}

function isSessionConfined({ usageVendor, isMarkedUnconfined, sessionFolders, unconfinedRepos }: SessionConfinementFacts): boolean {
  if (isMarkedUnconfined) return false;
  if (!isConfinedSessionVendor(usageVendor)) return false;
  return !sessionFolders.some((folder) => unconfinedRepos.some((repo) => isPathInside(repo, folder)));
}

function parseGitdirPointer(gitFileText: string): string | null {
  const gitdir = /^gitdir:\s*(.+)$/m.exec(gitFileText)?.[1]?.trim();
  return gitdir && path.isAbsolute(gitdir) ? path.resolve(gitdir) : null;
}

function isWorktreeAdminDirOf({ adminDir, commonGitDir }: { adminDir: string; commonGitDir: string }): boolean {
  return path.dirname(path.resolve(adminDir)) === path.resolve(commonGitDir, 'worktrees');
}

export {
  isConfinedSessionVendor, isSessionConfined, isWorktreeAdminDirOf, judgeRole, LANE_CREDENTIAL_ENV, LANE_READABLE_HOME_FOLDERS, parseGitdirPointer, sessionRole,
  workRole,
};
export type { SessionRoleFacts };
