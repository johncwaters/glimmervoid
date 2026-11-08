import path from 'node:path';
import { Board as BoardSchema, Box, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoardChange, BoardRecord, BoardSummary, BoxMedia, Op } from '../../shared/contracts/whiteboard.ts';
import { storedPlacesOfBoxes } from '../../shared/whiteboard-layout-core.ts';
import type { Rect as BoardBounds } from '../../shared/whiteboard-layout-core.ts';
import type { ApplyResult } from '../../shared/whiteboard-ops-core.ts';
import type { AgentNote } from '../../shared/contracts/hooks.ts';
import { isRecord } from '../../shared/coerce.ts';
import { dependencyWireId } from '../../shared/whiteboard-plan-core.ts';
import { caseFoldedPathKey } from '../../shared/paths.ts';

function elementWithMediaForImage(element: unknown): unknown {
  if (!isRecord(element) || !('image' in element)) return element;
  const { image, ...elementWithoutImage } = element;
  if (!isRecord(image)) return { ...elementWithoutImage, media: null };
  return { ...elementWithoutImage, media: { kind: 'image', mime: 'image/webp', hasPreview: false, ...image } };
}

function stepBoxForUnit(unit: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'box', id: unit.id, title: unit.title, lines: unit.lines ?? [], refs: unit.refs ?? [],
    step: { status: unit.status ?? 'planned', linkedBoardId: unit.linkedBoardId ?? null },
  };
}

function boxForPanel(element: unknown): unknown {
  if (!isRecord(element) || element.kind !== 'panel') return element;
  return { kind: 'box', id: element.id, title: element.title, lines: element.lines ?? [], order: element.order ?? 0, shape: 'panel' };
}

function boxWithOutputsOnlyOnDecision(element: unknown): unknown {
  if (!isRecord(element) || element.kind !== 'box' || element.shape === 'decision' || !Array.isArray(element.outputs)) return element;
  if (element.outputs.length > 0) return { ...element, shape: 'decision' };
  const { outputs, ...elementWithoutOutputs } = element;
  return elementWithoutOutputs;
}

function elementsWithStepBoxesForUnits(elements: Record<string, unknown>): Record<string, unknown> {
  const takenIds = new Set(Object.keys(elements));
  const upgraded: Record<string, unknown> = {};
  for (const [elementId, element] of Object.entries(elements)) {
    if (!isRecord(element) || element.kind !== 'unit') {
      upgraded[elementId] = element;
      continue;
    }
    upgraded[elementId] = stepBoxForUnit(element);
    const afterIds = Array.isArray(element.after) ? element.after.filter((afterId) => typeof afterId === 'string') : [];
    for (const afterId of afterIds) {
      const wireId = dependencyWireId(afterId, elementId, takenIds);
      takenIds.add(wireId);
      upgraded[wireId] = { kind: 'wire', id: wireId, from: afterId, to: elementId };
    }
  }
  return upgraded;
}

const UPGRADE_MARGIN = 40;
const UPGRADE_COLUMN_WIDTH = 220;
const UPGRADE_COLUMN_GAP = 90;
const UPGRADE_BOX_GAP = 30;

function idsOf(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => (isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : []));
}

function isGridPlacedBox(element: unknown, columnId: string): element is Record<string, unknown> {
  return isRecord(element) && element.kind === 'box' && element.column === columnId && (element.at ?? null) === null && (element.near ?? null) === null;
}

