import { COHERENCE_BOOKKEEPING_PATHSPEC } from '../../coherence/core/coherence-paths-core.ts';
import fs from 'node:fs';
import type { GitIsolationOptions } from '../core/git-invocation-core.ts';
import type { MarkerProbes } from '../../core/integration-branch-core.ts';
import type { MergeTreeOutcome } from '../../core/merge-proof-core.ts';
import type { IntegrationSyncOutcome } from '../../core/integration-sync-core.ts';
import type { OwnedPathOwner } from '../../../shared/contracts/owned-paths.ts';
import type { OwnedPathsLedgerHandle } from '../../owned-paths-ledger.ts';
import type { RemovalCause, RemovalKind } from '../../../shared/contracts/removal-record.ts';
import { isOwnWorktreeLockLine } from '../core/worktree-lock-core.ts';

const fsp = fs.promises;

type GitResult = { ok: boolean; out: string; err?: string };

type IntegrationSyncResult = {
  outcome: IntegrationSyncOutcome;
  from: string | null;
  to: string | null;
  error?: string;
};

type GitExtraOptions = { timeout?: number; maxBuffer?: number; env?: Record<string, string>; replaceEnv?: Record<string, string>; disableRepoCommands?: boolean };

type GitRunner = (args: string[], cwd: string, extra?: GitExtraOptions) => Promise<string> | string;

type WorktreeBranch = { cwd: string; branch: string; locked: boolean; prunable: boolean; headSha: string | null };

type WorkspaceHandle = {
  cwd: string;
  isGit: boolean;
  branch?: string | null;
  base?: string | null;
  baseSha?: string | null;
  reason?: string;
  conflictPath?: string;
  error?: string;
  warning?: string | null;
};

type WorktreeArgs = {
  projectPath: string;
  admissionTimeoutMs?: number;
  workspace?: WorkspaceHandle | null;
  targetBranch?: string | null;
  integrationBranch?: string | null;
  configuredIntegrationBranch?: string | null;
  cwd?: string | null;
  branch?: string | null;
  timeoutMs?: number;
  wtDir?: string;
  shareList?: string[] | null;
  keepTrackableLinks?: boolean;
  disableRepoCommands?: boolean;
  disableHooks?: boolean;
  replaceEnv?: Record<string, string>;
  teamId?: string;
  label?: string;
  baseBranch?: string | null;
  forkFromHead?: boolean;
  startSha?: string | null;
  worktreeBase?: string | null;
  name?: string;
  ancestorSha?: string;
  descendantSha?: string;
  sha?: string;
  tipSha?: string;
  integrationSha?: string;
  branchSha?: string;
  prefixes?: string[];
  worktreeRoot?: string | null;
  knownProjects?: unknown;
};

type MergeOutcome = {
  merged: boolean;
  committed: boolean;
  branch: string | null;
  base?: string | null;
  reason: string | null;
  parked?: boolean;
  kept?: boolean;
  baseSha?: string | null;
  conflicts?: string[];
  restoreConflict?: boolean;
  rerereReplayed?: boolean;
  pushed?: boolean;
  warning?: string;
  landedRange?: LandedRange | null;
};

type LandedRange = { fromSha: string; toSha: string };

type RebaseOutcome = {
  ok: boolean;
  upToDate?: boolean;
  rebased?: boolean;
  headSha?: string | null;
  baseSha?: string | null;
  rerereReplayed?: boolean;
  reason?: string;
  conflicts?: string[];
};

type SessionWorktree = {
  cwd: string;
  branch: string;
  id: string;
  hasWork: boolean;
  integrationBranch: string | null;
};

type ListedWorktree = {
  cwd: string;
  branch: string;
  locked: boolean;
  prunable: boolean;
  dirty: boolean | null;
  tipSha: string;
  integrationBranch: string | null;
};

type WorktreeProbe = { dirty: GitResult; ahead: GitResult | null; integrationBranch: string | null };

type IntegrationTip = { branch: string; sha: string | null };

type BaseClassification = { state: string; upstream: string };

type BaseSyncResult = BaseClassification & { fetched: boolean | null; error?: string };

type MergeTreeProbe = GitResult & { outcome: MergeTreeOutcome };

type MergeFastForwardOutcome = 'invalid-target-sha' | 'merged' | 'head-mismatch' | 'head-unreadable' | 'merge-failed' | 'queue-admission-timed-out';

type MergeFastForwardResult = GitResult & {
  sampledHead: string | null;
  outcome: MergeFastForwardOutcome;
};

