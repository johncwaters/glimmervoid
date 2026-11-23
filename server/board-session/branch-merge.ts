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

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

interface BranchMergeDeps {
  findSession: (sessionId: string) => Session | null;
  liveSessions: () => readonly Session[];
  tellMain: (branchId: string, text: string) => boolean;
  logger: Pick<Console, 'warn'>;
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout } = await runHardenedGit(args, { cwd, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' } });
    return { ok: true, out: stdout.trim(), err: '' };
  } catch (error) {
    return { ok: false, out: '', err: gitFailureTextOf(error) };
  }
}

function gitFailureTextOf(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr).trim() : '';
  return stderr || errorMessage(error);
}

function isSettled(session: Session): boolean {
  return SETTLED_STATES.includes(session.state);
}

function isWorktreeBusy(session: Session): boolean {
  return session.isAutoRebasing || BUSY_MERGE_STATUSES.includes(session.mergeStatus);
}

function createBranchMerge({ findSession, liveSessions, tellMain, logger }: BranchMergeDeps) {
  const mergingBranchIds = new Set<string>();
  const mergeQueueByParentId = new Map<string, Promise<void>>();
  const reportedHeadByBranchId = new Map<string, string>();

  function tellParent(parent: Session, branch: Session, branchHead: string, problem: string): void {
    if (reportedHeadByBranchId.get(branch.id) === branchHead) return;
    reportedHeadByBranchId.set(branch.id, branchHead);
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
    const parentBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], parentDir);
    const branchName = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], branchDir);
    if (!parentBranch.ok || !branchName.ok) return logger.warn(`[branch-merge] could not read the branches of ${branch.name}: ${parentBranch.err || branchName.err}`);
    const ahead = await runGit(['rev-list', '--count', `${parentBranch.out}..${branchName.out}`], branchDir);
    if (!ahead.ok || Number(ahead.out) === 0) return;
    const heldBack = await outsideFolderProblem(branch, parentBranch.out, branchName.out, branchDir);
    if (heldBack !== null) {
      const head = await runGit(['rev-parse', 'HEAD'], branchDir);
      return tellParent(parent, branch, head.out, heldBack);
    }
    const isParentAncestor = await runGit(['merge-base', '--is-ancestor', parentBranch.out, branchName.out], branchDir);
    if (!isParentAncestor.ok) {
      const rebased = await runGit(['rebase', '--autostash', parentBranch.out], branchDir);
      if (!rebased.ok) {
        const conflicts = await runGit(['diff', '--name-only', '--diff-filter=U'], branchDir);
        await runGit(['rebase', '--abort'], branchDir);
        const head = await runGit(['rev-parse', 'HEAD'], branchDir);
        const conflictList = conflicts.out.split('\n').filter(Boolean).join(', ');
        return tellParent(parent, branch, head.out, `rebasing ${branchName.out} onto ${parentBranch.out} stopped${conflictList ? ` on conflicts in ${conflictList}` : `: ${rebased.err}`}. Merge it yourself with git merge ${branchName.out}, or tell ${branch.name} what to change.`);
      }
    }
    const merged = await runGit(['merge', '--ff-only', branchName.out], parentDir);
    if (merged.ok) return void reportedHeadByBranchId.delete(branch.id);
    const head = await runGit(['rev-parse', 'HEAD'], branchDir);
    tellParent(parent, branch, head.out, `fast-forwarding ${parentBranch.out} to ${branchName.out} failed: ${merged.err}`);
  }

  async function mergeWhenReady(branch: Session): Promise<void> {
    const parentId = branchParentIdOf(branch.parent);
    if (parentId === null || !isSettled(branch)) return;
    const parent = findSession(parentId);
    if (!parent?.isWorktree || !branch.isWorktree || !isSettled(parent) || isWorktreeBusy(parent)) return;
    try {
      await bringIn(branch, parent);
    } catch (error) {
      logger.warn(`[branch-merge] ${branch.name}: ${errorMessage(error)}`);
    }
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
      if (!SETTLED_STATES.includes(to)) return;
      if (branchParentIdOf(session.parent) !== null) return queueMerge(session);
      for (const branch of liveSessions()) {
        if (branchParentIdOf(branch.parent) === session.id) queueMerge(branch);
      }
    });
  }

  return { attachSession };
}

export { createBranchMerge };
