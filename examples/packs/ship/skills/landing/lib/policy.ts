
const FALLBACK_FORBIDDEN_BRANCHES = ["main", "master"] as const;

export type CommitPolicy = Record<string, unknown>;

export type PolicyLookup = {
  profile?: string;
  policy?: CommitPolicy;
  policyPath?: string;
  warning?: string;
};

export function readCommitPolicy(): PolicyLookup {
  return { policy: {} };
}

export function configuredMainline(policy: CommitPolicy | undefined): unknown {
  return policy?.mainline ?? "auto";
}

export function policyValidationErrors(
  policy: CommitPolicy | undefined,
  policyPath: string | undefined,
): string[] {
  if (!policy) {
    return [];
  }
  const commitBranches = policy.commitBranches as { onForbidden?: unknown } | undefined;
  const onForbidden = commitBranches?.onForbidden;
  if (onForbidden === undefined) {
    return [];
  }
  if (onForbidden === "create-feature-branch") {
    return [];
  }
  const source = policyPath ?? "commit-policy.json";
  return [
    `${source} commitBranches.onForbidden must be "create-feature-branch", got ${JSON.stringify(onForbidden)}`,
  ];
}

export function forbiddenBranches(policy: CommitPolicy | undefined): string[] {
  const commitBranches = policy?.commitBranches as { forbid?: unknown } | undefined;
  const forbid = commitBranches?.forbid;
  if (!Array.isArray(forbid)) {
    return [...FALLBACK_FORBIDDEN_BRANCHES];
  }
  return forbid.filter((entry): entry is string => typeof entry === "string");
}

export function isBranchAllowed(
  branch: string,
  policy: CommitPolicy | undefined,
  mainline: string | null = null,
): boolean {
  return branch !== mainline && !forbiddenBranches(policy).includes(branch);
}
