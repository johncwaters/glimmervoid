import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { sendControlRequest } from '../../control-ws.ts';
import { applyCollectionServerMessage, defineCollection, watchCollection } from '../define-collection.ts';
import {
  INITIAL_SESSIONS_STATE,
  applySessionsServerMessage,
} from '../sessions-core.ts';
import type { SessionsApplyContext, SessionsCollectionState } from '../sessions-core.ts';

type SessionsServerMessageListener = (message: ServerMessage) => void;

const serverMessageListeners = new Set<SessionsServerMessageListener>();
let activeApplyContext: SessionsApplyContext = {};

function notifyServerMessageListeners(message: ServerMessage): void {
  for (const listener of [...serverMessageListeners]) {
    listener(message);
  }
}

const sessionsCollection = defineCollection<SessionsCollectionState>({
  name: 'sessions',
  key: 'id',
  initial: INITIAL_SESSIONS_STATE,
  apply(draft, message, helpers) {
    applySessionsServerMessage(draft, message, helpers, activeApplyContext);
  },
  onApplied: notifyServerMessageListeners,
});

export function onSessionsServerMessage(listener: SessionsServerMessageListener): () => void {
  serverMessageListeners.add(listener);
  return () => {
    serverMessageListeners.delete(listener);
  };
}

export function hasSessionInCollection(sessionId: string): boolean {
  return Object.hasOwn(sessionsCollection.state.byId, sessionId);
}

export function hasPendingLaunch(): boolean {
  return sessionsCollection.state.pendingLaunches.length > 0;
}

export function watchPendingLaunches(listener: () => void): () => void {
  return watchCollection(
    sessionsCollection,
    (state) => state.pendingLaunches.join('\0'),
    () => listener(),
  );
}

export type TracePagePayload = { id: string; after: number } | { id: string; endingAt: number | 'tail' };

export function requestSessionTracePage(
  payload: TracePagePayload,
  timeoutMs: number,
): Promise<ServerMessage> {
  return sendControlRequest('session-trace', payload, { timeoutMs });
}

export function applyChatStopReply(reply: ServerMessage, sessionId: string): void {
  activeApplyContext = { confirmedChatStopSessionId: sessionId };
  try {
    applyCollectionServerMessage('sessions', reply);
  } finally {
    activeApplyContext = {};
  }
}

export function applyApprovalDecisionReply(reply: ServerMessage, sessionId: string): void {
  activeApplyContext = { confirmedApprovalSessionId: sessionId };
  try {
    applyCollectionServerMessage('sessions', reply);
  } finally {
    activeApplyContext = {};
  }
}

export default sessionsCollection;
