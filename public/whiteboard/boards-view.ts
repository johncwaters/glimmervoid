import './whiteboard.css';
import type { Board, BoardReview, BoardSummary, BoxMedia, Element, Op } from '#shared/contracts/whiteboard.ts';
import { refPathOf, refsOfElement } from '#shared/whiteboard-anchor-core.ts';
import { BOARD_PAGE_ESCAPE_MESSAGE, BOARD_PAGE_VIEWER_PARAM, boardMediaOriginalFilename, WHITEBOARD_ASSET_ROUTE, WHITEBOARD_LIMITS } from '#shared/contracts/whiteboard.ts';
import { createActionStatus } from '../action-status.ts';
import { el, isRealInputOwningKey } from '../dom-helpers.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';
import { button, menuButton } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import { buildMenuItem, wirePopupMenuKeys } from '../menu.ts';
import { findSessionUi, sessionName } from '../session-card/card-registry.ts';
import { buildDialogShell, isModalOpen, openConfirmDialog } from '../session-card/modal.ts';
import { createLineIcon } from '../svg-dom.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { createBoardEditor, newElementId } from './board-edit.ts';
import type { BoardEditor, BoardTool, PressedImage } from './board-edit.ts';
import { EMPTY_HISTORY, recordEdit, recordStep, takeStep, undoOpsOf } from '#shared/whiteboard-undo-core.ts';
import type { BoardDiff } from '#shared/contracts/control/whiteboard-messages.ts';
import type { UndoDirection, UndoHistory } from '#shared/whiteboard-undo-core.ts';
import { createBoardInspector } from './board-inspect.ts';
import type { BoardInspector } from './board-inspect.ts';
import { createBoardRenderer } from './board-gl-renderer.ts';
import type { BoardRenderer } from './board-gl-renderer.ts';
import { onTilesChanged, showTilesFor, tiledBoardOf } from './board-tile-store.ts';
import { createBoardMediaLayer, fetchBoardDocText } from './board-media-layer.ts';
import { applyDocsToOpenEditor, openDocEditorOn } from '../doc-editor/doc-editor.ts';
import type { DocSource } from '../doc-editor/doc-editor.ts';
import {
  boardSummariesOf, createBoard, deleteBoard, onBoardChanged, onBoardListChanged, openBoard, openBoardOf, openFileInReview, requestBoardReview, sendBoardOps, takeOpenBoardRequest, uploadBoardMedia,
} from './board-store.ts';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EMPTY_TEXT = 'No boards yet. Make one here, or have an agent run glimmervoid whiteboard new <title>.';
const PICK_TEXT = 'Pick a board above.';
const TITLE_RENAME_CLASS = 'wb-board-title-rename';
const MORE_ICON_PATH = 'M4.5 6.5L8 10l3.5-3.5';
const MENU_GAP_PX = 4;
const STACKED_MEDIA_OFFSET_PX = 32;
const BOARD_DOC_CONFLICT_TEXT = 'This document changed on the board since you opened it. Reload to see that version.';
const BOARD_DOC_GONE_TEXT = 'This document is no longer on the board, so it cannot be saved.';
const BOARD_DOC_UNREAD_TEXT = 'This document could not be read from the board.';
const BOARD_DOC_NOT_MARKDOWN_TEXT = 'Not saved: this text starts like a picture or an HTML page, so the board would not keep it as a document.';
const BOARD_MEDIA_FILE_TYPES = new Set(['video/mp4', 'video/webm', 'text/html']);
const BOARD_MEDIA_FILE_NAME_RE = /\.(png|jpe?g|gif|webp|svg|mp4|webm|html?)$/i;
const FIT_ICON_PATH = 'M2.5 6V2.5H6 M10 2.5h3.5V6 M13.5 10v3.5H10 M6 13.5H2.5V10';
const UNDO_ICON_PATH = 'M5.5 3.5l-3 3l3 3 M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7';
const REDO_ICON_PATH = 'M10.5 3.5l3 3l-3 3 M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H9';
const TOO_BIG_TO_UNDO_TEXT = 'Saved, but that change is too big to undo.';
const TOOL_BUTTONS: readonly { tool: BoardTool; label: string; key: string; iconPath: string; hint: string | null }[] = [
  { tool: 'select', label: 'select', key: 'V', iconPath: 'M4 2.5l8.5 5.8l-4 0.7l2.2 4.3l-1.5 0.8l-2.2-4.3L4 12.5z', hint: null },
  { tool: 'box', label: 'box', key: 'R', iconPath: 'M2.5 4h11v8h-11z', hint: 'Click the board to place a box. Esc to cancel.' },
  { tool: 'decision', label: 'decision', key: 'D', iconPath: 'M8 2l6 6l-6 6l-6-6z', hint: 'Click the board to place a decision. Esc to cancel.' },
  { tool: 'panel', label: 'panel', key: 'P', iconPath: 'M2.5 3h11v10h-11z M2.5 6h11', hint: 'Click the board to place a panel. Esc to cancel.' },
  { tool: 'wire', label: 'wire', key: 'A', iconPath: 'M2.5 13.5L13 3 M8.5 3H13v4.5', hint: 'Drag from one box to another to connect them. Esc to cancel.' },
];

interface TextDialogOptions {
  title: string;
  label: string;
  placeholder: string;
  maxLength: number;
  confirmLabel: string;
  initialValue?: string;
  choices?: { label: string; options: { value: string; text: string }[] };
  onSubmit: (value: string, choice: string | null) => Promise<string | null>;
}

interface BoardsViewParts {
  boardIsland: HTMLElement;
  boardMenu: ReturnType<typeof buildBoardMenu>;
  boardTitle: HTMLButtonElement;
  boardMeta: HTMLElement;
  presence: HTMLElement;
  host: HTMLElement;
  chrome: HTMLElement;
  canvas: HTMLElement;
  empty: HTMLElement;
  emptyText: HTMLElement;
  agentIsland: HTMLElement;
  queuedForSession: HTMLElement;
  buttons: Record<'note' | 'frame' | 'step' | 'fit' | 'undo' | 'redo', HTMLButtonElement>;
  toolButtons: ReadonlyMap<BoardTool, HTMLButtonElement>;
  toolHint: HTMLElement;
  emptyBoardHint: HTMLElement;
}