function freePlacementByBoxId(board: Record<string, unknown>, elements: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const laneIds = idsOf(board.lanes);
  const laneRankOf = (box: Record<string, unknown>) => (typeof box.lane === 'string' ? laneIds.indexOf(box.lane) + 1 : 0);
  const orderOf = (box: Record<string, unknown>) => (typeof box.order === 'number' ? box.order : 0);
  const placementByBoxId = new Map<string, Record<string, unknown>>();
  let columnLeftEdge = UPGRADE_MARGIN;
  for (const columnId of idsOf(board.columns)) {
    const columnBoxes = Object.values(elements).filter((element) => isGridPlacedBox(element, columnId))
      .map((box, index) => ({ box, index }))
      .sort((left, right) => laneRankOf(left.box) - laneRankOf(right.box) || orderOf(left.box) - orderOf(right.box) || left.index - right.index)
      .map(({ box }) => box);
    columnBoxes.forEach((box, index) => {
      const boxAbove = columnBoxes[index - 1];
      placementByBoxId.set(String(box.id), boxAbove ? { near: { of: boxAbove.id, side: 'bottom', gap: UPGRADE_BOX_GAP } } : { at: { x: columnLeftEdge, y: UPGRADE_MARGIN } });
    });
    const widestBox = Math.max(UPGRADE_COLUMN_WIDTH, ...columnBoxes.map((box) => (typeof box.width === 'number' ? box.width : UPGRADE_COLUMN_WIDTH)));
    columnLeftEdge += widestBox + UPGRADE_COLUMN_GAP;
  }
  return placementByBoxId;
}

function withoutColumnAndLane(element: unknown, placementByBoxId: ReadonlyMap<string, Record<string, unknown>>): unknown {
  if (!isRecord(element)) return element;
  if (element.kind === 'wire' && element.tone === 'lane') return { ...element, tone: 'plain' };
  if (element.kind !== 'box') return element;
  const { column: _column, lane: _lane, ...freeBox } = element;
  return { ...freeBox, ...placementByBoxId.get(String(element.id)) };
}

function legendWithoutLaneTone(legend: unknown): unknown {
  if (!Array.isArray(legend)) return legend;
  return legend.map((entry) => (isRecord(entry) && entry.tone === 'lane' ? { ...entry, tone: 'plain' } : entry));
}

function freeCanvasBoard(board: Record<string, unknown>, elements: Record<string, unknown>): Record<string, unknown> {
  const placementByBoxId = freePlacementByBoxId(board, elements);
  const { columns: _columns, lanes: _lanes, ...freeBoard } = board;
  const freeElements = Object.fromEntries(Object.entries(elements).map(([elementId, element]) => [elementId, withoutColumnAndLane(element, placementByBoxId)]));
  return { ...freeBoard, ...('legend' in board ? { legend: legendWithoutLaneTone(board.legend) } : {}), elements: freeElements };
}

function isNearBox(element: unknown): element is Record<string, unknown> {
  return isRecord(element) && element.kind === 'box' && isRecord(element.near);
}

function pinnedNearBoxes(board: Record<string, unknown>, elements: Record<string, unknown>): Record<string, unknown> {
  if (!Object.values(elements).some(isNearBox)) return elements;
  const parsedBoard = BoardSchema.safeParse({ ...board, elements });
  if (!parsedBoard.success) return elements;
  const storedPlaceById = storedPlacesOfBoxes(parsedBoard.data);
  return Object.fromEntries(Object.entries(elements).map(([elementId, element]) => [elementId, isNearBox(element) ? { ...element, near: null, at: storedPlaceById.get(elementId) } : element]));
}

function upgradedBoardRecord(raw: unknown): unknown {
  const board = isRecord(raw) ? raw.board : null;
  if (!isRecord(raw) || !isRecord(board) || !isRecord(board.elements)) return raw;
  const elements = Object.fromEntries(Object.entries(elementsWithStepBoxesForUnits(board.elements)).map(([elementId, element]) => [elementId, boxWithOutputsOnlyOnDecision(boxForPanel(elementWithMediaForImage(element)))]));
  const freeBoard = freeCanvasBoard(board, elements);
  if (!isRecord(freeBoard.elements)) return { ...raw, board: freeBoard };
  return { ...raw, board: { ...freeBoard, elements: pinnedNearBoxes(freeBoard, freeBoard.elements) } };
}

function lowestCursor(record: BoardRecord): number {
  const cursors = Object.values(record.cursorBySessionId);
  return cursors.length === 0 ? record.board.version : Math.min(...cursors);
}

function pruneLog(record: BoardRecord): BoardRecord {
  const oldestUnread = lowestCursor(record);
  const unread = record.log.filter((change) => change.version > oldestUnread);
  return { ...record, log: unread.slice(-WHITEBOARD_LIMITS.logEntries) };
}

