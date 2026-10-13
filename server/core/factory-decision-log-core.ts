import { FACTORY_DECISION_OUTPUT_MAX_BYTES, FactoryDecisionLogLine } from '../../shared/contracts/factory-decision-log.ts';
import type { FactoryWorkerEvent, FactoryReviewVerdict } from '../../shared/contracts/factory.ts';
import { inheritedSecretValues } from './factory-core.ts';
import type { FactoryCheck, FactoryFence } from './factory-core.ts';

type WithoutTimestamp<Line> = Line extends { timestamp: string } ? Omit<Line, 'timestamp'> : never;
export type FactoryDecisionInput = WithoutTimestamp<FactoryDecisionLogLine>;
export type FactoryDecisionWorkerEvent = FactoryWorkerEvent & {
  intentId?: string;
  failureClass?: FactoryDecisionLogLine['failureClass'];
  attempt?: number;
  durationMs?: number;
};

export function factoryDecisionDayFileName(timestamp: string): string {
  return `${timestamp.slice(0, 10)}.jsonl`;
}

export function capFactoryDecisionOutput(output: string, maxBytes = FACTORY_DECISION_OUTPUT_MAX_BYTES): string {
  const outputBytes = Buffer.from(output, 'utf8');
  if (outputBytes.length <= maxBytes) return output;
  let tailStart = outputBytes.length - maxBytes;
  while (tailStart < outputBytes.length && (outputBytes[tailStart] & 0xc0) === 0x80) tailStart += 1;
  return outputBytes.subarray(tailStart).toString('utf8');
}

export function capFactoryDecisionChecks(checks: FactoryCheck[]): FactoryCheck[] {
  const mostRecentFirstIndexes = checks.map((_check, checkIndex) => checkIndex).toReversed();
  const budgetOrderIndexes = [...mostRecentFirstIndexes.filter((checkIndex) => !checks[checkIndex].pass), ...mostRecentFirstIndexes.filter((checkIndex) => checks[checkIndex].pass)];
  const cappedOutputByIndex = new Map<number, string>();
  let remainingBytes = FACTORY_DECISION_OUTPUT_MAX_BYTES;
  for (const checkIndex of budgetOrderIndexes) {
    const output = capFactoryDecisionOutput(checks[checkIndex].output, remainingBytes);
    remainingBytes -= Buffer.byteLength(output, 'utf8');
    cappedOutputByIndex.set(checkIndex, output);
  }
  return checks.map((check, checkIndex) => ({ ...check, output: cappedOutputByIndex.get(checkIndex) ?? '' }));
}

const ENV_FILE_QUOTED_VALUE = /^(["'`])((?:\\.|(?!\1).)*)\1/;
const ENV_FILE_TRAILING_COMMENT = /(?:^|\s+)#.*$/;

function envFileValueCandidates(writtenValue: string): string[] {
  const quotedValue = ENV_FILE_QUOTED_VALUE.exec(writtenValue);
  if (quotedValue) return [quotedValue[2]];
  const valueBeforeSpacedComment = writtenValue.replace(ENV_FILE_TRAILING_COMMENT, '').trim();
  const valueBeforeFirstHash = writtenValue.split('#', 1)[0].trim();
  return [...new Set([valueBeforeSpacedComment, valueBeforeFirstHash])];
}

export function envFileSecretValues(envFileText: string): string[] {
  return envFileText.split(/\r?\n/).flatMap((envFileLine) => {
    const assignment = envFileLine.trim().replace(/^export\s+/, '');
    const separatorIndex = assignment.indexOf('=');
    if (assignment.startsWith('#') || separatorIndex < 1) return [];
    const secretName = assignment.slice(0, separatorIndex).trim();
    return envFileValueCandidates(assignment.slice(separatorIndex + 1).trim()).flatMap((valueCandidate) => inheritedSecretValues({ [secretName]: valueCandidate }));
  });
}

function redactFence(fence: FactoryFence | null, redact: (text: string) => string): FactoryFence | null {
  if (!fence || fence.ok) return fence;
  return { ok: false, outside: fence.outside.map(redact), protected: fence.protected.map(redact), unsupportedProtectedPaths: fence.unsupportedProtectedPaths.map(redact) };
}

export function buildFactoryDecisionLine(decision: FactoryDecisionInput, timestamp: string, redact: (text: string) => string = (text) => text): FactoryDecisionLogLine {
  const reason = decision.reason === null ? null : redact(decision.reason).slice(0, 1000);
  if (decision.kind !== 'closeout') return FactoryDecisionLogLine.parse({ ...decision, timestamp, reason });
  return FactoryDecisionLogLine.parse({
    ...decision, timestamp, reason, fence: redactFence(decision.fence, redact),
    checks: decision.checks.map((check) => ({ ...check, command: redact(check.command), output: redact(check.output) })),
    review: decision.review && { ...decision.review, findings: decision.review.findings.map(redact) },
  });
}

export function factoryDecisionContext(projectId: string, fields: {
  workId?: string | null; intentId?: string | null; sessionId?: string | null; attempt?: number | null; durationMs?: number | null; reason?: string | null;
} = {}) {
  return { projectId, workId: fields.workId ?? null, intentId: fields.intentId ?? null, sessionId: fields.sessionId ?? null,
    attempt: fields.attempt ?? null, durationMs: fields.durationMs ?? null, reason: fields.reason ?? null };
}

export function factoryWorkerDecision(projectId: string, event: FactoryDecisionWorkerEvent): FactoryDecisionInput | null {
  const context = factoryDecisionContext(projectId, { ...event, reason: event.detail });
  switch (event.event) {
    case 'refused': return { ...context, kind: 'admission', outcome: 'refused', failureClass: 'admission' };
    case 'dispatch available': return { ...context, kind: 'admission', outcome: 'available', failureClass: null };
    case 'dispatched': return { ...context, kind: 'admission', outcome: 'dispatched', failureClass: null };
    case 'ended': return { ...context, kind: 'admission', outcome: 'ended', failureClass: event.failureClass ?? null };
    case 'blocked': return { ...context, kind: 'admission', outcome: 'block', failureClass: event.failureClass ?? 'closeout' };
    case 'merged': return null;
    case 'verification failed': return { ...context, intentId: event.workId, kind: 'verification', outcome: 'failed', failureClass: 'verification' };
    case 'verification stale': return { ...context, intentId: event.workId, kind: 'verification', outcome: 'stale', failureClass: 'stale' };
    case 'verification passed': return { ...context, intentId: event.workId, kind: 'verification', outcome: 'passed', failureClass: null };
    default: throw new Error(`Unknown factory decision event: ${event.event}`);
  }
}

export function isLogOnlyFactoryEvent(event: FactoryWorkerEvent): boolean {
  return event.event === 'verification passed';
}

export function factoryCloseOutFailureClass(fence: FactoryFence | null, checks: FactoryCheck[], review: FactoryReviewVerdict | null): FactoryDecisionLogLine['failureClass'] {
  if (fence && !fence.ok) return 'fence';
  if (checks.some((check) => !check.pass)) return 'check';
  if (review && !review.pass) return 'review';
  if (!review) return 'closeout';
  return null;
}