let selectedBoardId: string | null = null;
let parts: BoardsViewParts | null = null;
let renderer: BoardRenderer | null = null;
let editor: BoardEditor | null = null;
let inspector: BoardInspector | null = null;
let shouldFitOnNextRender = true;
let pairedSessionId: string | null = null;
let shownReview: { boardId: string; review: BoardReview } | null = null;
let reviewRequestKey: string | null = null;
type RecordedSend = { ok: true; isUndoable: boolean } | { ok: false; error: string };

const status = createActionStatus('action-status wb-status');
const historyByBoardId = new Map<string, UndoHistory>();
let historyQueue: Promise<unknown> = Promise.resolve();

function openTextDialog(options: TextDialogOptions): void {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: options.title });
  const input = el('input', 'dialog-input');
  input.type = 'text';
  input.placeholder = options.placeholder;
  input.maxLength = options.maxLength;
  input.value = options.initialValue ?? '';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', options.label);
  const errorEl = el('div', 'dialog-error');
  errorEl.setAttribute('role', 'alert');
  const select = options.choices ? el('select', 'dialog-input wb-dialog-select') : null;
  if (select && options.choices) {
    select.setAttribute('aria-label', options.choices.label);
    for (const choice of options.choices.options) {
      const option = el('option', null, choice.text);
      option.value = choice.value;
      select.append(option);
    }
  }
  const btnConfirm = button({ variant: 'primary', label: options.confirmLabel, action: 'confirm-board-dialog' });
  actions.append(btnConfirm);
  dialog.append(el('label', 'dialog-label', options.label), input, ...(select ? [select] : []), errorEl, actions);

  async function submit(): Promise<void> {
    const value = input.value.trim();
    if (!value) {
      errorEl.textContent = `${options.label} is empty.`;
      return;
    }
    btnConfirm.disabled = true;
    const error = await options.onSubmit(value, select?.value ?? null);
    btnConfirm.disabled = false;
    if (error) {
      errorEl.textContent = error;
      return;
    }
    close();
  }

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', () => void submit());
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void submit();
  });
  requestAnimationFrame(() => input.focus());
}

function selectedBoard(): Board | null {
  return selectedBoardId ? openBoardOf(selectedBoardId) : null;
}

function selectedSummary(): BoardSummary | null {
  return boardSummariesOf().find((summary) => summary.id === selectedBoardId) ?? null;
}

function inHistoryOrder<Outcome>(task: () => Promise<Outcome>): Promise<Outcome> {
  const queued = historyQueue.then(task);
  historyQueue = queued.catch(() => undefined);
  return queued;
}

function sendRecordedOps(boardId: string, ops: Op[]): Promise<RecordedSend> {
  return inHistoryOrder(() => sendAndRecord(boardId, ops));
}

function fitsOnePut(ops: readonly Op[]): boolean {
  return ops.length <= WHITEBOARD_LIMITS.opsPerPut && new TextEncoder().encode(JSON.stringify(ops)).length <= WHITEBOARD_LIMITS.putBytes;
}

function undoEntryOf(before: Board | null, boardId: string, diff: BoardDiff | null): Op[] | null {
  if (!before || before.id !== boardId || !diff) return [];
  const entry = undoOpsOf(before, diff);
  return fitsOnePut(entry) ? entry : null;
}

async function sendAndRecord(boardId: string, ops: Op[]): Promise<RecordedSend> {
  const before = selectedBoard();
  const outcome = await sendBoardOps(boardId, ops);
  if (!outcome.ok) return outcome;
  const entry = undoEntryOf(before, boardId, outcome.diff);
  if (!entry) {
    historyByBoardId.set(boardId, EMPTY_HISTORY);
    return { ok: true, isUndoable: false };
  }
  historyByBoardId.set(boardId, recordEdit(historyByBoardId.get(boardId) ?? EMPTY_HISTORY, entry));
  return { ok: true, isUndoable: true };
}

function stepHistory(direction: UndoDirection): Promise<void> {
  return inHistoryOrder(() => runHistoryStep(direction));
}

async function runHistoryStep(direction: UndoDirection): Promise<void> {
  const boardId = selectedBoardId;
  const board = selectedBoard();
  if (!boardId || !board) return;
  const step = takeStep(historyByBoardId.get(boardId) ?? EMPTY_HISTORY, direction);
  if (!step) return;
  historyByBoardId.set(boardId, step.history);
  const outcome = await sendBoardOps(boardId, step.entry);
  if (!outcome.ok) {
    status.show('error', `could not ${direction} that change, so it was dropped: ${outcome.error}`);
    return;
  }
  const entry = undoEntryOf(board, boardId, outcome.diff);
  if (!entry) {
    historyByBoardId.set(boardId, EMPTY_HISTORY);
    status.show('ok', TOO_BIG_TO_UNDO_TEXT);
    return;
  }
  status.clear();
  historyByBoardId.set(boardId, recordStep(historyByBoardId.get(boardId) ?? EMPTY_HISTORY, direction, entry));
}

async function sendOps(ops: Op[]): Promise<boolean> {
  if (!selectedBoardId || ops.length === 0) return false;
  const outcome = await sendRecordedOps(selectedBoardId, ops);
  if (outcome.ok && !outcome.isUndoable) {
    status.show('ok', TOO_BIG_TO_UNDO_TEXT);
    return true;
  }
  if (outcome.ok) {
    status.clear();
    return true;
  }
  status.show('error', outcome.error);
  return false;
}

async function sendOpsFromDialog(ops: Op[]): Promise<string | null> {
  if (!selectedBoardId) return 'No board is open.';
  const outcome = await sendRecordedOps(selectedBoardId, ops);
  return outcome.ok ? null : outcome.error;
}

