import './whiteboard.css';
import type { Board, BoardReview, BoardSummary, BoxMedia, DialValue, Element, Frame, LinkStateOfBox, Op, WorthALookPath } from '#shared/contracts/whiteboard.ts';
import { refPathOf, refsOfElement } from '#shared/whiteboard-anchor-core.ts';
import { ElementInput } from '#shared/contracts/whiteboard.ts';
import { CLIENT_LOG_TEXT_MAX_CHARS } from '#shared/contracts/control/control-fields.ts';
import { noteBoxTextOf } from '#shared/whiteboard-ops-core.ts';
import { SHAPE_TRAITS } from '#shared/whiteboard-shapes.ts';
import { BOARD_PAGE_ESCAPE_MESSAGE, BOARD_PAGE_TUNED_QUERY, BoardPageContentWidth, BOARD_PAGE_ZOOMED_MESSAGE, BoardPageGesture, BOARD_MEDIA_MAX_EDGE_PX, boardMediaOriginalFilename, boardPagePath, dialValuesOfBox, WHITEBOARD_ASSET_ROUTE, WHITEBOARD_LIMITS, WHITEBOARD_PICTURE_ROUTE } from '#shared/contracts/whiteboard.ts';
import { COMPACT_FLOORED_AGO, elapsedText } from '#shared/display-text.ts';
import { createActionStatus } from '../action-status.ts';
import { el, isRealInputOwningKey, markAsNotCredential } from '../dom-helpers.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';
import { wireColumnResizer } from '../column-resizer.ts';
import { button, menuButton } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import { buildMenuItem, wirePopupMenuKeys } from '../menu.ts';
import { findSessionUi, sessionName } from '../session-card/card-registry.ts';
import { buildDialogShell, isModalOpen, openConfirmDialog } from '../session-card/modal.ts';
import { onSessionTick } from '../session-card/session-tick.ts';
import { createLineIcon, REDO_ICON_PATH, UNDO_ICON_PATH } from '../svg-dom.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { createBoardEditor, newElementId, stacksByTopBoxIdOf } from './board-edit.ts';
import type { BoardEditor, BoardTool, PressedImage } from './board-edit.ts';
import { EMPTY_HISTORY, recordEdit, recordStep, takeStep, undoOpsOf } from '#shared/whiteboard-undo-core.ts';
import type { WhiteboardPatch } from '#shared/contracts/control/whiteboard-messages.ts';
import type { UndoDirection, UndoHistory } from '#shared/whiteboard-undo-core.ts';
import { createBoardInspector } from './board-inspect.ts';
import type { BoardInspector } from './board-inspect.ts';
import { createBoardRenderer } from './board-gl-renderer.ts';
import type { BoardRenderer } from './board-gl-renderer.ts';
import { boardGraphicsLogText, boardGraphicsTelemetryProperties } from './board-graphics-report-core.ts';
import type { BoardGraphicsEvent } from './board-graphics-report-core.ts';
import { countDashboardTabs } from '../boot/dashboard-tab-lock.ts';
import { sendControlMsg } from '../control-ws.ts';
import { liveTerminalWebglContextCount } from '../session-card/webgl-pool.ts';
import { onTilesChanged, resendTilesView, showTilesFor, tiledBoardOf } from './board-tile-store.ts';
import { createBoardMediaLayer, fetchBoardDocText, tunePageOnLoad } from './board-media-layer.ts';
import type { BoardMediaLayer } from './board-media-layer.ts';
import { applyPageGesture, attachMediaZoom } from './media-zoom.ts';
import type { MediaZoomControl } from './media-zoom.ts';
import { MAX_MEDIA_SCALE } from './media-zoom-core.ts';
import { applyDocsToOpenEditor, openDocEditorOn } from '../doc-editor/doc-editor.ts';
import type { DocSource } from '../doc-editor/doc-editor.ts';
import {
  boardSummariesOf, createBoard, deleteBoard, onBoardChanged, onBoardListChanged, openFileInReview, requestBoardReview, saveLinkedBoardDoc, sendBoardOps, takeOpenBoardRequest, uploadBoardMedia,
} from './board-store.ts';
import { clock } from '#shared/clock.ts';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EMPTY_TEXT = 'No boards yet. Make one here, or have an agent run glimmervoid whiteboard new <title>.';
const PICK_TEXT = 'Pick a board above.';
const TITLE_RENAME_CLASS = 'wb-board-title-rename';
const STACKED_MEDIA_OFFSET_PX = 32;
const BOARD_DOC_CONFLICT_TEXT = 'This document changed on the board since you opened it. Reload to see that version.';
const BOARD_DOC_GONE_TEXT = 'This document is no longer on the board, so it cannot be saved.';
const BOARD_DOC_UNREAD_TEXT = 'This document could not be read from the board.';
const BOARD_DOC_NOT_MARKDOWN_TEXT = 'Not saved: this text starts like a picture or an HTML page, so the board would not keep it as a document.';
const BOARD_MEDIA_FILE_TYPES = new Set(['video/mp4', 'video/webm', 'text/html']);
const BOARD_MEDIA_FILE_NAME_RE = /\.(png|jpe?g|gif|webp|svg|mp4|webm|html?)$/i;
const FIT_ICON_PATH = 'M2.5 6V2.5H6 M10 2.5h3.5V6 M13.5 10v3.5H10 M6 13.5H2.5V10';
const TOO_BIG_TO_UNDO_TEXT = 'Saved, but that change is too big to undo.';
interface ToolDetails {
  label: string;
  key: string;
  iconPath: string;
  hint: string | null;
}

