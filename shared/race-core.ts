import type { RaceRecord } from './contracts/race.ts';
import { STATES } from './states.ts';

const REMOVED_CONTESTANT = 'removed';
const SETTLED_STATES: ReadonlySet<string> = new Set([STATES.COMPLETE, STATES.DONE, STATES.FAILED, REMOVED_CONTESTANT]);

function isSettledContestantState(state: string): boolean {
  return SETTLED_STATES.has(state);
}

interface StateTransition {
  to: string;
  at: number;
}

function contestantTimeline(startedAt: number, transitions: readonly StateTransition[]): { elapsedMs: number | null; waits: number } {
  const sinceStart = transitions.filter((transition) => transition.at >= startedAt);
  const firstSettle = sinceStart.find((transition) => isSettledContestantState(transition.to));
  const waits = sinceStart.filter((transition) => transition.to === STATES.WAITING).length;
  return { elapsedMs: firstSettle ? firstSettle.at - startedAt : null, waits };
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

interface SeriesStanding {
  contestantId: string;
  wins: number;
  roundsJudged: number;
  lowestScore: number | null;
  highestScore: number | null;
}

function seriesKey(record: RaceRecord): string {
  return record.series?.id ?? record.id;
}

function seriesRoundIds(record: RaceRecord): string[] {
  if (!record.series) return [record.id];
  const seriesId = record.series.id;
  return Array.from({ length: record.spec.rounds }, (_, index) => (index === 0 ? seriesId : `${seriesId}-round-${index + 1}`));
}

function roundScores(record: RaceRecord): { contestantId: string; rank: number; score: number }[] {
  if (record.spec.reviewCase) return recallStanding(record).map((standing) => ({ contestantId: standing.contestantId, rank: standing.rank, score: standing.recall }));
  return record.panel?.standing.map((standing) => ({ contestantId: standing.contestantId, rank: standing.rank, score: standing.criteriaPassed })) ?? [];
}

function seriesStanding(records: readonly RaceRecord[]): SeriesStanding[] {
  const contestantIds = records[0]?.spec.contestants.map((contestant) => contestant.id) ?? [];
  const judgedRounds = records.map(roundScores).filter((standings) => standings.length > 0);
  return contestantIds.map((contestantId) => {
    const standings = judgedRounds.flatMap((round) => round.filter((standing) => standing.contestantId === contestantId));
    const scores = standings.map((standing) => standing.score);
    return {
      contestantId,
      wins: standings.filter((standing) => standing.rank === 1).length,
      roundsJudged: judgedRounds.length,
      lowestScore: scores.length > 0 ? Math.min(...scores) : null,
      highestScore: scores.length > 0 ? Math.max(...scores) : null,
    };
  });
}

interface RecallStanding {
  contestantId: string;
  rank: number;
  recall: number;
}

function recallStanding(record: RaceRecord): RecallStanding[] {
  const costOf = (contestantId: string) => record.metricsByContestant[contestantId]?.costUSD ?? Number.POSITIVE_INFINITY;
  const scored = Object.entries(record.recallByContestant)
    .map(([contestantId, recall]) => ({ contestantId, recall, cost: costOf(contestantId) }))
    .sort((left, right) => right.recall - left.recall || left.cost - right.cost);
  const standing: RecallStanding[] = [];
  for (const [index, entry] of scored.entries()) {
    const previous = scored[index - 1];
    const isTiedWithPrevious = previous !== undefined && previous.recall === entry.recall && previous.cost === entry.cost;
    standing.push({ contestantId: entry.contestantId, recall: entry.recall, rank: isTiedWithPrevious ? standing[index - 1].rank : index + 1 });
  }
  return standing;
}

export { REMOVED_CONTESTANT, recallStanding, seriesKey, seriesRoundIds, seriesStanding, contestantTimeline, isSettledContestantState, raceProgress, winnerNotesOf };
export type { StateTransition };