function sessionLabel(sessionId: string): string {
  const ui = findSessionUi(sessionId);
  return ui ? sessionName(ui) : 'closed session';
}

function codeSessionChoices(): { value: string; text: string }[] {
  const connectedSessionIds = selectedSummary()?.connectedSessionIds ?? [];
  const codeSessionId = selectedBoard()?.codeSessionId;
  const sessionIds = codeSessionId && !connectedSessionIds.includes(codeSessionId) ? [codeSessionId, ...connectedSessionIds] : connectedSessionIds;
  return sessionIds.map((sessionId) => ({ value: sessionId, text: sessionLabel(sessionId) }));
}

function selectedElementsOfKind<Kind extends Element['kind']>(kind: Kind): Extract<Element, { kind: Kind }>[] {
  const board = selectedBoard();
  const selectedIds = editor?.selectedIds() ?? new Set<string>();
  return [...selectedIds]
    .flatMap((elementId) => board?.elements[elementId] ?? [])
    .filter((element): element is Extract<Element, { kind: Kind }> => element.kind === kind);
}

function paintToolbar(): void {
  if (!parts) return;
  const board = selectedBoard();
  const selectedBoxCount = selectedElementsOfKind('box').length;
  for (const button of parts.toolButtons.values()) button.disabled = !board;
  parts.buttons.note.disabled = selectedBoxCount !== 1;
  parts.buttons.frame.disabled = selectedBoxCount === 0;
  for (const button of [parts.buttons.step, parts.buttons.fit, parts.buttons.undo, parts.buttons.redo]) button.disabled = !board;
  inspector?.paint(editor?.selectedIds() ?? new Set());
}

function paintList(): void {
  if (!parts) return;
  const summaries = boardSummariesOf();
  if (selectedBoardId && !summaries.some((summary) => summary.id === selectedBoardId)) selectedBoardId = null;
  const fallbackBoard = summaries.find((summary) => pairedSessionId !== null && summary.connectedSessionIds.includes(pairedSessionId)) ?? summaries[0];
  if (!selectedBoardId && fallbackBoard) selectBoard(fallbackBoard.id);
  parts.boardMenu.paintBoards(summaries);
  paintHead();
}

function isRenamingTitle(): boolean {
  return Boolean(parts?.boardIsland.querySelector(`.${TITLE_RENAME_CLASS}`));
}

function startTitleRename(): void {
  const summary = selectedSummary();
  if (!parts || !summary || isRenamingTitle()) return;
  const { boardTitle } = parts;
  const input = el('input', TITLE_RENAME_CLASS);
  input.type = 'text';
  input.value = summary.title;
  input.maxLength = WHITEBOARD_LIMITS.title;
  input.setAttribute('aria-label', 'Board title');
  boardTitle.replaceWith(input);
  input.focus();
  input.select();
  let isFinished = false;

  function finish(shouldSave: boolean): void {
    if (isFinished || !summary) return;
    isFinished = true;
    const newTitle = input.value.trim();
    input.replaceWith(boardTitle);
    paintHead();
    if (shouldSave && newTitle && newTitle !== summary.title) void sendOps([{ op: 'board', title: newTitle }]);
  }

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    finish(event.key === 'Enter');
  });
}

function boardMenuItem(summary: BoardSummary): HTMLButtonElement {
  const item = buildMenuItem(summary.title, 'visible wb-board-menu-board');
  item.setAttribute('role', 'menuitemradio');
  item.setAttribute('aria-checked', String(summary.id === selectedBoardId));
  const sessionCount = summary.connectedSessionIds.length;
  if (sessionCount > 0) item.append(el('span', 'wb-board-menu-count', String(sessionCount)));
  item.addEventListener('click', () => selectBoard(summary.id));
  return item;
}

function buildBoardMenu(onBoardSettings: () => void) {
  const menuRoot = el('div', 'session-overflow wb-board-menu');
  const menu = el('div', 'popup-menu session-overflow-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Board menu');
  const isOpen = () => menu.classList.contains('open');
  const setOpen = (shouldOpen: boolean) => {
    boardSettingsItem.classList.toggle('visible', !isPhoneLayout());
    menu.classList.toggle('open', shouldOpen);
    trigger.setAttribute('aria-expanded', String(shouldOpen));
  };
  const trigger = menuButton({ label: 'board menu', action: 'open-board-menu', onClick: () => setOpen(!isOpen()) });
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const actionItem = (label: string, onChoose: () => void, extraClass = '') => {
    const item = buildMenuItem(label, `visible ${extraClass}`.trim());
    item.addEventListener('click', onChoose);
    return item;
  };
  const divider = el('div', 'menu-divider');
  divider.setAttribute('role', 'separator');
  const boardSettingsItem = actionItem('board settings', onBoardSettings);
  const actionItems = [
    divider,
    actionItem('rename board', startTitleRename),
    actionItem('new board', newBoardFromDialog),
    boardSettingsItem,
    actionItem('delete board', confirmDeleteBoard, 'wb-board-menu-danger'),
  ];
  menu.addEventListener('click', (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('[role^="menuitem"]')) setOpen(false);
  });
  menuRoot.append(trigger, menu);
  wirePopupMenuKeys({
    trigger,
    menu,
    menuItems: () => [...menu.querySelectorAll<HTMLElement>('.visible[role^="menuitem"]')],
    isOpen,
    open: () => setOpen(true),
    close: () => setOpen(false),
  });
  document.addEventListener('click', (event) => {
    if (isOpen() && event.target instanceof Node && !menuRoot.contains(event.target)) setOpen(false);
  });
  const paintBoards = (summaries: readonly BoardSummary[]) => menu.replaceChildren(...summaries.map(boardMenuItem), ...actionItems);
  return { menuRoot, trigger, paintBoards };
}

