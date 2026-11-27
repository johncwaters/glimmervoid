import { defineAction } from '../define-action.ts';
import studioCollection, { applyStudioReply } from '../collections/studio.ts';

const MAIN_ENSURE_TIMEOUT_MS = 15_000;

interface StudioMainEnsureInput {
  id: string;
}

const studioMainEnsureAction = defineAction<StudioMainEnsureInput>({
  type: 'studio-main-ensure',
  timeoutMs: MAIN_ENSURE_TIMEOUT_MS,
  payload: ({ id }) => ({ id }),
  optimistic: ({ id }, apply) => {
    apply(studioCollection, (draft) => {
      if (draft.shownSessionId !== id) draft.pendingMainId = id;
    });
  },
  isReplyOk: (reply) => reply.type === 'studio-main-ensure-result' && reply.ok && reply.mainId !== null,
  onReply: (reply) => {
    if (reply.type === 'studio-main-ensure-result' && reply.ok) {
      applyStudioReply(reply);
    }
  },
  noticeSource: 'Studio Orchestrator',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `The Orchestrator did not start: ${detail}`;
  },
});

export async function runStudioMainEnsure(input: StudioMainEnsureInput) {
  return studioMainEnsureAction(input);
}

export default studioMainEnsureAction;
