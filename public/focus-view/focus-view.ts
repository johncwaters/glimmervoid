import { borrowCard, getBorrowedCardId, releaseCard } from '../card-host.ts';
import { wireColumnResizer } from '../column-resizer.ts';
import { el } from '../dom-helpers.ts';
import { renderStatusLegend } from '../status-legend.ts';
import { showFirstRunChecklist } from '../onboarding/first-run-loader.ts';
import { getRestorableSessionId, isSessionShown, quickAddSession, readSessionRows, requestSessionOpen, requestSessionRemoval, selectSession, undoPendingClose } from '../session-actions.ts';
import { markSessionSeen } from '../session-card/lifecycle.ts';
import type { ActivityRenderKind } from '../session-card/activity.ts';
import { addActivityRenderer, pulseActivityGlyph } from '../session-card/activity.ts';
import { buildNextAttentionKeys, setBoardSplitKeyClaimTest, SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { railAriaKeyShortcuts } from '../shortcuts-core.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionIdOf, sessionUIs } from '../session-card/card-registry.ts';
import { placeRowsInOrder, writeAttributeIfChanged, writeHiddenIfChanged, writeTextIfChanged } from '../status-paint.ts';
import { onLiveSessionTick, sessionElapsedText } from '../session-card/session-tick.ts';
import { setTerminalActiveViewer } from '../session-card/terminal.ts';
import { getRailWidth, getSplitBoardBySession, isRailStatusKeyOpen, setRailStatusKeyOpen, setRailWidth, setSplitBoardBySession } from '../ui-prefs.ts';
import { uiState } from '../ui-state-core.ts';
import type { AttentionTile, SessionRow } from './attention-core.ts';
import { canDropRow, countAttentionByKind, dropAnchorId, orderAttentionLine, orderRoster, pickAdjacent, sessionOrderAfterDrop, sessionOrderOf } from './attention-core.ts';
import type { ProjectBoards, RosterGroup, SplitBoardBySession } from './roster-groups-core.ts';
import { boardsByProject, closeSplit, connectionKeysOf, groupRoster, liveSplits, newestFreeBoardOf, openSplit, splitNewConnections, splitsOfBoards, visibleOrder, withBoardProjects } from './roster-groups-core.ts';
import { raceGroupOf, subscribeRaces } from '../arena/race-store.ts';
import type { SessionGroupHeader } from './roster-group-header.ts';
import { buildSessionGroupHeader, paintSessionGroupHeader } from './roster-group-header.ts';
import { buildAttentionBanner, buildAttentionLedger, paintAttentionBanner, paintAttentionLedger, pressAttentionBanner, sendAttentionTileToRow, tetherAttentionTile } from '../attention-banner.ts';
import { buildSessionRow, paintBoardRow, paintSessionRow, paintSessionRowSplit, wrapSessionRow } from '../session-row.ts';
import { describeFailure } from '../client-error-core.ts';
import { reportToServerLog, sendControlRequest } from '../control-ws.ts';
import { mergeSettingsPayload, settingsPayloadSnapshot, subscribeSettings } from '../settings/settings-store.ts';
import type { BoardSummary } from '#shared/contracts/whiteboard.ts';
import { beginPendingBoardDelete, boardSummariesOf, boardsConnectedTo, connectSessionToBoard, detachBoardFromSession, isBoardDeleting, onBoardListChanged, pendingBoardDeleteStartedAt, takeOpenBoardRequest, undoPendingBoardDelete } from '../whiteboard/board-store.ts';
import type { Pane } from '#shared/contracts/focus-layout.ts';
import type { PaneLayout } from './pane-layout.ts';
import { createPaneLayout } from './pane-layout.ts';
import { registerSessionPages } from '../session-pages/pages.ts';
import type { SessionPageHost } from '../session-pages/session-pages.ts';
import { closeSessionPage, createSessionPageButtons, openSessionPage, releaseSessionPageHost, setSessionPageHost } from '../session-pages/session-pages.ts';
import { placeHostHeaders } from '../hosts/host-headers.ts';
import { hostGroupOf } from '../hosts/session-hosts.ts';

type RosterRow = SessionRow<SessionUi, string | null>;

type BoardsViewModule = typeof import('../whiteboard/boards-view.ts');

const TERMINAL_ONLY: ReadonlySet<Pane> = new Set<Pane>(['terminal']);
const TERMINAL_AND_BOARD: ReadonlySet<Pane> = new Set<Pane>(['terminal', 'board']);
const BOARD_ONLY: ReadonlySet<Pane> = new Set<Pane>(['board']);

const projectPathOf = (row: RosterRow) => row.ui.path;
const hostOfRow = (row: RosterRow) => hostGroupOf(row.id);

type FocusPill = ReturnType<typeof buildPill>;

type BoardRow = ReturnType<typeof buildBoardRow>;

type ArchivedFold = ReturnType<typeof buildArchivedFold>;

const BOARD_ROW_MIME = 'application/x-glimmervoid-board-row';
const SESSION_ROW_MIME = 'application/x-glimmervoid-session-row';

type GroupList = HTMLDivElement & { _lastOrderKey?: string };

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

let railEl: HTMLElement | null = null;
let railHeadEl: HTMLElement | null = null;
let railLedgerEl: HTMLElement | null = null;
let centerEl: HTMLElement | null = null;
let cardSlotEl: HTMLElement | null = null;
let paneLayout: PaneLayout | null = null;
let pageButtons: ReturnType<typeof createSessionPageButtons> | null = null;
let boardsViewLoad: Promise<BoardsViewModule> | null = null;
let loadedBoardsView: BoardsViewModule | null = null;
let shownBoardKey: string | null = null;
let shownPanes: ReadonlySet<Pane> | null = null;
let centeredBoardId: string | null = null;
let splitBoardBySession: SplitBoardBySession = getSplitBoardBySession();
let knownConnectionKeys: ReadonlySet<string> | null = null;
let activePane: Pane = 'terminal';
let unsplitSlotEl: HTMLElement | null = null;
const boardRowById = new Map<string, BoardRow>();
const archivedFoldByProject = new Map<string, ArchivedFold>();
let emptyEl: HTMLElement | null = null;
let emptyTitleEl: HTMLElement | null = null;
let emptyDescEl: HTMLElement | null = null;

let active = false;
let isAttentionJumpActivating = false;
let attentionJumpTargetId: string | null = null;
const mergeStatusById = new Map<string, string>();
const pillById = new Map<string, FocusPill>();

const groupListById = new Map<string, GroupList>();
const groupHeaderById = new Map<string, SessionGroupHeader>();

let railTabStopId: string | null = null;
let lastGroupOrderKey = '';
let lastRailOrder: string[] = [];
let draggedSessionId: string | null = null;
let rosterRowById = new Map<string, RosterRow>();
let rosterGroupKeyBySessionId = new Map<string, string>();

const NO_COLLAPSED = new Set<string>();
function railVisibleIds() { return visibleOrder(groupsOf(orderedSessions()), NO_COLLAPSED); }

function setRailTabStop(id: string | null) {
  const prev = railTabStopId;
  railTabStopId = id || null;
  if (prev && prev !== railTabStopId) {
    const p = pillById.get(prev);
    if (p) { p.tabIndex = -1; p.setAttribute('aria-selected', 'false'); }
  }
  if (railTabStopId) {
    const n = pillById.get(railTabStopId);
    if (n) { n.tabIndex = 0; n.setAttribute('aria-selected', 'true'); }
  }
}

function groupsOf(order: RosterRow[]) {
  return groupRoster(order, projectPathOf, raceGroupOf, hostOfRow);
}

function firstGroupHeaderOf(groups: readonly RosterGroup<RosterRow>[], hostId: string | null): HTMLElement | null {
  const firstGroup = groups.find((group) => group.hostId === hostId);
  return firstGroup ? groupHeaderById.get(firstGroup.key)?.header ?? null : null;
}

function ensureGroup(group: RosterGroup<RosterRow>) {
  let groupHeader = groupHeaderById.get(group.key);
  let list = groupListById.get(group.key);
  if (!groupHeader || !list) {
    groupHeader = buildSessionGroupHeader({
      onAdd: quickAddSession,
    });
    list = el('div', 'focus-rail-list');
    list.setAttribute('role', 'listbox');
    groupHeaderById.set(group.key, groupHeader);
    groupListById.set(group.key, list);
  }
  paintSessionGroupHeader(groupHeader, group);
  writeAttributeIfChanged(list, 'aria-label', `${group.label} sessions`);
  return { header: groupHeader.header, list };
}

export function isFocusActive() { return active; }

export function getFocusedSessionId() { return uiState.snapshot().focusedSessionId; }

export function mountFocusView({ rail, center, resizer }: { rail: HTMLElement | null; center: HTMLElement | null; resizer: HTMLElement | null }) {
  railEl = rail;
  centerEl = center;
  if (!railEl || !centerEl) return;
  const mountedRail = railEl;
  const mountedCenter = centerEl;
  wireRailResizer(resizer);

  mountedRail.removeAttribute('role');
  mountedRail.removeAttribute('aria-label');
  mountedRail.setAttribute('aria-keyshortcuts', railAriaKeyShortcuts(SHORTCUT_PLATFORM));

  railHeadEl = buildAttentionBanner({
    onJump: focusNextAttention,
    rowFor: (id) => pillById.get(id),
  }, buildNextAttentionKeys());

  const statusKey = el('details', 'rail-section rail-status-key');
  statusKey.append(el('summary', 'rail-section-summary', 'Status key'), renderStatusLegend());
  rememberOpenState(statusKey, isRailStatusKeyOpen(), setRailStatusKeyOpen);
  railLedgerEl = buildAttentionLedger(focusSession);
  mountedRail.append(railHeadEl, railLedgerEl, statusKey);

  emptyEl = el('div', 'focus-empty');
  emptyEl.innerHTML = '<p class="focus-empty-title"></p>'
    + '<p class="focus-empty-desc"></p>';
  emptyTitleEl = emptyEl.querySelector<HTMLElement>('.focus-empty-title');
  emptyDescEl = emptyEl.querySelector<HTMLElement>('.focus-empty-desc');

  paneLayout = createPaneLayout();
  cardSlotEl = paneLayout.bodyOf('terminal');
  paneLayout.bodyOf('board').tabIndex = -1;
  paneLayout.onBoardDrag(paintUnsplitSlot);
  unsplitSlotEl = el('div', 'rail-unsplit-slot', 'Drop here to unsplit');
  registerSessionPages();
  pageButtons = createSessionPageButtons({ style: 'header' });
  paneLayout.trailSlot.append(pageButtons.element);
  mountedCenter.append(emptyEl, paneLayout.element);
  mountedCenter.addEventListener('focusin', onCenterFocusIn);
  subscribeRaces(() => {
    if (active) refreshFocusRoster();
  });
  onBoardListChanged(() => {
    if (!active) return;
    const wasBoardCentered = centeredBoardId !== null;
    refreshFocusRoster();
    if (wasBoardCentered && centeredBoardId === null) restoreFocusedSession();
  });

  mountedRail.addEventListener('keydown', onRailKeydown);
  mountedRail.addEventListener('dragover', onRailDragOver);
  mountedRail.addEventListener('drop', onRailDrop);
}

function noteBoardConnections() {
  const summaries = boardSummariesOf();
  const splitsOfExistingBoards = splitsOfBoards(splitBoardBySession, summaries);
  saveSplits(knownConnectionKeys ? splitNewConnections(splitsOfExistingBoards, summaries, knownConnectionKeys, isLiveSession) : splitsOfExistingBoards);
  knownConnectionKeys = connectionKeysOf(summaries);
}
onBoardListChanged(noteBoardConnections);

function isLiveSession(sessionId: string) {
  return sessionUIs.has(sessionId);
}

function saveSplits(nextSplits: SplitBoardBySession) {
  if (nextSplits === splitBoardBySession) return;
  splitBoardBySession = nextSplits;
  setSplitBoardBySession(nextSplits);
}

function currentLiveSplits() {
  return liveSplits(splitBoardBySession, boardSummariesOf(), isLiveSession);
}

function splitBoardIdOf(sessionId: string | null): string | null {
  if (!sessionId) return null;
  return currentLiveSplits()[sessionId] ?? null;
}

function onCenterFocusIn(event: FocusEvent) {
  const pane = event.target instanceof Element ? event.target.closest<HTMLElement>('.pane-group')?.dataset.pane : undefined;
  if ((pane !== 'terminal' && pane !== 'board') || pane === activePane) return;
  activePane = pane;
  const focusedId = getFocusedSessionId();
  const focusedPill = focusedId ? pillById.get(focusedId) : undefined;
  if (focusedId && focusedPill) paintPillSplit(focusedPill, focusedId, boardTitlesById());
}

function isBoardHeaderDragging() {
  return paneLayout?.element.hasAttribute('data-dragging') === true;
}

function paintUnsplitSlot() {
  if (!unsplitSlotEl) return;
  const focusedId = getFocusedSessionId();
  const focusedRow = focusedId && splitBoardIdOf(focusedId) ? pillById.get(focusedId)?._row : undefined;
  if (!isBoardHeaderDragging() || !focusedRow) {
    unsplitSlotEl.removeAttribute('data-over');
    unsplitSlotEl.remove();
    return;
  }
  if (focusedRow.nextElementSibling !== unsplitSlotEl) focusedRow.after(unsplitSlotEl);
}

function isUnsplitDrag() {
  return isBoardHeaderDragging() && unsplitSlotEl?.isConnected === true;
}

function onRailDragOver(event: DragEvent) {
  if (!isUnsplitDrag()) return;
  event.preventDefault();
  unsplitSlotEl?.toggleAttribute('data-over', true);
}

function onRailDrop(event: DragEvent) {
  const focusedId = getFocusedSessionId();
  if (!isUnsplitDrag() || !focusedId) return;
  event.preventDefault();
  activePane = 'terminal';
  closeOperatorSplit(focusedId);
  refreshFocusRoster();
  focusTerminalAfterSettle(sessionUIs.get(focusedId), focusedId);
}

function boardSplitToggleOf(sessionId: string | null) {
  if (!active || !sessionId || centeredBoardId) return null;
  const splits = currentLiveSplits();
  if (Object.hasOwn(splits, sessionId)) return { sessionId, boardIdToOpen: null };
  const board = newestFreeBoardOf(splits, boardsConnectedTo(sessionId));
  return board ? { sessionId, boardIdToOpen: board.id } : null;
}

setBoardSplitKeyClaimTest(() => boardSplitToggleOf(getFocusedSessionId()) !== null);

export function toggleFocusedBoardSplit(): boolean {
  const toggle = boardSplitToggleOf(getFocusedSessionId());
  if (!toggle) return false;
  if (toggle.boardIdToOpen) {
    openOperatorSplit(toggle.sessionId, toggle.boardIdToOpen);
    refreshFocusRoster();
    return true;
  }
  activePane = 'terminal';
  closeOperatorSplit(toggle.sessionId);
  refreshFocusRoster();
  focusTerminalAfterSettle(sessionUIs.get(toggle.sessionId), toggle.sessionId);
  return true;
}

function splitSessionWithBoard(sessionId: string, boardId: string) {
  const board = boardSummariesOf().find((summary) => summary.id === boardId);
  if (!board || !sessionUIs.has(sessionId)) return;
  openOperatorSplit(sessionId, boardId);
  if (getFocusedSessionId() === sessionId) {
    refreshFocusRoster();
    return;
  }
  focusSession(sessionId);
}

function openOperatorSplit(sessionId: string, boardId: string) {
  const nextSplits = openSplit(splitBoardBySession, sessionId, boardId);
  for (const [displacedSessionId, displacedBoardId] of Object.entries(splitBoardBySession)) {
    if (displacedSessionId !== sessionId && nextSplits[displacedSessionId] !== displacedBoardId) detachBoardFromSession(displacedBoardId, displacedSessionId).then(reportBoardAttachmentRefusal);
  }
  connectSessionToBoard(boardId, sessionId).then(reportBoardAttachmentRefusal);
  saveSplits(nextSplits);
}

function closeOperatorSplit(sessionId: string) {
  const closedBoardId = splitBoardBySession[sessionId];
  saveSplits(closeSplit(splitBoardBySession, sessionId));
  if (closedBoardId) detachBoardFromSession(closedBoardId, sessionId).then(reportBoardAttachmentRefusal);
}

function reportBoardAttachmentRefusal(outcome: Awaited<ReturnType<typeof connectSessionToBoard>>) {
  if (!outcome.ok) reportToServerLog('focus', `changing the board beside a session failed: ${outcome.error}`);
}

const RAIL_BOUNDS = { minPx: 280, maxPx: 480 };
const RAIL_KEY_STEP_PX = 16;

function wireRailResizer(resizer: HTMLElement | null) {
  if (!resizer || !railEl) return;
  wireColumnResizer({
    resizer,
    column: railEl,
    widthHost: railEl,
    widthProperty: '--rail-width',
    bounds: RAIL_BOUNDS,
    keyStepPx: RAIL_KEY_STEP_PX,
    getStoredWidth: getRailWidth,
    setStoredWidth: setRailWidth,
  });
}

function onRailKeydown(e: KeyboardEvent) {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const target = e.target instanceof HTMLElement ? e.target : null;
    const id = target?.dataset.id;
    if (!id || pillById.get(id) !== target) return;
    e.preventDefault();
    requestSessionRemoval(id);
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;

  const rows = railRowsInOrder();
  const currentRow = rows.find((row) => row === e.target) ?? (railTabStopId ? pillById.get(railTabStopId) : null);
  const currentIndex = currentRow ? rows.indexOf(currentRow) : -1;
  const nextIndex = pickAdjacent(rows.map((_, index) => String(index)), currentIndex === -1 ? null : String(currentIndex), e.key === 'ArrowDown' ? 1 : -1);
  const nextRow = nextIndex == null ? null : rows[Number(nextIndex)];
  if (!nextRow) return;
  e.preventDefault();
  if (nextRow.dataset.id) setRailTabStop(nextRow.dataset.id);
  nextRow.focus();
}

function railRowsInOrder() {
  if (!railEl) return [];
  return [...railEl.querySelectorAll<HTMLElement>('button.session-row[data-id], button.session-row[data-board-id]')].filter((row) => !row.closest('details:not([open])'));
}

function orderedSessions() {
  return orderRoster(readSessionRows(sessionName), savedSessionOrder());
}

function savedSessionOrder(): string[] {
  return sessionOrderOf(settingsPayloadSnapshot());
}

export function forgetSessionInSavedOrder(sessionId: string) {
  const sessionOrder = savedSessionOrder();
  if (!sessionOrder.includes(sessionId)) return;
  mergeSettingsPayload({ sessionOrder: sessionOrder.filter((id) => id !== sessionId) });
}

export function saveSessionOrder(nextSessionOrder: string[], repaint: () => void) {
  const previousSessionOrder = savedSessionOrder();
  const applySessionOrder = (sessionOrder: string[]) => {
    mergeSettingsPayload({ sessionOrder });
    repaint();
  };
  applySessionOrder(nextSessionOrder);
  sendControlRequest('update-settings', { settings: { sessionOrder: nextSessionOrder } })
    .then((message) => {
      if (message.type === 'settings-error') applySessionOrder(previousSessionOrder);
    })
    .catch(() => applySessionOrder(previousSessionOrder));
}

subscribeSettings((change) => {
  if (change.kind === 'broadcast') refreshFocusRoster();
});

function sessionName(ui: SessionUi): string | null {
  return ui.nameEl ? ui.nameEl.textContent : (ui.card ? (ui.card.dataset.session || ui.card.dataset.id || '') : '');
}

function buildPill(id: string) {
  const { row: pill, refs } = buildSessionRow();
  pill.dataset.id = id;
  pill.setAttribute('role', 'option');
  pill.addEventListener('click', (event) => onPillPick(id, memberPaneOf(event.target)));
  pill.addEventListener('pointerenter', () => { if (railHeadEl) tetherAttentionTile(railHeadEl, id); });
  pill.addEventListener('pointerleave', () => { if (railHeadEl) tetherAttentionTile(railHeadEl, null); });

  const { item, removeButton } = wrapSessionRow(pill, 'Remove session', () => requestSessionRemoval(id), () => undoPendingClose(id));
  item.setAttribute('role', 'presentation');
  removeButton.tabIndex = -1;
  wireBoardRowDropTarget(item, id);
  wireSessionRowDrag(pill, item, id);
  return Object.assign(pill, { _refs: refs, _row: item });
}

function memberPaneOf(target: EventTarget | null): Pane {
  const member = target instanceof Element ? target.closest<HTMLElement>('[data-member]')?.dataset.member : undefined;
  return member === 'board' ? 'board' : 'terminal';
}

function startBoardRowDrag(event: DragEvent, boardId: string) {
  event.dataTransfer?.setData(BOARD_ROW_MIME, boardId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'link';
}

function isBoardRowDrag(event: DragEvent) {
  return event.dataTransfer?.types.includes(BOARD_ROW_MIME) === true;
}

function wireBoardRowDropTarget(item: HTMLElement, sessionId: string) {
  item.addEventListener('dragover', (event) => {
    if (!isBoardRowDrag(event)) return;
    event.preventDefault();
    item.toggleAttribute('data-board-drop', true);
  });
  item.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && item.contains(event.relatedTarget)) return;
    item.removeAttribute('data-board-drop');
  });
  item.addEventListener('drop', (event) => {
    item.removeAttribute('data-board-drop');
    const boardId = event.dataTransfer?.getData(BOARD_ROW_MIME);
    if (!boardId) return;
    event.preventDefault();
    splitSessionWithBoard(sessionId, boardId);
  });
}

