import { defineAction } from '../define-action.ts';
import packsCollection from '../collections/packs.ts';
import {
  PACK_SOURCE_REPLY_TIMEOUT_MS,
  applyOptimisticPackSourceRemove,
} from '../packs-core.ts';

interface PackSourceRemoveInput {
  slug: string;
}

const packSourceRemoveAction = defineAction<PackSourceRemoveInput>({
  type: 'pack-source-remove',
  payload: ({ slug }) => ({ slug }),
  timeoutMs: PACK_SOURCE_REPLY_TIMEOUT_MS,
  optimistic: ({ slug }, apply) => {
    apply(packsCollection, (draft) => {
      applyOptimisticPackSourceRemove(draft, slug);
    });
  },
  isReplyOk: (reply) => reply.type === 'pack-source-result' && reply.ok,
  noticeSource: 'Remove pack source',
  rollbackNotice: (error, { slug }) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not remove pack source "${slug}": ${detail}`;
  },
});

export default packSourceRemoveAction;
