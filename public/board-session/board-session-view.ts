import './board-session.css';
import { createEffect, createRoot, runWithOwner } from 'solid-js';
import { branchParentIdOf } from '#shared/parent-link.ts';
import { chatPhaseOf, shownChatPhaseOf } from '../chat/chat-activity-core.ts';
import type { ActivityBeat, ChatPhase } from '../chat/chat-activity-core.ts';
import { createChatFeed } from '../chat/chat-feed.ts';
import type { ChatFeed } from '../chat/chat-feed.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { sessionWorkingDirectoryOf } from '../session-card/card-model.ts';
import { sessionName, sessionUIs } from '../session-card/card-registry.ts';
import { loadResumeDialog } from '../session-card/deferred-loads.ts';
import { isModalOpen } from '../ui/modal-state.ts';
import { createPressable } from '../ui/pressable.ts';
import type { ViewModule } from '../view-registry-core.ts';
import type { Camera } from '../whiteboard/board-gl-renderer.ts';
import { boundsOfHostBox, glideHostTo, leaveBoardHost, mountBoardHost, paintBoard, placeBoardTitle, reopenSelectedBoard, showBoardBeside } from '../whiteboard/boards-view.ts';
import type { BoardHostGuest, GuestFirstView } from '../whiteboard/boards-view.ts';
import { boardSummariesOf, onBoardListChanged } from '../whiteboard/board-store.ts';
import { dismissAgentChange, markAgentChangeShown, onAgentChange, ringAgentChange, tiledBoardOf } from '../whiteboard/board-tile-store.ts';
import type { AgentChip } from '../whiteboard/board-tile-store.ts';
import { SHOWN_BOX_ID_RE } from '#shared/whiteboard-constants.ts';
import { onBoardSessionStatusChanged, onBoardSessionTraceChanged } from './board-session-signals.ts';
import { firstViewCamera, readableFloorScale, viewMovedToShow } from './board-session-core.ts';
import { unionOf } from '#shared/whiteboard-route-core.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import type { TraceRecord } from '#shared/contracts/trace.ts';
import { createDock } from './dock.ts';
import { NO_PRESENCE, foldPresence, presencePathsOf } from './presence-core.ts';
import type { Presence } from './presence-core.ts';
import { asksOfSessions, createAskCards } from './ask-card.ts';
import { createChangesPeek, createDiffPanel } from './studio-diff-panel.ts';
import { createStudioGuide } from './studio-guide.ts';
import type { StudioGuide, StudioMapState } from './studio-guide.ts';
import type { ChangesPeek, DiffPanel } from './studio-diff-panel.ts';
import { onReviewChange, reloadReview, reviewOf } from '../review/review-store.ts';
import type { AskCards } from './ask-card.ts';
import { GLOW_TIER_RANK, createPresenceLayer, shownBoundsOfBoard, shownMapBoundsOfBoard } from './presence-layer.ts';
import type { GlowTier, PresenceLayer } from './presence-layer.ts';
import { createAgentCards, isBusyPhase } from './agent-card.ts';
import type { AgentCardModel, AgentCards } from './agent-card.ts';
import { openSwitchAccountDialog } from '../session-card/card-account.ts';
import { sessionRailFieldsOf } from '../chat/chat-page.ts';
import { chatOutboxEntriesOf } from '../state/collections/chat-outbox.ts';
import { createAgentWaits } from './agent-waits.ts';
import type { AgentWaits } from './agent-waits.ts';
import { opensOperatorTurn } from '#shared/trace-turn.ts';
import type { Dock, DockBranch } from './dock.ts';
import { branchSessionIdsOf, placeTitleOf } from './branch-core.ts';
import { isStudioSession } from './studio-target.ts';
import { openStudioRepoDialog } from '../session-actions.ts';
import { CODEMAP_BOXES_MAX_PATHS, DIRECTOR_DIGEST_SESSIONS_MAX, isCodeMapBoardTitle } from '#shared/contracts/control/board-session-messages.ts';
import type { OpenBoardAsk } from '#shared/contracts/control/board-session-messages.ts';
import { directorDigestKeyOf } from '#shared/director-digest-key.ts';
import { standingMisfitOf } from '#shared/director-fit.ts';
import { createLineIcon } from '../svg-dom.ts';
import sessionsCollection from '../state/collections/sessions.ts';
import studioCollection, { applyStudioReply, onStudioServerMessage } from '../state/collections/studio.ts';
import { runCodemapFolderSet } from '../state/actions/codemap-folder-set.ts';
import { runStudioMainEnsure } from '../state/actions/studio-main-ensure.ts';
import removeSessionAction from '../state/actions/remove-session.ts';

const BOXES_TIMEOUT_MS = 10000;
const TRACE_PAGE_TIMEOUT_MS = 10000;
const TITLE_SIZE_FALLBACK_PX = 16;
const PEEK_OVERLAP_PX = 4;
const NO_SESSION_TEXT = 'Open a repo from the menu to see its code map.';
const EVERY_REPO_TEXT = 'your repos';
const OPEN_REPO_TEXT = 'Open a repo';
const NO_MAP_TEXT = 'This session has no code map yet.';
const NO_MAIN_TEXT = 'The Orchestrator did not start.';
const ORCHESTRATOR_TEXT = 'Orchestrator';
const CARET_ICON_PATH = 'M4 6l4 4 4-4';
const RESTART_ORCHESTRATOR_TEXT = 'Restart Orchestrator';
const ACCOUNT_TEXT = 'Model and account';
const NO_REPO_TEXT = 'No repo';
const TURN_OPENINGS_KEPT = 20;

interface SessionWatch {
  feed: ChatFeed;
  presence: Presence;
  lastBeat: ActivityBeat | null;
  turnOpenedAts: number[];
  waits: AgentWaits;
}

