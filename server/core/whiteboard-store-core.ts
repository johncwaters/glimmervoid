import { WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoardChange, BoardRecord, BoardSummary } from '../../shared/contracts/whiteboard.ts';
import type { ApplyResult } from '../../shared/whiteboard-ops-core.ts';

function lowestCursor(record: BoardRecord): number {
  const cursors = Object.values(record.cursorBySessionId);
  return cursors.length === 0 ? record.board.version : Math.min(...cursors);
}

function pruneLog(record: BoardRecord): BoardRecord {
  const oldestUnread = lowestCursor(record);
  const unread = record.log.filter((change) => change.version > oldestUnread);
  return { ...record, log: unread.slice(-WHITEBOARD_LIMITS.logEntries) };
}

function recordPut(record: BoardRecord, result: Extract<ApplyResult, { ok: true }>): BoardRecord {
  return pruneLog({ ...record, board: result.board, log: [...record.log, ...result.changes] });
}

function connectSession(record: BoardRecord, sessionId: string): BoardRecord {
  if (sessionId in record.cursorBySessionId) return record;
  return { ...record, cursorBySessionId: { ...record.cursorBySessionId, [sessionId]: record.board.version } };
}

function disconnectSession(record: BoardRecord, sessionId: string): BoardRecord {
  const { [sessionId]: _dropped, ...remaining } = record.cursorBySessionId;
  return pruneLog({ ...record, cursorBySessionId: remaining });
}

function changesForReader(record: BoardRecord, sessionId: string): BoardChange[] {
  const cursor = record.cursorBySessionId[sessionId];
  if (cursor === undefined) return [];
  const unread = record.log.filter((change) => change.version > cursor && change.author !== sessionId);
  const mergedByElementId = new Map<string, { newest: BoardChange; summaries: Set<string> }>();
  for (const change of unread) {
    if (change.elementId === null) continue;
    const summaries = mergedByElementId.get(change.elementId)?.summaries ?? new Set<string>();
    mergedByElementId.set(change.elementId, { newest: change, summaries: summaries.add(change.summary) });
  }
  return unread.flatMap((change) => {
    if (change.elementId === null) return [change];
    const merged = mergedByElementId.get(change.elementId);
    if (!merged || merged.newest !== change) return [];
    return [{ ...change, summary: [...merged.summaries].join('; ') }];
  });
}

function markRead(record: BoardRecord, sessionId: string): BoardRecord {
  if (!(sessionId in record.cursorBySessionId)) return record;
  return pruneLog({ ...record, cursorBySessionId: { ...record.cursorBySessionId, [sessionId]: record.board.version } });
}

function summarizeBoard(record: BoardRecord): BoardSummary {
  const { id, title, version, updatedAt } = record.board;
  return { id, title, version, updatedAt, connectedSessionIds: Object.keys(record.cursorBySessionId) };
}

function resolveBoardRef(boards: readonly Board[], ref: string): Board | { error: string } {
  const byId = boards.find((board) => board.id === ref);
  if (byId) return byId;
  const wantedTitle = ref.trim().toLowerCase();
  const byTitle = boards.filter((board) => board.title.toLowerCase() === wantedTitle);
  if (byTitle.length === 1 && byTitle[0]) return byTitle[0];
  if (byTitle.length > 1) return { error: `${byTitle.length} boards are titled "${ref}", so name it by id: ${byTitle.map((board) => board.id).join(', ')}` };
  return { error: `no board is called ${ref}, so run glimmervoid whiteboard list to see the boards` };
}

export { changesForReader, connectSession, disconnectSession, markRead, recordPut, resolveBoardRef, summarizeBoard };
