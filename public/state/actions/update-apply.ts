import { defineAction } from '../define-action.ts';

type UpdateApplyInput = Record<string, never>;

const STAGED_UPDATE_PIPELINE_TIMEOUT_MS = 30 * 60_000;

const updateApplyAction = defineAction<UpdateApplyInput>({
  type: 'update-apply',
  payload: () => ({}),
  timeoutMs: STAGED_UPDATE_PIPELINE_TIMEOUT_MS,
  noticeSource: 'Updates',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not start update: ${detail}`;
  },
});

export default updateApplyAction;