const TOOL_DETAILS: Readonly<Record<BoardTool, ToolDetails>> = {
  select: { label: 'Select', key: 'V', iconPath: 'M4 2.5l8.5 5.8l-4 0.7l2.2 4.3l-1.5 0.8l-2.2-4.3L4 12.5z', hint: null },
  box: { label: 'Box', key: 'R', iconPath: 'M2.5 4h11v8h-11z', hint: 'Click the board to place a box. Esc to cancel.' },
  note: { label: 'Note', key: 'S', iconPath: 'M2.5 2.5h11v7l-4 4h-7z M9.5 13.5v-4h4', hint: 'Click the board to place a note. Esc to cancel.' },
  text: { label: 'Text', key: 'T', iconPath: 'M3 3.5h10 M8 3.5v9.5', hint: 'Click the board to place text. Esc to cancel.' },
  wire: { label: 'Wire', key: 'A', iconPath: 'M2.5 13.5L13 3 M8.5 3H13v4.5', hint: 'Drag from one box to another to connect them. Esc to cancel.' },
  pen: { label: 'Pen', key: 'B', iconPath: 'M2.5 13.5c2-1 3-4 5-4s2 3 4 3s2-3 2-5', hint: 'Drag on the board to draw. Esc to stop drawing.' },
  decision: { label: 'Decision', key: 'D', iconPath: 'M8 2l6 6l-6 6l-6-6z', hint: 'Click the board to place a decision. Esc to cancel.' },
  icon: { label: 'Icon', key: 'I', iconPath: 'M8 2.5l1.6 3.3l3.6 0.5l-2.6 2.5l0.6 3.6L8 10.7l-3.2 1.7l0.6-3.6L2.8 6.3l3.6-0.5z', hint: 'Click the board to place an icon. Esc to cancel.' },
  device: { label: 'Device', key: 'M', iconPath: 'M5 1.5h6v13h-6z M7 12.5h2', hint: 'Click the board to place a device mockup. Esc to cancel.' },
};
const TOOLBAR_TOOLS: readonly BoardTool[] = ['select', 'box', 'note', 'text', 'wire', 'pen'];

interface TextDialogOptions {
  title: string;
  label: string;
  placeholder: string;
  maxLength: number;
  confirmLabel: string;
  initialValue?: string;
  onSubmit: (value: string) => Promise<string | null>;
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
  buttons: Record<'fit' | 'undo' | 'redo', HTMLButtonElement>;
  toolButtons: ReadonlyMap<BoardTool, HTMLButtonElement>;
  toolHint: HTMLElement;
  emptyBoardHint: HTMLElement;
  mediaLayer: BoardMediaLayer;
}

let selectedBoardId: string | null = null;
interface ClickOpenedStack {
  boardId: string;
  boxIds: readonly string[];
  phase: 'opening' | 'left while opening' | 'open' | 'left while unseen';
}
const clickOpenedStacksByFrameId = new Map<string, ClickOpenedStack>();
let parts: BoardsViewParts | null = null;
let renderer: BoardRenderer | null = null;
let editor: BoardEditor | null = null;
let inspector: BoardInspector | null = null;
let shouldFitOnNextRender = true;
let pairedSessionId: string | null = null;
let shownReview: { boardId: string; review: BoardReview } | null = null;
let reviewRequestKey: string | null = null;
let openDocBox: { boardId: string; box: Extract<Element, { kind: 'box' }> } | null = null;
type RecordedSend = { ok: true; isUndoable: boolean } | { ok: false; error: string };

const status = createActionStatus('action-status wb-status');
const historyByBoardId = new Map<string, UndoHistory>();
let historyQueue: Promise<unknown> = Promise.resolve();

