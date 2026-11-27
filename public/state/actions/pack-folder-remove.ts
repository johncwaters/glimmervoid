import { defineAction } from '../define-action.ts';
import packsCollection from '../collections/packs.ts';
import {
  PACK_SOURCE_REPLY_TIMEOUT_MS,
  applyOptimisticPackFolderRemove,
} from '../packs-core.ts';

interface PackFolderRemoveInput {
  dir: string;
  packName?: string;
}

const packFolderRemoveAction = defineAction<PackFolderRemoveInput>({
  type: 'pack-folder-remove',
  payload: ({ dir }) => ({ dir }),
  timeoutMs: PACK_SOURCE_REPLY_TIMEOUT_MS,
  optimistic: ({ dir }, apply) => {
    apply(packsCollection, (draft) => {
      applyOptimisticPackFolderRemove(draft, dir);
    });
  },
  isReplyOk: (reply) => reply.type === 'pack-source-result' && reply.ok,
  noticeSource: 'Remove pack folder',
  rollbackNotice: (error, { packName, dir }) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not remove pack folder ${packName ?? dir}: ${detail}`;
  },
});

export default packFolderRemoveAction;
