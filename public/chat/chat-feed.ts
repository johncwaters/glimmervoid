import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { nextTraceRequest, traceReplyOutcome } from '../trace-store-core.ts';
import type { TraceRequest } from '../trace-store-core.ts';
import type { ActivityBeat } from './chat-activity-core.ts';
import type { ChatPart } from './chat-part.ts';
import { appendChatRecords, createChatPartsState, trimChatParts } from './chat-parts-core.ts';

const UNREADABLE_TRACE_TEXT = 'The conversation could not be read.';

type FeedPhase = 'seeking' | 'following' | 'closed';

type TracePagePayload = { id: string; after: number } | { id: string; endingAt: number | 'tail' };

interface ChatFeedOptions {
  sessionId: string;
  requestPage: (payload: TracePagePayload) => Promise<ServerMessage>;
  onPartsChanged: (changedParts: readonly ChatPart[], droppedPartIds: readonly string[]) => void;
  onBeats: (beats: readonly ActivityBeat[]) => void;
  onReset: () => void;
  onFailure: (failureText: string | null) => void;
}

export interface ChatFeed {
  refresh(): void;
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
  let partsState = createChatPartsState();
  let phase: FeedPhase = 'seeking';
  let nextOffset = 0;
  let pendingRequest: TraceRequest | null = null;
  let isRefreshNeeded = false;

  const restart = () => {
    partsState = createChatPartsState();
    phase = 'seeking';
    nextOffset = 0;
    options.onReset();
  };

  const showRecords = (reply: ServerMessage & { type: 'session-trace-response' }, isLive: boolean) => {
    nextOffset = reply.next;
    const appended = appendChatRecords(partsState, reply.records);
    options.onPartsChanged(appended.parts, trimChatParts(partsState));
    if (isLive && appended.beats.length > 0) options.onBeats(appended.beats);
  };

  const applyReply = (request: TraceRequest, reply: ServerMessage) => {
    if (phase === 'closed') return;
    pendingRequest = null;
    if (reply.type !== 'session-trace-response') {
      options.onFailure(reply.type === 'error' ? reply.message : UNREADABLE_TRACE_TEXT);
      return;
    }
    options.onFailure(null);
    const outcome = traceReplyOutcome({
      pendingRequest: request,
      resident: { sessionId, firstOffset: 0, nextOffset, hasLoadedOnce: phase === 'following' },
      reply: { id: reply.id, start: reply.start, next: reply.next, reset: reply.reset },
    });
    if (outcome === 'reset') {
      restart();
      refresh();
      return;
    }
    if (outcome === 'seed') phase = 'following';
    if (outcome === 'seed' || outcome === 'append') showRecords(reply, outcome === 'append');
    if (!isRefreshNeeded) return;
    isRefreshNeeded = false;
    refresh();
  };

  const applyFailure = (reason: unknown) => {
    if (phase === 'closed') return;
    pendingRequest = null;
    isRefreshNeeded = false;
    options.onFailure(failureTextOf(reason));
  };

  function refresh(): void {
    if (phase === 'closed') return;
    if (pendingRequest) {
      isRefreshNeeded = true;
      return;
    }
    const request = nextTraceRequest({ selectedSessionId: sessionId, isPanelVisible: true, hasPendingRequest: false, hasLoadedOnce: phase === 'following', nextOffset });
    if (!request) return;
    pendingRequest = request;
    options.requestPage(payloadOf(request)).then((reply) => applyReply(request, reply), applyFailure);
  }

  return {
    refresh,
    close: () => {
      phase = 'closed';
    },
  };
}