function openTextDialog(options: TextDialogOptions): void {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: options.title });
  const input = markAsNotCredential(el('input', 'dialog-input'));
  input.type = 'text';
  input.placeholder = options.placeholder;
  input.maxLength = options.maxLength;
  input.value = options.initialValue ?? '';
  input.setAttribute('aria-label', options.label);
  const errorEl = el('div', 'dialog-error');
  errorEl.setAttribute('role', 'alert');
  const btnConfirm = button({ variant: 'primary', label: options.confirmLabel, action: 'confirm-board-dialog' });
  actions.append(btnConfirm);
  dialog.append(el('label', 'dialog-label', options.label), input, errorEl, actions);

  async function submit(): Promise<void> {
    const value = input.value.trim();
    if (!value) {
      errorEl.textContent = `${options.label} is empty.`;
      return;
    }
    btnConfirm.disabled = true;
    const error = await options.onSubmit(value);
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

function heldBoardOf(boardId: string): Board | null {
  return tiledBoardOf(boardId)?.board ?? null;
}

function selectedBoard(): Board | null {
  return selectedBoardId ? heldBoardOf(selectedBoardId) : null;
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

function undoEntryOf(patch: WhiteboardPatch | null): Op[] | null {
  if (!patch) return [];
  const entry = undoOpsOf(patch.before, patch.diff);
  return fitsOnePut(entry) ? entry : null;
}

function recordPatch(boardId: string, patch: WhiteboardPatch | null): boolean {
  const entry = undoEntryOf(patch);
  if (!entry) {
    historyByBoardId.set(boardId, EMPTY_HISTORY);
    return false;
  }
  historyByBoardId.set(boardId, recordEdit(historyByBoardId.get(boardId) ?? EMPTY_HISTORY, entry));
  return true;
}

async function sendAndRecord(boardId: string, ops: Op[]): Promise<RecordedSend> {
  const outcome = await sendBoardOps(boardId, ops);
  if (!outcome.ok) return outcome;
  return { ok: true, isUndoable: recordPatch(boardId, outcome.patch) };
}

function stepHistory(direction: UndoDirection): Promise<void> {
  return inHistoryOrder(() => runHistoryStep(direction));
}

async function runHistoryStep(direction: UndoDirection): Promise<void> {
  const boardId = selectedBoardId;
  if (!boardId) return;
  const step = takeStep(historyByBoardId.get(boardId) ?? EMPTY_HISTORY, direction);
  if (!step) return;
  historyByBoardId.set(boardId, step.history);
  const outcome = await sendBoardOps(boardId, step.entry);
  if (!outcome.ok) {
    status.show('error', `could not ${direction} that change, so it was dropped: ${outcome.error}`);
    return;
  }
  const entry = undoEntryOf(outcome.patch);
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
    .flatMap((elementId) => board?.elements.get(elementId) ?? [])
    .filter((element): element is Extract<Element, { kind: Kind }> => element.kind === kind);
}

function paintToolbar(): void {
  if (!parts) return;
  const board = selectedBoard();
  for (const button of parts.toolButtons.values()) button.disabled = !board;
  for (const button of [parts.buttons.fit, parts.buttons.undo, parts.buttons.redo]) button.disabled = !board;
  inspector?.paint(editor?.selectedIds() ?? new Set());
}

function paintList(): void {
  if (!parts) return;
  const summaries = boardSummariesOf();
  if (selectedBoardId && !summaries.some((summary) => summary.id === selectedBoardId)) selectedBoardId = null;
  const fallbackBoard = summaries.find((summary) => pairedSessionId !== null && summary.connectedSessionIds.includes(pairedSessionId)) ?? summaries.find((summary) => !summary.isArchived) ?? summaries[0];
  if (!selectedBoardId && fallbackBoard) selectBoard(fallbackBoard.id);
  paintHead();
}

function isRenamingTitle(): boolean {
  return Boolean(parts?.boardIsland.querySelector(`.${TITLE_RENAME_CLASS}`));
}

function startTitleRename(): void {
  const summary = selectedSummary();
  if (!parts || !summary || isRenamingTitle()) return;
  const { boardTitle } = parts;
  const input = markAsNotCredential(el('input', TITLE_RENAME_CLASS));
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
  const trigger = menuButton({ label: 'Board actions', action: 'open-board-menu', onClick: () => setOpen(!isOpen()) });
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const actionItem = (label: string, onChoose: () => void, extraClass = '') => {
    const item = buildMenuItem(label, `visible ${extraClass}`.trim());
    item.addEventListener('click', onChoose);
    return item;
  };
  const boardSettingsItem = actionItem('Board settings', onBoardSettings);
  const actionItems = [
    actionItem('Rename board', startTitleRename),
    actionItem('New board', newBoardFromDialog),
    boardSettingsItem,
    actionItem('Export SVG', () => void exportBoardPicture('svg')),
    actionItem('Export PNG', () => void exportBoardPicture('png')),
    actionItem('Delete board', confirmDeleteBoard, 'wb-board-menu-danger'),
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
  menu.append(...actionItems);
  return { menuRoot, trigger };
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
  parts.boardMeta.dataset.boardVersion = String(summary.version);
  paintBoardEditedAge();
  paintToolbar();
  paintPairedSession();
}

const EDITED_JUST_NOW_BELOW_SECONDS = 60;

function paintBoardEditedAge(): void {
  if (!parts) return;
  const summary = selectedSummary();
  if (!summary) return;
  const editedText = `edited ${elapsedText(clock.nowMs() - summary.updatedAt, { ...COMPACT_FLOORED_AGO, justNowBelowSeconds: EDITED_JUST_NOW_BELOW_SECONDS })}`;
  if (parts.boardMeta.textContent !== editedText) parts.boardMeta.textContent = editedText;
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

function shownReviewOf(board: Board | null): BoardReview | null {
  return board && shownReview?.boardId === board.id ? shownReview.review : null;
}

function linkStateOf(boardId: string, boxId: string): LinkStateOfBox | null {
  if (shownReview?.boardId !== boardId) return null;
  return shownReview.review.linkStates.find((linkState) => linkState.boxId === boxId) ?? null;
}

function worthALookReasonOf(ref: string): string | null {
  const refPath = refPathOf(ref);
  return shownReviewOf(selectedBoard())?.worthALook.find((worth) => worth.path === refPath)?.reason ?? null;
}

function worthALookIdsOf(board: Board, worthALook: readonly WorthALookPath[]): Set<string> {
  const worthALookPaths = new Set(worthALook.map((worth) => worth.path));
  return new Set([...board.elements.values()]
    .filter((element) => refsOfElement(element).some((ref) => worthALookPaths.has(refPathOf(ref) ?? '')))
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
  const review = shownReviewOf(board);
  renderer.setReviewMarks({
    worthALookIds: board && review ? worthALookIdsOf(board, review.worthALook) : new Set(),
    flaggedStepIds: new Set(review?.flaggedStepIds ?? []),
  });
  parts.mediaLayer.setLinkStates(review?.linkStates ?? []);
}

function refreshReviewOf(board: Board): void {
  reviewRequestKey = null;
  requestReviewOf(board);
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
    inspector?.paint(editor?.selectedIds() ?? new Set());
  });
}

function paintBoard(): void {
  if (!renderer) return;
  const tiled = selectedBoardId ? tiledBoardOf(selectedBoardId) : null;
  if (!tiled) {
    if (parts) parts.emptyBoardHint.hidden = true;
    return;
  }
  renderer.renderLayout(tiled.layout, tiled.blocks);
  editor?.repaintPreview();
  const { board } = tiled;
  requestReviewOf(board);
  editor?.pruneSelection(board);
  if (parts) parts.emptyBoardHint.hidden = tiled.elementCount > 0;
  paintReview();
  editor?.afterBoardPaint();
  if (shouldFitOnNextRender) {
    editor?.fit();
    shouldFitOnNextRender = false;
  }
  paintToolbar();
}

const boardPickListeners: ((boardId: string) => void)[] = [];

export function onBoardPicked(listener: (boardId: string) => void): void {
  boardPickListeners.push(listener);
}

function pickBoard(boardId: string): void {
  selectBoard(boardId);
  for (const listener of boardPickListeners) listener(boardId);
}

function selectBoard(boardId: string): void {
  if (selectedBoardId === boardId) return;
  gatherClickOpenedStacksOfSelectedBoard();
  selectedBoardId = boardId;
  shouldFitOnNextRender = true;
  editor?.clearSelection();
  editor?.closeInlineEditor();
  inspector?.closeBoardSettings();
  renderer?.clear();
  status.clear();
  paintList();
  paintBoard();
}


function livePageBoxIdOf(selectedIds: ReadonlySet<string>): string | null {
  if (selectedIds.size !== 1) return null;
  const [selectedId] = selectedIds;
  const selected = selectedId === undefined ? undefined : selectedBoard()?.elements.get(selectedId);
  if (selected?.kind !== 'box' || selected.media?.kind !== 'page') return null;
  return selected.id;
}

function pressedDialValuesOf({ boxId }: PressedImage): Record<string, DialValue> {
  const pressedBox = boxId ? selectedBoard()?.elements.get(boxId) : undefined;
  return pressedBox?.kind === 'box' ? dialValuesOfBox(pressedBox) : {};
}

function pressedMediaOf({ boxId }: PressedImage): BoxMedia | null {
  const pressedBox = boxId ? selectedBoard()?.elements.get(boxId) : undefined;
  return pressedBox?.kind === 'box' ? pressedBox.media : null;
}

function enlargedMediaOf(pressedImage: PressedImage, media: BoxMedia | null): HTMLElement {
  const originalHref = media ? `${WHITEBOARD_ASSET_ROUTE}/${boardMediaOriginalFilename(media)}` : pressedImage.href;
  if (media?.kind === 'page') {
    const pageFrame = createSandboxedFrame({ source: { kind: 'url', url: `${boardPagePath(media)}?${BOARD_PAGE_TUNED_QUERY}` }, className: 'wb-image-viewer-page', title: pressedImage.alt || 'page', allowsScripts: true });
    tunePageOnLoad(pageFrame, document.body, () => pressedDialValuesOf(pressedImage));
    return pageFrame;
  }
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
  picture.draggable = false;
  return picture;
}

function postZoomedState(pageFrame: HTMLIFrameElement, isZoomed: boolean): void {
  pageFrame.contentWindow?.postMessage({ type: BOARD_PAGE_ZOOMED_MESSAGE, isZoomed }, '*');
}

function sheetGestureOf(gesture: BoardPageGesture, pageScale: number): BoardPageGesture {
  if (gesture.gesture === 'pan') return gesture;
  return { ...gesture, centerX: gesture.centerX * pageScale, centerY: gesture.centerY * pageScale };
}

function listenToViewerPage(pageFrame: HTMLIFrameElement, overlay: HTMLElement, close: () => void, zoomControl: MediaZoomControl, viewerSizing: ViewerSizing): void {
  const listening = new AbortController();
  window.addEventListener('message', (event) => {
    if (event.source !== pageFrame.contentWindow) return;
    if (event.data === BOARD_PAGE_ESCAPE_MESSAGE) {
      close();
      return;
    }
    const pageWidths = BoardPageContentWidth.safeParse(event.data);
    if (pageWidths.success) {
      viewerSizing.takePageWidths(pageWidths.data);
      return;
    }
    const gesture = BoardPageGesture.safeParse(event.data);
    if (gesture.success) applyPageGesture(zoomControl, sheetGestureOf(gesture.data, viewerSizing.pageScale()));
  }, { signal: listening.signal });
  pageFrame.addEventListener('load', () => {
    viewerSizing.takeNewPage();
    postZoomedState(pageFrame, zoomControl.isZoomed());
  }, { signal: listening.signal });
  const overlayWatcher = new MutationObserver(() => {
    if (overlay.isConnected) return;
    listening.abort();
    overlayWatcher.disconnect();
  });
  overlayWatcher.observe(document.body, { childList: true });
}

function docBoxOf(boardId: string, boxId: string): Extract<Element, { kind: 'box' }> | null {
  const isOpenDoc = openDocBox?.boardId === boardId && openDocBox.box.id === boxId;
  const held = heldBoardOf(boardId)?.elements.get(boxId);
  if (held?.kind !== 'box') return isOpenDoc ? (openDocBox?.box ?? null) : null;
  if (isOpenDoc) openDocBox = { boardId, box: held };
  return held;
}

function docMediaOf(boardId: string, boxId: string): BoxMedia | null {
  const box = docBoxOf(boardId, boxId);
  const media = box?.media ?? null;
  return media?.kind === 'doc' ? media : null;
}

function boardDocKey(boardId: string): string {
  return `whiteboard:${boardId}`;
}

function keepOpenDocMedia(boardId: string, boxId: string, savedMedia: BoxMedia): void {
  const savedBox = docBoxOf(boardId, boxId);
  if (savedBox && SHAPE_TRAITS[savedBox.shape].holdsMedia && openDocBox?.box.id === boxId) openDocBox = { boardId, box: { ...savedBox, media: savedMedia } };
}

async function saveLinkedDocText(boardId: string, boxId: string, docText: string, loadedAsset: string): ReturnType<DocSource['save']> {
  const saved = await inHistoryOrder(async () => {
    const outcome = await saveLinkedBoardDoc(boardId, boxId, docText, loadedAsset);
    if (outcome.ok) recordPatch(boardId, outcome.patch);
    return outcome;
  });
  if (!saved.ok) return { ok: false, isConflict: saved.isConflict, error: saved.isConflict ? null : saved.error };
  keepOpenDocMedia(boardId, boxId, saved.savedMedia);
  return { ok: true, hash: saved.savedMedia.asset };
}

async function saveBoardDoc(boardId: string, boxId: string, docText: string, loadedAsset: string): ReturnType<DocSource['save']> {
  const media = docMediaOf(boardId, boxId);
  if (!media || media.asset !== loadedAsset) return { ok: false, isConflict: true, error: null };
  if (media.link) return saveLinkedDocText(boardId, boxId, docText, loadedAsset);
  const stored = await uploadBoardMedia(new File([docText], `${boxId}.md`, { type: 'text/markdown' }));
  if (!stored.ok) return { ok: false, isConflict: false, error: stored.error };
  if (stored.media.kind !== 'doc') return { ok: false, isConflict: false, error: BOARD_DOC_NOT_MARKDOWN_TEXT };
  if (docMediaOf(boardId, boxId)?.asset !== loadedAsset) return { ok: false, isConflict: true, error: null };
  const savedMedia = { ...stored.media, alt: media.alt };
  const sent = await sendRecordedOps(boardId, [{ op: 'set', id: boxId, fields: { media: savedMedia } }]);
  if (!sent.ok) return { ok: false, isConflict: false, error: sent.error };
  keepOpenDocMedia(boardId, boxId, savedMedia);
  return { ok: true, hash: stored.media.asset };
}

function boardDocSource(boardId: string, boxId: string, title: string): DocSource {
  return {
    key: boardDocKey(boardId),
    docs: () => [{ path: boxId, name: title }],
    isSaveable: () => docMediaOf(boardId, boxId) !== null && linkStateOf(boardId, boxId)?.state !== 'broken',
    conflictText: BOARD_DOC_CONFLICT_TEXT,
    get unsaveableText() {
      const linkState = linkStateOf(boardId, boxId);
      return linkState?.state === 'broken' ? `${linkState.text}, so this card is read-only until it is linked again or unlinked.` : BOARD_DOC_GONE_TEXT;
    },
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
  const box = heldBoardOf(boardId)?.elements.get(boxId);
  if (box?.kind !== 'box') return;
  openDocBox = { boardId, box };
  const board = heldBoardOf(boardId);
  if (board && box.media?.link) refreshReviewOf(board);
  openDocEditorOn(boardDocSource(boardId, boxId, box.title));
}

const VIEWER_WIDTH_BOUNDS = { minPx: 240, maxPx: BOARD_MEDIA_MAX_EDGE_PX };
const VIEWER_WIDTH_KEY_STEP_PX = 40;
const VIEWER_HANDLE_WIDTH_PX = 8;
const MIN_PAGE_SCALE = 1 / MAX_MEDIA_SCALE;

type PageWidths = { contentWidth: number; layoutWidth: number };
type ViewerSizing = { pageScale: () => number; operatorWidth: () => number | null; takePageWidths: (pageWidths: PageWidths) => void; takeNewPage: () => void; takeOperatorWidth: (widthPx: number | null) => void };

function createViewerSizing(zoomStage: HTMLElement, mediaSheet: HTMLElement): ViewerSizing {
  let contentWidthPx: number | null = null;
  let operatorWidthPx: number | null = null;
  let pageScale = 1;
  const showAtScale = (nextPageScale: number) => {
    pageScale = nextPageScale;
    mediaSheet.style.setProperty('--wb-page-scale', String(pageScale));
  };
  const refit = () => {
    const visibleWidthPx = mediaSheet.clientWidth - VIEWER_HANDLE_WIDTH_PX;
    if (operatorWidthPx !== null || visibleWidthPx <= 0) return;
    if (contentWidthPx === null) {
      showAtScale(1);
      return;
    }
    showAtScale(Math.max(MIN_PAGE_SCALE, Math.min(1, visibleWidthPx / contentWidthPx)));
  };
  new ResizeObserver(refit).observe(zoomStage);
  return {
    pageScale: () => pageScale,
    operatorWidth: () => operatorWidthPx,
    takePageWidths: ({ contentWidth, layoutWidth }) => {
      if (contentWidth <= layoutWidth) return;
      contentWidthPx = contentWidth;
      refit();
    },
    takeNewPage: () => {
      contentWidthPx = null;
      refit();
    },
    takeOperatorWidth: (widthPx) => {
      operatorWidthPx = widthPx;
      refit();
    },
  };
}

function viewerWidthHandle(): HTMLElement {
  const widthHandle = el('div', 'wb-image-viewer-resizer');
  widthHandle.setAttribute('role', 'separator');
  widthHandle.setAttribute('aria-orientation', 'vertical');
  widthHandle.setAttribute('aria-label', 'Media width');
  widthHandle.tabIndex = 0;
  widthHandle.addEventListener('pointerdown', (event) => event.stopPropagation());
  widthHandle.addEventListener('dblclick', (event) => event.stopPropagation());
  return widthHandle;
}

function wireViewerWidth(zoomStage: HTMLElement, mediaSheet: HTMLElement, widthHandle: HTMLElement, viewerSizing: ViewerSizing): void {
  mediaSheet.style.setProperty('--wb-viewer-handle', `${VIEWER_HANDLE_WIDTH_PX}px`);
  wireColumnResizer({
    resizer: widthHandle,
    column: mediaSheet,
    widthHost: zoomStage,
    widthProperty: '--wb-viewer-width',
    bounds: VIEWER_WIDTH_BOUNDS,
    keyStepPx: VIEWER_WIDTH_KEY_STEP_PX,
    reservePx: 0,
    getStoredWidth: viewerSizing.operatorWidth,
    setStoredWidth: viewerSizing.takeOperatorWidth,
  });
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
  overlay.classList.add('wb-image-viewer-overlay');
  overlay.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  }, { passive: false });
  const enlargedMedia = enlargedMediaOf(pressedImage, media);
  enlargedMedia.classList.add('wb-image-viewer-media');
  const zoomStage = el('div', 'wb-image-viewer-stage');
  const mediaSheet = el('div', 'wb-image-viewer-sheet');
  const widthHandle = viewerWidthHandle();
  mediaSheet.append(enlargedMedia, widthHandle);
  zoomStage.append(mediaSheet);
  dialog.append(zoomStage);
  const viewerSizing = createViewerSizing(zoomStage, mediaSheet);
  wireViewerWidth(zoomStage, mediaSheet, widthHandle, viewerSizing);
  const zoomControl = attachMediaZoom(zoomStage, mediaSheet, (isZoomed) => {
    zoomStage.classList.toggle('is-zoomed', isZoomed);
    if (enlargedMedia instanceof HTMLIFrameElement) postZoomedState(enlargedMedia, isZoomed);
  });
  if (enlargedMedia instanceof HTMLIFrameElement) listenToViewerPage(enlargedMedia, overlay, close, zoomControl, viewerSizing);
  btnCancel.addEventListener('click', close);
  requestAnimationFrame(() => btnCancel.focus());
}

const NOTE_GAP_BESIDE_BOX = 24;

function addNoteOn(boxId: string): void {
  openTextDialog({
    title: 'Pin a note',
    label: 'Note',
    placeholder: 'what about retries?',
    maxLength: WHITEBOARD_LIMITS.noteText,
    confirmLabel: 'Pin note',
    onSubmit: (text) => {
      const targetRect = renderer?.boundsOf(boxId);
      if (!targetRect) return Promise.resolve('That box is not on the board any more.');
      const pinnedOffsetY = renderer?.layout()?.pinnedOffsetY ?? 0;
      const noteAt = { x: Math.round(targetRect.x + targetRect.width + NOTE_GAP_BESIDE_BOX), y: Math.round(targetRect.y - pinnedOffsetY) };
      const noteBoxId = newElementId('box');
      const { title, lines } = noteBoxTextOf(text);
      return sendOpsFromDialog([
        { op: 'add', element: ElementInput.parse({ kind: 'box', id: noteBoxId, shape: 'note', title, lines: lines.map((line) => ({ text: line })), place: { at: noteAt } }) },
        { op: 'add', element: ElementInput.parse({ kind: 'wire', id: newElementId('wire'), from: noteBoxId, to: boxId, dashed: true }) },
      ]);
    },
  });
}

function connectBoxes(fromBoxId: string, toBoxId: string): void {
  const board = selectedBoard();
  if (!board || fromBoxId === toBoxId) return;
  const isAlreadyWired = [...board.elements.values()].some((element) => element.kind === 'wire' && element.from === fromBoxId && element.to === toBoxId);
  if (isAlreadyWired) return;
  void sendOps([{ op: 'add', element: { kind: 'wire', id: newElementId('wire'), from: fromBoxId, to: toBoxId, dashed: false, tone: 'plain', label: null, fromSide: null, toSide: null } }]);
}

function stackTitleOf(board: Board, boxIds: readonly string[]): string {
  const titles = boxIds.flatMap((boxId) => {
    const box = board.elements.get(boxId);
    return box?.kind === 'box' ? [box.title] : [];
  });
  return titles.join(', ').slice(0, WHITEBOARD_LIMITS.title);
}

function addStack(board: Board, contains: string[]): Promise<boolean> {
  return sendOps([{ op: 'add', element: { kind: 'frame', id: newElementId('frame'), title: stackTitleOf(board, contains), contains, collapsed: true } }]);
}

function stackBoxes(targetBoxId: string, droppedBoxId: string, targetStack: Frame | null): void {
  const board = selectedBoard();
  if (!board) return;
  if (targetStack) {
    void sendOps([{ op: 'set', id: targetStack.id, fields: { contains: [...targetStack.contains, droppedBoxId] } }]);
    return;
  }
  void addStack(board, [targetBoxId, droppedBoxId]);
}

function stackSelectedBoxes(): void {
  const board = selectedBoard();
  const selectedBoxIds = selectedElementsOfKind('box').map((box) => box.id);
  if (!board || selectedBoxIds.length < 2) return;
  const stacksByTopBoxId = stacksByTopBoxIdOf(board);
  const selectedStack = selectedBoxIds.flatMap((boxId) => stacksByTopBoxId.get(boxId) ?? [])[0];
  const joinedBoxIds = selectedBoxIds.filter((boxId) => !selectedStack?.contains.includes(boxId));
  const sent = selectedStack ? sendOps([{ op: 'set', id: selectedStack.id, fields: { contains: [...selectedStack.contains, ...joinedBoxIds] } }]) : addStack(board, selectedBoxIds);
  void sent.then((isSent) => {
    if (isSent) editor?.clearSelection();
  });
}

function openStack(frameId: string): void {
  const frame = selectedBoard()?.elements.get(frameId);
  if (!selectedBoardId || frame?.kind !== 'frame') return;
  clickOpenedStacksByFrameId.set(frameId, { boardId: selectedBoardId, boxIds: frame.contains, phase: 'opening' });
  void sendOps([{ op: 'set', id: frameId, fields: { collapsed: false } }]).then((isSent) => {
    if (!isSent) clickOpenedStacksByFrameId.delete(frameId);
  });
}

function gatherClickOpenedStacksOfSelectedBoard(): void {
  for (const [frameId, clickOpenedStack] of clickOpenedStacksByFrameId) {
    if (clickOpenedStack.boardId !== selectedBoardId) continue;
    clickOpenedStacksByFrameId.delete(frameId);
    void sendRecordedOps(clickOpenedStack.boardId, [{ op: 'set', id: frameId, fields: { collapsed: true } }]);
  }
}

function settledClickOpenedStack(frameId: string, clickOpenedStack: ClickOpenedStack, held: Element | undefined, hasSelectionLeft: boolean): ClickOpenedStack | 'forget' | 'gather' {
  const hasShownOpen = clickOpenedStack.phase === 'open' || clickOpenedStack.phase === 'left while unseen';
  if (!held && !hasSelectionLeft) return clickOpenedStack;
  if (!held) return { ...clickOpenedStack, phase: hasShownOpen ? 'left while unseen' : 'left while opening' };
  if (held.kind !== 'frame' || held.id !== frameId) return 'forget';
  if (held.collapsed && hasShownOpen) return 'forget';
  if (held.collapsed) return { ...clickOpenedStack, boxIds: held.contains, phase: hasSelectionLeft ? 'left while opening' : 'opening' };
  if (hasSelectionLeft) return 'gather';
  return { ...clickOpenedStack, boxIds: held.contains, phase: 'open' };
}

function settleClickOpenedStacks(hasSelectionChanged: boolean): void {
  const board = selectedBoard();
  const selectedIds = editor?.selectedIds() ?? new Set<string>();
  const gatherOps: Op[] = [];
  for (const [frameId, clickOpenedStack] of clickOpenedStacksByFrameId) {
    const held = board?.elements.get(frameId);
    const boxIds = held?.kind === 'frame' ? held.contains : clickOpenedStack.boxIds;
    const isSelectionOutside = !selectedIds.has(frameId) && !boxIds.some((boxId) => selectedIds.has(boxId));
    const hasSelectionLeft = clickOpenedStack.phase.startsWith('left') || (hasSelectionChanged && isSelectionOutside);
    const settled = clickOpenedStack.boardId === selectedBoardId ? settledClickOpenedStack(frameId, clickOpenedStack, held, hasSelectionLeft) : 'forget';
    if (settled === 'gather') gatherOps.push({ op: 'set', id: frameId, fields: { collapsed: true } });
    if (settled === 'gather' || settled === 'forget') {
      clickOpenedStacksByFrameId.delete(frameId);
      continue;
    }
    clickOpenedStacksByFrameId.set(frameId, settled);
  }
  void sendOps(gatherOps);
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
      const error = await sendOpsFromDialog([{ op: 'add', element: { kind: 'frame', id: newElementId('frame'), title, contains, collapsed: false } }]);
      if (!error) editor?.clearSelection();
      return error;
    },
  });
}

