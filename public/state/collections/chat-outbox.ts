import type { ChatOutboxEntry } from '#shared/contracts/session.ts';
import { defineCollection } from '../define-collection.ts';
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

export function chatOutboxEntriesOf(sessionId: string): readonly ChatOutboxEntry[] {
  const entries = chatOutboxCollection.state.bySessionId[sessionId];
  if (!entries || entries.length === 0) return EMPTY_OUTBOX;
  return entries;
}

export default chatOutboxCollection;
