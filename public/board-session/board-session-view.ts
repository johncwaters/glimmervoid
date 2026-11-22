import { folderToggleTargetOf } from '../whiteboard/folder-toggle-core.ts';
import '../whiteboard/whiteboard.css';
import './board-session.css';
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
import { createLineIcon } from '../svg-dom.ts';
import { createPressable } from '../ui/pressable.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { createBoardRenderer } from '../whiteboard/board-gl-renderer.ts';
import type { BoardRenderer, Camera } from '../whiteboard/board-gl-renderer.ts';
import { createBoardMediaLayer } from '../whiteboard/board-media-layer.ts';
import { onTilesChanged, showTilesFor, tiledBoardOf } from '../whiteboard/board-tile-store.ts';
import { onBoardSessionTraceChanged } from './board-session-signals.ts';
import { fittedCamera, freshnessTextOf, isBelowFloor, pickedRepoPath, readableFloorScale, repoChoicesOf, zoomedCamera } from './board-session-core.ts';
import { unionOf } from '#shared/whiteboard-route-core.ts';
import type { RepoChoice, RepoSession } from './board-session-core.ts';
import type { CodemapStatus } from '#shared/contracts/codemap.ts';
import type { TraceRecord } from '#shared/contracts/trace.ts';
import { createDock } from './dock.ts';
import { NO_PRESENCE, faceStatusTextOf, foldPresence, presencePathsOf } from './presence-core.ts';
import type { Presence } from './presence-core.ts';
import { asksOfSessions, createAskCards } from './ask-card.ts';
import type { AskCards } from './ask-card.ts';
import { createPresenceLayer } from './presence-layer.ts';
import type { PresenceLayer, SessionFace } from './presence-layer.ts';
import type { Dock, DockBranch } from './dock.ts';
import { branchSessionIdsOf } from './branch-core.ts';
import type { BoxChoice } from './branch-core.ts';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const BOXES_TIMEOUT_MS = 10000;
const TRACE_PAGE_TIMEOUT_MS = 10000;
const MAIN_ENSURE_TIMEOUT_MS = 15000;
const CLICK_SLOP_PX = 4;
const TITLE_SIZE_FALLBACK_PX = 16;
const WHEEL_ZOOM_STEP = 1.1;
const CARET_ICON_PATH = 'M4 6l4 4 4-4';
const FIT_ICON_PATH = 'M2.5 6V2.5H6 M10 2.5h3.5V6 M13.5 10v3.5H10 M6 13.5H2.5V10';
const NO_SESSION_TEXT = 'Start a session to see its repo on the code map.';
const SHOWN_REPO_KEY = 'glimmervoid.studio.repoPath';
const NO_MAP_TEXT = 'This session has no code map yet.';
const NO_MAIN_TEXT = 'The main agent for this repo did not start.';

interface SessionWatch {
  feed: ChatFeed;
  presence: Presence;
  lastBeat: ActivityBeat | null;
  subagents: readonly RunningSubagent[];
}

interface ViewParts {
  canvas: HTMLElement;
  viewport: HTMLElement;
  world: HTMLElement;
  renderer: BoardRenderer;
  chip: HTMLButtonElement;
  chipName: HTMLElement;
  freshness: HTMLElement;
  menu: HTMLElement;
  notice: HTMLElement;
  dockSlot: HTMLElement;
  presenceLayer: PresenceLayer;
  askCards: AskCards;
}

let parts: ViewParts | null = null;
let isActive = false;
let shownRepoPath: string | null = null;
let shownSessionId: string | null = null;
let ensuredRepoPath: string | null = null;
const mainSessionIdByRepoPath = new Map<string, string>();
let mapState: CodemapStatus | null = null;
let boardId: string | null = null;
let changedBoxIds: ReadonlySet<string> = new Set();
let camera: Camera = { x: 0, y: 0, scale: 1 };
let fittedBoardId: string | null = null;
let dock: Dock | null = null;
let boxesRequestSerial = 0;
let watchBySessionId = new Map<string, SessionWatch>();
let boxIdByPath: Readonly<Record<string, string>> = {};
let moduleChoices: readonly BoxChoice[] = [];

