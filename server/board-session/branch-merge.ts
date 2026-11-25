import { pathsOutsideBranchFolder } from '../../shared/board-branch-core.ts';
import { branchParentIdOf } from '../../shared/parent-link.ts';
import { STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';
import { errorMessage } from '../../shared/text.ts';
import type { Session } from '../../session/sessions.ts';
import { runHardenedGit } from '../git/git-workspace.ts';

const GIT_TIMEOUT_MS = 60000;
const SETTLED_STATES: readonly SessionState[] = [STATES.IDLE, STATES.COMPLETE];
const BUSY_MERGE_STATUSES: readonly string[] = ['merging', 'parked'];
const OUTSIDE_PATHS_NAMED = 5;
const LANDED_BRANCH_IDLE_MS = 30000;

const SYMBOLIC_REF_DETACHED_EXIT_CODE = 1;

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
  exitCode: number | null;
}

type CheckedOutBranch = { ok: true; name: string | null } | { ok: false; err: string };

interface BranchMergeDeps {
  findSession: (sessionId: string) => Session | null;
  liveSessions: () => readonly Session[];
  tellMain: (branchId: string, text: string) => boolean;
  closeBranch: (branchId: string) => Promise<{ ok: boolean; error?: string }>;
  logger: Pick<Console, 'warn'>;
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout } = await runHardenedGit(args, { cwd, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' } });
    return { ok: true, out: stdout.trim(), err: '', exitCode: 0 };
  } catch (error) {
    return { ok: false, out: '', err: gitFailureTextOf(error), exitCode: exitCodeOf(error) };
  }
}

function gitFailureTextOf(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr).trim() : '';
  return stderr || errorMessage(error);
}

function exitCodeOf(error: unknown): number | null {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  return typeof code === 'number' ? code : null;
}

async function checkedOutBranchOf(worktreeDir: string): Promise<CheckedOutBranch> {
  const read = await runGit(['symbolic-ref', '-q', '--short', 'HEAD'], worktreeDir);
  if (read.ok && read.out !== '') return { ok: true, name: read.out };
  if (read.ok || read.exitCode === SYMBOLIC_REF_DETACHED_EXIT_CODE) return { ok: true, name: null };
  return { ok: false, err: read.err };
}

function noCheckedOutBranchProblem(isOrchestratorWithoutBranch: boolean, branch: Session): string {
  if (isOrchestratorWithoutBranch) return 'your worktree has no branch checked out, which a rebase, a bisect or checking out a commit leaves behind. Finish or abort that, or check out your branch, and Glimmervoid brings the commits in the next time you settle.';
  return `the worktree of ${branch.name} has no branch checked out, so there is no branch to bring in. Tell ${branch.name} to check out its branch with glimmervoid send ${branch.id} <text>.`;
}

function isSettled(session: Session): boolean {
  return SETTLED_STATES.includes(session.state);
}

function isWorktreeBusy(session: Session): boolean {
  return session.isAutoRebasing || BUSY_MERGE_STATUSES.includes(session.mergeStatus);
}

async function isBranchWorkElsewhere(branch: Session, parent: Session | null): Promise<boolean> {
  if (!parent?.isWorktree || !branch.isWorktree) return !(await branch.hasUnmergedWork());
  const branchDir = branch.effectiveCwd();
  const parentBranch = await checkedOutBranchOf(parent.effectiveCwd());
  if (!parentBranch.ok || parentBranch.name === null) return false;
  const uncommitted = await runGit(['--no-optional-locks', 'status', '--porcelain'], branchDir);
  if (!uncommitted.ok || uncommitted.out !== '') return false;
  const ahead = await runGit(['rev-list', '--count', `${parentBranch.name}..HEAD`], branchDir);
  return ahead.ok && Number(ahead.out) === 0;
}

