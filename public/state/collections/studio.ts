import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { applyCollectionServerMessage, defineCollection } from '../define-collection.ts';
import {
  INITIAL_STUDIO_STATE,
  applyStudioServerMessage,
} from '../studio-core.ts';
import type { StudioApplyContext, StudioCollectionState } from '../studio-core.ts';
import sessionsCollection, { onSessionsServerMessage } from './sessions.ts';

type StudioServerMessageListener = (message: ServerMessage) => void;

const serverMessageListeners = new Set<StudioServerMessageListener>();
let activeApplyContext: StudioApplyContext = {};

function notifyServerMessageListeners(message: ServerMessage): void {
  for (const listener of [...serverMessageListeners]) {
    listener(message);
  }
}

const studioCollection = defineCollection<StudioCollectionState>({
  name: 'studio',
  key: null,
  initial: INITIAL_STUDIO_STATE,
  apply(draft, message) {
    applyStudioServerMessage(draft, message, activeApplyContext);
  },
  onApplied: notifyServerMessageListeners,
});

onSessionsServerMessage((message) => {
  if (
    message.type !== 'snapshot'
    && message.type !== 'session-added'
    && message.type !== 'session-modified'
    && message.type !== 'session-removed'
  ) {
    return;
  }
  applyCollectionServerMessage('studio', message);
});

export function onStudioServerMessage(listener: StudioServerMessageListener): () => void {
  serverMessageListeners.add(listener);
  return () => {
    serverMessageListeners.delete(listener);
  };
}

export function applyStudioReply(
  message: ServerMessage,
  context: Omit<StudioApplyContext, 'liveSessionIds'> = {},
): void {
  activeApplyContext = {
    ...context,
    liveSessionIds: new Set(sessionsCollection.state.order),
  };
  try {
    applyCollectionServerMessage('studio', message);
  } finally {
    activeApplyContext = {};
  }
}

export default studioCollection;
