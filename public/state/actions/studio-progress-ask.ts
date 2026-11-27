import { defineAction } from '../define-action.ts';
import studioCollection from '../collections/studio.ts';
import { applyOptimisticProgressAsk } from '../studio-core.ts';

const PROGRESS_ASK_TIMEOUT_MS = 130_000;

interface StudioProgressAskInput {
  id: string;
  text: string;
}

const studioProgressAskAction = defineAction<StudioProgressAskInput>({
  type: 'studio-progress-ask',
  timeoutMs: PROGRESS_ASK_TIMEOUT_MS,
  payload: ({ id, text }) => ({ id, text }),
  optimistic: ({ id, text }, apply) => {
    apply(studioCollection, (draft) => {
      applyOptimisticProgressAsk(draft, id, text);
    });
  },
  isReplyOk: (reply) => reply.type === 'studio-progress-ask-result' && reply.ok,
  noticeSource: 'Studio progress',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not check progress: ${detail}`;
  },
});

export default studioProgressAskAction;
