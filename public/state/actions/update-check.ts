import { defineAction } from '../define-action.ts';

type UpdateCheckInput = Record<string, never>;

const updateCheckAction = defineAction<UpdateCheckInput>({
  type: 'update-check',
  payload: () => ({}),
  noticeSource: 'Updates',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not check for updates: ${detail}`;
  },
});

export default updateCheckAction;
