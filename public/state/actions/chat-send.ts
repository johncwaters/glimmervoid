import { defineAction } from '../define-action.ts';
import chatOutboxCollection, { chatOutboxEntriesOf } from '../collections/chat-outbox.ts';
import {
  OPTIMISTIC_OUTBOX_ENTRY_PREFIX,
  applyOptimisticChatSend,
  isOptimisticOutboxEntryId,
} from '../chat-outbox-core.ts';

const CHAT_SEND_TIMEOUT_MS = 10000;
let optimisticSendSequence = 0;

function nextOptimisticOutboxEntryId(): string {
  optimisticSendSequence += 1;
  return `${OPTIMISTIC_OUTBOX_ENTRY_PREFIX}${optimisticSendSequence}`;
}

function sameAttachments(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

interface ChatSendInput {
  id: string;
  text: string;
  attachments: readonly string[];
  isTurnRunning: boolean;
}

const chatSendAction = defineAction<ChatSendInput>({
  type: 'chat-send',
  timeoutMs: CHAT_SEND_TIMEOUT_MS,
  payload: ({ id, text, attachments }) => ({
    id,
    text: text.trim(),
    attachments: [...attachments],
  }),
  optimistic: ({ id, text, attachments, isTurnRunning }, apply) => {
    const normalizedText = text.trim();
    const currentEntries = chatOutboxEntriesOf(id);
    const knownServerEntryIds = new Set(
      currentEntries
        .filter((entry) => !isOptimisticOutboxEntryId(entry.entryId))
        .map((entry) => entry.entryId),
    );
    const priorInFlightMatchCount = currentEntries.filter((entry) => (
      isOptimisticOutboxEntryId(entry.entryId)
      && entry.origin === 'operator'
      && entry.text === normalizedText
      && sameAttachments(entry.attachments, attachments)
    )).length;
    const optimisticEntryId = nextOptimisticOutboxEntryId();
    apply(chatOutboxCollection, (draft) => {
      applyOptimisticChatSend(draft, {
        sessionId: id,
        optimisticEntryId,
        text: normalizedText,
        attachments,
        isTurnRunning,
        knownServerEntryIds,
        priorInFlightMatchCount,
      });
    });
  },
  isReplyOk: (reply) => reply.type === 'chat-send-result' && reply.ok,
  noticeSource: 'Chat',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not send message: ${detail}`;
  },
});

export default chatSendAction;