function isSessionRowDrag(event: DragEvent) {
  return draggedSessionId !== null && event.dataTransfer?.types.includes(SESSION_ROW_MIME) === true;
}

function canDropSessionOn(targetId: string) {
  const draggedRow = draggedSessionId ? rosterRowById.get(draggedSessionId) : undefined;
  const targetRow = rosterRowById.get(targetId);
  if (!draggedRow || !targetRow) return false;
  return canDropRow(draggedRow, targetRow, (row) => rosterGroupKeyBySessionId.get(row.id) ?? '', new Set(rosterRowById.keys()));
}

function dropSideAt(item: HTMLElement, event: DragEvent): 'before' | 'after' {
  const rect = item.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function railRowsInRailOrder() {
  return lastRailOrder.flatMap((id) => rosterRowById.get(id) ?? []);
}

function clearSessionDropMarker() {
  for (const marked of railEl?.querySelectorAll<HTMLElement>('.session-row-item[data-drop-target]') ?? []) delete marked.dataset.dropTarget;
}

function markSessionDrop(targetId: string, side: 'before' | 'after') {
  const anchorItem = pillById.get(dropAnchorId(railRowsInRailOrder(), targetId, side))?._row;
  if (anchorItem?.dataset.dropTarget === side) return;
  clearSessionDropMarker();
  if (anchorItem) anchorItem.dataset.dropTarget = side;
}

function wireSessionRowDrag(pill: HTMLElement, item: HTMLElement, sessionId: string) {
  pill.draggable = true;
  let pressedPane: Pane = 'terminal';
  pill.addEventListener('mousedown', (event) => { pressedPane = memberPaneOf(event.target); });
  pill.addEventListener('dragstart', (event) => {
    const splitBoardId = pressedPane === 'board' ? splitBoardIdOf(sessionId) : null;
    if (splitBoardId) {
      startBoardRowDrag(event, splitBoardId);
      return;
    }
    draggedSessionId = sessionId;
    event.dataTransfer?.setData(SESSION_ROW_MIME, sessionId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  pill.addEventListener('dragend', () => {
    draggedSessionId = null;
    clearSessionDropMarker();
  });
  item.addEventListener('dragover', (event) => {
    if (!isSessionRowDrag(event) || !canDropSessionOn(sessionId)) return;
    event.preventDefault();
    markSessionDrop(sessionId, dropSideAt(item, event));
  });
  item.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && railEl?.contains(event.relatedTarget)) return;
    clearSessionDropMarker();
  });
  item.addEventListener('drop', (event) => {
    clearSessionDropMarker();
    if (!isSessionRowDrag(event) || !canDropSessionOn(sessionId) || !draggedSessionId) return;
    event.preventDefault();
    saveSessionOrder(sessionOrderAfterDrop(railRowsInRailOrder(), savedSessionOrder(), draggedSessionId, sessionId, dropSideAt(item, event)), refreshFocusRoster);
    draggedSessionId = null;
  });
}

function onPillPick(id: string, pane: Pane = 'terminal') {
  const ui = requestSessionOpen(id);
  if (!ui) return;
  activePane = pane === 'board' && splitBoardIdOf(id) ? 'board' : 'terminal';
  focusSession(id);
  const pill = pillById.get(id);
  if (pill) paintPillSplit(pill, id, boardTitlesById());
  if (activePane === 'board') {
    focusBoardPaneAfterSettle(id);
    return;
  }
  focusTerminalAfterSettle(ui, id);
}

function focusBoardPaneAfterSettle(id: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (active && getFocusedSessionId() === id) paneLayout?.bodyOf('board').focus({ preventScroll: true });
  }));
}

