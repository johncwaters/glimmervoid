import type { BoardSummary } from '#shared/contracts/whiteboard.ts';
import { repaintSessionRowSignals } from '../session-row.ts';
import type { ActivatableSignal } from '../signal.ts';
import { tierForTone } from '../signal-core.ts';
import type { AgentChange } from '#shared/contracts/control/whiteboard-messages.ts';
import { boardsConnectedTo, onBoardListChanged, requestBoardFocus, requestOpenBoard } from './board-store.ts';

let openBoardsView: () => void = () => {};

export function setBoardsViewOpener(open: () => void): void {
  openBoardsView = open;
}

function openBoardForSession(boardId: string, sessionId: string | null): void {
  requestOpenBoard(boardId, sessionId);
  openBoardsView();
}

export function openBoardAtAgentChange(boardId: string, sessionId: string, change: AgentChange): void {
  requestBoardFocus({ boardId, change });
  openBoardForSession(boardId, sessionId);
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
    look: { icon: 'board', tone },
    tier: tierForTone(tone),
    className: 'session-pr-chip session-board-chip',
    ariaLabel: `Open board ${summary.title}`,
    onActivate: () => openBoardForSession(summary.id, sessionId),
  };
}

export function sessionRowBoardSignals(sessionId: string): ActivatableSignal[] {
  return boardsConnectedTo(sessionId).map((summary) => boardSignal(summary, sessionId, summary.title));
}

onBoardListChanged(repaintSessionRowSignals);
