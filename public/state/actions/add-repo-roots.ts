import { defineAction } from '../define-action.ts';
import settingsCollection from '../collections/settings.ts';
import { applyOptimisticAddedRepoRoots } from '../settings-core.ts';

interface AddRepoRootsInput {
  roots: string[];
}

const addRepoRootsAction = defineAction<AddRepoRootsInput>({
  type: 'add-repo-roots',
  payload: ({ roots }) => ({ roots }),
  optimistic: ({ roots }, apply) => {
    apply(settingsCollection, (draft) => {
      applyOptimisticAddedRepoRoots(draft, roots);
    });
  },
  noticeSource: 'Repository folders',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not add repository folder: ${detail}`;
  },
});

export default addRepoRootsAction;
