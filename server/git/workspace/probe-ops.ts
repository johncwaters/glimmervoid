import { isGcCandidateWorktree, sessionIdFromBranch } from '../../core/branch-gc-core.ts';
import { comparableDirectoryPath } from '../../../shared/canonical-paths.ts';
import { originTrackingRefProbe, unlandedCommitCountArgs } from '../../core/integration-branch-core.ts';
import { WORK_PRESENCE_STATUS_ARGS, directoryExists, hasWorkFrom, isDirtyResult, mainWorktreePath, markerFrom, parseWorktreeBranches } from './workspace-context.ts';
import type { GitWorkspaceContext, ListedWorktree, SessionWorktree, WorktreeArgs, WorktreeBranch, WorktreeDirtyProbe, WorktreeProbe } from './workspace-context.ts';
import type { OriginOps } from './origin-ops.ts';

function createProbeOps(context: GitWorkspaceContext, origin: OriginOps) {
  const { run, runInProject } = context;
  const { listWorktreePorcelain, lockReusedHomeWorktrees } = context.worktrees;
  const { detectDefaultBranch, migrateMarkerBase } = origin;

  async function probeWorktreeWork({ projectPath, cwd, branch, measuredTip = branch, integrationBranch, configuredIntegrationBranch }: {
    projectPath: string;
    cwd: string;
    branch: string;
    measuredTip?: string;
    integrationBranch?: string | null;
    configuredIntegrationBranch?: string | null;
  }): Promise<WorktreeProbe> {
    const { base: resolvedIntegrationBranch, measureRef } = await migrateMarkerBase(projectPath, branch, integrationBranch, configuredIntegrationBranch);
    const dirty = await run(WORK_PRESENCE_STATUS_ARGS, cwd);
    const ahead = !isDirtyResult(dirty) && resolvedIntegrationBranch
      ? await run(unlandedCommitCountArgs({
        tip: measuredTip,
        measuredBase: measureRef || resolvedIntegrationBranch,
        originBaseRef: markerFrom(await run(originTrackingRefProbe(resolvedIntegrationBranch), projectPath)),
      }), projectPath)
      : null;
    return { dirty, ahead, integrationBranch: resolvedIntegrationBranch ?? null };
  }

  async function describeWorkspaceMemberWorkBody({ projectPath, cwd, branch }: { projectPath: string; cwd: string; branch: string }): Promise<string | null> {
    const memberHead = await run(['rev-parse', '--verify', 'HEAD'], cwd);
    if (!memberHead.ok || !memberHead.out) return 'its checked-out commit could not be read';
    const integrationBranch = await detectDefaultBranch({ projectPath });
    const { dirty, ahead, integrationBranch: comparedBranch } = await probeWorktreeWork({ projectPath, cwd, branch, measuredTip: memberHead.out, integrationBranch });
    if (!dirty.ok) return 'its git status could not be read';
    if (isDirtyResult(dirty)) return 'uncommitted changes';
    if (!ahead?.ok) return 'its commits could not be compared with the base branch';
    if (!ahead.out || ahead.out === '0') return null;
    return `${ahead.out} ${ahead.out === '1' ? 'commit' : 'commits'} not on ${comparedBranch}`;
  }

  async function hasUnmergedWorkBody({ projectPath, workspace, integrationBranch, configuredIntegrationBranch }: WorktreeArgs): Promise<boolean> {
    if (!workspace || !workspace.isGit || !workspace.cwd || !workspace.branch) return true;
    const { dirty, ahead } = await probeWorktreeWork({
      projectPath, cwd: workspace.cwd, branch: workspace.branch,
      integrationBranch: integrationBranch || workspace.base,
      configuredIntegrationBranch,
    });
    if (!dirty.ok) return true;
    if (isDirtyResult(dirty)) return true;
    if (!ahead || !ahead.ok) return true;
    return hasWorkFrom(dirty, ahead);
  }

  async function scanProbedWorktrees<Described>({ projectPath, integrationBranch, configuredIntegrationBranch, beforeDescribe, describe }: {
    projectPath: string;
    integrationBranch?: string | null;
    configuredIntegrationBranch?: string | null;
    beforeDescribe?: (porcelain: string) => Promise<void>;
    describe: (entry: WorktreeBranch, probe: () => Promise<WorktreeProbe>, mainWorktree: string | null) => Promise<Described | null>;
  }): Promise<Described[]> {
    const described: Described[] = [];
    const inside = await run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return described;
    const listed = await listWorktreePorcelain(projectPath);
    if (!listed.ok) return described;
    if (beforeDescribe) await beforeDescribe(listed.out);
    const mainWorktree = mainWorktreePath(listed.out);
    for (const entry of parseWorktreeBranches(listed.out)) {
      const probe = () => probeWorktreeWork({ projectPath, cwd: entry.cwd, branch: entry.branch, integrationBranch, configuredIntegrationBranch });
      const record = await describe(entry, probe, mainWorktree);
      if (record !== null) described.push(record);
    }
    return described;
  }

  async function listWorktreesBody({ projectPath, prefixes = [], worktreeRoot = null, integrationBranch, configuredIntegrationBranch }: WorktreeArgs): Promise<ListedWorktree[]> {
    const canonicalWorktreeRoot = worktreeRoot ? await comparableDirectoryPath(worktreeRoot) : null;
    return scanProbedWorktrees<ListedWorktree>({
      projectPath, integrationBranch, configuredIntegrationBranch,
      beforeDescribe: (porcelain) => lockReusedHomeWorktrees(runInProject(projectPath), porcelain),
      describe: async ({ cwd, branch, locked, prunable, headSha }, probe, mainWorktree) => {
        const canonicalCwd = await comparableDirectoryPath(cwd);
        if (mainWorktree !== null && canonicalCwd === await comparableDirectoryPath(mainWorktree)) return null;
        if (!isGcCandidateWorktree({ branch, cwd: canonicalCwd }, prefixes, canonicalWorktreeRoot)) return null;
        if (!headSha) return null;
        if (prunable || !(await directoryExists(cwd))) {
          return { cwd: canonicalCwd, branch, locked, prunable: true, dirty: null, tipSha: headSha, integrationBranch: null };
        }
        const probed = await probe();
        return {
          cwd: canonicalCwd, branch, locked, prunable: false,
          dirty: probed.dirty.ok ? isDirtyResult(probed.dirty) : null,
          tipSha: headSha,
          integrationBranch: probed.integrationBranch,
        };
      },
    });
  }

  async function listSessionWorktreesBody({ projectPath, integrationBranch, configuredIntegrationBranch }: WorktreeArgs): Promise<SessionWorktree[]> {
    return scanProbedWorktrees<SessionWorktree>({
      projectPath, integrationBranch, configuredIntegrationBranch,
      describe: async ({ cwd, branch }, probe) => {
        const id = sessionIdFromBranch(branch);
        if (id === null) return null;
        const probed = await probe();
        return {
          cwd, branch, id,
          hasWork: hasWorkFrom(probed.dirty, probed.ahead),
          integrationBranch: probed.integrationBranch,
        };
      },
    });
  }

  async function probeWorktreeDirtyBody({ cwd }: WorktreeArgs): Promise<WorktreeDirtyProbe> {
    if (!cwd) return { ok: false, dirty: true, headSha: null, err: 'a worktree status probe needs a path' };
    const status = await run(WORK_PRESENCE_STATUS_ARGS, cwd);
    if (!status.ok) return { ok: false, dirty: true, headSha: null, err: status.err };
    const head = await run(['rev-parse', 'HEAD'], cwd);
    if (!head.ok || !head.out) return { ok: false, dirty: true, headSha: null, err: head.err || 'a worktree head probe returned no sha' };
    return { ok: true, dirty: status.out !== '', headSha: head.out };
  }

  return { describeWorkspaceMemberWorkBody, hasUnmergedWorkBody, listWorktreesBody, listSessionWorktreesBody, probeWorktreeDirtyBody };
}

export { createProbeOps };
