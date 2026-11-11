import { z } from 'zod';

import { upgradedBoardRecord } from '../core/whiteboard-store-core.ts';
import { BoardRecord, linesOfBox } from '../../shared/contracts/whiteboard.ts';
import type { Board, Element } from '../../shared/contracts/whiteboard.ts';
import { ELEMENT_KIND_NAMES, elementTableOf, isElementKind, jsonOfStored } from '../../shared/whiteboard-element-table.ts';
import type { ElementTable, StoredElementRow } from '../../shared/whiteboard-element-table.ts';
import type { StagedOps } from '../../shared/whiteboard-ops-core.ts';
import { assetIdOf } from '../../shared/whiteboard-board-index.ts';

type StagedElements = Pick<Extract<StagedOps, { ok: true }>, 'diff' | 'afterById'>;
type ElementDelta = { writes: z.infer<typeof ElementWrite>[]; removedElementIds: string[]; reslottedElementIds: string[] };

const BOARD_STORE_FILENAME = 'boards.sqlite';
const ELEMENT_PAGE_SIZE = 5_000;
const BOARD_ROWS_VERSION = 5;
const RETIRED_NOTE_KIND = 'note';

const BOARD_STORE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  head TEXT NOT NULL,
  cursors TEXT NOT NULL,
  created_by TEXT,
  version INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS elements (
  slot INTEGER PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  element_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  kind TEXT,
  asset_id TEXT,
  UNIQUE (board_id, element_id)
) STRICT;
CREATE INDEX IF NOT EXISTS elements_by_revision ON elements (board_id, revision);
CREATE VIRTUAL TABLE IF NOT EXISTS element_rects USING rtree(slot, min_x, max_x, min_y, max_y);
CREATE VIRTUAL TABLE IF NOT EXISTS element_text USING fts5(text, tokenize = 'unicode61');
CREATE TABLE IF NOT EXISTS board_log (
  seq INTEGER PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  body TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS board_log_by_version ON board_log (board_id, version);
`;

const Rect = z.strictObject({ minX: z.number(), maxX: z.number(), minY: z.number(), maxY: z.number() });

const ElementKind = z.enum(ELEMENT_KIND_NAMES);

const ElementWrite = z.strictObject({ elementId: z.string(), kind: ElementKind, body: z.string(), assetId: z.string().nullable(), text: z.string() });

const BoardDelta = z.strictObject({
  boardId: z.string(),
  head: z.string(),
  cursors: z.string(),
  createdBy: z.string().nullable(),
  version: z.number().int(),
  writes: z.array(ElementWrite),
  removedElementIds: z.array(z.string()),
  reslottedElementIds: z.array(z.string()),
  appendedLog: z.array(z.strictObject({ version: z.number().int(), body: z.string() })),
  keptLogCount: z.number().int().nonnegative(),
});

const StoreRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('load-heads'), requestId: z.number().int() }),
  z.strictObject({ kind: z.literal('load-board'), requestId: z.number().int(), boardId: z.string(), afterSlot: z.number().int(), limit: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('asset-ids'), requestId: z.number().int() }),
  z.strictObject({ kind: z.literal('write'), requestId: z.number().int(), deltas: z.array(BoardDelta) }),
  z.strictObject({ kind: z.literal('delete'), requestId: z.number().int(), boardId: z.string() }),
  z.strictObject({ kind: z.literal('set-rects'), requestId: z.number().int(), boardId: z.string(), rectsByElementId: z.record(z.string(), Rect) }),
  z.strictObject({ kind: z.literal('query-region'), requestId: z.number().int(), boardId: z.string(), region: Rect, limit: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('search-text'), requestId: z.number().int(), boardId: z.string(), query: z.string(), limit: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('board-ids'), requestId: z.number().int() }),
]);

const StoredHeadRows = z.strictObject({
  boardId: z.string(),
  head: z.string(),
  cursors: z.string(),
  createdBy: z.string().nullable(),
  logBodies: z.array(z.string()),
});

const StoreReply = z.discriminatedUnion('ok', [
  z.strictObject({
    requestId: z.number().int(),
    ok: z.literal(true),
    heads: z.array(StoredHeadRows).optional(),
    elementKinds: z.array(ElementKind).optional(),
    elementBodies: z.array(z.string()).optional(),
    isDamaged: z.literal(true).optional(),
    lastSlot: z.number().int().optional(),
    elementIds: z.array(z.string()).optional(),
    boardIds: z.array(z.string()).optional(),
    assetIds: z.array(z.string()).optional(),
  }),
  z.strictObject({ requestId: z.number().int(), ok: z.literal(false), error: z.string() }),
]);

type Rect = z.infer<typeof Rect>;
type BoardDelta = z.infer<typeof BoardDelta>;
type StoreRequest = z.infer<typeof StoreRequest>;
type StoreReply = z.infer<typeof StoreReply>;
type StoredHeadRows = z.infer<typeof StoredHeadRows>;
type ElementKindName = z.infer<typeof ElementKind>;
type StoredRowColumns = { elementId: string; kind: unknown; body: string };
type ElementPage = { isDamaged: true } | { elementIds: string[]; elementKinds: ElementKindName[]; elementBodies: string[] };
type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown ? Omit<Value, Key> : never;
type StoreRequestBody = DistributiveOmit<StoreRequest, 'requestId'>;

const EMPTY_BODY = '{}';
const BoardHeadFields = z.record(z.string(), z.unknown());
const ElementIdentity = z.object({ id: z.string() });

function searchableTextOf(element: Element): string {
  if (element.kind === 'box') return [element.title, ...linesOfBox(element).map((line) => [line.key, line.text].filter(Boolean).join(' '))].join('\n');
  if (element.kind === 'wire') return element.label ?? '';
  if (element.kind === 'stroke') return '';
  return element.title;
}

function headOf(board: Board): string {
  const { elements: _elements, ...head } = board;
  return JSON.stringify(head);
}

function elementWriteOf(element: Element, body: string): z.infer<typeof ElementWrite> {
  return { elementId: element.id, kind: element.kind, body, assetId: assetIdOf(element), text: searchableTextOf(element) };
}

function elementWritesOf(elements: readonly Element[]): z.infer<typeof ElementWrite>[] {
  const encoded = elementTableOf(elements);
  return elements.map((element) => elementWriteOf(element, encoded.bodyOf(element.id) ?? EMPTY_BODY));
}

function reorderedElementIdsOf(elementsBefore: Board['elements'], elementsAfter: Board['elements']): Set<string> {
  const keptInOrderBefore = [...elementsBefore.keys()].filter((elementId) => elementsAfter.has(elementId));
  const idsInOrderAfter = [...elementsAfter.keys()];
  const movedElementIds = new Set<string>();
  let afterIndex = 0;
  for (const elementId of keptInOrderBefore) {
    if (idsInOrderAfter[afterIndex] === elementId) {
      afterIndex += 1;
      continue;
    }
    movedElementIds.add(elementId);
  }
  return movedElementIds;
}

function stagedElementDeltaOf(staged: StagedElements): ElementDelta {
  const delta: ElementDelta = { writes: [], removedElementIds: [], reslottedElementIds: [] };
  const writtenElements: Element[] = [];
  for (const [elementId, change] of Object.entries(staged.diff.elements)) {
    const element = staged.afterById.get(elementId);
    if (change[0] === 'remove' || !element) {
      delta.removedElementIds.push(elementId);
      continue;
    }
    if (change[0] === 'put') delta.reslottedElementIds.push(elementId);
    writtenElements.push(element);
  }
  delta.writes = elementWritesOf(writtenElements);
  return delta;
}

function comparedElementDeltaOf(elementsBefore: Board['elements'], elementsAfter: Board['elements']): ElementDelta {
  if (elementsBefore === elementsAfter) return { writes: [], removedElementIds: [], reslottedElementIds: [] };
  const reorderedElementIds = reorderedElementIdsOf(elementsBefore, elementsAfter);
  const writes = [...elementsAfter.values()].filter((element) => elementsBefore.bodyOf(element.id) !== elementsAfter.bodyOf(element.id) || elementsBefore.kindOf(element.id) !== element.kind || reorderedElementIds.has(element.id)).map((element) => elementWriteOf(element, elementsAfter.bodyOf(element.id) ?? EMPTY_BODY));
  const removedElementIds = [...elementsBefore.keys()].filter((elementId) => !elementsAfter.has(elementId));
  return { writes, removedElementIds, reslottedElementIds: [...reorderedElementIds] };
}

function boardDeltaOf(before: BoardRecord | null, after: BoardRecord, staged: StagedElements | null = null): BoardDelta {
  const elementDelta = staged ? stagedElementDeltaOf(staged) : comparedElementDeltaOf(before?.board.elements ?? elementTableOf(), after.board.elements);
  const newestLoggedVersion = before?.log.at(-1)?.version ?? Number.NEGATIVE_INFINITY;
  const appendedLog = after.log.filter((change) => change.version > newestLoggedVersion).map((change) => ({ version: change.version, body: JSON.stringify(change) }));
  return {
    boardId: after.board.id,
    head: headOf(after.board),
    cursors: JSON.stringify(after.cursorBySessionId),
    createdBy: after.createdBy,
    version: after.board.version,
    ...elementDelta,
    appendedLog,
    keptLogCount: after.log.length,
  };
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function headRowsOf(record: BoardRecord): StoredHeadRows {
  return { boardId: record.board.id, head: headOf(record.board), cursors: JSON.stringify(record.cursorBySessionId), createdBy: record.createdBy, logBodies: record.log.map((change) => JSON.stringify(change)) };
}

function elementPageOfRows(rows: readonly StoredRowColumns[]): ElementPage {
  const storedRows: StoredElementRow[] = [];
  for (const row of rows) {
    if (!isElementKind(row.kind)) return { isDamaged: true };
    storedRows.push({ id: row.elementId, kind: row.kind, body: row.body });
  }
  return { elementIds: storedRows.map((row) => row.id), elementKinds: storedRows.map((row) => row.kind), elementBodies: storedRows.map((row) => row.body) };
}

function compactDeltaOf(rows: StoredHeadRows, storedElements: readonly StoredRowColumns[]): BoardDelta | null {
  const record = upgradedRecordOfRows(rows, storedElements);
  if (!record) return null;
  const delta = boardDeltaOf(null, record);
  return { ...delta, appendedLog: [], removedElementIds: storedElements.map((row) => row.elementId).filter((elementId) => !record.board.elements.has(elementId)) };
}

function upgradedRecordWith(rows: StoredHeadRows, storedElements: Record<string, unknown>): BoardRecord | null {
  const head = BoardHeadFields.safeParse(parsedJson(rows.head));
  if (!head.success) return null;
  const storedRecord = { board: { ...head.data, elements: storedElements }, log: rows.logBodies.map(parsedJson), cursorBySessionId: parsedJson(rows.cursors), createdBy: rows.createdBy };
  const record = BoardRecord.safeParse(upgradedBoardRecord(storedRecord));
  return record.success ? record.data : null;
}

function recordOfRows(rows: StoredHeadRows, elements: ElementTable): BoardRecord | null {
  const record = upgradedRecordWith(rows, {});
  return record ? { ...record, board: { ...record.board, elements } } : null;
}

function storedElementOfRow(row: StoredRowColumns): unknown {
  if (!isElementKind(row.kind) && row.kind !== RETIRED_NOTE_KIND) return parsedJson(row.body);
  const element = parsedJson(jsonOfStored(row.body));
  return typeof element === 'object' && element !== null ? { ...element, id: row.elementId, kind: row.kind } : undefined;
}

function upgradedRecordOfRows(rows: StoredHeadRows, elementRows: readonly StoredRowColumns[]): BoardRecord | null {
  const storedElements: Record<string, unknown> = {};
  for (const row of elementRows) {
    const element = storedElementOfRow(row);
    const identity = ElementIdentity.safeParse(element);
    if (!identity.success) return null;
    storedElements[identity.data.id] = element;
  }
  return upgradedRecordWith(rows, storedElements);
}

function ftsQueryOf(query: string): string {
  return query.split(/\s+/).filter(Boolean).map((word) => `"${word.replaceAll('"', '""')}"`).join(' ');
}

export type { StagedElements };
export { BOARD_STORE_FILENAME, BOARD_STORE_SCHEMA, BOARD_ROWS_VERSION, ELEMENT_PAGE_SIZE, StoreReply, StoreRequest, boardDeltaOf, compactDeltaOf, elementPageOfRows, ftsQueryOf, headRowsOf, recordOfRows };
export type { BoardDelta, ElementPage, Rect, StoreRequestBody, StoredHeadRows, StoredRowColumns };
