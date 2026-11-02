import { borrowCard, getBorrowedCardId, releaseCard } from '../card-host.ts';
import { wireColumnResizer } from '../column-resizer.ts';
import { el } from '../dom-helpers.ts';
import { createLineIcon, IMAGE_ICON_PATH } from '../svg-dom.ts';
import { renderStatusLegend } from '../status-legend.ts';
import { showFirstRunChecklist } from '../onboarding/first-run-loader.ts';
import { emptyProjectKeys, forgetProject } from '../project-registry.ts';
import { getRestorableSessionId, isSessionShown, quickAddSession, readSessionRows, requestSessionOpen, requestSessionRemoval, selectSession, undoPendingClose } from '../session-actions.ts';
import { markSessionSeen, showSessionPlanFace } from '../session-card/lifecycle.ts';
import type { ActivityRenderKind } from '../session-card/activity.ts';
import { addActivityRenderer, pulseActivityGlyph } from '../session-card/activity.ts';
import { buildNextAttentionKeys, SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { railAriaKeyShortcuts } from '../shortcuts-core.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionIdOf, sessionUIs } from '../session-card/card-registry.ts';
import { placeRowsInOrder, writeAttributeIfChanged, writeHiddenIfChanged, writeTextIfChanged } from '../status-paint.ts';
import { onLiveSessionTick, sessionElapsedText } from '../session-card/session-tick.ts';
import { setTerminalActiveViewer } from '../session-card/terminal.ts';
import { getRailWidth, setRailWidth } from '../ui-prefs.ts';
import { uiState } from '../ui-state-core.ts';
import type { AttentionTile, SessionRow } from './attention-core.ts';
import { countAttentionByKind, orderAttentionLine, orderRoster, pickAdjacent } from './attention-core.ts';
import type { RosterGroup } from './roster-groups-core.ts';
import { groupRoster, sessionlessBoards, visibleOrder } from './roster-groups-core.ts';
import type { SessionGroupHeader } from './roster-group-header.ts';
import { buildSessionGroupHeader, paintSessionGroupHeader } from './roster-group-header.ts';
import { buildAttentionBanner, paintAttentionBanner, pressAttentionBanner, sendAttentionTileToRow, tetherAttentionTile } from '../attention-banner.ts';
import { buildSessionRow, paintBoardRow, paintSessionRow, wrapSessionRow } from '../session-row.ts';
import { unopenedShownCountOf } from '../shown-files.ts';
import { describeFailure } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';
import { boardSummariesOf, boardsConnectedTo, isBoardListSettled, onBoardListChanged, takeOpenBoardRequest } from '../whiteboard/board-store.ts';
import type { PaneTab } from '#shared/contracts/focus-layout.ts';
import type { PaneLayout } from './pane-layout.ts';
import { createPaneLayout } from './pane-layout.ts';
import type { ReviewBar } from '../review/review-bar.ts';
import { createReviewBar } from '../review/review-bar.ts';
import { closeReviewOverlay, openReviewOverlay } from '../review/review-reader.ts';

type RosterRow = SessionRow<SessionUi, string | null>;

type BoardsViewModule = typeof import('../whiteboard/boards-view.ts');

const TERMINAL_ONLY: ReadonlySet<PaneTab> = new Set<PaneTab>(['terminal']);
const TERMINAL_AND_BOARD: ReadonlySet<PaneTab> = new Set<PaneTab>(['terminal', 'board']);
const BOARD_ONLY: ReadonlySet<PaneTab> = new Set<PaneTab>(['board']);

const projectPathOf = (row: RosterRow) => row.ui.path;

type FocusPill = ReturnType<typeof buildPill>;

type BoardRow = ReturnType<typeof buildBoardRow>;

type GroupList = HTMLDivElement & { _lastOrderKey?: string };

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

let railEl: HTMLElement | null = null;
let railHeadEl: HTMLElement | null = null;
let centerEl: HTMLElement | null = null;
let cardSlotEl: HTMLElement | null = null;
let paneLayout: PaneLayout | null = null;
let boardToolsSlot: HTMLElement | null = null;
let reviewBar: ReviewBar | null = null;
let boardsViewLoad: Promise<BoardsViewModule> | null = null;
let loadedBoardsView: BoardsViewModule | null = null;
let boardPairedSessionId: string | null = null;
let pairedBoardId: string | null = null;
let shownPaneTabs: ReadonlySet<PaneTab> | null = null;
let paneTabsSessionId: string | null = null;
let centeredBoardId: string | null = null;
let boardsGroup: ReturnType<typeof buildBoardsGroup> | null = null;
const boardRowById = new Map<string, BoardRow>();
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
  return groupRoster(order, projectPathOf, emptyProjectKeys(order, projectPathOf));
}

