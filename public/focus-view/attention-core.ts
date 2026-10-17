import type { SessionState } from '#shared/states.ts';
import { STATES } from '#shared/states.ts';
import type { SessionStateSource } from '../session-actions-core.ts';

export type SessionAttentionTier = 'now' | 'next' | 'later' | 'ready' | 'working' | 'resting';
export type SessionAttentionOption = 'needs-you' | 'phone-triage' | 'favicon';

interface SessionAttentionRow {
  state?: unknown;
  unseen?: unknown;
}

type AttentionCondition = 'always' | 'unseen' | 'never';
type StateAttentionRule = { tier: SessionAttentionTier } & Record<SessionAttentionOption, AttentionCondition>;

const SESSION_ATTENTION_RANK_BY_TIER: Readonly<Record<SessionAttentionTier, number>> = Object.freeze({
  now: 0, next: 1, later: 2, ready: 3, working: 4, resting: 5,
});

const SESSION_ATTENTION_RULES: Readonly<Record<SessionState, StateAttentionRule>> = {
  WAITING: { tier: 'now', 'needs-you': 'always', 'phone-triage': 'always', favicon: 'always' },
  FAILED: { tier: 'next', 'needs-you': 'never', 'phone-triage': 'always', favicon: 'never' },
  COMPLETE: { tier: 'later', 'needs-you': 'unseen', 'phone-triage': 'always', favicon: 'always' },
  IDLE: { tier: 'ready', 'needs-you': 'never', 'phone-triage': 'never', favicon: 'never' },
  RUNNING: { tier: 'working', 'needs-you': 'never', 'phone-triage': 'always', favicon: 'never' },
  STARTING: { tier: 'working', 'needs-you': 'never', 'phone-triage': 'never', favicon: 'never' },
  INITIALIZING: { tier: 'working', 'needs-you': 'never', 'phone-triage': 'never', favicon: 'never' },
  DORMANT: { tier: 'resting', 'needs-you': 'never', 'phone-triage': 'never', favicon: 'never' },
  DONE: { tier: 'resting', 'needs-you': 'never', 'phone-triage': 'never', favicon: 'never' },
};
const attentionRuleByState: ReadonlyMap<string, StateAttentionRule> = new Map(Object.entries(SESSION_ATTENTION_RULES));

export function sessionAttentionTier(row: SessionAttentionRow, option: SessionAttentionOption): SessionAttentionTier {
  const rule = typeof row.state === 'string' ? attentionRuleByState.get(row.state) : undefined;
  if (!rule) return 'resting';
  const condition = rule[option];
  if (condition === 'never') return 'resting';
  if (condition === 'unseen' && row.unseen !== true) return 'resting';
  return rule.tier;
}

export function sessionAttentionRank(row: SessionAttentionRow, option: SessionAttentionOption): number {
  return SESSION_ATTENTION_RANK_BY_TIER[sessionAttentionTier(row, option)];
}

interface RosterEntry {
  isDormant?: boolean;
  name?: unknown;
}

export interface SessionRow<Session, Name = string> extends RosterEntry {
  id: string;
  ui: Session;
  name: Name;
  isDormant: boolean;
  state: string;
  unseen: boolean;
}

export function buildSessionRows<Session extends SessionStateSource, Name>(
  sessions: Iterable<readonly [string, Session]>,
  nameOf: (session: Session) => Name,
): SessionRow<Session, Name>[] {
  return [...sessions].map(([id, ui]) => {
    const state = ui.currentState || STATES.DORMANT;
    return { id, ui, name: nameOf(ui), isDormant: state === STATES.DORMANT, state, unseen: false };
  });
}

export function orderRoster<Row extends RosterEntry>(list: readonly Row[]): Row[] {
  return [...list].sort((a, b) =>
    (a.isDormant === b.isDormant ? 0 : a.isDormant ? 1 : -1)
    || String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
}

export function pickNextAttention(orderedIds: readonly string[], currentId: string | null | undefined) {
  if (!orderedIds.length) return null;
  const i = currentId == null ? -1 : orderedIds.indexOf(currentId);
  return orderedIds[(i + 1) % orderedIds.length];
}

export function pickAdjacent(orderedIds: readonly string[], currentId: string | null | undefined, dir: number) {
  if (!orderedIds.length) return null;
  const step = dir < 0 ? -1 : 1;
  const cur = currentId == null ? -1 : orderedIds.indexOf(currentId);
  const start = cur === -1 ? (step === 1 ? -1 : 0) : cur;
  return orderedIds[(start + step + orderedIds.length) % orderedIds.length];
}

export function needsAttention({ state, unseen }: { state?: unknown; unseen?: unknown } = {}) {
  return sessionAttentionRank({ state, unseen }, 'needs-you') < SESSION_ATTENTION_RANK_BY_TIER.ready;
}

type AttentionCountRow = { state?: unknown; unseen?: unknown } | null | undefined;

interface AttentionCounts {
  waitingCount: number;
  finishedCount: number;
}

export function countAttentionByKind(rows: readonly AttentionCountRow[] | null | undefined): AttentionCounts {
  const counts = { waitingCount: 0, finishedCount: 0 };
  for (const row of (rows || [])) {
    if (!needsAttention(row || {})) continue;
    if (row?.state === STATES.COMPLETE) {
      counts.finishedCount++;
      continue;
    }
    counts.waitingCount++;
  }
  return counts;
}

export function attentionSummaryText({ waitingCount, finishedCount }: AttentionCounts) {
  const parts: string[] = [];
  if (waitingCount === 1) parts.push('1 NEEDS YOU');
  if (waitingCount > 1) parts.push(`${waitingCount} NEED YOU`);
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
