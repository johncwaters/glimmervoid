import type { TraceRecord } from '#shared/contracts/trace.ts';
import { byteSizeText } from '#shared/display-text.ts';
import { formatClockOffset } from './radar/radar-core.ts';
import type { TraceSessionOption, TraceTurn } from './trace-store-core.ts';

export { hasEarlierTracePages } from './trace-store-core.ts';
export type { TracePrepend, TraceSessionOption, TraceTurn, TraceTurnAppend, TraceViewRow } from './trace-store-core.ts';

export function traceRecordBody(record: TraceRecord): string {
  if (record.kind === 'prompt' || record.kind === 'expansion' || record.kind === 'thinking' || record.kind === 'assistant' || record.kind === 'notice') return record.text;
  if (record.kind === 'tool_result') return record.content;
  if (record.kind === 'raw') return record.line;
  if (record.kind === 'tool_call') return JSON.stringify(record.input, null, 2) ?? String(record.input ?? '');
  return [
    `${record.vendor} ${record.vendorSessionId}`,
    record.transcriptPath,
    record.reason ?? '',
  ].filter(Boolean).join('\n');
}

export const TRACE_FILTERABLE_KINDS: readonly { kind: TraceRecord['kind']; label: string }[] = [
  { kind: 'thinking', label: 'Thinking' },
  { kind: 'tool_result', label: 'Tool result' },
  { kind: 'raw', label: 'Raw' },
];

function traceTurnDurationMs(turn: TraceTurn): number {
  if (turn.startedAt === null) return 0;
  let finishedAtMs = turn.head?.record.ts ?? turn.startedAt;
  for (const row of turn.rows) finishedAtMs = Math.max(finishedAtMs, row.record.ts);
  return Math.max(0, finishedAtMs - turn.startedAt);
}

export function formatTurnMetrics(turn: TraceTurn): string {
  const { rowCount, toolCallCount, errorCount, resultBytes } = turn.metrics;
  const rows = `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`;
  const tools = `${toolCallCount} ${toolCallCount === 1 ? 'tool' : 'tools'}`;
  const errors = `${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`;
  const bytes = byteSizeText(resultBytes, 'KB');
  const durationText = formatClockOffset(traceTurnDurationMs(turn));
  return `${rows}, ${tools}, ${errors}, ${bytes}, ${durationText}`;
}

interface TraceRebuildInputs {
  hasSelectionChanged: boolean;
  isRenderedTraceStale: boolean;
  hasRenderedOnce: boolean;
}

export function shouldRebuildTraceView(inputs: TraceRebuildInputs): boolean {
  return inputs.hasSelectionChanged || inputs.isRenderedTraceStale || !inputs.hasRenderedOnce;
}

export function traceSessionStartedAtMs(
  firstOffset: number,
  hasDroppedEarliestRows: boolean,
  firstTurn: TraceTurn | null | undefined,
): number | null {
  if (firstOffset !== 0 || hasDroppedEarliestRows) return null;
  return firstTurn?.startedAt ?? null;
}

export function toggleHiddenKind(hidden: readonly string[], kind: string): string[] {
  if (isKindHidden(hidden, kind)) return hidden.filter((hiddenKind) => hiddenKind !== kind);
  return [...hidden, kind];
}

export function isKindHidden(hidden: readonly string[], kind: string): boolean {
  return hidden.includes(kind);
}

export function traceEmptyState(session: TraceSessionOption | null): string {
  if (!session) return 'No sessions are available.';
  return `No trace has been recorded for ${session.label}.`;
}
