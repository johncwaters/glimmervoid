import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { nextTraceRequest, traceReplyOutcome } from '../trace-store-core.ts';
import type { TraceRequest } from '../trace-store-core.ts';
import type { ActivityBeat } from './chat-activity-core.ts';
import type { ChatPart } from './chat-part.ts';
import { appendChatRecords, createChatPartsState, endChatTurn, trimChatParts } from './chat-parts-core.ts';
import type { RunningSubagent } from './status-rail-core.ts';

const UNREADABLE_TRACE_TEXT = 'The conversation could not be read.';

type FeedPhase = 'seeking' | 'following' | 'closed';

type TracePagePayload = { id: string; after: number } | { id: string; endingAt: number | 'tail' };

interface ChatFeedOptions {
  sessionId: string;
  workingDirectory: string | null;
  requestPage: (payload: TracePagePayload) => Promise<ServerMessage>;
  onPartsChanged: (changedParts: readonly ChatPart[], droppedPartIds: readonly string[], isLive: boolean) => void;
  onBeats: (beats: readonly ActivityBeat[]) => void;
  onSubagents: (runningSubagents: readonly RunningSubagent[]) => void;
  isTurnOver: () => boolean;
  onReset: () => void;
  onFailure: (failureText: string | null) => void;
}

export interface ChatFeed {
  refresh(): void;
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
  let pendingRequest: TraceRequest | null = null;
  let isRefreshNeeded = false;
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
    options.onReset();
  };

  const showRecords = (reply: ServerMessage & { type: 'session-trace-response' }, isLive: boolean) => {
    nextOffset = reply.next;
    const appended = appendChatRecords(partsState, reply.records);
    const endedTurnParts = options.isTurnOver() ? endChatTurn(partsState) : [];
    const changedParts = appended.parts.map((part) => endedTurnParts.find((ended) => ended.id === part.id) ?? part);
    const endedTurnPartsNotChanged = endedTurnParts.filter((ended) => !appended.parts.some((part) => part.id === ended.id));
    options.onPartsChanged([...changedParts, ...endedTurnPartsNotChanged], trimChatParts(partsState), isLive);
    options.onSubagents(appended.runningSubagents);
    if (isLive && appended.beats.length > 0) options.onBeats(appended.beats);
  };

  const applyReply = (request: TraceRequest, reply: ServerMessage) => {
    if (phase === 'closed') return;
    pendingRequest = null;
    if (reply.type !== 'session-trace-response') {
      options.onFailure(reply.type === 'error' ? reply.message : UNREADABLE_TRACE_TEXT);
      deferCallbacksOfPendingRequest();
      return;
    }
    options.onFailure(null);
    const outcome = traceReplyOutcome({
      pendingRequest: request,
      resident: { sessionId, firstOffset: 0, nextOffset, hasLoadedOnce: phase === 'following' },
      reply: { id: reply.id, start: reply.start, next: reply.next, reset: reply.reset },
    });
    if (outcome === 'reset') {
      deferCallbacksOfPendingRequest();
      restart();
      refresh();
      return;
    }
    if (outcome === 'seed') phase = 'following';
    if (outcome === 'seed' || outcome === 'append') showRecords(reply, outcome === 'append');
    runCallbacksOfPendingRequest();
    if (!isRefreshNeeded) return;
    isRefreshNeeded = false;
    refresh();
  };

  const applyFailure = (reason: unknown) => {
    if (phase === 'closed') return;
    pendingRequest = null;
    isRefreshNeeded = false;
    options.onFailure(failureTextOf(reason));
    deferCallbacksOfPendingRequest();
  };

  function refresh(): void {
    if (phase === 'closed') return;
    if (pendingRequest) {
      isRefreshNeeded = true;
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
    options.requestPage(payloadOf(request)).then((reply) => applyReply(request, reply), applyFailure);
  }

  return {
    refresh,
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
