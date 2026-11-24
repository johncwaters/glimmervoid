import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import type { TraceRecord } from '#shared/contracts/trace.ts';
import { earlierTraceRequest, nextTraceRequest, TRACE_MAX_RESIDENT_ROWS, traceReplyOutcome } from '../trace-store-core.ts';
import type { TraceRequest } from '../trace-store-core.ts';
import type { ActivityBeat } from './chat-activity-core.ts';
import type { ChatPart } from './chat-part.ts';
import { appendChatRecords, createChatPartsState, endChatTurn, trimChatParts } from './chat-parts-core.ts';

const UNREADABLE_TRACE_TEXT = 'The conversation could not be read.';

type FeedPhase = 'seeking' | 'following' | 'closed';

type TracePagePayload = { id: string; after: number } | { id: string; endingAt: number | 'tail' };

interface ChatFeedOptions {
  sessionId: string;
  workingDirectory: string | null;
  requestPage: (payload: TracePagePayload) => Promise<ServerMessage>;
  onPartsChanged: (changedParts: readonly ChatPart[], droppedPartIds: readonly string[], isLive: boolean) => void;
  onBeats: (beats: readonly ActivityBeat[]) => void;
  isTurnOver: () => boolean;
  onReset: () => void;
  onRebuilt: (rebuiltParts: readonly ChatPart[], replacedPartIds: readonly string[]) => void;
  onFailure: (failureText: string | null) => void;
  onRecords?: (appendedRecords: readonly TraceRecord[]) => void;
}

export interface ChatFeed {
  refresh(): void;
  loadEarlier(): void;
  whenCaughtUp(callback: () => void): void;
  endTurn(): void;
  close(): void;
}

function payloadOf(request: TraceRequest): TracePagePayload {
  if (request.endingAt === undefined) return { id: request.id, after: request.after };
  return { id: request.id, endingAt: request.endingAt };
}

function failureTextOf(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  return UNREADABLE_TRACE_TEXT;
}

