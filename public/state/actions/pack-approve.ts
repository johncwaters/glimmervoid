import { defineAction } from '../define-action.ts';
import packsCollection from '../collections/packs.ts';
import { applyOptimisticPackApprove } from '../packs-core.ts';

interface PackApproveInput {
  fingerprint: string;
  packName?: string;
}

const packApproveAction = defineAction<PackApproveInput>({
  type: 'pack-approve',
  payload: ({ fingerprint }) => ({ fingerprint }),
  optimistic: ({ fingerprint }, apply) => {
    apply(packsCollection, (draft) => {
      applyOptimisticPackApprove(draft, fingerprint);
    });
  },
  isReplyOk: (reply) => reply.type === 'pack-approve-result' && reply.ok,
  noticeSource: 'Approve pack',
  rollbackNotice: (error, { packName }) => {
    const detail = error instanceof Error ? error.message : String(error);
    const label = packName ? ` "${packName}"` : '';
    return `Could not approve pack${label}: ${detail}`;
  },
});

export default packApproveAction;