interface ViewParts {
  root: HTMLElement;
  menu: HTMLElement;
  menuOpener: HTMLButtonElement | null;
  topLeft: HTMLElement;
  noRepoChip: HTMLButtonElement;
  notice: HTMLElement;
  dockSlot: HTMLElement;
  presenceLayer: PresenceLayer;
  askCards: AskCards;
  changesPeek: ChangesPeek;
  diffPanel: DiffPanel;
  guide: StudioGuide;
  agentCards: AgentCards;
  guest: BoardHostGuest;
}

let parts: ViewParts | null = null;
let isActive = false;
let mountedDockSessionId: string | null = null;
let ensuredAnchorId: string | null = null;
let answeredPathKeys = new Set<string>();
let peekedBoxId: string | null = null;
let fetchedAsks: { boardId: string; asks: readonly OpenBoardAsk[] } | null = null;
let requestedAsksKey: string | null = null;
const OPEN_ASKS_TIMEOUT_MS = 10000;
let unseenShownCards: { boardId: string; area: Rect } | null = null;
let askGlide: { askBoxIds: ReadonlySet<string>; returnArea: Rect; shownArea: Rect } | null = null;
const ASK_VIEW_TOP_MARGIN_PX = 64;
const ASK_VIEW_SIDE_MARGIN_PX = 24;
let hostCamera: Camera = { x: 0, y: 0, scale: 1 };
let shownFixedAreas: readonly Rect[] = [];
let dock: Dock | null = null;
let boxesRequestSerial = 0;
type MissingMap = { boardId: string | null; boardVersion: number | null; knownBoardIds: ReadonlySet<string> };

let missingMap: MissingMap | null = null;
let digestsRequestSerial = 0;
let watchBySessionId = new Map<string, SessionWatch>();
const openedBranchIds = new Set<string>();

function isBranchOfShownSession(sessionId: string): boolean {
  const shownId = studioCollection.state.shownSessionId;
  if (shownId === null) return false;
  const sessionRecord = sessionsCollection.state.byId[sessionId];
  return branchParentIdOf(sessionRecord?.parent ?? sessionUIs.get(sessionId)?.parent ?? null) === shownId;
}

function studioSessionIds(): string[] {
  return [...sessionUIs].flatMap(([id, ui]) => isStudioSession(ui) ? [id] : []);
}

function pathKeyOf(sessionId: string, sessionPath: string): string {
  return `${sessionId}\n${sessionPath}`;
}

function phaseOfSession(sessionId: string): ChatPhase {
  const ui = sessionUIs.get(sessionId);
  return shownChatPhaseOf(chatPhaseOf(ui?.currentState), false, ui?.awaitingBackgroundTasks === true);
}

function changedFilesOf(sessionId: string) {
  return reviewOf(sessionId)?.files ?? [];
}

function changedFilesAtBox(boxId: string) {
  return [...watchBySessionId.keys()].flatMap((sessionId) => changedFilesOf(sessionId).filter((file) => boxIdOfSessionPath(sessionId, file.path) === boxId));
}

function watchedPathsOf(sessionId: string, watch: SessionWatch): string[] {
  return [...new Set([...presencePathsOf(watch.presence), ...changedFilesOf(sessionId).map((file) => file.path)])];
}

function unaskedPathsBySessionId(): Record<string, string[]> {
  return Object.fromEntries([...watchBySessionId].map(([sessionId, watch]) => [sessionId, watchedPathsOf(sessionId, watch).filter((sessionPath) => isUnaskedPath(sessionId, sessionPath)).slice(0, CODEMAP_BOXES_MAX_PATHS)]));
}

function hasUnaskedPaths(): boolean {
  return Object.values(unaskedPathsBySessionId()).some((sessionPaths) => sessionPaths.length > 0);
}

function boxIdAtPointer(event: PointerEvent, overlayHost: HTMLElement): string | null {
  const hostRect = overlayHost.getBoundingClientRect();
  const boardX = (event.clientX - hostRect.left) / hostCamera.scale + hostCamera.x;
  const boardY = (event.clientY - hostRect.top) / hostCamera.scale + hostCamera.y;
  return studioCollection.state.changedBoxIds.find((boxId) => {
    const bounds = boundsOfHostBox(boxId);
    return bounds !== null && boardX >= bounds.x && boardX <= bounds.x + bounds.width && boardY >= bounds.y && boardY <= bounds.y + bounds.height;
  }) ?? null;
}

function peekSpotOf(bounds: Rect): { left: number; top: number } {
  return { left: (bounds.x + bounds.width - hostCamera.x) * hostCamera.scale - PEEK_OVERLAP_PX, top: (bounds.y - hostCamera.y) * hostCamera.scale };
}

function paintChangesPeek(): void {
  if (!parts) return;
  const bounds = peekedBoxId === null ? null : boundsOfHostBox(peekedBoxId);
  if (bounds === null) {
    parts.changesPeek.hide();
    return;
  }
  const files = changedFilesAtBox(peekedBoxId ?? '');
  const { left, top } = peekSpotOf(bounds);
  parts.changesPeek.show(files, left, top);
}

function moveOverlaysWithCamera(): void {
  if (!parts) return;
  parts.agentCards.place(hostCamera);
  parts.askCards.place(hostCamera);
  const peekBounds = peekedBoxId === null ? null : boundsOfHostBox(peekedBoxId);
  if (peekBounds === null) return;
  const { left, top } = peekSpotOf(peekBounds);
  parts.changesPeek.moveTo(left, top);
}

function peekChangedBox(event: PointerEvent): void {
  if (!parts || studioCollection.state.shownSessionId === null || event.buttons !== 0) return;
  if (event.target instanceof Node && parts.changesPeek.element.contains(event.target)) return;
  const overlayHost = parts.changesPeek.element.parentElement;
  const boxId = overlayHost === null ? null : boxIdAtPointer(event, overlayHost);
  if (boxId === peekedBoxId) return;
  peekedBoxId = boxId;
  const changingSessionIds = boxId === null ? [] : studioCollection.state.changingSessionIdsByBoxId[boxId] ?? [];
  for (const changingSessionId of changingSessionIds) reloadReview(changingSessionId);
  paintChangesPeek();
}

