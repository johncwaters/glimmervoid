import type { SessionState } from '#shared/states.ts';
import { STATES } from '#shared/states.ts';
import type { SessionStateSource } from '../session-actions-core.ts';
import { promptKindNeedWords } from '../session-card/face-core.ts';

export type SessionAttentionTier = 'now' | 'later' | 'resting';
interface SessionAttentionRow {
  state?: unknown;
}

const SESSION_ATTENTION_TIER_BY_STATE: Readonly<Record<SessionState, SessionAttentionTier>> = {
  WAITING: 'now',
  COMPLETE: 'later',
  FAILED: 'resting',
  IDLE: 'resting',
  RUNNING: 'resting',
  STARTING: 'resting',
  INITIALIZING: 'resting',
  DORMANT: 'resting',
  DONE: 'resting',
};
const attentionTierByState: ReadonlyMap<string, SessionAttentionTier> = new Map(Object.entries(SESSION_ATTENTION_TIER_BY_STATE));

export function sessionAttentionTier(row: SessionAttentionRow): SessionAttentionTier {
  const tier = typeof row.state === 'string' ? attentionTierByState.get(row.state) : undefined;
  return tier ?? 'resting';
}

interface RosterEntry {
  isDormant?: boolean;
}

export interface SessionRow<Session, Name = string> extends RosterEntry {
  id: string;
  ui: Session;
  name: Name;
  isDormant: boolean;
  state: string;
}

export function buildSessionRows<Session extends SessionStateSource, Name>(
  sessions: Iterable<readonly [string, Session]>,
  nameOf: (session: Session) => Name,
): SessionRow<Session, Name>[] {
  return [...sessions].map(([id, ui]) => {
    const state = ui.currentState || STATES.DORMANT;
    return { id, ui, name: nameOf(ui), isDormant: state === STATES.DORMANT, state };
  });
}

export function orderRoster<Row extends RosterEntry>(list: readonly Row[]): Row[] {
  return [...list].sort((a, b) => Number(a.isDormant === true) - Number(b.isDormant === true));
}

export function pickNextAttention(orderedIds: readonly string[], currentId: string | null | undefined) {
  if (!orderedIds.length) return null;
  const i = currentId == null ? -1 : orderedIds.indexOf(currentId);
  return orderedIds[(i + 1) % orderedIds.length];
}

export function pickStagedSession(queuedIds: readonly string[], stagedId: string | null) {
  if (stagedId !== null && queuedIds.includes(stagedId)) return stagedId;
  return queuedIds[0] ?? null;
}

const STAGE_NEED_WORDS_BY_STATE: ReadonlyMap<string, string> = new Map([
  [STATES.FAILED, 'Failed'],
  [STATES.COMPLETE, 'Finished'],
]);

export function stageNeedWords(state: string, pendingPromptKind: string | null) {
  return STAGE_NEED_WORDS_BY_STATE.get(state) ?? promptKindNeedWords(pendingPromptKind ?? '');
}

export function pickAdjacent(orderedIds: readonly string[], currentId: string | null | undefined, dir: number) {
  if (!orderedIds.length) return null;
  const step = dir < 0 ? -1 : 1;
  const cur = currentId == null ? -1 : orderedIds.indexOf(currentId);
  const start = cur === -1 ? (step === 1 ? -1 : 0) : cur;
  return orderedIds[(start + step + orderedIds.length) % orderedIds.length];
}

export function needsAttention({ state }: SessionAttentionRow = {}) {
  return sessionAttentionTier({ state }) !== 'resting';
}

const JUMP_RANK_BY_STATE: ReadonlyMap<string, number> = new Map([
  [STATES.WAITING, 0],
  [STATES.FAILED, 1],
  [STATES.COMPLETE, 2],
]);

function jumpRankOf({ state }: SessionAttentionRow): number | undefined {
  return typeof state === 'string' ? JUMP_RANK_BY_STATE.get(state) : undefined;
}

export function orderAttentionQueue<Row extends SessionAttentionRow & { id: string }>(rosterOrderedRows: readonly Row[]): string[] {
  return rosterOrderedRows
    .filter((row) => jumpRankOf(row) !== undefined)
    .sort((first, second) => (jumpRankOf(first) ?? 0) - (jumpRankOf(second) ?? 0))
    .map(({ id }) => id);
}

type AttentionCountRow = SessionAttentionRow | null | undefined;

export interface AttentionCounts {
  waitingCount: number;
  finishedCount: number;
  failedCount: number;
}

export function countAttentionByKind(rows: readonly AttentionCountRow[] | null | undefined): AttentionCounts {
  const counts = { waitingCount: 0, finishedCount: 0, failedCount: 0 };
  for (const row of (rows || [])) {
    if (row?.state === STATES.FAILED) {
      counts.failedCount++;
      continue;
    }
    if (!needsAttention(row || {})) continue;
    if (row?.state === STATES.COMPLETE) {
      counts.finishedCount++;
      continue;
    }
    counts.waitingCount++;
  }
  return counts;
}

export function jumpTargetCount({ waitingCount, finishedCount, failedCount }: AttentionCounts) {
  return waitingCount + failedCount + finishedCount;
}

export function titleAlertCount({ waitingCount, failedCount }: AttentionCounts) {
  return waitingCount + failedCount;
}

export function headerAttentionState({ waitingCount, failedCount, finishedCount }: AttentionCounts): SessionState | null {
  if (waitingCount > 0) return STATES.WAITING;
  if (failedCount > 0) return STATES.FAILED;
  if (finishedCount > 0) return STATES.COMPLETE;
  return null;
}

export function hasAnyAttention(counts: AttentionCounts) {
  return jumpTargetCount(counts) > 0;
}

export function attentionSummaryText({ waitingCount, finishedCount, failedCount }: AttentionCounts) {
  const parts: string[] = [];
  if (waitingCount === 1) parts.push('1 NEEDS YOU');
  if (waitingCount > 1) parts.push(`${waitingCount} NEED YOU`);
  if (failedCount > 0) parts.push(`${failedCount} FAILED`);
  if (finishedCount > 0) parts.push(`${finishedCount} FINISHED`);
  if (parts.length === 0) return 'ALL CLEAR';
  return parts.join(', ');
}

const ATTENTION_RANK_BY_LEVEL = new Map<string, number>([['hand', 2]]);
const ATTENTION_RANK_PRESENT = 1;

type AttentionLevel = string | boolean | null | undefined;

export function attentionRank(level: AttentionLevel) {
  if (!level) return 0;
  if (typeof level === 'string') return ATTENTION_RANK_BY_LEVEL.get(level) || ATTENTION_RANK_PRESENT;
  return ATTENTION_RANK_PRESENT;
}

export function pickStrongestAttention(levels?: readonly AttentionLevel[] | null): string | boolean {
  let strongest: string | boolean = false;
  let strongestRank = 0;
  for (const level of (levels || [])) {
    const rank = attentionRank(level);
    if (rank <= strongestRank) continue;
    strongest = typeof level === 'string' ? level : true;
    strongestRank = rank;
  }
  return strongest;
}
