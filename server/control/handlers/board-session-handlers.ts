import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { branchParentIdOf } from '../../../shared/parent-link.ts';
import { errorMessage } from '../../../shared/text.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import type { ControlContext } from '../control-context.ts';
import { SESSION_GONE_TEXT } from '../control-context.ts';
import type { BranchWiring } from '../../board-session/branch-wiring.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';
import type { Session } from '../../../session/sessions.ts';
import { ensureOrchestrator } from '../../board-session/studio-main.ts';

const CODE_MAP_OFF_TEXT = 'The code map is not running';
const BOARD_ASKS_OFF_TEXT = 'Board questions are not running';

const WORKSPACE_MAIN_TEXT = 'A workspace of several repos does not open in Studio; open one of its repos.';

type MainAgentOutcome = { ok: true; mainId: string } | { ok: false; error: string };

function createBoardSessionHandlers(context: ControlContext, deps: ControlHandlerDeps, branches: BranchWiring): ControlHandlerGroup {
  const { findSession, createProjectSession, findConfiguredProject, sessions } = context;
  const { codemap = null, boardAsks = null, director = null, studioGuide = null } = deps;

  function ensureMainAgent(anchor: Session): MainAgentOutcome {
    if (findConfiguredProject(anchor.id)?.repos) return { ok: false, error: WORKSPACE_MAIN_TEXT };
    if (!anchor.isStudioMain) codemap?.openArea(anchor.path);
    const ensured = ensureOrchestrator(sessions.values(), createProjectSession, { agent: anchor.agentId, dangerouslySkipPermissions: anchor.dangerouslySkipPermissions, saneYolo: anchor.saneYolo, accountId: anchor.accountId });
    if (!ensured.ok) return ensured;
    return { ok: true, mainId: ensured.orchestratorId };
  }

  const handlers = {
    'codemap-boxes-of': async (message: ClientMessageOf<'codemap-boxes-of'>, ws: ControlSocket) => {
      const reply = { type: 'codemap-boxes-of-response', id: message.id, requestId: message.requestId ?? null };
      const session = findSession(message);
      if (!session) return ws.send(JSON.stringify({ ...reply, ok: false, error: SESSION_GONE_TEXT }));
      if (!codemap) return ws.send(JSON.stringify({ ...reply, ok: false, error: CODE_MAP_OFF_TEXT }));
      try {
        const boxes = await codemap.boxesOfSession(session.path, session.id, message.paths);
        const boxRectById = boxes.ok && boxes.boardId ? await codemap.boxRectsOf(boxes.boardId, [...Object.values(boxes.boxIdByPath), ...boxes.changedBoxIds, boxes.fallbackBoxId]) : {};
        ws.send(JSON.stringify({ ...reply, ...boxes, boxRectById }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `Code map read failed: ${errorMessage(error)}` }));
      }
    },
    'board-asks-of': async (message: ClientMessageOf<'board-asks-of'>, ws: ControlSocket) => {
      const reply = { type: 'board-asks-of-result', requestId: message.requestId ?? null };
      if (!boardAsks) return ws.send(JSON.stringify({ ...reply, ok: false, error: BOARD_ASKS_OFF_TEXT }));
      try {
        ws.send(JSON.stringify({ ...reply, ok: true, asks: await boardAsks.openAsksOf(message.boardId) }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `The board questions could not be read: ${errorMessage(error)}` }));
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
        const outcome = await branches.spawn({ orchestratorId: message.id, place: { boxId: message.aboutBoxId }, prompt: message.prompt });
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
    'codemap-folder-set': async (message: ClientMessageOf<'codemap-folder-set'>, ws: ControlSocket) => {
      const reply = { type: 'codemap-folder-set-result', id: message.id, requestId: message.requestId ?? null };
      const session = findSession(message);
      if (!session) return ws.send(JSON.stringify({ ...reply, ok: false, error: SESSION_GONE_TEXT }));
      if (!codemap) return ws.send(JSON.stringify({ ...reply, ok: false, error: CODE_MAP_OFF_TEXT }));
      try {
        ws.send(JSON.stringify({ ...reply, ...await codemap.setFolderOpen(session.path, message.boxId, message.isOpen) }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `The folder did not open: ${errorMessage(error)}` }));
      }
    },
    'director-digests': async (message: ClientMessageOf<'director-digests'>, ws: ControlSocket) => {
      const reply = { type: 'director-digests-result', id: message.id, requestId: message.requestId ?? null };
      const session = findSession(message);
      if (!session) return ws.send(JSON.stringify({ ...reply, ok: false, error: SESSION_GONE_TEXT }));
      if (!director) return ws.send(JSON.stringify({ ...reply, ok: true, verdictByKey: {} }));
      try {
        const [verdictByKey, progressAnswers] = await Promise.all([director.verdictsOf(message.sessionIds), director.progressAnswersFor(message.sessionIds)]);
        ws.send(JSON.stringify({ ...reply, ok: true, verdictByKey, progressAnswers }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `Director digests read failed: ${errorMessage(error)}` }));
      }
    },
    'studio-progress-ask': async (message: ClientMessageOf<'studio-progress-ask'>, ws: ControlSocket) => {
      const reply = { type: 'studio-progress-ask-result', id: message.id, requestId: message.requestId ?? null };
      const main = findSession(message);
      if (!main) return ws.send(JSON.stringify({ ...reply, ok: false, error: SESSION_GONE_TEXT }));
      if (!director || !main.isStudioMain) return ws.send(JSON.stringify({ ...reply, ok: true, isAnswered: false }));
      try {
        const branches = [...sessions.values()].filter((candidate) => branchParentIdOf(candidate.parent) === main.id && !candidate._destroyed);
        const agents = [main, ...branches].map((agent) => ({ sessionId: agent.id, name: agent.name }));
        const boardIdOf = async () => (codemap ? codemap.mapBoardIdOfRepo(main.path) : null);
        const isAnswered = await director.answerProgress({ mainSessionId: main.id, agents, question: message.text, boardIdOf });
        ws.send(JSON.stringify({ ...reply, ok: true, isAnswered }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: true, isAnswered: false, error: errorMessage(error) }));
      }
    },
    'studio-guide': async (message: ClientMessageOf<'studio-guide'>, ws: ControlSocket) => {
      const reply = { type: 'studio-guide-result', requestId: message.requestId ?? null };
      if (!studioGuide) return ws.send(JSON.stringify({ ...reply, ok: true, doneSteps: [] }));
      try {
        const doneSteps = message.step === null ? await studioGuide.doneSteps() : await studioGuide.markDone(message.step);
        ws.send(JSON.stringify({ ...reply, ok: true, doneSteps }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `The Studio guide was not saved: ${errorMessage(error)}` }));
      }
    },
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'codemap-boxes-of': (msg, requestId, message) => ({ type: 'codemap-boxes-of-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
    'board-asks-of': (_msg, requestId, message) => ({ type: 'board-asks-of-result', requestId, ok: false, error: message }),
    'board-ask-answer': (_msg, requestId, message) => ({ type: 'board-ask-answer-result', requestId, ok: false, error: message }),
    'branch-spawn': (msg, requestId, message) => ({ type: 'branch-spawn-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
    'studio-main-ensure': (msg, requestId, message) => ({ type: 'studio-main-ensure-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
    'codemap-folder-set': (msg, requestId, message) => ({ type: 'codemap-folder-set-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
    'director-digests': (msg, requestId, message) => ({ type: 'director-digests-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
    'studio-progress-ask': (msg, requestId, message) => ({ type: 'studio-progress-ask-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
    'studio-guide': (_msg, requestId, message) => ({ type: 'studio-guide-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, genericErrorTypes: [] };
}

export { createBoardSessionHandlers };
