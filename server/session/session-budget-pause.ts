import { KILLABLE_STATES } from '../../shared/states.ts';
import { ownerIdOf } from '../../shared/parent-link.ts';
import type { Session } from '../../session/sessions.ts';

type PausableSession = Pick<Session, 'id' | 'name' | 'ephemeral' | 'parent' | 'state' | 'lastOperatorActivityAt' | 'snooze' | 'killSession'>;
type BudgetHoldPhase = 'start' | 'continue' | 'end';

interface PauseOutcome {
  paused: PausableSession[];
  waitingOnChildren: PausableSession[];
}

function pauseEach(sessions: readonly PausableSession[]): PauseOutcome {
  const paused: PausableSession[] = [];
  let waitingOnChildren = [...sessions];
  let hasSettledAny = true;
  while (hasSettledAny && waitingOnChildren.length > 0) {
    const stillWaitingOnChildren: PausableSession[] = [];
    for (const session of waitingOnChildren) {
      const snoozed = session.snooze();
      if (!snoozed.ok && snoozed.reason === 'has-children') {
        stillWaitingOnChildren.push(session);
        continue;
      }
      if (snoozed.ok || session.killSession()) paused.push(session);
    }
    hasSettledAny = stillWaitingOnChildren.length < waitingOnChildren.length;
    waitingOnChildren = stillWaitingOnChildren;
  }
  return { paused, waitingOnChildren };
}

function createBudgetSessionPauser(liveSessions: () => readonly PausableSession[], nowMs: () => number) {
  let pausedAtMs = 0;
  const heldSessionIds = new Set<string>();

  function isRunning(session: PausableSession): boolean {
    const isLaneSession = session.ephemeral && ownerIdOf(session.parent) === null;
    return !isLaneSession && KILLABLE_STATES.includes(session.state);
  }

  function pauseAll(): string[] {
    pausedAtMs = nowMs();
    const { paused, waitingOnChildren } = pauseEach(liveSessions().filter(isRunning));
    for (const session of [...paused, ...waitingOnChildren]) heldSessionIds.add(session.id);
    return paused.map((session) => session.name);
  }

  function repauseRestarted(): string[] {
    const runningWithoutOperator = liveSessions()
      .filter((session) => heldSessionIds.has(session.id) && isRunning(session))
      .filter((session) => {
        if (session.lastOperatorActivityAt < pausedAtMs) return true;
        heldSessionIds.delete(session.id);
        return false;
      });
    return pauseEach(runningWithoutOperator).paused.map((session) => session.name);
  }

  return (phase: BudgetHoldPhase): string[] => {
    if (phase === 'start') return pauseAll();
    if (phase === 'continue') return repauseRestarted();
    heldSessionIds.clear();
    return [];
  };
}

export { createBudgetSessionPauser };
export type { BudgetHoldPhase };
