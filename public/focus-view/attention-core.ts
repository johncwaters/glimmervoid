import type { SessionState } from '#shared/states.ts';
import { STATES } from '#shared/states.ts';
import { UnseenOutcome } from '#shared/contracts/session.ts';
import type { SessionStateSource } from '../session-actions-core.ts';
import { promptKindNeedWords } from '../session-card/face-core.ts';

type SessionAttentionTier = 'now' | 'later' | 'resting';
interface SessionAttentionRow {
  state?: unknown;
  unseenOutcome?: unknown;
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
  id: string;
  isDormant?: boolean;
  ownerId?: string | null;
}

export interface SessionRow<Session, Name = string> extends RosterEntry {
  id: string;
  ui: Session;
  name: Name;
  isDormant: boolean;
  state: string;
  unseenOutcome: UnseenOutcome | null;
  ownerId: string | null;
}

export function buildSessionRows<Session extends SessionStateSource & { ownerId?: string | null; unseenOutcome?: UnseenOutcome | null }, Name>(
  sessions: Iterable<readonly [string, Session]>,
  nameOf: (session: Session) => Name,
): SessionRow<Session, Name>[] {
  return [...sessions].map(([id, ui]) => {
    const state = ui.currentState || STATES.DORMANT;
    return { id, ui, name: nameOf(ui), isDormant: state === STATES.DORMANT, state, unseenOutcome: ui.unseenOutcome ?? null, ownerId: ui.ownerId ?? null };
  });
}

function placeOwnedAfterOwners<Row extends RosterEntry>(rows: readonly Row[]): Row[] {
  const presentIds = new Set(rows.map(({ id }) => id));
  const presentOwnerIdOf = (row: Row) => (row.ownerId && presentIds.has(row.ownerId) ? row.ownerId : null);
  const ownedRowsByOwnerId = new Map<string, Row[]>();
  for (const row of rows) {
    const ownerId = presentOwnerIdOf(row);
    if (ownerId) ownedRowsByOwnerId.set(ownerId, [...(ownedRowsByOwnerId.get(ownerId) ?? []), row]);
  }
  return rows.flatMap((row) => (presentOwnerIdOf(row) ? [] : [row, ...(ownedRowsByOwnerId.get(row.id) ?? [])]));
}

export function orderRoster<Row extends RosterEntry>(list: readonly Row[]): Row[] {
  return placeOwnedAfterOwners([...list].sort((a, b) => Number(a.isDormant === true) - Number(b.isDormant === true)));
}

export function describeOwnership({ ownerName, ownedCount }: { ownerName: string | null; ownedCount: number }): string | null {
  if (ownerName !== null) return `Owned by ${ownerName}`;
  if (ownedCount === 1) return 'Owns 1 session';
  if (ownedCount > 1) return `Owns ${ownedCount} sessions`;
  return null;
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

export type AttentionKind = 'waiting' | UnseenOutcome;

export interface AttentionTile {
  id: string;
  kind: AttentionKind;
  name: string;
}

function attentionKindOf({ state, unseenOutcome }: SessionAttentionRow): AttentionKind | null {
  if (state === STATES.WAITING) return 'waiting';
  const parsedUnseenOutcome = UnseenOutcome.safeParse(unseenOutcome);
  return parsedUnseenOutcome.success ? parsedUnseenOutcome.data : null;
}

export function hasUnseenOutcomeAttention(row: SessionAttentionRow = {}) {
  const kind = attentionKindOf(row);
  return kind !== null && kind !== 'waiting';
}

export function needsAttention(row: SessionAttentionRow = {}) {
  return attentionKindOf(row) !== null;
}

const JUMP_RANK_BY_KIND: ReadonlyMap<AttentionKind, number> = new Map<AttentionKind, number>([
  ['failed', 0],
  ['waiting', 1],
  ['finished', 2],
]);

function jumpRankOf(row: SessionAttentionRow): number | undefined {
  const kind = attentionKindOf(row);
  return kind === null ? undefined : JUMP_RANK_BY_KIND.get(kind);
}

export function orderAttentionQueue<Row extends SessionAttentionRow & { id: string }>(rosterOrderedRows: readonly Row[]): string[] {
  return rosterOrderedRows
    .filter((row) => jumpRankOf(row) !== undefined)
    .sort((first, second) => (jumpRankOf(first) ?? 0) - (jumpRankOf(second) ?? 0))
    .map(({ id }) => id);
}

export function orderAttentionLine<Row extends SessionAttentionRow & { id: string; name?: string | null }>(rosterOrderedRows: readonly Row[], focusedId: string | null | undefined): AttentionTile[] {
  const rowById = new Map(rosterOrderedRows.map((row) => [row.id, row]));
  return orderAttentionQueue(rosterOrderedRows).flatMap((id) => {
    const row = rowById.get(id);
    const kind = row ? attentionKindOf(row) : null;
    if (!row || kind === null || id === focusedId) return [];
    return [{ id, kind, name: row.name ?? '' }];
  });
}

export const ATTENTION_TILE_SIZES_PX = { headTile: 32, tile: 26, tileGap: 4, overflowSlot: 40 } as const;

export function fitAttentionTiles(availableWidthPx: number, tileCount: number) {
  if (tileCount === 0) return 0;
  const { headTile, tile, tileGap, overflowSlot } = ATTENTION_TILE_SIZES_PX;
  const tileStepPx = tile + tileGap;
  if (headTile + (tileCount - 1) * tileStepPx <= availableWidthPx) return tileCount;
  const roomBeforeOverflowPx = availableWidthPx - overflowSlot - tileGap - headTile;
  const tilesAfterHead = Math.floor(roomBeforeOverflowPx / tileStepPx);
  return Math.max(1, Math.min(tileCount - 1, 1 + tilesAfterHead));
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
    const kind = attentionKindOf(row || {});
    if (kind === 'waiting') counts.waitingCount++;
    if (kind === 'failed') counts.failedCount++;
    if (kind === 'finished') counts.finishedCount++;
  }
  return counts;
}

export function jumpTargetCount({ waitingCount, finishedCount, failedCount }: AttentionCounts) {
  return waitingCount + failedCount + finishedCount;
}

export function titleAlertCount({ waitingCount, failedCount }: AttentionCounts) {
  return waitingCount + failedCount;
}

export function attentionSummaryText({ waitingCount, finishedCount, failedCount }: AttentionCounts) {
  const parts: string[] = [];
  if (failedCount > 0) parts.push(`${failedCount} FAILED`);
  if (waitingCount === 1) parts.push('1 NEEDS YOU');
  if (waitingCount > 1) parts.push(`${waitingCount} NEED YOU`);
  if (finishedCount > 0) parts.push(`${finishedCount} FINISHED`);
  if (parts.length === 0) return 'ALL CLEAR';
  return parts.join(', ');
}

const ATTENTION_RANK_BY_LEVEL = new Map<string, number>([['hand', 2]]);
const ATTENTION_RANK_PRESENT = 1;

type AttentionLevel = string | boolean | null | undefined;

function attentionRank(level: AttentionLevel) {
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
