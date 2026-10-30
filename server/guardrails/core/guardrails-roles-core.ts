import path from 'node:path';
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
  ownVendor?: string | null;
  writableRoots: readonly string[];
  readDenied: readonly string[];
  readablePaths: readonly string[];
  blockedPaths: readonly string[];
}

const SESSION_VENDORS: readonly GuardrailsRoleVendor[] = Object.freeze(['claude', 'codex']);
const GUARDED_SESSION_VENDORS: readonly GuardrailsRoleVendor[] = Object.freeze(['claude', 'kimi']);

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

function sessionRole({ ownVendor = null, writableRoots, readDenied, readablePaths, blockedPaths }: SessionRoleFacts): GuardrailsRole {
  const ownGuardedVendors = GUARDED_SESSION_VENDORS.filter((vendor) => vendor === ownVendor);
  return {
    guardrailLevel: 'standard',
    blockedPaths: [...blockedPaths],
    vendors: [...new Set([...SESSION_VENDORS, ...ownGuardedVendors])],
    vendorHome: { scope: 'state' },
    network: { access: 'open' },
    writableRoots: [...new Set(writableRoots)],
    lockedCheckouts: [],
    commitCheckouts: [],
    readDenied: [...readDenied],
    readableWithinDenied: [...readablePaths],
  };
}

function isWorktreeAdminDirOf({ adminDir, commonGitDir }: { adminDir: string; commonGitDir: string }): boolean {
  return path.dirname(path.resolve(adminDir)) === path.resolve(commonGitDir, 'worktrees');
}

export {
  isWorktreeAdminDirOf, judgeRole, sessionRole,
  workRole,
};
