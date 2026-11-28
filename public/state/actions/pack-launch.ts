import { DEFAULT_REPLY_TIMEOUT_MS } from '../../action-status.ts';
import { defineAction } from '../define-action.ts';
import sessionsCollection from '../collections/sessions.ts';
import { applyOptimisticPendingLaunch } from '../sessions-core.ts';

interface PackLaunchInput {
  pack: string;
  launcherId: string;
  timeoutMs?: number;
}

const packLaunchAction = defineAction<PackLaunchInput>({
  type: 'pack-launch',
  timeoutMs: (input) => input.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
  payload: ({ pack, launcherId }) => ({ pack, launcherId }),
  optimistic: ({ pack, launcherId }, apply) => {
    apply(sessionsCollection, (draft) => {
      applyOptimisticPendingLaunch(draft, `pack:${pack}:${launcherId}`);
    });
  },
  isReplyOk: (reply) => reply.type === 'add-session-result' && reply.ok,
  noticeSource: 'Add session',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `The session was not added: ${detail}`;
  },
});

export default packLaunchAction;