function repoChoices(): RepoChoice[] {
  const repoSessions: RepoSession[] = [...sessionUIs].flatMap(([id, ui]) => ui.branchOf ? [] : [{ id, path: ui.path }]);
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

function watchedPaths(): string[] {
  return [...new Set([...watchBySessionId.values()].flatMap((watch) => presencePathsOf(watch.presence)))];
}

function repoSessionIds(): string[] {
  if (shownRepoPath === null) return [];
  return [...sessionUIs].flatMap(([id, ui]) => ui.path === shownRepoPath ? [id] : []);
}

function closeWatches(): void {
  for (const watch of watchBySessionId.values()) watch.feed.close();
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
  };
  return watch;
}

function syncWatches(): void {
  const wantedIds = new Set(repoSessionIds());
  for (const [sessionId, watch] of watchBySessionId) {
    if (wantedIds.has(sessionId)) continue;
    watch.feed.close();
    watchBySessionId.delete(sessionId);
  }
  for (const sessionId of wantedIds) {
    if (watchBySessionId.has(sessionId)) continue;
    const watch = openWatch(sessionId);
    watchBySessionId.set(sessionId, watch);
    watch.feed.refresh();
  }
}

function addressFace(face: SessionFace): void {
  dock?.addressSession(face.sessionId, face.agentLabel);
}

function shownBranchIds(): string[] {
  if (shownSessionId === null) return [];
  return branchSessionIdsOf(sessionUIs, shownSessionId);
}

function dockBranchesOf(branchIds: readonly string[]): DockBranch[] {
  return branchIds.flatMap((branchId) => {
    const ui = sessionUIs.get(branchId);
    if (!ui?.branchOf) return [];
    return [{
      sessionId: branchId,
      name: sessionName(ui) || branchId.slice(0, 8),
      workingDirectory: sessionWorkingDirectoryOf(branchId) ?? ui.path,
      agentId: ui.agent ?? null,
      aboutTitle: ui.branchOf.aboutTitle,
      isTurnOver: () => chatPhaseOf(sessionUIs.get(branchId)?.currentState) !== 'working',
    }];
  });
}

function syncBranches(): void {
  dock?.setBranches(dockBranchesOf(shownBranchIds()));
}

function applyCamera(): void {
  if (!parts) return;
  parts.world.style.transform = `translate(${-camera.x * camera.scale}px, ${-camera.y * camera.scale}px) scale(${camera.scale})`;
  parts.renderer.setCamera(camera);
  paintAsks();
}

function paintAsks(): void {
  if (!parts) return;
  const renderer = parts.renderer;
  const board = boardId === null ? null : tiledBoardOf(boardId)?.board ?? null;
  const askingSessionIds = new Set(shownSessionId === null ? [] : [shownSessionId, ...shownBranchIds()]);
  parts.askCards.paint(boardId, asksOfSessions(board, askingSessionIds), (boxId) => renderer.boundsOf(boxId) ?? null, camera);
}

function sessionBoxIds(): string[] {
  const presence = presenceOf(shownSessionId);
  const presenceBoxIds = [presence.workedPath, ...presence.namedPaths].flatMap((presencePath) => boxIdOfPresencePath(presencePath) ?? []);
  return [...presenceBoxIds, ...changedBoxIds];
}

function fitWholeBoard(): void {
  if (!parts) return;
  const layout = parts.renderer.layout();
  if (!layout) return;
  const fitted = fittedCamera(layout.bounds, parts.viewport.clientWidth, parts.viewport.clientHeight, parts.dockSlot.offsetHeight);
  if (!fitted) return;
  camera = fitted;
  applyCamera();
}

function fitFirstView(): void {
  if (!parts) return;
  const renderer = parts.renderer;
  const layout = renderer.layout();
  if (!layout) return;
  const viewWidthPx = parts.viewport.clientWidth;
  const viewHeightPx = parts.viewport.clientHeight;
  const reservedBottomPx = parts.dockSlot.offsetHeight;
  const titleSizePx = Number.parseFloat(getComputedStyle(parts.viewport).getPropertyValue('--type-title')) || TITLE_SIZE_FALLBACK_PX;
  const floorScale = readableFloorScale(titleSizePx);
  const sessionBounds = unionOf(sessionBoxIds().flatMap((boxId) => renderer.boundsOf(boxId) ?? []));
  const isMapTooBig = isBelowFloor(layout.bounds, viewWidthPx, viewHeightPx, reservedBottomPx, floorScale);
  const target = isMapTooBig && sessionBounds ? sessionBounds : layout.bounds;
  const fitted = fittedCamera(target, viewWidthPx, viewHeightPx, reservedBottomPx, floorScale);
  if (!fitted) return;
  camera = fitted;
  applyCamera();
}

