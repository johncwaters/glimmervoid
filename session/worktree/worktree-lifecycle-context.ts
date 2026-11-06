import type { RunGitOptions } from "../../server/git/git-exec.ts";
import type { CoalescedTimer } from "../../shared/coalesce-timer.ts";
import type { SessionState } from "../../shared/states.ts";
import type { createWorktreeWatcher } from "../../detection/worktree-watch.ts";
import type { createIntegrationRefWatcher } from "../../detection/integration-ref-watch.ts";
import type { createRerereWatcher } from "../../detection/rerere-watch.ts";
import type { MergeStatus } from "../core/worktree-state.ts";
import type { DecisionEntry } from "../core/decision-log.ts";
import type { WorktreeArgs } from "../../server/git/git-workspace.ts";
import type { GitWorkspaceInstance } from "../../server/git/git-workspace.ts";
import type { WorkspaceMember } from "../core/workspace-core.ts";
import type { createSessionWorkspaceMembers } from "../session-workspace-members.ts";
import type { OwnedPathOwner } from "../../shared/contracts/owned-paths.ts";
import type { SeedDependencies } from "../../server/git/dependency-clone.ts";
import type { BranchUpstream } from "../../server/core/branch-sync-core.ts";

interface Workspace {
  cwd: string;
  isGit: boolean;
  branch?: string | null;
  base?: string | null;
  baseSha?: string | null;
  reason?: string;
  conflictPath?: string;
  warning?: string | null;
}

interface SessionSnapshot {
  state: SessionState;
  isDestroyed: boolean;
  isTeardownPending: boolean;
  hasLivePty: boolean;
}

interface MergeResult {
  merged: boolean;
  parked?: boolean;
  refused?: boolean;
  reason?: string | null;
  conflicts?: string[];
  baseSha?: string | null;
  restoreConflict?: boolean;
  warning?: string;
  pushed?: boolean;

  branch?: string | null;
  base?: string | null;
  kept?: boolean;
  landedRange?: { fromSha: string; toSha: string } | null;
}

interface BranchSyncStatus {
  branch: string | null;
  upstream: string | null;
  state: string;
  ahead: number;
  behind: number;
  fetched: boolean | null;
  error?: string | null;
}

interface BranchSyncResult extends BranchSyncStatus {
  action: string;
  error: string | null;
}

interface RebaseResult {
  ok?: boolean;
  upToDate?: boolean;
  rebased?: boolean;
  baseSha?: string | null;
  headSha?: string | null;
  rerereReplayed?: boolean;
  reason?: string;
  conflicts?: string[];
}

type WorkspaceArgs = WorktreeArgs;

interface IntegrationSyncResult {
  outcome: string;
  from: string | null;
  to: string | null;
  error?: string;
}

interface GitWorkspace {
  withGitIsolation?: GitWorkspaceInstance["withGitIsolation"];
  create: (args: WorkspaceArgs & { owner: OwnedPathOwner }) => Workspace | Promise<Workspace>;
  populate: (args: WorkspaceArgs) => unknown;
  hasUnmergedWork: (args: WorkspaceArgs) => boolean | Promise<boolean>;
  discard: (args: WorkspaceArgs & { cause: 'session' }) => unknown;
  mergeBack: (args: WorkspaceArgs) => MergeResult | Promise<MergeResult>;
  mergeKeep: (args: WorkspaceArgs) => MergeResult | Promise<MergeResult>;
  rebaseOnly: (args: WorkspaceArgs) => Promise<RebaseResult>;
  resolveRebaseTarget?: (args: WorkspaceArgs) => Promise<string | null>;
  syncIntegrationBranch?: (args: WorkspaceArgs) => Promise<IntegrationSyncResult>;
  detectDefaultBranch?: (options: { projectPath: string }) => Promise<string | null>;
  ensureWorkspaceMember?: GitWorkspaceInstance["ensureWorkspaceMember"];
  removeWorkspaceMember?: GitWorkspaceInstance["removeWorkspaceMember"];
  describeWorkspaceMemberWork?: GitWorkspaceInstance["describeWorkspaceMemberWork"];
  recordOwnedFolder?: GitWorkspaceInstance["recordOwnedFolder"];
  forgetRemovedPath?: GitWorkspaceInstance["forgetRemovedPath"];
  listOwnedPaths?: GitWorkspaceInstance["listOwnedPaths"];
}

type WorkspaceMembersSetup =
  | { ok: true; members: ReturnType<typeof createSessionWorkspaceMembers> }
  | { ok: false; error: string };

interface SessionPort {
  state: () => SessionSnapshot;
  projectPath?: () => string;
  emit: (event: string, detail: Record<string, unknown>) => void;
  recordDecision: (entry: DecisionEntry) => void;
  pasteText: (text: string) => Record<string, unknown>;
  holdWorktreeReaders?: () => Promise<() => void>;
}

