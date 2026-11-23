import { KILLABLE_STATES } from '../../shared/states.ts';
import { ownerIdOf } from '../../shared/parent-link.ts';
import type { Session } from '../../session/sessions.ts';

type PausableSession = Pick<Session, 'id' | 'name' | 'ephemeral' | 'parent' | 'state' | '_lastOperatorInputAt' | 'snooze' | 'killSession'>;
type BudgetHoldPhase = 'start' | 'continue' | 'end';

function pauseOne(session: PausableSession): boolean {
  return session.snooze().ok || session.killSession();
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
    const paused = liveSessions().filter(isRunning).filter(pauseOne);
    for (const session of paused) pausedSessionIds.add(session.id);
    return paused.map((session) => session.name);
  }

  function repauseRestarted(): string[] {
    return liveSessions()
      .filter((session) => pausedSessionIds.has(session.id) && isRunning(session))
      .filter((session) => {
        if (session._lastOperatorInputAt < pausedAtMs) return true;
        pausedSessionIds.delete(session.id);
        return false;
      })
      .filter(pauseOne)
      .map((session) => session.name);
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
