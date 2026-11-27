import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { errorMessage } from '../../../shared/text.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import type { ControlContext } from '../control-context.ts';
import { SESSION_GONE_TEXT, sendError } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

function createInspectHandlers(context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const { findSession, replyApplied } = context;
  const { readTracePage = null, sessionDocs = null } = deps;

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
    'session-doc-asset-read': async (message: ClientMessageOf<'session-doc-asset-read'>, ws: ControlSocket) => {
      const reply = { type: 'session-doc-asset-response', requestId: message.requestId ?? null, id: message.id, path: message.path, src: message.src };
      const session = findSession(message);
      if (!sessionDocs || !session) return ws.send(JSON.stringify({ ...reply, ok: false, error: 'Session not found' }));
      try {
        ws.send(JSON.stringify({ ...reply, ...await sessionDocs.readImage(session, message.path, message.src) }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `Read failed: ${errorMessage(error)}` }));
      }
    },
    'session-doc-save': async (message: ClientMessageOf<'session-doc-save'>, ws: ControlSocket) => {
      const basePayload = { id: message.id, path: message.path };
      const session = findSession(message);
      if (!sessionDocs || !session) {
        replyApplied(ws, message, 'session-doc-save-result', { ...basePayload, ok: false, error: 'Session not found' });
        return;
      }
      try {
        replyApplied(ws, message, 'session-doc-save-result', { ...basePayload, ...await sessionDocs.save(session, message.path, message.text, message.baseHash) });
      } catch (error) {
        replyApplied(ws, message, 'session-doc-save-result', { ...basePayload, ok: false, error: `Save failed: ${errorMessage(error)}` });
      }
    },
    'session-doc-open': async (message: ClientMessageOf<'session-doc-open'>, ws: ControlSocket) => {
      const basePayload = { id: message.id, path: message.path };
      const session = findSession(message);
      if (!sessionDocs || !session) {
        replyApplied(ws, message, 'session-doc-open-result', { ...basePayload, ok: false, error: 'Session not found' });
        return;
      }
      try {
        const opened = await sessionDocs.surface(session, { path: message.path });
        replyApplied(ws, message, 'session-doc-open-result', opened.ok ? { ...basePayload, ok: true } : { ...basePayload, ok: false, error: opened.error });
      } catch (error) {
        replyApplied(ws, message, 'session-doc-open-result', { ...basePayload, ok: false, error: `Open failed: ${errorMessage(error)}` });
      }
    },
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'session-doc-read': (msg, requestId, message) => ({ type: 'session-doc-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', path: typeof msg?.path === 'string' ? msg.path : '', ok: false, error: message }),
    'session-doc-asset-read': (msg, requestId, message) => ({ type: 'session-doc-asset-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', path: typeof msg?.path === 'string' ? msg.path : '', src: typeof msg?.src === 'string' ? msg.src : '', ok: false, error: message }),
    'session-doc-open': (msg, requestId, message) => ({ type: 'session-doc-open-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', path: typeof msg?.path === 'string' ? msg.path : '', ok: false, error: message }),
    'session-doc-save': (msg, requestId, message) => ({ type: 'session-doc-save-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', path: typeof msg?.path === 'string' ? msg.path : '', ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, genericErrorTypes: ['debug-state', 'session-trace'] };
}

export { createInspectHandlers };
