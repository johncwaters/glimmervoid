import type { GitIsolationOptions } from "../server/git/core/git-invocation-core.ts";
import { gitCommandFailure, runGit } from "../server/git/git-exec.ts";
import type { RunGitOptions } from "../server/git/git-exec.ts";
import { errorMessage } from "../shared/text.ts";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "../server/child-process-safe.ts";
import { createCoalescedTimer } from "../shared/coalesce-timer.ts";
import { STATES, MERGEABLE_LIVE_STATES, RESTARTABLE_STATES } from "../shared/states.ts";
import { createWorktreeWatcher, readWorktreeGitdirPointer } from "../detection/worktree-watch.ts";
import { createIntegrationRefWatcher } from "../detection/integration-ref-watch.ts";
import { createRerereWatcher } from "../detection/rerere-watch.ts";
import { buildMergePrompt } from "./core/merge-prompt.ts";
import { decideSignatureDemotion } from "./core/merge-gate.ts";
import { decideAutoRebase, decideRerereCooldownClear, AUTO_REBASE_STATES, SPAWN_GAP_TRIGGER } from "./core/rebase-gate.ts";
import { nextMergeState } from "./core/worktree-state.ts";
import type { MergeStatus } from "./core/worktree-state.ts";
import { BRANCH_UPSTREAM_FORMAT, parseBranchUpstream } from "../server/core/branch-sync-core.ts";
import type { BranchUpstream } from "../server/core/branch-sync-core.ts";
import { planWorkspaceMembers } from "./core/workspace-core.ts";
import { sanitizeWorktreeName } from "../shared/paths.ts";
import { createSessionWorkspaceMembers } from "./session-workspace-members.ts";
import type { WorkspaceMemberGit } from "./session-workspace-members.ts";
import type { KeptWorkPath } from "../shared/contracts/control-messages.ts";
import type { AdoptWorktreeOptions, GitWorkspace, MergeEngineOutcome, MergeResult, Workspace, WorkspaceMembersSetup, WorktreeLifecycleContext, WorktreeLifecycleOptions, WorktreeLifecycleState, WorktreeSignature } from "./worktree/worktree-lifecycle-context.ts";
import { createWorktreeProvisioning } from "./worktree/worktree-provisioning.ts";
import { createWorktreeDiffScopes } from "./worktree/worktree-diff-scopes.ts";
import { createWorktreeBranchSync } from "./worktree/worktree-branch-sync.ts";
import { clock } from '../shared/clock.ts';

const WORKTREE_CHECK_DEBOUNCE_MS = 400;
const GIT_NOT_FOUND_EXIT_CODE = 1;

function workspaceMemberGit(gitWorkspace: GitWorkspace | null): WorkspaceMemberGit | null {
  if (!gitWorkspace) return null;
  const { ensureWorkspaceMember, removeWorkspaceMember, describeWorkspaceMemberWork, recordOwnedFolder, forgetRemovedPath } = gitWorkspace;
  if (!ensureWorkspaceMember || !removeWorkspaceMember || !describeWorkspaceMemberWork || !recordOwnedFolder || !forgetRemovedPath) return null;
  const listOwnedPaths = gitWorkspace.listOwnedPaths ?? (async () => []);
  return { ensureWorkspaceMember, removeWorkspaceMember, describeWorkspaceMemberWork, recordOwnedFolder, forgetRemovedPath, listOwnedPaths };
}

async function readGitStrict(args: string[], options: RunGitOptions): Promise<string> {
  const command = await runGit(args, { ...options, trim: false });
  if (!command.ok) throw gitCommandFailure(args, command, options.timeoutMs);
  return command.out;
}

function stopWatcher(watcher: { stop: () => void } | null): null {
  if (!watcher) return null;
  try { watcher.stop(); } catch {}
  return null;
}

function detectLinkedWorktree(directory: string): boolean {
  return readWorktreeGitdirPointer(directory) !== null;
}

