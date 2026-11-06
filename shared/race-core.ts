import type { RaceRecord } from './contracts/race.ts';
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

function winnerNotesOf(record: RaceRecord, contestantId: string): string | null {
  const panelNotes = (record.panel?.verdicts ?? []).map((verdict) => verdict.contestants[contestantId]?.notes.trim() ?? '').filter((notes) => notes !== '');
  if (panelNotes.length > 0) return panelNotes.join('\n\n');
  return record.judge?.notes[contestantId] ?? null;
}

export { REMOVED_CONTESTANT, raceProgress, winnerNotesOf };
