import { OUTCOME_NAMES } from '../../shared/outcome-names.ts';
import type { OutcomeName } from '../../shared/outcome-names.ts';

type OutcomeCounts = Record<OutcomeName, number>;
type OutcomeSummaryFields = Record<string, number>;

const LOOP_LAG_REPORT_THRESHOLD_MS = 100;

function emptyOutcomeCounts(): OutcomeCounts {
  return {
    notifyDelivered: 0,
    notifyFailed: 0,
    telegramDelivered: 0,
    telegramFailed: 0,
    hookRejected403: 0,
    hookRejected404: 0,
    hookRejectedNonLoopback: 0,
    controlWsOpened: 0,
    controlWsClosed: 0,
    dataWsOpened: 0,
    dataWsClosed: 0,
  };
}

function countOutcome(counts: OutcomeCounts, name: OutcomeName): void {
  counts[name] += 1;
}

function drainOutcomeSummary(
  counts: OutcomeCounts,
  loopLagP99Ms: number | null,
): { fields: OutcomeSummaryFields | null; next: OutcomeCounts } {
  const fields: OutcomeSummaryFields = {};
  for (const name of OUTCOME_NAMES) {
    if (counts[name] === 0) continue;
    fields[name] = counts[name];
  }
  const hasCountedOutcomes = Object.keys(fields).length > 0;
  const next = hasCountedOutcomes ? emptyOutcomeCounts() : counts;
  if (loopLagP99Ms !== null && loopLagP99Ms > LOOP_LAG_REPORT_THRESHOLD_MS) {
    fields.loopLagP99Ms = Math.round(loopLagP99Ms);
  }
  if (Object.keys(fields).length === 0) return { fields: null, next };
  return { fields, next };
}

export { countOutcome, drainOutcomeSummary, emptyOutcomeCounts, LOOP_LAG_REPORT_THRESHOLD_MS };
export type { OutcomeCounts, OutcomeSummaryFields };
