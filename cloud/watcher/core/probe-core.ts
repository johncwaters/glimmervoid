import type { Nudge, Probe, ProbeFailure, ProbeStatus } from '../../../shared/contracts/watcher-link.ts';

interface ProbeMemory {
  requestFingerprint: string;
  etag: string | null;
  bodySha256: string | null;
  status: ProbeStatus;
  failure: ProbeFailure | null;
  lastRunAtMs: number | null;
  retryAfterMs: number | null;
}

type ProbeResponse =
  | { kind: 'answered'; status: number; etag: string | null; bodySha256: string; errorInAnswer: string | null; retryAfterMs: number | null }
  | { kind: 'unreachable'; error: string };

type NudgeKind = Nudge['kind'];

const NOT_MODIFIED = 304;
const STATUS_AFTER_RESPONSE: Record<ProbeStatus, Record<'responded ok' | 'responded failing', ProbeStatus>> = {
  unknown: { 'responded ok': 'ok', 'responded failing': 'failing' },
  ok: { 'responded ok': 'ok', 'responded failing': 'failing' },
  failing: { 'responded ok': 'ok', 'responded failing': 'failing' },
};
const MAX_FAILURE_REASON_LENGTH = 500;

function freshProbeMemory(requestFingerprint: string): ProbeMemory {
  return { requestFingerprint, etag: null, bodySha256: null, status: 'unknown', failure: null, lastRunAtMs: null, retryAfterMs: null };
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function failureOf(response: ProbeResponse): ProbeFailure {
  if (response.kind === 'unreachable') return { status: null, reason: response.error.slice(0, MAX_FAILURE_REASON_LENGTH) };
  if (response.errorInAnswer !== null) return { status: null, reason: response.errorInAnswer.slice(0, MAX_FAILURE_REASON_LENGTH) };
  return { status: response.status, reason: `answered ${response.status}` };
}

function probeOutcome(memory: ProbeMemory, response: ProbeResponse, nowMs: number): { memory: ProbeMemory; nudge: NudgeKind | null } {
  const isOk = response.kind === 'answered' && response.errorInAnswer === null && (response.status === NOT_MODIFIED || isSuccessStatus(response.status));
  const status = STATUS_AFTER_RESPONSE[memory.status][isOk ? 'responded ok' : 'responded failing'];
  const retryAfterMs = response.kind === 'answered' ? response.retryAfterMs : null;
  if (!isOk) {
    const failure = failureOf(response);
    return { memory: { ...memory, status, failure, lastRunAtMs: nowMs, retryAfterMs }, nudge: memory.status === 'failing' ? null : 'failing' };
  }
  const recoveredNudge: NudgeKind | null = memory.status === 'failing' ? 'recovered' : null;
  if (response.kind !== 'answered' || response.status === NOT_MODIFIED) {
    return { memory: { ...memory, status, failure: null, lastRunAtMs: nowMs, retryAfterMs }, nudge: recoveredNudge };
  }
  const hasBodyChanged = memory.bodySha256 !== null && memory.bodySha256 !== response.bodySha256;
  const nextMemory = { ...memory, status, failure: null, etag: response.etag, bodySha256: response.bodySha256, lastRunAtMs: nowMs, retryAfterMs };
  return { memory: nextMemory, nudge: recoveredNudge ?? (hasBodyChanged ? 'changed' : null) };
}

function memoryAfterCredentialChange(memory: ProbeMemory, hasCredentialChanged: boolean): ProbeMemory {
  if (!hasCredentialChanged) return memory;
  const isRefusedWithoutRateLimit = memory.status === 'failing' && memory.retryAfterMs === null;
  return isRefusedWithoutRateLimit ? { ...memory, lastRunAtMs: null } : { ...memory };
}

function nextRunAtMs(probe: Pick<Probe, 'everyMs'>, memory: ProbeMemory, nowMs: number): number {
  if (memory.lastRunAtMs === null) return nowMs;
  const scheduledAtMs = memory.lastRunAtMs + probe.everyMs;
  if (memory.retryAfterMs === null) return scheduledAtMs;
  return Math.max(scheduledAtMs, memory.lastRunAtMs + memory.retryAfterMs);
}

function retryAfterMsFromHeaders({ status, hasErrorInAnswer }: { status: number; hasErrorInAnswer: boolean }, headers: { retryAfter: string | null; rateLimitRemaining: string | null; rateLimitReset: string | null }, nowMs: number): number | null {
  if (status !== 403 && status !== 429 && !hasErrorInAnswer) return null;
  const retryAfterSeconds = Number(headers.retryAfter);
  if (headers.retryAfter !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) return retryAfterSeconds * 1000;
  const resetEpochSeconds = Number(headers.rateLimitReset);
  if (headers.rateLimitRemaining !== '0' || !Number.isFinite(resetEpochSeconds)) return null;
  return Math.max(0, resetEpochSeconds * 1000 - nowMs);
}

function isCleanAnswer(response: ProbeResponse): boolean {
  return response.kind === 'answered' && response.status >= 200 && response.status < 300 && response.errorInAnswer === null;
}

function fannedOutProbeResponse(responses: readonly ProbeResponse[], digestOf: (text: string) => string): ProbeResponse {
  const firstUnclean = responses.find((response) => !isCleanAnswer(response));
  if (firstUnclean !== undefined || responses.length === 1) return firstUnclean ?? responses[0];
  const answers = responses.flatMap((response) => response.kind === 'answered' ? [response] : []);
  const retryAfterTimes = answers.flatMap((answer) => answer.retryAfterMs === null ? [] : [answer.retryAfterMs]);
  return {
    kind: 'answered',
    status: answers[0].status,
    etag: null,
    bodySha256: digestOf(answers.map((answer) => answer.bodySha256).sort().join(',')),
    errorInAnswer: null,
    retryAfterMs: retryAfterTimes.length === 0 ? null : Math.max(...retryAfterTimes),
  };
}

export { fannedOutProbeResponse, freshProbeMemory, memoryAfterCredentialChange, nextRunAtMs, probeOutcome, retryAfterMsFromHeaders };
export type { ProbeMemory, ProbeResponse };
