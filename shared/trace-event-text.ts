import type { TraceRecord } from './contracts/trace.ts';

type AgentErrorRecord = Extract<TraceRecord, { kind: 'agent-error' }>;

const TOKENS_PER_THOUSAND = 1000;
const MS_PER_SECOND = 1000;

function thousandsText(tokens: number): string {
  return tokens < TOKENS_PER_THOUSAND ? String(tokens) : `${Math.round(tokens / TOKENS_PER_THOUSAND)}k`;
}

export function compactionText(record: Extract<TraceRecord, { kind: 'compaction' }>): string {
  if (record.tokensBefore === null || record.tokensAfter === null) return 'Conversation compacted';
  return `Conversation compacted, ${thousandsText(record.tokensBefore)} to ${thousandsText(record.tokensAfter)} tokens`;
}

export function hookLabelOf(record: Extract<TraceRecord, { kind: 'hook-message' }>): string {
  return record.toolName === null ? `hook ${record.hookEvent}` : `hook ${record.hookEvent}:${record.toolName}`;
}

export function agentErrorReasonOf(record: AgentErrorRecord): string {
  return record.text.trim().replace(/\.+$/, '');
}

function retryText(record: AgentErrorRecord): string | null {
  if (record.retryInMs === null) return null;
  const seconds = Math.max(1, Math.round(record.retryInMs / MS_PER_SECOND));
  const attemptText = record.attempt === null ? '' : record.maxAttempts === null ? `, attempt ${record.attempt}` : `, attempt ${record.attempt} of ${record.maxAttempts}`;
  return `Retrying in ${seconds}s${attemptText}`;
}

export function agentErrorText(record: AgentErrorRecord): string {
  const retry = retryText(record);
  return retry === null ? record.text : `${agentErrorReasonOf(record)}. ${retry}`;
}

export function settledRetryText(reason: string, attempts: number, hasRecovered: boolean): string {
  if (hasRecovered) return `${reason}. Recovered after ${attempts === 1 ? '1 retry' : `${attempts} retries`}`;
  return `${reason}. Retried ${attempts === 1 ? 'once' : `${attempts} times`}`;
}
