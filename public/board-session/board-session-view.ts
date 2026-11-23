import './board-session.css';
import { branchParentIdOf } from '#shared/parent-link.ts';
import { chatPhaseOf, shownChatPhaseOf } from '../chat/chat-activity-core.ts';
import type { ActivityBeat, ChatPhase } from '../chat/chat-activity-core.ts';
import { createChatFeed } from '../chat/chat-feed.ts';
import type { ChatFeed } from '../chat/chat-feed.ts';
import type { RunningSubagent } from '../chat/status-rail-core.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { getJSON, setJSON } from '../local-store.ts';
import { sessionWorkingDirectoryOf } from '../session-card/card-model.ts';
import { sessionName, sessionUIs } from '../session-card/card-registry.ts';
import { loadResumeDialog } from '../session-card/deferred-loads.ts';
import { createPressable } from '../ui/pressable.ts';
import type { ViewModule } from '../view-registry-core.ts';
import type { Camera } from '../whiteboard/board-gl-renderer.ts';
import { boundsOfHostBox, glideHostTo, leaveBoardHost, mountBoardHost, paintBoard, placeBoardTitle, reopenSelectedBoard, showBoardBeside } from '../whiteboard/boards-view.ts';
import type { BoardHostGuest } from '../whiteboard/boards-view.ts';
import { tiledBoardOf } from '../whiteboard/board-tile-store.ts';
import { onBoardSessionTraceChanged, onDirectorDigestKept } from './board-session-signals.ts';
import { isBelowFloor, pickedRepoPath, readableFloorScale, repoChoicesOf } from './board-session-core.ts';
import { unionOf } from '#shared/whiteboard-route-core.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import type { RepoChoice, RepoSession } from './board-session-core.ts';
import type { TraceRecord } from '#shared/contracts/trace.ts';
import { createDock } from './dock.ts';
import type { SessionProgressAnswer } from '#shared/contracts/director-digests.ts';
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
import { createAgentWaits } from './agent-waits.ts';
import type { AgentWaits } from './agent-waits.ts';
import { opensOperatorTurn } from '#shared/trace-turn.ts';
import type { Dock, DockBranch } from './dock.ts';
import { branchSessionIdsOf } from './branch-core.ts';
import type { BoxChoice } from './branch-core.ts';
import { SHOWN_REPO_KEY, isStudioSession, onStudioRepoRequested } from './studio-target.ts';
import { openStudioRepoDialog } from '../session-actions.ts';
import { CODEMAP_BOXES_MAX_PATHS, DIRECTOR_DIGEST_SESSIONS_MAX } from '#shared/contracts/control/board-session-messages.ts';
import { directorDigestKeyOf } from '#shared/director-digest-key.ts';
import { STATES } from '#shared/states.ts';
import { createLineIcon } from '../svg-dom.ts';

const BOXES_TIMEOUT_MS = 10000;
const MAP_RETRY_MS = 15000;
const TRACE_PAGE_TIMEOUT_MS = 10000;
const MAIN_ENSURE_TIMEOUT_MS = 15000;
const TITLE_SIZE_FALLBACK_PX = 16;
const PEEK_OVERLAP_PX = 4;
const NO_SESSION_TEXT = 'Open a repo from the repo menu to see its code map.';
const OPEN_REPO_TEXT = 'Open a repo';
const NO_MAP_TEXT = 'This session has no code map yet.';
const NO_MAIN_TEXT = 'The Orchestrator for this repo did not start.';
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
  subagents: readonly RunningSubagent[];
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
let shownRepoPath: string | null = null;
let shownSessionId: string | null = null;
let ensuredRepoPath: string | null = null;
const mainSessionIdByRepoPath = new Map<string, string>();
let fallbackBoxId: string | null = null;
let answeredPaths = new Set<string>();
let pendingMainId: string | null = null;
let boardId: string | null = null;
const sessionIdByBoardId = new Map<string, string>();
let changedBoxIds: ReadonlySet<string> = new Set();
let peekedBoxId: string | null = null;
let askGlide: { askBoxIds: ReadonlySet<string>; returnArea: Rect; shownArea: Rect } | null = null;
const ASK_VIEW_TOP_MARGIN_PX = 64;
const ASK_VIEW_SIDE_MARGIN_PX = 24;
let hostCamera: Camera = { x: 0, y: 0, scale: 1 };
let dock: Dock | null = null;
let boxesRequestSerial = 0;
let mapRetryTimer: ReturnType<typeof setTimeout> | null = null;
let digestsRequestSerial = 0;
let progressAnswers: readonly SessionProgressAnswer[] = [];
let verdictByKey: Readonly<Record<string, { chatLine: string | null; digest: string | null }>> = {};
let watchBySessionId = new Map<string, SessionWatch>();
let boxIdByPath: Readonly<Record<string, string>> = {};
let moduleChoices: readonly BoxChoice[] = [];
const openedBranchIds = new Set<string>();

