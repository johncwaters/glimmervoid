import { KILLABLE_STATES } from '../../shared/states.ts';
import { ownerIdOf } from '../../shared/parent-link.ts';
import type { Session } from '../../session/sessions.ts';

type PausableSession = Pick<Session, 'id' | 'name' | 'ephemeral' | 'parent' | 'state' | '_lastOperatorInputAt' | 'snooze' | 'killSession'>;
type BudgetHoldPhase = 'start' | 'continue' | 'end';

function pauseEach(sessions: readonly PausableSession[]): PausableSession[] {
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
  return [...paused, ...waitingOnChildren.filter((session) => session.killSession())];
}

function createBudgetSessionPauser(liveSessions: () => readonly PausableSession[], nowMs: () => number) {
  let pausedAtMs = 0;
  const pausedSessionIds = new Set<string>();

  function isRunning(session: PausableSession): boolean {
    const isLaneSession = session.ephemeral && ownerIdOf(session.parent) === null;
    return !isLaneSession && KILLABLE_STATES.includes(session.state);
  }

  function pauseAll(): string[] {
    pausedAtMs = nowMs();
    const paused = pauseEach(liveSessions().filter(isRunning));
    for (const session of paused) pausedSessionIds.add(session.id);
    return paused.map((session) => session.name);
  }

  function repauseRestarted(): string[] {
    const restartedWithoutOperator = liveSessions()
      .filter((session) => pausedSessionIds.has(session.id) && isRunning(session))
      .filter((session) => {
        if (session._lastOperatorInputAt < pausedAtMs) return true;
        pausedSessionIds.delete(session.id);
        return false;
      });
    return pauseEach(restartedWithoutOperator).map((session) => session.name);
  }

  return (phase: BudgetHoldPhase): string[] => {
    if (phase === 'start') return pauseAll();
    if (phase === 'continue') return repauseRestarted();
    pausedSessionIds.clear();
    return [];
  };
}

export { createBudgetSessionPauser };
export type { BudgetHoldPhase };
