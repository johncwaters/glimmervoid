import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { SessionMapBoxes, StudioMapArea } from '#shared/contracts/control/board-session-messages.ts';
import type { SessionProgressAnswer } from '#shared/contracts/director-digests.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import type { BoxChoice } from '../board-session/branch-core.ts';

export interface DirectorVerdict {
  chatLine: string | null;
  digest: string | null;
  fitsTask: boolean | null;
  misfit: string | null;
}

export interface StudioCollectionState {
  shownSessionId: string | null;
  pendingMainId: string | null;
  boardId: string | null;
  areas: StudioMapArea[];
  areaByRepoKey: Record<string, StudioMapArea>;
  boxesBySessionId: Record<string, SessionMapBoxes>;
  changedBoxIds: string[];
  changingSessionIdsByBoxId: Record<string, string[]>;
  boxRectById: Record<string, Rect>;
  boxChoices: BoxChoice[];
  boxChoiceById: Record<string, BoxChoice>;
  boxesAnsweredSessionId: string | null;
  verdictByKey: Record<string, DirectorVerdict>;
  progressAnswers: SessionProgressAnswer[];
  digestRevisionBySessionId: Record<string, number>;
}

export interface StudioApplyContext {
  watchedSessionIds?: ReadonlySet<string>;
  liveSessionIds?: ReadonlySet<string>;
  confirmedFolderBoxId?: string;
  confirmedRepoBranchAgent?: { repoDir: string; agentId: string };
}

export const INITIAL_STUDIO_STATE: StudioCollectionState = {
  shownSessionId: null,
  pendingMainId: null,
  boardId: null,
  areas: [],
  areaByRepoKey: {},
  boxesBySessionId: {},
  changedBoxIds: [],
  changingSessionIdsByBoxId: {},
  boxRectById: {},
  boxChoices: [],
  boxChoiceById: {},
  boxesAnsweredSessionId: null,
  verdictByKey: {},
  progressAnswers: [],
  digestRevisionBySessionId: {},
};

function rebuildChangedBoxIndex(
  boxesBySessionId: Readonly<Record<string, SessionMapBoxes>>,
): { changedBoxIds: string[]; changingSessionIdsByBoxId: Record<string, string[]> } {
  const changingSessionIdsByBoxId: Record<string, string[]> = {};
  const changedBoxIdSet = new Set<string>();
  for (const [sessionId, boxes] of Object.entries(boxesBySessionId)) {
    for (const boxId of boxes.changedBoxIds) {
      changedBoxIdSet.add(boxId);
      const existing = changingSessionIdsByBoxId[boxId];
      if (existing) {
        if (!existing.includes(sessionId)) existing.push(sessionId);
        continue;
      }
      changingSessionIdsByBoxId[boxId] = [sessionId];
    }
  }
  return {
    changedBoxIds: [...changedBoxIdSet],
    changingSessionIdsByBoxId,
  };
}

function indexAreasByRepoKey(areas: readonly StudioMapArea[]): Record<string, StudioMapArea> {
  const indexed: Record<string, StudioMapArea> = {};
  for (const area of areas) {
    indexed[area.repoKey] = area;
  }
  return indexed;
}

function indexBoxChoicesById(boxChoices: readonly BoxChoice[]): Record<string, BoxChoice> {
  const indexed: Record<string, BoxChoice> = {};
  for (const choice of boxChoices) {
    if (!Object.hasOwn(indexed, choice.boxId)) indexed[choice.boxId] = choice;
  }
  return indexed;
}

function clearSessionScopedFields(draft: StudioCollectionState): void {
  draft.boardId = null;
  draft.areas = [];
  draft.areaByRepoKey = {};
  draft.boxesBySessionId = {};
  draft.changedBoxIds = [];
  draft.changingSessionIdsByBoxId = {};
  draft.boxRectById = {};
  draft.boxChoices = [];
  draft.boxChoiceById = {};
  draft.boxesAnsweredSessionId = null;
  draft.verdictByKey = {};
  draft.progressAnswers = [];
}

