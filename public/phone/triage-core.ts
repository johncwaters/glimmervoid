import { sessionAttentionRank } from '../focus-view/attention-core.ts';

export function orderSessionsForTriage<Row extends { state?: unknown }>(rows: readonly Row[] | null | undefined): Row[] {
  return [...(rows || [])]
    .map((row, index) => ({ row, index }))
    .sort((first, second) => sessionAttentionRank(first.row || {}, 'phone-triage') - sessionAttentionRank(second.row || {}, 'phone-triage') || first.index - second.index)
    .map((entry) => entry.row);
}
