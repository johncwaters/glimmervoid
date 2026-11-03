import './whiteboard.css';
import type { Board, BoardReview, BoardSummary, Element, Op } from '#shared/contracts/whiteboard.ts';
import { refPathOf, refsOfElement } from '#shared/whiteboard-anchor-core.ts';
import { WHITEBOARD_LIMITS } from '#shared/contracts/whiteboard.ts';
import { createActionStatus } from '../action-status.ts';
import { el, isRealInputOwningKey } from '../dom-helpers.ts';
import { button, menuButton } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import { buildMenuItem, wirePopupMenuKeys } from '../menu.ts';
import { findSessionUi, sessionName } from '../session-card/card-registry.ts';
import { buildDialogShell, isModalOpen, openConfirmDialog } from '../session-card/modal.ts';
import { createLineIcon } from '../svg-dom.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { createBoardEditor, newElementId } from './board-edit.ts';
import type { BoardEditor, BoardTool, PressedImage } from './board-edit.ts';
import { EMPTY_HISTORY, inverseOps, recordEdit, recordStep, takeStep } from '#shared/whiteboard-undo-core.ts';
import type { UndoDirection, UndoHistory } from '#shared/whiteboard-undo-core.ts';
import { createBoardInspector } from './board-inspect.ts';
import type { BoardInspector } from './board-inspect.ts';
import { createBoardRenderer } from './board-render.ts';
import type { BoardRenderer } from './board-render.ts';
import {
  boardSummariesOf, createBoard, deleteBoard, nudgeSessionAboutBoard, onBoardChanged, onBoardListChanged, openBoard, openBoardOf, openFileInReview, requestBoardReview, sendBoardOps, takeOpenBoardRequest, uploadBoardImage,
} from './board-store.ts';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EMPTY_TEXT = 'No boards yet. Make one here, or have an agent run glimmervoid whiteboard new <title>.';
const PICK_TEXT = 'Pick a board above.';
const TITLE_RENAME_CLASS = 'wb-board-title-rename';
const SEND_TO_CHAT_ICON_PATH = 'M13.5 8H3 M7 4L3 8l4 4';
const MORE_ICON_PATH = 'M4.5 6.5L8 10l3.5-3.5';
const MENU_GAP_PX = 4;
const STACKED_IMAGE_OFFSET_PX = 32;
const FIT_ICON_PATH = 'M2.5 6V2.5H6 M10 2.5h3.5V6 M13.5 10v3.5H10 M6 13.5H2.5V10';
const UNDO_ICON_PATH = 'M5.5 3.5l-3 3l3 3 M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7';
const REDO_ICON_PATH = 'M10.5 3.5l3 3l-3 3 M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H9';
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
  sendToAgent: HTMLButtonElement;
  buttons: Record<'note' | 'frame' | 'unit' | 'fit' | 'undo' | 'redo', HTMLButtonElement>;
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
const status = createActionStatus('action-status wb-status');
const pairedStatus = createActionStatus('action-status wb-status');
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

function sendRecordedOps(boardId: string, ops: Op[]): Promise<{ ok: true } | { ok: false; error: string }> {
  return inHistoryOrder(() => sendAndRecord(boardId, ops));
}