function showNotice(text: string | null): void {
  if (!parts) return;
  parts.notice.hidden = text === null;
  parts.notice.textContent = text ?? '';
}

function paintBoard(): void {
  if (!parts || !isActive || boardId === null) return;
  const tiled = tiledBoardOf(boardId);
  if (!tiled) return;
  parts.renderer.renderLayout(tiled.layout, tiled.blocks);
  parts.renderer.setReviewMarks({ worthALookIds: new Set(), flaggedStepIds: new Set(), agentChangedIds: changedBoxIds });
  paintPresence();
  if (fittedBoardId === boardId) return;
  fittedBoardId = boardId;
  fitFirstView();
}

function boxIdOfPresencePath(presencePath: string | null): string | null {
  if (presencePath === null) return null;
  return boxIdByPath[presencePath] ?? null;
}

function sessionFaceOf(sessionId: string, watch: SessionWatch): SessionFace | null {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return null;
  const phase = phaseOfSession(sessionId);
  return {
    sessionId,
    boxId: ui.branchOf ? ui.branchOf.aboutBoxId : boxIdOfPresencePath(watch.presence.workedPath),
    agentId: ui.agent ?? null,
    agentLabel: sessionName(ui) || sessionId.slice(0, 8),
    isMain: sessionId === shownSessionId,
    isBranch: Boolean(ui.branchOf),
    phase,
    statusText: faceStatusTextOf(phase, watch.lastBeat),
    subagents: phase === 'working' || phase === 'monitoring' ? watch.subagents : [],
  };
}

function paintPresence(): void {
  if (!parts || boardId === null) return;
  const namedPaths = presenceOf(shownSessionId).namedPaths;
  const glowingBoxIds = [...new Set(namedPaths.flatMap((namedPath) => boxIdOfPresencePath(namedPath) ?? []))];
  const faces = [...watchBySessionId].flatMap(([sessionId, watch]) => sessionFaceOf(sessionId, watch) ?? []);
  parts.presenceLayer.paint({ glowingBoxIds, faces }, tiledBoardOf(boardId)?.board ?? null);
  paintAsks();
}

function toggleFolderAt(point: { x: number; y: number }): void {
  if (!parts || boardId === null || shownSessionId === null) return;
  const folderBoxId = folderToggleTargetOf(parts.renderer.hitTest(point), tiledBoardOf(boardId)?.board ?? null);
  if (folderBoxId === null) return;
  sendControlRequest('codemap-folder-toggle', { id: shownSessionId, boxId: folderBoxId }, { timeoutMs: BOXES_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type !== 'codemap-folder-toggle-result' || reply.ok) return;
      showNotice(reply.error ?? NO_MAP_TEXT);
    })
    .catch(() => showNotice(NO_MAP_TEXT));
}

function notePresenceRecords(sessionId: string, appendedRecords: readonly TraceRecord[]): void {
  const watch = watchBySessionId.get(sessionId);
  if (!watch) return;
  const workingDirectory = sessionWorkingDirectoryOf(sessionId) ?? sessionUIs.get(sessionId)?.path ?? null;
  const nextPresence = foldPresence(watch.presence, appendedRecords, workingDirectory);
  const hasNewPath = presencePathsOf(nextPresence).some((presencePath) => !(presencePath in boxIdByPath));
  watch.presence = nextPresence;
  if (hasNewPath) {
    requestBoxes();
    return;
  }
  paintPresence();
}

function paintChip(): void {
  if (!parts) return;
  parts.chipName.textContent = repoChoices().find((choice) => choice.path === shownRepoPath)?.label ?? 'No repo';
  parts.freshness.hidden = mapState === null;
  if (mapState === null) return;
  parts.freshness.dataset.state = mapState.state;
  parts.freshness.textContent = freshnessTextOf(mapState);
}

