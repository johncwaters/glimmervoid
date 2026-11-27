import { createEffect, createRoot, flush, runWithOwner, untrack } from 'solid-js';
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
  let disposeWatcher = (): void => {};
  let hasRunInitial = false;
  runWithOwner(null, () => {
    createRoot((dispose) => {
      disposeWatcher = dispose;
      createEffect(
        () => snapshotEntriesOf(sessionId),
        (entries) => {
          if (!hasRunInitial) {
            hasRunInitial = true;
            return;
          }
          untrack(() => listener(entries));
        },
      );
    });
  });
  flush();
  return disposeWatcher;
}

export default chatOutboxCollection;