function onPillCycle(id: string) {
  const ui = requestSessionOpen(id);
  if (ui) centerOpenedSession(ui, id);
}

function centerOpenedSession(ui: SessionUi, id: string) {
  focusSession(id);
  focusTerminalAfterSettle(ui, id);
}

function boardTitlesById() {
  return new Map(boardSummariesOf().map((board) => [board.id, board.title]));
}

function paintPillSplit(pill: FocusPill, id: string, boardTitleById: ReadonlyMap<string, string>) {
  const boardId = splitBoardIdOf(id);
  const boardTitle = boardId ? boardTitleById.get(boardId) ?? null : null;
  const splitBoard = boardId && boardTitle !== null ? { id: boardId, title: boardTitle } : null;
  paintSessionRowSplit(pill, splitBoard, id === getFocusedSessionId() && splitBoard !== null ? activePane : null);
}

function paintPill(pill: FocusPill, { id, ui, state, name }: RosterRow, attentionPosition: number | null) {
  const mergeStatus = mergeStatusById.get(id) || 'none';
  pill.classList.toggle('focused', id === getFocusedSessionId());
  paintSessionRow(pill, pill._refs, { ui, state, name: name ?? '', mergeStatus: mergeStatus === 'none' ? '' : mergeStatus, attentionPosition });
  const isTabStop = id === railTabStopId;
  writeAttributeIfChanged(pill, 'aria-selected', String(isTabStop));
  writeAttributeIfChanged(pill, 'tabindex', isTabStop ? '0' : '-1');
}

