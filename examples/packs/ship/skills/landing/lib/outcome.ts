export const EXIT_CODES = {
  READY: 0,
  COMMITTED: 0,
  NOT_A_REPO: 10,
  DETACHED_HEAD: 11,
  OPERATION_IN_PROGRESS: 12,
  NOTHING_TO_COMMIT: 13,
  MESSAGE_INVALID: 20,
  HOOK_FAILED: 21,
  DENYLISTED_FILE_STAGED: 25,
  PUSH_FAILED: 22,
  PROMOTE_CONFLICT: 23,
  PROMOTE_FAILED: 24,
  BRANCH_FORBIDDEN: 28,
  MAINLINE_UNVERIFIED: 29,
  HOME_PATH_STAGED: 30,
  NOT_REVIEWED: 31,
  PROMOTE_WITHHELD: 32,
  PUSH_WITHHELD: 33,
  SECRET_STAGED: 34,
} as const;

export type OutcomeName = keyof typeof EXIT_CODES;

type FieldValueByKind = {
  string: string;
  boolean: boolean;
  stringList: string[];
  object: Record<string, unknown>;
};

type FieldKind = keyof FieldValueByKind;

type FieldSpec = { kind: FieldKind; isRequired: boolean };

type FieldSpecs = Record<string, FieldSpec>;

type RequiredFieldNames<Specs extends FieldSpecs> = {
  [Name in keyof Specs]: Specs[Name]["isRequired"] extends true ? Name : never;
}[keyof Specs];

type OptionalFieldNames<Specs extends FieldSpecs> = {
  [Name in keyof Specs]: Specs[Name]["isRequired"] extends true ? never : Name;
}[keyof Specs];

type Payload<Specs extends FieldSpecs> = {
  [Name in RequiredFieldNames<Specs>]: FieldValueByKind[Specs[Name]["kind"]];
} & {
  [Name in OptionalFieldNames<Specs>]?: FieldValueByKind[Specs[Name]["kind"]];
} & { warnings?: string[] };

export type NextStep =
  | { action: "done" }
  | { action: "proceed" }
  | { action: "rerun"; script: "land.ts" | "preflight.ts"; after: string }
  | { action: "runGate"; gate: string; then: "landing"; commits?: string[] }
  | { action: "fixAndRerun"; fix: "message" | "unstage" | "replacePaths" | "removeSecret" | "hookCause" | "finding"; items: string[] }
  | { action: "resolveConflicts"; files: string[] }
  | { action: "relay"; report: string }
  | { action: "stop"; report: string };

export type Result = { outcome: OutcomeName; next: NextStep } & Record<string, unknown>;

export function required<Kind extends FieldKind>(kind: Kind) {
  return { kind, isRequired: true } as const;
}

export function optional<Kind extends FieldKind>(kind: Kind) {
  return { kind, isRequired: false } as const;
}

function matchesKind(kind: FieldKind, value: unknown): boolean {
  if (kind === "string") {
    return typeof value === "string";
  }
  if (kind === "boolean") {
    return typeof value === "boolean";
  }
  if (kind === "stringList") {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
  }
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defineOutcome<const Specs extends FieldSpecs>(
  outcome: OutcomeName,
  specs: Specs,
  nextStepFor: (payload: Payload<Specs>) => NextStep,
) {
  return (payload: Payload<Specs>): Result => {
    const fields = payload as Record<string, unknown>;
    for (const [name, value] of Object.entries(fields)) {
      if (name === "warnings") {
        if (!matchesKind("stringList", value)) {
          throw new Error(`${outcome} field warnings must be a stringList`);
        }
        continue;
      }
      const spec = specs[name];
      if (!spec) {
        throw new Error(`${outcome} has no field named ${name}`);
      }
      if (!matchesKind(spec.kind, value)) {
        throw new Error(`${outcome} field ${name} must be a ${spec.kind}`);
      }
    }
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.isRequired && !(name in fields)) {
        throw new Error(`${outcome} is missing required field ${name}`);
      }
    }
    const warnings = payload.warnings ?? [];
    const result: Result = { outcome, ...fields, next: nextStepFor(payload) };
    if (warnings.length === 0) {
      delete result.warnings;
    }
    return result;
  };
}

export const ready = defineOutcome("READY", {
  branch: required("string"),
  branchAllowed: required("boolean"),
  changed: required("stringList"),
  untracked: required("stringList"),
  hasUncommittedWork: required("boolean"),
  profile: optional("string"),
  policy: optional("object"),
  mainlineFreshness: optional("object"),
  remoteVisibility: optional("object"),
}, ({ branchAllowed, mainlineFreshness, hasUncommittedWork }) => {
  if (!branchAllowed) {
    return { action: "rerun", script: "preflight.ts", after: "creating and switching to a feature branch named for the work" };
  }
  const commitsBehindMainline = Number(mainlineFreshness?.behind ?? 0);
  if (commitsBehindMainline > 0 && !hasUncommittedWork) {
    return { action: "rerun", script: "preflight.ts", after: `integrating origin/${String(mainlineFreshness?.mainline)} with the verb its warning names` };
  }
  return { action: "proceed" };
});

export const committed = defineOutcome("COMMITTED", {
  commit: required("string"),
  branchPushed: required("boolean"),
  promoted: required("stringList"),
  deletedRemoteBranches: optional("stringList"),
  noPullRequestHost: optional("string"),
}, ({ noPullRequestHost }) => noPullRequestHost
  ? { action: "relay", report: `${noPullRequestHost}; it is not a GitHub remote, so the branch stays unmerged until a pull request is opened on its host.` }
  : { action: "done" });

