import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import type { WhiteboardPort } from '../../whiteboard/whiteboard-wiring.ts';
import type { TileViewer } from '../../whiteboard/board-tile-service.ts';
import type { ControlContext, RequestWithId } from '../control-context.ts';
import { replyTo } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

function createWhiteboardHandlers(context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const { findSession } = context;
  const { whiteboards = null } = deps;
  const tileViewerBySocket = new WeakMap<ControlSocket, TileViewer>();

  function tileViewerOf(ws: ControlSocket, port: Pick<WhiteboardPort, 'tiles'>): TileViewer {
    const known = tileViewerBySocket.get(ws);
    if (known) return known;
    const viewer: TileViewer = { send: (message) => ws.send(JSON.stringify(message)) };
    tileViewerBySocket.set(ws, viewer);
    ws.once('close', () => port.tiles.forget(viewer));
    return viewer;
  }

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
    'whiteboard-view': (msg: ClientMessageOf<'whiteboard-view'>, ws: ControlSocket) => {
      if (!whiteboards) return;
      whiteboards.tiles.view(tileViewerOf(ws, whiteboards), { boardId: msg.boardId, view: msg.view, lod: msg.lod, knownVersion: msg.knownVersion });
    },
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'whiteboard-create': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-op': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-delete': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-get': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-review': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-connect': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-disconnect': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-view': (_msg, requestId, message) => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies };
}

export { createWhiteboardHandlers };