function recordPut(record: BoardRecord, result: Pick<Extract<ApplyResult, { ok: true }>, 'board' | 'changes'>): BoardRecord {
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
  const cursor = record.cursorBySessionId[sessionId];
  if (cursor === undefined || cursor >= record.board.version) return record;
  return pruneLog({ ...record, cursorBySessionId: { ...record.cursorBySessionId, [sessionId]: record.board.version } });
}

const ARCHIVE_AFTER_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

function isBoardArchived(record: BoardRecord, nowMs: number): boolean {
  return Object.keys(record.cursorBySessionId).length === 0 && nowMs - record.board.updatedAt > ARCHIVE_AFTER_IDLE_MS;
}

function isSameProject(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  return caseFoldedPathKey(path.resolve(left)) === caseFoldedPathKey(path.resolve(right));
}

function isFiledFor(record: BoardRecord, callerProject: string): boolean {
  return record.board.project === null || isSameProject(record.board.project, callerProject);
}

function isListedFor(record: BoardRecord, callerProject: string, nowMs: number): boolean {
  return isFiledFor(record, callerProject) && !isBoardArchived(record, nowMs);
}

function summarizeBoard(record: BoardRecord, nowMs: number): BoardSummary {
  const { id, title, version, updatedAt, project } = record.board;
  const sessionIds = Object.keys(record.cursorBySessionId);
  const queuedBySessionId = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, changesForReader(record, sessionId).length]));
  return { id, title, version, updatedAt, project, isArchived: isBoardArchived(record, nowMs), connectedSessionIds: sessionIds, queuedBySessionId };
}

interface BoardNotice {
  text: string;
  announced: { boardId: string; version: number }[];
}

function boardNoticeLineFor({ title, id }: Pick<Board, 'title' | 'id'>): string {
  return `Board "${title}" (${id}) changed since your last read. Read it with whiteboard get ${id} before you change it.`;
}

const BOARD_CONTEXT_NOTE: AgentNote = {
  name: 'Board changes',
  carriedBy: 'UserPromptSubmit',
  firesWhen: 'a board the session is connected to has a change it was not yet told about',
  text: boardNoticeLineFor({ title: '<title>', id: '<board id>' }),
  isTemplate: true,
};

function boardNoticeFor(records: readonly BoardRecord[], sessionId: string, announcedVersionByBoardId: ReadonlyMap<string, number>): BoardNotice | null {
  const announced = records.flatMap((record) => {
    const newestUnreadVersion = changesForReader(record, sessionId).at(-1)?.version;
    if (newestUnreadVersion === undefined || newestUnreadVersion <= (announcedVersionByBoardId.get(record.board.id) ?? -1)) return [];
    return [{ boardId: record.board.id, version: newestUnreadVersion, line: boardNoticeLineFor(record.board) }];
  });
  if (announced.length === 0) return null;
  return { text: announced.map((entry) => entry.line).join('\n'), announced: announced.map(({ boardId, version }) => ({ boardId, version })) };
}

const PROJECT_BOARDS_NOTICE_LIMIT = 5;

function isOwnBoard(record: BoardRecord, sessionId: string): boolean {
  return record.createdBy === sessionId || isConnectedTo(record, sessionId);
}

function projectBoardsNoticeFor(records: Iterable<BoardRecord>, caller: { sessionId: string; project: string }, nowMs: number): string | null {
  const newestBoards: Board[] = [];
  for (const record of records) {
    if (!isSameProject(record.board.project, caller.project) || isBoardArchived(record, nowMs) || isOwnBoard(record, caller.sessionId)) continue;
    newestBoards.push(record.board);
    newestBoards.sort((left, right) => right.updatedAt - left.updatedAt);
    newestBoards.length = Math.min(newestBoards.length, PROJECT_BOARDS_NOTICE_LIMIT);
  }
  if (newestBoards.length === 0) return null;
  const named = newestBoards.map((board) => `"${board.title}" (${board.id})`).join(', ');
  return `This project has whiteboards from other sessions, newest first: ${named}. Read one with whiteboard get <id>, or connect to follow its changes.`;
}