async function sendAndRecord(boardId: string, ops: Op[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const before = selectedBoard();
  const outcome = await sendBoardOps(boardId, ops);
  if (outcome.ok && before?.id === boardId) historyByBoardId.set(boardId, recordEdit(historyByBoardId.get(boardId) ?? EMPTY_HISTORY, inverseOps(before, ops)));
  return outcome;
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
  status.clear();
  historyByBoardId.set(boardId, recordStep(historyByBoardId.get(boardId) ?? EMPTY_HISTORY, direction, inverseOps(board, step.entry)));
}

async function sendOps(ops: Op[]): Promise<boolean> {
  if (!selectedBoardId || ops.length === 0) return false;
  const outcome = await sendRecordedOps(selectedBoardId, ops);
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
  for (const button of [parts.buttons.unit, parts.buttons.fit, parts.buttons.undo, parts.buttons.redo]) button.disabled = !board;
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
  const trigger = button({ variant: 'quiet', size: 'small', label: 'more', icon: createLineIcon(MORE_ICON_PATH, '1.5'), action: 'open-more-tools', onClick: () => setOpen(!isOpen()) });
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
  connectedCount.title = connectedNames.join(', ');
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
  parts.sendToAgent.disabled = !summary?.connectedSessionIds.includes(pairedSessionId);
}

function hasNewsForPairedSession(summary: BoardSummary | null, sessionId: string): boolean {
  if (!summary?.connectedSessionIds.includes(sessionId)) return true;
  return (summary.queuedBySessionId[sessionId] ?? 0) > 0;
}

async function sendBoardNudge(): Promise<void> {
  if (!parts || !selectedBoardId || !pairedSessionId) return;
  parts.sendToAgent.disabled = true;
  pairedStatus.show('busy', 'sending');
  const outcome = await nudgeSessionAboutBoard(selectedBoardId, pairedSessionId);
  paintPairedSession();
  if (!outcome.ok) {
    pairedStatus.show('error', outcome.error);
    return;
  }
  pairedStatus.show('ok', 'sent; the agent reads the board when it is ready');
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
    flaggedUnitIds: new Set(review?.flaggedUnitIds ?? []),
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

function paintBoard(): void {
  if (!renderer) return;
  const board = selectedBoard();
  if (!board) {
    renderer.clear();
    if (parts) parts.emptyBoardHint.hidden = true;
    return;
  }
  requestReviewOf(board);
  editor?.pruneSelection(board);
  renderer.render(editor?.previewOf(board) ?? board);
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

function addUnitFromDialog(): void {
  const board = selectedBoard();
  if (!board) return;
  const otherBoards = boardSummariesOf().filter((summary) => summary.id !== board.id);
  const linkOptions = [{ value: '', text: 'No linked board' }, ...otherBoards.map((summary) => ({ value: summary.id, text: summary.title }))];
  openTextDialog({
    title: 'Add a unit',
    label: 'Unit title',
    placeholder: 'index the diffs',
    maxLength: WHITEBOARD_LIMITS.title,
    confirmLabel: 'Add unit',
    choices: otherBoards.length > 0 ? { label: 'Linked board', options: linkOptions } : undefined,
    onSubmit: (title, linkedBoardId) => sendOpsFromDialog([{ op: 'add', element: { kind: 'unit', id: newElementId('unit'), title, lines: [], refs: [], status: 'planned', after: [], linkedBoardId: linkedBoardId || null } }]),
  });
}

function originalHrefOf(previewHref: string): string {
  return previewHref.replace(/\.webp$/, '.original');
}

function openImageViewer({ href, alt }: PressedImage): void {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: alt || 'Picture', dialogClass: 'dialog wb-image-viewer', cancelLabel: 'Close' });
  const picture = el('img', 'wb-image-viewer-picture');
  picture.src = originalHrefOf(href);
  picture.alt = alt;
  dialog.append(picture, actions);
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
  toolOption.dataset.tipLabel = label;
  toolOption.dataset.tipDetail = key;
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

function onHistoryKey(host: HTMLElement, event: KeyboardEvent): void {
  const direction = historyDirectionOf(event);
  if (!direction || !host.checkVisibility() || isModalOpen() || isRealInputOwningKey(event)) return;
  if (document.activeElement?.classList.contains('xterm-helper-textarea')) return;
  event.preventDefault();
  void stepHistory(direction);
}

function imageFilesOf(transfer: DataTransfer | null): File[] {
  return [...(transfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));
}

function titleOfImageFile(file: File): string {
  return (file.name.replace(/\.[^.]+$/, '') || 'Picture').slice(0, WHITEBOARD_LIMITS.title);
}

async function addImageFiles(files: readonly File[], clientPoint: { x: number; y: number } | null): Promise<void> {
  if (!selectedBoardId || files.length === 0) return;
  status.show('busy', files.length === 1 ? `adding ${files[0]?.name}` : `adding ${files.length} pictures`);
  for (const [index, file] of files.entries()) {
    const stored = await uploadBoardImage(file);
    if (!stored.ok) {
      status.show('error', stored.error);
      return;
    }
    const offset = index * STACKED_IMAGE_OFFSET_PX;
    const stackedPoint = clientPoint ? { x: clientPoint.x + offset, y: clientPoint.y + offset } : null;
    const image = { asset: stored.asset, width: stored.width, height: stored.height, alt: file.name.slice(0, WHITEBOARD_LIMITS.line) };
    const isPlaced = await editor?.placeImageBox(titleOfImageFile(file), image, stackedPoint);
    if (!isPlaced) return;
  }
  status.clear();
}

function wireImageDrops(host: HTMLElement, canvas: HTMLElement): void {
  canvas.addEventListener('dragover', (event) => {
    if (!selectedBoardId || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  canvas.addEventListener('drop', (event) => {
    const files = imageFilesOf(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    void addImageFiles(files, { x: event.clientX, y: event.clientY });
  });
  document.addEventListener('paste', (event) => {
    if (!host.checkVisibility() || isModalOpen() || isTextEntryFocused()) return;
    const files = imageFilesOf(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void addImageFiles(files, null);
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
  boardTitle.title = 'Click to rename';
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
    unit: moreMenuItem('plan step', 'add-unit', addUnitFromDialog),
    fit: iconButton('fit', FIT_ICON_PATH, 'fit-board', () => editor?.fit()),
    undo: iconButton('undo', UNDO_ICON_PATH, 'undo-board-edit', () => void stepHistory('undo')),
    redo: iconButton('redo', REDO_ICON_PATH, 'redo-board-edit', () => void stepHistory('redo')),
  };
  buttons.fit.dataset.phoneVisible = '';
  const toolDivider = el('span', 'wb-divider');
  toolDivider.setAttribute('aria-hidden', 'true');
  const toolsIsland = island('wb-island-tools', 'Board tools', toolGroup, toolDivider, buildMoreMenu([buttons.note, buttons.frame, buttons.unit]));
  const toolHint = el('p', 'wb-tool-hint');
  toolHint.setAttribute('aria-live', 'polite');
  toolHint.hidden = true;
  const viewIsland = island('wb-island-view', 'View', buttons.fit, buttons.undo, buttons.redo);

  const canvas = el('div', 'wb-canvas');
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'wb-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Whiteboard');
  svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
  const inspectPanel = el('aside', 'wb-inspect');
  const queuedForSession = el('span', 'wb-session-queued');
  const sendToAgent = iconButton('send to agent', SEND_TO_CHAT_ICON_PATH, 'send-board-to-agent', () => void sendBoardNudge());
  const agentIsland = island('wb-island-agent', 'Session', sendToAgent, queuedForSession, pairedStatus.element);
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
  canvas.append(svg, emptyBoardHint, topRightStack, chrome, bottomLeftStack);
  const emptyText = el('p', 'wb-empty-text', EMPTY_TEXT);
  const empty = el('div', 'wb-empty');
  empty.append(emptyText, button({ variant: 'secondary', label: 'new board', action: 'new-board', onClick: newBoardFromDialog }));

  host.replaceChildren(canvas, empty);
  parts = { boardIsland, boardMenu, boardTitle, boardMeta, presence, host, chrome, canvas, empty, emptyText, agentIsland, queuedForSession, sendToAgent, buttons, toolButtons, toolHint, emptyBoardHint };
  const boardRenderer = createBoardRenderer(svg);
  renderer = boardRenderer;
  inspector = createBoardInspector({ container: inspectPanel, currentBoard: selectedBoard, layout: () => boardRenderer.layout(), sendOps, codeSessionChoices, openRef: openRefInReview });
  editor = createBoardEditor({
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
  wireImageDrops(host, canvas);
  onBoardListChanged(paintList);
  onBoardChanged((boardId) => {
    if (boardId !== selectedBoardId) return;
    paintBoard();
  });
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
  if (sessionId !== pairedSessionId) pairedStatus.clear();
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
