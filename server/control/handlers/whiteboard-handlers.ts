import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import type { WhiteboardPort } from '../../whiteboard/whiteboard-wiring.ts';
import type { ControlContext, RequestWithId } from '../control-context.ts';
import { replyTo } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

function createWhiteboardHandlers(context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const { findSession } = context;
  const { whiteboards = null } = deps;

  async function answerWhiteboard(ws: ControlSocket, msg: RequestWithId, command: (port: WhiteboardPort['handleOperator']) => Promise<Record<string, unknown>>): Promise<void> {
    if (!whiteboards) {
      replyTo(ws, msg, 'whiteboard-result', { ok: false, error: 'Whiteboards are not available on this server.' });
      return;
    }
    replyTo(ws, msg, 'whiteboard-result', { ...await command(whiteboards.handleOperator) });
  }

  const handlers = {
    'whiteboard-create': (msg: ClientMessageOf<'whiteboard-create'>, ws: ControlSocket) => answerWhiteboard(ws, msg, (port) => port.create(msg.title)),
    'whiteboard-op': (msg: ClientMessageOf<'whiteboard-op'>, ws: ControlSocket) => answerWhiteboard(ws, msg, (port) => port.put(msg.boardId, msg.ops)),
    'whiteboard-delete': (msg: ClientMessageOf<'whiteboard-delete'>, ws: ControlSocket) => answerWhiteboard(ws, msg, (port) => port.remove(msg.boardId)),
    'whiteboard-get': (msg: ClientMessageOf<'whiteboard-get'>, ws: ControlSocket) => answerWhiteboard(ws, msg, (port) => port.get(msg.boardId)),
    'whiteboard-review': (msg: ClientMessageOf<'whiteboard-review'>, ws: ControlSocket) => answerWhiteboard(ws, msg, (port) => port.review(msg.boardId)),
    'whiteboard-connect': (msg: ClientMessageOf<'whiteboard-connect'>, ws: ControlSocket) => answerWhiteboard(ws, msg, async (port) => {
      if (!findSession({ id: msg.sessionId })) return { ok: false, error: 'That session is no longer on the dashboard.' };
      return port.connect(msg.boardId, msg.sessionId);
    }),
    'whiteboard-disconnect': (msg: ClientMessageOf<'whiteboard-disconnect'>, ws: ControlSocket) => answerWhiteboard(ws, msg, (port) => port.disconnect(msg.boardId, msg.sessionId)),
    'whiteboard-nudge': (msg: ClientMessageOf<'whiteboard-nudge'>, ws: ControlSocket) => answerWhiteboard(ws, msg, async (port) => {
      const session = findSession({ id: msg.sessionId });
      if (!session) return { ok: false, error: 'That session is no longer on the dashboard.' };
      const nudgeLine = port.nudgeLine(msg.boardId);
      if (!nudgeLine) return { ok: false, error: 'That board was deleted.' };
      if (session.hasPendingPaste()) return { ok: false, error: 'That session already has a prompt waiting to be pasted, so nothing was sent.' };
      const pasted = session.pasteTextWhenReady(nudgeLine, { submit: true });
      if (!pasted.ok) return { ok: false, error: 'That session has no live terminal, so nothing was sent.' };
      return { ok: true, error: null };
    }),
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'whiteboard-create': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-op': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-delete': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-get': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-review': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-connect': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-disconnect': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-nudge': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies };
}

export { createWhiteboardHandlers };
