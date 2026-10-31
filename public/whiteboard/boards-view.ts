import './whiteboard.css';
import type { Board, BoardSummary, Element, Op } from '#shared/contracts/whiteboard.ts';
import { WHITEBOARD_LIMITS } from '#shared/contracts/whiteboard.ts';
import { createActionStatus } from '../action-status.ts';
import { borrowCard, getBorrowedCardId, releaseCard } from '../card-host.ts';
import { el } from '../dom-helpers.ts';
import { findSessionUi, sessionName } from '../session-card/card-registry.ts';
import { buildDialogShell, openConfirmDialog } from '../session-card/modal.ts';
import { setTerminalActiveViewer } from '../session-card/terminal.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { createBoardEditor, newElementId } from './board-edit.ts';
import type { BoardEditor, BoardTool } from './board-edit.ts';
import { EMPTY_HISTORY, inverseOps, recordEdit, recordStep, takeStep } from '#shared/whiteboard-undo-core.ts';
import type { UndoDirection, UndoHistory } from '#shared/whiteboard-undo-core.ts';
import { createBoardRenderer } from './board-render.ts';
import type { BoardRenderer } from './board-render.ts';
import {
  boardSummariesOf, createBoard, deleteBoard, nudgeSessionAboutBoard, onBoardChanged, onBoardListChanged, openBoard, openBoardOf, sendBoardOps, takeOpenBoardRequest,
} from './board-store.ts';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EMPTY_TEXT = 'No boards yet. Make one here, or have an agent run glimmervoid whiteboard new <title>.';
const PICK_TEXT = 'Pick a board above.';
const TOOL_BUTTONS: readonly { tool: BoardTool; label: string; key: string }[] = [
  { tool: 'select', label: 'select', key: 'V' },
  { tool: 'box', label: 'box', key: 'R' },
  { tool: 'decision', label: 'decision', key: 'D' },
  { tool: 'panel', label: 'panel', key: 'P' },
  { tool: 'wire', label: 'wire', key: 'A' },
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
  list: HTMLElement;
  boardHead: HTMLElement;
  boardMeta: HTMLElement;
  presence: HTMLElement;
  toolbar: HTMLElement;
  canvas: HTMLElement;
  empty: HTMLElement;
  dock: HTMLElement;
  dockQueued: HTMLElement;
  sendToAgent: HTMLButtonElement;
  buttons: Record<'note' | 'frame' | 'unit' | 'fit' | 'remove', HTMLButtonElement>;
  toolButtons: ReadonlyMap<BoardTool, HTMLButtonElement>;
}

let selectedBoardId: string | null = null;
let parts: BoardsViewParts | null = null;
let renderer: BoardRenderer | null = null;
let editor: BoardEditor | null = null;
let shouldFitOnNextRender = true;
let dockedSessionId: string | null = null;
const status = createActionStatus('action-status wb-status');
const dockStatus = createActionStatus('action-status wb-status');
const historyByBoardId = new Map<string, UndoHistory>();

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
  const btnConfirm = el('button', 'btn-dialog btn-dialog-confirm', options.confirmLabel);
  btnConfirm.type = 'button';
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

async function sendRecordedOps(boardId: string, ops: Op[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const before = selectedBoard();
  const outcome = await sendBoardOps(boardId, ops);
  if (outcome.ok && before?.id === boardId) historyByBoardId.set(boardId, recordEdit(historyByBoardId.get(boardId) ?? EMPTY_HISTORY, inverseOps(before, ops)));
  return outcome;
}

async function stepHistory(direction: UndoDirection): Promise<void> {
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
  const selectedCount = editor?.selectedIds().size ?? 0;
  for (const button of parts.toolButtons.values()) button.disabled = !board;
  parts.buttons.note.disabled = selectedBoxCount !== 1;
  parts.buttons.frame.disabled = selectedBoxCount === 0;
  parts.buttons.unit.disabled = !board;
  parts.buttons.fit.disabled = !board;
  parts.buttons.remove.disabled = !board;
  parts.toolbar.dataset.selectedCount = String(selectedCount);
}

function paintList(): void {
  if (!parts) return;
  const summaries = boardSummariesOf();
  if (selectedBoardId && !summaries.some((summary) => summary.id === selectedBoardId)) selectedBoardId = null;
  if (!selectedBoardId && summaries[0]) selectBoard(summaries[0].id);
  parts.list.replaceChildren(...summaries.map((summary) => {
    const button = el('button', 'wb-board-tab', summary.title);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(summary.id === selectedBoardId));
    if (summary.connectedSessionIds.length > 0) button.append(el('span', 'wb-board-tab-count', String(summary.connectedSessionIds.length)));
    button.addEventListener('click', () => selectBoard(summary.id));
    return button;
  }));
  paintHead();
}

