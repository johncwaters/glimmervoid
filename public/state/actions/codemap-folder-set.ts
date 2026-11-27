import { defineAction } from '../define-action.ts';
import studioCollection, { applyStudioReply } from '../collections/studio.ts';
import { applyOptimisticFolderSet } from '../studio-core.ts';

const FOLDER_SET_TIMEOUT_MS = 10_000;

interface CodemapFolderSetInput {
  id: string;
  boxId: string;
  isOpen: boolean;
}

const codemapFolderSetAction = defineAction<CodemapFolderSetInput>({
  type: 'codemap-folder-set',
  timeoutMs: FOLDER_SET_TIMEOUT_MS,
  payload: ({ id, boxId, isOpen }) => ({ id, boxId, isOpen }),
  optimistic: ({ boxId, isOpen }, apply) => {
    apply(studioCollection, (draft) => {
      applyOptimisticFolderSet(draft, boxId, isOpen);
    });
  },
  isReplyOk: (reply) => reply.type === 'codemap-folder-set-result' && reply.ok,
  noticeSource: 'Studio map',
  rollbackNotice: (error, { isOpen }) => {
    const detail = error instanceof Error ? error.message : String(error);
    const verb = isOpen ? 'open' : 'fold';
    return `Could not ${verb} the repo area: ${detail}`;
  },
});

export async function runCodemapFolderSet(input: CodemapFolderSetInput) {
  const outcome = await codemapFolderSetAction(input);
  if (outcome.ok && outcome.reply.type === 'codemap-folder-set-result' && outcome.reply.ok) {
    applyStudioReply(outcome.reply, { confirmedFolderBoxId: input.boxId });
  }
  return outcome;
}

export default codemapFolderSetAction;