function openWatch(sessionId: string): SessionWatch {
  const watch: SessionWatch = {
    feed: createChatFeed({
      sessionId,
      workingDirectory: sessionWorkingDirectoryOf(sessionId) ?? sessionUIs.get(sessionId)?.path ?? null,
      requestPage: (payload) => sendControlRequest('session-trace', payload, { timeoutMs: TRACE_PAGE_TIMEOUT_MS }),
      onPartsChanged: () => {},
      onBeats: (beats) => {
        watch.lastBeat = beats.at(-1) ?? watch.lastBeat;
        paintPresence();
      },
      isTurnOver: () => chatPhaseOf(sessionsCollection.state.byId[sessionId]?.state ?? sessionUIs.get(sessionId)?.currentState) !== 'working',
      onReset: () => {},
      onRebuilt: () => {},
      onFailure: () => {},
      onRecords: (appendedRecords) => notePresenceRecords(sessionId, appendedRecords),
    }),
    presence: NO_PRESENCE,
    lastBeat: null,
    turnOpenedAts: [],
    waits: createAgentWaits(sessionId, showNotice),
  };
  return watch;
}

function catchUpWatch(watch: SessionWatch): void {
  watch.feed.whenCaughtUp(paintPresence);
  watch.feed.refresh();
}

function syncWatches(): void {
  const wantedIds = new Set(studioSessionIds());
  for (const [sessionId, watch] of watchBySessionId) {
    if (wantedIds.has(sessionId)) continue;
    watch.feed.close();
    watch.waits.close();
    watchBySessionId.delete(sessionId);
  }
  for (const sessionId of wantedIds) {
    if (watchBySessionId.has(sessionId)) continue;
    const watch = openWatch(sessionId);
    watchBySessionId.set(sessionId, watch);
    watch.feed.refresh();
  }
}

function addressAgent(model: AgentCardModel): void {
  dock?.addressSession(model.sessionId, model.name);
}

function answerAgentCard(sessionId: string, cardId: string, action: string, value: string): void {
  watchBySessionId.get(sessionId)?.waits.answer(cardId, action, value);
  paintPresence();
}

function addressBox(clickedBoardId: string, boxId: string): void {
  if (clickedBoardId !== studioCollection.state.boardId || studioCollection.state.shownSessionId === null) return;
  const choice = studioCollection.state.boxChoiceById[boxId];
  if (choice === undefined) return;
  dock?.addressBox(choice.boxId, placeTitleOf(choice.repoName, choice.title));
}

function toggleOpenedBranch(sessionId: string): void {
  if (!openedBranchIds.delete(sessionId)) openedBranchIds.add(sessionId);
  paintPresence();
}

function shownBranchIds(): string[] {
  const shownId = studioCollection.state.shownSessionId;
  if (shownId === null) return [];
  return branchSessionIdsOf(sessionUIs, shownId);
}

function dockBranchesOf(branchIds: readonly string[]): DockBranch[] {
  return branchIds.flatMap((branchId) => {
    const ui = sessionUIs.get(branchId);
    const branchBox = ui?.parent?.box;
    if (!ui || !branchBox) return [];
    return [{
      sessionId: branchId,
      name: sessionName(ui) || branchId.slice(0, 8),
      workingDirectory: sessionWorkingDirectoryOf(branchId) ?? ui.path,
      agentId: ui.agent ?? null,
      aboutTitle: placeTitleOf(branchBox.repoName, branchBox.title).trim(),
      isTurnOver: () => chatPhaseOf(sessionUIs.get(branchId)?.currentState) !== 'working',
    }];
  });
}

function syncBranches(): void {
  dock?.setBranches(dockBranchesOf(shownBranchIds()));
}

function paintAsks(): void {
  if (!parts) return;
  requestOpenAsksIfStale();
  const shownId = studioCollection.state.shownSessionId;
  const currentBoardId = studioCollection.state.boardId;
  const askingSessionIds = new Set(shownId === null ? [] : [shownId, ...shownBranchIds()]);
  const openAsks = fetchedAsks !== null && fetchedAsks.boardId === currentBoardId ? fetchedAsks.asks : [];
  const shownAsks = asksOfSessions(openAsks, askingSessionIds);
  const newAsks = parts.askCards.paint(currentBoardId, shownAsks, hostCamera);
  const overlay = parts.askCards.element;
  returnFromAnsweredAsk(shownAsks, overlay);
  const askArea = unionOf(newAsks.map((shown) => shown.rect));
  if (askArea === null) return;
  const shownArea = viewAreaShowing(askArea);
  if (shownArea === null) return;
  askGlide = { askBoxIds: new Set(newAsks.map((shown) => shown.askBoxId)), returnArea: currentViewArea(overlay), shownArea };
  glideHostTo(shownArea);
}

function viewAreaShowing(area: Rect): Rect | null {
  if (!parts) return null;
  const overlay = parts.askCards.element;
  const rightReservedPx = reservedRightOf(overlay, parts.guide.element);
  const clearArea = clearViewArea(overlay.clientWidth, overlay.clientHeight, reservedBelow(parts.dockSlot, overlay), rightReservedPx);
  return viewMovedToShow(area, clearArea, currentViewArea(overlay));
}

function revealShownCards(): void {
  const shownCards = unseenShownCards;
  if (shownCards === null || shownCards.boardId !== studioCollection.state.boardId || !parts) return;
  unseenShownCards = null;
  dismissAgentChange();
  const shownArea = viewAreaShowing(shownCards.area);
  if (shownArea !== null) glideHostTo(shownArea);
}

