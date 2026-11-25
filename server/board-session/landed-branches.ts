import { branchParentIdOf } from '../../shared/parent-link.ts';
import { STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';
import { errorMessage } from '../../shared/text.ts';
import type { Session } from '../../session/sessions.ts';

const SETTLED_STATES: readonly SessionState[] = [STATES.IDLE, STATES.COMPLETE];
const LANDED_BRANCH_IDLE_MS = 30000;

interface LandedBranchesDeps {
  findSession: (sessionId: string) => Session | null;
  closeBranch: (branchId: string) => Promise<{ ok: boolean; error?: string }>;
  landedBranchIdleMs?: number;
  logger: Pick<Console, 'warn'>;
}

async function isBranchWorkLanded(branch: Session): Promise<boolean> {
  return !(await branch.hasUnmergedWork());
}

function createLandedBranches({ findSession, closeBranch, landedBranchIdleMs = LANDED_BRANCH_IDLE_MS, logger }: LandedBranchesDeps) {
  const branchIdsSeenWithUnlandedWork = new Set<string>();
  const closeTimerByBranchId = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelIdleClose(branchId: string): void {
    clearTimeout(closeTimerByBranchId.get(branchId));
    closeTimerByBranchId.delete(branchId);
  }

  function scheduleIdleClose(branchId: string): void {
    cancelIdleClose(branchId);
    const timer = setTimeout(() => {
      closeTimerByBranchId.delete(branchId);
      void closeIfLanded(branchId).catch((error: unknown) => logger.warn(`[landed-branches] closing ${branchId}: ${errorMessage(error)}`));
    }, landedBranchIdleMs);
    timer.unref();
    closeTimerByBranchId.set(branchId, timer);
  }

  async function closeIfLanded(branchId: string): Promise<void> {
    const branch = findSession(branchId);
    const isSettled = () => !branch?._destroyed && SETTLED_STATES.includes(branch?.state ?? STATES.RUNNING);
    if (!branch || !isSettled()) return;
    const isLanded = await isBranchWorkLanded(branch);
    if (!isLanded) return void branchIdsSeenWithUnlandedWork.add(branch.id);
    if (!branchIdsSeenWithUnlandedWork.has(branch.id) || !isSettled()) return;
    const closed = await closeBranch(branch.id);
    if (!closed.ok) logger.warn(`[landed-branches] could not close ${branch.name}: ${closed.error ?? 'refused'}`);
  }

  function attachSession(session: Session): void {
    if (branchParentIdOf(session.parent) === null) return;
    session.on('state-change', ({ to }: { to: SessionState }) => {
      if (!SETTLED_STATES.includes(to)) return void cancelIdleClose(session.id);
      scheduleIdleClose(session.id);
    });
    session.on('teardown', () => {
      cancelIdleClose(session.id);
      branchIdsSeenWithUnlandedWork.delete(session.id);
    });
  }

  return { attachSession };
}

export { createLandedBranches, isBranchWorkLanded };