function ensureGroup(group: RosterGroup<RosterRow>) {
  let groupHeader = groupHeaderById.get(group.key);
  let list = groupListById.get(group.key);
  if (!groupHeader || !list) {
    groupHeader = buildSessionGroupHeader({
      onAdd: quickAddSession,
      onForget: (path) => {
        forgetProject(path);
        refreshFocusRoster();
      },
    });
    list = el('div', 'focus-rail-list');
    list.setAttribute('role', 'listbox');
    groupHeaderById.set(group.key, groupHeader);
    groupListById.set(group.key, list);
  }
  paintSessionGroupHeader(groupHeader, group, 'rail');
  writeAttributeIfChanged(list, 'aria-label', `${group.label} sessions`);
  return { header: groupHeader.header, list };
}

export function isFocusActive() { return active; }

export function getFocusedSessionId() { return uiState.snapshot().focusedSessionId; }

export function isBoardCentered() {
  return active && centeredBoardId !== null;
}

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

  const statusKey = el('details', 'rail-status-key');
  statusKey.append(el('summary', 'rail-status-key-summary', 'Status key'), renderStatusLegend());
  mountedRail.append(railHeadEl, statusKey);

  emptyEl = el('div', 'focus-empty');
  emptyEl.innerHTML = '<p class="focus-empty-title"></p>'
    + '<p class="focus-empty-desc"></p>';
  emptyTitleEl = emptyEl.querySelector<HTMLElement>('.focus-empty-title');
  emptyDescEl = emptyEl.querySelector<HTMLElement>('.focus-empty-desc');

  paneLayout = createPaneLayout();
  paneLayout.element.addEventListener('click', showTerminalFaceOnTerminalTab);
  cardSlotEl = paneLayout.bodyOf('terminal');
  boardToolsSlot = el('div', 'pane-board-tools');
  boardsGroup = buildBoardsGroup();
  paneLayout.setTabTools('board', boardToolsSlot);
  reviewBar = createReviewBar({ onOpenChanges: () => openChangesInFocus() });
  paneLayout.trailSlot.append(reviewBar.element);
  mountedCenter.append(emptyEl, paneLayout.element);
  onBoardListChanged(() => {
    if (!active) return;
    const wasBoardCentered = centeredBoardId !== null;
    refreshFocusRoster();
    if (wasBoardCentered && centeredBoardId === null) restoreFocusedSession();
  });

  mountedRail.addEventListener('keydown', onRailKeydown);
}

const RAIL_BOUNDS = { minPx: 180, maxPx: 480 };
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
  return [...railEl.querySelectorAll<HTMLElement>('button.session-row[data-id], button.session-row[data-board-id]')];
}

function orderedSessions() {
  return orderRoster(readSessionRows(sessionName));
}

function sessionName(ui: SessionUi): string | null {
  return ui.nameEl ? ui.nameEl.textContent : (ui.card ? (ui.card.dataset.session || ui.card.dataset.id || '') : '');
}