function showBoardChange(sessionId: string, boardChange: AgentChip): void {
  if (boardChange.boardId !== studioCollection.state.boardId) return;
  markAgentChangeShown(sessionId, boardChange.change);
  dismissAgentChange();
  ringAgentChange(boardChange.boardId, boardChange.change);
  const changedArea = unionOf(boardChange.change.boxes.map((box) => box.rect));
  const shownArea = changedArea === null ? null : viewAreaShowing(changedArea);
  if (shownArea !== null) glideHostTo(shownArea);
}

onAgentChange((_sessionId, boardChange) => {
  const shownCardArea = unionOf(boardChange.change.boxes.filter((box) => SHOWN_BOX_ID_RE.test(box.id)).map((box) => box.rect));
  if (shownCardArea !== null) unseenShownCards = { boardId: boardChange.boardId, area: shownCardArea };
});

function requestOpenAsksIfStale(): void {
  const askedBoardId = studioCollection.state.boardId;
  const heldVersion = askedBoardId === null ? null : tiledBoardOf(askedBoardId)?.version ?? null;
  if (askedBoardId === null || heldVersion === null) return;
  const versionKey = `${askedBoardId}@${heldVersion}`;
  if (requestedAsksKey === versionKey) return;
  requestedAsksKey = versionKey;
  void sendControlRequest('board-asks-of', { boardId: askedBoardId }, { timeoutMs: OPEN_ASKS_TIMEOUT_MS })
    .then((reply) => {
      if (requestedAsksKey !== versionKey) return;
      if (reply.type !== 'board-asks-of-result' || !reply.ok) {
        requestedAsksKey = null;
        return;
      }
      fetchedAsks = { boardId: askedBoardId, asks: reply.asks };
      paintAsks();
    }, () => {
      if (requestedAsksKey === versionKey) requestedAsksKey = null;
    });
}

function currentViewArea(overlay: HTMLElement): Rect {
  return { x: hostCamera.x, y: hostCamera.y, width: overlay.clientWidth / hostCamera.scale, height: overlay.clientHeight / hostCamera.scale };
}

function isSameArea(left: Rect, right: Rect): boolean {
  return Math.abs(left.x - right.x) < 1 && Math.abs(left.y - right.y) < 1 && Math.abs(left.width - right.width) < 1 && Math.abs(left.height - right.height) < 1;
}

function returnFromAnsweredAsk(shownAsks: readonly { askBoxId: string }[], overlay: HTMLElement): void {
  if (askGlide === null) return;
  const glide = askGlide;
  if (shownAsks.some((shown) => glide.askBoxIds.has(shown.askBoxId))) return;
  askGlide = null;
  if (isSameArea(currentViewArea(overlay), glide.shownArea)) glideHostTo(glide.returnArea);
}

function reservedRightOf(overlay: HTMLElement, guideElement: HTMLElement): number {
  if (guideElement.hidden) return 0;
  return Math.max(0, overlay.getBoundingClientRect().right - guideElement.getBoundingClientRect().left);
}

function clearViewArea(viewWidthPx: number, viewHeightPx: number, reservedBottomPx: number, reservedRightPx: number): Rect {
  const scale = hostCamera.scale;
  return { x: hostCamera.x + ASK_VIEW_SIDE_MARGIN_PX / scale, y: hostCamera.y + ASK_VIEW_TOP_MARGIN_PX / scale, width: Math.max(0, viewWidthPx - ASK_VIEW_SIDE_MARGIN_PX * 2 - reservedRightPx) / scale, height: Math.max(0, viewHeightPx - ASK_VIEW_TOP_MARGIN_PX - reservedBottomPx) / scale };
}

function sessionBoxIds(): string[] {
  const presenceBoxIds = [...watchBySessionId].flatMap(([sessionId, watch]) => [watch.presence.workedPath, ...watch.presence.namedPaths].flatMap((presencePath) => boxIdOfPresencePath(sessionId, presencePath) ?? []));
  const branchBoxIds = shownBranchIds().flatMap((branchId) => sessionUIs.get(branchId)?.parent?.box?.id ?? []);
  return [...presenceBoxIds, ...branchBoxIds, ...studioCollection.state.changedBoxIds];
}

function reservedBelow(element: HTMLElement | null, overlay: HTMLElement): number {
  if (element === null) return 0;
  return Math.max(0, overlay.getBoundingClientRect().bottom - element.getBoundingClientRect().top);
}

function firstView(mapBounds: Rect, viewWidthPx: number, viewHeightPx: number): GuestFirstView {
  if (!parts) return { isReady: true, camera: null };
  const dockBar = parts.dockSlot.querySelector<HTMLElement>('[data-board-island]');
  const shownId = studioCollection.state.shownSessionId;
  const isWaitingForSession = shownId !== null && (dockBar === null || studioCollection.state.boxesAnsweredSessionId !== shownId);
  if (isWaitingForSession) return { isReady: false };
  const titleSizePx = Number.parseFloat(getComputedStyle(parts.root).getPropertyValue('--type-title')) || TITLE_SIZE_FALLBACK_PX;
  const sessionArea = unionOf(sessionBoxIds().flatMap((boxId) => studioCollection.state.boxRectById[boxId] ?? []));
  const reservedBottomPx = reservedBelow(dockBar, parts.askCards.element);
  return { isReady: true, camera: firstViewCamera({ mapBounds, sessionArea, viewWidthPx, viewHeightPx, reservedBottomPx, floorScale: readableFloorScale(titleSizePx) }) };
}

function showNotice(text: string | null): void {
  if (!parts) return;
  parts.notice.hidden = text === null;
  parts.notice.textContent = text ?? '';
  paintPresence();
}

