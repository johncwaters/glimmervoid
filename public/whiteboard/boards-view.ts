import './whiteboard.css';
import type { Board, BoardReview, BoardSummary, BoxMedia, DialValue, Element, Frame, LinkStateOfBox, Op, WorthALookPath } from '#shared/contracts/whiteboard.ts';
import { refPathOf, refsOfElement } from '#shared/whiteboard-anchor-core.ts';
import { ElementInput } from '#shared/contracts/whiteboard.ts';
import { noteBoxTextOf } from '#shared/contracts/whiteboard-ops-core.ts';
import { SHAPE_TRAITS } from '#shared/whiteboard-shapes.ts';
import { BoardPageArrow, BOARD_PAGE_ESCAPE_MESSAGE, BOARD_PAGE_TUNED_QUERY, BoardPageContentWidth, BOARD_PAGE_ZOOMED_MESSAGE, BoardPageGesture, BOARD_MEDIA_EXTENSION_BY_MIME, BOARD_MEDIA_MAX_EDGE_PX, boardMediaNamedPath, boardMediaSavedName, BOARD_PAGE_SAVED_NAME_QUERY, boardPagePath, dialValuesOfBox, BOARD_FILE_DOWNLOAD_NAME, BOARD_FILE_EXTENSION, BOARD_LINK_PATH_MAX_LENGTH, WHITEBOARD_FILE_ROUTE, WHITEBOARD_LIMITS, WHITEBOARD_PICTURE_ROUTE } from '#shared/contracts/whiteboard.ts';
import { COMPACT_FLOORED_AGO, elapsedText } from '#shared/display-text.ts';
import { createActionStatus } from '../action-status.ts';
import { el, isRealInputOwningKey, markAsNotCredential } from '../dom-helpers.ts';
import { textInput } from '../ui/text-input.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';
import { SHEET_WIDTH_HANDLE_PX, sheetWidthHandle, wireSheetWidth } from '../sheet-width.ts';
import { button, menuButton } from '../ui/button.ts';
import { createDeckFrame, forwardDeckKey } from './deck-frame.ts';
import { emptyState } from '../ui/empty-state.ts';
import { radio } from '../ui/checkbox.ts';
import { field } from '../ui/field.ts';
import { createPressable, labelIconPressable } from '../ui/pressable.ts';
import { buildMenuItem, popupMenu } from '../ui/popup-menu.ts';
import { findSessionUi, sessionName } from '../session-card/card-registry.ts';
import { buildDialogShell, isModalOpen, openConfirmDialog } from '../session-card/modal.ts';
import { onSessionTick } from '../session-card/session-tick.ts';
import { CLOSE_ICON_PATH, createLineIcon, MORE_ICON_PATH, REDO_ICON_PATH, UNDO_ICON_PATH } from '../svg-dom.ts';
import type { ViewModule, ViewRefreshReason } from '../view-registry-core.ts';
import { createBoardEditor, newElementId, NUDGE_DIRECTION_BY_KEY, stacksByTopBoxIdOf } from './board-edit.ts';
import { nextWiredBoxId } from './media-walk-core.ts';
import type { BoardEditor, BoardTool, PressedImage } from './board-edit.ts';
import { EMPTY_HISTORY, recordEdit, recordStep, takeStep, undoStepOf } from '#shared/contracts/whiteboard-undo-core.ts';
import type { DiffBefore, WhiteboardPatch } from '#shared/contracts/control/whiteboard-messages.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import { rectAround } from './board-snap-core.ts';
import type { UndoDirection, UndoHistory } from '#shared/contracts/whiteboard-undo-core.ts';
import { createBoardInspector } from './board-inspect.ts';
import { createBoardStyleRows } from './board-style-rows.ts';
import { createBoardContextMenu } from './board-context-menu.ts';
import { isArrayIndexKey } from '#shared/contracts/whiteboard-element-table.ts';
import type { BoardContextMenu, ContextMenuGroup } from './board-context-menu.ts';
import { SHORTCUT_PLATFORM } from '../shortcuts.ts';
import type { BoardInspector } from './board-inspect.ts';
import { createBoardRenderer } from './board-gl-renderer.ts';
import type { BoardRenderer, Camera } from './board-gl-renderer.ts';
import { agentChangeSentence, dismissAgentChange, offViewAgentChangeOf, onTilesChanged, resendTilesView, ringAgentChange, ringedAgentBoxIdsOf, showTilesFor, tiledBoardOf } from './board-tile-store.ts';
import { followBoardSessionFeed } from './board-session-feed.ts';
import { createBoardMediaLayer, fetchBoardDocText, fetchBoardSheetText, tunePageOnLoad } from './board-media-layer.ts';
import type { BoardMediaLayer } from './board-media-layer.ts';
import { applyPageGesture, attachMediaZoom } from './media-zoom.ts';
import type { MediaZoomControl } from './media-zoom.ts';
import { MAX_MEDIA_SCALE } from './media-zoom-core.ts';
import { applyDocsToOpenEditor, openDocEditorOn } from '../doc-editor/doc-editor.ts';
import { openSheetEditor } from './sheet-editor.ts';
import type { SheetSaveOutcome } from './sheet-editor.ts';
import type { DocSource } from '../doc-editor/doc-editor.ts';
import {
  boardSummariesOf, boardsConnectedTo, createBoard, deleteBoard, disconnectSessionFromBoard, importBoardFile, onBoardChanged, onBoardListChanged, openFileInReview, requestBoardReview, requestBoardSlides, saveLinkedBoardDoc, onBoardFocusRequested, sendBoardOps, takeBoardFocusFor, takeOpenBoardRequest, uploadBoardMedia,
} from './board-store.ts';
import { clock } from '#shared/clock.ts';
import { getPhoneSessionId } from '../phone/phone-shell-gate.ts';
import { openExternalUrl } from '../external-link.ts';

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
const PRESENT_ICON_PATH = 'M2 3h12v8H2z M8 11v2.5 M5.5 13.5h5 M6.5 5.5v3l2.5-1.5z';
const FIT_ICON_PATH = 'M2.5 6V2.5H6 M10 2.5h3.5V6 M13.5 10v3.5H10 M6 13.5H2.5V10';
const TOO_BIG_TO_UNDO_TEXT = 'Saved, but that change is too big to undo.';
const CLIPBOARD_NOTICE_TEXT = {
  cut: 'Pasted, but the text ran past what a box holds, so the rest was left out.',
  unreadable: 'Could not paste: those board elements are in a form this Glimmervoid cannot read.',
  'gathered stack': 'Open the gathered stack first, so every card in it is copied.',
} as const;
interface ToolDetails {
  label: string;
  key: string;
  iconPath: string;
  hint: string | null;
}