function buildPill(id: string) {
  const { row: button, refs } = buildSessionRow('button');
  button.type = 'button';
  button.dataset.id = id;
  button.setAttribute('role', 'option');
  button.addEventListener('click', () => onPillPick(id));
  button.addEventListener('pointerenter', () => { if (railHeadEl) tetherAttentionTile(railHeadEl, id); });
  button.addEventListener('pointerleave', () => { if (railHeadEl) tetherAttentionTile(railHeadEl, null); });

  const { item, removeButton } = wrapSessionRow(button, () => requestSessionRemoval(id), () => undoPendingClose(id));
  item.setAttribute('role', 'presentation');
  removeButton.tabIndex = -1;
  const shownCount = el('span', 'session-row-shown');
  shownCount.hidden = true;
  shownCount.append(createLineIcon(IMAGE_ICON_PATH), el('span', 'session-row-shown-count'));
  refs.name.after(shownCount);
  return Object.assign(button, { _refs: refs, _row: item, _shownCount: shownCount });
}

function onPillPick(id: string) {
  const ui = requestSessionOpen(id);
  if (!ui) return;
  centerOpenedSession(ui, id);
}

function onPillCycle(id: string) {
  const ui = requestSessionOpen(id);
  if (ui) centerOpenedSession(ui, id);
}

function centerOpenedSession(ui: SessionUi, id: string) {
  focusSession(id);
  focusTerminalAfterSettle(ui, id);
}

function paintPillShownCount(shownCount: HTMLElement, unopenedCount: number) {
  writeHiddenIfChanged(shownCount, unopenedCount === 0);
  writeAttributeIfChanged(shownCount, 'title', `${unopenedCount} shown ${unopenedCount === 1 ? 'file' : 'files'} not opened`);
  const countText = shownCount.querySelector<HTMLElement>('.session-row-shown-count');
  if (countText) writeTextIfChanged(countText, String(unopenedCount));
}

function paintPill(pill: FocusPill, { id, ui, state, name }: RosterRow, attentionPosition: number | null) {
  const mergeStatus = mergeStatusById.get(id) || 'none';
  pill.classList.toggle('focused', id === getFocusedSessionId());
  paintSessionRow(pill, pill._refs, { ui, state, name: name ?? '', mergeStatus: mergeStatus === 'none' ? '' : mergeStatus, attentionPosition });
  paintPillShownCount(pill._shownCount, unopenedShownCountOf(id));
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
  const seen = new Set<string>();
  const attentionTiles = orderAttentionLine(order, getFocusedSessionId());
  const attentionPositionById = new Map(attentionTiles.map(({ id }, index) => [id, index + 1]));

  const placeList = (rows: RosterRow[], listEl: GroupList) => {
    const newKey = rows.map((r) => r.id).join(',');
    const orderUnchanged = listEl._lastOrderKey === newKey && listEl.childElementCount === rows.length;
    for (const row of rows) {
      const { id } = row;
      seen.add(id);
      let pill = pillById.get(id);
      const isNewPill = !pill;
      if (!pill) { pill = buildPill(id); pillById.set(id, pill); }
      const attentionPosition = attentionPositionById.get(id) ?? null;
      const isPaintNeeded = !dirtySessionIds || isNewPill || dirtySessionIds.has(id) || paintedAttentionPositionById.get(id) !== attentionPosition;
      if (isPaintNeeded) paintPill(pill, row, attentionPosition);
      paintedAttentionPositionById.set(id, attentionPosition);
    }
    if (!orderUnchanged) placeRowsInOrder(listEl, rows.flatMap(({ id }) => pillById.get(id)?._row ?? []));
    listEl._lastOrderKey = newKey;
  };

  const presentKeys = new Set(groups.order);
  const groupOrderKey = groups.groups.map((group) => group.key).join('\n');
  const groupsAlreadyInPlace = groupOrderKey === lastGroupOrderKey;
  lastGroupOrderKey = groupOrderKey;
  for (const group of groups.groups) {
    const { header, list } = ensureGroup(group);
    if (!groupsAlreadyInPlace) mountedRail.append(header, list);
    placeList(group.rows, list);
  }

  if (boardsGroup && (!groupsAlreadyInPlace || boardsGroup.header.parentElement !== mountedRail)) mountedRail.append(boardsGroup.header, boardsGroup.list);
  if (boardsGroup) paintBoardRows(boardsGroup);

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
    closeReviewOverlay();
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
  reviewBar?.showSession(centeredBoardId ? null : centeredId);
  paintBoardPane();
  updateRailHead(order, attentionTiles);
}

