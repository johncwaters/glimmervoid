import { defineAction } from '../define-action.ts';
import sessionsCollection from '../collections/sessions.ts';
import { applyOptimisticSessionRename } from '../sessions-core.ts';

interface RenameSessionInput {
  id: string;
  newName: string;
}

const renameSessionAction = defineAction<RenameSessionInput>({
  type: 'rename-session',
  payload: ({ id, newName }) => ({ id, newName }),
  optimistic: ({ id, newName }, apply) => {
    apply(sessionsCollection, (draft) => {
      applyOptimisticSessionRename(draft, id, newName);
    });
  },
  noticeSource: 'Rename session',
  rollbackNotice: (error, { newName }) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not rename session to "${newName}": ${detail}`;
  },
});

export default renameSessionAction;
