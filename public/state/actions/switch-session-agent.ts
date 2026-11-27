import { DEFAULT_REPLY_TIMEOUT_MS } from '../../action-status.ts';
import { defineAction } from '../define-action.ts';
import sessionsCollection from '../collections/sessions.ts';

interface SwitchSessionAgentInput {
  id: string;
  agent: string;
}

const switchSessionAgentAction = defineAction<SwitchSessionAgentInput>({
  type: 'switch-session-agent',
  timeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
  payload: ({ id, agent }) => ({ id, agent }),
  optimistic: ({ id, agent }, apply) => {
    apply(sessionsCollection, (draft) => {
      const record = draft.byId[id];
      if (!record) return;
      record.agent = agent;
      record.failureReason = null;
    });
  },
  isReplyOk: (reply) => reply.type === 'switch-session-agent-result' && reply.ok,
  noticeSource: 'Switch agent',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `The agent was not switched: ${detail}`;
  },
});

export default switchSessionAgentAction;