const TOOL_DETAILS: Readonly<Record<BoardTool, ToolDetails>> = {
  select: { label: 'Select', key: 'V', iconPath: 'M4 2.5l8.5 5.8l-4 0.7l2.2 4.3l-1.5 0.8l-2.2-4.3L4 12.5z', hint: null },
  box: { label: 'Box', key: 'R', iconPath: 'M2.5 4h11v8h-11z', hint: 'Click or drag on the board to place a box. Esc to cancel.' },
  note: { label: 'Note', key: 'S', iconPath: 'M2.5 2.5h11v7l-4 4h-7z M9.5 13.5v-4h4', hint: 'Click or drag on the board to place a note. Esc to cancel.' },
  text: { label: 'Text', key: 'T', iconPath: 'M3 3.5h10 M8 3.5v9.5', hint: 'Click or drag on the board to place text. Esc to cancel.' },
  wire: { label: 'Arrow', key: 'A', iconPath: 'M2.5 13.5L13 3 M8.5 3H13v4.5', hint: 'Drag from a box or empty canvas; let go on a box to bind the end. Esc to cancel.' },
  line: { label: 'Line', key: 'L', iconPath: 'M2.5 13.5L13.5 2.5', hint: 'Drag to draw a line; let go on a box to bind the end. Esc to cancel.' },
  hand: { label: 'Hand', key: 'H', iconPath: 'M5.5 8V3.5a1 1 0 0 1 2 0V7.5 M7.5 7V2.5a1 1 0 0 1 2 0V7 M9.5 7V3.5a1 1 0 0 1 2 0V8 M11.5 8V5.5a1 1 0 0 1 2 0V10c0 2.5-2 4.5-4.5 4.5h-1c-1.6 0-2.6-.6-3.5-1.8L2.3 9.8a1 1 0 0 1 1.6-1.2L5.5 10', hint: 'Drag to pan the board. Esc to stop.' },
  pen: { label: 'Pen', key: 'P', iconPath: 'M2.5 13.5c2-1 3-4 5-4s2 3 4 3s2-3 2-5', hint: 'Drag on the board to draw. Esc to stop drawing.' },
  ellipse: { label: 'Ellipse', key: 'O', iconPath: 'M8 3c3.6 0 6 2.2 6 5s-2.4 5-6 5s-6-2.2-6-5s2.4-5 6-5z', hint: 'Click or drag on the board to place an ellipse. Esc to cancel.' },
  eraser: { label: 'Eraser', key: 'E', iconPath: 'M6 13.5l-3.5-3.5l7-7l5 5l-5.5 5.5z M5.5 6.5l5 5 M6 13.5h7.5', hint: 'Drag across elements to erase them. Esc to stop.' },
  decision: { label: 'Decision', key: 'D', iconPath: 'M8 2l6 6l-6 6l-6-6z', hint: 'Click or drag on the board to place a decision. Esc to cancel.' },
  icon: { label: 'Icon', key: 'I', iconPath: 'M8 2.5l1.6 3.3l3.6 0.5l-2.6 2.5l0.6 3.6L8 10.7l-3.2 1.7l0.6-3.6L2.8 6.3l3.6-0.5z', hint: 'Click or drag on the board to place an icon. Esc to cancel.' },
  device: { label: 'Device', key: 'M', iconPath: 'M5 1.5h6v13h-6z M7 12.5h2', hint: 'Click or drag on the board to place a device mockup. Esc to cancel.' },
};
const TOOLBAR_TOOLS: readonly BoardTool[] = ['hand', 'select', 'box', 'decision', 'ellipse', 'wire', 'line', 'pen', 'text', 'note', 'eraser'];
const MORE_TOOLS: readonly BoardTool[] = ['icon', 'device'];
const TOOL_LOCK_ICON_PATH = 'M4.5 7.5h7v6h-7z M6 7.5V5.5a2 2 0 0 1 4 0v2';

interface TextDialogOptions {
  title: string;
  label: string;
  placeholder: string;
  maxLength: number;
  confirmLabel: string;
  initialValue?: string;
  message?: string;
  onSubmit: (value: string) => Promise<string | null>;
}

interface BoardsViewParts {
  boardIsland: HTMLElement;
  boardMenu: ReturnType<typeof buildBoardMenu>;
  boardTitle: HTMLButtonElement;
  boardMeta: HTMLElement;
  boardLink: HTMLButtonElement;
  presence: HTMLElement;
  host: HTMLElement;
  chrome: HTMLElement;
  canvas: HTMLElement;
  empty: HTMLElement;
  emptyText: HTMLElement;
  agentIsland: HTMLElement;
  agentChangeIsland: HTMLElement;
  agentChangeText: HTMLElement;
  queuedForSession: HTMLElement;
  pairedDisconnect: HTMLElement;
  buttons: Record<'fit' | 'undo' | 'redo', HTMLButtonElement>;
  toolButtons: ReadonlyMap<BoardTool, HTMLButtonElement>;
  toolLockButton: HTMLButtonElement;
  moreTools: ReturnType<typeof buildMoreToolsMenu>;
  toolHint: HTMLElement;
  emptyBoardHint: HTMLElement;
  mediaLayer: BoardMediaLayer;
  viewport: HTMLElement;
  world: HTMLElement;
}

export type GuestFirstView = { isReady: false } | { isReady: true; camera: Camera | null };

export interface BoardHostGuest {
  chrome: HTMLElement;
  overlays: readonly HTMLElement[];
  worldLayer: HTMLElement;
  markedBoxIds: () => ReadonlySet<string>;
  firstView: (boardBounds: Rect, viewWidthPx: number, viewHeightPx: number) => GuestFirstView;
  setStackOpen: (boardId: string, frameId: string, isOpen: boolean) => Promise<boolean>;
  onBoxClicked: (boardId: string, boxId: string) => void;
  onPainted: (camera: Camera) => void;
  onCameraMoved: (camera: Camera) => void;
}

let guest: BoardHostGuest | null = null;
let hostCamera: Camera = { x: 0, y: 0, scale: 1 };
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
let contextMenu: BoardContextMenu | null = null;
let inspector: BoardInspector | null = null;
let firstViewOfNextRender: 'fit' | 'kept camera' | null = 'fit';
const keptCameraByBoardId = new Map<string, Camera>();
const fittedBoardIdsByGuest = new WeakMap<BoardHostGuest, Set<string>>();
let pairedSessionId: string | null = null;
let shownReview: { boardId: string; review: BoardReview } | null = null;
let reviewRequestKey: string | null = null;
let openDocBox: { boardId: string; box: Extract<Element, { kind: 'box' }> } | null = null;
type RecordedSend = { ok: true; isUndoable: boolean; version: number | null } | { ok: false; error: string };
type SentOps = { isSent: boolean; version: number | null };

const status = createActionStatus('action-status wb-status');
const emptyStatus = createActionStatus('action-status wb-empty-status');
type UndoEntry = { ops: Op[]; expected: DiffBefore };
const historyByBoardId = new Map<string, UndoHistory<UndoEntry>>();
let historyQueue: Promise<unknown> = Promise.resolve();