function renderPillActivity(ui: SessionUi, kind: ActivityRenderKind) {
  if (!active) return;
  const id = ui?.card?.dataset.id;
  const pill = id ? pillById.get(id) : null;
  if (!pill) return;
  if (kind === 'flag') {
    pill.dataset.activity = ui._activity || '';
    return;
  }
  pulseActivityGlyph(pill._refs?.glyph);
}
addActivityRenderer(renderPillActivity);

onLiveSessionTick((id, ui) => {
  if (!active) return;
  const pill = pillById.get(id);
  if (pill) writeTextIfChanged(pill._refs.elapsed, sessionElapsedText(ui));
});

const paintedAttentionPositionById = new Map<string, number | null>();

export function refreshFocusRoster(dirtySessionIds?: ReadonlySet<string>) {
  if (!active) return;
  const mountedRail = railEl;
  if (!mountedRail) return;
  const order = orderedSessions();
  const groups = groupsOf(order);
  rosterRowById = new Map(order.map((row) => [row.id, row]));
  rosterGroupKeyBySessionId = new Map(groups.groups.flatMap((group) => group.rows.map((row) => [row.id, group.key] as const)));
  const boardSummaries = boardSummariesOf();
  if (centeredBoardId && !boardSummaries.some((summary) => summary.id === centeredBoardId)) centeredBoardId = null;
  const groupKeyBySessionId = new Map(groups.groups.filter((group) => group.hostId === null).flatMap((group) => group.rows.map((row) => [row.id, group.key] as const)));
  const boardsOfProject = boardsByProject(boardSummaries.filter((board) => !isBoardDeleting(board.id)), currentLiveSplits(), groupKeyBySessionId);
  const railGroups = withBoardProjects(groups, boardsOfProject.keys());
  const boardTitleById = new Map(boardSummaries.map((board) => [board.id, board.title]));
  const placedBoardIds = new Set<string>();
  const seen = new Set<string>();
  const attentionTiles = orderAttentionLine(order, getFocusedSessionId());
  const attentionPositionById = new Map(attentionTiles.map(({ id }, index) => [id, index + 1]));

  const placeList = (rows: RosterRow[], listEl: GroupList, boardNodes: HTMLElement[]) => {
    const newKey = `${rows.map((r) => r.id).join(',')}|${boardNodes.map((node) => node.dataset.boardNode).join(',')}`;
    const orderUnchanged = listEl._lastOrderKey === newKey && listEl.childElementCount === rows.length + boardNodes.length;
    for (const row of rows) {
      const { id } = row;
      seen.add(id);
      let pill = pillById.get(id);
      const isNewPill = !pill;
      if (!pill) { pill = buildPill(id); pillById.set(id, pill); }
      const attentionPosition = attentionPositionById.get(id) ?? null;
      const isPaintNeeded = !dirtySessionIds || isNewPill || dirtySessionIds.has(id) || paintedAttentionPositionById.get(id) !== attentionPosition;
      if (isPaintNeeded) paintPill(pill, row, attentionPosition);
      paintPillSplit(pill, id, boardTitleById);
      paintedAttentionPositionById.set(id, attentionPosition);
    }
    if (!orderUnchanged) placeRowsInOrder(listEl, [...rows.flatMap(({ id }) => pillById.get(id)?._row ?? []), ...boardNodes]);
    listEl._lastOrderKey = newKey;
  };

  const presentKeys = new Set(railGroups.order);
  const groupOrderKey = railGroups.groups.map((group) => group.key).join('\n');
  const groupsAlreadyInPlace = groupOrderKey === lastGroupOrderKey;
  lastGroupOrderKey = groupOrderKey;
  for (const group of railGroups.groups) {
    const { header, list } = ensureGroup(group);
    if (!groupsAlreadyInPlace) mountedRail.append(header, list);
    const projectBoards = group.hostId === null ? boardsOfProject.get(group.key) : undefined;
    placeList(group.rows, list, projectBoards ? boardNodesOf(group.key, projectBoards, placedBoardIds) : []);
  }
  removeUnplacedBoardRows(placedBoardIds, presentKeys);
  placeHostHeaders(mountedRail, { firstGroupHeaderOf: (hostId) => firstGroupHeaderOf(railGroups.groups, hostId), trailingNode: null });

  for (const [key, groupHeader] of [...groupHeaderById]) {
    if (!presentKeys.has(key)) {
      groupHeader.header.remove();
      groupListById.get(key)?.remove();
      groupHeaderById.delete(key);
      groupListById.delete(key);
    }
  }

  for (const [id, pill] of pillById) {
    if (!seen.has(id)) {
      pill._row.remove();
      pillById.delete(id);
      paintedAttentionPositionById.delete(id);
      if (id === railTabStopId) railTabStopId = null;
    }
  }

  for (const id of [...mergeStatusById.keys()]) {
    if (!sessionUIs.has(id)) mergeStatusById.delete(id);
  }

  const previousRailOrder = lastRailOrder;
  lastRailOrder = visibleOrder(groups, NO_COLLAPSED);

  const staleFocusedId = getFocusedSessionId();
  if (staleFocusedId && !isSessionShown(staleFocusedId)) {
    closeSessionPage();
    uiState.dispatch('focusSession', null);
    railTabStopId = null;
    const neighborId = pickNeighborOfRemoved(previousRailOrder, staleFocusedId);
    if (neighborId) {
      const wasTerminalFocusLost = !document.activeElement || document.activeElement === document.body;
      focusSession(neighborId);
      if (wasTerminalFocusLost) focusTerminalAfterSettle(sessionUIs.get(neighborId), neighborId);
      return;
    }
  }

  updateCenter();
  const centeredId = getFocusedSessionId();
  if (centeredId) {
    const ui = sessionUIs.get(centeredId);
    if (ui && ui.card.parentElement !== cardSlotEl) borrowToCenter(ui, centeredId);
  }
  pageButtons?.showSession(centeredBoardId ? null : centeredId);
  paintBoardPane();
  paintUnsplitSlot();
  updateRailHead(order, attentionTiles);
}