function seatOnHost(): void {
  if (!parts || !isActive) return;
  const currentBoardId = studioCollection.state.boardId;
  parts.root.dataset.map = currentBoardId === null ? 'none' : 'shown';
  showBoardBeside(currentBoardId, null, parts.guest);
}

function boxIdOfSessionPath(sessionId: string, sessionPath: string): string | null {
  return studioCollection.state.boxesBySessionId[sessionId]?.boxIdByPath[sessionPath] ?? null;
}

function boxIdOfPresencePath(sessionId: string, presencePath: string | null): string | null {
  if (presencePath === null) return null;
  return boxIdOfSessionPath(sessionId, presencePath);
}

function latestMisfitOf(sessionId: string, watch: SessionWatch): string | null {
  return standingMisfitOf([...watch.turnOpenedAts].reverse().map((openedAt) => studioCollection.state.verdictByKey[directorDigestKeyOf(sessionId, openedAt)]));
}

function latestDigestOf(sessionId: string, watch: SessionWatch): string | null {
  for (const openedAt of [...watch.turnOpenedAts].reverse()) {
    const digest = directorDigestOf(sessionId, openedAt);
    if (digest !== null) return digest;
  }
  return null;
}

function agentCardModelOf(sessionId: string, watch: SessionWatch): AgentCardModel | null {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return null;
  const shownId = studioCollection.state.shownSessionId;
  const phase = phaseOfSession(sessionId);
  if (isBusyPhase(phase)) openedBranchIds.delete(sessionId);
  watch.waits.sync();
  return {
    sessionId,
    name: sessionId === shownId ? ORCHESTRATOR_TEXT : ui.parent?.box?.title ?? (sessionName(ui) || sessionId.slice(0, 8)),
    agentId: ui.agent ?? null,
    isMain: sessionId === shownId,
    repoLabel: sessionId === shownId ? ORCHESTRATOR_TEXT : null,
    isBranch: branchParentIdOf(ui.parent) !== null,
    boxIds: [ui.parent?.box?.id ?? null, studioCollection.state.boxesBySessionId[sessionId]?.fallbackBoxId ?? null].flatMap((candidate) => candidate ?? []),
    phase,
    beat: phase === 'working' ? watch.lastBeat : null,
    digest: sessionId === shownId ? null : latestDigestOf(sessionId, watch),
    misfit: latestMisfitOf(sessionId, watch),
    approvals: watch.waits.element,
    isAsking: watch.waits.isAsking(),
    isOpened: openedBranchIds.has(sessionId),
  };
}

function shownAreaIn(overlay: HTMLElement, shown: HTMLElement): Rect[] {
  if (shown.hidden || shown.offsetHeight === 0) return [];
  const shownRect = shown.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  return [{ x: shownRect.left - overlayRect.left, y: shownRect.top - overlayRect.top, width: shownRect.width, height: shownRect.height }];
}

function fixedAreasIn(overlay: HTMLElement): Rect[] {
  if (!parts) return [];
  return [...shownAreaIn(overlay, parts.dockSlot), ...shownAreaIn(overlay, parts.guide.element)];
}

function observeFixedAreas(observed: readonly HTMLElement[]): void {
  const observer = new ResizeObserver(() => {
    if (!parts) return;
    shownFixedAreas = fixedAreasIn(parts.agentCards.element);
    parts.agentCards.place(hostCamera);
  });
  for (const target of observed) observer.observe(target);
}

function paintPresence(): void {
  if (!parts || !isActive) return;
  const tierByBoxId = new Map<string, GlowTier>();
  const markPaths = (sessionId: string, paths: readonly string[], tier: GlowTier) => {
    for (const boxId of paths.flatMap((presencePath) => boxIdOfPresencePath(sessionId, presencePath) ?? [])) {
      const shownTier = tierByBoxId.get(boxId);
      if (shownTier === undefined || GLOW_TIER_RANK[tier] > GLOW_TIER_RANK[shownTier]) tierByBoxId.set(boxId, tier);
    }
  };
  for (const [sessionId, watch] of watchBySessionId) {
    markPaths(sessionId, watch.presence.readPaths, 'read');
    markPaths(sessionId, watch.presence.editedPaths, 'edited');
    markPaths(sessionId, watch.presence.namedPaths, 'named');
  }
  const glows = [...tierByBoxId].map(([boxId, tier]) => ({ boxId, tier }));
  const currentBoardId = studioCollection.state.boardId;
  const board = currentBoardId === null ? null : tiledBoardOf(currentBoardId)?.board ?? null;
  const shownId = studioCollection.state.shownSessionId;
  const orchestratorAgentId = shownId === null ? null : sessionUIs.get(shownId)?.agent ?? null;
  const repoAgents = studioCollection.state.areas.map((area) => ({ repoKey: area.repoKey, repoName: area.repoName, anchorBoxId: area.anchorBoxId, agentId: area.branchAgentId ?? orchestratorAgentId }));
  parts.presenceLayer.paint({ glows, repoAgents }, board);
  const models = [...watchBySessionId].flatMap(([sessionId, watch]) => agentCardModelOf(sessionId, watch) ?? []);
  parts.agentCards.paint(models, shownBoundsOfBoard(board, boundsOfHostBox), shownMapBoundsOfBoard(board, boundsOfHostBox), hostCamera, () => shownFixedAreas);
  dock?.paintActivity();
  paintAsks();
}

function directorDigestOf(sessionId: string, openedAt: number): string | null {
  return studioCollection.state.verdictByKey[directorDigestKeyOf(sessionId, openedAt)]?.digest ?? null;
}

function directorChatLineOf(sessionId: string, openedAt: number): string | null {
  return studioCollection.state.verdictByKey[directorDigestKeyOf(sessionId, openedAt)]?.chatLine ?? null;
}