interface WorktreeLifecycleOptions {
  id: string;
  projectPath: string;
  integrationBranch?: string | null;
  startSha?: string | null;
  gitWorkspace?: GitWorkspace | null;
  autoRebase?: boolean;
  syncOnStart?: boolean;
  liveWorktreeReview?: boolean;
  worktreeRoot?: string | null;
  worktreeShare?: string[] | null;
  workspaceRepos?: string[] | null;
  seedDependencies?: SeedDependencies | null;
  sessionName?: string;
  port: SessionPort;
}

interface WorktreeLifecycleState {
  worktreeDir: string | null;
  commonGitDir: string | null;
  baseSha: string | null;
  workspace: Workspace | null;
  mergeStatus: MergeStatus;
  mergeReason: string | null;
  mergeConflicts: string[];
  worktreeNotice: string | null;
  effectiveBase: string | null;
  isWorktree: boolean;
  autoRebasing: boolean;
  rebaseConflictKey: string | null;
  resyncPromise: Promise<BranchSyncResult> | null;
  worktreeWatcher: ReturnType<typeof createWorktreeWatcher> | null;
  integrationWatcher: ReturnType<typeof createIntegrationRefWatcher> | null;
  rerereWatcher: ReturnType<typeof createRerereWatcher> | null;
  checkTimer: CoalescedTimer;
  lastSignature: string | null;
  lastLoggedCheckFailure: string | null;
  provisionedMembers: WorkspaceMember[] | null;
}

interface ChangeScope {
  name: string;
  root: string;
  sessionPathPrefix: string;
  base: string | null;
  committedNameStatus: string;
  uncommittedNameStatus: string;
}

interface DiffSection {
  stat: string;
  diff: string;
}

interface MemberDiff {
  name: string;
  committed: DiffSection;
  uncommitted: DiffSection;
  hasCommits: boolean;
  baseRef: string | null;
  baseSha: string;
}

interface AdoptWorktreeOptions {
  worktreeDir: string;
  branch: string | null;
  base?: string | null;
  baseSha?: string | null;
  hasUnmergedWork?: boolean;
  watch?: boolean;
  emit?: boolean;
}

interface WorktreeSignature {
  sig: string;
  dirty: boolean;
  ahead: string;
  behind: string;
  rebaseBehind: string;
  rebaseInProgress: boolean;
  headSha: string;
  targetSha: string | null;
  baseRef: string | null;
}

type MergeEngineOutcome =
  | { result: MergeResult; failure?: undefined }
  | { result?: undefined; failure: MergeResult };

function branchFromHeadRef(headRef: string): string {
  const localBranchPrefix = "refs/heads/";
  return headRef.startsWith(localBranchPrefix) ? headRef.slice(localBranchPrefix.length) : "";
}

function branchFromRemoteRef(upstream: string): string {
  const separatorIndex = upstream.indexOf("/");
  if (separatorIndex === -1) return upstream;
  return upstream.slice(separatorIndex + 1);
}

function isOwnRemoteCopy(upstream: string, branch: string): boolean {
  return branchFromRemoteRef(upstream) === branch;
}

function prefixRenameAndCopyHeaders(diffText: string, memberName: string): string {
  return diffText.replace(/^((?:rename|copy) (?:from|to) )("?)/gm, (_match, keyword: string, openingQuote: string) => `${keyword}${openingQuote}${memberName}/`);
}

type WorktreeLifecycleContext = Required<Pick<WorktreeLifecycleOptions, "id" | "projectPath" | "integrationBranch" | "startSha" | "gitWorkspace" | "syncOnStart" | "worktreeRoot" | "worktreeShare" | "seedDependencies" | "port">> & {
  workspaceMembers: WorkspaceMembersSetup | null;
  lifecycleState: WorktreeLifecycleState;
  currentProjectPath(): string;
  gitOut(args: string[], options: RunGitOptions): Promise<string>;
  gitLookup(args: string[], options: RunGitOptions): Promise<string | null>;
  readUpstreamOf(branch: string, options: RunGitOptions): Promise<string | null>;
  readBranchUpstreamOf(branch: string, options: RunGitOptions): Promise<BranchUpstream | null>;
  effectiveIntegrationBranch(): string | null;
  setMergeStatus(status: MergeStatus, detail?: Record<string, unknown>, options?: { emit?: boolean }): void;
};

export { branchFromHeadRef, branchFromRemoteRef, isOwnRemoteCopy, prefixRenameAndCopyHeaders };
export type { AdoptWorktreeOptions, BranchSyncResult, BranchSyncStatus, ChangeScope, DiffSection, GitWorkspace, IntegrationSyncResult, MemberDiff, MergeEngineOutcome, MergeResult, SessionPort, SessionSnapshot, Workspace, WorkspaceMembersSetup, WorktreeLifecycleContext, WorktreeLifecycleOptions, WorktreeLifecycleState, WorktreeSignature };
