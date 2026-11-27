import { DEFAULT_REPLY_TIMEOUT_MS } from '../../action-status.ts';
import { defineAction } from '../define-action.ts';
import studioCollection, { applyStudioReply } from '../collections/studio.ts';
import { applyOptimisticRepoBranchAgent } from '../studio-core.ts';

interface AddSessionInput {
  name: string;
  path: string;
  repos?: string[];
  agent?: string;
  dangerouslySkipPermissions?: boolean;
  saneYolo?: boolean;
  runInPlace?: boolean;
  accountId?: string | null;
  resumeSessionId?: string;
  prompt?: string;
  setup?: unknown;
  studio?: boolean;
  timeoutMs?: number;
}

const addSessionAction = defineAction<AddSessionInput>({
  type: 'add-session',
  timeoutMs: (input) => input.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
  payload: ({ timeoutMs: _timeoutMs, ...wirePayload }) => wirePayload,
  optimistic: (input, apply) => {
    if (input.studio !== true || !input.agent) return;
    apply(studioCollection, (draft) => {
      applyOptimisticRepoBranchAgent(draft, input.path, input.agent ?? '');
    });
  },
  isReplyOk: (reply) => reply.type === 'add-session-result' && reply.ok,
  noticeSource: 'Add session',
  rollbackNotice: (error, input) => {
    const detail = error instanceof Error ? error.message : String(error);
    if (input.studio === true) return `The Studio repo was not opened: ${detail}`;
    return `The session was not added: ${detail}`;
  },
});

export async function runStudioAddSession(input: AddSessionInput) {
  const outcome = await addSessionAction({ ...input, studio: true });
  if (outcome.ok && outcome.reply.type === 'add-session-result' && outcome.reply.ok) {
    applyStudioReply(outcome.reply, {
      ...(input.agent ? { confirmedRepoBranchAgent: { repoDir: input.path, agentId: input.agent } } : {}),
    });
  }
  return outcome;
}

export default addSessionAction;