function repoChoices(): RepoChoice[] {
  const repoSessions: RepoSession[] = [...sessionUIs].flatMap(([id, ui]) => ui.isStudioMain ? [{ id, path: ui.path }] : []);
  return repoChoicesOf(repoSessions);
}

function phaseOfSession(sessionId: string): ChatPhase {
  const ui = sessionUIs.get(sessionId);
  return shownChatPhaseOf(chatPhaseOf(ui?.currentState), false, ui?.awaitingBackgroundTasks === true);
}

function presenceOf(sessionId: string | null): Presence {
  if (sessionId === null) return NO_PRESENCE;
  return watchBySessionId.get(sessionId)?.presence ?? NO_PRESENCE;
}

function changedFilesOfShownSession() {
  return shownSessionId === null ? [] : reviewOf(shownSessionId)?.files ?? [];
}

function watchedPaths(): string[] {
  return [...new Set([...[...watchBySessionId.values()].flatMap((watch) => presencePathsOf(watch.presence)), ...changedFilesOfShownSession().map((file) => file.path)])];
}

function boxIdAtPointer(event: PointerEvent, overlayHost: HTMLElement): string | null {
  const hostRect = overlayHost.getBoundingClientRect();
  const boardX = (event.clientX - hostRect.left) / hostCamera.scale + hostCamera.x;
  const boardY = (event.clientY - hostRect.top) / hostCamera.scale + hostCamera.y;
  return [...changedBoxIds].find((boxId) => {
    const bounds = boundsOfHostBox(boxId);
    return bounds !== null && boardX >= bounds.x && boardX <= bounds.x + bounds.width && boardY >= bounds.y && boardY <= bounds.y + bounds.height;
  }) ?? null;
}

function paintChangesPeek(): void {
  if (!parts) return;
  const bounds = peekedBoxId === null ? null : boundsOfHostBox(peekedBoxId);
  if (bounds === null) {
    parts.changesPeek.hide();
    return;
  }
  const files = changedFilesOfShownSession().filter((file) => boxIdByPath[file.path] === peekedBoxId);
  const left = (bounds.x + bounds.width - hostCamera.x) * hostCamera.scale - PEEK_OVERLAP_PX;
  const top = (bounds.y - hostCamera.y) * hostCamera.scale;
  parts.changesPeek.show(files, left, top);
}

function peekChangedBox(event: PointerEvent): void {
  if (!parts || shownSessionId === null) return;
  if (event.target instanceof Node && parts.changesPeek.element.contains(event.target)) return;
  const overlayHost = parts.changesPeek.element.parentElement;
  const boxId = overlayHost === null ? null : boxIdAtPointer(event, overlayHost);
  if (boxId === peekedBoxId) return;
  peekedBoxId = boxId;
  if (boxId !== null) reloadReview(shownSessionId);
  paintChangesPeek();
}

function repoSessionIds(): string[] {
  if (shownRepoPath === null) return [];
  return [...sessionUIs].flatMap(([id, ui]) => ui.path === shownRepoPath && isStudioSession(ui) ? [id] : []);
}

function closeWatches(): void {
  for (const watch of watchBySessionId.values()) {
    watch.feed.close();
    watch.waits.close();
  }
  watchBySessionId = new Map();
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
      onSubagents: (runningSubagents) => {
        watch.subagents = runningSubagents;
        paintPresence();
      },
      isTurnOver: () => chatPhaseOf(sessionUIs.get(sessionId)?.currentState) !== 'working',
      onReset: () => {},
      onRebuilt: () => {},
      onFailure: () => {},
      onRecords: (appendedRecords) => notePresenceRecords(sessionId, appendedRecords),
    }),
    presence: NO_PRESENCE,
    lastBeat: null,
    subagents: [],
    turnOpenedAts: [],
    waits: createAgentWaits(sessionId, showNotice),
  };
  return watch;
}