function setUpWorkspaceMembers({ folder, sessionId, sessionName, repoPaths, shareList, gitWorkspace }: {
  folder: string;
  sessionId: string;
  sessionName: string;
  repoPaths: string[];
  shareList: string[] | null;
  gitWorkspace: GitWorkspace | null;
}): WorkspaceMembersSetup {
  const planned = planWorkspaceMembers({ folder, sessionId, repoPaths });
  if (!planned.ok) return planned;
  const memberGit = workspaceMemberGit(gitWorkspace);
  if (!memberGit) return { ok: false, error: "Git workspace is unavailable" };
  return {
    ok: true,
    members: createSessionWorkspaceMembers({ plan: planned.plan, owner: `session:${sessionId}`, sessionName, shareList, gitWorkspace: memberGit }),
  };
}

function createSessionWorktreeLifecycle({
  id,
  projectPath,
  integrationBranch = null,
  startSha = null,
  gitWorkspace = null,
  autoRebase = true,
  syncOnStart = true,
  liveWorktreeReview = true,
  worktreeRoot = null,
  worktreeShare = null,
  workspaceRepos = null,
  seedDependencies = null,
  sessionName = id,
  port,
}: WorktreeLifecycleOptions) {
  const currentProjectPath = (): string => port.projectPath ? port.projectPath() : projectPath;
  function gitOut(args: string[], options: RunGitOptions): Promise<string> {
    return readGitStrict(args, options);
  }
  function gitLookup(args: string[], options: RunGitOptions): Promise<string | null> {
    return gitOut(args, options).catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === GIT_NOT_FOUND_EXIT_CODE) return null;
      throw error;
    });
  }
  async function readBranchUpstreamOf(branch: string, options: RunGitOptions): Promise<BranchUpstream | null> {
    return parseBranchUpstream(await gitOut(["for-each-ref", `--format=${BRANCH_UPSTREAM_FORMAT}`, `refs/heads/${branch}`], options), branch);
  }
  async function readUpstreamOf(branch: string, options: RunGitOptions): Promise<string | null> {
    return (await readBranchUpstreamOf(branch, options))?.upstream ?? null;
  }
  const workspaceMembers = workspaceRepos
    ? setUpWorkspaceMembers({ folder: currentProjectPath(), sessionId: id, sessionName, repoPaths: workspaceRepos, shareList: worktreeShare, gitWorkspace })
    : null;
  const lifecycleState: WorktreeLifecycleState = {
    worktreeDir: null,
    commonGitDir: null,
    baseSha: null,
    workspace: null,
    mergeStatus: "none",
    mergeReason: null,
    mergeConflicts: [],
    worktreeNotice: null,
    effectiveBase: null,
    isWorktree: detectLinkedWorktree(currentProjectPath()),
    autoRebasing: false,
    rebaseConflictKey: null,
    resyncPromise: null,
    worktreeWatcher: null,
    integrationWatcher: null,
    rerereWatcher: null,
    checkTimer: createCoalescedTimer({
      mode: "leading",
      delayMs: WORKTREE_CHECK_DEBOUNCE_MS,
      run: () => {
        api.checkWorktreeChange().catch(recordWorktreeCheckFailure);
      },
    }),
    lastSignature: null,
    lastLoggedCheckFailure: null,
    provisionedMembers: null,
  };

  function effectiveIntegrationBranch() {
    return lifecycleState.workspace?.base || lifecycleState.effectiveBase || integrationBranch || null;
  }

  function snapshot() {
    return {
      worktreeDir: lifecycleState.worktreeDir,
      commonGitDir: lifecycleState.commonGitDir,
      baseSha: lifecycleState.baseSha,
      mergeStatus: lifecycleState.mergeStatus,
      mergeReason: lifecycleState.mergeReason,
      mergeConflicts: [...lifecycleState.mergeConflicts],
      worktreeNotice: lifecycleState.worktreeNotice,
      effectiveBase: effectiveIntegrationBranch(),
      isWorktree: lifecycleState.isWorktree,
      isWorkspace: workspaceMembers !== null,
      isAutoRebasing: lifecycleState.autoRebasing,
      hasConflictCooldown: Boolean(lifecycleState.rebaseConflictKey),
      hasPendingCheck: lifecycleState.checkTimer.isArmed,
    };
  }

  function getCarry(): { worktreeDir: string; branch: string | null; base: string | null } | null {
    if (!lifecycleState.worktreeDir || !lifecycleState.workspace) return null;
    return {
      worktreeDir: lifecycleState.worktreeDir,
      branch: lifecycleState.workspace.branch || null,
      base: lifecycleState.workspace.base || null,
    };
  }

  function hasOwnWorktree(): boolean {
    return Boolean(gitWorkspace && lifecycleState.workspace);
  }

  function setMergeStatus(status: MergeStatus, detail: Record<string, unknown> = {}, { emit = true }: { emit?: boolean } = {}): void {
    const nextState = nextMergeState(lifecycleState.mergeStatus, status, detail);
    if (!nextState) {
      console.warn(`[session ${id}] merge status ${lifecycleState.mergeStatus} cannot move to ${status}`);
      return;
    }
    Object.assign(lifecycleState, nextState);
    if (!emit) return;
    port.emit("merge-status", { id, mergeStatus: status, ...detail });
  }

  const isMerging = (): boolean => lifecycleState.mergeStatus === "merging";

  function effectiveCwd(): string {
    return lifecycleState.worktreeDir || currentProjectPath();
  }

  function refreshGitContext(): boolean {
    const next = detectLinkedWorktree(effectiveCwd());
    if (next === lifecycleState.isWorktree) return false;
    lifecycleState.isWorktree = next;
    return true;
  }

  function resolveCommonGitDir(): string | null {
    if (!lifecycleState.worktreeDir) return null;
    try {
      const invocation = { args: ['rev-parse', '--git-common-dir'], env: process.env };
      const commonDir = execFileSync("git", invocation.args, {
        env: invocation.env,
        cwd: lifecycleState.worktreeDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      });
      return path.resolve(lifecycleState.worktreeDir, commonDir.trim());
    } catch {
      return null;
    }
  }

  function clearCheckTimer(): void {
    lifecycleState.checkTimer.cancel();
  }

  function scheduleCheck(): void {
    const session = port.state();
    if (session.isDestroyed) return;
    if (!lifecycleState.worktreeDir && !lifecycleState.provisionedMembers) return;
    lifecycleState.checkTimer.schedule();
  }

  function stopWatching(): void {
    lifecycleState.worktreeWatcher = stopWatcher(lifecycleState.worktreeWatcher);
    lifecycleState.integrationWatcher = stopWatcher(lifecycleState.integrationWatcher);
    lifecycleState.rerereWatcher = stopWatcher(lifecycleState.rerereWatcher);
    clearCheckTimer();
    lifecycleState.lastSignature = null;
  }

  function onRerereRecorded(): void {
    const session = port.state();
    const verdict = decideRerereCooldownClear({
      enabled: autoRebase !== false && Boolean(gitWorkspace && lifecycleState.workspace),
      hasCooldown: Boolean(lifecycleState.rebaseConflictKey),
      teardownPending: session.isTeardownPending,
    });
    if (!verdict.clear) return;
    port.recordDecision({ kind: "rebase", ts: clock.nowMs(), decision: "cooldown-cleared", reason: verdict.reason });
    lifecycleState.rebaseConflictKey = null;
    scheduleCheck();
  }

  function startWatching(): void {
    stopWatching();
    const session = port.state();
    if (session.isDestroyed || !lifecycleState.worktreeDir) return;
    const onChange = (): void => scheduleCheck();
    lifecycleState.worktreeWatcher = createWorktreeWatcher({ worktreeDir: lifecycleState.worktreeDir, onChange });
    lifecycleState.worktreeWatcher.start();
    const watchedBranch = effectiveIntegrationBranch();
    if (liveWorktreeReview === false || !lifecycleState.commonGitDir || !watchedBranch) return;
    lifecycleState.integrationWatcher = createIntegrationRefWatcher({
      commonGitDir: lifecycleState.commonGitDir,
      branch: watchedBranch,
      onChange,
    });
    lifecycleState.integrationWatcher.start();
    lifecycleState.rerereWatcher = createRerereWatcher({
      commonGitDir: lifecycleState.commonGitDir,
      onChange: onRerereRecorded,
    });
    lifecycleState.rerereWatcher.start();
  }

  function adoptWorktree({
    worktreeDir,
    branch,
    base,
    baseSha = null,
    hasUnmergedWork: hasUnmerged = true,
    watch = true,
    emit = true,
  }: AdoptWorktreeOptions): void {
    if (!worktreeDir) return;
    const resolvedBase = base || integrationBranch || null;
    lifecycleState.workspace = { cwd: worktreeDir, isGit: true, branch, base: resolvedBase, baseSha };
    lifecycleState.effectiveBase = resolvedBase;
    lifecycleState.worktreeDir = worktreeDir;
    lifecycleState.baseSha = baseSha;
    lifecycleState.commonGitDir = resolveCommonGitDir();
    lifecycleState.isWorktree = true;
    setMergeStatus(hasUnmerged ? "pending-review" : "none", {}, { emit });
    if (watch) startWatching();
  }

  const context: WorktreeLifecycleContext = {
    id, projectPath, integrationBranch, startSha, gitWorkspace, syncOnStart, worktreeRoot, worktreeShare, seedDependencies, port, workspaceMembers, lifecycleState, currentProjectPath, gitOut, gitLookup, readUpstreamOf, readBranchUpstreamOf, effectiveIntegrationBranch, setMergeStatus,
  };
  const { provision, stopSeeding } = createWorktreeProvisioning(context, { adoptWorktree, resolveCommonGitDir, runAutoRebase, api: { computeWorktreeSignature: () => api.computeWorktreeSignature() } });
  const { resolveEffectiveBase, resolveVerifiedBaseRef, diffGitOptions, getChangeScopes, getDiff, getDiffFileContents } = createWorktreeDiffScopes(context);
  const { getBranchSync, resyncBranch } = createWorktreeBranchSync(context);

  async function hasUnmergedWork(): Promise<boolean> {
    if (!lifecycleState.worktreeDir) return false;
    if (!gitWorkspace || !lifecycleState.workspace) return true;
    try {
      return await gitWorkspace.hasUnmergedWork({
        projectPath: currentProjectPath(),
        workspace: lifecycleState.workspace,
        integrationBranch: effectiveIntegrationBranch(),
        configuredIntegrationBranch: integrationBranch,
      });
    } catch {
      return true;
    }
  }

  function clearWorktreeState(status: MergeStatus): void {
    lifecycleState.workspace = null;
    lifecycleState.worktreeDir = null;
    lifecycleState.commonGitDir = null;
    lifecycleState.isWorktree = false;
    setMergeStatus(status);
  }

  let isWorkspaceWorkDiscardConfirmed = false;

  function confirmWorkspaceWorkDiscard(): void {
    isWorkspaceWorkDiscardConfirmed = true;
  }

  let checkoutMembers: ReturnType<typeof createSessionWorkspaceMembers> | null = null;

  const checkoutOwner = `session:${id}` as const;
  const checkoutBranch = `glimmervoid/workspace/${id}`;
  let recordedCheckoutsLoad: Promise<void> | null = null;

  function createCheckoutMembers(folder: string, memberGit: NonNullable<ReturnType<typeof workspaceMemberGit>>) {
    return createSessionWorkspaceMembers({ plan: { folder, branch: checkoutBranch, members: [] }, owner: checkoutOwner, sessionName, shareList: worktreeShare, gitWorkspace: memberGit });
  }

  async function adoptRecordedCheckouts(): Promise<void> {
    const memberGit = workspaceMemberGit(gitWorkspace);
    if (!memberGit) return;
    const entries = await memberGit.listOwnedPaths(checkoutOwner).catch(() => []);
    if (workspaceMembers?.ok) await workspaceMembers.members.adopt(entries);
    const checkoutFolder = entries.find((entry) => entry.kind === 'folder' && path.basename(entry.path).startsWith('checkouts-'));
    if (!checkoutFolder || checkoutMembers) return;
    checkoutMembers = createCheckoutMembers(checkoutFolder.path, memberGit);
    await checkoutMembers.adopt(entries);
  }

  function loadRecordedCheckouts(): Promise<void> {
    recordedCheckoutsLoad ??= adoptRecordedCheckouts();
    return recordedCheckoutsLoad;
  }

  async function addCheckout({ repoPath, checkoutRoot }: { repoPath: string; checkoutRoot: string }): Promise<{ ok: true; path: string; branch: string } | { ok: false; error: string }> {
    await loadRecordedCheckouts();
    if (workspaceMembers?.ok) return workspaceMembers.members.add(repoPath);
    if (workspaceMembers) return { ok: false, error: workspaceMembers.error };
    if (checkoutMembers) return checkoutMembers.add(repoPath);
    const memberGit = workspaceMemberGit(gitWorkspace);
    if (!memberGit) return { ok: false, error: "Git workspace is unavailable" };
    const folder = path.join(checkoutRoot, `checkouts-${sanitizeWorktreeName(sessionName) || "session"}-${id.slice(0, 8)}`);
    checkoutMembers = createCheckoutMembers(folder, memberGit);
    return checkoutMembers.add(repoPath);
  }

  async function hasWorkspaceMembers(): Promise<boolean> {
    await loadRecordedCheckouts();
    return workspaceMembers !== null || checkoutMembers !== null;
  }

  async function findWorkspaceKeptWork(): Promise<KeptWorkPath[]> {
    await loadRecordedCheckouts();
    const workspaceKept = workspaceMembers?.ok ? await workspaceMembers.members.findKeptWork() : [];
    const checkoutKept = checkoutMembers ? await checkoutMembers.findKeptWork() : [];
    return [...workspaceKept, ...checkoutKept];
  }

  async function releaseWorkspaceMembers(members: ReturnType<typeof createSessionWorkspaceMembers>, keepRepoPaths: string[] = []): Promise<void> {
    const released = await members.release({ keepRepoPaths, discardWork: isWorkspaceWorkDiscardConfirmed });
    if (released.kept.length === 0) return;
    console.warn(`[session ${id}] kept workspace members: ${released.kept.map((kept) => `${kept.path} (${kept.reason})`).join(", ")}`);
  }

  async function releaseDroppedWorkspaceMembers(keepRepoPaths: string[]): Promise<void> {
    if (!workspaceMembers?.ok) return;
    await releaseWorkspaceMembers(workspaceMembers.members, keepRepoPaths);
  }

  async function releaseCheckouts(): Promise<void> {
    await loadRecordedCheckouts();
    if (checkoutMembers) await releaseWorkspaceMembers(checkoutMembers);
  }

  async function discardWorktree(): Promise<void> {
    const releaseWorktreeReaders = await port.holdWorktreeReaders?.();
    try { await discardHeldWorktree(); }
    finally { releaseWorktreeReaders?.(); }
  }

  async function discardHeldWorktree(): Promise<void> {
    await stopSeeding();
    await releaseCheckouts();
    if (workspaceMembers?.ok) return releaseWorkspaceMembers(workspaceMembers.members);
    stopWatching();
    if (gitWorkspace && lifecycleState.workspace) {
      try { await gitWorkspace.discard({ projectPath: currentProjectPath(), workspace: lifecycleState.workspace, cause: 'session' }); } catch {}
    }
    clearWorktreeState("none");
  }

  async function discardIfClean(): Promise<boolean> {
    if (!lifecycleState.worktreeDir) return false;
    if (await hasUnmergedWork()) return false;
    await discardWorktree();
    return true;
  }

  async function settleOnExit(): Promise<void> {
    const session = port.state();
    if (session.isDestroyed || !gitWorkspace || !lifecycleState.workspace) return;
    if (!RESTARTABLE_STATES.includes(session.state)) return;
    if (await discardIfClean()) return;
    setMergeStatus("pending-review");
  }

  function pasteMergePrompt(): Record<string, unknown> {
    const session = port.state();
    if (session.isDestroyed) return { ok: false, reason: "destroyed" };
    if (lifecycleState.mergeStatus !== "parked") return { ok: false, reason: "not-parked" };
    if (!session.hasLivePty) return { ok: false, reason: "no-pty" };
    return port.pasteText(buildMergePrompt({
      branch: lifecycleState.workspace?.branch || undefined,
      target: effectiveIntegrationBranch() || undefined,
      reason: lifecycleState.mergeReason || undefined,
      conflicts: lifecycleState.mergeConflicts,
      worktreeDir: lifecycleState.worktreeDir || undefined,
    }));
  }

  function statusPathsOf(porcelainZ: string): string[] {
    const entries = porcelainZ.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      paths.push(entry.slice(3));
      if (/^[RC]/.test(entry)) index += 1;
    }
    return paths;
  }

  async function readChangedFileStamps(worktreeDir: string, porcelainZ: string): Promise<string> {
    const stamps = await Promise.all(statusPathsOf(porcelainZ).map(async (changedPath) => {
      const stats = await fs.promises.lstat(path.join(worktreeDir, changedPath)).catch(() => null);
      return stats ? `${changedPath}:${stats.size}:${stats.mtimeMs}` : `${changedPath}:gone`;
    }));
    return stamps.join("\0");
  }

  async function computeWorktreeSignature(): Promise<WorktreeSignature | null> {
    const worktreeDir = lifecycleState.worktreeDir;
    if (!worktreeDir) return null;
    const opts: RunGitOptions = { cwd: worktreeDir, timeoutMs: 10000, maxBuffer: 16 * 1024 * 1024 };
    const run = (args: string[]): Promise<string> => gitOut(["--no-optional-locks", ...args], opts);
    let status: string;
    let changedFileStamps: string;
    let head: string;
    let ahead = "0";
    let behind = "0";
    let rebaseBehind = "0";
    let rebaseInProgress = false;
    let targetSha: string | null = null;
    let baseRef: string | null = null;
    try {
      status = await run(["status", "--porcelain", "-z", "--untracked-files=all"]);
      changedFileStamps = await readChangedFileStamps(worktreeDir, status);
      head = (await run(["rev-parse", "HEAD"])).trim();
      baseRef = (await resolveVerifiedBaseRef(opts)).ref;
      if (baseRef) ahead = (await run(["rev-list", "--count", `${baseRef}..HEAD`])).trim();
      const mergeTarget = effectiveIntegrationBranch() || lifecycleState.baseSha;
      const resolvedTarget = mergeTarget ? (await gitLookup(["rev-parse", "--verify", "--quiet", mergeTarget], opts))?.trim() ?? "" : "";
      if (resolvedTarget) {
        targetSha = resolvedTarget;
        behind = (await run(["rev-list", "--count", `HEAD..${mergeTarget}`])).trim();
        rebaseBehind = behind;
      }
      const rebaseTargetSha = gitWorkspace?.resolveRebaseTarget && lifecycleState.workspace
        ? await gitWorkspace.resolveRebaseTarget({ projectPath: currentProjectPath(), workspace: lifecycleState.workspace, targetBranch: effectiveIntegrationBranch() })
        : null;
      if (rebaseTargetSha) {
        targetSha = rebaseTargetSha;
        rebaseBehind = (await run(["rev-list", "--count", `HEAD..${rebaseTargetSha}`])).trim();
      }
      const rebaseMerge = (await run(["rev-parse", "--git-path", "rebase-merge"])).trim();
      const rebaseApply = (await run(["rev-parse", "--git-path", "rebase-apply"])).trim();
      const resolveGitPath = (gitPath: string): string => path.isAbsolute(gitPath) ? gitPath : path.resolve(worktreeDir, gitPath);
      rebaseInProgress = fs.existsSync(resolveGitPath(rebaseMerge)) || fs.existsSync(resolveGitPath(rebaseApply));
    } catch (error) {
      recordWorktreeCheckFailure(error);
      return null;
    }
    lifecycleState.lastLoggedCheckFailure = null;
    const sig = crypto.createHash("sha1").update(`${status} ${changedFileStamps} ${head} ${ahead}`).digest("hex");
    return { sig, dirty: status.trim() !== "", ahead, behind, rebaseBehind, rebaseInProgress, headSha: head, targetSha, baseRef };
  }

  async function runAutoRebase(trigger: string, signature: WorktreeSignature): Promise<void> {
    if (lifecycleState.autoRebasing) return;
    const session = port.state();
    if (session.isDestroyed) return;
    const currentKey = `${signature.headSha || ""}::${signature.targetSha || ""}`;
    const verdict = decideAutoRebase({
      enabled: autoRebase !== false && Boolean(gitWorkspace && lifecycleState.workspace),
      trigger,
      state: session.state,
      hasLivePty: session.hasLivePty,
      mergeStatus: lifecycleState.mergeStatus,
      dirty: signature.dirty,
      behind: signature.rebaseBehind,
      rebaseInProgress: signature.rebaseInProgress,
      teardownPending: session.isTeardownPending,
      currentKey,
      lastConflictKey: lifecycleState.rebaseConflictKey,
    });
    if (verdict.action !== "rebase") {
      if (trigger === SPAWN_GAP_TRIGGER) {
        port.recordDecision({ kind: "rebase", ts: clock.nowMs(), decision: "skipped", trigger, reason: verdict.reason });
      }
      return;
    }
    if (!gitWorkspace || !lifecycleState.workspace) return;
    const workspace = lifecycleState.workspace;
    lifecycleState.autoRebasing = true;
    try {
      const rebase = await gitWorkspace.rebaseOnly({
        projectPath: currentProjectPath(),
        workspace,
        targetBranch: effectiveIntegrationBranch(),
      });
      const currentSession = port.state();
      if (trigger !== SPAWN_GAP_TRIGGER && !AUTO_REBASE_STATES.includes(currentSession.state)) {
        port.recordDecision({ kind: "rebase", ts: clock.nowMs(), decision: "state-moved", state: currentSession.state });
      }
      if (rebase?.ok && rebase.rebased) {
        lifecycleState.rebaseConflictKey = null;
        if (rebase.baseSha) {
          lifecycleState.baseSha = rebase.baseSha;
          workspace.baseSha = rebase.baseSha;
        }
        port.recordDecision({
          kind: "rebase",
          ts: clock.nowMs(),
          decision: "auto-rebased",
          trigger,
          from: signature.headSha || null,
          to: rebase.headSha || null,
          rerereReplayed: rebase.rerereReplayed === true,
        });
        return;
      }
      if (rebase?.reason === "rebase-conflict") {
        lifecycleState.rebaseConflictKey = currentKey;
        port.recordDecision({ kind: "rebase", ts: clock.nowMs(), decision: "conflict", trigger, conflicts: rebase.conflicts || [] });
      }
    } catch (error) {
      console.warn(`[session ${id}] auto-rebase failed: ${errorMessage(error)}`);
    } finally {
      lifecycleState.autoRebasing = false;
      scheduleCheck();
    }
  }

  async function readMemberHeads(): Promise<{ name: string; head: string }[]> {
    const memberHeads: { name: string; head: string }[] = [];
    for (const member of lifecycleState.provisionedMembers ?? []) {
      const memberDirStats = await fs.promises.stat(member.dir).catch(() => null);
      if (!memberDirStats?.isDirectory()) continue;
      memberHeads.push({ name: member.name, head: (await gitOut(["rev-parse", "HEAD"], diffGitOptions(member.dir))).trim() });
    }
    return memberHeads;
  }

  function recordWorktreeCheckFailure(error: unknown): void {
    lifecycleState.lastSignature = null;
    const failure = errorMessage(error);
    if (failure === lifecycleState.lastLoggedCheckFailure) return;
    lifecycleState.lastLoggedCheckFailure = failure;
    console.warn(`[session ${id}] worktree check failed: ${failure}`);
  }

  async function checkWorkspaceChange(): Promise<void> {
    const signaturePayload = { scopes: await getChangeScopes(), memberHeads: await readMemberHeads() };
    lifecycleState.lastLoggedCheckFailure = null;
    const sig = crypto.createHash("sha1").update(JSON.stringify(signaturePayload)).digest("hex");
    if (port.state().isDestroyed || sig === lifecycleState.lastSignature) return;
    lifecycleState.lastSignature = sig;
    port.emit("worktree-changed", { id, sig });
  }

  async function checkWorktreeChange(signatureOverride?: WorktreeSignature | null): Promise<void> {
    if (lifecycleState.provisionedMembers) return checkWorkspaceChange();
    let session = port.state();
    if (session.isDestroyed || !lifecycleState.worktreeDir || isMerging()) return;
    if (lifecycleState.autoRebasing) return;
    const signature = signatureOverride || await api.computeWorktreeSignature();
    session = port.state();
    if (session.isDestroyed || isMerging() || !signature) return;
    const nextStatus = decideSignatureDemotion(lifecycleState.mergeStatus, signature);
    const demoted = nextStatus !== null;
    if (demoted) setMergeStatus(nextStatus);
    await runAutoRebase("change", signature);
    session = port.state();
    if (session.isDestroyed || isMerging()) return;
    if (signature.sig === lifecycleState.lastSignature && !demoted) return;
    lifecycleState.lastSignature = signature.sig;
    port.emit("worktree-changed", { id, sig: signature.sig, headSha: signature.headSha, baseRef: signature.rebaseInProgress ? null : signature.baseRef });
  }

  async function runMergeEngine(
    workspaceApi: GitWorkspace,
    workspace: Workspace,
    method: "mergeBack" | "mergeKeep",
    isolation?: GitIsolationOptions,
  ): Promise<MergeEngineOutcome> {
    setMergeStatus("merging");
    try {
      const merge = () => workspaceApi[method]({
        projectPath: currentProjectPath(),
        workspace,
        targetBranch: effectiveIntegrationBranch(),
      });
      if (isolation && !workspaceApi.withGitIsolation) throw new Error("Merge requires Git isolation");
      const mergeResult = await (isolation && workspaceApi.withGitIsolation ? workspaceApi.withGitIsolation(isolation, merge) : merge());
      if (mergeResult.warning) port.emit("worktree-warning", { id, branch: effectiveIntegrationBranch(), notice: mergeResult.warning });
      if (mergeResult.merged && mergeResult.landedRange) port.emit("commits-landed", { id, repoDir: currentProjectPath(), basePushed: mergeResult.pushed === true, ...mergeResult.landedRange });
      return { result: mergeResult };
    } catch (error) {
      setMergeStatus("pending-review", { reason: errorMessage(error) });
      return { failure: { merged: false, reason: errorMessage(error) } };
    }
  }

  function applyParkedOrPending(mergeResult: MergeResult): MergeResult {
    if (mergeResult.parked) {
      setMergeStatus("parked", { reason: mergeResult.reason || null, conflicts: mergeResult.conflicts || [] });
      return mergeResult;
    }
    setMergeStatus("pending-review", { reason: mergeResult.reason || null });
    return mergeResult;
  }

  async function mergeWorktree(isolation?: GitIsolationOptions): Promise<MergeResult> {
    if (!gitWorkspace || !lifecycleState.workspace) return { merged: false, refused: true, reason: "no-worktree" };
    const workspace = lifecycleState.workspace;
    if (isMerging()) return { merged: false, refused: true, reason: "merge-in-progress" };
    const { result: mergeResult, failure } = await runMergeEngine(gitWorkspace, workspace, "mergeBack", isolation);
    if (failure) return failure;
    if (!mergeResult.merged) return applyParkedOrPending(mergeResult);
    stopWatching();
    clearWorktreeState("merged");
    return mergeResult;
  }

  async function mergeAndContinue({ force = false }: { force?: boolean } = {}): Promise<MergeResult> {
    const session = port.state();
    if (session.isDestroyed) return { merged: false, refused: true, reason: "destroyed" };
    if (!gitWorkspace || !lifecycleState.workspace) return { merged: false, refused: true, reason: "no-worktree" };
    const workspace = lifecycleState.workspace;
    const runningOverride = force && session.state === STATES.RUNNING;
    if (!MERGEABLE_LIVE_STATES.includes(session.state) && !runningOverride) {
      return { merged: false, refused: true, reason: "not-continuable" };
    }
    if (isMerging()) return { merged: false, refused: true, reason: "merge-in-progress" };
    const { result, failure } = await runMergeEngine(gitWorkspace, workspace, "mergeKeep");
    if (failure) return failure;
    if (result.merged) {
      if (result.baseSha) {
        lifecycleState.baseSha = result.baseSha;
        workspace.baseSha = result.baseSha;
      }
      if (!result.restoreConflict) {
        setMergeStatus("none");
        return result;
      }
      setMergeStatus("pending-review", { reason: "restore-conflict" });
      return result;
    }
    if (!result.parked && result.reason === "nothing-to-commit") {
      setMergeStatus("none");
      return result;
    }
    return applyParkedOrPending(result);
  }

  const api = {
    snapshot,
    getCarry,
    hasOwnWorktree,
    effectiveCwd,
    refreshGitContext,
    provision,
    settleOnExit,
    discardIfClean,
    setMergeStatus,
    pasteMergePrompt,
    hasUnmergedWork,
    findWorkspaceKeptWork,
    addCheckout,
    releaseCheckouts,
    hasWorkspaceMembers,
    confirmWorkspaceWorkDiscard,
    getDiff,
    getDiffFileContents,
    getChangeScopes,
    resolveEffectiveBase,
    getBranchSync,
    resyncBranch,
    computeWorktreeSignature,
    checkWorktreeChange,
    scheduleCheck,
    startWatching,
    stopWatching,
    mergeWorktree,
    mergeAndContinue,
    adoptWorktree,
    discardWorktree,
    releaseDroppedWorkspaceMembers,
  };
  return api;
}

export { createSessionWorktreeLifecycle };