function rememberOpenState(details: HTMLDetailsElement, isOpen: boolean, saveOpen: (isOpen: boolean) => void) {
  details.open = isOpen;
  details.addEventListener('toggle', () => saveOpen(details.open));
}

function buildBoardRow(boardId: string) {
  const { row: boardRow, refs } = buildSessionRow();
  boardRow.dataset.boardId = boardId;
  boardRow.draggable = true;
  boardRow.addEventListener('click', () => centerBoard(boardId));
  boardRow.addEventListener('dragstart', (event) => startBoardRowDrag(event, boardId));
  const { item, removeButton } = wrapSessionRow(boardRow, 'Remove board', () => beginPendingBoardDelete(boardId), () => undoPendingBoardDelete(boardId));
  removeButton.tabIndex = -1;
  item.dataset.boardNode = boardId;
  return Object.assign(boardRow, { _refs: refs, _row: item });
}

function buildArchivedFold(projectKey: string) {
  const details = el('details', 'focus-board-archive');
  details.dataset.boardNode = `archive:${projectKey}`;
  const list = el('div', 'focus-board-archive-list');
  details.append(el('summary', 'focus-board-archive-summary', 'Archived'), list);
  return { details, list };
}

function connectedSessionNameOf(board: BoardSummary) {
  const connectedUi = board.connectedSessionIds.map((sessionId) => sessionUIs.get(sessionId)).find((ui) => ui !== undefined);
  return connectedUi ? sessionName(connectedUi) : null;
}

