import { defineAction } from '../define-action.ts';
import sessionsCollection, { applyChatStopReply } from '../collections/sessions.ts';
import { applyOptimisticChatStop } from '../sessions-core.ts';

interface ChatStopInput {
  id: string;
  entryId?: string;
}

const chatStopAction = defineAction<ChatStopInput>({
  type: 'chat-stop',
  payload: ({ id, entryId }) => (entryId === undefined ? { id } : { id, entryId }),
  optimistic: ({ id }, apply) => {
    apply(sessionsCollection, (draft) => {
      applyOptimisticChatStop(draft, id);
    });
  },
  isReplyOk: (reply) => reply.type === 'session-action-result' && reply.ok,
  onReply: (reply, { id }) => {
    if (reply.type === 'session-action-result' && reply.ok) {
      applyChatStopReply(reply, id);
    }
  },
  noticeSource: 'Chat',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not stop turn: ${detail}`;
  },
});

export default chatStopAction;
