import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import {
  SERVER_MESSAGE_CLASS,
  collectionNamesForServerMessage,
} from '#shared/contracts/control/message-classes.ts';
import type { CollectionServerMessageType } from '#shared/contracts/control/message-classes.ts';
import { onControlMessage } from '../control-ws.ts';
import { applyCollectionServerMessages } from './define-collection.ts';
import { advanceSeq, resetSeq } from './seq.ts';

type LegacyControlMessageHandler = (message: ServerMessage) => void;

let legacyHandler: LegacyControlMessageHandler | null = null;
let afterIngestHandler: LegacyControlMessageHandler | null = null;

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
    const collectionNames = collectionNamesForServerMessage(message.type as CollectionServerMessageType);
    const { appliedCount, totalCount } = applyCollectionServerMessages(collectionNames, message);
    syncSeqFromMessage(message);
    if (appliedCount === totalCount && totalCount > 0) {
      afterIngestHandler?.(message);
      return 'collection';
    }
    legacyHandler?.(message);
    afterIngestHandler?.(message);
    return 'legacy';
  }

  syncSeqFromMessage(message);
  legacyHandler?.(message);
  afterIngestHandler?.(message);
  return 'legacy';
}

export function startIngest(
  onLegacyMessage: LegacyControlMessageHandler,
  onAfterIngest?: LegacyControlMessageHandler,
): void {
  legacyHandler = onLegacyMessage;
  afterIngestHandler = onAfterIngest ?? null;
  onControlMessage(ingestControlMessage);
}
