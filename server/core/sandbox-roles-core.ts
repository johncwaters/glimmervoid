import type { SandboxRole } from './sandbox-policy-core.ts';

interface JudgeRoleFacts {
  vendor: SandboxRole['vendors'][number];
  cwd: string;
  hookPort: number | null;
  readablePaths: readonly string[];
  agentSessionId: string | null;
}

const LANE_CREDENTIAL_ENV: Readonly<Record<string, string>> = Object.freeze({
  SSH_AUTH_SOCK: '', SSH_ASKPASS: '', GIT_ASKPASS: '', GIT_SSH_COMMAND: 'false', GIT_TERMINAL_PROMPT: '0',
  GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
});

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

export { judgeRole, LANE_CREDENTIAL_ENV };
export type { JudgeRoleFacts };