function buildBoardsGroup() {
  const header = el('div', 'session-group-header focus-boards-header');
  const count = el('span', 'session-group-count');
  const rule = el('span', 'session-group-rule');
  rule.setAttribute('aria-hidden', 'true');
  const addButton = el('button', 'session-group-add', '+');
  addButton.type = 'button';
  addButton.title = 'New board';
  addButton.setAttribute('aria-label', 'New board');
  addButton.addEventListener('click', createBoardFromRail);
  header.append(el('span', 'session-group-label', 'Boards'), count, rule, addButton);
  const list = el('div', 'focus-rail-list focus-board-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Boards with no session');
  return { header, count, list };
}

function buildBoardRow(boardId: string) {
  const { row: button, refs } = buildSessionRow('button');
  button.type = 'button';
  button.dataset.boardId = boardId;
  button.addEventListener('click', () => centerBoard(boardId));
  const item = el('div', 'session-row-item');
  item.append(button);
  return Object.assign(button, { _refs: refs, _row: item });
}

function paintBoardRows(group: ReturnType<typeof buildBoardsGroup>) {
  const summaries = boardSummariesOf();
  if (centeredBoardId && !summaries.some((summary) => summary.id === centeredBoardId)) centeredBoardId = null;
  const boards = sessionlessBoards(summaries, (sessionId) => sessionUIs.has(sessionId));
  const shownIds = new Set(boards.map((board) => board.id));
  for (const [boardId, row] of boardRowById) {
    if (shownIds.has(boardId)) continue;
    row._row.remove();
    boardRowById.delete(boardId);
  }
  for (const board of boards) {
    let row = boardRowById.get(board.id);
    if (!row) { row = buildBoardRow(board.id); boardRowById.set(board.id, row); }
    paintBoardRow(row, row._refs, board.title);
    row.classList.toggle('focused', board.id === centeredBoardId);
  }
  placeRowsInOrder(group.list, boards.flatMap((board) => boardRowById.get(board.id)?._row ?? []));
  writeTextIfChanged(group.count, String(boards.length));
  writeAttributeIfChanged(group.count, 'title', `${boards.length} ${boards.length === 1 ? 'board' : 'boards'} with no session`);
}

function centerBoard(boardId: string) {
  if (!active) return;
  releaseCenter();
  centeredBoardId = boardId;
  pairedBoardId = null;
  setRailTabStop(null);
  refreshFocusRoster();
}

function createBoardFromRail() {
  loadBoardsView().then((boardsView) => boardsView.createBoardFromDialog(centerBoard), reportBoardsViewLoadFailure);
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
  borrowCard(ui, id, cardSlotEl, { className: 'focus-centered', onRelease: () => paneLayout?.setStripHost('terminal', null) });
  const header = ui.card.querySelector<HTMLElement>(':scope > .session-card-header');
  if (header) paneLayout?.setStripHost('terminal', { parent: header, before: header.querySelector(':scope > .session-actions') });
  paneLayout?.setTabTitle('terminal', () => terminalTabTitle(ui));
  setTerminalActiveViewer(ui, id, true);
}

function showTerminalFaceOnTerminalTab(event: MouseEvent) {
  if (!(event.target instanceof Element) || !event.target.closest('.pane-tab[data-tab="terminal"]')) return;
  const centeredId = getFocusedSessionId();
  const ui = centeredId ? sessionUIs.get(centeredId) : null;
  if (ui && ui.face !== 'terminal') ui._showTerminalFace?.();
}

function terminalTabTitle(ui: SessionUi) {
  const agentText = ui.agent ? `Agent: ${ui.agent}` : '';
  const worktreeText = ui.card.dataset.worktree === undefined ? 'No worktree' : 'Runs in its own worktree';
  return [agentText, worktreeText].filter(Boolean).join('. ');
}

function loadBoardsView() {
  boardsViewLoad ??= import('../whiteboard/boards-view.ts').then((boardsView) => {
    loadedBoardsView = boardsView;
    return boardsView;
  });
  return boardsViewLoad;
}