function openTextDialog(options: TextDialogOptions): void {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: options.title });
  const input = textInput({ placeholder: options.placeholder, value: options.initialValue ?? '' });
  input.maxLength = options.maxLength;
  const inputField = field({ label: options.label, control: input });
  const btnConfirm = button({ variant: 'primary', label: options.confirmLabel, action: 'confirm-board-dialog' });
  actions.append(btnConfirm);
  if (options.message) dialog.append(el('p', 'dialog-message', options.message));
  dialog.append(inputField.element, actions);

  async function submit(): Promise<void> {
    const value = input.value.trim();
    if (!value) {
      inputField.setError(`${options.label} is empty.`);
      return;
    }
    btnConfirm.disabled = true;
    const error = await options.onSubmit(value);
    btnConfirm.disabled = false;
    if (error) {
      inputField.setError(error);
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

function pullRequestUrlOf(boxId: string): string | null {
  const box = selectedBoard()?.elements.get(boxId);
  return box?.kind === 'box' ? box.pullRequest?.url ?? null : null;
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

function fitsOnePut(entry: UndoEntry): boolean {
  return entry.ops.length <= WHITEBOARD_LIMITS.opsPerPut && new TextEncoder().encode(JSON.stringify(entry)).length <= WHITEBOARD_LIMITS.putBytes;
}

function undoEntryOf(patch: WhiteboardPatch | null): UndoEntry | null {
  if (!patch) return { ops: [], expected: { fields: {}, elements: {} } };
  const step = undoStepOf(patch.before, patch.diff);
  const entry = { ops: [...step.ops, ...restoredStackOrderOpsOf(patch)], expected: step.expected };
  return fitsOnePut(entry) ? entry : null;
}

function restoredStackOrderOpsOf(patch: WhiteboardPatch): Op[] {
  const reslottedIds = Object.keys(patch.before.elements).filter((id) => !isArrayIndexKey(id) && patch.before.elements[id] && patch.diff.elements[id]?.[0] === 'put');
  return reslottedIds.length === 0 ? [] : [{ op: 'order', ids: reslottedIds, to: 'front' }];
}

function commandChord(key: string): string {
  return `${SHORTCUT_PLATFORM === 'mac' ? 'Cmd' : 'Ctrl'}+${key}`;
}

async function copySelectionToClipboard(copiedTextOf: () => string | null | undefined, chordKey: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    status.show('error', `This page cannot reach the clipboard here. Press ${commandChord(chordKey)} on the board instead.`);
    return;
  }
  const copiedText = copiedTextOf();
  if (!copiedText) return;
  await navigator.clipboard.writeText(copiedText).catch(() => status.show('error', 'Could not copy: the browser refused the clipboard.'));
}

async function pasteFromClipboard(): Promise<void> {
  const pastedText = navigator.clipboard?.readText ? await navigator.clipboard.readText().catch(() => null) : null;
  if (pastedText === null) {
    status.show('error', `Could not read the clipboard here. Press ${commandChord('V')} on the board instead.`);
    return;
  }
  if (pastedText) await editor?.pasteText(pastedText);
}

function selectionMenuGroups(activeEditor: BoardEditor): ContextMenuGroup[] {
  const selectedBoxCount = selectedElementsOfKind('box').length;
  return [
    [
      { label: 'Cut', shortcut: commandChord('X'), run: () => void copySelectionToClipboard(() => activeEditor.cutSelection(), 'X') },
      { label: 'Copy', shortcut: commandChord('C'), run: () => void copySelectionToClipboard(() => activeEditor.copySelection(), 'C') },
      { label: 'Paste', shortcut: commandChord('V'), run: () => void pasteFromClipboard() },
      { label: 'Duplicate', shortcut: commandChord('D'), run: () => activeEditor.duplicateSelection() },
      { label: 'Delete', shortcut: 'Delete', tone: 'danger', run: () => activeEditor.removeSelected() },
    ],
    [
      { label: 'Bring to front', shortcut: commandChord('Shift+]'), run: () => activeEditor.orderSelected('front') },
      { label: 'Bring forward', shortcut: commandChord(']'), run: () => activeEditor.orderSelected('forward') },
      { label: 'Send backward', shortcut: commandChord('['), run: () => activeEditor.orderSelected('backward') },
      { label: 'Send to back', shortcut: commandChord('Shift+['), run: () => activeEditor.orderSelected('back') },
    ],
    selectedBoxCount < 2 ? [] : [
      { label: 'Align left', shortcut: null, run: () => activeEditor.alignSelected('left') },
      { label: 'Align center', shortcut: null, run: () => activeEditor.alignSelected('center') },
      { label: 'Align right', shortcut: null, run: () => activeEditor.alignSelected('right') },
      { label: 'Align top', shortcut: null, run: () => activeEditor.alignSelected('top') },
      { label: 'Align middle', shortcut: null, run: () => activeEditor.alignSelected('middle') },
      { label: 'Align bottom', shortcut: null, run: () => activeEditor.alignSelected('bottom') },
    ],
    selectedBoxCount < 3 ? [] : [
      { label: 'Distribute horizontally', shortcut: null, run: () => activeEditor.distributeSelected('horizontal') },
      { label: 'Distribute vertically', shortcut: null, run: () => activeEditor.distributeSelected('vertical') },
    ],
    selectedBoxCount < 2 ? [] : [
      { label: 'Frame', shortcut: null, run: addFrame },
      { label: 'Stack', shortcut: null, run: stackSelectedBoxes },
    ],
  ];
}

function canvasMenuGroups(activeEditor: BoardEditor): ContextMenuGroup[] {
  return [
    [{ label: 'Paste', shortcut: commandChord('V'), run: () => void pasteFromClipboard() }],
    [
      { label: 'Select all', shortcut: commandChord('A'), run: () => activeEditor.selectAll() },
      { label: 'Fit', shortcut: 'Shift+1', run: () => activeEditor.fit() },
    ],
  ];
}

function openBoardContextMenu(clientX: number, clientY: number, target: 'selection' | 'canvas'): void {
  if (!editor || !contextMenu) return;
  contextMenu.openAt(clientX, clientY, target === 'selection' ? selectionMenuGroups(editor) : canvasMenuGroups(editor));
}

function recordPatch(boardId: string, patch: WhiteboardPatch | null): boolean {
  const entry = undoEntryOf(patch);
  if (!entry) {
    historyByBoardId.set(boardId, EMPTY_HISTORY);
    return false;
  }
  if (entry.ops.length === 0) return true;
  historyByBoardId.set(boardId, recordEdit(historyByBoardId.get(boardId) ?? EMPTY_HISTORY, entry));
  return true;
}

async function sendAndRecord(boardId: string, ops: Op[]): Promise<RecordedSend> {
  const outcome = await sendBoardOps(boardId, ops);
  if (!outcome.ok) return outcome;
  return { ok: true, isUndoable: recordPatch(boardId, outcome.patch), version: outcome.patch?.toVersion ?? null };
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
  const outcome = await sendBoardOps(boardId, step.entry.ops, step.entry.expected);
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
  if (entry.ops.length === 0) return;
  historyByBoardId.set(boardId, recordStep(historyByBoardId.get(boardId) ?? EMPTY_HISTORY, direction, entry));
}

async function sendOps(ops: Op[]): Promise<boolean> {
  return (await sendOpsReportingVersion(ops)).isSent;
}

async function sendOpsReportingVersion(ops: Op[]): Promise<SentOps> {
  if (!selectedBoardId || ops.length === 0) return { isSent: false, version: null };
  const outcome = await sendRecordedOps(selectedBoardId, ops);
  if (outcome.ok && !outcome.isUndoable) {
    status.show('ok', TOO_BIG_TO_UNDO_TEXT);
    return { isSent: true, version: outcome.version };
  }
  if (outcome.ok) {
    status.clear();
    return { isSent: true, version: outcome.version };
  }
  status.show('error', outcome.error);
  return { isSent: false, version: null };
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
  for (const button of [...parts.toolButtons.values(), parts.toolLockButton, parts.moreTools.trigger]) button.disabled = !board;
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

function buildMoreToolsMenu() {
  const menuRoot = el('div', 'session-overflow wb-more-tools');
  const menu = el('div', 'popup-menu session-overflow-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'More tools');
  const trigger = createPressable('wb-tool');
  labelIconPressable(trigger, 'More tools');
  trigger.append(createLineIcon(MORE_ICON_PATH, '2'));
  const itemsByTool = new Map(MORE_TOOLS.map((tool) => [tool, moreToolItem(tool)]));
  menu.append(...itemsByTool.values());
  menuRoot.append(trigger, menu);
  popupMenu({ trigger, menu });
  return { menuRoot, trigger, itemsByTool };
}

function moreToolItem(tool: BoardTool): HTMLButtonElement {
  const { label, key, iconPath } = TOOL_DETAILS[tool];
  const item = buildMenuItem(label, 'visible wb-more-tool');
  item.setAttribute('role', 'menuitemradio');
  item.setAttribute('aria-checked', 'false');
  item.setAttribute('aria-keyshortcuts', key);
  const keyHint = el('span', 'wb-more-tool-key', key);
  keyHint.setAttribute('aria-hidden', 'true');
  item.prepend(createLineIcon(iconPath, '1.5'));
  item.append(keyHint);
  item.addEventListener('click', () => {
    editor?.setTool(tool);
    editor?.focusCanvas();
  });
  return item;
}

function buildBoardMenu(onBoardSettings: () => void) {
  const menuRoot = el('div', 'session-overflow wb-board-menu');
  const menu = el('div', 'popup-menu session-overflow-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Board menu');
  const trigger = menuButton({ label: 'Board actions', action: 'open-board-menu' });
  const actionItem = (label: string, onChoose: () => void, tone?: 'danger') => {
    const item = buildMenuItem(label, 'visible', { tone });
    item.addEventListener('click', onChoose);
    return item;
  };
  const boardSettingsItem = actionItem('Board settings', onBoardSettings);
  const unlinkItem = actionItem('Unlink folder', unlinkBoardFolder);
  const actionItems = [
    actionItem('New board', newBoardFromDialog),
    actionItem('Import board', pickBoardFileToImport),
    actionItem('Export board', openExportBoardDialog),
    actionItem('Link to folder', linkBoardFromDialog),
    unlinkItem,
    boardSettingsItem,
    actionItem('Delete board', confirmDeleteBoard, 'danger'),
  ];
  menuRoot.append(trigger, menu);
  popupMenu({
    trigger,
    menu,
    onOpen: () => {
      boardSettingsItem.classList.toggle('visible', !isPhoneLayout());
      unlinkItem.classList.toggle('visible', Boolean(selectedSummary()?.link));
    },
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
  paintBoardLink(summary);
  paintToolbar();
  paintPairedSession();
}

const EDITED_JUST_NOW_BELOW_SECONDS = 60;

function paintBoardLink(summary: BoardSummary): void {
  if (!parts) return;
  const { boardLink } = parts;
  boardLink.hidden = summary.link === null;
  if (summary.link === null) {
    delete boardLink.dataset.linkState;
    return;
  }
  const linkText = `${summary.link.path}: ${summary.link.text}`;
  boardLink.dataset.linkState = summary.link.state;
  if (boardLink.textContent !== linkText) boardLink.textContent = linkText;
}

function paintBoardEditedAge(): void {
  if (!parts) return;
  const summary = selectedSummary();
  if (!summary) return;
  const editedText = `edited ${elapsedText(clock.nowMs() - summary.updatedAt, { ...COMPACT_FLOORED_AGO, justNowBelowSeconds: EDITED_JUST_NOW_BELOW_SECONDS })}`;
  if (parts.boardMeta.textContent !== editedText) parts.boardMeta.textContent = editedText;
}

function confirmDisconnectSession(boardId: string, sessionId: string): void {
  const summary = boardSummariesOf().find((candidate) => candidate.id === boardId);
  if (!summary) return;
  openConfirmDialog({
    title: 'Disconnect session',
    message: `Disconnect ${sessionLabel(sessionId)} from ${summary.title}? It stops getting summaries of changes to the board until it connects again.`,
    confirmLabel: 'Disconnect',
    onConfirm: () => {
      void disconnectSessionFromBoard(boardId, sessionId).then((outcome) => {
        if (!outcome.ok) status.show('error', outcome.error);
      });
    },
  });
}

function disconnectControl(sessionName: string, onChoose: () => void): HTMLElement {
  const disconnect = createPressable('wb-presence-disconnect');
  disconnect.setAttribute('aria-label', `Disconnect ${sessionName}`);
  disconnect.append(createLineIcon(CLOSE_ICON_PATH));
  disconnect.addEventListener('click', onChoose);
  return disconnect;
}

function presencePill(boardId: string, sessionId: string): HTMLElement {
  const name = sessionLabel(sessionId);
  const pill = el('span', 'wb-presence-pill');
  pill.append(el('span', 'wb-presence-name', name), disconnectControl(name, () => confirmDisconnectSession(boardId, sessionId)));
  return pill;
}

function disconnectPairedSession(): void {
  const summary = selectedSummary();
  if (!summary || !pairedSessionId) return;
  confirmDisconnectSession(summary.id, pairedSessionId);
}

function paintPresence(boardId: string | null, connectedSessionIds: readonly string[]): void {
  if (!parts) return;
  const pills = boardId === null ? [] : connectedSessionIds.filter((sessionId) => sessionId !== pairedSessionId).map((sessionId) => presencePill(boardId, sessionId));
  parts.presence.replaceChildren(...pills);
  if (connectedSessionIds.length === 0) parts.presence.append(el('span', 'wb-presence-none', 'no sessions connected'));
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
  paintPresence(summary?.id ?? null, summary?.connectedSessionIds ?? []);
  parts.agentIsland.hidden = !pairedSessionId;
  if (!pairedSessionId) return;
  parts.agentIsland.toggleAttribute('data-idle', !hasNewsForPairedSession(summary, pairedSessionId));
  parts.queuedForSession.textContent = queuedForSessionText(summary, pairedSessionId);
  parts.pairedDisconnect.hidden = !summary?.connectedSessionIds.includes(pairedSessionId);
  parts.pairedDisconnect.setAttribute('aria-label', `Disconnect ${sessionLabel(pairedSessionId)}`);
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
    agentChangedIds: new Set([...(selectedBoardId ? ringedAgentBoxIdsOf(selectedBoardId) : []), ...(guest?.markedBoxIds() ?? [])]),
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

function paintAgentChange(): void {
  if (!parts) return;
  const change = selectedBoardId ? offViewAgentChangeOf(selectedBoardId) : null;
  parts.agentChangeIsland.hidden = !change;
  if (!change) return;
  parts.agentChangeText.textContent = agentChangeSentence(change);
}

const FOCUSED_CHANGE_BREATHING_RATIO = 1.02;

function areaWithBreathingRoom(area: Rect): Rect {
  const width = area.width * FOCUSED_CHANGE_BREATHING_RATIO;
  const height = area.height * FOCUSED_CHANGE_BREATHING_RATIO;
  return { x: area.x - (width - area.width) / 2, y: area.y - (height - area.height) / 2, width, height };
}

function focusAgentChangeOf(boardId: string): void {
  const change = takeBoardFocusFor(boardId);
  if (!change) return;
  editor?.frameArea(areaWithBreathingRoom(rectAround(change.boxes.map((box) => box.rect))));
  dismissAgentChange();
  ringAgentChange(boardId, change);
}

function currentViewArea(): Rect | null {
  if (!parts || parts.viewport.clientWidth === 0) return null;
  return { x: hostCamera.x, y: hostCamera.y, width: parts.viewport.clientWidth / hostCamera.scale, height: parts.viewport.clientHeight / hostCamera.scale };
}

function viewCenteredOn(cardArea: Rect, viewArea: Rect): Rect {
  return { x: cardArea.x + cardArea.width / 2 - viewArea.width / 2, y: cardArea.y + cardArea.height / 2 - viewArea.height / 2, width: viewArea.width, height: viewArea.height };
}

function goToAgentChange(): void {
  const change = selectedBoardId ? offViewAgentChangeOf(selectedBoardId) : null;
  if (!change) return;
  dismissAgentChange();
  const cardArea = rectAround(change.boxes.map((box) => box.rect));
  const viewArea = currentViewArea();
  const fitsView = viewArea !== null && cardArea.width <= viewArea.width && cardArea.height <= viewArea.height;
  if (!fitsView) {
    editor?.frameArea(cardArea);
    return;
  }
  editor?.glideToView(viewCenteredOn(cardArea, viewArea));
}

export function paintBoard(): void {
  if (!renderer) return;
  const tiled = selectedBoardId ? tiledBoardOf(selectedBoardId) : null;
  if (!tiled) {
    if (parts) parts.emptyBoardHint.hidden = true;
    return;
  }
  renderer.renderLayout(tiled.layout, tiled.blocks);
  parts?.mediaLayer.showBackdrop(tiled.backdrop);
  editor?.repaintPreview();
  const { board } = tiled;
  requestReviewOf(board);
  editor?.pruneSelection(board);
  if (parts) parts.emptyBoardHint.hidden = tiled.elementCount > 0;
  paintReview();
  paintAgentChange();
  editor?.afterBoardPaint(tiled.version);
  if (firstViewOfNextRender && showFirstView(board.id, firstViewOfNextRender)) firstViewOfNextRender = null;
  focusAgentChangeOf(board.id);
  paintToolbar();
  guest?.onPainted(hostCamera);
}

function showFirstView(boardId: string, firstView: 'fit' | 'kept camera'): boolean {
  const keptCamera = firstView === 'kept camera' ? keptCameraByBoardId.get(boardId) : undefined;
  if (keptCamera) {
    editor?.showCamera(keptCamera);
    return true;
  }
  return fitFirstView();
}

function fitFirstView(): boolean {
  const layout = renderer?.layout();
  const guestFirstView = layout && parts && guest ? guest.firstView(layout.bounds, parts.viewport.clientWidth, parts.viewport.clientHeight) : null;
  if (guestFirstView && !guestFirstView.isReady) return false;
  if (guestFirstView?.camera) {
    editor?.showCamera(guestFirstView.camera);
    return true;
  }
  editor?.fit();
  return true;
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
  editor?.endPresenting();
  gatherClickOpenedStacksOfSelectedBoard();
  if (selectedBoardId && firstViewOfNextRender === null) keptCameraByBoardId.set(selectedBoardId, hostCamera);
  selectedBoardId = boardId;
  firstViewOfNextRender = 'kept camera';
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

function pressedBoxTitleOf({ boxId, alt }: PressedImage): string {
  const pressedBox = boxId ? selectedBoard()?.elements.get(boxId) : undefined;
  return pressedBox?.kind === 'box' ? pressedBox.title : alt;
}

function pressedMediaOf({ boxId }: PressedImage): BoxMedia | null {
  const pressedBox = boxId ? selectedBoard()?.elements.get(boxId) : undefined;
  return pressedBox?.kind === 'box' ? pressedBox.media : null;
}

function enlargedMediaOf(pressedImage: PressedImage, media: BoxMedia | null, listening: AbortSignal): HTMLElement {
  const boxTitle = pressedBoxTitleOf(pressedImage);
  const originalHref = media ? boardMediaNamedPath(media, boxTitle) : pressedImage.href;
  if (media?.kind === 'deck') return createDeckFrame(originalHref, pressedImage.alt || boxTitle || 'deck', listening);
  if (media?.kind === 'page') {
    const savedNameQuery = `${BOARD_PAGE_SAVED_NAME_QUERY}=${encodeURIComponent(boardMediaSavedName(media, boxTitle))}`;
    const pageFrame = createSandboxedFrame({ source: { kind: 'url', url: `${boardPagePath(media)}?${BOARD_PAGE_TUNED_QUERY}&${savedNameQuery}` }, className: 'wb-image-viewer-page', title: pressedImage.alt || 'page', allowsScripts: true });
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

function listenToViewerPage(pageFrame: HTMLIFrameElement, listening: AbortController, close: () => void, zoomControl: MediaZoomControl, viewerSizing: ViewerSizing, walkToward: (direction: { x: number; y: number }) => void): void {
  window.addEventListener('message', (event) => {
    if (event.source !== pageFrame.contentWindow) return;
    if (event.data === BOARD_PAGE_ESCAPE_MESSAGE) {
      close();
      return;
    }
    const pressedArrow = BoardPageArrow.safeParse(event.data);
    const pressedDirection = pressedArrow.success ? NUDGE_DIRECTION_BY_KEY[pressedArrow.data.key] : undefined;
    if (pressedDirection) {
      walkToward(pressedDirection);
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
}

function abortWhenOverlayLeaves(overlay: HTMLElement, abortShownMedia: () => void): void {
  const overlayWatcher = new MutationObserver(() => {
    if (overlay.isConnected) return;
    abortShownMedia();
    overlayWatcher.disconnect();
  });
  overlayWatcher.observe(document.body, { childList: true });
}

const VIEWABLE_MEDIA_KINDS: ReadonlySet<BoxMedia['kind']> = new Set(['image', 'video', 'page', 'deck']);

function walkableBoundsOf(board: Board, boxId: string): { x: number; y: number; width: number; height: number } | null {
  const box = board.elements.get(boxId);
  if (box?.kind !== 'box' || !box.media || !VIEWABLE_MEDIA_KINDS.has(box.media.kind)) return null;
  return renderer?.boundsOf(boxId) ?? null;
}

function wiredNeighbourOf(shownBoxId: string, direction: { x: number; y: number }): PressedImage | null {
  const board = selectedBoard();
  if (!board) return null;
  const wires = [...board.elements.values()].filter((element) => element.kind === 'wire');
  const neighbourId = nextWiredBoxId(shownBoxId, direction, wires, (boxId) => walkableBoundsOf(board, boxId));
  const neighbour = neighbourId ? board.elements.get(neighbourId) : undefined;
  if (neighbour?.kind !== 'box' || !neighbour.media) return null;
  return { boxId: neighbour.id, href: '', alt: neighbour.media.alt || neighbour.title };
}

function isWalkKeyOwnedElsewhere(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true;
  return isRealInputOwningKey(event) || event.target instanceof HTMLMediaElement;
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
  const stored = await uploadBoardMedia(new File([docText], `${boxId}${BOARD_MEDIA_EXTENSION_BY_MIME[media.mime]}`, { type: media.mime }));
  if (!stored.ok) return { ok: false, isConflict: false, error: stored.error };
  if (stored.media.kind !== 'doc') return { ok: false, isConflict: false, error: BOARD_DOC_NOT_MARKDOWN_TEXT };
  if (docMediaOf(boardId, boxId)?.asset !== loadedAsset) return { ok: false, isConflict: true, error: null };
  const savedMedia = { ...stored.media, alt: media.alt, source: media.source };
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
      return { ok: true, text: docText, hash: media.asset, format: media.mime === 'text/x-fountain' ? 'fountain' : 'markdown' };
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

function sheetMediaOf(boardId: string, boxId: string): BoxMedia | null {
  const held = heldBoardOf(boardId)?.elements.get(boxId);
  const media = held?.kind === 'box' ? held.media : null;
  return media?.kind === 'sheet' ? media : null;
}

async function saveBoardSheet(boardId: string, boxId: string, sheetText: string, loadedAsset: string): Promise<SheetSaveOutcome> {
  const media = sheetMediaOf(boardId, boxId);
  if (!media || media.asset !== loadedAsset) return { ok: false, isConflict: true, error: null };
  if (media.link) {
    const saved = await inHistoryOrder(async () => {
      const outcome = await saveLinkedBoardDoc(boardId, boxId, sheetText, loadedAsset);
      if (outcome.ok) recordPatch(boardId, outcome.patch);
      return outcome;
    });
    return saved.ok ? { ok: true, asset: saved.savedMedia.asset } : { ok: false, isConflict: saved.isConflict, error: saved.isConflict ? null : saved.error };
  }
  const stored = await uploadBoardMedia(new File([sheetText], boardMediaSavedName(media, boxId), { type: media.mime }));
  if (!stored.ok) return { ok: false, isConflict: false, error: stored.error };
  if (sheetMediaOf(boardId, boxId)?.asset !== loadedAsset) return { ok: false, isConflict: true, error: null };
  const savedMedia = { ...stored.media, alt: media.alt, source: media.source };
  const sent = await sendRecordedOps(boardId, [{ op: 'set', id: boxId, fields: { media: savedMedia } }]);
  if (!sent.ok) return { ok: false, isConflict: false, error: sent.error };
  return { ok: true, asset: savedMedia.asset };
}

function openBoardSheet(boardId: string, boxId: string): void {
  const box = heldBoardOf(boardId)?.elements.get(boxId);
  if (box?.kind !== 'box') return;
  const board = heldBoardOf(boardId);
  if (board && box.media?.link) refreshReviewOf(board);
  openSheetEditor({
    title: box.title,
    media: () => sheetMediaOf(boardId, boxId),
    readText: (media, sheetIndex) => fetchBoardSheetText(media, sheetIndex),
    unsaveableText: () => {
      const linkState = linkStateOf(boardId, boxId);
      return linkState?.state === 'broken' ? `${linkState.text}, so this sheet is read-only until it is linked again or unlinked.` : null;
    },
    save: (sheetText, loadedAsset) => saveBoardSheet(boardId, boxId, sheetText, loadedAsset),
  });
}

const VIEWER_WIDTH_BOUNDS = { minPx: 240, maxPx: BOARD_MEDIA_MAX_EDGE_PX };
const VIEWER_WIDTH_KEY_STEP_PX = 40;
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
    const visibleWidthPx = mediaSheet.clientWidth - SHEET_WIDTH_HANDLE_PX;
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

function wireViewerWidth(zoomStage: HTMLElement, mediaSheet: HTMLElement, widthHandle: HTMLElement, viewerSizing: ViewerSizing): void {
  wireSheetWidth({
    widthHost: zoomStage,
    sheet: mediaSheet,
    handle: widthHandle,
    widthProperty: '--wb-viewer-width',
    bounds: VIEWER_WIDTH_BOUNDS,
    keyStepPx: VIEWER_WIDTH_KEY_STEP_PX,
    reservePx: 0,
    getStoredWidth: viewerSizing.operatorWidth,
    setStoredWidth: viewerSizing.takeOperatorWidth,
  });
}

function downloadOriginalOf(pressedImage: PressedImage, media: BoxMedia | null): void {
  if (!media) return;
  const boxTitle = pressedBoxTitleOf(pressedImage);
  const download = el('a');
  download.href = boardMediaNamedPath(media, boxTitle);
  download.download = boardMediaSavedName(media, boxTitle);
  download.click();
}

const UNWIRED_PRESENT_TEXT = 'Wire boxes in order, from each slide to the next, to present them.';

async function presentBoard(): Promise<void> {
  const presentedBoardId = selectedBoardId;
  if (!editor || !presentedBoardId) return;
  const outcome = await requestBoardSlides(presentedBoardId);
  if (!editor || selectedBoardId !== presentedBoardId) return;
  if (!outcome.ok) {
    status.show('error', outcome.error);
    return;
  }
  if (editor.startPresenting(outcome.slides)) return;
  status.show('error', UNWIRED_PRESENT_TEXT);
}

let presentingListening: AbortController | null = null;

function showPresenting(canvas: HTMLElement, isPresenting: boolean): void {
  canvas.dataset.presenting = String(isPresenting);
  presentingListening?.abort();
  presentingListening = null;
  if (!isPresenting) {
    if (document.fullscreenElement === document.documentElement) void document.exitFullscreen();
    return;
  }
  if (!document.fullscreenEnabled) return;
  presentingListening = new AbortController();
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) editor?.endPresenting();
  }, { signal: presentingListening.signal });
  document.documentElement.requestFullscreen().catch(() => editor?.focusCanvas());
}

function openImageViewer(pressedImage: PressedImage): void {
  const media = pressedMediaOf(pressedImage);
  if (!media && !pressedImage.href) return;
  if (media?.kind === 'doc' && selectedBoardId && pressedImage.boxId) {
    openBoardDoc(selectedBoardId, pressedImage.boxId);
    return;
  }
  if (media?.kind === 'sheet' && selectedBoardId && pressedImage.boxId) {
    openBoardSheet(selectedBoardId, pressedImage.boxId);
    return;
  }
  const { overlay, dialog, close, titleEl, btnCancel } = buildDialogShell({ title: pressedImage.alt || 'Picture', dialogClass: 'dialog wb-image-viewer', cancelLabel: 'Close' });
  const header = el('div', 'wb-image-viewer-header');
  titleEl.replaceWith(header);
  header.append(titleEl, btnCancel);
  overlay.classList.add('wb-image-viewer-overlay');
  overlay.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  }, { passive: false });
  const zoomStage = el('div', 'wb-image-viewer-stage');
  const mediaSheet = el('div', 'wb-image-viewer-sheet');
  const widthHandle = sheetWidthHandle('Media width');
  mediaSheet.append(widthHandle);
  zoomStage.append(mediaSheet);
  dialog.append(zoomStage);
  const viewerSizing = createViewerSizing(zoomStage, mediaSheet);
  wireViewerWidth(zoomStage, mediaSheet, widthHandle, viewerSizing);
  const firstListening = new AbortController();
  let shown = { pressedImage, media, enlargedMedia: enlargedMediaOf(pressedImage, media, firstListening.signal), listening: firstListening };
  const btnDownload = button({ variant: 'secondary', label: 'Download' });
  btnDownload.addEventListener('click', () => downloadOriginalOf(shown.pressedImage, shown.media));
  header.insertBefore(btnDownload, btnCancel);
  const zoomControl = attachMediaZoom(zoomStage, mediaSheet, (isZoomed) => {
    zoomStage.classList.toggle('is-zoomed', isZoomed);
    if (shown.enlargedMedia instanceof HTMLIFrameElement) postZoomedState(shown.enlargedMedia, isZoomed);
  });

  function showEnlargedMedia(): void {
    shown.enlargedMedia.classList.add('wb-image-viewer-media');
    mediaSheet.prepend(shown.enlargedMedia);
    titleEl.textContent = shown.pressedImage.alt || 'Picture';
    btnDownload.hidden = shown.media?.kind !== 'deck';
    if (shown.enlargedMedia instanceof HTMLIFrameElement) listenToViewerPage(shown.enlargedMedia, shown.listening, close, zoomControl, viewerSizing, walkToward);
  }

  function walkToward(direction: { x: number; y: number }): boolean {
    const neighbour = shown.pressedImage.boxId ? wiredNeighbourOf(shown.pressedImage.boxId, direction) : null;
    if (!neighbour) return false;
    shown.listening.abort();
    shown.enlargedMedia.remove();
    const neighbourMedia = pressedMediaOf(neighbour);
    const neighbourListening = new AbortController();
    shown = { pressedImage: neighbour, media: neighbourMedia, enlargedMedia: enlargedMediaOf(neighbour, neighbourMedia, neighbourListening.signal), listening: neighbourListening };
    viewerSizing.takeNewPage();
    showEnlargedMedia();
    return true;
  }

  overlay.addEventListener('keydown', (event) => {
    const shownDeckFrame = shown.media?.kind === 'deck' && shown.enlargedMedia instanceof HTMLIFrameElement ? shown.enlargedMedia : null;
    if (shownDeckFrame && !isWalkKeyOwnedElsewhere(event) && forwardDeckKey(shownDeckFrame, event.key)) {
      event.preventDefault();
      return;
    }
    const direction = NUDGE_DIRECTION_BY_KEY[event.key];
    if (!direction || isWalkKeyOwnedElsewhere(event)) return;
    if (walkToward(direction)) event.preventDefault();
  });
  abortWhenOverlayLeaves(overlay, () => shown.listening.abort());
  showEnlargedMedia();
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
  void (guest ? guest.setStackOpen(selectedBoardId, frameId, true) : sendOps([{ op: 'set', id: frameId, fields: { collapsed: false } }])).then((isSent) => {
    if (!isSent) clickOpenedStacksByFrameId.delete(frameId);
  });
}

function gatherClickOpenedStacksOfSelectedBoard(): void {
  for (const [frameId, clickOpenedStack] of clickOpenedStacksByFrameId) {
    if (clickOpenedStack.boardId !== selectedBoardId) continue;
    clickOpenedStacksByFrameId.delete(frameId);
    if (guest) {
      void guest.setStackOpen(clickOpenedStack.boardId, frameId, false);
      continue;
    }
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
    if (settled === 'gather') gatherStack(clickOpenedStack.boardId, frameId, gatherOps);
    if (settled === 'gather' || settled === 'forget') {
      clickOpenedStacksByFrameId.delete(frameId);
      continue;
    }
    clickOpenedStacksByFrameId.set(frameId, settled);
  }
  void sendOps(gatherOps);
}

function gatherClickedStack(frameId: string): void {
  if (!selectedBoardId) return;
  clickOpenedStacksByFrameId.delete(frameId);
  const gatherOps: Op[] = [];
  gatherStack(selectedBoardId, frameId, gatherOps);
  void sendOps(gatherOps);
}

function gatherStack(boardId: string, frameId: string, gatherOps: Op[]): void {
  if (guest) {
    void guest.setStackOpen(boardId, frameId, false);
    return;
  }
  gatherOps.push({ op: 'set', id: frameId, fields: { collapsed: true } });
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

const BOARD_EXPORT_FORMATS = [
  { value: 'svg', label: 'SVG picture', routeTemplate: `${WHITEBOARD_PICTURE_ROUTE}/{boardId}/picture.svg`, extension: '.svg' },
  { value: 'png', label: 'PNG picture', routeTemplate: `${WHITEBOARD_PICTURE_ROUTE}/{boardId}/picture.png`, extension: '.png' },
  { value: 'board-file', label: 'Board file, to import elsewhere', routeTemplate: `${WHITEBOARD_FILE_ROUTE}/{boardId}/${BOARD_FILE_DOWNLOAD_NAME}`, extension: BOARD_FILE_EXTENSION },
] as const;

function buildExportFormatChoice(format: typeof BOARD_EXPORT_FORMATS[number], isChecked: boolean): HTMLLabelElement {
  return radio({ name: 'board-export-format', value: format.value, label: format.label, checked: isChecked }).element;
}

function suggestedLinkPathOf(summary: BoardSummary): string {
  const folderName = summary.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const basePath = `boards/${folderName || 'board'}`;
  const linkedPaths = new Set(boardSummariesOf().flatMap((other) => (other.id !== summary.id && other.link ? [other.link.path] : [])));
  if (!linkedPaths.has(basePath)) return basePath;
  let copyNumber = 2;
  while (linkedPaths.has(`${basePath}-${copyNumber}`)) copyNumber += 1;
  return `${basePath}-${copyNumber}`;
}

function linkBoardFromDialog(): void {
  const summary = selectedSummary();
  if (!summary) return;
  openTextDialog({
    title: 'Link the board to a folder',
    label: 'Folder in the code session worktree',
    placeholder: 'boards/login-flow',
    maxLength: BOARD_LINK_PATH_MAX_LENGTH,
    confirmLabel: 'Link folder',
    initialValue: summary.link?.path ?? suggestedLinkPathOf(summary),
    message: summary.link?.text,
    onSubmit: (linkPath) => sendOpsFromDialog([{ op: 'board', link: linkPath }]),
  });
}

function unlinkBoardFolder(): void {
  void sendOps([{ op: 'board', link: null }]);
}

function openExportBoardDialog(): void {
  if (!selectedSummary()) return;
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: 'Export board' });
  const formatList = el('fieldset', 'dialog-workspace-list');
  formatList.setAttribute('aria-label', 'Export format');
  formatList.append(...BOARD_EXPORT_FORMATS.map((format, index) => buildExportFormatChoice(format, index === 0)));
  const btnExport = button({ variant: 'primary', label: 'Export' });
  actions.append(btnExport);
  dialog.append(formatList, actions);
  btnCancel.addEventListener('click', close);
  btnExport.addEventListener('click', () => {
    const pickedValue = formatList.querySelector<HTMLInputElement>('input:checked')?.value;
    const pickedFormat = BOARD_EXPORT_FORMATS.find((format) => format.value === pickedValue);
    if (!pickedFormat) return;
    close();
    void downloadBoardExport(pickedFormat.routeTemplate, pickedFormat.extension);
  });
  requestAnimationFrame(() => btnExport.focus());
}

async function downloadBoardExport(routeTemplate: string, extension: string): Promise<void> {
  const summary = selectedSummary();
  if (!summary) return;
  const response = await fetch(routeTemplate.replace('{boardId}', encodeURIComponent(summary.id))).catch(() => null);
  if (!response?.ok) {
    const refusal: unknown = await response?.json().catch(() => null);
    const reason = typeof refusal === 'object' && refusal !== null && 'error' in refusal && typeof refusal.error === 'string' ? refusal.error : 'the board could not be exported';
    status.show('error', reason);
    return;
  }
  const exportUrl = URL.createObjectURL(await response.blob());
  const download = el('a');
  download.href = exportUrl;
  download.download = `${summary.title}${extension}`;
  download.click();
  URL.revokeObjectURL(exportUrl);
}

function pickBoardFileToImport(): void {
  const picker = el('input');
  picker.type = 'file';
  picker.accept = BOARD_FILE_EXTENSION;
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    if (file) void importPickedBoardFile(file);
  });
  picker.click();
}

async function importPickedBoardFile(file: File): Promise<void> {
  const shownStatus = selectedSummary() ? status : emptyStatus;
  shownStatus.show('busy', `Importing ${file.name}`);
  const outcome = await importBoardFile(file);
  if (!outcome.ok) {
    shownStatus.show('error', outcome.error);
    return;
  }
  emptyStatus.clear();
  pickBoard(outcome.boardId);
  status.show('ok', `Imported ${file.name}`);
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

function iconButton(label: string, shortcutKey: string | undefined, iconPath: string, action: string, onClick: () => void): HTMLButtonElement {
  const iconOnlyButton = button({ variant: 'icon', label, icon: createLineIcon(iconPath, '1.5'), action, onClick });
  labelIconPressable(iconOnlyButton, label, shortcutKey);
  return iconOnlyButton;
}

function toolButton(tool: BoardTool): HTMLButtonElement {
  const { label, key, iconPath } = TOOL_DETAILS[tool];
  const toolOption = createPressable('wb-tool');
  labelIconPressable(toolOption, label, key);
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

function toolLockButton(): HTMLButtonElement {
  const lockToggle = createPressable('wb-tool wb-tool-lock');
  labelIconPressable(lockToggle, 'Keep tool selected', 'Q');
  const keyHint = el('span', 'wb-tool-key', 'Q');
  keyHint.setAttribute('aria-hidden', 'true');
  lockToggle.append(createLineIcon(TOOL_LOCK_ICON_PATH, '1.5'), keyHint);
  lockToggle.setAttribute('aria-keyshortcuts', 'Q');
  lockToggle.setAttribute('aria-pressed', 'false');
  lockToggle.addEventListener('click', () => {
    editor?.toggleToolLock();
    editor?.focusCanvas();
  });
  return lockToggle;
}

function paintToolLock(isToolLocked: boolean): void {
  parts?.toolLockButton.setAttribute('aria-pressed', String(isToolLocked));
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
  for (const [tool, item] of parts.moreTools.itemsByTool) item.setAttribute('aria-checked', String(tool === activeTool));
  parts.moreTools.trigger.dataset.active = String(MORE_TOOLS.includes(activeTool));
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
    if (files.length > 0) {
      event.preventDefault();
      void addMediaFiles(files, null);
      return;
    }
    const pastedText = event.clipboardData?.getData('text/plain') ?? '';
    if (!pastedText || !isBoardFocused(host)) return;
    event.preventDefault();
    void editor?.pasteText(pastedText);
  });
  const copyInto = (event: ClipboardEvent, copiedTextOf: () => string | null | undefined) => {
    if (!editor?.isCanvasFocused() || isModalOpen()) return;
    const copiedText = copiedTextOf();
    if (!copiedText || !event.clipboardData) return;
    event.clipboardData.setData('text/plain', copiedText);
    event.preventDefault();
  };
  document.addEventListener('copy', (event) => copyInto(event, () => editor?.copySelection()));
  document.addEventListener('cut', (event) => copyInto(event, () => editor?.cutSelection()));
}

function isBoardFocused(host: HTMLElement): boolean {
  const focused = document.activeElement;
  return focused === null || focused === document.body || host.contains(focused);
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
  const boardLink = createPressable('wb-board-link pane-header-subtitle');
  boardLink.addEventListener('click', linkBoardFromDialog);
  boardLink.hidden = true;
  const presence = el('div', 'wb-presence');
  const boardIsland = island('wb-island-board', 'Board', boardMenu.menuRoot, boardTitle, boardMeta, boardLink, presence, status.element);

  const toolButtons = new Map(TOOLBAR_TOOLS.map((tool) => [tool, toolButton(tool)]));
  const toolGroup = el('div', 'wb-tools');
  toolGroup.setAttribute('role', 'group');
  toolGroup.setAttribute('aria-label', 'Drawing tools');
  const lockButton = toolLockButton();
  const moreTools = buildMoreToolsMenu();
  toolGroup.append(lockButton, ...toolButtons.values(), moreTools.menuRoot);
  const buttons = {
    fit: iconButton('Fit', 'Shift+1', FIT_ICON_PATH, 'fit-board', () => editor?.fit()),
    present: iconButton('Present', undefined, PRESENT_ICON_PATH, 'present-board', () => void presentBoard()),
    undo: iconButton('Undo', commandChord('Z'), UNDO_ICON_PATH, 'undo-board-edit', () => void stepHistory('undo')),
    redo: iconButton('Redo', commandChord('Shift+Z'), REDO_ICON_PATH, 'redo-board-edit', () => void stepHistory('redo')),
  };
  buttons.fit.dataset.phoneVisible = '';
  const toolsIsland = island('wb-island-tools', 'Board tools', toolGroup);
  const toolHint = el('p', 'wb-tool-hint');
  toolHint.setAttribute('aria-live', 'polite');
  toolHint.hidden = true;
  const viewIsland = island('wb-island-view', 'View', buttons.fit, buttons.present, buttons.undo, buttons.redo);

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
  followBoardSessionFeed(mediaLayer.showFeed);
  world.append(svg, mediaLayer.element);
  const glCanvas = el('canvas', 'wb-gl');
  glCanvas.setAttribute('aria-hidden', 'true');
  const flowCanvas = el('canvas', 'wb-flow');
  flowCanvas.setAttribute('aria-hidden', 'true');
  viewport.append(mediaLayer.backdrop, glCanvas, flowCanvas, world);
  const inspectPanel = el('aside', 'wb-inspect');
  const queuedForSession = el('span', 'wb-session-queued');
  const pairedDisconnect = disconnectControl('session', disconnectPairedSession);
  pairedDisconnect.hidden = true;
  const agentIsland = island('wb-island-agent', 'Session', queuedForSession, pairedDisconnect);
  agentIsland.hidden = true;
  const agentChangeText = el('span', 'wb-agent-change-text');
  const goToAgentChangeButton = button({ variant: 'secondary', size: 'small', label: 'Go to card', action: 'go-to-agent-change', onClick: goToAgentChange });
  const dismissAgentChangeButton = button({ variant: 'icon', size: 'small', label: 'Dismiss', icon: createLineIcon(CLOSE_ICON_PATH), action: 'dismiss-agent-change', onClick: dismissAgentChange });
  const agentChangeIsland = island('wb-island-agent-change', 'Agent change', agentChangeText, goToAgentChangeButton, dismissAgentChangeButton);
  agentChangeIsland.hidden = true;
  const bottomLeftStack = el('div', 'wb-bottom-left');
  bottomLeftStack.append(agentChangeIsland, agentIsland);
  const chrome = el('div', 'wb-top-left');
  chrome.append(boardIsland, viewIsland, toolsIsland, toolHint);
  const topRightStack = el('div', 'wb-top-right');
  topRightStack.append(inspectPanel);
  const topChrome = el('div', 'wb-top');
  topChrome.append(chrome, topRightStack);
  const emptyBoardHint = el('div', 'wb-empty-board');
  emptyBoardHint.hidden = true;
  emptyBoardHint.append(emptyState({
    title: 'This board is empty.',
    text: [
      el('span', 'wb-empty-board-keys', 'Pick box (R) and click the board to place one, or ask a session to draw here.'),
      el('span', 'wb-empty-board-touch', 'Ask a session to draw here.'),
    ],
    variant: 'centered',
  }));
  canvas.append(viewport, emptyBoardHint, topChrome, bottomLeftStack);
  const emptyText = el('span', null, EMPTY_TEXT);
  const empty = emptyState({ text: emptyText, actions: [button({ variant: 'secondary', label: 'new board', action: 'new-board', onClick: newBoardFromDialog }), button({ variant: 'secondary', label: 'import board', action: 'import-board', onClick: pickBoardFileToImport }), emptyStatus.element], variant: 'boxed' });
  empty.classList.add('wb-empty');

  host.replaceChildren(canvas, empty);
  parts = { boardIsland, boardMenu, boardTitle, boardMeta, boardLink, presence, host, chrome, canvas, empty, emptyText, agentIsland, agentChangeIsland, agentChangeText, queuedForSession, pairedDisconnect, buttons, toolButtons, toolLockButton: lockButton, moreTools, toolHint, emptyBoardHint, mediaLayer, viewport, world };
  onSessionTick(paintBoardEditedAge);
  const boardRenderer = createBoardRenderer({
    canvas: glCanvas,
    viewport,
    fontSource: svg,
    mediaLayer,
    flowCanvas,
    onViewChange: (view, scale) => {
      if (selectedBoardId) showTilesFor(selectedBoardId, view, scale);
      paintAgentChange();
      hostCamera = { x: view.x, y: view.y, scale };
      guest?.onCameraMoved(hostCamera);
    },
  });
  renderer = boardRenderer;
  const styleRows = createBoardStyleRows({ currentBoard: selectedBoard, sendOps });
  inspector = createBoardInspector({ container: inspectPanel, currentBoard: selectedBoard, layout: () => boardRenderer.layout(), sendOps, codeSessionChoices, styleRowsFor: styleRows.rowsFor, openRef: openRefInReview, worthALookReasonOf, linkStateOf: (boxId) => (selectedBoardId ? linkStateOf(selectedBoardId, boxId) : null), addNoteOn, frameSelectedBoxes: addFrame, stackSelectedBoxes, removeSelected: () => editor?.removeSelected() });
  editor = createBoardEditor({
    viewport,
    world,
    svg,
    canvas,
    renderer: boardRenderer,
    currentBoard: selectedBoard,
    repaint: paintBoard,
    sendOps,
    sendOpsReportingVersion,
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
    onStackBoxes: stackBoxes,
    onOpenStack: openStack,
    onGatherStack: gatherClickedStack,
    onClickBox: (boxId) => {
      const pullRequestUrl = pullRequestUrlOf(boxId);
      if (pullRequestUrl !== null) {
        openExternalUrl(pullRequestUrl);
        return;
      }
      if (guest && selectedBoardId) guest.onBoxClicked(selectedBoardId, boxId);
    },
    isOpenedStack: (frameId) => clickOpenedStacksByFrameId.has(frameId),
    onToolChange: paintActiveTool,
    onToolLockChange: paintToolLock,
    onClipboardNotice: (notice) => status.show(notice === 'cut' ? 'ok' : 'error', CLIPBOARD_NOTICE_TEXT[notice]),
    onContextMenu: openBoardContextMenu,
    onPresentChange: (isPresenting) => showPresenting(canvas, isPresenting),
    takesWheel: (wheel) => mediaLayer.takesWheel(wheel),
  });
  contextMenu = createBoardContextMenu(canvas, viewport);

  document.addEventListener('keydown', (event) => onHistoryKey(host, event));
  wireMediaDrops(host, canvas);
  onBoardListChanged(paintList);
  onBoardFocusRequested(paintBoard);
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

function seatGuest(nextGuest: BoardHostGuest | null): void {
  if (nextGuest === guest) return;
  gatherClickOpenedStacksOfSelectedBoard();
  for (const layer of guest ? [guest.chrome, guest.worldLayer, ...guest.overlays] : []) layer.remove();
  guest = nextGuest;
  if (!parts || !guest) return;
  parts.chrome.prepend(guest.chrome);
  parts.world.append(guest.worldLayer);
  parts.canvas.append(...guest.overlays);
}

export function leaveBoardHost(leavingGuest: BoardHostGuest): void {
  if (leavingGuest === guest) seatGuest(null);
}

export function glideHostTo(view: Rect): void {
  editor?.glideToView(view);
}

export function boundsOfHostBox(boxId: string): Rect | null {
  return renderer?.boundsOf(boxId) ?? null;
}

function fitFirstGuestView(seatedGuest: BoardHostGuest, boardId: string): void {
  const fittedBoardIds = fittedBoardIdsByGuest.get(seatedGuest) ?? new Set<string>();
  if (fittedBoardIds.has(boardId)) return;
  fittedBoardIds.add(boardId);
  fittedBoardIdsByGuest.set(seatedGuest, fittedBoardIds);
  firstViewOfNextRender = 'fit';
}

export function showBoardBeside(boardId: string | null, sessionId: string | null, nextGuest: BoardHostGuest | null = null): void {
  seatGuest(nextGuest);
  pairedSessionId = sessionId;
  if (boardId) selectBoard(boardId);
  if (boardId && guest) fitFirstGuestView(guest, boardId);
  paintPairedSession();
}

export function reopenSelectedBoard(): void {
  paintList();
  reviewRequestKey = null;
  renderer?.resendView();
  resendTilesView();
  paintBoard();
}

let boardsScreen: HTMLElement | null = null;

function mountBoardsScreen(panel: HTMLElement): void {
  boardsScreen = panel;
  panel.replaceChildren(mountBoardHost());
}

function refreshBoardsScreen(reason: ViewRefreshReason): void {
  const host = mountBoardHost();
  if (boardsScreen && host.parentElement !== boardsScreen) boardsScreen.replaceChildren(host);
  placeBoardTitle(null);
  const request = takeOpenBoardRequest();
  const sessionBoardId = reason === 'shown' ? newestBoardConnectedTo(getPhoneSessionId()) : null;
  showBoardBeside(request?.boardId ?? sessionBoardId, null);
  reopenSelectedBoard();
}

function newestBoardConnectedTo(sessionId: string | null): string | null {
  if (!sessionId) return null;
  return boardsConnectedTo(sessionId)[0]?.id ?? null;
}

export const view: ViewModule<HTMLElement> = { mount: mountBoardsScreen, refresh: refreshBoardsScreen };
