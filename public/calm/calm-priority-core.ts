import type { PendingPromptDetail } from '#shared/contracts/session.ts';
import { STATES } from '#shared/states.ts';
import { needsAttention } from '../focus-view/attention-core.ts';

export type CalmTier = 'now' | 'next' | 'later' | 'working' | 'resting';

export interface CalmRow {
  id: string;
  name: string;
  state: string;
  stateSince?: number | null;
  agent?: string | null;
  pendingPromptKind?: string | null;
  pendingPromptDetail?: PendingPromptDetail | null;
  unseen?: boolean;
}

export function tierOf(row: CalmRow): CalmTier {
  if (row.state === STATES.WAITING) return 'now';
  if (row.state === STATES.FAILED) return 'next';
  if (needsAttention(row)) return 'later';
  switch (row.state) {
    case STATES.RUNNING:
    case STATES.IDLE:
    case STATES.STARTING:
    case STATES.INITIALIZING:
      return 'working';
    default:
      return 'resting';
  }
}

const QUEUE_RANK_BY_TIER = { now: 0, next: 1, later: 2, working: 3, resting: 4 };

export function orderCalmQueue<Row extends CalmRow>(rows: readonly Row[]): Row[] {
  return rows.map((row, index) => ({ row, index, rank: QUEUE_RANK_BY_TIER[tierOf(row)] }))
    .filter((entry) => entry.rank < QUEUE_RANK_BY_TIER.working)
    .sort((first, second) => first.rank - second.rank
      || (first.row.stateSince ?? Infinity) - (second.row.stateSince ?? Infinity)
      || first.index - second.index)
    .map((entry) => entry.row);
}

export function countByTier(rows: readonly CalmRow[]) {
  const counts = { now: 0, next: 0, later: 0, working: 0 };
  for (const row of rows) {
    const tier = tierOf(row);
    if (tier === 'resting') continue;
    counts[tier] += 1;
  }
  return counts;
}

export type CalmComponent = 'permission' | 'plan' | 'failure' | 'review' | 'terminal';

function pickPromptComponent(row: CalmRow): { component: CalmComponent; canApprove: boolean } {
  if (row.pendingPromptKind === 'plan') return { component: 'plan', canApprove: false };
  if (row.pendingPromptKind === 'permission' && row.agent === 'claude-code') {
    return { component: 'permission', canApprove: row.pendingPromptDetail?.isComplete === true };
  }
  return { component: 'terminal', canApprove: false };
}

export function pickComponent(row: CalmRow): { component: CalmComponent; canApprove: boolean } {
  switch (tierOf(row)) {
    case 'now':
      return pickPromptComponent(row);
    case 'next':
      return { component: 'failure', canApprove: false };
    case 'later':
      return { component: 'review', canApprove: false };
    default:
      return { component: 'terminal', canApprove: false };
  }
}
