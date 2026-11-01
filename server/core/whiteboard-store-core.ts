import { WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoardChange, BoardRecord, BoardSummary } from '../../shared/contracts/whiteboard.ts';
import type { ApplyResult } from '../../shared/whiteboard-ops-core.ts';
import type { AgentNote } from '../../shared/contracts/hooks.ts';

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

function markRead(record: BoardRecord, sessionId: string, throughVersion: number = record.board.version): BoardRecord {
  const cursor = record.cursorBySessionId[sessionId];
  if (cursor === undefined || cursor >= throughVersion) return record;
  return pruneLog({ ...record, cursorBySessionId: { ...record.cursorBySessionId, [sessionId]: throughVersion } });
}

function summarizeBoard(record: BoardRecord): BoardSummary {
  const { id, title, version, updatedAt } = record.board;
  const sessionIds = Object.keys(record.cursorBySessionId);
  const queuedBySessionId = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, changesForReader(record, sessionId).length]));
  return { id, title, version, updatedAt, connectedSessionIds: sessionIds, queuedBySessionId };
}

interface PromptContext {
  text: string;
  readThrough: { boardId: string; version: number }[];
}

interface PromptContextDraft {
  lines: string[];
  characterCount: number;
}

function hasRoomFor(draft: PromptContextDraft, addedLines: readonly string[]): boolean {
  const addedCharacters = addedLines.reduce((total, line) => total + line.length + 1, 0);
  return draft.lines.length + addedLines.length <= WHITEBOARD_LIMITS.promptContextLines
    && draft.characterCount + addedCharacters <= WHITEBOARD_LIMITS.promptContextCharacters;
}

function appendLines(draft: PromptContextDraft, addedLines: readonly string[]): void {
  for (const line of addedLines) {
    draft.lines.push(line);
    draft.characterCount += line.length + 1;
  }
}

function summaryLineOf(change: BoardChange): string {
  const line = `- ${change.summary}`;
  if (line.length <= WHITEBOARD_LIMITS.promptContextLineCharacters) return line;
  return `${line.slice(0, WHITEBOARD_LIMITS.promptContextLineCharacters - 3)}...`;
}

function boardChangesHeader({ title, id }: Pick<Board, 'title' | 'id'>): string {
  return `Board "${title}" (${id}) changed since your last read:`;
}

const BOARD_CONTEXT_NOTE: AgentNote = {
  name: 'Board changes',
  carriedBy: 'UserPromptSubmit',
  firesWhen: 'a board the session is connected to changed since its last read',
  text: `${boardChangesHeader({ title: '<title>', id: '<board id>' })} <one line per change>`,
  isTemplate: true,
};

function appendBoardChanges(draft: PromptContextDraft, board: Board, changes: readonly BoardChange[]): boolean {
  const header = boardChangesHeader(board);
  const pointer = `run glimmervoid whiteboard get ${board.id} for the rest`;
  if (!hasRoomFor(draft, [header, pointer])) {
    const brief = `Board "${board.title}" (${board.id}) has ${changes.length} unread changes: run glimmervoid whiteboard get ${board.id}`;
    if (hasRoomFor(draft, [brief])) appendLines(draft, [brief]);
    return false;
  }
  appendLines(draft, [header]);
  let isComplete = true;
  for (const [index, change] of changes.entries()) {
    const line = summaryLineOf(change);
    const isClipped = line !== `- ${change.summary}`;
    const needsPointerRoom = index < changes.length - 1 || isClipped;
    if (!hasRoomFor(draft, needsPointerRoom ? [line, pointer] : [line])) {
      isComplete = false;
      break;
    }
    appendLines(draft, [line]);
    if (isClipped) isComplete = false;
  }
  if (!isComplete) appendLines(draft, [pointer]);
  return isComplete;
}

function promptContextFor(records: readonly BoardRecord[], sessionId: string): PromptContext | null {
  const draft: PromptContextDraft = { lines: [], characterCount: 0 };
  const readThrough: PromptContext['readThrough'] = [];
  for (const record of records) {
    const changes = changesForReader(record, sessionId);
    if (changes.length === 0) continue;
    if (appendBoardChanges(draft, record.board, changes)) readThrough.push({ boardId: record.board.id, version: record.board.version });
  }
  if (draft.lines.length === 0) return null;
  return { text: draft.lines.join('\n'), readThrough };
}

function nudgeLineFor(board: Board): string {
  return `The operator changed board "${board.title}"; run glimmervoid whiteboard get ${board.id}`;
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

export { BOARD_CONTEXT_NOTE, changesForReader, connectSession, disconnectSession, markRead, nudgeLineFor, promptContextFor, recordPut, resolveBoardRef, summarizeBoard };
