import { STATES } from './states.ts';

const REMOVED_CONTESTANT = 'removed';
const SETTLED_STATES: ReadonlySet<string> = new Set([STATES.COMPLETE, STATES.DONE, STATES.FAILED, REMOVED_CONTESTANT]);

function isSettledContestantState(state: string): boolean {
  return SETTLED_STATES.has(state);
}

function raceProgress(sessionIds: readonly string[], stateOf: (sessionId: string) => string): { settled: number; total: number; isAllSettled: boolean } {
  const settled = sessionIds.filter((sessionId) => isSettledContestantState(stateOf(sessionId))).length;
  return { settled, total: sessionIds.length, isAllSettled: sessionIds.length > 0 && settled === sessionIds.length };
}

export { REMOVED_CONTESTANT, raceProgress };
