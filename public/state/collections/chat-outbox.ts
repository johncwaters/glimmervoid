import type { ChatOutboxEntry } from '#shared/contracts/session.ts';
import { defineCollection, watchCollection } from '../define-collection.ts';
import {
  INITIAL_CHAT_OUTBOX_STATE,
  applyChatOutboxServerMessage,
} from '../chat-outbox-core.ts';
import type { ChatOutboxCollectionState } from '../chat-outbox-core.ts';

const EMPTY_OUTBOX: readonly ChatOutboxEntry[] = [];

const chatOutboxCollection = defineCollection<ChatOutboxCollectionState>({
  name: 'chat-outbox',
  key: 'entryId',
  initial: INITIAL_CHAT_OUTBOX_STATE,
  apply: applyChatOutboxServerMessage,
});

function snapshotEntriesOf(sessionId: string): ChatOutboxEntry[] {
  const entries = chatOutboxCollection.state.bySessionId[sessionId];
  if (!entries || entries.length === 0) return [];
  return entries.map((entry) => ({
    entryId: entry.entryId,
    text: entry.text,
    attachments: [...entry.attachments],
    state: entry.state,
    failure: entry.failure,
    shouldOpenTerminal: entry.shouldOpenTerminal,
    origin: entry.origin,
  }));
}

export function chatOutboxEntriesOf(sessionId: string): readonly ChatOutboxEntry[] {
  const entries = chatOutboxCollection.state.bySessionId[sessionId];
  if (!entries || entries.length === 0) return EMPTY_OUTBOX;
  return entries;
}

export function watchChatOutbox(
  sessionId: string,
  listener: (entries: readonly ChatOutboxEntry[]) => void,
): () => void {
  return watchCollection(
    chatOutboxCollection,
    () => JSON.stringify(snapshotEntriesOf(sessionId)),
    () => listener(snapshotEntriesOf(sessionId)),
  );
}

export default chatOutboxCollection;
