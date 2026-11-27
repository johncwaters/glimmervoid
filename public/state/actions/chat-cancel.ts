import { defineAction } from '../define-action.ts';
import chatOutboxCollection from '../collections/chat-outbox.ts';
import { applyOptimisticChatCancel } from '../chat-outbox-core.ts';

const CHAT_CANCEL_TIMEOUT_MS = 10000;

interface ChatCancelInput {
  id: string;
  entryId: string;
}

const chatCancelAction = defineAction<ChatCancelInput>({
  type: 'chat-cancel',
  timeoutMs: CHAT_CANCEL_TIMEOUT_MS,
  payload: ({ id, entryId }) => ({ id, entryId }),
  optimistic: ({ id, entryId }, apply) => {
    apply(chatOutboxCollection, (draft) => {
      applyOptimisticChatCancel(draft, id, entryId);
    });
  },
  isReplyOk: (reply) => reply.type === 'chat-cancel-result',
  noticeSource: 'Chat',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not cancel the message: ${detail}`;
  },
});

export default chatCancelAction;
