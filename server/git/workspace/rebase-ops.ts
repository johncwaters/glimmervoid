import fs from 'node:fs';
import { COHERENCE_BOOKKEEPING_PATHSPEC, COHERENCE_JOURNAL_DIRECTORY, isCoherenceJournalPath } from '../../coherence/core/coherence-paths-core.ts';
import crypto from 'node:crypto';
import path from 'node:path';
import { WORKTREE_STATUS_ARGS } from './workspace-context.ts';
import type { BaseSyncResult, GitWorkspaceContext, LandedRange, MergeOutcome, RebaseOutcome, WorktreeArgs } from './workspace-context.ts';
import type { OriginOps } from './origin-ops.ts';

const fsp = fs.promises;

function createRebaseOps(context: GitWorkspaceContext, origin: OriginOps) {
  const { run, runUntrusted, rerereEnabled, rebaseSigningArgs } = context;
  const { tearDownWorktree } = context.worktrees;
  const { synchronizeBaseWithOrigin, pushBaseToOrigin } = origin;

  function joinWarnings(...warnings: (string | null)[]): string | null {
    const presentWarnings = warnings.filter((warning): warning is string => !!warning);
    return presentWarnings.length > 0 ? presentWarnings.join(' ') : null;
  }

  function mergeSyncWarning(baseSync: BaseSyncResult, branch: string): string | null {
    if (baseSync.fetched === false) return `could not fetch origin/${branch}; merged with local base: ${baseSync.error}`;
    if (baseSync.error) return `could not fast-forward ${branch} from origin/${branch}; merged with local base`;
    return null;
  }

  function includeWarning(mergeResult: MergeOutcome, warning: string | null): MergeOutcome {
    if (!warning) return mergeResult;
    return { ...mergeResult, warning };
  }

  async function fastForwardTarget(projectPath: string, sourceRef: string, target: string, targetIsHead: boolean): Promise<{ ok: boolean; err: string }> {
    if (!targetIsHead) {
      const fetched = await run(['fetch', '.', `${sourceRef}:refs/heads/${target}`], projectPath);
      return { ok: fetched.ok, err: fetched.ok ? '' : (fetched.err ?? '') };
    }

    const merged = await run(['merge', '--ff-only', String(sourceRef).replace(/^refs\/heads\//, '')], projectPath);
    return { ok: merged.ok, err: merged.ok ? '' : (merged.err ?? '') };
  }

  async function unmergedPaths(wt: string): Promise<string[]> {
    return (await run(['diff', '--name-only', '--diff-filter=U'], wt)).out
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  const stoppedRebaseReason = (conflicts: string[]) => (conflicts.length > 0 ? 'rebase-conflict' : 'rebase-failed');

  async function abortRebaseWithConflicts(wt: string): Promise<string[]> {
    const conflicts = await unmergedPaths(wt);
    await run(['rebase', '--abort'], wt);
    return conflicts;
  }

  async function rebaseStopped(wt: string): Promise<boolean> {
    return (await run(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'], wt)).ok;
  }

  const withAutoUpdate = (args: string[]) => (rerereEnabled ? ['-c', 'rerere.autoUpdate=true', ...args] : args);
  const rebaseArgs = async (wt: string, rebaseTarget: string) => [...await rebaseSigningArgs(wt), ...withAutoUpdate(['rebase', rebaseTarget])];

  async function advanceRebaseStep(wt: string): Promise<{ done: boolean; conflicted?: boolean }> {
    const staged = await run(['diff', '--cached', '--quiet'], wt);
    const step = staged.ok ? '--skip' : '--continue';
    const r = await run(await rebaseArgs(wt, step), wt, { env: { GIT_EDITOR: 'true' } });
    if (r.ok) return { done: true };
    return { done: false, conflicted: (await unmergedPaths(wt)).length > 0 };
  }

  async function findStashEntryByTag(wt: string, tag: string): Promise<{ selector: string; sha: string } | null> {
    const listing = await run(['stash', 'list', '--format=%gd %H %gs'], wt);
    const entry = listing.out.split(/\r?\n/).find((line) => line.endsWith(`: ${tag}`));
    if (!entry) return null;
    const [selector = '', sha = ''] = entry.split(' ');
    return { selector, sha };
  }

  async function saveUncommittedWork(wt: string): Promise<{ tag: string; sha: string } | null> {
    const tag = `glimmervoid-merge-${crypto.randomUUID()}`;
    if (!(await run(['stash', 'push', '--include-untracked', '-m', tag], wt)).ok) return null;
    const entry = await findStashEntryByTag(wt, tag);
    return entry ? { tag, sha: entry.sha } : null;
  }

  async function restoreSavedWork(wt: string, savedWork: { tag: string; sha: string } | null): Promise<boolean> {
    if (!savedWork) return true;
    if (!(await run(['stash', 'apply', savedWork.sha], wt)).ok) return false;
    const entry = await findStashEntryByTag(wt, savedWork.tag);
    if (entry?.sha === savedWork.sha) await run(['stash', 'drop', entry.selector], wt);
    return true;
  }

  const RERERE_STEP_CAP = 50;
  async function replayRecordedResolutions(wt: string): Promise<{ ok: boolean; steps: number }> {
    let steps = 0;
    for (; steps < RERERE_STEP_CAP; steps += 1) {
      if ((await unmergedPaths(wt)).length) return { ok: false, steps };
      const staged = await run(['add', '-u'], wt);
      if (!staged.ok) return { ok: false, steps };
      const advanced = await advanceRebaseStep(wt);
      if (advanced.done) return { ok: true, steps: steps + 1 };
      if (!advanced.conflicted) return { ok: false, steps };
    }
    return { ok: false, steps };
  }

  async function rebaseFfBranch({ projectPath, wt, branch, target }: {
    projectPath: string;
    wt: string;
    branch: string;
    target: string;
  }): Promise<{
    committed: boolean;
    merged: boolean;
    reason: string | null;
    parked?: boolean;
    conflicts?: string[];
    restoreConflict?: boolean;
    rerereReplayed?: boolean;
    landedRange?: LandedRange | null;
  }> {

    const ahead = await run(['rev-list', '--count', `${target}..${branch}`], projectPath);
    if (!ahead.ok || ahead.out === '' || ahead.out === '0') {
      return { committed: false, merged: false, reason: 'nothing-to-commit' };
    }

    const dirty = (await run(['--no-optional-locks', 'status', '--porcelain'], wt)).out !== '';
    const savedWork = dirty ? await saveUncommittedWork(wt) : null;

    let rerereReplayed = false;
    if (!(await run(await rebaseArgs(wt, target), wt)).ok) {
      const replay = rerereEnabled && (await rebaseStopped(wt))
        ? await replayRecordedResolutions(wt)
        : { ok: false };
      if (!replay.ok) {
        const conflicts = await abortRebaseWithConflicts(wt);
        await restoreSavedWork(wt, savedWork);
        return { committed: true, merged: false, reason: stoppedRebaseReason(conflicts), parked: true, conflicts };
      }
      rerereReplayed = true;
    }

    const head = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)).out;
    const targetShaBeforeLanding = (await run(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], projectPath)).out;
    const merged = await fastForwardTarget(projectPath, `refs/heads/${branch}`, target, head === target);
    if (!merged.ok) {
      await restoreSavedWork(wt, savedWork);
      return { committed: true, merged: false, reason: 'not-fast-forward', parked: true, rerereReplayed };
    }

    const landedTipSha = (await run(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], projectPath)).out;
    const landedRange = targetShaBeforeLanding && landedTipSha ? { fromSha: targetShaBeforeLanding, toSha: landedTipSha } : null;
    const restoreConflict = !(await restoreSavedWork(wt, savedWork));
    return { committed: true, merged: true, reason: null, restoreConflict, rerereReplayed, landedRange };
  }

  async function resolveMergeBack({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<{
    wt?: string;
    branch?: string;
    target?: string;
    error?: MergeOutcome;
  }> {
    if (!workspace || !workspace.isGit) return { error: { merged: false, committed: false, branch: null, reason: 'not-git' } };
    const branch = workspace.branch;
    if (!branch) return { error: { merged: false, committed: false, branch: null, reason: 'no-branch' } };
    const target = workspace.base || targetBranch;
    if (!target || target === 'HEAD') return { error: { merged: false, committed: false, branch, reason: 'no-target', parked: true } };
    if (!(await run(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], projectPath)).ok) {
      return { error: { merged: false, committed: false, branch, base: target, reason: 'no-target-branch', parked: true } };
    }
    return { wt: workspace.cwd, branch, target };
  }

  async function readUncommittedWork(worktreePath: string, statusPathspec: string[] = []): Promise<{ ok: boolean; hasWork: boolean }> {
    const status = await run([...WORKTREE_STATUS_ARGS, ...statusPathspec], worktreePath);
    const statusEntries = status.out.split('\n').filter((statusEntry) => statusEntry !== '');
    return { ok: status.ok, hasWork: statusEntries.length > 0 };
  }

  async function isRegularCoherenceJournal(worktreePath: string, journalPath: string): Promise<boolean> {
    const pathSegments = journalPath.split('/');
    if (!isCoherenceJournalPath(journalPath)) return false;
    let checkedPath = worktreePath;
    for (const [index, segment] of pathSegments.entries()) {
      if (!segment || segment === '.' || segment === '..') return false;
      checkedPath = path.join(checkedPath, segment);
      const entryStats = await fsp.lstat(checkedPath).catch(() => null);
      if (!entryStats) return false;
      if (index === pathSegments.length - 1) return entryStats.isFile();
      if (!entryStats.isDirectory()) return false;
    }
    return false;
  }

  async function recordCoherenceJournals(worktreePath: string): Promise<boolean> {
    const modifiedFiles = await run(['ls-files', '--modified', '--others', '--exclude-standard', '-z', '--', COHERENCE_JOURNAL_DIRECTORY], worktreePath);
    if (!modifiedFiles.ok) return false;
    const stagedFiles = await run(['diff', '--cached', '--name-only', '--no-renames', '-z', '--', COHERENCE_JOURNAL_DIRECTORY], worktreePath);
    if (!stagedFiles.ok) return false;
    const journalPaths = [...new Set([...modifiedFiles.out.split('\0'), ...stagedFiles.out.split('\0')].filter(Boolean))];
    if (journalPaths.length === 0) return true;
    for (const journalPath of journalPaths) {
      if (!await isRegularCoherenceJournal(worktreePath, journalPath)) return false;
    }
    const literalJournalPaths = journalPaths.map((journalPath) => `:(literal)${journalPath}`);
    const staged = await runUntrusted(['add', '--', ...literalJournalPaths], worktreePath, { disableHooks: true });
    if (!staged.ok) return false;
    const committed = await runUntrusted(['commit', '-m', 'chore: record Coherence journal', '--only', '--', ...literalJournalPaths], worktreePath, { disableHooks: true });
    return committed.ok;
  }

  async function mergeBackBody({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<MergeOutcome> {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return g.error;
    const { wt = '', branch = '', target = '' } = g;

    const baseSync = await synchronizeBaseWithOrigin(projectPath, target);
    if (baseSync.state === 'diverged') {
      return { merged: false, committed: false, branch, base: target, reason: 'base-diverged', parked: true };
    }
    const warning = mergeSyncWarning(baseSync, target);

    const uncommitted = await readUncommittedWork(wt, COHERENCE_BOOKKEEPING_PATHSPEC);
    if (!uncommitted.ok || uncommitted.hasWork || !await recordCoherenceJournals(wt)) {
      return includeWarning({ merged: false, committed: false, branch, base: target, reason: 'uncommitted-changes', parked: true }, warning);
    }

    const r = await rebaseFfBranch({ projectPath, wt, branch, target });
    if (!r.committed) {

      await tearDownWorktree(projectPath, wt, branch);
      return includeWarning({ merged: false, committed: false, branch: null, base: target, reason: 'nothing-to-commit' }, warning);
    }
    if (!r.merged) {

      return includeWarning({ merged: false, committed: true, branch, base: target, reason: r.reason, parked: true, conflicts: r.conflicts || [] }, warning);
    }
    await tearDownWorktree(projectPath, wt, branch);
    const push = await pushBaseToOrigin(projectPath, target);
    return includeWarning({
      merged: true,
      committed: true,
      branch: null,
      base: target,
      reason: null,
      pushed: push.pushed,
      rerereReplayed: r.rerereReplayed === true,
      landedRange: r.landedRange ?? null,
    }, joinWarnings(warning, push.warning));
  }

  async function mergeKeepBody({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<MergeOutcome> {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return g.error;
    const { wt = '', branch = '', target = '' } = g;

    const baseSync = await synchronizeBaseWithOrigin(projectPath, target);
    if (baseSync.state === 'diverged') {
      return { merged: false, committed: false, branch, base: target, reason: 'base-diverged', parked: true };
    }
    const warning = mergeSyncWarning(baseSync, target);

    const r = await rebaseFfBranch({ projectPath, wt, branch, target });
    if (!r.committed) {

      return includeWarning({ merged: false, committed: false, branch, base: target, reason: 'nothing-to-commit', kept: true }, warning);
    }
    if (!r.merged) {
      return includeWarning({ merged: false, committed: true, branch, base: target, reason: r.reason, parked: true, conflicts: r.conflicts || [] }, warning);
    }

    const baseSha = (await run(['rev-parse', target], projectPath)).out || workspace?.baseSha || null;
    const push = await pushBaseToOrigin(projectPath, target);
    return includeWarning({
      merged: true, committed: true, branch, base: target, baseSha, kept: true, reason: null,
      pushed: push.pushed, restoreConflict: r.restoreConflict || false, rerereReplayed: r.rerereReplayed === true,
      landedRange: r.landedRange ?? null,
    }, joinWarnings(warning, push.warning));
  }

  async function resolvePushedRebaseTarget(projectPath: string, target: string): Promise<string | null> {
    const localSha = (await run(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], projectPath)).out;
    if (!localSha) return null;
    const originRef = `refs/remotes/origin/${target}`;
    if (!(await run(['rev-parse', '--verify', '--quiet', originRef], projectPath)).ok) return localSha;
    return (await run(['merge-base', localSha, originRef], projectPath)).out || localSha;
  }

  async function rebaseOnlyBody({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<RebaseOutcome> {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return { ok: false, reason: g.error.reason ?? undefined };
    const { wt = '', target = '' } = g;

    const uncommitted = await readUncommittedWork(wt);
    if (!uncommitted.ok) return { ok: false, reason: 'unreadable' };
    if (uncommitted.hasWork) return { ok: false, reason: 'dirty' };

    const rebaseTargetSha = await resolvePushedRebaseTarget(projectPath, target);
    if (!rebaseTargetSha) return { ok: false, reason: 'unreadable' };

    const behind = await run(['rev-list', '--count', `HEAD..${rebaseTargetSha}`], wt);
    if (!behind.ok) return { ok: false, reason: 'unreadable' };
    if (behind.out === '' || behind.out === '0') return { ok: true, upToDate: true };

    let rerereReplayed = false;
    if (!(await run(await rebaseArgs(wt, rebaseTargetSha), wt)).ok) {

      if (!(await rebaseStopped(wt))) return { ok: false, reason: 'rebase-failed' };
      const replay = rerereEnabled ? await replayRecordedResolutions(wt) : { ok: false };
      if (!replay.ok) {
        const conflicts = await abortRebaseWithConflicts(wt);
        return { ok: false, reason: stoppedRebaseReason(conflicts), conflicts };
      }
      rerereReplayed = true;
    }
    return {
      ok: true,
      rebased: true,
      headSha: (await run(['rev-parse', 'HEAD'], wt)).out || null,
      baseSha: rebaseTargetSha,
      rerereReplayed,
    };
  }

  async function resolveRebaseTarget({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<string | null> {
    const target = workspace?.base || targetBranch;
    if (!target || target === 'HEAD') return null;
    return resolvePushedRebaseTarget(projectPath, target);
  }

  return { fastForwardTarget, mergeBackBody, mergeKeepBody, rebaseOnlyBody, resolveRebaseTarget };
}

type RebaseOps = ReturnType<typeof createRebaseOps>;

export { createRebaseOps };
export type { RebaseOps };