function reportBoardsViewLoadFailure(error: unknown) {
  boardsViewLoad = null;
  reportToServerLog('focus', `the board pane failed to load: ${describeFailure(error)}`);
}

function showPaneTabs(tabs: ReadonlySet<PaneTab>, sessionId: string | null, holdSplit = false) {
  const isSameSubject = shownPaneTabs === tabs && paneTabsSessionId === sessionId;
  if (!paneLayout || isSameSubject) return;
  shownPaneTabs = tabs;
  paneTabsSessionId = sessionId;
  paneLayout.showTabs(tabs, { holdSplit });
}

function paintBoardOnlyPane(boardId: string) {
  showPaneTabs(BOARD_ONLY, null);
  const isNewSubject = boardPairedSessionId !== null || pairedBoardId !== boardId;
  boardPairedSessionId = null;
  pairedBoardId = boardId;
  loadBoardsView().then((boardsView) => placeBoardPane(boardsView, null, isNewSubject ? boardId : null), reportBoardsViewLoadFailure);
}

function paintBoardPane(requestedBoardId: string | null = null) {
  if (centeredBoardId) {
    paintBoardOnlyPane(centeredBoardId);
    return;
  }
  const centeredId = getFocusedSessionId();
  const connectedBoards = centeredId ? boardsConnectedTo(centeredId) : [];
  const [newestBoard] = connectedBoards;
  const tabs = newestBoard ? TERMINAL_AND_BOARD : TERMINAL_ONLY;
  const isBoardArrivingMidView = isBoardListSettled() && tabs === TERMINAL_AND_BOARD && shownPaneTabs === TERMINAL_ONLY && paneTabsSessionId === centeredId && requestedBoardId === null;
  showPaneTabs(tabs, centeredId, isBoardArrivingMidView);
  if (!centeredId || !newestBoard) {
    boardPairedSessionId = null;
    pairedBoardId = null;
    return;
  }
  const isPairedBoardConnected = connectedBoards.some((board) => board.id === pairedBoardId);
  const isNewPairing = boardPairedSessionId !== centeredId || requestedBoardId !== null || !isPairedBoardConnected;
  boardPairedSessionId = centeredId;
  const boardId = isNewPairing ? requestedBoardId ?? newestBoard.id : null;
  if (boardId) pairedBoardId = boardId;
  loadBoardsView().then((boardsView) => placeBoardPane(boardsView, centeredId, boardId), reportBoardsViewLoadFailure);
}

function placeBoardPane(boardsView: BoardsViewModule, sessionId: string | null, boardId: string | null) {
  if (!paneLayout || getFocusedSessionId() !== sessionId) return;
  const boardBody = paneLayout.bodyOf('board');
  const host = boardsView.mountBoardHost();
  if (host.parentElement !== boardBody) boardBody.replaceChildren(host);
  boardsView.placeBoardChrome(boardToolsSlot);
  if (boardId) boardsView.showBoardBeside(boardId, sessionId);
}

export function reopenFocusBoard() {
  if (!active || (!boardPairedSessionId && !centeredBoardId)) return;
  loadedBoardsView?.reopenSelectedBoard();
}

export function openRequestedBoardInFocus() {
  const request = takeOpenBoardRequest();
  if (!active || !request?.sessionId || !sessionUIs.has(request.sessionId)) return;
  focusSession(request.sessionId);
  paintBoardPane(request.boardId);
  paneLayout?.showTab('board');
}

function releaseCenter() {
  closeReviewOverlay();
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

export function openChangesInFocus(path: string | null = null) {
  const centeredId = getFocusedSessionId();
  if (!active || !centerEl || centeredBoardId || !centeredId) return;
  openReviewOverlay(centerEl, { path, onClosed: () => focusTerminalAfterSettle(sessionUIs.get(centeredId), centeredId) });
}

export function centerSessionQuietly(id: string) {
  if (!active || !sessionUIs.has(id)) return;
  focusSession(id);
}

export function openPlanInFocus(id: string) {
  if (!active || !sessionUIs.has(id)) return false;
  focusSession(id);
  return showSessionPlanFace(id);
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
  railTabStopId = null;
  active = false;
}