function buildMoreMenu(menuItems: readonly HTMLButtonElement[]): HTMLElement {
  const menuRoot = el('div', 'session-overflow wb-more-menu');
  const menu = el('div', 'popup-menu session-overflow-menu wb-more-menu-popup');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'More tools');
  const isOpen = () => menu.classList.contains('open');
  const setOpen = (shouldOpen: boolean) => {
    menu.classList.toggle('open', shouldOpen);
    trigger.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) placeMenuAtTrigger(menu, trigger);
  };
  const trigger = button({ variant: 'quiet', label: 'more', icon: createLineIcon(MORE_ICON_PATH, '1.5'), action: 'open-more-tools', onClick: () => setOpen(!isOpen()) });
  trigger.classList.add('wb-more-trigger');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  menu.append(...menuItems);
  menu.addEventListener('click', (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('[role="menuitem"]')) setOpen(false);
  });
  menuRoot.append(trigger);
  document.body.append(menu);
  wirePopupMenuKeys({
    trigger,
    menu,
    menuItems: () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')],
    isOpen,
    open: () => setOpen(true),
    close: () => setOpen(false),
  });
  document.addEventListener('click', (event) => {
    if (isOpen() && event.target instanceof Node && !menuRoot.contains(event.target) && !menu.contains(event.target)) setOpen(false);
  });
  window.addEventListener('resize', () => setOpen(false));
  return menuRoot;
}

function placeMenuAtTrigger(menu: HTMLElement, trigger: HTMLElement): void {
  const triggerRect = trigger.getBoundingClientRect();
  const isRoomBelow = triggerRect.bottom + MENU_GAP_PX + menu.offsetHeight <= window.innerHeight;
  menu.style.right = `${Math.max(0, window.innerWidth - triggerRect.right)}px`;
  menu.style.top = isRoomBelow ? `${triggerRect.bottom + MENU_GAP_PX}px` : 'auto';
  menu.style.bottom = isRoomBelow ? 'auto' : `${window.innerHeight - triggerRect.top + MENU_GAP_PX}px`;
}

function moreMenuItem(label: string, action: string, onChoose: () => void): HTMLButtonElement {
  const item = buildMenuItem(label, 'visible');
  item.dataset.action = action;
  item.addEventListener('click', onChoose);
  return item;
}

function paintHead(): void {
  if (!parts) return;
  const summary = selectedSummary();
  const hasBoards = boardSummariesOf().length > 0;
  parts.canvas.hidden = !summary;
  parts.empty.hidden = Boolean(summary);
  parts.emptyText.textContent = hasBoards ? PICK_TEXT : EMPTY_TEXT;
  if (!summary) return;
  parts.boardTitle.textContent = summary.title;
  parts.boardMeta.textContent = `v${summary.version}`;
  paintToolbar();
  paintPairedSession();
}

function paintPresence(connectedSessionIds: readonly string[]): void {
  if (!parts) return;
  const connectedNames = connectedSessionIds.map(sessionLabel);
  const pillNames = connectedSessionIds.filter((sessionId) => sessionId !== pairedSessionId).map(sessionLabel);
  const connectedCount = el('span', connectedNames.length === 0 ? 'wb-presence-count wb-presence-none' : 'wb-presence-count wb-presence-pill', `${connectedNames.length} connected`);
  if (connectedNames.length > 0) connectedCount.append(el('span', 'sr-only', `: ${connectedNames.join(', ')}`));
  parts.presence.replaceChildren(...pillNames.map((name) => el('span', 'wb-presence-pill', name)), connectedCount);
  if (connectedNames.length === 0) parts.presence.prepend(el('span', 'wb-presence-none', 'no sessions connected'));
}

function queuedForSessionText(summary: BoardSummary | null, sessionId: string): string {
  const name = sessionLabel(sessionId);
  if (!summary?.connectedSessionIds.includes(sessionId)) return `${name} is not connected to this board`;
  const queuedCount = summary.queuedBySessionId[sessionId] ?? 0;
  if (queuedCount === 0) return `${name} has read every change`;
  return `${queuedCount} board ${queuedCount === 1 ? 'edit' : 'edits'} queued for ${name}`;
}

function paintPairedSession(): void {
  if (!parts) return;
  const summary = selectedSummary();
  paintPresence(summary?.connectedSessionIds ?? []);
  parts.agentIsland.hidden = !pairedSessionId;
  if (!pairedSessionId) return;
  parts.agentIsland.toggleAttribute('data-idle', !hasNewsForPairedSession(summary, pairedSessionId));
  parts.queuedForSession.textContent = queuedForSessionText(summary, pairedSessionId);
}

function hasNewsForPairedSession(summary: BoardSummary | null, sessionId: string): boolean {
  if (!summary?.connectedSessionIds.includes(sessionId)) return true;
  return (summary.queuedBySessionId[sessionId] ?? 0) > 0;
}

function worthALookIdsOf(board: Board, worthALookPaths: readonly string[]): Set<string> {
  const worthALook = new Set(worthALookPaths);
  return new Set(Object.values(board.elements)
    .filter((element) => refsOfElement(element).some((ref) => worthALook.has(refPathOf(ref) ?? '')))
    .map((element) => element.id));
}

function openRefInReview(ref: string): void {
  const codeSessionId = selectedBoard()?.codeSessionId;
  const openPath = refPathOf(ref);
  if (!codeSessionId || !openPath) return;
  openFileInReview(codeSessionId, openPath);
}

function paintReview(): void {
  if (!parts || !renderer) return;
  const board = selectedBoard();
  const review = board && shownReview?.boardId === board.id ? shownReview.review : null;
  renderer.setReviewMarks({
    worthALookIds: board && review ? worthALookIdsOf(board, review.worthALookPaths) : new Set(),
    flaggedStepIds: new Set(review?.flaggedStepIds ?? []),
  });
}

