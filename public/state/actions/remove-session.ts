import { DEFAULT_REPLY_TIMEOUT_MS } from '../../action-status.ts';
import { defineAction } from '../define-action.ts';
import sessionsCollection from '../collections/sessions.ts';
import { applyOptimisticSessionRemove } from '../sessions-core.ts';

const SESSION_REMOVAL_TIMEOUT_MS = 65 * 60_000;

interface RemoveSessionInput {
  id: string;
  checkOnly?: boolean;
  discardWork?: boolean;
  confirmedKeptPaths?: string[];
  label?: string;
}

const removeSessionAction = defineAction<RemoveSessionInput>({
  type: 'remove-session',
  timeoutMs: ({ checkOnly }) => (checkOnly ? DEFAULT_REPLY_TIMEOUT_MS : SESSION_REMOVAL_TIMEOUT_MS),
  payload: ({ id, checkOnly, discardWork, confirmedKeptPaths }) => ({
    id,
    ...(checkOnly !== undefined ? { checkOnly } : {}),
    ...(discardWork !== undefined ? { discardWork } : {}),
    ...(confirmedKeptPaths !== undefined ? { confirmedKeptPaths } : {}),
  }),
  optimistic: ({ id, checkOnly }, apply) => {
    if (checkOnly) return;
    apply(sessionsCollection, (draft) => {
      applyOptimisticSessionRemove(draft, id);
    });
  },
  isReplyOk: (reply) => {
    if (reply.type !== 'remove-session-result') return false;
    if (reply.ok) return true;
    return reply.canDiscardWork === true;
  },
  noticeSource: 'Remove session',
  rollbackNotice: (error, { label }) => {
    const detail = error instanceof Error ? error.message : String(error);
    const subject = label ? `"${label}"` : 'The session';
    return `${subject} was not removed: ${detail} Try Remove again from its actions menu.`;
  },
});

export default removeSessionAction;