export function createChatFeed(options: ChatFeedOptions): ChatFeed {
  const { sessionId } = options;
  let partsState = createChatPartsState(options.workingDirectory);
  let phase: FeedPhase = 'seeking';
  let nextOffset = 0;
  let firstOffset = 0;
  let residentRecords: TraceRecord[] = [];
  let hasDroppedEarliestRecords = false;
  let pendingRequest: TraceRequest | null = null;
  const queuedDirections = new Set<TraceRequest['direction']>();
  let callbacksAwaitingRequest: (() => void)[] = [];
  let callbacksOfPendingRequest: (() => void)[] = [];

  const deferCallbacksOfPendingRequest = () => {
    callbacksAwaitingRequest = [...callbacksOfPendingRequest, ...callbacksAwaitingRequest];
    callbacksOfPendingRequest = [];
  };

  const runCallbacksOfPendingRequest = () => {
    const callbacks = callbacksOfPendingRequest;
    callbacksOfPendingRequest = [];
    for (const callback of callbacks) callback();
  };

  const restart = () => {
    partsState = createChatPartsState(options.workingDirectory);
    phase = 'seeking';
    nextOffset = 0;
    firstOffset = 0;
    residentRecords = [];
    hasDroppedEarliestRecords = false;
    queuedDirections.clear();
    options.onReset();
  };

  const showRecords = (reply: ServerMessage & { type: 'session-trace-response' }, isLive: boolean) => {
    nextOffset = reply.next;
    residentRecords.push(...reply.records);
    const overflowingRecordCount = residentRecords.length - TRACE_MAX_RESIDENT_ROWS;
    if (overflowingRecordCount > 0) {
      residentRecords.splice(0, overflowingRecordCount);
      hasDroppedEarliestRecords = true;
    }
    const appended = appendChatRecords(partsState, reply.records);
    options.onRecords?.(reply.records);
    const endedTurnParts = options.isTurnOver() ? endChatTurn(partsState) : [];
    const changedParts = appended.parts.map((part) => endedTurnParts.find((ended) => ended.id === part.id) ?? part);
    const endedTurnPartsNotChanged = endedTurnParts.filter((ended) => !appended.parts.some((part) => part.id === ended.id));
    const droppedPartIds = trimChatParts(partsState);
    if (droppedPartIds.length > 0) hasDroppedEarliestRecords = true;
    options.onPartsChanged([...changedParts, ...endedTurnPartsNotChanged], droppedPartIds, isLive);
    if (isLive && appended.beats.length > 0) options.onBeats(appended.beats);
  };

  const showEarlierRecords = (reply: ServerMessage & { type: 'session-trace-response' }) => {
    firstOffset = reply.start;
    residentRecords = [...reply.records, ...residentRecords];
    const replacedPartIds = partsState.residentPartIds;
    partsState = createChatPartsState(options.workingDirectory);
    const rebuilt = appendChatRecords(partsState, residentRecords);
    const rebuiltPartById = new Map(rebuilt.parts.map((part) => [part.id, part]));
    const endedTurnParts = options.isTurnOver() ? endChatTurn(partsState) : [];
    for (const endedPart of endedTurnParts) rebuiltPartById.set(endedPart.id, endedPart);
    if (trimChatParts(partsState).length > 0) hasDroppedEarliestRecords = true;
    const residentPartIds = new Set(partsState.residentPartIds);
    options.onRebuilt([...rebuiltPartById.values()].filter((part) => residentPartIds.has(part.id)), replacedPartIds);
  };

  const applyReply = (request: TraceRequest, reply: ServerMessage) => {
    if (phase === 'closed') return;
    pendingRequest = null;
    if (reply.type !== 'session-trace-response') {
      options.onFailure(reply.type === 'error' ? reply.message : UNREADABLE_TRACE_TEXT);
      deferCallbacksOfPendingRequest();
      refreshAfterFailedEarlierRead(request);
      return;
    }
    options.onFailure(null);
    const outcome = traceReplyOutcome({
      pendingRequest: request,
      resident: { sessionId, firstOffset, nextOffset, hasLoadedOnce: phase === 'following' },
      reply: { id: reply.id, start: reply.start, next: reply.next, reset: reply.reset },
    });
    if (outcome === 'reset') {
      deferCallbacksOfPendingRequest();
      restart();
      refresh();
      return;
    }
    if (outcome === 'seed') {
      phase = 'following';
      firstOffset = reply.start;
    }
    if (outcome === 'prepend') showEarlierRecords(reply);
    if (outcome === 'seed' || outcome === 'append') showRecords(reply, outcome === 'append');
    const hasMoreToRead = outcome === 'append' && reply.next > reply.start;
    if (hasMoreToRead && callbacksOfPendingRequest.length > 0) {
      deferCallbacksOfPendingRequest();
      queuedDirections.add('forward');
    }
    runCallbacksOfPendingRequest();
    startQueuedRequest();
  };

  const startQueuedRequest = () => {
    if (queuedDirections.delete('forward')) refresh();
    if (pendingRequest || !queuedDirections.delete('earlier')) return;
    loadEarlier();
  };

  const refreshAfterFailedEarlierRead = (request: TraceRequest) => {
    if (request.direction !== 'earlier' || !queuedDirections.delete('forward')) return;
    refresh();
  };

  const applyFailure = (request: TraceRequest, reason: unknown) => {
    if (phase === 'closed') return;
    pendingRequest = null;
    options.onFailure(failureTextOf(reason));
    deferCallbacksOfPendingRequest();
    if (request.direction === 'earlier') {
      refreshAfterFailedEarlierRead(request);
      return;
    }
    queuedDirections.delete('forward');
  };

  function refresh(): void {
    if (phase === 'closed') return;
    if (pendingRequest) {
      queuedDirections.add('forward');
      return;
    }
    const request = nextTraceRequest({ selectedSessionId: sessionId, isPanelVisible: true, hasPendingRequest: false, hasLoadedOnce: phase === 'following', nextOffset });
    callbacksOfPendingRequest = callbacksAwaitingRequest;
    callbacksAwaitingRequest = [];
    if (!request) {
      runCallbacksOfPendingRequest();
      return;
    }
    pendingRequest = request;
    options.requestPage(payloadOf(request)).then((reply) => applyReply(request, reply), (reason) => applyFailure(request, reason));
  }

  function loadEarlier(): void {
    if (phase !== 'following') return;
    if (pendingRequest) {
      queuedDirections.add('earlier');
      return;
    }
    const request = earlierTraceRequest({ selectedSessionId: sessionId, hasPendingRequest: false, hasLoadedOnce: true, hasDroppedEarliestRows: hasDroppedEarliestRecords, firstOffset, residentRowCount: residentRecords.length });
    if (!request) return;
    pendingRequest = request;
    options.requestPage(payloadOf(request)).then((reply) => applyReply(request, reply), (reason) => applyFailure(request, reason));
  }

  return {
    refresh,
    loadEarlier,
    whenCaughtUp: (callback) => {
      if (phase === 'closed') return;
      callbacksAwaitingRequest.push(callback);
    },
    endTurn: () => {
      if (phase === 'closed') return;
      options.onPartsChanged(endChatTurn(partsState), [], true);
    },
    close: () => {
      phase = 'closed';
    },
  };
}