function paintHead(): void {
  if (!parts) return;
  const summary = selectedSummary();
  const hasBoards = boardSummariesOf().length > 0;
  parts.boardHead.hidden = !summary;
  parts.canvas.hidden = !summary;
  parts.empty.hidden = Boolean(summary);
  parts.empty.textContent = hasBoards ? PICK_TEXT : EMPTY_TEXT;
  if (!summary) return;
  parts.boardMeta.textContent = `v${summary.version}`;
  parts.presence.replaceChildren(...summary.connectedSessionIds.map((sessionId) => el('span', 'wb-presence-pill', sessionLabel(sessionId))));
  if (summary.connectedSessionIds.length === 0) parts.presence.append(el('span', 'wb-presence-none', 'no sessions connected'));
  paintToolbar();
  paintDock();
}

function dockQueuedText(summary: BoardSummary | null, sessionId: string): string {
  const name = sessionLabel(sessionId);
  if (!summary?.connectedSessionIds.includes(sessionId)) return `${name} is not connected to this board`;
  const queuedCount = summary.queuedBySessionId[sessionId] ?? 0;
  if (queuedCount === 0) return `${name} has read every change`;
  return `${queuedCount} board ${queuedCount === 1 ? 'edit' : 'edits'} queued for ${name}`;
}

function paintDock(): void {
  if (!parts || !dockedSessionId) return;
  const summary = selectedSummary();
  parts.dockQueued.textContent = dockQueuedText(summary, dockedSessionId);
  parts.sendToAgent.disabled = !summary?.connectedSessionIds.includes(dockedSessionId);
}

async function sendBoardNudge(): Promise<void> {
  if (!parts || !selectedBoardId || !dockedSessionId) return;
  parts.sendToAgent.disabled = true;
  dockStatus.show('busy', 'sending');
  const outcome = await nudgeSessionAboutBoard(selectedBoardId, dockedSessionId);
  paintDock();
  if (!outcome.ok) {
    dockStatus.show('error', outcome.error);
    return;
  }
  dockStatus.show('ok', 'sent; the agent reads the board when it is ready');
}

function paintBoard(): void {
  if (!renderer) return;
  const board = selectedBoard();
  if (!board) {
    renderer.clear();
    return;
  }
  editor?.pruneSelection(board);
  renderer.render(editor?.previewOf(board) ?? board);
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
    onSubmit: (title, linkedBoardId) => sendOpsFromDialog([{ op: 'add', element: { kind: 'unit', id: newElementId('unit'), title, lines: [], after: [], linkedBoardId: linkedBoardId || null } }]),
  });
}

