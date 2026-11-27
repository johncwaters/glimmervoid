import { defineAction } from '../define-action.ts';
import packsCollection from '../collections/packs.ts';
import {
  PACK_SOURCE_REPLY_TIMEOUT_MS,
  applyOptimisticPackSourceEnable,
} from '../packs-core.ts';

interface PackSourceEnableInput {
  slug: string;
  pack: string;
  isEnabled: boolean;
}

const packSourceEnableAction = defineAction<PackSourceEnableInput>({
  type: 'pack-source-enable',
  payload: ({ slug, pack, isEnabled }) => ({ slug, pack, isEnabled }),
  timeoutMs: PACK_SOURCE_REPLY_TIMEOUT_MS,
  optimistic: ({ slug, pack, isEnabled }, apply) => {
    apply(packsCollection, (draft) => {
      applyOptimisticPackSourceEnable(draft, slug, pack, isEnabled);
    });
  },
  isReplyOk: (reply) => reply.type === 'pack-source-result' && reply.ok,
  noticeSource: 'Packs',
  rollbackNotice: (error, { pack, isEnabled }) => {
    const detail = error instanceof Error ? error.message : String(error);
    const verb = isEnabled ? 'enable' : 'remove';
    return `Could not ${verb} pack "${pack}": ${detail}`;
  },
});

export default packSourceEnableAction;
