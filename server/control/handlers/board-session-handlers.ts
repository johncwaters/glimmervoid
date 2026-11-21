import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { errorMessage } from '../../../shared/text.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import type { ControlContext } from '../control-context.ts';
import { SESSION_GONE_TEXT } from '../control-context.ts';
import { createBranchWiring } from '../../board-session/branch-wiring.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

const CODE_MAP_OFF_TEXT = 'The code map is not running';
const BOARD_ASKS_OFF_TEXT = 'Board questions are not running';

function createBoardSessionHandlers(context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const { findSession, createProjectSession } = context;
  const { codemap = null, boardAsks = null } = deps;
  const branches = createBranchWiring({ findSession: (sessionId) => findSession({ id: sessionId }), createProjectSession });

  const handlers = {
    'codemap-boxes-of': async (message: ClientMessageOf<'codemap-boxes-of'>, ws: ControlSocket) => {
      const reply = { type: 'codemap-boxes-of-response', id: message.id, requestId: message.requestId ?? null };
      const session = findSession(message);
      if (!session) return ws.send(JSON.stringify({ ...reply, ok: false, error: SESSION_GONE_TEXT }));
      if (!codemap) return ws.send(JSON.stringify({ ...reply, ok: false, error: CODE_MAP_OFF_TEXT }));
      try {
        const boxes = await codemap.boxesOfSession(session.path, session.id, message.paths);
        ws.send(JSON.stringify({ ...reply, ...boxes }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `Code map read failed: ${errorMessage(error)}` }));
      }
    },
    'board-ask-answer': async (message: ClientMessageOf<'board-ask-answer'>, ws: ControlSocket) => {
      const reply = { type: 'board-ask-answer-result', requestId: message.requestId ?? null };
      if (!boardAsks) return ws.send(JSON.stringify({ ...reply, ok: false, error: BOARD_ASKS_OFF_TEXT }));
      try {
        const outcome = await boardAsks.answer(message.boardId, message.askBoxId, message.answer);
        ws.send(JSON.stringify({ ...reply, ...outcome }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `The answer was not sent: ${errorMessage(error)}` }));
      }
    },
    'branch-spawn': async (message: ClientMessageOf<'branch-spawn'>, ws: ControlSocket) => {
      const reply = { type: 'branch-spawn-result', id: message.id, requestId: message.requestId ?? null };
      try {
        const outcome = await branches.spawn({ parentId: message.id, aboutBoxId: message.aboutBoxId, aboutTitle: message.aboutTitle, prompt: message.prompt });
        if (!outcome.ok) return ws.send(JSON.stringify({ ...reply, ok: false, error: outcome.error }));
        ws.send(JSON.stringify({ ...reply, ok: true, branchId: outcome.sessionId }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `The branch did not start: ${errorMessage(error)}` }));
      }
    },
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'codemap-boxes-of': (msg, requestId, message) => ({ type: 'codemap-boxes-of-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
    'board-ask-answer': (_msg, requestId, message) => ({ type: 'board-ask-answer-result', requestId, ok: false, error: message }),
    'branch-spawn': (msg, requestId, message) => ({ type: 'branch-spawn-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, genericErrorTypes: [] };
}

export { createBoardSessionHandlers };