function paintedBoardRowOf(board: BoardSummary, placedBoardIds: Set<string>) {
  let row = boardRowById.get(board.id);
  if (!row) { row = buildBoardRow(board.id); boardRowById.set(board.id, row); }
  paintBoardRow(row, row._refs, board.title, connectedSessionNameOf(board), pendingBoardDeleteStartedAt(board.id));
  row.classList.toggle('focused', board.id === centeredBoardId);
  placedBoardIds.add(board.id);
  return row._row;
}

function boardNodesOf(projectKey: string, projectBoards: ProjectBoards<BoardSummary>, placedBoardIds: Set<string>): HTMLElement[] {
  const activeRows = projectBoards.active.map((board) => paintedBoardRowOf(board, placedBoardIds));
  if (projectBoards.archived.length === 0) return activeRows;
  const fold = archivedFoldByProject.get(projectKey) ?? buildArchivedFold(projectKey);
  archivedFoldByProject.set(projectKey, fold);
  placeRowsInOrder(fold.list, projectBoards.archived.map((board) => paintedBoardRowOf(board, placedBoardIds)));
  return [...activeRows, fold.details];
}

function removeUnplacedBoardRows(placedBoardIds: ReadonlySet<string>, presentGroupKeys: ReadonlySet<string>) {
  for (const [boardId, row] of boardRowById) {
    if (placedBoardIds.has(boardId)) continue;
    row._row.remove();
    boardRowById.delete(boardId);
  }
  for (const [projectKey, fold] of archivedFoldByProject) {
    if (presentGroupKeys.has(projectKey) && fold.list.childElementCount > 0) continue;
    fold.details.remove();
    archivedFoldByProject.delete(projectKey);
  }
}

