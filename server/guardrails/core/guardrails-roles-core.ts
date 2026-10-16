import path from 'node:path';
import { isPathInside } from '../../../shared/paths.ts';
import type { GuardrailsRole } from './guardrails-policy-core.ts';

type GuardrailsRoleVendor = GuardrailsRole['vendors'][number];

interface JudgeRoleFacts {
  vendor: GuardrailsRoleVendor;
  cwd: string;
  hookPort: number | null;
  readablePaths: readonly string[];
  agentSessionId: string | null;
}

interface WorkRoleFacts {
  vendor: GuardrailsRoleVendor;
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

interface SessionGuardrailsFacts {
  usageVendor: string | null;
  isMarkedUnguarded: boolean;
  sessionFolders: readonly string[];
  unguardedRepos: readonly string[];
}

const SESSION_VENDORS: readonly GuardrailsRoleVendor[] = Object.freeze(['claude', 'codex']);
const GUARDED_SESSION_VENDORS: readonly string[] = Object.freeze(['claude']);

const LANE_CREDENTIAL_ENV: Readonly<Record<string, string>> = Object.freeze({
  SSH_AUTH_SOCK: '', SSH_ASKPASS: '', GIT_ASKPASS: '', GIT_SSH_COMMAND: 'false', GIT_TERMINAL_PROMPT: '0',
  GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
});

const LANE_READABLE_HOME_FOLDERS: readonly string[] = Object.freeze(['bin', path.join('factory', 'bin')]);

function judgeRole({ vendor, cwd, hookPort, readablePaths, agentSessionId }: JudgeRoleFacts): GuardrailsRole {
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

function workRole({ vendor, cwd, checkout, readablePaths, writablePaths = [], agentSessionId }: WorkRoleFacts): GuardrailsRole {
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

function sessionRole({ writableRoots, readDenied, readablePaths, blockedPaths }: SessionRoleFacts): GuardrailsRole {
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

function isGuardedSessionVendor(usageVendor: string | null): boolean {
  return usageVendor !== null && GUARDED_SESSION_VENDORS.includes(usageVendor);
}

function isSessionGuarded({ usageVendor, isMarkedUnguarded, sessionFolders, unguardedRepos }: SessionGuardrailsFacts): boolean {
  if (isMarkedUnguarded) return false;
  if (!isGuardedSessionVendor(usageVendor)) return false;
  return !sessionFolders.some((folder) => unguardedRepos.some((repo) => isPathInside(repo, folder)));
}

function parseGitdirPointer(gitFileText: string): string | null {
  const gitdir = /^gitdir:\s*(.+)$/m.exec(gitFileText)?.[1]?.trim();
  return gitdir && path.isAbsolute(gitdir) ? path.resolve(gitdir) : null;
}

function isWorktreeAdminDirOf({ adminDir, commonGitDir }: { adminDir: string; commonGitDir: string }): boolean {
  return path.dirname(path.resolve(adminDir)) === path.resolve(commonGitDir, 'worktrees');
}

export {
  isGuardedSessionVendor, isSessionGuarded, isWorktreeAdminDirOf, judgeRole, LANE_CREDENTIAL_ENV, LANE_READABLE_HOME_FOLDERS, parseGitdirPointer, sessionRole,
  workRole,
};
export type { SessionRoleFacts };
