import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { PlanDecision } from '../../../shared/contracts/plan-review.ts';
import { errorMessage } from '../../../shared/text.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { readSessionSetup } from '../../session/session-setup-wiring.ts';
import type { ControlContext } from '../control-context.ts';
import { SESSION_GONE_TEXT, replyTo, sendError } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

function createInspectHandlers(context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const { findSession } = context;
  const { readTracePage = null, readPlanRevision = null, decidePlanReview = null, sessionDocs = null, coherenceFeed = null } = deps;

  const handlers = {
    'debug-state': (msg: ClientMessageOf<'debug-state'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) { sendError(ws, SESSION_GONE_TEXT); return; }
      ws.send(JSON.stringify({ type: 'debug-state-response', id: s.id, payload: s.getDebugState() }));
    },
    'session-trace': async (message: ClientMessageOf<'session-trace'>, ws: ControlSocket) => {
      const requestedSessionId = message.id;
      const session = findSession(message);
      if (!session) return sendError(ws, 'Session not found', { id: requestedSessionId, requestId: message.requestId });
      if (!readTracePage) return sendError(ws, 'Session trace is not enabled', { id: session.id, requestId: message.requestId });
      const endingAt = message.endingAt === 'tail' || typeof message.endingAt === 'number' ? message.endingAt : undefined;
      try {
        const page = await readTracePage(session.id, { after: message.after ?? 0, ...(endingAt !== undefined ? { endingAt } : {}) });
        ws.send(JSON.stringify({ type: 'session-trace-response', id: session.id, ...(message.requestId ? { requestId: message.requestId } : {}), ...page }));
      } catch (error) {
        sendError(ws, `Session trace read failed: ${errorMessage(error)}`, { id: session.id, requestId: message.requestId });
      }
    },
    'session-plan': async (message: ClientMessageOf<'session-plan'>, ws: ControlSocket) => {
      const requestedSessionId = String(message.id || '');
      if (!readPlanRevision) return sendError(ws, 'Plan review is not enabled', { id: requestedSessionId, scope: 'plan' });
      const agentId = typeof message.agentId === 'string' ? message.agentId : null;
      const revision = typeof message.revision === 'number' ? message.revision : null;
      const draft = message.draft === true;
      try {
        const result = await readPlanRevision(requestedSessionId, { agentId, revision, draft });
        if (!result) return sendError(ws, 'Plan revision not found', { id: requestedSessionId, scope: 'plan' });
        ws.send(JSON.stringify({ type: 'session-plan-response', id: requestedSessionId, ...result }));
      } catch (error) {
        sendError(ws, `Plan read failed: ${errorMessage(error)}`, { id: requestedSessionId, scope: 'plan' });
      }
    },
    'plan-decision': (message: ClientMessageOf<'plan-decision'>, ws: ControlSocket) => {
      const requestedSessionId = String(message.id || '');
      const refuse = (reason: string) => sendError(ws, reason, { id: requestedSessionId, scope: 'plan-decision' });
      if (!decidePlanReview) return refuse('Plan review is not enabled');
      const session = findSession(message);
      if (!session) return refuse('Session not found');
      const parsed = PlanDecision.safeParse({ ...message, id: session.id });
      if (!parsed.success) return refuse('Plan decision refused by the schema');
      const refusal = decidePlanReview(session.id, parsed.data);
      if (!refusal) return;
      ws.send(JSON.stringify({
        type: 'session-error',
        id: session.id,
        scope: 'plan-decision',
        session: session.name,
        message: refusal,
      }));
    },
    'session-doc-read': async (message: ClientMessageOf<'session-doc-read'>, ws: ControlSocket) => {
      const reply = { type: 'session-doc-response', requestId: message.requestId ?? null, id: message.id, path: message.path };
      const session = findSession(message);
      if (!sessionDocs || !session) return ws.send(JSON.stringify({ ...reply, ok: false, error: 'Session not found' }));
      try {
        ws.send(JSON.stringify({ ...reply, ...await sessionDocs.read(session, message.path) }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `Read failed: ${errorMessage(error)}` }));
      }
    },
    'session-coherence-journal': async (message: ClientMessageOf<'session-coherence-journal'>, ws: ControlSocket) => {
      const reply = { type: 'session-coherence-journal-response', requestId: message.requestId ?? null, id: message.id };
      const session = findSession(message);
      if (!coherenceFeed || !session) return ws.send(JSON.stringify({ ...reply, ok: false, entries: [], error: 'Session not found' }));
      const journal = await coherenceFeed.readJournal(session);
      if (!journal.ok) return ws.send(JSON.stringify({ ...reply, ok: false, entries: [], error: journal.error }));
      ws.send(JSON.stringify({ ...reply, ok: true, entries: journal.entries }));
    },
    'session-setup': async (message: ClientMessageOf<'session-setup'>, ws: ControlSocket) => {
      const session = findSession(message);
      if (!session) return replyTo(ws, message, 'session-setup-response', { id: message.id, ok: false, error: 'Session not found' });
      const transcriptPath = session.transcriptPath;
      if (session.agentId !== 'claude-code' || !transcriptPath) return replyTo(ws, message, 'session-setup-response', { id: message.id, ok: false, error: 'No Claude Code transcript for this session yet' });
      try {
        const setup = await readSessionSetup(transcriptPath);
        replyTo(ws, message, 'session-setup-response', { id: message.id, ok: true, setup });
      } catch {
        replyTo(ws, message, 'session-setup-response', { id: message.id, ok: false, error: 'Could not read the Claude Code transcript for this session' });
      }
    },
    'session-doc-save': async (message: ClientMessageOf<'session-doc-save'>, ws: ControlSocket) => {
      const reply = { type: 'session-doc-save-result', requestId: message.requestId ?? null, id: message.id, path: message.path };
      const session = findSession(message);
      if (!sessionDocs || !session) return ws.send(JSON.stringify({ ...reply, ok: false, error: 'Session not found' }));
      try {
        ws.send(JSON.stringify({ ...reply, ...await sessionDocs.save(session, message.path, message.text, message.baseHash) }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `Save failed: ${errorMessage(error)}` }));
      }
    },
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'session-doc-read': (msg, requestId, message) => ({ type: 'session-doc-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', path: typeof msg?.path === 'string' ? msg.path : '', ok: false, error: message }),
    'session-doc-save': (msg, requestId, message) => ({ type: 'session-doc-save-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', path: typeof msg?.path === 'string' ? msg.path : '', ok: false, error: message }),
    'session-coherence-journal': (msg, requestId, message) => ({ type: 'session-coherence-journal-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, entries: [], error: message }),
    'session-setup': (msg, requestId, message) => ({ type: 'session-setup-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, genericErrorTypes: ['debug-state', 'session-trace', 'session-plan', 'plan-decision'] };
}

export { createInspectHandlers };
