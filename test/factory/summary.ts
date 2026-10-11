import type { Verdict } from './verdict.ts';

export function summaryRows(verdicts: Verdict[]) {
  return verdicts.map((verdict, index) => ({
    run: index + 1, intent: verdict.intentName, outcome: verdict.outcome, failureClass: verdict.failureClass,
    queueReplyError: verdict.queueReplyError,
    durationMs: verdict.durationMs, spendUsd: verdict.spendUsd, sessionCount: verdict.sessionCount,
    attemptsPerOrder: verdict.attemptsPerOrder,
  }));
}