function requestDigests(): void {
  const shownId = studioCollection.state.shownSessionId;
  if (shownId === null) return;
  digestsRequestSerial += 1;
  const serial = digestsRequestSerial;
  const sessionIds = [shownId, ...watchBySessionId.keys()].slice(0, DIRECTOR_DIGEST_SESSIONS_MAX);
  sendControlRequest('director-digests', { id: shownId, sessionIds }, { timeoutMs: BOXES_TIMEOUT_MS })
    .then((reply) => {
      if (serial !== digestsRequestSerial || reply.type !== 'director-digests-result' || !reply.ok) return;
      applyStudioReply(reply);
      dock?.refreshDigests();
      paintPresence();
    })
    .catch(() => {});
}

async function setFolderOpen(folderBoardId: string, frameId: string, isOpen: boolean): Promise<boolean> {
  const mapSessionId = studioCollection.state.shownSessionId;
  if (mapSessionId === null || folderBoardId !== studioCollection.state.boardId) return false;
  const outcome = await runCodemapFolderSet({ id: mapSessionId, boxId: frameId, isOpen });
  if (!outcome.ok) {
    showNotice(outcome.error.message || NO_MAP_TEXT);
    return false;
  }
  return outcome.reply.type === 'codemap-folder-set-result' && outcome.reply.ok;
}

function notePresenceRecords(sessionId: string, appendedRecords: readonly TraceRecord[]): void {
  const watch = watchBySessionId.get(sessionId);
  if (!watch) return;
  const workingDirectory = sessionWorkingDirectoryOf(sessionId) ?? sessionUIs.get(sessionId)?.path ?? null;
  const nextPresence = foldPresence(watch.presence, appendedRecords, workingDirectory, sessionUIs.get(sessionId)?.isStudioMain === true);
  const openedAts = appendedRecords.filter(opensOperatorTurn).map((record) => record.ts);
  watch.turnOpenedAts = [...watch.turnOpenedAts, ...openedAts].slice(-TURN_OPENINGS_KEPT);
  const hasNewPath = presencePathsOf(nextPresence).some((presencePath) => isUnaskedPath(sessionId, presencePath));
  watch.presence = nextPresence;
  if (hasNewPath) {
    requestBoxes();
    return;
  }
  paintPresence();
}

function isUnaskedPath(sessionId: string, sessionPath: string): boolean {
  return boxIdOfSessionPath(sessionId, sessionPath) === null && !answeredPathKeys.has(pathKeyOf(sessionId, sessionPath));
}

function titledMapBoardIdOf(): string | null {
  const titledBoards = boardSummariesOf().filter((summary) => isCodeMapBoardTitle(summary.title));
  return titledBoards.length === 1 ? titledBoards[0].id : null;
}

function missingMapOf(boardId: string | null): MissingMap {
  const summaries = boardSummariesOf();
  return { boardId, boardVersion: summaries.find((summary) => summary.id === boardId)?.version ?? null, knownBoardIds: new Set(summaries.map((summary) => summary.id)) };
}

function isMissingMapRedrawn(missing: MissingMap): boolean {
  const summaries = boardSummariesOf();
  if (missing.boardId === null) return summaries.some((summary) => !missing.knownBoardIds.has(summary.id));
  return (summaries.find((summary) => summary.id === missing.boardId)?.version ?? null) !== missing.boardVersion;
}

function followMissingMap(): void {
  if (!isActive || missingMap === null || !isMissingMapRedrawn(missingMap)) return;
  missingMap = missingMapOf(missingMap.boardId);
  requestBoxes();
}

function showMapState(mapState: StudioMapState): void {
  const studioAreas = studioCollection.state.areas;
  parts?.guide.show(mapState, studioAreas.length === 1 ? studioAreas[0].repoName : EVERY_REPO_TEXT);
}

function showMapMissing(text: string, isMapFailed: boolean, mapBoardId: string | null): void {
  showMapState(isMapFailed ? 'failed' : 'building');
  showNotice(parts?.guide.isShowingWelcome() ? null : text);
  missingMap = missingMapOf(mapBoardId);
}

function requestBoxes(): void {
  const sessionId = studioCollection.state.shownSessionId;
  if (sessionId === null) return;
  boxesRequestSerial += 1;
  const serial = boxesRequestSerial;
  const askedPathsBySessionId = unaskedPathsBySessionId();
  const showMissingAndFirstView = (text: string, isMapFailed: boolean) => {
    showMapMissing(text, isMapFailed, studioCollection.state.boardId ?? titledMapBoardIdOf());
    paintBoard();
  };
  sendControlRequest('codemap-boxes-of', { id: sessionId, pathsBySessionId: askedPathsBySessionId }, { timeoutMs: BOXES_TIMEOUT_MS })
    .then((reply) => {
      if (serial !== boxesRequestSerial) return;
      if (reply.type !== 'codemap-boxes-of-response') return paintBoard();
      applyStudioReply(reply, { watchedSessionIds: new Set(watchBySessionId.keys()) });
      if (!reply.ok) return showMissingAndFirstView(reply.error ?? NO_MAP_TEXT, reply.isMapFailed);
      if (reply.boardId === null || reply.areas.length === 0) return showMissingAndFirstView(NO_MAP_TEXT, false);
      missingMap = null;
      const unmappedArea = reply.areas.find((area) => area.mapError !== null);
      showNotice(unmappedArea ? `${unmappedArea.repoName}: ${unmappedArea.mapError}` : null);
      showMapState('drawn');
      for (const [askedId, askedPaths] of Object.entries(askedPathsBySessionId)) {
        for (const askedPath of askedPaths) answeredPathKeys.add(pathKeyOf(askedId, askedPath));
      }
      seatOnHost();
      paintBoard();
      if (hasUnaskedPaths()) requestBoxes();
    })
    .catch(() => {
      if (serial !== boxesRequestSerial) return;
      applyStudioReply({
        type: 'codemap-boxes-of-response',
        id: sessionId,
        requestId: null,
        ok: false,
        boardId: null,
        boxesBySessionId: {},
        areas: [],
        boxRectById: {},
        boxChoices: [],
        isMapFailed: true,
        error: NO_MAP_TEXT,
      });
      showMissingAndFirstView(NO_MAP_TEXT, true);
    });
}

