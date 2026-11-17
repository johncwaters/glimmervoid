import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { appendTraceRecords, chatToolOutcome, createTraceGrouping, nextTraceRequest, traceReplyOutcome, trimTraceGrouping } from '../trace-store-core.ts';
import type { ChatToolOutcome, TraceGrouping, TraceRequest } from '../trace-store-core.ts';
import type { ChatPart } from './chat-part.ts';
import { appendChatRecords, createChatPartsState, refreshRunningCalls, trimChatParts } from './chat-parts-core.ts';
import type { PathContext } from './tool-call-core.ts';

const UNREADABLE_TRACE_TEXT = 'The conversation could not be read.';
const NO_RESULT: ChatToolOutcome = { status: 'no-result' };

type FeedPhase = 'seeking' | 'following' | 'closed';

type TracePagePayload = { id: string; after: number } | { id: string; endingAt: number | 'tail' };

interface ChatFeedOptions {
  sessionId: string;
  pathContext: PathContext;
  requestPage: (payload: TracePagePayload) => Promise<ServerMessage>;
  isSessionWorking: () => boolean;
  onPartsChanged: (changedParts: readonly ChatPart[], droppedPartIds: readonly string[]) => void;
  onReset: () => void;
  onFailure: (failureText: string | null) => void;
}

export interface ChatFeed {
  refresh(): void;
  noteSessionWorkingChanged(): void;
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
  let grouping: TraceGrouping = createTraceGrouping();
  let partsState = createChatPartsState(options.pathContext);
  let phase: FeedPhase = 'seeking';
  let nextOffset = 0;
  let pendingRequest: TraceRequest | null = null;
  let isRefreshNeeded = false;

  const outcomeOf = (toolUseId: string): ChatToolOutcome | null => {
    const toolCall = grouping.toolCallByUseId.get(toolUseId);
    if (toolCall) return chatToolOutcome(grouping, toolCall, options.isSessionWorking());
    return options.isSessionWorking() ? null : NO_RESULT;
  };

  const restart = () => {
    grouping = createTraceGrouping();
    partsState = createChatPartsState(options.pathContext);
    phase = 'seeking';
    nextOffset = 0;
    options.onReset();
  };

  const showRecords = (reply: ServerMessage & { type: 'session-trace-response' }) => {
    nextOffset = reply.next;
    appendTraceRecords(grouping, reply.records);
    const changedParts = appendChatRecords(partsState, reply.records, outcomeOf);
    trimTraceGrouping(grouping);
    options.onPartsChanged(changedParts, trimChatParts(partsState));
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
    if (outcome === 'seed' || outcome === 'append') showRecords(reply);
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
    noteSessionWorkingChanged: () => {
      if (phase === 'closed') return;
      options.onPartsChanged(refreshRunningCalls(partsState, outcomeOf), []);
    },
    close: () => {
      phase = 'closed';
    },
  };
}