type QueuedGitResult = GitResult & { admissionRefused?: boolean; removalKept?: string };

type WorktreeDirtyProbe = { ok: boolean; dirty: boolean; headSha: string | null; err?: string; admissionRefused?: boolean };

type MergeProbeEnvArgs = { projectPath: string; timeoutMs?: number };

type CheckoutDetachedArgs = { worktreePath: string; sha: string } & GitIsolationOptions;

type StageDetachedWorktreeArgs = { projectPath: string; worktreePath?: string; sha?: string; owner: OwnedPathOwner } & GitIsolationOptions;

type OwnedWorktreeArgs = WorktreeArgs & { owner: OwnedPathOwner };

type WorktreeOwnership = { owner: OwnedPathOwner; projectPath: string; branch: string | null };

type OwnedPathsRecorder = Pick<OwnedPathsLedgerHandle, 'record' | 'forget' | 'ownerOf'> & Partial<Pick<OwnedPathsLedgerHandle, 'entriesOwnedBy'>>;

type RemovalGuardOptions = { protectedSessionIds?: () => ReadonlySet<string>; journalPath?: string; now?: () => number };

type RemovalArgs = WorktreeArgs & { cause: RemovalCause; requiresUntouchedFloor?: boolean };

type RemovalTarget = { cause: RemovalCause; kind: RemovalKind; projectPath: string; path: string | null; branch: string | null; tipSha?: string | null; requiresUntouchedFloor?: boolean };

type RemovalAdmission = { admitted: true } | { admitted: false; reason: string };

type StageIsolatedCheckoutArgs = { projectPath: string; checkoutPath?: string; sha?: string; baseSha?: string };

type MergeFastForwardArgs = {
  projectPath: string;
  expectedHead?: string;
  sha?: string;
  timeoutMs?: number;
  admissionTimeoutMs?: number;
};

type ResetKeepArgs = { projectPath: string; expectedHead?: string; sha?: string; timeoutMs?: number; admissionTimeoutMs?: number };

type MergeTreeArgs = {
  projectPath: string;
  integrationSha: string;
  branchSha: string;
  probeEnv: Record<string, string>;
  timeoutMs?: number;
};

const MERGE_PROBE_TIMEOUT_MS = 30000;

const REMOTE_REF_PREFIX = 'refs/remotes/origin/';

const REMOTE_BRANCH_LISTING_MAX_BUFFER = 64 * 1024 * 1024;

const ISOLATED_CHECKOUT_HYDRATE_TIMEOUT_MS = 10 * 60 * 1000;

const ISOLATED_CHECKOUT_REVIEW_REF = 'refs/heads/review';

const ISOLATED_CHECKOUT_BASE_REF = 'refs/benchmark/base';

function errorExitCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function okResult(out: unknown): GitResult {
  return { ok: true, out: String(out || '').trim() };
}

function errResult(err: unknown): GitResult {
  const failure = (err ?? {}) as { stdout?: unknown; stderr?: unknown; message?: unknown; killed?: unknown; signal?: unknown };
  const detail = String(failure.stderr || failure.message || '');
  const wasKilledByTimeout = failure.killed === true && Boolean(failure.signal);
  return {
    ok: false,
    out: String(failure.stdout || '').trim(),
    err: wasKilledByTimeout ? `timed out (killed): ${detail}` : detail,
  };
}

async function directoryExists(candidatePath: string): Promise<boolean> {
  try {
    await fsp.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function parseWorktreeBranches(porcelain: string): WorktreeBranch[] {
  const result: WorktreeBranch[] = [];
  let current: { cwd: string; branch: string | null; locked: boolean; prunable: boolean; headSha: string | null } | null = null;
  const flush = () => {
    if (current?.branch) result.push({ cwd: current.cwd, branch: current.branch, locked: current.locked, prunable: current.prunable, headSha: current.headSha });
    current = null;
  };
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { cwd: line.slice('worktree '.length).trim(), branch: null, locked: false, prunable: false, headSha: null };
      continue;
    }
    if (line === '') { flush(); continue; }
    if (!current) continue;
    if (line.startsWith('HEAD ')) { current.headSha = line.slice('HEAD '.length).trim() || null; continue; }
    if (line.startsWith('branch ')) { current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, ''); continue; }
    if (line.startsWith('prunable')) { current.prunable = true; continue; }
    if (line.startsWith('locked') && !isOwnWorktreeLockLine(line)) current.locked = true;
  }
  flush();
  return result;
}

