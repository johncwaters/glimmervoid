import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { WhiteboardPatch } from '#shared/contracts/control/whiteboard-messages.ts';
import type { BoardReview, BoardSummary, BoxMedia, Op } from '#shared/contracts/whiteboard.ts';
import { BoardMediaUploadReply, WHITEBOARD_ASSET_ROUTE } from '#shared/contracts/whiteboard.ts';
import { sendControlRequest } from '../control-ws.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from '../action-status.ts';

type BoardCommandOutcome = { ok: true; reply: ServerMessageOf<'whiteboard-result'> } | { ok: false; error: string };
type BoardListener = (boardId: string) => void;

const listListeners: (() => void)[] = [];
const boardListeners: BoardListener[] = [];
let boardSummaries: BoardSummary[] = [];
let boardsBySessionId = new Map<string, BoardSummary[]>();

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

export function boardSummariesOf(): readonly BoardSummary[] {
  return boardSummaries;
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

function indexBoardsBySession(): void {
  const index = new Map<string, BoardSummary[]>();
  for (const summary of boardSummaries) {
    for (const sessionId of summary.connectedSessionIds) {
      const sessionBoards = index.get(sessionId);
      if (sessionBoards) {
        sessionBoards.push(summary);
        continue;
      }
      index.set(sessionId, [summary]);
    }
  }
  boardsBySessionId = index;
}

export function applyWhiteboardsSnapshot(message: ServerMessageOf<'whiteboards-snapshot'>): void {
  boardSummaries = [...message.boards].sort((left, right) => right.updatedAt - left.updatedAt);
  indexBoardsBySession();
  notifyList();
}

export function applyWhiteboardRemoved(message: ServerMessageOf<'whiteboard-removed'>): void {
  boardSummaries = boardSummaries.filter((summary) => summary.id !== message.boardId);
  indexBoardsBySession();
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

export async function sendBoardOps(boardId: string, ops: readonly Op[]): Promise<{ ok: true; patch: WhiteboardPatch | null } | { ok: false; error: string }> {
  const outcome = await runBoardCommand('whiteboard-op', { boardId, ops });
  return outcome.ok ? { ok: true, patch: outcome.reply.patch ?? null } : outcome;
}

export async function uploadBoardMedia(file: File): Promise<{ ok: true; media: BoxMedia } | { ok: false; error: string }> {
  const headers: Record<string, string> = { 'x-glimmervoid-upload-name': encodeURIComponent(file.name) };
  if (file.type) headers['content-type'] = file.type;
  const response = await fetch(WHITEBOARD_ASSET_ROUTE, { method: 'POST', body: file, headers }).catch(() => null);
  if (!response) return { ok: false, error: `${file.name} was not added because the server did not answer` };
  const reply: unknown = await response.json().catch(() => null);
  const stored = BoardMediaUploadReply.safeParse(reply);
  if (stored.success) return { ok: true, media: stored.data.media };
  const error = reply && typeof reply === 'object' && 'error' in reply && typeof reply.error === 'string' ? reply.error : `${file.name} was not added (HTTP ${response.status})`;
  return { ok: false, error };
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

export async function detachBoardFromSession(boardId: string, sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const outcome = await runBoardCommand('whiteboard-detach', { boardId, sessionId });
  return outcome.ok ? { ok: true } : outcome;
}

export async function requestBoardReview(boardId: string): Promise<{ ok: true; review: BoardReview } | { ok: false; error: string }> {
  const outcome = await runBoardCommand('whiteboard-review', { boardId });
  if (!outcome.ok) return outcome;
  return outcome.reply.review ? { ok: true, review: outcome.reply.review } : { ok: false, error: 'Glimmervoid did not return the board review.' };
}

let openInReview: ((sessionId: string, openPath: string) => void) | null = null;

export function setOpenInReview(callback: (sessionId: string, openPath: string) => void): void {
  openInReview = callback;
}

export function openFileInReview(sessionId: string, openPath: string): void {
  openInReview?.(sessionId, openPath);
}

export function boardsConnectedTo(sessionId: string): readonly BoardSummary[] {
  return boardsBySessionId.get(sessionId) ?? [];
}

interface OpenBoardRequest {
  boardId: string;
  sessionId: string | null;
}

let pendingOpenRequest: OpenBoardRequest | null = null;

export function requestOpenBoard(boardId: string, sessionId: string | null): void {
  pendingOpenRequest = { boardId, sessionId };
}

export function takeOpenBoardRequest(): OpenBoardRequest | null {
  const request = pendingOpenRequest;
  pendingOpenRequest = null;
  return request;
}
