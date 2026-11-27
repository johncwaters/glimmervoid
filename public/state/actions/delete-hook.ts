import { defineAction } from '../define-action.ts';
import hooksCollection, { reconcileDeletedHook } from '../collections/hooks.ts';
import { applyOptimisticHookDelete } from '../hooks-core.ts';

interface DeleteHookInput {
  id: string;
  name?: string;
}

const deleteHookAction = defineAction<DeleteHookInput>({
  type: 'delete-hook',
  payload: ({ id }) => ({ id }),
  optimistic: ({ id }, apply) => {
    apply(hooksCollection, (draft) => {
      applyOptimisticHookDelete(draft, id);
    });
  },
  onReply: (_reply, { id }) => {
    reconcileDeletedHook(id);
  },
  noticeSource: 'Hooks',
  rollbackNotice: (error, { name }) => {
    const detail = error instanceof Error ? error.message : String(error);
    const label = name && name.trim().length > 0 ? `"${name.trim()}"` : 'hook';
    return `Could not delete ${label}: ${detail}`;
  },
});

export default deleteHookAction;
