import { errorMessage } from "../../shared/text.ts";
import fs from "node:fs";
import { isSameDirectoryPath } from "../../shared/canonical-paths.ts";
import { SPAWN_GAP_TRIGGER } from "../core/rebase-gate.ts";
import { describeDependencyCloneSkip, describeStaleDirs } from "../../server/git/core/dependency-clone-core.ts";
import type { AdoptWorktreeOptions, GitWorkspace, IntegrationSyncResult, Workspace, WorkspaceMembersSetup, WorktreeLifecycleContext, WorktreeSignature } from "./worktree-lifecycle-context.ts";

type WorktreeProvisioningDeps = {
  adoptWorktree(options: AdoptWorktreeOptions): void;
  resolveCommonGitDir(): string | null;
  runAutoRebase(trigger: string, signature: WorktreeSignature): Promise<void>;
  api: { computeWorktreeSignature(): Promise<WorktreeSignature | null> };
};

function createWorktreeProvisioning(context: WorktreeLifecycleContext, deps: WorktreeProvisioningDeps) {
  const { id, integrationBranch, gitWorkspace, syncOnStart, worktreeRoot, worktreeShare, seedDependencies, port, workspaceMembers, lifecycleState, currentProjectPath, effectiveIntegrationBranch, setMergeStatus } = context;
  const { adoptWorktree, resolveCommonGitDir, runAutoRebase, api } = deps;

  function syncableGitWorkspace(): (GitWorkspace & Required<Pick<GitWorkspace, "syncIntegrationBranch">>) | null {
    if (syncOnStart === false) return null;
    if (!gitWorkspace || typeof gitWorkspace.syncIntegrationBranch !== "function") return null;
    return gitWorkspace as GitWorkspace & Required<Pick<GitWorkspace, "syncIntegrationBranch">>;
  }

  async function resolveBaseForStart(): Promise<string | null> {
    const resolvedBase = effectiveIntegrationBranch();
    if (resolvedBase) return resolvedBase;
    if (!gitWorkspace || typeof gitWorkspace.detectDefaultBranch !== "function") return null;
    const detectedBase = await gitWorkspace.detectDefaultBranch({ projectPath: currentProjectPath() });
    lifecycleState.effectiveBase = detectedBase;
    return detectedBase;
  }

  async function syncIntegrationBranchForStart(
    trigger: string,
    branch: string | null,
  ): Promise<IntegrationSyncResult | null> {
    const syncGitWorkspace = syncableGitWorkspace();
    if (!syncGitWorkspace || !branch) return null;
    try {
      const sync = await syncGitWorkspace.syncIntegrationBranch({
        projectPath: currentProjectPath(),
        branch,
      });
      port.recordDecision({
        kind: "integration-sync",
        ts: Date.now(),
        decision: trigger,
        outcome: sync.outcome,
        from: sync.from,
        to: sync.to,
      });
      if (sync.outcome === "fetch-failed" || sync.outcome === "update-failed") {
        const detail = sync.error ? `${sync.outcome}: ${sync.error}` : sync.outcome;
        console.warn(`[session ${id}] integration sync failed during ${trigger}: ${detail}`);
      }
      return sync;
    } catch (error) {
      console.warn(`[session ${id}] integration sync failed during ${trigger}: ${errorMessage(error)}`);
      return null;
    }
  }

  function forkSyncWarning(sync: IntegrationSyncResult | null, branch: string | null): string | null {
    if (!sync || !branch) return null;
    if (sync.outcome === "ahead") return `base ${branch} is ahead of origin/${branch} (unpushed commits); forked from local`;
    if (sync.outcome === "diverged") return `base ${branch} has diverged from origin/${branch}; forked from local`;
    if (sync.outcome === "fetch-failed") return `could not fetch origin/${branch}; forked from local`;
    if (sync.outcome === "checked-out") {
      return `${branch} is checked out with local changes and behind origin/${branch}; forked from local`;
    }
    if (sync.outcome === "update-failed") return `could not fast-forward ${branch} from origin/${branch}; forked from local`;
    return null;
  }

  async function syncFreshWorktree(): Promise<void> {

    if (!syncableGitWorkspace()) return;
    const branch = await resolveBaseForStart();
    await syncIntegrationBranchForStart(SPAWN_GAP_TRIGGER, branch);
    if (port.state().isDestroyed) return;
    if (!lifecycleState.workspace) return;
    const signature = await api.computeWorktreeSignature();
    if (!signature) return;
    await runAutoRebase(SPAWN_GAP_TRIGGER, signature);
  }

  async function provisionWorkspaceMembers(setup: WorkspaceMembersSetup): Promise<boolean> {
    if (!setup.ok) {
      port.emit("worktree-blocked", { id, branch: null, notice: setup.error });
      return false;
    }
    const provisioned = await setup.members.provision();
    if (provisioned.ok) {
      lifecycleState.provisionedMembers = provisioned.members;
      for (const member of provisioned.members) await seedWorktreeDependencies(member.repoPath, member.dir, member.base ?? null);
      return true;
    }
    port.emit("worktree-blocked", { id, branch: setup.members.branch, notice: provisioned.error });
    return false;
  }

  async function provision({ fresh = false }: { fresh?: boolean } = {}): Promise<boolean> {
    if (workspaceMembers) return provisionWorkspaceMembers(workspaceMembers);
    if (!gitWorkspace) return true;
    if (lifecycleState.worktreeDir && fs.existsSync(lifecycleState.worktreeDir)) {
      await Promise.resolve(gitWorkspace.populate({
        projectPath: currentProjectPath(),
        wtDir: lifecycleState.worktreeDir,
        shareList: worktreeShare,
      })).catch(() => {});
      if (fresh) await syncFreshWorktree();
      await seedWorktreeDependencies(currentProjectPath(), lifecycleState.worktreeDir, effectiveIntegrationBranch());
      return true;
    }
    const baseBranch = await resolveBaseForStart();
    const initialSync = await syncIntegrationBranchForStart("initial-create", baseBranch);
    if (port.state().isDestroyed) return false;
    let workspace: Workspace;
    try {
      workspace = await gitWorkspace.create({
        projectPath: currentProjectPath(),
        owner: `session:${id}`,
        teamId: "session",
        label: id,
        baseBranch,
        configuredIntegrationBranch: integrationBranch,
        worktreeBase: worktreeRoot,
        shareList: worktreeShare,
      });
    } catch (error) {
      console.warn(`[session ${id}] worktree create failed: ${errorMessage(error)} - running in place`);
      return true;
    }
    if (workspace?.reason === "no-base-branch") {
      lifecycleState.worktreeNotice = integrationBranch
        ? `Integration branch "${integrationBranch}" not found. Create it, then start this session.`
        : "No default branch found. Configure integrationBranch or create main or master, then start this session.";
      port.emit("worktree-blocked", { id, branch: integrationBranch, notice: lifecycleState.worktreeNotice });
      return false;
    }
    if (workspace?.reason === "branch-in-use") {
      let adopted = false;
      if (workspace.branch && workspace.conflictPath && fs.existsSync(workspace.conflictPath)
          && !isSameDirectoryPath(workspace.conflictPath, currentProjectPath())) {
        try {
          adoptWorktree({ worktreeDir: workspace.conflictPath, branch: workspace.branch, base: workspace.base || integrationBranch });
          adopted = true;
        } catch (error) {
          console.warn(`[session ${id}] survivor adopt failed: ${errorMessage(error)} - running in place`);
        }
      }
      if (adopted && lifecycleState.worktreeDir) {
        lifecycleState.worktreeNotice = null;
        await Promise.resolve(gitWorkspace.populate({
          projectPath: currentProjectPath(),
          wtDir: lifecycleState.worktreeDir,
          shareList: worktreeShare,
        })).catch(() => {});
        port.emit("worktree-ready", {
          id,
          worktreeDir: lifecycleState.worktreeDir,
          branch: workspace.branch,
          base: effectiveIntegrationBranch(),
        });
        await seedWorktreeDependencies(currentProjectPath(), lifecycleState.worktreeDir, effectiveIntegrationBranch());
        return true;
      }
      lifecycleState.worktreeNotice = `session branch already checked out at ${workspace.conflictPath}; running in place`;
      port.emit("worktree-blocked", { id, branch: effectiveIntegrationBranch(), notice: lifecycleState.worktreeNotice });
    }
    if (!workspace || !workspace.isGit) {
      lifecycleState.worktreeDir = null;
      lifecycleState.isWorktree = false;
      return true;
    }
    lifecycleState.workspace = workspace;
    lifecycleState.effectiveBase = workspace.base || null;
    lifecycleState.worktreeDir = workspace.cwd;
    lifecycleState.commonGitDir = resolveCommonGitDir();
    lifecycleState.baseSha = workspace.baseSha || null;
    lifecycleState.worktreeNotice = null;
    setMergeStatus("none", {}, { emit: false });
    lifecycleState.isWorktree = true;
    const syncWarning = forkSyncWarning(initialSync, workspace.base || baseBranch);
    if (syncWarning) port.emit("worktree-warning", { id, branch: workspace.base || null, notice: syncWarning });
    port.emit("worktree-ready", { id, worktreeDir: workspace.cwd, branch: workspace.branch, base: workspace.base || null });
    await seedWorktreeDependencies(currentProjectPath(), workspace.cwd, workspace.base || null);
    return true;
  }

  async function seedWorktreeDependencies(mainCheckout: string, worktreeDir: string, branch: string | null): Promise<void> {
    if (!seedDependencies) return;
    const outcome = await seedDependencies({ mainCheckout, worktreeDir });
    if (outcome.action === "cloned") {
      console.log(`[session ${id}] cloned node_modules into ${worktreeDir} (${outcome.dirs.join(", ")}) in ${outcome.elapsedMs}ms`);
      if (!outcome.staleDirs.length) return;
      const staleNotice = describeStaleDirs(outcome.staleDirs);
      console.log(`[session ${id}] ${staleNotice}`);
      port.emit("worktree-warning", { id, branch, notice: staleNotice });
      return;
    }
    const reason = describeDependencyCloneSkip(outcome.reason);
    console.log(`[session ${id}] did not clone node_modules into ${worktreeDir}: ${reason}`);
    if (outcome.notify) port.emit("worktree-warning", { id, branch, notice: reason });
  }

  return { provision };
}

export { createWorktreeProvisioning };
