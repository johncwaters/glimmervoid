import type { RunGitOptions } from "../../server/git/git-exec.ts";
import { errorMessage } from "../../shared/text.ts";
import { decideBaseSyncDemotion } from "../core/merge-gate.ts";
import { GIT_FETCH_TIMEOUT_MS, parseLeftRightCount, decideBranchSyncState, isLocalRemote, decideResyncAction, buildResyncCommand, firstGitErrorLine } from "../../server/core/branch-sync-core.ts";
import type { BranchUpstream } from "../../server/core/branch-sync-core.ts";
import type { BranchSyncResult, BranchSyncStatus, WorktreeLifecycleContext } from "./worktree-lifecycle-context.ts";

function createWorktreeBranchSync(context: WorktreeLifecycleContext) {
  const { id, lifecycleState, currentProjectPath, gitOut, readBranchUpstreamOf, effectiveIntegrationBranch, setMergeStatus } = context;

  function noUpstream(branch: string | null) {
    return {
      branch: branch || null,
      upstream: null,
      state: decideBranchSyncState({ hasUpstream: false }),
      ahead: 0,
      behind: 0,
      fetched: null,
    };
  }

  async function fetchUpstream({ remote, remoteBranch }: BranchUpstream, opts: RunGitOptions): Promise<boolean | null> {
    if (isLocalRemote(remote)) return null;
    try {
      await gitOut(["fetch", "--quiet", remote, remoteBranch], {
        ...opts,
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
        replaceEnv: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return true;
    } catch (error) {
      console.warn(`[session ${id}] fetch of ${remote}/${remoteBranch} failed: ${errorMessage(error)}`);
      return false;
    }
  }

  async function branchCounts(upstream: string, branch: string, opts: RunGitOptions) {
    const counts = parseLeftRightCount(await gitOut(["rev-list", "--left-right", "--count", `${upstream}...${branch}`], opts));
    return {
      ahead: counts ? counts.ahead : 0,
      behind: counts ? counts.behind : 0,
      state: decideBranchSyncState({ hasUpstream: true, ahead: counts?.ahead, behind: counts?.behind }),
    };
  }

  function applyBaseSyncDemotion<T extends { state: string }>(sync: T): T {
    const nextStatus = decideBaseSyncDemotion(
      lifecycleState.mergeStatus,
      lifecycleState.mergeReason,
      sync.state,
    );
    if (nextStatus !== null) setMergeStatus(nextStatus);
    return sync;
  }

  function branchSyncFailure(branch: string, error: unknown): BranchSyncStatus & { error: string } {
    console.warn(`[session ${id}] branch sync check of ${branch} failed: ${errorMessage(error)}`);
    return {
      branch,
      upstream: null,
      state: decideBranchSyncState({ hasUpstream: true }),
      ahead: 0,
      behind: 0,
      fetched: null,
      error: firstGitErrorLine(error),
    };
  }

  async function getBranchSync(): Promise<BranchSyncStatus> {
    const branch = effectiveIntegrationBranch();
    if (!branch || !currentProjectPath()) return noUpstream(branch);
    return readBranchSync(branch).catch((error: unknown) => branchSyncFailure(branch, error));
  }

  async function isGitRepository(opts: RunGitOptions): Promise<boolean> {
    try {
      await gitOut(["rev-parse", "--is-inside-work-tree"], opts);
      return true;
    } catch (error) {
      const failure = error as { stderr?: unknown; message?: unknown } | null;
      if (`${String(failure?.stderr ?? "")}\n${String(failure?.message ?? "")}`.includes("not a git repository")) return false;
      throw error;
    }
  }

  async function readBranchSync(branch: string): Promise<BranchSyncStatus> {
    const opts: RunGitOptions = { cwd: currentProjectPath(), timeoutMs: 10000 };
    if (!(await isGitRepository(opts))) return noUpstream(branch);
    const branchUpstream = await readBranchUpstreamOf(branch, opts);
    if (!branchUpstream) return noUpstream(branch);
    const { upstream } = branchUpstream;
    const fetched = await fetchUpstream(branchUpstream, opts);
    return applyBaseSyncDemotion({ branch, upstream, fetched, ...(await branchCounts(upstream, branch, opts)) });
  }

  async function resyncBranchBody(): Promise<BranchSyncResult> {
    const branch = effectiveIntegrationBranch();
    if (!branch || !currentProjectPath()) return { ...noUpstream(branch), action: "none", error: null };
    return resyncKnownBranch(branch).catch((error: unknown) => ({ ...branchSyncFailure(branch, error), action: "none" }));
  }

  async function resyncKnownBranch(branch: string): Promise<BranchSyncResult> {
    const opts: RunGitOptions = { cwd: currentProjectPath(), timeoutMs: 10000 };
    if (!(await isGitRepository(opts))) return { ...noUpstream(branch), action: "none", error: null };
    const branchUpstream = await readBranchUpstreamOf(branch, opts);
    if (!branchUpstream) return { ...noUpstream(branch), action: "none", error: null };
    const { upstream, remote, remoteBranch } = branchUpstream;
    const fetched = await fetchUpstream(branchUpstream, opts);
    const before = await branchCounts(upstream, branch, opts);
    const checkedOut = (await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], opts)).trim();
    const decision = decideResyncAction(before.state, checkedOut === branch);
    let action = "none";
    let error: string | null = null;
    const command = buildResyncCommand(decision, { upstream, branch, remote, remoteBranch });
    if (command) {
      try {
        await gitOut(command.args, { ...opts, timeoutMs: command.timeoutMs ?? opts.timeoutMs });
        action = command.successAction;
      } catch (commandError) {
        console.warn(`[session ${id}] resync of ${branch} failed: ${errorMessage(commandError)}`);
        error = firstGitErrorLine(commandError);
      }
    }
    return applyBaseSyncDemotion({ branch, upstream, fetched, ...(await branchCounts(upstream, branch, opts)), action, error });
  }

  function resyncBranch(): Promise<BranchSyncResult> {
    if (lifecycleState.resyncPromise) return lifecycleState.resyncPromise;
    lifecycleState.resyncPromise = resyncBranchBody().finally(() => { lifecycleState.resyncPromise = null; });
    return lifecycleState.resyncPromise;
  }

  return { getBranchSync, resyncBranch };
}

export { createWorktreeBranchSync };
