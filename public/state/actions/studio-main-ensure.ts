import { defineAction } from '../define-action.ts';
import { applyStudioReply } from '../collections/studio.ts';

const MAIN_ENSURE_TIMEOUT_MS = 15_000;

interface StudioMainEnsureInput {
  id: string;
}

const studioMainEnsureAction = defineAction<StudioMainEnsureInput>({
  type: 'studio-main-ensure',
  timeoutMs: MAIN_ENSURE_TIMEOUT_MS,
  payload: ({ id }) => ({ id }),
  isReplyOk: (reply) => reply.type === 'studio-main-ensure-result' && reply.ok && reply.mainId !== null,
  noticeSource: 'Studio Orchestrator',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `The Orchestrator did not start: ${detail}`;
  },
});

export async function runStudioMainEnsure(input: StudioMainEnsureInput) {
  const outcome = await studioMainEnsureAction(input);
  if (outcome.ok && outcome.reply.type === 'studio-main-ensure-result' && outcome.reply.ok) {
    applyStudioReply(outcome.reply);
  }
  return outcome;
}

export default studioMainEnsureAction;
