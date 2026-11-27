import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { COLLECTION_OF, SERVER_MESSAGE_CLASS } from '#shared/contracts/control/message-classes.ts';
import { onControlMessage } from '../control-ws.ts';
import { applyCollectionServerMessage } from './define-collection.ts';
import { advanceSeq, resetSeq } from './seq.ts';

type LegacyControlMessageHandler = (message: ServerMessage) => void;

let legacyHandler: LegacyControlMessageHandler | null = null;

function syncSeqFromMessage(message: ServerMessage): void {
  if (message.type === 'snapshot') {
    resetSeq(typeof message.seq === 'number' ? message.seq : 0);
    return;
  }
  if (typeof message.seq === 'number') {
    advanceSeq(message.seq);
  }
}

export function ingestControlMessage(message: ServerMessage): 'collection' | 'legacy' {
  const messageClass = SERVER_MESSAGE_CLASS[message.type];
  if (messageClass === 'collection') {
    const collectionName = COLLECTION_OF[message.type as keyof typeof COLLECTION_OF];
    const handledByCollection = applyCollectionServerMessage(collectionName, message);
    syncSeqFromMessage(message);
    if (handledByCollection) return 'collection';
    legacyHandler?.(message);
    return 'legacy';
  }

  syncSeqFromMessage(message);
  legacyHandler?.(message);
  return 'legacy';
}

export function startIngest(onLegacyMessage: LegacyControlMessageHandler): void {
  legacyHandler = onLegacyMessage;
  onControlMessage(ingestControlMessage);
}