function requestReviewOf(board: Board): void {
  const requestKey = `${board.id}@${board.version}`;
  if (reviewRequestKey === requestKey) return;
  reviewRequestKey = requestKey;
  void requestBoardReview(board.id).then((outcome) => {
    if (reviewRequestKey !== requestKey) return;
    if (!outcome.ok) {
      reviewRequestKey = null;
      return;
    }
    shownReview = { boardId: board.id, review: outcome.review };
    paintReview();
  });
}

function drawSelectedBoard(boardRenderer: BoardRenderer, board: Board | null): boolean {
  const tiled = selectedBoardId ? tiledBoardOf(selectedBoardId) : null;
  const shown = board ? (editor?.previewOf(board) ?? board) : null;
  const isPreviewing = shown !== board;
  const isTiledDrawable = tiled !== null && (!board || (tiled.version >= board.version && tiled.lod !== 'blocks'));
  if (tiled && isTiledDrawable && !isPreviewing) {
    boardRenderer.renderLayout(tiled.layout, tiled.blocks);
    return true;
  }
  if (!shown) return false;
  boardRenderer.render(shown);
  return true;
}

function paintBoard(): void {
  if (!renderer) return;
  const board = selectedBoard();
  const isDrawn = drawSelectedBoard(renderer, board);
  if (!board) {
    if (!isDrawn) renderer.clear();
    if (parts) parts.emptyBoardHint.hidden = true;
    return;
  }
  requestReviewOf(board);
  editor?.pruneSelection(board);
  if (parts) parts.emptyBoardHint.hidden = Object.keys(board.elements).length > 0;
  paintReview();
  editor?.openPendingTitleEdit();
  if (shouldFitOnNextRender) {
    editor?.fit();
    shouldFitOnNextRender = false;
  }
  paintToolbar();
}

function selectBoard(boardId: string): void {
  if (selectedBoardId === boardId) return;
  selectedBoardId = boardId;
  shouldFitOnNextRender = true;
  editor?.clearSelection();
  editor?.closeTitleInput();
  inspector?.closeBoardSettings();
  renderer?.clear();
  status.clear();
  paintList();
  void openBoard(boardId).then(paintBoard);
}

function addStepFromDialog(): void {
  const board = selectedBoard();
  if (!board) return;
  const otherBoards = boardSummariesOf().filter((summary) => summary.id !== board.id);
  const linkOptions = [{ value: '', text: 'No linked board' }, ...otherBoards.map((summary) => ({ value: summary.id, text: summary.title }))];
  openTextDialog({
    title: 'Add a plan step',
    label: 'Step title',
    placeholder: 'index the diffs',
    maxLength: WHITEBOARD_LIMITS.title,
    confirmLabel: 'Add step',
    choices: otherBoards.length > 0 ? { label: 'Linked board', options: linkOptions } : undefined,
    onSubmit: (title, linkedBoardId) => sendOpsFromDialog([{
      op: 'add',
      element: {
        kind: 'box', id: newElementId('box'), title, lines: [], refs: [], change: 'none', was: null, near: null, order: 0, at: null,
        shape: 'box', outputs: [], media: null, width: null, step: { status: 'planned', linkedBoardId: linkedBoardId || null },
      },
    }]),
  });
}

function pressedMediaOf({ boxId }: PressedImage): BoxMedia | null {
  const pressedBox = boxId ? selectedBoard()?.elements[boxId] : undefined;
  return pressedBox?.kind === 'box' ? pressedBox.media : null;
}

function enlargedMediaOf(pressedImage: PressedImage, media: BoxMedia | null): HTMLElement {
  const originalHref = media ? `${WHITEBOARD_ASSET_ROUTE}/${boardMediaOriginalFilename(media)}` : pressedImage.href;
  if (media?.kind === 'page') return createSandboxedFrame({ source: { kind: 'url', url: `${originalHref}?${BOARD_PAGE_VIEWER_PARAM}=1` }, className: 'wb-image-viewer-page', title: pressedImage.alt || 'page', allowsScripts: true });
  if (media?.kind === 'video') {
    const video = el('video', 'wb-image-viewer-video');
    video.src = originalHref;
    video.controls = true;
    video.playsInline = true;
    video.autoplay = true;
    return video;
  }
  const picture = el('img', 'wb-image-viewer-picture');
  picture.src = originalHref;
  picture.alt = pressedImage.alt;
  return picture;
}

function closeOnEscapeInsidePage(pageFrame: HTMLIFrameElement, overlay: HTMLElement, close: () => void): void {
  const listening = new AbortController();
  window.addEventListener('message', (event) => {
    if (event.source !== pageFrame.contentWindow || event.data !== BOARD_PAGE_ESCAPE_MESSAGE) return;
    close();
  }, { signal: listening.signal });
  const overlayWatcher = new MutationObserver(() => {
    if (overlay.isConnected) return;
    listening.abort();
    overlayWatcher.disconnect();
  });
  overlayWatcher.observe(document.body, { childList: true });
}

function docMediaOf(boardId: string, boxId: string): BoxMedia | null {
  const box = openBoardOf(boardId)?.elements[boxId];
  return box?.kind === 'box' && box.media?.kind === 'doc' ? box.media : null;
}

function boardDocKey(boardId: string): string {
  return `whiteboard:${boardId}`;
}

async function saveBoardDoc(boardId: string, boxId: string, docText: string, loadedAsset: string): ReturnType<DocSource['save']> {
  const media = docMediaOf(boardId, boxId);
  const box = openBoardOf(boardId)?.elements[boxId];
  if (!media || box?.kind !== 'box' || media.asset !== loadedAsset) return { ok: false, isConflict: true, error: null };
  const stored = await uploadBoardMedia(new File([docText], `${boxId}.md`, { type: 'text/markdown' }));
  if (!stored.ok) return { ok: false, isConflict: false, error: stored.error };
  if (stored.media.kind !== 'doc') return { ok: false, isConflict: false, error: BOARD_DOC_NOT_MARKDOWN_TEXT };
  if (docMediaOf(boardId, boxId)?.asset !== loadedAsset) return { ok: false, isConflict: true, error: null };
  const sent = await sendRecordedOps(boardId, [{ op: 'set', id: boxId, fields: { media: { ...stored.media, alt: media.alt } } }]);
  if (!sent.ok) return { ok: false, isConflict: false, error: sent.error };
  return { ok: true, hash: stored.media.asset };
}

