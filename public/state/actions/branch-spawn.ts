import { defineAction } from '../define-action.ts';
import studioCollection from '../collections/studio.ts';
import { applyOptimisticBranchSpawn } from '../studio-core.ts';

const BRANCH_SPAWN_TIMEOUT_MS = 30_000;

interface BranchSpawnInput {
  id: string;
  aboutBoxId: string;
  prompt: string;
}

const branchSpawnAction = defineAction<BranchSpawnInput>({
  type: 'branch-spawn',
  timeoutMs: BRANCH_SPAWN_TIMEOUT_MS,
  payload: ({ id, aboutBoxId, prompt }) => ({ id, aboutBoxId, prompt }),
  optimistic: ({ aboutBoxId }, apply) => {
    apply(studioCollection, (draft) => {
      applyOptimisticBranchSpawn(draft, aboutBoxId);
    });
  },
  isReplyOk: (reply) => reply.type === 'branch-spawn-result' && reply.ok && reply.branchId !== null,
  noticeSource: 'Studio branch',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not start branch: ${detail}`;
  },
});

export default branchSpawnAction;
