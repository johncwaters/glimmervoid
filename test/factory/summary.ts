import type { RecordedVerdict } from './telemetry-core.ts';

export function summaryRows(verdicts: RecordedVerdict[]) {
  return verdicts.map((verdict, index) => ({
    run: index + 1, intent: verdict.intentName, outcome: verdict.outcome, failureClass: verdict.failureClass,
    queueReplyError: verdict.queueReplyError,
    telemetrySendResult: verdict.telemetrySendResult,
    durationMs: verdict.durationMs, spendUsd: verdict.spendUsd, sessionCount: verdict.sessionCount,
    attemptsPerOrder: verdict.attemptsPerOrder,
  }));
}
