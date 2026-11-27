import { defineAction } from '../define-action.ts';
import hooksCollection, { reconcileSavedHook } from '../collections/hooks.ts';
import { OPTIMISTIC_HOOK_ID_PREFIX, applyOptimisticHookSave } from '../hooks-core.ts';

interface SaveHookInput {
  hook: Record<string, unknown>;
}

let nextOptimisticHookId = 1;

const saveHookAction = defineAction<SaveHookInput>({
  type: 'save-hook',
  payload: ({ hook }) => ({ hook }),
  optimistic: ({ hook }, apply) => {
    const tempId = `${OPTIMISTIC_HOOK_ID_PREFIX}${nextOptimisticHookId}`;
    nextOptimisticHookId += 1;
    apply(hooksCollection, (draft) => {
      applyOptimisticHookSave(draft, hook, tempId);
    });
  },
  onReply: (reply) => {
    if (reply.type === 'save-hook-result' && reply.hook) {
      reconcileSavedHook(reply.hook);
    }
  },
  noticeSource: 'Hooks',
  rollbackNotice: (error, { hook }) => {
    const detail = error instanceof Error ? error.message : String(error);
    const hookName = typeof hook.name === 'string' && hook.name.trim().length > 0 ? hook.name.trim() : 'hook';
    return `Could not save "${hookName}": ${detail}`;
  },
});

export default saveHookAction;
