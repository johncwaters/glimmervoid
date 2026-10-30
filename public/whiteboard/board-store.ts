import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { Board, BoardSummary, Op } from '#shared/contracts/whiteboard.ts';
import { applyOps } from '#shared/whiteboard-ops-core.ts';
import { sendControlRequest } from '../control-ws.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from '../action-status.ts';

type BoardCommandOutcome = { ok: true; reply: ServerMessageOf<'whiteboard-result'> } | { ok: false; error: string };
type BoardListener = (boardId: string) => void;

const openBoardsById = new Map<string, Board>();
const pendingFetchByBoardId = new Map<string, Promise<void>>();
const listListeners: (() => void)[] = [];
const boardListeners: BoardListener[] = [];
let boardSummaries: BoardSummary[] = [];

function notifyList(): void {
  for (const listener of [...listListeners]) listener();
}

function notifyBoard(boardId: string): void {
  for (const listener of boardListeners) listener(boardId);
}

function isWhiteboardResult(message: ServerMessage): message is ServerMessageOf<'whiteboard-result'> {
  return message.type === 'whiteboard-result';
}

async function runBoardCommand(type: string, payload: Record<string, unknown>): Promise<BoardCommandOutcome> {
  try {
    const reply = await sendControlRequest(type, payload, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (!isWhiteboardResult(reply)) return { ok: false, error: 'The server answered with something other than a whiteboard reply.' };
    if (!reply.ok) return { ok: false, error: reply.error ?? 'The server refused the change.' };
    return { ok: true, reply };
  } catch (reason) {
    return { ok: false, error: requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS) };
  }
}

function fetchBoard(boardId: string): Promise<void> {
  const pending = pendingFetchByBoardId.get(boardId);
  if (pending) return pending;
  const started = runBoardCommand('whiteboard-get', { boardId }).then((outcome) => {
    pendingFetchByBoardId.delete(boardId);
    if (!outcome.ok || !outcome.reply.board) return;
    openBoardsById.set(boardId, outcome.reply.board);
    notifyBoard(boardId);
  });
  pendingFetchByBoardId.set(boardId, started);
  return started;
}

export function boardSummariesOf(): readonly BoardSummary[] {
  return boardSummaries;
}

export function openBoardOf(boardId: string): Board | null {
  return openBoardsById.get(boardId) ?? null;
}

export function openBoard(boardId: string): Promise<void> {
  if (openBoardsById.has(boardId)) return Promise.resolve();
  return fetchBoard(boardId);
}

export function onBoardListChanged(listener: () => void): () => void {
  listListeners.push(listener);
  return () => {
    const index = listListeners.indexOf(listener);
    if (index >= 0) listListeners.splice(index, 1);
  };
}

export function onBoardChanged(listener: BoardListener): void {
  boardListeners.push(listener);
}

export function applyWhiteboardsSnapshot(message: ServerMessageOf<'whiteboards-snapshot'>): void {
  boardSummaries = [...message.boards].sort((left, right) => right.updatedAt - left.updatedAt);
  const versionByBoardId = new Map(boardSummaries.map((summary) => [summary.id, summary.version]));
  for (const [boardId, board] of [...openBoardsById]) {
    const knownVersion = versionByBoardId.get(boardId);
    if (knownVersion === board.version) continue;
    openBoardsById.delete(boardId);
    if (knownVersion !== undefined) {
      void fetchBoard(boardId);
      continue;
    }
    notifyBoard(boardId);
  }
  notifyList();
}

export function applyWhiteboardPatch(message: ServerMessageOf<'whiteboard-patch'>): void {
  const board = openBoardsById.get(message.boardId);
  if (!board || board.version >= message.toVersion) return;
  if (board.version !== message.fromVersion) {
    openBoardsById.delete(message.boardId);
    void fetchBoard(message.boardId);
    return;
  }
  const result = applyOps(board, message.ops, message.author, message.updatedAt);
  if (!result.ok || result.board.version !== message.toVersion) {
    openBoardsById.delete(message.boardId);
    void fetchBoard(message.boardId);
    return;
  }
  openBoardsById.set(message.boardId, result.board);
  notifyBoard(message.boardId);
}

export function applyWhiteboardRemoved(message: ServerMessageOf<'whiteboard-removed'>): void {
  openBoardsById.delete(message.boardId);
  boardSummaries = boardSummaries.filter((summary) => summary.id !== message.boardId);
  notifyBoard(message.boardId);
  notifyList();
}

export async function createBoard(title: string): Promise<{ ok: true; boardId: string } | { ok: false; error: string }> {
  const outcome = await runBoardCommand('whiteboard-create', { title });
  if (!outcome.ok) return outcome;
  const boardId = outcome.reply.summary?.id;
  if (!boardId) return { ok: false, error: 'The server created no board.' };
  return { ok: true, boardId };
}

export async function sendBoardOps(boardId: string, ops: readonly Op[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const outcome = await runBoardCommand('whiteboard-op', { boardId, ops });
  return outcome.ok ? { ok: true } : outcome;
}

export async function deleteBoard(boardId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const outcome = await runBoardCommand('whiteboard-delete', { boardId });
  return outcome.ok ? { ok: true } : outcome;
}

export async function connectSessionToBoard(boardId: string, sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const outcome = await runBoardCommand('whiteboard-connect', { boardId, sessionId });
  return outcome.ok ? { ok: true } : outcome;
}

export async function disconnectSessionFromBoard(boardId: string, sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const outcome = await runBoardCommand('whiteboard-disconnect', { boardId, sessionId });
  return outcome.ok ? { ok: true } : outcome;
}

export function boardsConnectedTo(sessionId: string): readonly BoardSummary[] {
  return boardSummaries.filter((summary) => summary.connectedSessionIds.includes(sessionId));
}

let pendingOpenRequest: { boardId: string; dockSessionId: string | null } | null = null;

export function requestOpenBoard(boardId: string, dockSessionId: string | null): void {
  pendingOpenRequest = { boardId, dockSessionId };
}

export function takeOpenBoardRequest(): { boardId: string; dockSessionId: string | null } | null {
  const request = pendingOpenRequest;
  pendingOpenRequest = null;
  return request;
}
