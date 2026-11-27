import { defineAction } from '../define-action.ts';
import sessionsCollection from '../collections/sessions.ts';
import { applyOptimisticSessionRestart } from '../sessions-core.ts';

interface RestartSessionInput {
  id: string;
  fresh?: boolean;
  conversationId?: string;
}

const restartAction = defineAction<RestartSessionInput>({
  type: 'restart',
  payload: ({ id, fresh, conversationId }) => ({
    id,
    ...(fresh !== undefined ? { fresh } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
  }),
  optimistic: ({ id }, apply) => {
    apply(sessionsCollection, (draft) => {
      applyOptimisticSessionRestart(draft, id);
    });
  },
  noticeSource: 'Restart session',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not restart session: ${detail}`;
  },
});

export default restartAction;