function centerBoard(boardId: string) {
  if (!active) return;
  releaseCenter();
  centeredBoardId = boardId;
  setRailTabStop(null);
  refreshFocusRoster();
}

function pickNeighborOfRemoved(previousRailOrder: readonly string[], removedId: string) {
  const survivorsAndRemoved = previousRailOrder.filter((id) => id === removedId || isSessionShown(id));
  if (survivorsAndRemoved.length < 2) return lastRailOrder.find((id) => isSessionShown(id)) ?? null;
  const isRemovedLast = survivorsAndRemoved.indexOf(removedId) === survivorsAndRemoved.length - 1;
  return pickAdjacent(survivorsAndRemoved, removedId, isRemovedLast ? -1 : 1);
}

function attentionLine() {
  return orderAttentionLine(orderedSessions(), getFocusedSessionId());
}

function updateRailHead(rosterOrderedRows: readonly RosterRow[], attentionTiles: readonly AttentionTile[]) {
  if (!railHeadEl) return;
  paintAttentionBanner(railHeadEl, countAttentionByKind(rosterOrderedRows), attentionTiles);
  if (railLedgerEl) paintAttentionLedger(railLedgerEl, rosterOrderedRows);
}

export function focusNextAttention() {
  if (!active) return;
  if (railHeadEl) pressAttentionBanner(railHeadEl);
  const nextId = attentionLine()[0]?.id;
  if (nextId) openAttentionSession(nextId);
}

function openAttentionSession(id: string) {
  if (!active) return;
  requestSessionOpen(id);
  pillById.get(id)?.scrollIntoView({ block: 'nearest' });
  if (railHeadEl) sendAttentionTileToRow(railHeadEl, id, () => flashAttention(id));
  focusSession(id);
  focusTerminalAfterSettle(sessionUIs.get(id), id);
}

function focusTerminalAfterSettle(ui: SessionUi | null | undefined, id: string) {
  if (!ui) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (active && getFocusedSessionId() === id) ui.term?.focus();
  }));
}