function requestBoxes(): void {
  if (shownSessionId === null) return;
  const sessionId = shownSessionId;
  boxesRequestSerial += 1;
  const serial = boxesRequestSerial;
  sendControlRequest('codemap-boxes-of', { id: sessionId, paths: watchedPaths() }, { timeoutMs: BOXES_TIMEOUT_MS })
    .then((reply) => {
      if (serial !== boxesRequestSerial || reply.type !== 'codemap-boxes-of-response') return;
      if (!reply.ok) return showNotice(reply.error ?? NO_MAP_TEXT);
      if (reply.boardId === null) return showNotice(NO_MAP_TEXT);
      showNotice(null);
      changedBoxIds = new Set(reply.changedBoxIds);
      mapState = reply.mapState;
      paintChip();
      boxIdByPath = { ...boxIdByPath, ...reply.boxIdByPath };
      moduleChoices = reply.boxChoices;
      const isNewBoard = boardId !== reply.boardId;
      boardId = reply.boardId;
      if (isNewBoard) parts?.renderer.resendView();
      paintBoard();
    })
    .catch(() => {
      if (serial === boxesRequestSerial) showNotice(NO_MAP_TEXT);
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
    name: ui ? sessionName(ui) : sessionId.slice(0, 8),
    workingDirectory: sessionWorkingDirectoryOf(sessionId) ?? ui?.path ?? null,
    agentId: ui?.agent ?? null,
    isTurnOver: () => chatPhaseOf(sessionUIs.get(sessionId)?.currentState) !== 'working',
    phase: () => phaseOfSession(sessionId),
    boxChoices: () => moduleChoices,
  });
  parts.dockSlot.append(dock.element);
  syncBranches();
}

function showSession(sessionId: string | null): void {
  const isSameSession = sessionId === shownSessionId;
  shownSessionId = sessionId;
  if (!isSameSession) mapState = null;
  paintChip();
  if (sessionId === null) {
    boardId = null;
    parts?.renderer.clear();
    mountDock();
    showNotice(NO_SESSION_TEXT);
    return;
  }
  if (!isSameSession) {
    changedBoxIds = new Set();
    boxIdByPath = {};
    moduleChoices = [];
    mountDock();
  }
  requestBoxes();
}

function closeMenu(): void {
  if (!parts) return;
  parts.menu.hidden = true;
  parts.chip.setAttribute('aria-expanded', 'false');
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
  const knownPaths = repoChoices().map((choice) => choice.path);
  showRepo(pickedRepoPath(shownRepoPath, getJSON<string | null>(SHOWN_REPO_KEY, null), knownPaths));
}

function openMenu(): void {
  if (!parts) return;
  const items = repoChoices().map((choice) => {
    const item = createPressable('bs-menu-item');
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(choice.path === shownRepoPath));
    item.append(el('span', 'bs-menu-name', choice.label));
    item.addEventListener('click', () => {
      closeMenu();
      setJSON(SHOWN_REPO_KEY, choice.path);
      showRepo(choice.path);
    });
    return item;
  });
  parts.menu.replaceChildren(...items);
  parts.menu.hidden = false;
  parts.chip.setAttribute('aria-expanded', 'true');
}

function wireCameraGestures(viewport: HTMLElement): void {
  viewport.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = viewport.getBoundingClientRect();
      camera = zoomedCamera(camera, event.clientX - rect.left, event.clientY - rect.top, event.deltaY > 0 ? 1 / WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP);
      return applyCamera();
    }
    camera = { ...camera, x: camera.x + event.deltaX / camera.scale, y: camera.y + event.deltaY / camera.scale };
    applyCamera();
  }, { passive: false });
  let dragFrom: { x: number; y: number } | null = null;
  let pressFrom: { x: number; y: number } | null = null;
  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragFrom = { x: event.clientX, y: event.clientY };
    pressFrom = dragFrom;
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!dragFrom) return;
    if (pressFrom && Math.hypot(event.clientX - pressFrom.x, event.clientY - pressFrom.y) > CLICK_SLOP_PX) pressFrom = null;
    camera = { ...camera, x: camera.x - (event.clientX - dragFrom.x) / camera.scale, y: camera.y - (event.clientY - dragFrom.y) / camera.scale };
    dragFrom = { x: event.clientX, y: event.clientY };
    applyCamera();
  });
  const endDrag = () => {
    dragFrom = null;
    pressFrom = null;
  };
  viewport.addEventListener('pointerup', (event) => {
    const wasClick = pressFrom !== null;
    endDrag();
    if (!wasClick) return;
    const rect = viewport.getBoundingClientRect();
    toggleFolderAt({ x: camera.x + (event.clientX - rect.left) / camera.scale, y: camera.y + (event.clientY - rect.top) / camera.scale });
  });
  viewport.addEventListener('pointercancel', endDrag);
}