function createBranchMerge({ findSession, liveSessions, tellMain, closeBranch, logger }: BranchMergeDeps) {
  const mergingBranchIds = new Set<string>();
  const workedBranchIds = new Set<string>();
  const closeTimerByBranchId = new Map<string, ReturnType<typeof setTimeout>>();
  const mergeQueueByParentId = new Map<string, Promise<void>>();
  const reportedProblemByBranchId = new Map<string, string>();

  function tellParent(parent: Session, branch: Session, branchHead: string, problem: string): void {
    const report = `${branchHead}\0${problem}`;
    if (reportedProblemByBranchId.get(branch.id) === report) return;
    reportedProblemByBranchId.set(branch.id, report);
    const text = `Glimmervoid could not bring the commits of your branch session ${branch.name} into your branch: ${problem}`;
    if (tellMain(branch.id, text)) return;
    const queued = parent.queueChatMessage(text, []);
    if (!queued.ok) logger.warn(`[branch-merge] could not tell ${parent.name} about ${branch.name}: ${queued.error}`);
  }

  async function outsideFolderProblem(branch: Session, parentBranch: string, branchName: string, branchDir: string): Promise<string | null> {
    const branchTitle = branch.parent?.box?.title;
    if (branchTitle === undefined) return null;
    const changed = await runGit(['diff', '--name-only', '-z', `${parentBranch}...${branchName}`], branchDir);
    if (!changed.ok) return `listing the files its commits change failed: ${changed.err}`;
    const outsidePaths = pathsOutsideBranchFolder(changed.out.split('\0').filter(Boolean), branchTitle);
    if (outsidePaths.length === 0) return null;
    const namedPaths = outsidePaths.slice(0, OUTSIDE_PATHS_NAMED).join(', ');
    const morePaths = outsidePaths.length > OUTSIDE_PATHS_NAMED ? ` and ${outsidePaths.length - OUTSIDE_PATHS_NAMED} more` : '';
    return `its commits change ${namedPaths}${morePaths}, outside ${branchTitle}, the folder it holds. Check them, then merge it yourself with git merge ${branchName}, or tell ${branch.name} what to undo with glimmervoid send ${branch.id} <text>.`;
  }

  async function bringIn(branch: Session, parent: Session): Promise<void> {
    const branchDir = branch.effectiveCwd();
    const parentDir = parent.effectiveCwd();
    const parentRead = await checkedOutBranchOf(parentDir);
    const branchRead = await checkedOutBranchOf(branchDir);
    if (!parentRead.ok) return logger.warn(`[branch-merge] could not read the branch of ${parent.name}: ${parentRead.err}`);
    if (!branchRead.ok) return logger.warn(`[branch-merge] could not read the branch of ${branch.name}: ${branchRead.err}`);
    const parentTip = parentRead.name ?? (await runGit(['rev-parse', 'HEAD'], parentDir)).out;
    const branchTip = branchRead.name ?? (await runGit(['rev-parse', 'HEAD'], branchDir)).out;
    const ahead = await runGit(['rev-list', '--count', `${parentTip}..${branchTip}`], branchDir);
    if (!ahead.ok || Number(ahead.out) === 0) return;
    const parentBranch = parentRead.name;
    const branchName = branchRead.name;
    if (parentBranch === null || branchName === null) {
      const head = await runGit(['rev-parse', 'HEAD'], branchDir);
      return tellParent(parent, branch, head.out, noCheckedOutBranchProblem(parentBranch === null, branch));
    }
    const heldBack = await outsideFolderProblem(branch, parentBranch, branchName, branchDir);
    if (heldBack !== null) {
      const head = await runGit(['rev-parse', 'HEAD'], branchDir);
      return tellParent(parent, branch, head.out, heldBack);
    }
    const isParentAncestor = await runGit(['merge-base', '--is-ancestor', parentBranch, branchName], branchDir);
    if (!isParentAncestor.ok) {
      const rebased = await runGit(['rebase', '--autostash', parentBranch], branchDir);
      if (!rebased.ok) {
        const conflicts = await runGit(['diff', '--name-only', '--diff-filter=U'], branchDir);
        await runGit(['rebase', '--abort'], branchDir);
        const head = await runGit(['rev-parse', 'HEAD'], branchDir);
        const conflictList = conflicts.out.split('\n').filter(Boolean).join(', ');
        return tellParent(parent, branch, head.out, `rebasing ${branchName} onto ${parentBranch} stopped${conflictList ? ` on conflicts in ${conflictList}` : `: ${rebased.err}`}. Merge it yourself with git merge ${branchName}, or tell ${branch.name} what to change.`);
      }
    }
    const merged = await runGit(['merge', '--ff-only', branchName], parentDir);
    if (merged.ok) return void reportedProblemByBranchId.delete(branch.id);
    const head = await runGit(['rev-parse', 'HEAD'], branchDir);
    tellParent(parent, branch, head.out, `fast-forwarding ${parentBranch} to ${branchName} failed: ${merged.err}`);
  }

  async function mergeWhenReady(branch: Session): Promise<void> {
    const parentId = branchParentIdOf(branch.parent);
    if (parentId === null || !isSettled(branch)) return;
    const parent = findSession(parentId);
    if (!parent?.isWorktree || !branch.isWorktree || !isSettled(parent) || isWorktreeBusy(parent)) return;
    try {
      await bringIn(branch, parent);
      if (workedBranchIds.has(branch.id) && isSettled(branch)) scheduleIdleClose(branch.id);
    } catch (error) {
      logger.warn(`[branch-merge] ${branch.name}: ${errorMessage(error)}`);
    }
  }

  function cancelIdleClose(branchId: string): void {
    clearTimeout(closeTimerByBranchId.get(branchId));
    closeTimerByBranchId.delete(branchId);
  }

  function scheduleIdleClose(branchId: string): void {
    cancelIdleClose(branchId);
    const timer = setTimeout(() => {
      closeTimerByBranchId.delete(branchId);
      void closeIfLanded(branchId).catch((error: unknown) => logger.warn(`[branch-merge] closing ${branchId}: ${errorMessage(error)}`));
    }, LANDED_BRANCH_IDLE_MS);
    timer.unref();
    closeTimerByBranchId.set(branchId, timer);
  }

  async function closeIfLanded(branchId: string): Promise<void> {
    const branch = findSession(branchId);
    if (!branch || branch._destroyed || !isSettled(branch)) return;
    const parentId = branchParentIdOf(branch.parent);
    const parent = parentId === null ? null : findSession(parentId);
    if (!(await isBranchWorkElsewhere(branch, parent))) return;
    const closed = await closeBranch(branch.id);
    if (closed.ok) return void workedBranchIds.delete(branch.id);
    logger.warn(`[branch-merge] could not close ${branch.name}: ${closed.error ?? 'refused'}`);
  }

  function queueMerge(branch: Session): void {
    const parentId = branchParentIdOf(branch.parent);
    if (parentId === null || mergingBranchIds.has(branch.id)) return;
    mergingBranchIds.add(branch.id);
    const previous = mergeQueueByParentId.get(parentId) ?? Promise.resolve();
    const queued = previous.then(() => mergeWhenReady(branch)).finally(() => {
      mergingBranchIds.delete(branch.id);
      if (mergeQueueByParentId.get(parentId) === queued) mergeQueueByParentId.delete(parentId);
    });
    mergeQueueByParentId.set(parentId, queued);
  }

  function attachSession(session: Session): void {
    session.on('state-change', ({ to }: { to: SessionState }) => {
      const isBranch = branchParentIdOf(session.parent) !== null;
      if (isBranch && to === STATES.RUNNING) workedBranchIds.add(session.id);
      if (!SETTLED_STATES.includes(to)) return void cancelIdleClose(session.id);
      if (isBranch) return queueMerge(session);
      for (const branch of liveSessions()) {
        if (branchParentIdOf(branch.parent) === session.id) queueMerge(branch);
      }
    });
  }

  return { attachSession };
}

export { createBranchMerge, isBranchWorkElsewhere };