function mountDock(): void {
  dock?.close();
  dock = null;
  parts?.dockSlot.replaceChildren();
  const sessionId = studioCollection.state.shownSessionId;
  if (!parts || sessionId === null) return;
  const ui = sessionUIs.get(sessionId);
  dock = createDock({
    sessionId,
    name: ORCHESTRATOR_TEXT,
    workingDirectory: sessionWorkingDirectoryOf(sessionId) ?? ui?.path ?? null,
    agentId: ui?.agent ?? null,
    isTurnOver: () => chatPhaseOf(sessionsCollection.state.byId[sessionId]?.state ?? sessionUIs.get(sessionId)?.currentState) !== 'working',
    boxChoices: () => studioCollection.state.boxChoices,
    digestOf: directorChatLineOf,
    progressAnswers: () => studioCollection.state.progressAnswers.filter((answer) => answer.sessionId === sessionId),
    railFields: (canChangeModel) => sessionRailFieldsOf(sessionId, canChangeModel),
    onDelivered: (kind) => parts?.guide.markDone(kind),
    outbox: () => chatOutboxEntriesOf(sessionId).filter((entry) => entry.origin === 'operator'),
    activity: () => {
      const phase = phaseOfSession(sessionId);
      return { phase, beat: phase === 'working' ? watchBySessionId.get(sessionId)?.lastBeat ?? null : null };
    },
    mapBoardId: () => studioCollection.state.boardId,
    showBoardChange,
  });
  parts.dockSlot.append(dock.element);
  syncBranches();
}

function showSession(sessionId: string | null): void {
  const isSameSession = sessionId === mountedDockSessionId;
  if (parts) parts.noRepoChip.hidden = sessionId !== null;
  if (sessionId === null) {
    boxesRequestSerial += 1;
    digestsRequestSerial += 1;
    mountedDockSessionId = null;
    seatOnHost();
    mountDock();
    showMapState('absent');
    showNotice(NO_SESSION_TEXT);
    return;
  }
  if (!isSameSession) {
    mountedDockSessionId = sessionId;
    answeredPathKeys = new Set();
    peekedBoxId = null;
    parts?.changesPeek.hide();
    parts?.diffPanel.close();
    mountDock();
    requestDigests();
  }
  requestBoxes();
}

function closeMenu(): void {
  if (!parts) return;
  parts.menu.hidden = true;
  parts.menuOpener?.setAttribute('aria-expanded', 'false');
  parts.menuOpener = null;
}

function showStudio(): void {
  syncWatches();
  const orchestratorId = studioCollection.state.shownSessionId;
  showSession(orchestratorId);
  const anchorId = orchestratorId === null ? studioSessionIds()[0] ?? null : null;
  if (anchorId === null || anchorId === ensuredAnchorId) return;
  ensuredAnchorId = anchorId;
  ensureOrchestrator(anchorId);
}

function ensureOrchestrator(anchorSessionId: string): void {
  void runStudioMainEnsure({ id: anchorSessionId }).then((outcome) => {
    if (!outcome.ok) {
      showNotice(outcome.error.message || NO_MAIN_TEXT);
      return;
    }
    refreshBoardSessionView();
  });
}

function openStudioRepo(repoDir: string | null = null): void {
  openStudioRepoDialog(() => {
    refreshBoardSessionView();
    requestBoxes();
  }, repoDir);
}

function pickRepoAgent(repoKey: string): void {
  const area = studioCollection.state.areaByRepoKey[repoKey];
  if (area) openStudioRepo(area.repoDir);
}

function menuActionItem(label: string, action: string, onPick: () => void): HTMLElement {
  const item = createPressable('bs-menu-item');
  item.setAttribute('role', 'menuitem');
  item.dataset.action = action;
  item.append(el('span', 'bs-menu-name', label));
  item.addEventListener('click', () => {
    closeMenu();
    onPick();
  });
  return item;
}

function restartAgent(sessionId: string): void {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  void loadResumeDialog().then((resumeDialog) => resumeDialog?.openRestartDialog(sessionId, { readState: () => ui.currentState, canListEarlier: true }));
}

async function closeBranchAgent(sessionId: string): Promise<string | null> {
  const ui = sessionUIs.get(sessionId);
  const label = ui ? sessionName(ui) : undefined;
  const outcome = await removeSessionAction({ id: sessionId, label });
  if (!outcome.ok) return outcome.error.message;
  if (outcome.reply.type !== 'remove-session-result' || outcome.reply.ok) return null;
  return outcome.reply.error ?? null;
}

function toggleRepoMenu(card: HTMLElement, repoButton: HTMLButtonElement): void {
  if (!parts) return;
  const isOpenHere = parts.menuOpener === repoButton && !parts.menu.hidden;
  closeMenu();
  if (isOpenHere) return;
  card.append(parts.menu);
  openMenu(repoButton);
}

function openMenu(opener: HTMLButtonElement): void {
  if (!parts) return;
  const openRepoItem = menuActionItem(OPEN_REPO_TEXT, 'board-session-open-repo', () => openStudioRepo());
  const orchestratorId = studioCollection.state.shownSessionId;
  const orchestratorItems = orchestratorId === null ? [] : [
    el('div', 'bs-menu-rule'),
    menuActionItem(RESTART_ORCHESTRATOR_TEXT, 'board-session-agent-restart', () => restartAgent(orchestratorId)),
    menuActionItem(ACCOUNT_TEXT, 'board-session-agent-account', () => openSwitchAccountDialog(orchestratorId)),
  ];
  parts.menu.replaceChildren(openRepoItem, ...orchestratorItems);
  parts.menu.hidden = false;
  parts.menuOpener = opener;
  opener.setAttribute('aria-expanded', 'true');
}

