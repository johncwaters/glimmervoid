import type { SandboxRole } from './sandbox-policy-core.ts';

interface JudgeRoleFacts {
  vendor: SandboxRole['vendors'][number];
  cwd: string;
  hookPort: number | null;
  readablePaths: readonly string[];
}

function judgeRole({ vendor, cwd, hookPort, readablePaths }: JudgeRoleFacts): SandboxRole {
  return {
    vendors: [vendor],
    vendorHome: 'lane',
    network: { access: 'allowlist', domains: [], hookPort },
    writableRoots: [cwd],
    lockedCheckouts: [],
    commitCheckouts: [],
    readDenied: [],
    readableWithinDenied: [...readablePaths],
  };
}

export { judgeRole };
export type { JudgeRoleFacts };