function boardDocSource(boardId: string, boxId: string, title: string): DocSource {
  return {
    key: boardDocKey(boardId),
    docs: () => [{ path: boxId, name: title }],
    isSaveable: () => docMediaOf(boardId, boxId) !== null,
    hasMarkup: false,
    openingMode: 'preview',
    conflictText: BOARD_DOC_CONFLICT_TEXT,
    unsaveableText: BOARD_DOC_GONE_TEXT,
    read: async () => {
      const media = docMediaOf(boardId, boxId);
      if (!media) return { ok: false, error: BOARD_DOC_GONE_TEXT };
      const docText = await fetchBoardDocText(media);
      if (docText === null) return { ok: false, error: BOARD_DOC_UNREAD_TEXT };
      return { ok: true, text: docText, hash: media.asset };
    },
    save: (_docPath, docText, loadedAsset) => saveBoardDoc(boardId, boxId, docText, loadedAsset),
  };
}

function openBoardDoc(boardId: string, boxId: string): void {
  const box = openBoardOf(boardId)?.elements[boxId];
  if (box?.kind !== 'box') return;
  openDocEditorOn(boardDocSource(boardId, boxId, box.title));
}

function openImageViewer(pressedImage: PressedImage): void {
  const { alt } = pressedImage;
  const media = pressedMediaOf(pressedImage);
  if (!media && !pressedImage.href) return;
  if (media?.kind === 'doc' && selectedBoardId && pressedImage.boxId) {
    openBoardDoc(selectedBoardId, pressedImage.boxId);
    return;
  }
  const { overlay, dialog, close, titleEl, btnCancel } = buildDialogShell({ title: alt || 'Picture', dialogClass: 'dialog wb-image-viewer', cancelLabel: 'Close' });
  const header = el('div', 'wb-image-viewer-header');
  titleEl.replaceWith(header);
  header.append(titleEl, btnCancel);
  const enlargedMedia = enlargedMediaOf(pressedImage, media);
  dialog.append(enlargedMedia);
  if (enlargedMedia instanceof HTMLIFrameElement) closeOnEscapeInsidePage(enlargedMedia, overlay, close);
  btnCancel.addEventListener('click', close);
  requestAnimationFrame(() => btnCancel.focus());
}

function addNoteOn(boxId: string): void {
  openTextDialog({
    title: 'Pin a note',
    label: 'Note',
    placeholder: 'what about retries?',
    maxLength: WHITEBOARD_LIMITS.noteText,
    confirmLabel: 'Pin note',
    onSubmit: (text) => sendOpsFromDialog([{ op: 'add', element: { kind: 'note', id: newElementId('note'), on: boxId, text, ref: null, author: '', resolvedBy: null } }]),
  });
}

function connectBoxes(fromBoxId: string, toBoxId: string): void {
  const board = selectedBoard();
  if (!board || fromBoxId === toBoxId) return;
  const isAlreadyWired = Object.values(board.elements).some((element) => element.kind === 'wire' && element.from === fromBoxId && element.to === toBoxId);
  if (isAlreadyWired) return;
  void sendOps([{ op: 'add', element: { kind: 'wire', id: newElementId('wire'), from: fromBoxId, to: toBoxId, fromOutput: null, dashed: false, tone: 'plain', label: null, fromSide: null, toSide: null, back: false } }]);
}

function addFrame(): void {
  const contains = selectedElementsOfKind('box').map((box) => box.id);
  if (contains.length === 0) return;
  openTextDialog({
    title: 'Frame the selected boxes',
    label: 'Frame title',
    placeholder: 'intake',
    maxLength: WHITEBOARD_LIMITS.title,
    confirmLabel: 'Add frame',
    onSubmit: async (title) => {
      const error = await sendOpsFromDialog([{ op: 'add', element: { kind: 'frame', id: newElementId('frame'), title, contains, loop: false } }]);
      if (!error) editor?.clearSelection();
      return error;
    },
  });
}

function confirmDeleteBoard(): void {
  const summary = selectedSummary();
  if (!summary) return;
  const connectedNames = summary.connectedSessionIds.map(sessionLabel);
  const connectedText = connectedNames.length > 0 ? ` ${connectedNames.join(', ')} ${connectedNames.length === 1 ? 'is' : 'are'} connected and will lose it.` : '';
  openConfirmDialog({
    title: 'Delete board',
    message: `Delete "${summary.title}" for good?${connectedText}`,
    confirmLabel: 'Delete board',
    danger: true,
    onConfirm: () => {
      void deleteBoard(summary.id).then((outcome) => {
        if (!outcome.ok) status.show('error', outcome.error);
      });
    },
  });
}

function newBoardFromDialog(): void {
  createBoardFromDialog(selectBoard);
}

export function createBoardFromDialog(onCreated: (boardId: string) => void): void {
  openTextDialog({
    title: 'New board',
    label: 'Board title',
    placeholder: 'knowledge writer',
    maxLength: WHITEBOARD_LIMITS.title,
    confirmLabel: 'Create board',
    onSubmit: async (title) => {
      const outcome = await createBoard(title);
      if (!outcome.ok) return outcome.error;
      onCreated(outcome.boardId);
      return null;
    },
  });
}

function iconButton(label: string, iconPath: string, action: string, onClick: () => void): HTMLButtonElement {
  return button({ variant: 'icon', label, icon: createLineIcon(iconPath, '1.5'), action, onClick });
}

