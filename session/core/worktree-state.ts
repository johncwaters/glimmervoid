import type { MergeStatus } from "../../shared/contracts/session.ts";
import { defineTransitions } from "../../shared/state-transitions.ts";

interface MergeStatusDetail {
  reason?: string | null;
  conflicts?: string[];
}
interface MergeState {
  mergeStatus: MergeStatus;
  mergeReason: string | null;
  mergeConflicts: string[];
}

const MERGE_STATUS_MOVES = defineTransitions<MergeStatus, MergeStatus>({
  "none": { "none": "none", "pending-review": "pending-review", "merging": "merging", "parked": "parked", "merged": "merged" },
  "pending-review": { "none": "none", "pending-review": "pending-review", "merging": "merging", "parked": "parked", "merged": "merged" },
  "parked": { "none": "none", "pending-review": "pending-review", "merging": "merging", "parked": "parked" },
  "merging": { "none": "none", "pending-review": "pending-review", "parked": "parked", "merged": "merged" },
  "merged": { "none": "none", "pending-review": "pending-review" },
});

function nextMergeState(currentStatus: MergeStatus, requestedStatus: MergeStatus, detail: MergeStatusDetail = {}): MergeState | null {
  const mergeStatus = MERGE_STATUS_MOVES.next(currentStatus, requestedStatus);
  if (mergeStatus === null) return null;
  if (mergeStatus !== "parked") return { mergeStatus, mergeReason: null, mergeConflicts: [] };
  return {
    mergeStatus,
    mergeReason: detail.reason || null,
    mergeConflicts: Array.isArray(detail.conflicts) ? detail.conflicts : [],
  };
}

export { nextMergeState };
export type { MergeStatus };