function switchShownSession(draft: StudioCollectionState, nextSessionId: string | null): void {
  if (draft.shownSessionId === nextSessionId) return;
  draft.shownSessionId = nextSessionId;
  clearSessionScopedFields(draft);
}

function pruneBoxesToSessions(draft: StudioCollectionState, liveSessionIds: ReadonlySet<string>): void {
  let didRemove = false;
  for (const sessionId of Object.keys(draft.boxesBySessionId)) {
    if (liveSessionIds.has(sessionId)) continue;
    delete draft.boxesBySessionId[sessionId];
    didRemove = true;
  }
  if (!didRemove) return;
  const rebuilt = rebuildChangedBoxIndex(draft.boxesBySessionId);
  draft.changedBoxIds = rebuilt.changedBoxIds;
  draft.changingSessionIdsByBoxId = rebuilt.changingSessionIdsByBoxId;
}

function pruneDigestRevisionsToSessions(draft: StudioCollectionState, liveSessionIds: ReadonlySet<string>): void {
  for (const sessionId of Object.keys(draft.digestRevisionBySessionId)) {
    if (!liveSessionIds.has(sessionId)) delete draft.digestRevisionBySessionId[sessionId];
  }
}

function matchesAreaFoldBoxId(anchorBoxId: string, boxId: string): boolean {
  if (anchorBoxId === boxId) return true;
  const cardMarkerIndex = anchorBoxId.indexOf('-area-card-');
  if (cardMarkerIndex === -1) return false;
  const areaFramePrefix = `${anchorBoxId.slice(0, cardMarkerIndex)}-area-`;
  return boxId.startsWith(areaFramePrefix) && !boxId.startsWith(`${areaFramePrefix}card-`);
}

function applyStudioBoxesReply(
  draft: StudioCollectionState,
  reply: ServerMessageOf<'codemap-boxes-of-response'>,
  watchedSessionIds?: ReadonlySet<string>,
): void {
  if (draft.shownSessionId !== reply.id) return;
  draft.boxesAnsweredSessionId = reply.id;
  if (!reply.ok || reply.boardId === null || reply.areas.length === 0) return;

  draft.boardId = reply.boardId;
  draft.areas = reply.areas.map((area) => ({ ...area }));
  draft.areaByRepoKey = indexAreasByRepoKey(draft.areas);

  const mergedBoxes: Record<string, SessionMapBoxes> = { ...draft.boxesBySessionId };
  for (const [answeredId, boxes] of Object.entries(reply.boxesBySessionId)) {
    mergedBoxes[answeredId] = {
      fallbackBoxId: boxes.fallbackBoxId,
      changedBoxIds: [...boxes.changedBoxIds],
      boxIdByPath: {
        ...draft.boxesBySessionId[answeredId]?.boxIdByPath,
        ...boxes.boxIdByPath,
      },
    };
  }
  if (watchedSessionIds) {
    for (const sessionId of Object.keys(mergedBoxes)) {
      if (!watchedSessionIds.has(sessionId)) delete mergedBoxes[sessionId];
    }
  }
  draft.boxesBySessionId = mergedBoxes;
  const rebuilt = rebuildChangedBoxIndex(mergedBoxes);
  draft.changedBoxIds = rebuilt.changedBoxIds;
  draft.changingSessionIdsByBoxId = rebuilt.changingSessionIdsByBoxId;
  draft.boxRectById = { ...draft.boxRectById, ...reply.boxRectById };
  draft.boxChoices = reply.boxChoices.map((choice) => ({ ...choice }));
  draft.boxChoiceById = indexBoxChoicesById(draft.boxChoices);
}

function applyStudioDigestsReply(
  draft: StudioCollectionState,
  reply: ServerMessageOf<'director-digests-result'>,
): void {
  if (!reply.ok || draft.shownSessionId !== reply.id) return;
  draft.verdictByKey = { ...draft.verdictByKey, ...reply.verdictByKey };
  draft.progressAnswers = reply.progressAnswers.map((answer) => ({ ...answer }));
}