function syncWatches(): void {
  const wantedIds = new Set(repoSessionIds());
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

function repoStateWordOf(sessionId: string | undefined): string {
  if (sessionId === undefined) return '';
  if (sessionUIs.get(sessionId)?.currentState === STATES.WAITING) return 'Waiting on you';
  const wordByPhase: Record<ChatPhase, string> = { starting: 'Starting', working: 'Working', monitoring: 'Working', quiet: 'Idle', stopped: 'Stopped' };
  return wordByPhase[phaseOfSession(sessionId)];
}

function addressAgent(model: AgentCardModel): void {
  dock?.addressSession(model.sessionId, model.name);
}

function answerAgentCard(sessionId: string, cardId: string, action: string, value: string): void {
  watchBySessionId.get(sessionId)?.waits.answer(cardId, action, value);
  paintPresence();
}

function addressBox(clickedBoardId: string, boxId: string): void {
  if (clickedBoardId !== boardId || shownSessionId === null) return;
  const choice = moduleChoices.find((candidate) => candidate.boxId === boxId);
  if (choice === undefined) return;
  dock?.addressBox(choice.boxId, choice.title);
}

function toggleOpenedBranch(sessionId: string): void {
  if (!openedBranchIds.delete(sessionId)) openedBranchIds.add(sessionId);
  paintPresence();
}

function shownBranchIds(): string[] {
  if (shownSessionId === null) return [];
  return branchSessionIdsOf(sessionUIs, shownSessionId);
}

function dockBranchesOf(branchIds: readonly string[]): DockBranch[] {
  return branchIds.flatMap((branchId) => {
    const ui = sessionUIs.get(branchId);
    const branchTitle = ui?.parent?.box?.title;
    if (!ui || branchTitle === undefined) return [];
    return [{
      sessionId: branchId,
      name: sessionName(ui) || branchId.slice(0, 8),
      workingDirectory: sessionWorkingDirectoryOf(branchId) ?? ui.path,
      agentId: ui.agent ?? null,
      aboutTitle: branchTitle,
      isTurnOver: () => chatPhaseOf(sessionUIs.get(branchId)?.currentState) !== 'working',
    }];
  });
}

function syncBranches(): void {
  dock?.setBranches(dockBranchesOf(shownBranchIds()));
}

function paintAsks(): void {
  if (!parts) return;
  const board = boardId === null ? null : tiledBoardOf(boardId)?.board ?? null;
  const askingSessionIds = new Set(shownSessionId === null ? [] : [shownSessionId, ...shownBranchIds()]);
  const shownAsks = asksOfSessions(board, askingSessionIds);
  const newAsks = parts.askCards.paint(boardId, shownAsks, boundsOfHostBox, hostCamera);
  const overlay = parts.askCards.element;
  returnFromAnsweredAsk(shownAsks, overlay);
  const askArea = unionOf(newAsks.flatMap((shown) => boundsOfHostBox(shown.askBoxId) ?? []));
  if (askArea === null) return;
  const rightReservedPx = reservedRightOf(overlay, parts.guide.element);
  const clearArea = clearViewArea(overlay.clientWidth, overlay.clientHeight, parts.dockSlot.offsetHeight, rightReservedPx);
  if (isRectInside(askArea, clearArea)) return;
  const shownArea = viewShowingAsk(askArea, overlay.clientWidth, overlay.clientHeight, rightReservedPx);
  askGlide = { askBoxIds: new Set(newAsks.map((shown) => shown.askBoxId)), returnArea: currentViewArea(overlay), shownArea };
  glideHostTo(shownArea);
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

function viewShowingAsk(askArea: Rect, viewWidthPx: number, viewHeightPx: number, reservedRightPx: number): Rect {
  const scale = hostCamera.scale;
  const width = viewWidthPx / scale;
  const height = viewHeightPx / scale;
  return { x: askArea.x + askArea.width + (ASK_VIEW_SIDE_MARGIN_PX + reservedRightPx) / scale - width, y: askArea.y - ASK_VIEW_TOP_MARGIN_PX / scale, width, height };
}

function isRectInside(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function sessionBoxIds(): string[] {
  const presence = presenceOf(shownSessionId);
  const presenceBoxIds = [presence.workedPath, ...presence.namedPaths].flatMap((presencePath) => boxIdOfPresencePath(presencePath) ?? []);
  return [...presenceBoxIds, ...changedBoxIds];
}

function firstViewArea(mapBounds: Rect, viewWidthPx: number, viewHeightPx: number): Rect | null {
  if (!parts) return null;
  const reservedBottomPx = parts.dockSlot.offsetHeight;
  const titleSizePx = Number.parseFloat(getComputedStyle(parts.root).getPropertyValue('--type-title')) || TITLE_SIZE_FALLBACK_PX;
  if (!isBelowFloor(mapBounds, viewWidthPx, viewHeightPx, reservedBottomPx, readableFloorScale(titleSizePx))) return null;
  return unionOf(sessionBoxIds().flatMap((boxId) => boundsOfHostBox(boxId) ?? []));
}

function showNotice(text: string | null): void {
  if (!parts) return;
  parts.notice.hidden = text === null;
  parts.notice.textContent = text ?? '';
  paintPresence();
}

function seatOnHost(): void {
  if (!parts || !isActive) return;
  parts.root.dataset.map = boardId === null ? 'none' : 'shown';
  showBoardBeside(boardId, null, parts.guest);
}

function boxIdOfPresencePath(presencePath: string | null): string | null {
  if (presencePath === null) return null;
  return boxIdByPath[presencePath] ?? null;
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
  const phase = phaseOfSession(sessionId);
  if (isBusyPhase(phase)) openedBranchIds.delete(sessionId);
  watch.waits.sync();
  return {
    sessionId,
    name: sessionId === shownSessionId ? ORCHESTRATOR_TEXT : sessionName(ui) || sessionId.slice(0, 8),
    agentId: ui.agent ?? null,
    isMain: sessionId === shownSessionId,
    repoLabel: sessionId === shownSessionId ? shownRepoLabel() : null,
    isBranch: branchParentIdOf(ui.parent) !== null,
    boxIds: [ui.parent?.box?.id ?? null, fallbackBoxId].flatMap((candidate) => candidate ?? []),
    phase,
    beat: phase === 'working' ? watch.lastBeat : null,
    digest: sessionId === shownSessionId ? null : latestDigestOf(sessionId, watch),
    approvals: watch.waits.element,
    isAsking: watch.waits.isAsking(),
    isOpened: openedBranchIds.has(sessionId),
  };
}

function dockAreaIn(overlay: HTMLElement): Rect | null {
  if (!parts || parts.dockSlot.offsetHeight === 0) return null;
  const dockRect = parts.dockSlot.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  return { x: dockRect.left - overlayRect.left, y: dockRect.top - overlayRect.top, width: dockRect.width, height: dockRect.height };
}

function paintPresence(): void {
  if (!parts) return;
  const tierByBoxId = new Map<string, GlowTier>();
  const markPaths = (paths: readonly string[], tier: GlowTier) => {
    for (const boxId of paths.flatMap((presencePath) => boxIdOfPresencePath(presencePath) ?? [])) {
      const shownTier = tierByBoxId.get(boxId);
      if (shownTier === undefined || GLOW_TIER_RANK[tier] > GLOW_TIER_RANK[shownTier]) tierByBoxId.set(boxId, tier);
    }
  };
  for (const watch of watchBySessionId.values()) {
    markPaths(watch.presence.readPaths, 'read');
    markPaths(watch.presence.editedPaths, 'edited');
  }
  markPaths(presenceOf(shownSessionId).namedPaths, 'named');
  const glows = [...tierByBoxId].map(([boxId, tier]) => ({ boxId, tier }));
  const board = boardId === null ? null : tiledBoardOf(boardId)?.board ?? null;
  parts.presenceLayer.paint({ glows }, board);
  const models = [...watchBySessionId].flatMap(([sessionId, watch]) => agentCardModelOf(sessionId, watch) ?? []);
  parts.agentCards.paint(models, shownBoundsOfBoard(board, boundsOfHostBox), shownMapBoundsOfBoard(board, boundsOfHostBox), hostCamera, dockAreaIn(parts.agentCards.element));
  paintAsks();
}

function directorDigestOf(sessionId: string, openedAt: number): string | null {
  return verdictByKey[directorDigestKeyOf(sessionId, openedAt)]?.digest ?? null;
}

function directorChatLineOf(sessionId: string, openedAt: number): string | null {
  return verdictByKey[directorDigestKeyOf(sessionId, openedAt)]?.chatLine ?? null;
}

function requestDigests(): void {
  if (shownSessionId === null) return;
  digestsRequestSerial += 1;
  const serial = digestsRequestSerial;
  const sessionIds = [shownSessionId, ...watchBySessionId.keys()].slice(0, DIRECTOR_DIGEST_SESSIONS_MAX);
  sendControlRequest('director-digests', { id: shownSessionId, sessionIds }, { timeoutMs: BOXES_TIMEOUT_MS })
    .then((reply) => {
      if (serial !== digestsRequestSerial || reply.type !== 'director-digests-result' || !reply.ok) return;
      verdictByKey = { ...verdictByKey, ...reply.verdictByKey };
      progressAnswers = reply.progressAnswers;
      dock?.refreshDigests();
      paintPresence();
    })
    .catch(() => {});
}

async function toggleFolder(folderBoardId: string, frameId: string): Promise<boolean> {
  const mapSessionId = sessionIdByBoardId.get(folderBoardId);
  if (mapSessionId === undefined) return false;
  const reply = await sendControlRequest('codemap-folder-toggle', { id: mapSessionId, boxId: frameId }, { timeoutMs: BOXES_TIMEOUT_MS }).catch(() => null);
  if (reply?.type !== 'codemap-folder-toggle-result') {
    showNotice(NO_MAP_TEXT);
    return false;
  }
  if (!reply.ok) showNotice(reply.error ?? NO_MAP_TEXT);
  return reply.ok;
}

function notePresenceRecords(sessionId: string, appendedRecords: readonly TraceRecord[]): void {
  const watch = watchBySessionId.get(sessionId);
  if (!watch) return;
  const workingDirectory = sessionWorkingDirectoryOf(sessionId) ?? sessionUIs.get(sessionId)?.path ?? null;
  const nextPresence = foldPresence(watch.presence, appendedRecords, workingDirectory);
  const openedAts = appendedRecords.filter(opensOperatorTurn).map((record) => record.ts);
  watch.turnOpenedAts = [...watch.turnOpenedAts, ...openedAts].slice(-TURN_OPENINGS_KEPT);
  const hasNewPath = presencePathsOf(nextPresence).some(isUnaskedPath);
  watch.presence = nextPresence;
  if (hasNewPath) {
    requestBoxes();
    return;
  }
  paintPresence();
}

function shownRepoLabel(): string {
  return repoChoices().find((choice) => choice.path === shownRepoPath)?.label ?? NO_REPO_TEXT;
}

function isUnaskedPath(presencePath: string): boolean {
  return !(presencePath in boxIdByPath) && !answeredPaths.has(presencePath);
}

function stopMapRetry(): void {
  if (mapRetryTimer !== null) clearTimeout(mapRetryTimer);
  mapRetryTimer = null;
}

function showMapState(mapState: StudioMapState): void {
  parts?.guide.show(mapState, shownSessionId === null ? NO_REPO_TEXT : shownRepoLabel());
}

function showMapMissing(text: string, isMapFailed: boolean): void {
  showMapState(isMapFailed ? 'failed' : 'building');
  showNotice(parts?.guide.isShowingWelcome() ? null : text);
  stopMapRetry();
  mapRetryTimer = setTimeout(() => {
    mapRetryTimer = null;
    if (isActive) requestBoxes();
  }, MAP_RETRY_MS);
}

function requestBoxes(): void {
  stopMapRetry();
  if (shownSessionId === null) return;
  const sessionId = shownSessionId;
  boxesRequestSerial += 1;
  const serial = boxesRequestSerial;
  const askedPaths = watchedPaths().filter(isUnaskedPath).slice(0, CODEMAP_BOXES_MAX_PATHS);
  sendControlRequest('codemap-boxes-of', { id: sessionId, paths: askedPaths }, { timeoutMs: BOXES_TIMEOUT_MS })
    .then((reply) => {
      if (serial !== boxesRequestSerial || reply.type !== 'codemap-boxes-of-response') return;
      if (!reply.ok) return showMapMissing(reply.error ?? NO_MAP_TEXT, reply.isMapFailed);
      if (reply.boardId === null) return showMapMissing(NO_MAP_TEXT, false);
      showNotice(null);
      showMapState('drawn');
      changedBoxIds = new Set(reply.changedBoxIds);
      fallbackBoxId = reply.fallbackBoxId;
      boxIdByPath = { ...boxIdByPath, ...reply.boxIdByPath };
      for (const askedPath of askedPaths) answeredPaths.add(askedPath);
      moduleChoices = reply.boxChoices;
      boardId = reply.boardId;
      sessionIdByBoardId.set(reply.boardId, sessionId);
      seatOnHost();
      paintBoard();
      if (watchedPaths().some(isUnaskedPath)) requestBoxes();
    })
    .catch(() => {
      if (serial === boxesRequestSerial) showMapMissing(NO_MAP_TEXT, true);
    });
}

function mountDock(): void {
  dock?.close();
  dock = null;
  parts?.dockSlot.replaceChildren();
  if (!parts || shownSessionId === null) return;
  const sessionId = shownSessionId;
  const ui = sessionUIs.get(sessionId);
  dock = createDock({
    sessionId,
    name: ORCHESTRATOR_TEXT,
    workingDirectory: sessionWorkingDirectoryOf(sessionId) ?? ui?.path ?? null,
    agentId: ui?.agent ?? null,
    isTurnOver: () => chatPhaseOf(sessionUIs.get(sessionId)?.currentState) !== 'working',
    boxChoices: () => moduleChoices,
    digestOf: directorChatLineOf,
    progressAnswers: () => progressAnswers.filter((answer) => answer.sessionId === sessionId),
    railFields: () => sessionRailFieldsOf(sessionId, watchBySessionId.get(sessionId)?.subagents ?? [], false),
    onDelivered: (kind) => parts?.guide.markDone(kind),
  });
  parts.dockSlot.append(dock.element);
  syncBranches();
}

function showSession(sessionId: string | null): void {
  const isSameSession = sessionId === shownSessionId;
  shownSessionId = sessionId;
  if (!isSameSession) fallbackBoxId = null;
  if (parts) parts.noRepoChip.hidden = sessionId !== null;
  if (sessionId === null) {
    boardId = null;
    seatOnHost();
    mountDock();
    showMapState('drawn');
    showNotice(NO_SESSION_TEXT);
    return;
  }
  if (!isSameSession) {
    verdictByKey = {};
    progressAnswers = [];
    changedBoxIds = new Set();
    boxIdByPath = {};
    answeredPaths = new Set();
    moduleChoices = [];
    peekedBoxId = null;
    parts?.changesPeek.hide();
    parts?.diffPanel.close();
    mountDock();
    requestDigests();
    reloadReview(sessionId);
  }
  requestBoxes();
}

function closeMenu(): void {
  if (!parts) return;
  parts.menu.hidden = true;
  parts.menuOpener?.setAttribute('aria-expanded', 'false');
  parts.menuOpener = null;
}

function showRepo(repoPath: string | null): void {
  if (repoPath !== shownRepoPath) closeWatches();
  shownRepoPath = repoPath;
  syncWatches();
  const repoSessionIds = repoChoices().find((choice) => choice.path === repoPath)?.sessionIds ?? [];
  const mainSessionId = repoPath === null ? undefined : mainSessionIdByRepoPath.get(repoPath);
  const fallbackSessionId = shownSessionId !== null && repoSessionIds.includes(shownSessionId) ? shownSessionId : repoSessionIds.at(-1) ?? null;
  const anchorSessionId = mainSessionId !== undefined && sessionUIs.has(mainSessionId) ? mainSessionId : fallbackSessionId;
  showSession(anchorSessionId);
  if (repoPath === null || anchorSessionId === null || repoPath === ensuredRepoPath) return;
  ensuredRepoPath = repoPath;
  ensureMainSession(repoPath, anchorSessionId);
}

function ensureMainSession(repoPath: string, anchorSessionId: string): void {
  sendControlRequest('studio-main-ensure', { id: anchorSessionId }, { timeoutMs: MAIN_ENSURE_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type !== 'studio-main-ensure-result') return;
      if (!reply.ok || reply.mainId === null) return showNotice(reply.error ?? NO_MAIN_TEXT);
      mainSessionIdByRepoPath.set(repoPath, reply.mainId);
      if (shownRepoPath === repoPath) showSession(reply.mainId);
    })
    .catch(() => {
      if (shownRepoPath === repoPath) showNotice(NO_MAIN_TEXT);
    });
}

function showPickedRepo(): void {
  const startedMain = pendingMainId === null ? undefined : sessionUIs.get(pendingMainId);
  if (startedMain) {
    pendingMainId = null;
    setJSON(SHOWN_REPO_KEY, startedMain.path);
    showRepo(startedMain.path);
    return;
  }
  const knownPaths = repoChoices().map((choice) => choice.path);
  showRepo(pickedRepoPath(shownRepoPath, getJSON<string | null>(SHOWN_REPO_KEY, null), knownPaths));
}

function openStudioRepo(): void {
  openStudioRepoDialog((mainId) => {
    pendingMainId = mainId;
    refreshBoardSessionView();
  });
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
  const items = repoChoices().map((choice) => {
    const item = createPressable('bs-menu-item');
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(choice.path === shownRepoPath));
    item.append(el('span', 'bs-menu-name', choice.label), el('span', 'bs-menu-state', repoStateWordOf(choice.sessionIds.at(-1))));
    item.addEventListener('click', () => {
      closeMenu();
      setJSON(SHOWN_REPO_KEY, choice.path);
      showRepo(choice.path);
    });
    return item;
  });
  const openRepoItem = menuActionItem(OPEN_REPO_TEXT, 'board-session-open-repo', openStudioRepo);
  const orchestratorId = shownSessionId;
  const orchestratorItems = orchestratorId === null ? [] : [
    el('div', 'bs-menu-rule'),
    menuActionItem(RESTART_ORCHESTRATOR_TEXT, 'board-session-agent-restart', () => restartAgent(orchestratorId)),
    menuActionItem(ACCOUNT_TEXT, 'board-session-agent-account', () => openSwitchAccountDialog(orchestratorId)),
  ];
  parts.menu.replaceChildren(...items, openRepoItem, ...orchestratorItems);
  parts.menu.hidden = false;
  parts.menuOpener = opener;
  opener.setAttribute('aria-expanded', 'true');
}

function mountBoardSessionView(panel: HTMLElement): void {
  onStudioRepoRequested((repoPath) => {
    if (isActive) showRepo(repoPath);
  });
  const root = el('div', 'bs-root');
  const menu = el('div', 'bs-menu bs-card-menu bs-repo-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const presenceLayer = createPresenceLayer(boundsOfHostBox);
  const agentCards = createAgentCards({ address: addressAgent, restart: restartAgent, switchAccount: openSwitchAccountDialog, toggleOpened: toggleOpenedBranch, toggleRepoMenu, answer: answerAgentCard });
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
  dockSlot.dataset.boardIsland = '';
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
    if (!isActive || sessionId !== shownSessionId) return;
    if (watchedPaths().some(isUnaskedPath)) requestBoxes();
    paintChangesPeek();
  });
  panel.replaceChildren(root);
  const guest: BoardHostGuest = {
    chrome: topLeft,
    overlays: [notice, guide.element, dockSlot, agentCards.element, askCards.element, changesPeek.element, diffPanel.element],
    worldLayer: presenceLayer.element,
    markedBoxIds: () => changedBoxIds,
    firstViewArea,
    toggleStack: toggleFolder,
    onBoxClicked: addressBox,
    onPainted: (camera) => {
      hostCamera = camera;
      paintPresence();
      paintChangesPeek();
    },
  };
  parts = { root, menu, menuOpener: null, topLeft, noRepoChip, notice, dockSlot, presenceLayer, askCards, agentCards, changesPeek, diffPanel, guide, guest };
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) closeMenu();
  });
  document.addEventListener('pointerdown', (event) => {
    if (menu.hidden || !(event.target instanceof Node) || menu.contains(event.target) || parts?.menuOpener?.contains(event.target)) return;
    closeMenu();
  });
  onDirectorDigestKept((sessionId) => {
    if (isActive && (sessionId === shownSessionId || watchBySessionId.has(sessionId))) requestDigests();
  });
  onBoardSessionTraceChanged((sessionId) => {
    if (!isActive) return;
    watchBySessionId.get(sessionId)?.feed.refresh();
    if (shownBranchIds().includes(sessionId)) return dock?.refresh();
    if (sessionId !== shownSessionId) return;
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
  showPickedRepo();
  reopenSelectedBoard();
}

function deactivateBoardSessionView(): void {
  isActive = false;
  stopMapRetry();
  closeWatches();
  shownRepoPath = null;
  ensuredRepoPath = null;
  closeMenu();
  if (parts) leaveBoardHost(parts.guest);
}

function refreshBoardSessionView(): void {
  if (!isActive) return;
  showPickedRepo();
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