function toolButton(tool: BoardTool, label: string, key: string, iconPath: string): HTMLButtonElement {
  const toolOption = createPressable('wb-tool');
  toolOption.setAttribute('aria-label', label);
  const keyHint = el('span', 'wb-tool-key', key);
  keyHint.setAttribute('aria-hidden', 'true');
  toolOption.append(createLineIcon(iconPath, '1.5'), keyHint);
  toolOption.setAttribute('aria-keyshortcuts', key);
  toolOption.setAttribute('aria-pressed', String(tool === 'select'));
  toolOption.addEventListener('click', () => {
    editor?.setTool(tool);
    editor?.focusCanvas();
  });
  return toolOption;
}

function island(className: string, label: string, ...children: HTMLElement[]): HTMLElement {
  const container = el('div', `wb-island ${className}`);
  container.setAttribute('role', 'toolbar');
  container.setAttribute('aria-label', label);
  container.append(...children);
  return container;
}

function paintActiveTool(activeTool: BoardTool): void {
  if (!parts) return;
  for (const [tool, button] of parts.toolButtons) button.setAttribute('aria-pressed', String(tool === activeTool));
  const hint = TOOL_BUTTONS.find(({ tool }) => tool === activeTool)?.hint ?? null;
  parts.toolHint.textContent = hint ?? '';
  parts.toolHint.hidden = hint === null;
}

function historyDirectionOf(event: KeyboardEvent): UndoDirection | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.code !== 'KeyZ') return null;
  return event.shiftKey ? 'redo' : 'undo';
}

function isFieldOwningHistoryKey(event: KeyboardEvent): boolean {
  if (document.activeElement instanceof HTMLSelectElement) return false;
  return isRealInputOwningKey(event);
}

function onHistoryKey(host: HTMLElement, event: KeyboardEvent): void {
  const direction = historyDirectionOf(event);
  if (!direction || !host.checkVisibility() || isModalOpen() || isFieldOwningHistoryKey(event)) return;
  if (document.activeElement?.classList.contains('xterm-helper-textarea')) return;
  event.preventDefault();
  void stepHistory(direction);
}

function isBoardMediaFile(file: File): boolean {
  if (file.type.startsWith('image/') || BOARD_MEDIA_FILE_TYPES.has(file.type)) return true;
  return file.type === '' && BOARD_MEDIA_FILE_NAME_RE.test(file.name);
}

function mediaFilesOf(transfer: DataTransfer | null): File[] {
  return [...(transfer?.files ?? [])].filter(isBoardMediaFile);
}

function titleOfMediaFile(file: File): string {
  return (file.name.replace(/\.[^.]+$/, '') || 'Picture').slice(0, WHITEBOARD_LIMITS.title);
}

async function addMediaFiles(files: readonly File[], clientPoint: { x: number; y: number } | null): Promise<void> {
  if (!selectedBoardId || files.length === 0) return;
  status.show('busy', files.length === 1 ? `adding ${files[0]?.name}` : `adding ${files.length} files`);
  for (const [index, file] of files.entries()) {
    const stored = await uploadBoardMedia(file);
    if (!stored.ok) {
      status.show('error', stored.error);
      return;
    }
    const offset = index * STACKED_MEDIA_OFFSET_PX;
    const stackedPoint = clientPoint ? { x: clientPoint.x + offset, y: clientPoint.y + offset } : null;
    const media = { ...stored.media, alt: file.name.slice(0, WHITEBOARD_LIMITS.line) };
    const isPlaced = await editor?.placeMediaBox(titleOfMediaFile(file), media, stackedPoint);
    if (!isPlaced) return;
  }
  status.clear();
}