export const messageValid = defineOutcome("READY", {}, () => ({ action: "proceed" }));

export const notARepo = defineOutcome("NOT_A_REPO", {}, () => ({ action: "stop", report: "Not inside a git repository." }));

export const detachedHead = defineOutcome("DETACHED_HEAD", {}, () => ({ action: "stop", report: "HEAD is detached; nothing was written." }));

export const operationInProgress = defineOutcome("OPERATION_IN_PROGRESS", {
  operation: required("string"),
  unmerged: optional("stringList"),
}, ({ operation, unmerged = [] }) => operation === "MERGE_HEAD"
  ? { action: "rerun", script: "preflight.ts", after: `resolving ${unmerged.length > 0 ? unmerged.join(", ") : "the merge"} by the sync path in recovery, then git merge --continue` }
  : { action: "stop", report: `A ${operation} is in flight; nothing was written.` });

export const nothingToCommit = defineOutcome("NOTHING_TO_COMMIT", {
  branchPushed: optional("boolean"),
  promoted: optional("stringList"),
  deletedRemoteBranches: optional("stringList"),
}, ({ promoted = [] }) => ({ action: "stop", report: promoted.length > 0 ? `Nothing new to commit; promoted ${promoted.join(", ")}.` : "Nothing to commit." }));

export const messageInvalid = defineOutcome("MESSAGE_INVALID", {
  errors: required("stringList"),
}, ({ errors }) => ({ action: "fixAndRerun", fix: "message", items: errors }));

export const hookFailed = defineOutcome("HOOK_FAILED", {}, ({ warnings = [] }) => ({ action: "fixAndRerun", fix: "hookCause", items: warnings }));

export const denylistedFileStaged = defineOutcome("DENYLISTED_FILE_STAGED", {
  files: required("stringList"),
}, ({ files }) => ({ action: "fixAndRerun", fix: "unstage", items: files }));

export const homePathStaged = defineOutcome("HOME_PATH_STAGED", {
  matches: required("stringList"),
}, ({ matches }) => ({ action: "fixAndRerun", fix: "replacePaths", items: matches }));

export const secretStaged = defineOutcome("SECRET_STAGED", {
  matches: required("stringList"),
}, ({ matches }) => ({ action: "fixAndRerun", fix: "removeSecret", items: matches }));

export const pushFailed = defineOutcome("PUSH_FAILED", {
  commit: optional("string"),
  branchPushed: required("boolean"),
  promoted: required("stringList"),
}, () => ({ action: "rerun", script: "land.ts", after: "fixing the push failure named in warnings, by Push and promote recovery" }));

export const promoteConflict = defineOutcome("PROMOTE_CONFLICT", {
  commit: optional("string"),
  branchPushed: required("boolean"),
  promoted: required("stringList"),
  conflicts: required("stringList"),
}, ({ conflicts }) =>
    conflicts.length > 0
      ? { action: "resolveConflicts", files: conflicts }
      : { action: "rerun", script: "land.ts", after: "fetching origin, since the mainline fast-forward was rejected" });

export const promoteFailed = defineOutcome("PROMOTE_FAILED", {
  commit: optional("string"),
  branchPushed: required("boolean"),
  promoted: required("stringList"),
}, () => ({ action: "rerun", script: "land.ts", after: "fixing the promote failure named in warnings, by Push and promote recovery" }));

export const branchForbidden = defineOutcome("BRANCH_FORBIDDEN", {
  branch: required("string"),
}, ({ branch }) => ({ action: "rerun", script: "preflight.ts", after: `switching from ${branch} to a feature branch named for the work` }));

export const mainlineUnverified = defineOutcome("MAINLINE_UNVERIFIED", {
  commit: optional("string"),
  branchPushed: required("boolean"),
  promoted: required("stringList"),
  mainline: required("string"),
}, () => ({ action: "rerun", script: "land.ts", after: "restoring the remote verification named in warnings" }));

export const notReviewed = defineOutcome("NOT_REVIEWED", {
  gate: required("string"),
  tree: optional("string"),
  stampTree: optional("string"),
}, ({ gate }) => ({ action: "runGate", gate, then: "landing" }));

const withheldFields = {
  commit: optional("string"),
  branchPushed: required("boolean"),
  promoted: required("stringList"),
  findings: required("stringList"),
};

function reviewWithheldCommits({ findings }: { findings: string[] }): NextStep {
  const blockingFindings = findings.filter((finding) => !finding.startsWith("UNREVIEWED "));
  if (blockingFindings.length > 0) {
    return { action: "fixAndRerun", fix: "finding", items: blockingFindings };
  }
  const unreviewedCommits = findings.map((finding) => /^UNREVIEWED ([0-9a-f]+):/.exec(finding)?.[1]).filter((commit) => commit !== undefined).reverse();
  return { action: "runGate", gate: "gating-reviews", then: "landing", commits: unreviewedCommits };
}

export const promoteWithheld = defineOutcome("PROMOTE_WITHHELD", withheldFields, reviewWithheldCommits);

export const pushWithheld = defineOutcome("PUSH_WITHHELD", withheldFields, reviewWithheldCommits);

export function emit(result: Result): never {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(EXIT_CODES[result.outcome]);
}
