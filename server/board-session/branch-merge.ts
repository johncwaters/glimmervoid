import { STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';
import { errorMessage } from '../../shared/text.ts';
import type { Session } from '../../session/sessions.ts';
import { runHardenedGit } from '../git/git-workspace.ts';

const GIT_TIMEOUT_MS = 60000;
const SETTLED_STATES: readonly SessionState[] = [STATES.IDLE, STATES.COMPLETE];
const BUSY_MERGE_STATUSES: readonly string[] = ['merging', 'parked'];

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

interface BranchMergeDeps {
  findSession: (sessionId: string) => Session | null;
  liveSessions: () => readonly Session[];
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

function createBranchMerge({ findSession, liveSessions, logger }: BranchMergeDeps) {
  const mergingBranchIds = new Set<string>();
  const mergeQueueByParentId = new Map<string, Promise<void>>();
  const reportedHeadByBranchId = new Map<string, string>();

  function tellParent(parent: Session, branch: Session, branchHead: string, problem: string): void {
    if (reportedHeadByBranchId.get(branch.id) === branchHead) return;
    reportedHeadByBranchId.set(branch.id, branchHead);
    const queued = parent.queueChatMessage(`Glimmervoid could not bring the commits of your branch session ${branch.name} into your branch: ${problem}`, []);
    if (!queued.ok) logger.warn(`[branch-merge] could not tell ${parent.name} about ${branch.name}: ${queued.error}`);
  }

  async function bringIn(branch: Session, parent: Session): Promise<void> {
    const branchDir = branch.effectiveCwd();
    const parentDir = parent.effectiveCwd();
    const parentBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], parentDir);
    const branchName = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], branchDir);
    if (!parentBranch.ok || !branchName.ok) return logger.warn(`[branch-merge] could not read the branches of ${branch.name}: ${parentBranch.err || branchName.err}`);
    const ahead = await runGit(['rev-list', '--count', `${parentBranch.out}..${branchName.out}`], branchDir);
    if (!ahead.ok || Number(ahead.out) === 0) return;
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
    const link = branch.branchOf;
    if (link === null || !isSettled(branch)) return;
    const parent = findSession(link.parentId);
    if (!parent?.isWorktree || !branch.isWorktree || !isSettled(parent) || isWorktreeBusy(parent)) return;
    try {
      await bringIn(branch, parent);
    } catch (error) {
      logger.warn(`[branch-merge] ${branch.name}: ${errorMessage(error)}`);
    }
  }

  function queueMerge(branch: Session): void {
    const link = branch.branchOf;
    if (link === null || mergingBranchIds.has(branch.id)) return;
    mergingBranchIds.add(branch.id);
    const previous = mergeQueueByParentId.get(link.parentId) ?? Promise.resolve();
    const queued = previous.then(() => mergeWhenReady(branch)).finally(() => {
      mergingBranchIds.delete(branch.id);
      if (mergeQueueByParentId.get(link.parentId) === queued) mergeQueueByParentId.delete(link.parentId);
    });
    mergeQueueByParentId.set(link.parentId, queued);
  }

  function attachSession(session: Session): void {
    session.on('state-change', ({ to }: { to: SessionState }) => {
      if (!SETTLED_STATES.includes(to)) return;
      if (session.branchOf !== null) return queueMerge(session);
      for (const branch of liveSessions()) {
        if (branch.branchOf?.parentId === session.id) queueMerge(branch);
      }
    });
  }

  return { attachSession };
}

export { createBranchMerge };