function applyTargetMainSession(
  draft: StudioCollectionState,
  targetMainId: string,
  liveSessionIds?: ReadonlySet<string>,
): void {
  if (draft.shownSessionId === targetMainId) {
    draft.pendingMainId = null;
    return;
  }
  if (liveSessionIds?.has(targetMainId)) {
    draft.pendingMainId = null;
    switchShownSession(draft, targetMainId);
    return;
  }
  draft.pendingMainId = targetMainId;
}

export function applyStudioServerMessage(
  draft: StudioCollectionState,
  message: ServerMessage,
  context: StudioApplyContext = {},
): void {
  switch (message.type) {
    case 'director-digest-kept': {
      draft.digestRevisionBySessionId[message.id] = (draft.digestRevisionBySessionId[message.id] ?? 0) + 1;
      return;
    }
    case 'codemap-boxes-of-response': {
      applyStudioBoxesReply(draft, message, context.watchedSessionIds);
      return;
    }
    case 'director-digests-result': {
      applyStudioDigestsReply(draft, message);
      return;
    }
    case 'codemap-folder-set-result': {
      if (message.ok && context.confirmedFolderBoxId) {
        applyOptimisticFolderSet(draft, context.confirmedFolderBoxId, message.isOpen);
      }
      return;
    }
    case 'studio-main-ensure-result': {
      if (message.ok && message.mainId !== null) {
        applyTargetMainSession(draft, message.mainId, context.liveSessionIds);
      }
      return;
    }
    case 'add-session-result': {
      if (!message.ok) return;
      if (message.sessionId) {
        applyTargetMainSession(draft, message.sessionId, context.liveSessionIds);
      }
      if (context.confirmedRepoBranchAgent) {
        applyOptimisticRepoBranchAgent(
          draft,
          context.confirmedRepoBranchAgent.repoDir,
          context.confirmedRepoBranchAgent.agentId,
        );
      }
      return;
    }
    case 'snapshot': {
      const liveIds = new Set(message.sessions.map((row) => row.id));
      pruneDigestRevisionsToSessions(draft, liveIds);
      if (draft.pendingMainId !== null && liveIds.has(draft.pendingMainId)) {
        const resolvedId = draft.pendingMainId;
        draft.pendingMainId = null;
        switchShownSession(draft, resolvedId);
        pruneBoxesToSessions(draft, liveIds);
        return;
      }
      const mainRow = message.sessions.find((row) => row.isStudioMain === true);
      switchShownSession(draft, mainRow?.id ?? null);
      pruneBoxesToSessions(draft, liveIds);
      return;
    }
    case 'session-added':
    case 'session-modified': {
      if (draft.pendingMainId === message.id) {
        draft.pendingMainId = null;
        switchShownSession(draft, message.id);
        return;
      }
      if (message.isStudioMain === true && draft.shownSessionId === null) {
        switchShownSession(draft, message.id);
      }
      return;
    }
    case 'session-removed': {
      delete draft.digestRevisionBySessionId[message.id];
      if (draft.pendingMainId === message.id) {
        draft.pendingMainId = null;
      }
      if (draft.shownSessionId === message.id) {
        switchShownSession(draft, null);
        return;
      }
      if (Object.hasOwn(draft.boxesBySessionId, message.id)) {
        delete draft.boxesBySessionId[message.id];
        const rebuilt = rebuildChangedBoxIndex(draft.boxesBySessionId);
        draft.changedBoxIds = rebuilt.changedBoxIds;
        draft.changingSessionIdsByBoxId = rebuilt.changingSessionIdsByBoxId;
      }
      return;
    }
    default:
      return;
  }
}

export function applyOptimisticFolderSet(
  draft: StudioCollectionState,
  boxId: string,
  isOpen: boolean,
): void {
  const area = draft.areas.find((candidate) => matchesAreaFoldBoxId(candidate.anchorBoxId, boxId));
  if (!area) return;
  area.isFolded = !isOpen;
  draft.areaByRepoKey[area.repoKey] = area;
}

export function applyOptimisticRepoBranchAgent(
  draft: StudioCollectionState,
  repoDir: string,
  agentId: string,
): void {
  const area = draft.areas.find((candidate) => candidate.repoDir === repoDir);
  if (!area) return;
  area.branchAgentId = agentId;
  draft.areaByRepoKey[area.repoKey] = area;
}