function mainWorktreePath(porcelain: string): string | null {
  const firstEntry = porcelain.split(/\r?\n/).find((line) => line.startsWith('worktree '));
  if (!firstEntry) return null;
  return firstEntry.slice('worktree '.length).trim() || null;
}

function findWorktreeForBranch(porcelain: string, branch: string): string | null {
  const hit = parseWorktreeBranches(porcelain).find((w) => w.branch === branch);
  return hit ? hit.cwd : null;
}

const WORKTREE_STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'];

const WORK_PRESENCE_STATUS_ARGS = [...WORKTREE_STATUS_ARGS, ...COHERENCE_BOOKKEEPING_PATHSPEC];

const isDirtyResult = (dirty: GitResult) => dirty.ok && dirty.out !== '';

function hasWorkFrom(dirty: GitResult, ahead: GitResult | null): boolean {
  if (!dirty.ok) return true;
  if (isDirtyResult(dirty)) return true;
  if (!ahead || !ahead.ok) return true;
  return !!(ahead.out && ahead.out !== '0');
}

const markerFrom = (result: GitResult) => (result.ok && result.out ? result.out : null);

const markerKey = (branch: string) => `branch.${branch}.glimmervoid-integration`;

const UNPROBED_MARKER: MarkerProbes = { detectedDefaultBranch: null, resolvedMarkerRef: null, isMarkerRefResolvable: null, isMarkerAbsorbedByDefault: null };

type ResolvedMarkerBase = { base: string | null; measureRef: string | null };

type RetiredShareLinks = { projectRealPath: string; shareList: readonly string[] };

type ProjectGitRunner = (args: string[]) => Promise<GitResult>;

type WorktreePort = {
  listWorktreePorcelain(projectPath: string): Promise<GitResult>;
  lockReusedHomeWorktrees(runGitInProject: ProjectGitRunner, porcelain: string): Promise<void>;
  tearDownWorktree(projectPath: string, wt: string, branch: string | null | undefined): Promise<void>;
};

type GitWorkspaceContext = {
  git: GitRunner;
  run(args: string[], cwd: string, extra?: GitExtraOptions): Promise<GitResult>;
  runInProject(projectPath: string): ProjectGitRunner;
  runUntrusted(args: string[], cwd: string, isolation: GitIsolationOptions): Promise<GitResult>;
  log: Pick<Console, 'warn'>;
  rerereEnabled: boolean;
  provenanceNotesRef(projectPath: string): Promise<string | null>;
  serialized<TArgs, TResult>(body: (args: TArgs) => Promise<TResult>): (args: TArgs) => Promise<TResult>;
  admitted<TArgs extends { admissionTimeoutMs?: number }, TResult>(body: (args: TArgs) => Promise<TResult>, refuse: (args: TArgs) => TResult): (args: TArgs) => Promise<TResult>;
  worktrees: WorktreePort;
};

export { ISOLATED_CHECKOUT_BASE_REF, ISOLATED_CHECKOUT_HYDRATE_TIMEOUT_MS, ISOLATED_CHECKOUT_REVIEW_REF, MERGE_PROBE_TIMEOUT_MS, REMOTE_BRANCH_LISTING_MAX_BUFFER, REMOTE_REF_PREFIX, UNPROBED_MARKER, WORKTREE_STATUS_ARGS, WORK_PRESENCE_STATUS_ARGS, directoryExists, errResult, errorExitCode, findWorktreeForBranch, hasWorkFrom, isDirtyResult, mainWorktreePath, markerFrom, markerKey, okResult, parseWorktreeBranches };
export type { BaseClassification, BaseSyncResult, CheckoutDetachedArgs, GitExtraOptions, GitResult, GitRunner, GitWorkspaceContext, IntegrationSyncResult, IntegrationTip, LandedRange, ListedWorktree, MergeFastForwardArgs, MergeFastForwardResult, MergeOutcome, MergeProbeEnvArgs, MergeTreeArgs, MergeTreeProbe, OwnedPathsRecorder, OwnedWorktreeArgs, ProjectGitRunner, QueuedGitResult, RebaseOutcome, RemovalAdmission, RemovalArgs, RemovalGuardOptions, RemovalTarget, ResetKeepArgs, ResolvedMarkerBase, RetiredShareLinks, SessionWorktree, StageDetachedWorktreeArgs, StageIsolatedCheckoutArgs, WorkspaceHandle, WorktreeArgs, WorktreeBranch, WorktreeDirtyProbe, WorktreeOwnership, WorktreeProbe };
