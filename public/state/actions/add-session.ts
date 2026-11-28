import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { DEFAULT_REPLY_TIMEOUT_MS } from '../../action-status.ts';
import { sendControlRequest } from '../../control-ws.ts';
import { defineAction } from '../define-action.ts';
import studioCollection, { applyStudioReply } from '../collections/studio.ts';
import { applyOptimisticRepoBranchAgent } from '../studio-core.ts';

export function scanRepoRoots(): Promise<ServerMessage> {
  return sendControlRequest('scan-repo-roots', { includeSuggestions: true, includeActivity: true }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
}

export function listAddSessionAgents(isStudio: boolean): Promise<ServerMessage> {
  return sendControlRequest('list-agents', isStudio ? { driver: 'acp' } : {}, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
}

export function requestAddSessionSettings(): Promise<ServerMessage> {
  return sendControlRequest('get-settings', {}, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
}

export function listStartPicks(): Promise<ServerMessage> {
  return sendControlRequest('list-start-picks', {}, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
}

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
  onReply: (reply, input) => {
    if (input.studio !== true) return;
    if (reply.type === 'add-session-result' && reply.ok) {
      applyStudioReply(reply, {
        ...(input.agent ? { confirmedRepoBranchAgent: { repoDir: input.path, agentId: input.agent } } : {}),
      });
    }
  },
  noticeSource: 'Add session',
  rollbackNotice: (error, input) => {
    const detail = error instanceof Error ? error.message : String(error);
    if (input.studio === true) return `The Studio repo was not opened: ${detail}`;
    return `The session was not added: ${detail}`;
  },
});

export async function runStudioAddSession(input: AddSessionInput) {
  return addSessionAction({ ...input, studio: true });
}

export default addSessionAction;