function flashAttention(id: string) {
  if (reducedMotion?.matches || document.hidden) return;
  const pill = pillById.get(id);
  if (pill?.animate) {
    pill.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.045)', offset: 0.3 },
        { transform: 'scale(1)' },
      ],
      { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
    pill._row.animate(
      [{ boxShadow: '0 0 0 3px var(--accent)' }, { boxShadow: '0 0 0 3px transparent' }],
      { duration: 700, easing: 'ease-out' },
    );
  }
  const card = sessionUIs.get(id)?.card;
  if (card?.animate) {
    card.animate([{ opacity: 0.8 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  }
}

function borrowToCenter(ui: SessionUi, id: string) {
  if (!cardSlotEl) return;
  const header = ui.card.querySelector<HTMLElement>(':scope > .session-card-header');
  borrowCard(ui, id, cardSlotEl, {
    className: 'focus-centered',
    onRelease: () => {
      header?.classList.remove('pane-header');
      paneLayout?.setHeaderHost('terminal', null);
    },
  });
  header?.classList.add('pane-header');
  if (header) moveStripToHeaderStart(header);
  setTerminalActiveViewer(ui, id, true);
}

function moveStripToHeaderStart(header: HTMLElement) {
  const firstOwnChild = header.querySelector<HTMLElement>(':scope > .session-name');
  paneLayout?.setHeaderHost('terminal', { parent: header, before: firstOwnChild });
}


function loadBoardsView() {
  boardsViewLoad ??= import('../whiteboard/boards-view.ts').then((boardsView) => {
    loadedBoardsView = boardsView;
    boardsView.onBoardPicked(onPaneBoardPicked);
    return boardsView;
  });
  return boardsViewLoad;
}

function reportBoardsViewLoadFailure(error: unknown) {
  boardsViewLoad = null;
  reportToServerLog('focus', `the board pane failed to load: ${describeFailure(error)}`);
}

function showPanes(panes: ReadonlySet<Pane>) {
  if (!paneLayout || shownPanes === panes) return;
  shownPanes = panes;
  paneLayout.showPanes(panes);
}

function paintBoardPane() {
  if (centeredBoardId) {
    showPanes(BOARD_ONLY);
    showBoard(null, centeredBoardId);
    return;
  }
  const centeredId = getFocusedSessionId();
  const boardId = splitBoardIdOf(centeredId);
  if (!centeredId || !boardId) {
    showPanes(TERMINAL_ONLY);
    shownBoardKey = null;
    return;
  }
  showPanes(TERMINAL_AND_BOARD);
  showBoard(centeredId, boardId);
}

function showBoard(sessionId: string | null, boardId: string) {
  const boardKey = `${sessionId ?? ''}\n${boardId}`;
  const isNewSubject = shownBoardKey !== boardKey;
  shownBoardKey = boardKey;
  loadBoardsView().then((boardsView) => placeBoardPane(boardsView, sessionId, isNewSubject ? boardId : null), reportBoardsViewLoadFailure);
}

function onPaneBoardPicked(boardId: string) {
  if (!active) return;
  if (centeredBoardId) {
    centeredBoardId = boardId;
    shownBoardKey = `\n${boardId}`;
    refreshFocusRoster();
    return;
  }
  const sessionId = getFocusedSessionId();
  if (!sessionId) return;
  openOperatorSplit(sessionId, boardId);
  shownBoardKey = `${sessionId}\n${boardId}`;
  refreshFocusRoster();
}

function placeBoardPane(boardsView: BoardsViewModule, sessionId: string | null, boardId: string | null) {
  if (!paneLayout || getFocusedSessionId() !== sessionId) return;
  const boardBody = paneLayout.bodyOf('board');
  const host = boardsView.mountBoardHost();
  if (host.parentElement !== boardBody) boardBody.replaceChildren(host);
  boardsView.placeBoardTitle(paneLayout.boardTitleSlot);
  if (boardId) boardsView.showBoardBeside(boardId, sessionId);
}

export function reopenFocusBoard() {
  if (!active || shownBoardKey === null) return;
  loadedBoardsView?.reopenSelectedBoard();
}

export function openRequestedBoardInFocus() {
  const request = takeOpenBoardRequest();
  if (!active || !request?.sessionId || !sessionUIs.has(request.sessionId)) return;
  splitSessionWithBoard(request.sessionId, request.boardId);
}

function releaseCenter() {
  closeSessionPage();
  const centeredId = getFocusedSessionId();
  if (!centeredId) return;
  if (getBorrowedCardId() === centeredId) releaseCard();
  uiState.dispatch('focusSession', null);
}

function focusSession(id: string) {
  if (!active || !sessionUIs.has(id)) return;
  markSessionSeen(id);
  selectSession(id);
  if (id === getFocusedSessionId()) return;
  releaseCenter();
  centeredBoardId = null;
  uiState.dispatch('focusSession', id);
  railTabStopId = id;
  refreshFocusRoster();
}

function updateCenter() {
  if (!emptyEl || !emptyTitleEl || !emptyDescEl) return;
  const centeredId = getFocusedSessionId();
  const has = Boolean(centeredBoardId) || Boolean(centeredId && sessionUIs.has(centeredId));
  const hasSessions = sessionUIs.size > 0;
  writeHiddenIfChanged(emptyEl, has);
  if (paneLayout) writeHiddenIfChanged(paneLayout.element, !has);
  showFirstRunChecklist(emptyEl, !hasSessions);
  writeHiddenIfChanged(emptyTitleEl, !hasSessions);
  writeHiddenIfChanged(emptyDescEl, !hasSessions);
  if (has || !hasSessions) return;

  writeTextIfChanged(emptyTitleEl, 'No session selected');
  writeTextIfChanged(emptyDescEl, 'Select a session from the rail on the left to focus it here.');
}

export function setFocusMergeStatus(id: unknown, mergeStatus: unknown) {
  mergeStatusById.set(sessionIdOf(id), typeof mergeStatus === 'string' && mergeStatus ? mergeStatus : 'none');
  if (active) refreshFocusRoster();
}

let pageHeaderObserver: ResizeObserver | null = null;

function keepSessionPageBelowHeader(card: HTMLElement) {
  pageHeaderObserver?.disconnect();
  const header = card.querySelector<HTMLElement>(':scope > .session-card-header');
  if (!header) return;
  const placeBelowHeader = () => card.style.setProperty('--session-page-top', `${header.offsetHeight}px`);
  placeBelowHeader();
  pageHeaderObserver = new ResizeObserver(placeBelowHeader);
  pageHeaderObserver.observe(header);
}

const focusPageHost: SessionPageHost = {
  placement: 'overlay',
  sessionId: () => (active && centerEl && !centeredBoardId ? getFocusedSessionId() : null),
  elementFor: () => {
    const centeredCard = sessionUIs.get(getFocusedSessionId() ?? '')?.card;
    if (!centeredCard) throw new Error('Focus view has no centered session');
    keepSessionPageBelowHeader(centeredCard);
    return centeredCard;
  },
  didShow: () => {},
  didHide: () => {
    pageHeaderObserver?.disconnect();
    pageHeaderObserver = null;
    const centeredId = getFocusedSessionId();
    if (centeredId) focusTerminalAfterSettle(sessionUIs.get(centeredId), centeredId);
  },
};

export function openChangesInFocus(path: string | null = null) {
  const centeredId = getFocusedSessionId();
  if (centeredId) openSessionPage('changes', centeredId, path);
}

export function centerSessionQuietly(id: string) {
  if (!active || !sessionUIs.has(id)) return;
  focusSession(id);
}

export function focusNthInRail(n: number) {
  if (!active) return;
  const id = railVisibleIds()[n - 1];
  if (id && isSessionShown(id)) onPillPick(id);
}

export function focusAdjacentInRail(dir: number) {
  if (!active) return;
  const cyclableIds = railVisibleIds().filter((railId) => railId === railTabStopId || isSessionShown(railId));
  const id = pickAdjacent(cyclableIds, railTabStopId, dir);
  if (id == null || !isSessionShown(id)) return;
  onPillCycle(id);
  pillById.get(id)?.scrollIntoView({ block: 'nearest' });
}

window.addEventListener('focus', () => {
  const centeredId = getFocusedSessionId();
  if (active && centeredId) markSessionSeen(centeredId);
});

export function activateFocusView() {
  if (!railEl) return;
  active = true;
  setSessionPageHost(focusPageHost);

  releaseCenter();
  railTabStopId = null;
  refreshFocusRoster();
  if (isAttentionJumpActivating && attentionJumpTargetId) {
    openAttentionSession(attentionJumpTargetId);
    return;
  }
  if (isAttentionJumpActivating && attentionLine().length > 0) {
    focusNextAttention();
    return;
  }
  if (isAttentionJumpActivating && railHeadEl) pressAttentionBanner(railHeadEl);
  restoreFocusedSession();
}

export function activateFocusOnNextAttention(activateFocus: () => void, targetSessionId: string | null = null) {
  isAttentionJumpActivating = true;
  attentionJumpTargetId = targetSessionId;
  try {
    activateFocus();
  } finally {
    isAttentionJumpActivating = false;
    attentionJumpTargetId = null;
  }
}

export function restoreFocusedSession() {
  if (!active || getFocusedSessionId() || centeredBoardId) return;
  const id = getRestorableSessionId();
  if (!id) return;
  focusSession(id);
}

export function deactivateFocusView() {
  if (!active) return;
  releaseCenter();
  releaseSessionPageHost(focusPageHost);
  railTabStopId = null;
  active = false;
}
