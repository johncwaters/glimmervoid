import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { TraceRecord } from '#shared/contracts/trace.ts';
import { NOT_CONNECTED_TEXT } from './updates-view-core.ts';
import {
  appendTraceRecords,
  createTraceGrouping,
  earlierTraceRequest,
  nextTraceRequest,
  prependTraceRecords,
  resolveTraceSessionId,
  traceReplyOutcome,
  traceResidentRowCount,
  traceSessionOptions,
  trimTraceGrouping,
} from './trace-view-core.ts';
import type { TraceGrouping, TracePrepend, TraceRequest, TraceSessionOption, TraceSessionSummary, TraceTurnAppend } from './trace-view-core.ts';

const TRACE_REQUEST_TIMEOUT_MS = 10000;

interface SelectedTrace {
  sessionId: string;
  grouping: TraceGrouping;
  firstOffset: number;
  nextOffset: number;
  hasDroppedEarliestRows: boolean;
  filePath: string;
  hasLoadedOnce: boolean;
}

interface PendingTraceRequest {
  request: TraceRequest;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

type TraceReply = Pick<ServerMessageOf<'session-trace-response'>, 'id' | 'records' | 'start' | 'next' | 'reset' | 'path'>;

export interface TraceTrim {
  droppedTurnCount: number;
  droppedRowCount: number;
  hasJustDroppedEarliestRows: boolean;
}

export type TraceChange =
  | { kind: 'selection-reset' }
  | { kind: 'rebuild' }
  | { kind: 'header' }
  | { kind: 'sessions'; hasSelectionChanged: boolean }
  | { kind: 'records-appended'; appends: TraceTurnAppend[] }
  | { kind: 'records-prepended'; prepend: TracePrepend }
  | { kind: 'trimmed'; trim: TraceTrim };

let sendRequest: ((message: Record<string, unknown>) => boolean) | null = null;
let navigateToTrace: (() => void) | null = null;
let sessionOptions: TraceSessionOption[] = [];
let selectedSessionId: string | null = null;
let preselectedSessionId: string | null = null;
let selectedTrace: SelectedTrace | null = null;
let pendingRequest: PendingTraceRequest | null = null;
let isRefreshNeeded = false;
let traceFailureText: string | null = null;
let isViewLooking: () => boolean = () => false;
const subscribers = new Set<(change: TraceChange) => void>();

function notifySubscribers(change: TraceChange): void {
  for (const subscriber of subscribers) subscriber(change);
}

function clearPendingRequest(): void {
  if (!pendingRequest) return;
  clearTimeout(pendingRequest.timeoutHandle);
  pendingRequest = null;
}

function abandonPendingRequest(): void {
  pendingRequest = null;
  traceFailureText = `The trace did not load within ${Math.round(TRACE_REQUEST_TIMEOUT_MS / 1000)} s.`;
  notifySubscribers({ kind: 'rebuild' });
}

function startSelectedTrace(sessionId: string | null): void {
  clearPendingRequest();
  isRefreshNeeded = false;
  traceFailureText = null;
  selectedSessionId = sessionId;
  selectedTrace = sessionId
    ? {
      sessionId,
      grouping: createTraceGrouping(),
      firstOffset: 0,
      nextOffset: 0,
      hasDroppedEarliestRows: false,
      filePath: '',
      hasLoadedOnce: false,
    }
    : null;
  notifySubscribers({ kind: 'selection-reset' });
}

function applySelection(canFallBackToFirst: boolean): boolean {
  const nextSelectedId = resolveTraceSessionId(sessionOptions, preselectedSessionId, selectedSessionId, canFallBackToFirst);
  if (preselectedSessionId && nextSelectedId === preselectedSessionId) preselectedSessionId = null;
  if (nextSelectedId === selectedSessionId) return false;
  startSelectedTrace(nextSelectedId);
  return true;
}

function sendTraceRequest(request: TraceRequest): void {
  if (!sendRequest) return;
  const wireMessage = request.endingAt === undefined
    ? { type: 'session-trace', id: request.id, after: request.after }
    : { type: 'session-trace', id: request.id, endingAt: request.endingAt };
  if (!sendRequest(wireMessage)) {
    traceFailureText = NOT_CONNECTED_TEXT;
    notifySubscribers({ kind: 'header' });
    return;
  }
  pendingRequest = { request, timeoutHandle: setTimeout(abandonPendingRequest, TRACE_REQUEST_TIMEOUT_MS) };
}

function requestSelectedTrace(isSurfaceShown = false): void {
  if (!sendRequest) return;
  const request = nextTraceRequest({
    selectedSessionId,
    isPanelVisible: isSurfaceShown || isViewLooking(),
    hasPendingRequest: !!pendingRequest,
    hasLoadedOnce: selectedTrace?.hasLoadedOnce ?? false,
    nextOffset: selectedTrace?.nextOffset ?? 0,
  });
  if (!request) return;
  sendTraceRequest(request);
}

function requestQueuedRefresh(): void {
  if (!isRefreshNeeded || pendingRequest) return;
  isRefreshNeeded = false;
  requestSelectedTrace();
}

function trimOldestRows(): void {
  if (!selectedTrace) return;
  const trim = trimTraceGrouping(selectedTrace.grouping);
  const hasDroppedRows = trim.droppedTurnCount > 0 || trim.droppedRowCount > 0;
  const hasJustDroppedEarliestRows = hasDroppedRows && !selectedTrace.hasDroppedEarliestRows;
  if (hasDroppedRows) selectedTrace.hasDroppedEarliestRows = true;
  notifySubscribers({ kind: 'trimmed', trim: { droppedTurnCount: trim.droppedTurnCount, droppedRowCount: trim.droppedRowCount, hasJustDroppedEarliestRows } });
}

function showAppendedRecords(records: readonly TraceRecord[]): void {
  if (!selectedTrace) return;
  notifySubscribers({ kind: 'records-appended', appends: appendTraceRecords(selectedTrace.grouping, records) });
  trimOldestRows();
}

function showPrependedRecords(records: readonly TraceRecord[]): void {
  if (!selectedTrace) return;
  notifySubscribers({ kind: 'records-prepended', prepend: prependTraceRecords(selectedTrace.grouping, records) });
  trimOldestRows();
}

function traceReplyFrom(message: unknown): TraceReply | null {
  if (!message || typeof message !== 'object') return null;
  const reply = message as { id?: unknown; records?: unknown; start?: unknown; next?: unknown; reset?: unknown; path?: unknown };
  if (typeof reply.id !== 'string' || !Array.isArray(reply.records)) return null;
  if (typeof reply.next !== 'number' || typeof reply.start !== 'number') return null;
  return {
    id: reply.id,
    records: reply.records as TraceRecord[],
    start: reply.start,
    next: reply.next,
    reset: reply.reset === true,
    path: typeof reply.path === 'string' ? reply.path : '',
  };
}

export function traceEarlierPageInputs() {
  return {
    selectedSessionId,
    hasPendingRequest: !!pendingRequest,
    hasLoadedOnce: selectedTrace?.hasLoadedOnce ?? false,
    hasDroppedEarliestRows: selectedTrace?.hasDroppedEarliestRows ?? false,
    firstOffset: selectedTrace?.firstOffset ?? 0,
    residentRowCount: selectedTrace ? traceResidentRowCount(selectedTrace.grouping) : 0,
  };
}

export function traceSnapshot(): {
  sessionOptions: readonly TraceSessionOption[];
  selectedSessionId: string | null;
  selectedTrace: SelectedTrace | null;
  pendingSessionId: string | null;
  traceFailureText: string | null;
} {
  return { sessionOptions, selectedSessionId, selectedTrace, pendingSessionId: pendingRequest?.request.id ?? null, traceFailureText };
}

export function subscribeTrace(subscriber: (change: TraceChange) => void): void {
  subscribers.add(subscriber);
}

export function setTraceLookingProbe(probe: () => boolean): void {
  isViewLooking = probe;
}

export function requestEarlierTrace(): void {
  if (!sendRequest) return;
  const request = earlierTraceRequest(traceEarlierPageInputs());
  if (!request) return;
  sendTraceRequest(request);
}

export function selectTraceSession(sessionId: string): void {
  if (!sessionOptions.some((option) => option.id === sessionId)) return;
  if (sessionId === selectedSessionId) return;
  preselectedSessionId = null;
  startSelectedTrace(sessionId);
  requestSelectedTrace();
  notifySubscribers({ kind: 'rebuild' });
}

export function refreshTraceSelectionOnShow(): boolean {
  const hasSelectionChanged = applySelection(true);
  requestSelectedTrace(true);
  return hasSelectionChanged;
}

export function setTraceRequestSender(sender: (message: Record<string, unknown>) => boolean): void {
  sendRequest = sender;
}

export function setTraceNavigate(callback: () => void): void {
  navigateToTrace = callback;
}

export function openTraceForSession(sessionId: string): void {
  preselectedSessionId = sessionId;
  navigateToTrace?.();
}

export function setTraceSessions(sessions: readonly TraceSessionSummary[]): void {
  sessionOptions = traceSessionOptions(sessions);
  const hasSelectionChanged = applySelection(isViewLooking());
  if (hasSelectionChanged) requestSelectedTrace();
  notifySubscribers({ kind: 'sessions', hasSelectionChanged });
}

export function applyTraceResponse(message: unknown): void {
  const reply = traceReplyFrom(message);
  if (!reply) return;
  const outcome = traceReplyOutcome({
    pendingRequest: pendingRequest?.request ?? null,
    resident: selectedTrace
      ? {
        sessionId: selectedTrace.sessionId,
        firstOffset: selectedTrace.firstOffset,
        nextOffset: selectedTrace.nextOffset,
        hasLoadedOnce: selectedTrace.hasLoadedOnce,
      }
      : null,
    reply: { id: reply.id, start: reply.start, next: reply.next, reset: reply.reset },
  });
  if (outcome === 'ignore') {
    requestQueuedRefresh();
    return;
  }
  clearPendingRequest();
  if (traceFailureText) {
    traceFailureText = null;
    notifySubscribers({ kind: 'header' });
  }
  if (outcome === 'stale') {
    requestQueuedRefresh();
    return;
  }
  if (outcome === 'reset') {
    startSelectedTrace(reply.id);
    if (selectedTrace) selectedTrace.filePath = reply.path;
    requestSelectedTrace();
    notifySubscribers({ kind: 'rebuild' });
    requestQueuedRefresh();
    return;
  }
  if (!selectedTrace) return;
  selectedTrace.filePath = reply.path;
  if (outcome === 'prepend') {
    selectedTrace.firstOffset = reply.start;
    showPrependedRecords(reply.records);
    requestQueuedRefresh();
    return;
  }
  if (outcome === 'seed') {
    selectedTrace.hasLoadedOnce = true;
    selectedTrace.firstOffset = reply.start;
  }
  selectedTrace.nextOffset = reply.next;
  showAppendedRecords(reply.records);
  requestQueuedRefresh();
}

export function applyTraceChanged(message: unknown): void {
  const sessionId = (message as { id?: unknown } | null)?.id;
  if (typeof sessionId !== 'string' || sessionId !== selectedSessionId) return;
  if (!isViewLooking()) return;
  if (pendingRequest) {
    isRefreshNeeded = true;
    return;
  }
  requestSelectedTrace();
}

export function applyTraceError(message: unknown): boolean {
  const sessionId = (message as { id?: unknown } | null)?.id;
  if (typeof sessionId !== 'string' || pendingRequest?.request.id !== sessionId) return false;
  clearPendingRequest();
  isRefreshNeeded = false;
  const errorText = (message as { message?: unknown } | null)?.message;
  traceFailureText = typeof errorText === 'string' && errorText ? errorText : 'The trace could not be read.';
  notifySubscribers({ kind: 'rebuild' });
  return true;
}

export function applyTraceConnectionState(isConnected: boolean): void {
  clearPendingRequest();
  isRefreshNeeded = false;
  traceFailureText = isConnected ? null : NOT_CONNECTED_TEXT;
  if (!isConnected) {
    notifySubscribers({ kind: 'rebuild' });
    return;
  }
  notifySubscribers({ kind: 'header' });
  requestSelectedTrace();
}