function addNoteOn(boxId: string): void {
  openTextDialog({
    title: 'Pin a note',
    label: 'Note',
    placeholder: 'what about retries?',
    maxLength: WHITEBOARD_LIMITS.noteText,
    confirmLabel: 'Pin note',
    onSubmit: (text) => sendOpsFromDialog([{ op: 'add', element: { kind: 'note', id: newElementId('note'), on: boxId, text, author: '', resolvedBy: null } }]),
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
  openTextDialog({
    title: 'New board',
    label: 'Board title',
    placeholder: 'knowledge writer',
    maxLength: WHITEBOARD_LIMITS.title,
    confirmLabel: 'Create board',
    onSubmit: async (title) => {
      const outcome = await createBoard(title);
      if (!outcome.ok) return outcome.error;
      selectBoard(outcome.boardId);
      return null;
    },
  });
}

function toolbarButton(label: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
  const button = el('button', `wb-button ${extraClass}`.trim(), label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function toolButton(tool: BoardTool, label: string, key: string): HTMLButtonElement {
  const button = toolbarButton(label, () => {
    editor?.setTool(tool);
    editor?.focusCanvas();
  }, 'wb-tool');
  const keyHint = el('span', 'wb-tool-key', key);
  keyHint.setAttribute('aria-hidden', 'true');
  button.prepend(keyHint);
  button.setAttribute('aria-pressed', String(tool === 'select'));
  button.setAttribute('aria-keyshortcuts', key);
  return button;
}

function paintActiveTool(activeTool: BoardTool): void {
  for (const [tool, button] of parts?.toolButtons ?? []) button.setAttribute('aria-pressed', String(tool === activeTool));
}

function mountBoardsView(panel: HTMLElement): void {
  const top = el('div', 'wb-top');
  const list = el('div', 'wb-board-list');
  list.setAttribute('aria-label', 'Boards');

  const boardHead = el('div', 'wb-board-head');
  const titleRow = el('div', 'wb-title-row');
  const boardMeta = el('span', 'wb-board-meta');
  const presence = el('div', 'wb-presence');
  titleRow.append(boardMeta, presence);
  const toolbar = el('div', 'wb-toolbar');
  const toolButtons = new Map(TOOL_BUTTONS.map(({ tool, label, key }) => [tool, toolButton(tool, label, key)]));
  const toolGroup = el('div', 'wb-tools');
  toolGroup.setAttribute('role', 'group');
  toolGroup.setAttribute('aria-label', 'Drawing tools');
  toolGroup.append(...toolButtons.values());
  const buttons = {
    note: toolbarButton('note', () => {
      const [box] = selectedElementsOfKind('box');
      if (box) addNoteOn(box.id);
    }),
    frame: toolbarButton('frame', addFrame),
    unit: toolbarButton('unit', addUnitFromDialog),
    fit: toolbarButton('fit', () => editor?.fit()),
    remove: toolbarButton('delete board', confirmDeleteBoard, 'wb-button-danger'),
  };
  buttons.fit.dataset.phoneVisible = '';
  toolbar.append(toolGroup, buttons.note, buttons.frame, buttons.unit, buttons.fit, buttons.remove, status.element);
  boardHead.append(titleRow, toolbar);
  top.append(list, toolbarButton('new board', newBoardFromDialog), boardHead);

  const canvas = el('div', 'wb-canvas');
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'wb-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Whiteboard');
  svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
  canvas.append(svg);
  const empty = el('p', 'wb-empty', EMPTY_TEXT);
  const dock = el('div', 'wb-dock');
  dock.hidden = true;
  const dockQueued = el('span', 'wb-dock-queued');
  const sendToAgent = toolbarButton('send to agent', () => void sendBoardNudge());
  const dockBar = el('div', 'wb-dock-bar');
  dockBar.append(dockQueued, sendToAgent, dockStatus.element);
  dock.append(dockBar);

  panel.replaceChildren(top, canvas, empty, dock);
  parts = { list, boardHead, boardMeta, presence, toolbar, canvas, empty, dock, dockQueued, sendToAgent, buttons, toolButtons };
  const boardRenderer = createBoardRenderer(svg);
  renderer = boardRenderer;
  editor = createBoardEditor({
    svg,
    canvas,
    renderer: boardRenderer,
    currentBoard: selectedBoard,
    sendOps,
    onSelectionChange: paintToolbar,
    onPhoneTapBox: addNoteOn,
    onOpenLinkedBoard: selectBoard,
    onConnectBoxes: connectBoxes,
    onToolChange: paintActiveTool,
    onHistoryStep: (direction) => void stepHistory(direction),
  });

  onBoardListChanged(paintList);
  onBoardChanged((boardId) => {
    if (boardId !== selectedBoardId) return;
    paintBoard();
  });
  paintList();
}

function isPhoneLayout(): boolean {
  return document.documentElement.dataset.layout === 'phone';
}

function undockSession(): void {
  if (dockedSessionId && getBorrowedCardId() === dockedSessionId) releaseCard();
  dockedSessionId = null;
  if (parts) parts.dock.hidden = true;
}

function dockSession(sessionId: string): void {
  if (!parts || isPhoneLayout()) return;
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  dockedSessionId = sessionId;
  parts.dock.hidden = false;
  dockStatus.clear();
  paintDock();
  borrowCard(ui, sessionId, parts.dock, { className: 'wb-docked-card' });
  setTerminalActiveViewer(ui, sessionId, true);
}

function refreshBoardsView(): void {
  const request = takeOpenBoardRequest();
  if (request) {
    selectBoard(request.boardId);
    if (request.dockSessionId) dockSession(request.dockSessionId);
  }
  paintList();
  if (selectedBoardId) void openBoard(selectedBoardId).then(paintBoard);
}

export const view: ViewModule<HTMLElement> = { mount: mountBoardsView, refresh: refreshBoardsView, deactivate: undockSession };
