import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import type { SessionMapBoxes } from '../../../shared/contracts/control/board-session-messages.ts';
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
const NO_MAP_BOXES: SessionMapBoxes = { boxIdByPath: {}, fallbackBoxId: null, changedBoxIds: [] };

const WORKSPACE_MAIN_TEXT = 'A workspace of several repos does not open in Studio; open one of its repos.';

type MainAgentOutcome = { ok: true; mainId: string } | { ok: false; error: string };

function createBoardSessionHandlers(context: ControlContext, deps: ControlHandlerDeps, branches: BranchWiring): ControlHandlerGroup {
  const { findSession, createProjectSession, findConfiguredProject, sessions, replyApplied } = context;
  const { codemap = null, studioRepos = null, boardAsks = null, director = null, studioGuide = null } = deps;

  function ensureMainAgent(anchor: Session): MainAgentOutcome {
    if (findConfiguredProject(anchor.id)?.repos) return { ok: false, error: WORKSPACE_MAIN_TEXT };
    if (!anchor.isStudioMain) void codemap?.openArea(anchor.path);
    const ensured = ensureOrchestrator(sessions.values(), createProjectSession, { agent: anchor.agentId, dangerouslySkipPermissions: anchor.dangerouslySkipPermissions, saneYolo: anchor.saneYolo, accountId: anchor.accountId });
    if (!ensured.ok) return ensured;
    return { ok: true, mainId: ensured.orchestratorId };
  }

  async function sessionMapBoxesOf(watchedId: string, paths: readonly string[]): Promise<SessionMapBoxes> {
    const watched = sessions.get(watchedId);
    if (!codemap || !watched) return NO_MAP_BOXES;
    if (watched.isStudioMain) return { ...NO_MAP_BOXES, boxIdByPath: (await codemap.boxesOfStudioPaths(watched.id, paths)).boxIdByPath };
    const boxes = await codemap.boxesOfSession(watched.path, watched.id, paths);
    return boxes.ok ? { boxIdByPath: boxes.boxIdByPath, fallbackBoxId: boxes.fallbackBoxId, changedBoxIds: boxes.changedBoxIds } : NO_MAP_BOXES;
  }

  const handlers = {
    'codemap-boxes-of': async (message: ClientMessageOf<'codemap-boxes-of'>, ws: ControlSocket) => {
      const reply = { type: 'codemap-boxes-of-response', id: message.id, requestId: message.requestId ?? null };
      const session = findSession(message);
      if (!session) return ws.send(JSON.stringify({ ...reply, ok: false, error: SESSION_GONE_TEXT }));
      if (!codemap) return ws.send(JSON.stringify({ ...reply, ok: false, error: CODE_MAP_OFF_TEXT }));
      try {
        const studio = await codemap.studioAreas();
        const boxesBySessionId = Object.fromEntries(await Promise.all(Object.entries(message.pathsBySessionId).map(async ([watchedId, paths]) => [watchedId, await sessionMapBoxesOf(watchedId, paths)] as const)));
        const boxChoices = studio.areas.flatMap((area) => area.boxChoices.map((choice) => ({ ...choice, repoName: area.repoName })));
        const listedRepos = (await studioRepos?.repos()) ?? [];
        const branchAgentIdOf = (repoKey: string) => listedRepos.find((listed) => listed.repoKey === repoKey)?.branchAgent?.agentId ?? null;
        const areas = studio.areas.map(({ repoKey, repoName, repoDir, isFolded, anchorBoxId, mapError }) => ({ repoKey, repoName, repoDir, isFolded, anchorBoxId, mapError, branchAgentId: branchAgentIdOf(repoKey) }));
        const firstUnmapped = studio.areas.find((area) => area.mapError !== null);
        if (firstUnmapped && studio.areas.every((area) => area.mapError !== null)) return ws.send(JSON.stringify({ ...reply, ok: false, boardId: studio.boardId, error: firstUnmapped.mapError, isMapFailed: studio.areas.some((area) => area.isMapFailed) }));
        const placedBoxIds = [...areas.map((area) => area.anchorBoxId), ...Object.keys(boxesBySessionId).flatMap((watchedId) => sessions.get(watchedId)?.parent?.box?.id ?? []), ...Object.values(boxesBySessionId).flatMap((boxes) => [...Object.values(boxes.boxIdByPath), ...boxes.changedBoxIds, ...(boxes.fallbackBoxId === null ? [] : [boxes.fallbackBoxId])])];
        const boxRectById = studio.boardId ? await codemap.boxRectsOf(studio.boardId, [...new Set(placedBoxIds)]) : {};
        ws.send(JSON.stringify({ ...reply, ok: true, boardId: studio.boardId, boxesBySessionId, areas, boxChoices, boxRectById }));
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
      if (!boardAsks) {
        replyApplied(ws, message, 'board-ask-answer-result', { ok: false, error: BOARD_ASKS_OFF_TEXT });
        return;
      }
      try {
        const outcome = await boardAsks.answer(message.boardId, message.askBoxId, message.answer);
        replyApplied(ws, message, 'board-ask-answer-result', outcome);
      } catch (error) {
        replyApplied(ws, message, 'board-ask-answer-result', { ok: false, error: `The answer was not sent: ${errorMessage(error)}` });
      }
    },
    'branch-spawn': async (message: ClientMessageOf<'branch-spawn'>, ws: ControlSocket) => {
      try {
        const outcome = await branches.spawn({ orchestratorId: message.id, place: { boxId: message.aboutBoxId }, prompt: message.prompt });
        if (!outcome.ok) {
          replyApplied(ws, message, 'branch-spawn-result', { id: message.id, ok: false, error: outcome.error });
          return;
        }
        replyApplied(ws, message, 'branch-spawn-result', { id: message.id, ok: true, branchId: outcome.sessionId });
      } catch (error) {
        replyApplied(ws, message, 'branch-spawn-result', { id: message.id, ok: false, error: `The branch did not start: ${errorMessage(error)}` });
      }
    },
    'studio-main-ensure': (message: ClientMessageOf<'studio-main-ensure'>, ws: ControlSocket) => {
      const anchor = findSession(message);
      if (!anchor) {
        replyApplied(ws, message, 'studio-main-ensure-result', { id: message.id, ok: false, error: SESSION_GONE_TEXT });
        return;
      }
      const outcome = ensureMainAgent(anchor);
      replyApplied(ws, message, 'studio-main-ensure-result', { id: message.id, ...outcome });
    },
    'codemap-folder-set': async (message: ClientMessageOf<'codemap-folder-set'>, ws: ControlSocket) => {
      const session = findSession(message);
      if (!session) {
        replyApplied(ws, message, 'codemap-folder-set-result', { id: message.id, ok: false, error: SESSION_GONE_TEXT });
        return;
      }
      if (!codemap) {
        replyApplied(ws, message, 'codemap-folder-set-result', { id: message.id, ok: false, error: CODE_MAP_OFF_TEXT });
        return;
      }
      try {
        const boxRepo = await codemap.repoOfBox(message.boxId);
        if (!boxRepo) {
          replyApplied(ws, message, 'codemap-folder-set-result', { id: message.id, ok: false, error: 'That box is not on the code map of a Studio repo any more.' });
          return;
        }
        replyApplied(ws, message, 'codemap-folder-set-result', { id: message.id, ...await codemap.setFolderOpen(boxRepo.repoDir, message.boxId, message.isOpen) });
      } catch (error) {
        replyApplied(ws, message, 'codemap-folder-set-result', { id: message.id, ok: false, error: `The folder did not open: ${errorMessage(error)}` });
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
      const main = findSession(message);
      if (!main) {
        replyApplied(ws, message, 'studio-progress-ask-result', { id: message.id, ok: false, error: SESSION_GONE_TEXT });
        return;
      }
      if (!director || !main.isStudioMain) {
        replyApplied(ws, message, 'studio-progress-ask-result', { id: message.id, ok: true, isAnswered: false });
        return;
      }
      try {
        const branches = [...sessions.values()].filter((candidate) => branchParentIdOf(candidate.parent) === main.id && !candidate._destroyed);
        const agents = [main, ...branches].map((agent) => ({ sessionId: agent.id, name: agent.name }));
        const boardIdOf = async () => (codemap ? codemap.mapBoardIdOfRepo(main.path) : null);
        const isAnswered = await director.answerProgress({ mainSessionId: main.id, agents, question: message.text, boardIdOf });
        replyApplied(ws, message, 'studio-progress-ask-result', { id: message.id, ok: true, isAnswered });
      } catch (error) {
        replyApplied(ws, message, 'studio-progress-ask-result', { id: message.id, ok: true, isAnswered: false, error: errorMessage(error) });
      }
    },
    'studio-guide': async (message: ClientMessageOf<'studio-guide'>, ws: ControlSocket) => {
      if (!studioGuide) {
        replyApplied(ws, message, 'studio-guide-result', { ok: true, doneSteps: [] });
        return;
      }
      try {
        const doneSteps = message.step === null ? await studioGuide.doneSteps() : await studioGuide.markDone(message.step);
        replyApplied(ws, message, 'studio-guide-result', { ok: true, doneSteps });
      } catch (error) {
        replyApplied(ws, message, 'studio-guide-result', { ok: false, error: `The Studio guide was not saved: ${errorMessage(error)}` });
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