function resolveBoardRef(boards: readonly Board[], ref: string): Board | { error: string } {
  const byId = boards.find((board) => board.id === ref);
  if (byId) return byId;
  const wantedTitle = ref.trim().toLowerCase();
  const byTitle = boards.filter((board) => board.title.toLowerCase() === wantedTitle);
  if (byTitle.length === 1 && byTitle[0]) return byTitle[0];
  if (byTitle.length > 1) return { error: `${byTitle.length} boards are titled "${ref}", so name it by id: ${byTitle.map((board) => board.id).join(', ')}` };
  return { error: `no board is called ${ref}: whiteboard list names the boards, and whiteboard new creates one` };
}

const SHOWN_BOX_ID_RE = /^shown-(\d{1,9})$/;
const SHOWN_BOX_WIDTH = 480;
const SHOWN_BOX_GAP = 60;
const EMPTY_BOARD_ORIGIN = { x: 40, y: 40 };

function isConnectedTo(record: BoardRecord, sessionId: string): boolean {
  return sessionId in record.cursorBySessionId;
}

function newestBoardId(records: readonly BoardRecord[], timeOf: (record: BoardRecord) => number): string | null {
  const newest = records.reduce<BoardRecord | null>((best, record) => (best === null || timeOf(record) > timeOf(best) ? record : best), null);
  return newest?.board.id ?? null;
}

function pickShowBoardId(records: readonly BoardRecord[], sessionId: string): string | null {
  const connectedRecords = records.filter((record) => isConnectedTo(record, sessionId));
  const createdBySession = connectedRecords.filter((record) => record.createdBy === sessionId);
  return newestBoardId(createdBySession, (record) => record.board.createdAt) ?? newestBoardId(connectedRecords, (record) => record.board.updatedAt);
}

function shownBoxNumbers(board: Board): number[] {
  return [...board.elements.keys()].flatMap((elementId) => {
    const shownNumber = SHOWN_BOX_ID_RE.exec(elementId)?.[1];
    return shownNumber ? [Number(shownNumber)] : [];
  });
}

interface ShownCard {
  media: BoxMedia;
  title: string;
  caption: string | null;
}

function shownBoxOp(board: Board, contentBounds: BoardBounds, card: ShownCard): { ok: true; op: Op; boxId: string } | { ok: false; error: string } {
  const lastShownNumber = Math.max(0, ...shownBoxNumbers(board));
  const boxId = `shown-${lastShownNumber + 1}`;
  const caption = card.caption?.slice(0, WHITEBOARD_LIMITS.line) ?? null;
  const isEmptyBoard = board.elements.size === 0;
  const belowContent = { x: contentBounds.x, y: contentBounds.y + contentBounds.height + SHOWN_BOX_GAP };
  const placement = lastShownNumber > 0
    ? { near: { of: `shown-${lastShownNumber}`, side: 'right' as const, gap: SHOWN_BOX_GAP } }
    : { at: isEmptyBoard ? EMPTY_BOARD_ORIGIN : belowContent };
  const box = Box.safeParse({
    kind: 'box',
    id: boxId,
    title: card.title.slice(0, WHITEBOARD_LIMITS.title),
    lines: caption ? [{ text: caption }] : [],
    media: { ...card.media, alt: caption ?? card.title.slice(0, WHITEBOARD_LIMITS.line) },
    width: SHOWN_BOX_WIDTH,
    ...placement,
  });
  if (!box.success) return { ok: false, error: `box ${boxId} could not be built: ${box.error.issues[0]?.message ?? 'invalid box'}` };
  return { ok: true, op: { op: 'add', element: box.data }, boxId };
}

export { pickShowBoardId, shownBoxOp };
export type { ShownCard };
export { BOARD_CONTEXT_NOTE, upgradedBoardRecord, changesForReader, connectSession, disconnectSession, boardNoticeFor, isFiledFor, isListedFor, isSameProject, markRead, projectBoardsNoticeFor, recordPut, resolveBoardRef, summarizeBoard };