function mountBoardSessionView(panel: HTMLElement): void {
  const root = el('div', 'bs-root');
  const canvas = el('div', 'wb-canvas bs-canvas');
  const viewport = el('div', 'wb-viewport');
  viewport.setAttribute('role', 'application');
  viewport.setAttribute('aria-label', 'Session board');
  const world = el('div', 'wb-world');
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'wb-svg');
  svg.setAttribute('aria-hidden', 'true');
  const mediaLayer = createBoardMediaLayer({
    onEscapeFromPage: () => viewport.focus(),
    onZoomFromPage: () => {},
    onPanFromPage: (deltaX, deltaY) => {
      camera = { ...camera, x: camera.x + deltaX / camera.scale, y: camera.y + deltaY / camera.scale };
      applyCamera();
    },
  });
  world.append(svg, mediaLayer.element);
  const glCanvas = el('canvas', 'wb-gl');
  glCanvas.setAttribute('aria-hidden', 'true');
  const glNotice = el('p', 'wb-gl-notice');
  glNotice.setAttribute('role', 'status');
  glNotice.hidden = true;
  viewport.append(glCanvas, world);

  const chip = createPressable('bs-chip');
  chip.setAttribute('aria-haspopup', 'menu');
  chip.setAttribute('aria-expanded', 'false');
  chip.dataset.action = 'board-session-repo';
  const chipName = el('span', 'bs-chip-name');
  chip.append(chipName, createLineIcon(CARET_ICON_PATH, '1.5'));
  chip.addEventListener('click', () => {
    if (parts?.menu.hidden === false) return closeMenu();
    openMenu();
  });
  const fitButton = createPressable('bs-fit');
  fitButton.setAttribute('aria-label', 'Fit');
  fitButton.dataset.action = 'board-session-fit';
  fitButton.append(createLineIcon(FIT_ICON_PATH, '1.5'));
  fitButton.addEventListener('click', fitWholeBoard);
  const menu = el('div', 'bs-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const topLeft = el('div', 'bs-top-left');
  const freshness = el('span', 'bs-fresh');
  freshness.setAttribute('role', 'status');
  freshness.hidden = true;
  topLeft.append(chip, freshness, fitButton, menu);
  const notice = el('p', 'bs-notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const dockSlot = el('div', 'bs-dock-slot');
  canvas.append(viewport, topLeft, notice, dockSlot, glNotice);
  root.append(canvas);
  panel.replaceChildren(root);

  const renderer = createBoardRenderer({
    canvas: glCanvas,
    viewport,
    fontSource: svg,
    mediaLayer,
    notice: glNotice,
    onViewChange: (view, scale) => {
      if (isActive && boardId !== null) showTilesFor(boardId, view, scale);
    },
  });
  const presenceLayer = createPresenceLayer(renderer, addressFace);
  world.append(presenceLayer.element);
  canvas.append(presenceLayer.roster);
  const askCards = createAskCards();
  viewport.append(askCards.element);
  parts = { canvas, viewport, world, renderer, chip, chipName, freshness, menu, notice, dockSlot, presenceLayer, askCards };
  wireCameraGestures(viewport);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) closeMenu();
  });
  document.addEventListener('pointerdown', (event) => {
    if (menu.hidden || !(event.target instanceof Node) || topLeft.contains(event.target)) return;
    closeMenu();
  });
  onTilesChanged(paintBoard);
  onBoardSessionTraceChanged((sessionId) => {
    if (!isActive) return;
    watchBySessionId.get(sessionId)?.feed.refresh();
    if (shownBranchIds().includes(sessionId)) return dock?.refresh();
    if (sessionId !== shownSessionId) return;
    dock?.refresh();
    requestBoxes();
  });
  applyCamera();
}

function activateBoardSessionView(): void {
  isActive = true;
  showPickedRepo();
  parts?.renderer.resendView();
  paintBoard();
}

function deactivateBoardSessionView(): void {
  isActive = false;
  closeWatches();
  shownRepoPath = null;
  ensuredRepoPath = null;
  closeMenu();
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
