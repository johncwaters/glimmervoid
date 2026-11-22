import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { errorMessage } from '../../../shared/text.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import type { ControlContext } from '../control-context.ts';
import { SESSION_GONE_TEXT } from '../control-context.ts';
import type { BranchWiring } from '../../board-session/branch-wiring.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';
import type { Session } from '../../../session/sessions.ts';
import { mainAgentNameOf } from '../../core/studio-main-core.ts';
import { wakeStudioMain } from '../../board-session/studio-main.ts';

const CODE_MAP_OFF_TEXT = 'The code map is not running';
const BOARD_ASKS_OFF_TEXT = 'Board questions are not running';

const WORKSPACE_MAIN_TEXT = 'A workspace of several repos has no main agent; open one of its repos.';

type MainAgentOutcome = { ok: true; mainId: string } | { ok: false; error: string };

function createBoardSessionHandlers(context: ControlContext, deps: ControlHandlerDeps, branches: BranchWiring): ControlHandlerGroup {
  const { findSession, createProjectSession, findConfiguredProject, sessions } = context;
  const { codemap = null, boardAsks = null } = deps;

  function ensureMainAgent(anchor: Session): MainAgentOutcome {
    const repoPath = anchor.path;
    if (findConfiguredProject(anchor.id)?.repos) return { ok: false, error: WORKSPACE_MAIN_TEXT };
    const mainId = wakeStudioMain(sessions.values(), repoPath);
    if (mainId !== null) return { ok: true, mainId };
    const created = createProjectSession({
      name: mainAgentNameOf(repoPath),
      path: repoPath,
      agent: anchor.agentId,
      dangerouslySkipPermissions: anchor.dangerouslySkipPermissions,
      saneYolo: anchor.saneYolo,
      accountId: anchor.accountId,
      requireExistingPath: true,
      runSettings: { isStudioMain: true },
    });
    if (!created.ok) return created;
    return { ok: true, mainId: created.project.id };
  }

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
    'studio-main-ensure': (message: ClientMessageOf<'studio-main-ensure'>, ws: ControlSocket) => {
      const reply = { type: 'studio-main-ensure-result', id: message.id, requestId: message.requestId ?? null };
      const anchor = findSession(message);
      if (!anchor) return ws.send(JSON.stringify({ ...reply, ok: false, error: SESSION_GONE_TEXT }));
      const outcome = ensureMainAgent(anchor);
      ws.send(JSON.stringify({ ...reply, ...outcome }));
    },
    'codemap-folder-toggle': async (message: ClientMessageOf<'codemap-folder-toggle'>, ws: ControlSocket) => {
      const reply = { type: 'codemap-folder-toggle-result', id: message.id, requestId: message.requestId ?? null };
      const session = findSession(message);
      if (!session) return ws.send(JSON.stringify({ ...reply, ok: false, error: SESSION_GONE_TEXT }));
      if (!codemap) return ws.send(JSON.stringify({ ...reply, ok: false, error: CODE_MAP_OFF_TEXT }));
      try {
        ws.send(JSON.stringify({ ...reply, ...await codemap.toggleFolder(session.path, message.boxId) }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `The folder did not open: ${errorMessage(error)}` }));
      }
    },
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'codemap-boxes-of': (msg, requestId, message) => ({ type: 'codemap-boxes-of-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
    'board-ask-answer': (_msg, requestId, message) => ({ type: 'board-ask-answer-result', requestId, ok: false, error: message }),
    'branch-spawn': (msg, requestId, message) => ({ type: 'branch-spawn-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
    'studio-main-ensure': (msg, requestId, message) => ({ type: 'studio-main-ensure-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
    'codemap-folder-toggle': (msg, requestId, message) => ({ type: 'codemap-folder-toggle-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, genericErrorTypes: [] };
}

export { createBoardSessionHandlers };