async function exportBoardPicture(format: 'svg' | 'png'): Promise<void> {
  const summary = selectedSummary();
  if (!summary) return;
  const response = await fetch(`${WHITEBOARD_PICTURE_ROUTE}/${encodeURIComponent(summary.id)}/picture.${format}`).catch(() => null);
  if (!response?.ok) {
    const refusal: unknown = await response?.json().catch(() => null);
    const reason = typeof refusal === 'object' && refusal !== null && 'error' in refusal && typeof refusal.error === 'string' ? refusal.error : 'the board could not be exported';
    status.show('error', reason);
    return;
  }
  const pictureUrl = URL.createObjectURL(await response.blob());
  const download = el('a');
  download.href = pictureUrl;
  download.download = `${summary.title}.${format}`;
  download.click();
  URL.revokeObjectURL(pictureUrl);
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
  createBoardFromDialog(pickBoard);
}

function createBoardFromDialog(onCreated: (boardId: string) => void): void {
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

function toolButton(tool: BoardTool): HTMLButtonElement {
  const { label, key, iconPath } = TOOL_DETAILS[tool];
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
  const { hint } = TOOL_DETAILS[activeTool];
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

  const toolButtons = new Map(TOOLBAR_TOOLS.map((tool) => [tool, toolButton(tool)]));
  const toolGroup = el('div', 'wb-tools');
  toolGroup.setAttribute('role', 'group');
  toolGroup.setAttribute('aria-label', 'Drawing tools');
  toolGroup.append(...toolButtons.values());
  const buttons = {
    fit: iconButton('Fit', FIT_ICON_PATH, 'fit-board', () => editor?.fit()),
    undo: iconButton('Undo', UNDO_ICON_PATH, 'undo-board-edit', () => void stepHistory('undo')),
    redo: iconButton('Redo', REDO_ICON_PATH, 'redo-board-edit', () => void stepHistory('redo')),
  };
  buttons.fit.dataset.phoneVisible = '';
  const toolsIsland = island('wb-island-tools', 'Board tools', toolGroup);
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
  const mediaLayer = createBoardMediaLayer({
    onEscapeFromPage: () => {
      editor?.clearSelection();
      editor?.focusCanvas();
    },
    onZoomFromPage: (clientX, clientY, viewWidthFactor) => editor?.zoomAroundClientPoint(clientX, clientY, viewWidthFactor),
    onPanFromPage: (deltaX, deltaY) => editor?.panByPixels(deltaX, deltaY),
  });
  world.append(svg, mediaLayer.element);
  const glCanvas = el('canvas', 'wb-gl');
  glCanvas.setAttribute('aria-hidden', 'true');
  const glNotice = el('p', 'wb-gl-notice');
  glNotice.setAttribute('role', 'status');
  glNotice.hidden = true;
  viewport.append(glCanvas, world);
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
  canvas.append(viewport, emptyBoardHint, topRightStack, chrome, bottomLeftStack, glNotice);
  const emptyText = el('p', 'wb-empty-text', EMPTY_TEXT);
  const empty = el('div', 'wb-empty');
  empty.append(emptyText, button({ variant: 'secondary', label: 'new board', action: 'new-board', onClick: newBoardFromDialog }));

  host.replaceChildren(canvas, empty);
  parts = { boardIsland, boardMenu, boardTitle, boardMeta, presence, host, chrome, canvas, empty, emptyText, agentIsland, queuedForSession, buttons, toolButtons, toolHint, emptyBoardHint, mediaLayer };
  onSessionTick(paintBoardEditedAge);
  const boardRenderer = createBoardRenderer({
    canvas: glCanvas,
    viewport,
    fontSource: svg,
    mediaLayer,
    notice: glNotice,
    onViewChange: (view, scale) => {
      if (selectedBoardId) showTilesFor(selectedBoardId, view, scale);
    },
    onGraphicsEvent: (event) => { void reportBoardGraphics(event); },
  });
  renderer = boardRenderer;
  inspector = createBoardInspector({ container: inspectPanel, currentBoard: selectedBoard, layout: () => boardRenderer.layout(), sendOps, codeSessionChoices, openRef: openRefInReview, worthALookReasonOf, linkStateOf: (boxId) => (selectedBoardId ? linkStateOf(selectedBoardId, boxId) : null), addNoteOn, frameSelectedBoxes: addFrame, stackSelectedBoxes, removeSelected: () => editor?.removeSelected() });
  editor = createBoardEditor({
    viewport,
    world,
    svg,
    canvas,
    renderer: boardRenderer,
    currentBoard: selectedBoard,
    repaint: paintBoard,
    sendOps,
    onSelectionChange: (selectedIds) => {
      paintToolbar();
      mediaLayer.setInteractiveBox(livePageBoxIdOf(selectedIds));
      settleClickOpenedStacks(true);
    },
    onPhoneTapBox: addNoteOn,
    onOpenImage: (pressedImage) => {
      editor?.clearSelection();
      openImageViewer(pressedImage);
    },
    onConnectBoxes: connectBoxes,
    onStackBoxes: stackBoxes,
    onOpenStack: openStack,
    isOpenedStack: (frameId) => clickOpenedStacksByFrameId.has(frameId),
    onToolChange: paintActiveTool,
  });

  document.addEventListener('keydown', (event) => onHistoryKey(host, event));
  wireMediaDrops(host, canvas);
  onBoardListChanged(paintList);
  onBoardChanged((boardId) => {
    applyDocsToOpenEditor(boardDocKey(boardId));
    if (boardId !== selectedBoardId) return;
    paintBoard();
    settleClickOpenedStacks(false);
  });
  onTilesChanged(() => {
    if (selectedBoardId) applyDocsToOpenEditor(boardDocKey(selectedBoardId));
    paintBoard();
    settleClickOpenedStacks(false);
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
  pairedSessionId = sessionId;
  if (boardId) selectBoard(boardId);
  paintPairedSession();
}

export function reopenSelectedBoard(): void {
  paintList();
  reviewRequestKey = null;
  resendTilesView();
  paintBoard();
}

let boardsScreen: HTMLElement | null = null;

const MAX_BOARD_GRAPHICS_LOG_LINES_PER_PAGE = 200;
let boardGraphicsLogLinesSent = 0;

function logBoardGraphicsToServer(text: string): void {
  console.warn(`[board-graphics] ${text}`);
  if (boardGraphicsLogLinesSent >= MAX_BOARD_GRAPHICS_LOG_LINES_PER_PAGE) return;
  if (sendControlMsg({ type: 'client-log', scope: 'board-graphics', text: text.slice(0, CLIENT_LOG_TEXT_MAX_CHARS) })) boardGraphicsLogLinesSent += 1;
}

async function reportBoardGraphics(event: BoardGraphicsEvent): Promise<void> {
  const page = { boardId: selectedBoardId, terminalWebglContexts: liveTerminalWebglContextCount(), sameOriginDashboardTabs: await countDashboardTabs() };
  logBoardGraphicsToServer(boardGraphicsLogText(event, page));
  sendControlMsg({ type: 'dashboard-telemetry', event: 'board_graphics_reset', properties: boardGraphicsTelemetryProperties(event, page) });
}

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