function wireMediaDrops(host: HTMLElement, canvas: HTMLElement): void {
  canvas.addEventListener('dragover', (event) => {
    if (!selectedBoardId || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  canvas.addEventListener('drop', (event) => {
    const files = mediaFilesOf(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    void addMediaFiles(files, { x: event.clientX, y: event.clientY });
  });
  document.addEventListener('paste', (event) => {
    if (!host.checkVisibility() || isModalOpen() || isTextEntryFocused()) return;
    const files = mediaFilesOf(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void addMediaFiles(files, null);
  });
}

function isTextEntryFocused(): boolean {
  const focused = document.activeElement;
  if (focused?.classList.contains('xterm-helper-textarea')) return true;
  return focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || (focused instanceof HTMLElement && focused.isContentEditable);
}

export function mountBoardHost(): HTMLElement {
  if (parts) return parts.host;
  const host = el('div', 'boards-view');
  const boardMenu = buildBoardMenu(() => {
    editor?.clearSelection();
    inspector?.openBoardSettings();
  });
  boardMenu.trigger.dataset.phoneVisible = '';
  const boardTitle = createPressable('wb-board-title pane-header-title');
  boardTitle.addEventListener('click', startTitleRename);
  const boardMeta = el('span', 'wb-board-meta pane-header-subtitle');
  const presence = el('div', 'wb-presence');
  const boardIsland = island('wb-island-board', 'Board', boardMenu.menuRoot, boardTitle, boardMeta, presence, status.element);

  const toolButtons = new Map(TOOL_BUTTONS.map(({ tool, label, key, iconPath }) => [tool, toolButton(tool, label, key, iconPath)]));
  const toolGroup = el('div', 'wb-tools');
  toolGroup.setAttribute('role', 'group');
  toolGroup.setAttribute('aria-label', 'Drawing tools');
  toolGroup.append(...toolButtons.values());
  const buttons = {
    note: moreMenuItem('note on box', 'add-note', () => {
      const [box] = selectedElementsOfKind('box');
      if (box) addNoteOn(box.id);
    }),
    frame: moreMenuItem('frame selected boxes', 'add-frame', addFrame),
    step: moreMenuItem('plan step', 'add-step', addStepFromDialog),
    fit: iconButton('fit', FIT_ICON_PATH, 'fit-board', () => editor?.fit()),
    undo: iconButton('undo', UNDO_ICON_PATH, 'undo-board-edit', () => void stepHistory('undo')),
    redo: iconButton('redo', REDO_ICON_PATH, 'redo-board-edit', () => void stepHistory('redo')),
  };
  buttons.fit.dataset.phoneVisible = '';
  const toolDivider = el('span', 'wb-divider');
  toolDivider.setAttribute('aria-hidden', 'true');
  const toolsIsland = island('wb-island-tools', 'Board tools', toolGroup, toolDivider, buildMoreMenu([buttons.note, buttons.frame, buttons.step]));
  const toolHint = el('p', 'wb-tool-hint');
  toolHint.setAttribute('aria-live', 'polite');
  toolHint.hidden = true;
  const viewIsland = island('wb-island-view', 'View', buttons.fit, buttons.undo, buttons.redo);

  const canvas = el('div', 'wb-canvas');
  const viewport = el('div', 'wb-viewport');
  viewport.setAttribute('role', 'application');
  viewport.setAttribute('aria-label', 'Whiteboard');
  const world = el('div', 'wb-world');
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'wb-svg');
  svg.setAttribute('aria-hidden', 'true');
  const mediaLayer = createBoardMediaLayer();
  world.append(svg, mediaLayer.element);
  const glCanvas = el('canvas', 'wb-gl');
  glCanvas.setAttribute('aria-hidden', 'true');
  const glNotice = el('p', 'wb-gl-notice');
  glNotice.setAttribute('role', 'status');
  glNotice.hidden = true;
  viewport.append(glCanvas, world, glNotice);
  const inspectPanel = el('aside', 'wb-inspect');
  const queuedForSession = el('span', 'wb-session-queued');
  const agentIsland = island('wb-island-agent', 'Session', queuedForSession);
  agentIsland.hidden = true;
  const bottomLeftStack = el('div', 'wb-bottom-left');
  bottomLeftStack.append(agentIsland);
  const chrome = el('div', 'wb-top-left');
  chrome.append(boardIsland, viewIsland, toolsIsland, toolHint);
  const topRightStack = el('div', 'wb-top-right');
  topRightStack.append(inspectPanel);
  const emptyBoardHint = el('div', 'wb-empty-board');
  emptyBoardHint.hidden = true;
  const emptyBoardHow = el('p', 'wb-empty-board-desc');
  emptyBoardHow.append(
    el('span', 'wb-empty-board-keys', 'Pick box (R) and click the board to place one, or ask a session to draw here.'),
    el('span', 'wb-empty-board-touch', 'Ask a session to draw here.'),
  );
  emptyBoardHint.append(el('p', 'wb-empty-board-title', 'This board is empty.'), emptyBoardHow);
  canvas.append(viewport, emptyBoardHint, topRightStack, chrome, bottomLeftStack);
  const emptyText = el('p', 'wb-empty-text', EMPTY_TEXT);
  const empty = el('div', 'wb-empty');
  empty.append(emptyText, button({ variant: 'secondary', label: 'new board', action: 'new-board', onClick: newBoardFromDialog }));

  host.replaceChildren(canvas, empty);
  parts = { boardIsland, boardMenu, boardTitle, boardMeta, presence, host, chrome, canvas, empty, emptyText, agentIsland, queuedForSession, buttons, toolButtons, toolHint, emptyBoardHint };
  const boardRenderer = createBoardRenderer({
    canvas: glCanvas,
    viewport,
    fontSource: svg,
    mediaLayer,
    notice: glNotice,
    onViewChange: (view, scale) => {
      if (selectedBoardId) showTilesFor(selectedBoardId, view, scale);
    },
  });
  renderer = boardRenderer;
  inspector = createBoardInspector({ container: inspectPanel, currentBoard: selectedBoard, layout: () => boardRenderer.layout(), sendOps, codeSessionChoices, openRef: openRefInReview });
  editor = createBoardEditor({
    viewport,
    world,
    svg,
    canvas,
    renderer: boardRenderer,
    currentBoard: selectedBoard,
    sendOps,
    onSelectionChange: paintToolbar,
    onPhoneTapBox: addNoteOn,
    onOpenLinkedBoard: selectBoard,
    onOpenImage: openImageViewer,
    onConnectBoxes: connectBoxes,
    onToolChange: paintActiveTool,
  });

  document.addEventListener('keydown', (event) => onHistoryKey(host, event));
  wireMediaDrops(host, canvas);
  onBoardListChanged(paintList);
  onBoardChanged((boardId) => {
    applyDocsToOpenEditor(boardDocKey(boardId));
    if (boardId !== selectedBoardId) return;
    paintBoard();
  });
  onTilesChanged(paintBoard);
  paintList();
  return host;
}

function isPhoneLayout(): boolean {
  return document.documentElement.dataset.layout === 'phone';
}

export function placeBoardTitle(titleSlot: HTMLElement | null): void {
  if (!parts) return;
  if (!titleSlot) {
    if (parts.chrome.firstElementChild !== parts.boardIsland) parts.chrome.prepend(parts.boardIsland);
    return;
  }
  if (parts.boardIsland.parentElement !== titleSlot) titleSlot.append(parts.boardIsland);
}

export function showBoardBeside(boardId: string | null, sessionId: string | null): void {
  pairedSessionId = sessionId;
  if (boardId) selectBoard(boardId);
  paintPairedSession();
}

export function reopenSelectedBoard(): void {
  paintList();
  reviewRequestKey = null;
  if (selectedBoardId) void openBoard(selectedBoardId).then(paintBoard);
}

let boardsScreen: HTMLElement | null = null;

function mountBoardsScreen(panel: HTMLElement): void {
  boardsScreen = panel;
  panel.replaceChildren(mountBoardHost());
}

function refreshBoardsScreen(): void {
  const host = mountBoardHost();
  if (boardsScreen && host.parentElement !== boardsScreen) boardsScreen.replaceChildren(host);
  placeBoardTitle(null);
  const request = takeOpenBoardRequest();
  showBoardBeside(request?.boardId ?? null, null);
  reopenSelectedBoard();
}

export const view: ViewModule<HTMLElement> = { mount: mountBoardsScreen, refresh: refreshBoardsScreen };
