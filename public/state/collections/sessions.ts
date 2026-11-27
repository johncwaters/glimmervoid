import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { defineCollection } from '../define-collection.ts';
import {
  INITIAL_SESSIONS_STATE,
  applySessionsServerMessage,
} from '../sessions-core.ts';
import type { SessionsCollectionState } from '../sessions-core.ts';

type SessionsServerMessageListener = (message: ServerMessage) => void;

const serverMessageListeners = new Set<SessionsServerMessageListener>();

function notifyServerMessageListeners(message: ServerMessage): void {
  for (const listener of [...serverMessageListeners]) {
    listener(message);
  }
}

const sessionsCollection = defineCollection<SessionsCollectionState>({
  name: 'sessions',
  key: 'id',
  initial: INITIAL_SESSIONS_STATE,
  apply: applySessionsServerMessage,
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

export default sessionsCollection;
