import type { BoardSummary } from '#shared/contracts/whiteboard.ts';
import { createActionStatus } from '../action-status.ts';
import { el } from '../dom-helpers.ts';
import { buildDialogShell, openConfirmDialog } from '../session-card/modal.ts';
import { repaintSessionRowSignals } from '../session-row.ts';
import { createSignal, paintSignalLine } from '../signal.ts';
import type { ActivatableSignal } from '../signal.ts';
import { tierForTone } from '../signal-core.ts';
import { CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import {
  boardSummariesOf, boardsConnectedTo, connectSessionToBoard, disconnectSessionFromBoard, onBoardListChanged, requestOpenBoard,
} from './board-store.ts';

let openBoardsView: () => void = () => {};

export function setBoardsViewOpener(open: () => void): void {
  openBoardsView = open;
}

function openBoardForSession(boardId: string, sessionId: string | null): void {
  requestOpenBoard(boardId, sessionId);
  openBoardsView();
}

function queuedEditsText(summary: BoardSummary, sessionId: string): string {
  const queuedCount = summary.queuedBySessionId[sessionId] ?? 0;
  if (queuedCount === 0) return '';
  return `${queuedCount} queued`;
}

function boardSignal(summary: BoardSummary, sessionId: string, text: string): ActivatableSignal {
  const queuedText = queuedEditsText(summary, sessionId);
  const tone = queuedText ? 'wait' : 'muted';
  return {
    key: `board:${summary.id}`,
    text,
    detailText: summary.title,
    stateText: queuedText,
    hoverText: `${summary.title}${queuedText ? `, ${queuedText}` : ''}. Open it with this session docked beside it`,
    look: { icon: 'board', tone },
    tier: tierForTone(tone),
    className: 'session-pr-chip session-board-chip',
    ariaLabel: `Open board ${summary.title}`,
    onActivate: () => openBoardForSession(summary.id, sessionId),
  };
}

function titledBoardSignal(summary: BoardSummary, sessionId: string): ActivatableSignal {
  const queuedText = queuedEditsText(summary, sessionId);
  return boardSignal(summary, sessionId, queuedText ? `${summary.title}, ${queuedText}` : summary.title);
}

export function sessionRowBoardSignals(sessionId: string): ActivatableSignal[] {
  return boardsConnectedTo(sessionId).map((summary) => boardSignal(summary, sessionId, summary.title));
}

function createUnlinkableBoardChip(summary: BoardSummary, sessionId: string, onUnlinked: (error: string | null) => void): HTMLElement {
  const signal = titledBoardSignal(summary, sessionId);
  const unlinkButton = el('button', 'session-pr-chip-unlink');
  unlinkButton.append(createLineIcon(CLOSE_ICON_PATH));
  unlinkButton.type = 'button';
  unlinkButton.title = `Disconnect ${summary.title} from this session`;
  unlinkButton.setAttribute('aria-label', `Disconnect board ${summary.title}`);
  unlinkButton.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    openConfirmDialog({
      title: 'Disconnect board',
      message: `Disconnect ${summary.title} from this session? It stops getting summaries of changes to the board until it connects again.`,
      confirmLabel: 'Disconnect',
      danger: true,
      onConfirm: () => {
        void disconnectSessionFromBoard(summary.id, sessionId).then((outcome) => onUnlinked(outcome.ok ? null : outcome.error));
      },
    });
  });
  const chipItem = el('span', 'session-pr-chip-item');
  chipItem.append(createSignal(signal, signal), unlinkButton);
  return chipItem;
}

export function openConnectBoardDialog(sessionId: string): void {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: 'Connect board' });
  const connectedChips = el('div', 'session-pr-chips dialog-linked-prs');
  const hint = el('p', 'dialog-message', 'A connected session is told what others changed on the board with its next whiteboard get or prompt.');
  const select = el('select', 'dialog-input');
  select.setAttribute('aria-label', 'Board to connect');
  const status = createActionStatus('action-status');
  const btnConnect = el('button', 'btn-dialog btn-dialog-confirm', 'Connect');
  btnConnect.type = 'button';
  actions.append(btnConnect);
  dialog.append(connectedChips, hint, select, status.element, actions);

  function showError(error: string | null): void {
    if (error) status.show('error', error);
  }

  function paint(): void {
    const connected = boardsConnectedTo(sessionId);
    paintSignalLine(connectedChips, connected.map((summary) => titledBoardSignal(summary, sessionId)), (signal) => {
      const summary = connected.find((candidate) => `board:${candidate.id}` === signal.key);
      return summary ? createUnlinkableBoardChip(summary, sessionId, showError) : createSignal(signal, signal);
    });
    const connectable = boardSummariesOf().filter((summary) => !summary.connectedSessionIds.includes(sessionId));
    select.replaceChildren(...connectable.map((summary) => {
      const option = el('option', null, summary.title);
      option.value = summary.id;
      return option;
    }));
    if (connectable.length === 0) select.append(el('option', null, 'No other boards to connect'));
    select.disabled = connectable.length === 0;
    btnConnect.disabled = connectable.length === 0;
  }

  btnConnect.addEventListener('click', () => {
    const boardId = select.value;
    if (!boardId) return;
    btnConnect.disabled = true;
    void connectSessionToBoard(boardId, sessionId).then((outcome) => {
      if (!outcome.ok) {
        status.show('error', outcome.error);
        paint();
        return;
      }
      close();
    });
  });
  btnCancel.addEventListener('click', close);
  const stopWatchingBoards = onBoardListChanged(() => {
    if (!dialog.isConnected) {
      stopWatchingBoards();
      return;
    }
    paint();
  });
  paint();
}

onBoardListChanged(repaintSessionRowSignals);