function mountBoardSessionView(panel: HTMLElement): void {
  const root = el('div', 'bs-root');
  const menu = el('div', 'bs-menu bs-card-menu bs-repo-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const presenceLayer = createPresenceLayer(boundsOfHostBox, pickRepoAgent);
  const agentCards = createAgentCards({ address: addressAgent, restart: restartAgent, switchAccount: openSwitchAccountDialog, close: closeBranchAgent, toggleOpened: toggleOpenedBranch, toggleRepoMenu, answer: answerAgentCard });
  const topLeft = el('div', 'bs-top-left');
  const noRepoChip = createPressable('bs-chip');
  noRepoChip.setAttribute('aria-haspopup', 'menu');
  noRepoChip.setAttribute('aria-expanded', 'false');
  noRepoChip.dataset.action = 'board-session-repo';
  noRepoChip.append(el('span', 'bs-chip-name', NO_REPO_TEXT), createLineIcon(CARET_ICON_PATH, '1.5'));
  noRepoChip.addEventListener('click', () => {
    if (parts?.menuOpener === noRepoChip) return closeMenu();
    closeMenu();
    topLeft.append(menu);
    openMenu(noRepoChip);
  });
  topLeft.append(noRepoChip);
  const notice = el('p', 'bs-notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const dockSlot = el('div', 'bs-dock-slot');
  const askCards = createAskCards();
  const diffPanel = createDiffPanel();
  const guide = createStudioGuide();
  const changesPeek = createChangesPeek((file) => {
    peekedBoxId = null;
    changesPeek.hide();
    diffPanel.open(file);
    guide.markDone('diff');
  });
  root.addEventListener('pointermove', peekChangedBox, { capture: true });
  root.addEventListener('pointerleave', () => {
    peekedBoxId = null;
    changesPeek.hide();
  });
  onReviewChange((sessionId) => {
    if (!isActive || !watchBySessionId.has(sessionId)) return;
    if (hasUnaskedPaths()) requestBoxes();
    paintChangesPeek();
  });
  panel.replaceChildren(root);
  const guest: BoardHostGuest = {
    chrome: topLeft,
    overlays: [notice, guide.element, dockSlot, agentCards.element, askCards.element, changesPeek.element, diffPanel.element],
    worldLayer: presenceLayer.element,
    markedBoxIds: () => new Set(studioCollection.state.changedBoxIds),
    firstView,
    setStackOpen: setFolderOpen,
    onBoxClicked: addressBox,
    onPainted: (camera) => {
      hostCamera = camera;
      revealShownCards();
      paintPresence();
      paintChangesPeek();
    },
    onCameraMoved: (camera) => {
      hostCamera = camera;
      moveOverlaysWithCamera();
    },
  };
  parts = { root, menu, menuOpener: null, topLeft, noRepoChip, notice, dockSlot, presenceLayer, askCards, agentCards, changesPeek, diffPanel, guide, guest };
  observeFixedAreas([dockSlot, guide.element, agentCards.element]);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || menu.hidden || isModalOpen()) return;
    closeMenu();
  });
  document.addEventListener('pointerdown', (event) => {
    if (menu.hidden || !(event.target instanceof Node) || menu.contains(event.target) || parts?.menuOpener?.contains(event.target)) return;
    closeMenu();
  });
  onBoardListChanged(followMissingMap);
  onStudioServerMessage((message) => {
    if (message.type !== 'director-digest-kept') return;
    if (isActive && (message.id === studioCollection.state.shownSessionId || watchBySessionId.has(message.id))) requestDigests();
  });
  runWithOwner(null, () => {
    createRoot(() => {
      createEffect(
        () => studioCollection.state.areas.map((area) => `${area.repoKey}:${area.isFolded}:${area.branchAgentId ?? ''}`).join('|'),
        () => {
          if (isActive) paintPresence();
        },
      );
    });
  });
  onBoardSessionStatusChanged((sessionId) => {
    if (!isActive) return;
    if (watchBySessionId.has(sessionId)) paintPresence();
    if (sessionId !== studioCollection.state.shownSessionId && !isBranchOfShownSession(sessionId)) return;
    dock?.refresh();
  });
  onBoardSessionTraceChanged((sessionId) => {
    if (!isActive) return;
    watchBySessionId.get(sessionId)?.feed.refresh();
    if (isBranchOfShownSession(sessionId)) return dock?.refresh();
    if (sessionId !== studioCollection.state.shownSessionId) return;
    dock?.refresh();
    requestBoxes();
  });
}

function activateBoardSessionView(): void {
  isActive = true;
  if (!parts) return;
  const host = mountBoardHost();
  if (host.parentElement !== parts.root) parts.root.replaceChildren(host);
  placeBoardTitle(null);
  seatOnHost();
  for (const watch of watchBySessionId.values()) catchUpWatch(watch);
  showStudio();
  requestDigests();
  reopenSelectedBoard();
}

function deactivateBoardSessionView(): void {
  isActive = false;
  boxesRequestSerial += 1;
  digestsRequestSerial += 1;
  missingMap = null;
  for (const watch of watchBySessionId.values()) watch.waits.close();
  ensuredAnchorId = null;
  closeMenu();
  if (parts) leaveBoardHost(parts.guest);
}

function refreshBoardSessionView(): void {
  if (!isActive) return;
  showStudio();
  syncBranches();
  paintPresence();
  dock?.refresh();
}

export const view: ViewModule<HTMLElement> = {
  mount: mountBoardSessionView,
  activate: activateBoardSessionView,
  deactivate: deactivateBoardSessionView,
  refresh: refreshBoardSessionView,
};
