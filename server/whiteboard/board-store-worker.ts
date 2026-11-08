import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import { BOARD_STORE_SCHEMA, COMPACT_ROWS_VERSION, StoreRequest, compactDeltaOf, elementPageOfRows, ftsQueryOf } from './board-store-core.ts';
import type { BoardDelta, ElementPage, Rect, StoreRequestBody, StoredHeadRows, StoredRowColumns } from './board-store-core.ts';
import { errorMessage } from '../../shared/text.ts';
import { inTransaction, isUnreadableDatabase, openDatabase, setAside } from './sqlite-files.ts';

type ReplyFields = Partial<Extract<ElementPage, { isDamaged: true }>> & Partial<Extract<ElementPage, { elementIds: string[] }>> & { heads?: StoredHeadRows[]; lastSlot?: number; boardIds?: string[]; assetIds?: string[] };

const COMPACT_ROW_COLUMNS = ['kind', 'asset_id', 'linked_board_id'] as const;
const COMPACT_ROW_INDEXES = [
  'CREATE INDEX IF NOT EXISTS elements_by_board ON elements (board_id)',
  'CREATE INDEX IF NOT EXISTS elements_by_asset ON elements (asset_id) WHERE asset_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS elements_by_linked_board ON elements (linked_board_id) WHERE linked_board_id IS NOT NULL',
];

const STORE_FOLDER_MODE = 0o700;
function preparedStatementsOf(database: DatabaseSync) {
  return {
    upsertBoard: database.prepare('INSERT INTO boards (id, head, cursors, created_by, version) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET head = excluded.head, cursors = excluded.cursors, created_by = excluded.created_by, version = excluded.version'),
    upsertElement: database.prepare('INSERT INTO elements (board_id, element_id, revision, body, kind, asset_id, linked_board_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(board_id, element_id) DO UPDATE SET revision = excluded.revision, body = excluded.body, kind = excluded.kind, asset_id = excluded.asset_id, linked_board_id = excluded.linked_board_id RETURNING slot'),
    slotOf: database.prepare('SELECT slot FROM elements WHERE board_id = ? AND element_id = ?'),
    removeElement: database.prepare('DELETE FROM elements WHERE slot = ?'),
    removeText: database.prepare('DELETE FROM element_text WHERE rowid = ?'),
    insertText: database.prepare('INSERT INTO element_text (rowid, text) VALUES (?, ?)'),
    removeRect: database.prepare('DELETE FROM element_rects WHERE slot = ?'),
    upsertRect: database.prepare('INSERT OR REPLACE INTO element_rects (slot, min_x, max_x, min_y, max_y) VALUES (?, ?, ?, ?, ?)'),
    appendLog: database.prepare('INSERT INTO board_log (board_id, version, body) VALUES (?, ?, ?)'),
    pruneLog: database.prepare('DELETE FROM board_log WHERE board_id = ? AND seq NOT IN (SELECT seq FROM board_log WHERE board_id = ? ORDER BY seq DESC LIMIT ?)'),
    allBoards: database.prepare('SELECT id, head, cursors, created_by FROM boards'),
    boardIds: database.prepare('SELECT id FROM boards'),
    elementRows: database.prepare('SELECT slot, element_id, kind, body FROM elements WHERE board_id = ? AND slot > ? ORDER BY slot LIMIT ?'),
    allElementRows: database.prepare('SELECT element_id, kind, body FROM elements WHERE board_id = ? ORDER BY slot'),
    logBodies: database.prepare('SELECT body FROM board_log WHERE board_id = ? ORDER BY seq'),
    boardSlots: database.prepare('SELECT slot FROM elements WHERE board_id = ?'),
    assetIds: database.prepare('SELECT DISTINCT asset_id FROM elements WHERE asset_id IS NOT NULL'),
    boardsLinkingTo: database.prepare('SELECT DISTINCT board_id FROM elements WHERE linked_board_id = ?'),
    fillJsonRowColumns: database.prepare("UPDATE elements SET asset_id = json_extract(body, '$.media.asset'), linked_board_id = json_extract(body, '$.step.linkedBoardId') WHERE board_id = ? AND kind IS NULL AND json_valid(body)"),
    deleteBoard: database.prepare('DELETE FROM boards WHERE id = ?'),
    region: database.prepare('SELECT elements.element_id AS element_id FROM element_rects JOIN elements ON elements.slot = element_rects.slot WHERE elements.board_id = ? AND element_rects.max_x >= ? AND element_rects.min_x <= ? AND element_rects.max_y >= ? AND element_rects.min_y <= ? LIMIT ?'),
    search: database.prepare('SELECT elements.element_id AS element_id FROM element_text JOIN elements ON elements.slot = element_text.rowid WHERE element_text MATCH ? AND elements.board_id = ? ORDER BY rank LIMIT ?'),
  };
}

function preparedStatementsOrClose(database: DatabaseSync): ReturnType<typeof preparedStatementsOf> {
  try {
    return preparedStatementsOf(database);
  } catch (error) {
    database.close();
    throw error;
  }
}

function addCompactRowColumns(database: DatabaseSync): void {
  const presentColumns = new Set(database.prepare('PRAGMA table_info(elements)').all().map((row) => Reflect.get(row, 'name')));
  for (const column of COMPACT_ROW_COLUMNS) {
    if (!presentColumns.has(column)) database.exec(`ALTER TABLE elements ADD COLUMN ${column} TEXT`);
  }
  for (const index of COMPACT_ROW_INDEXES) execUnlessUnreadable(database, index);
}

function execUnlessUnreadable(database: DatabaseSync, statement: string): void {
  try {
    database.exec(statement);
  } catch (error) {
    if (!isUnreadableDatabase(error)) throw error;
  }
}

function storedVersionOf(database: DatabaseSync): number {
  const version: unknown = Reflect.get(database.prepare('PRAGMA user_version').get() ?? {}, 'user_version');
  return typeof version === 'number' ? version : 0;
}

function openCompactRowsDatabase(databasePath: string): DatabaseSync {
  const database = openDatabase(databasePath, BOARD_STORE_SCHEMA);
  try {
    addCompactRowColumns(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function openStore(databasePath: string) {
  const database = openCompactRowsDatabase(databasePath);
  const statements = preparedStatementsOrClose(database);

  function slotNumberOf(row: unknown): number {
    if (typeof row !== 'object' || row === null || !('slot' in row) || typeof row.slot !== 'number') throw new Error('the element slot is missing');
    return row.slot;
  }

  function textColumn(row: unknown, column: string): string {
    const value: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, column) : undefined;
    if (typeof value !== 'string') throw new Error(`the ${column} column is not text`);
    return value;
  }

  function removeSlot(slot: number): void {
    statements.removeText.run(slot);
    statements.removeRect.run(slot);
    statements.removeElement.run(slot);
  }

  function applyDelta(delta: BoardDelta): void {
    statements.upsertBoard.run(delta.boardId, delta.head, delta.cursors, delta.createdBy, delta.version);
    for (const elementId of [...delta.removedElementIds, ...delta.reslottedElementIds]) {
      const row = statements.slotOf.get(delta.boardId, elementId);
      if (row) removeSlot(slotNumberOf(row));
    }
    const slots = delta.writes.map((write) => slotNumberOf(statements.upsertElement.get(delta.boardId, write.elementId, delta.version, write.body, write.kind, write.assetId, write.linkedBoardId)));
    for (const [index, slot] of slots.entries()) {
      const text = delta.writes[index]?.text;
      statements.removeText.run(slot);
      if (text) statements.insertText.run(slot, text);
    }
    for (const change of delta.appendedLog) statements.appendLog.run(delta.boardId, change.version, change.body);
    statements.pruneLog.run(delta.boardId, delta.boardId, delta.keptLogCount);
  }

  function deleteBoard(boardId: string): void {
    for (const row of statements.boardSlots.all(boardId)) removeSlot(slotNumberOf(row));
    statements.deleteBoard.run(boardId);
  }

  function setRects(boardId: string, rectsByElementId: Record<string, Rect>): void {
    for (const [elementId, rect] of Object.entries(rectsByElementId)) {
      const row = statements.slotOf.get(boardId, elementId);
      if (row) statements.upsertRect.run(slotNumberOf(row), rect.minX, rect.maxX, rect.minY, rect.maxY);
    }
  }

  function loadHeads(): StoredHeadRows[] {
    return statements.allBoards.all().map((row) => {
      const boardId = textColumn(row, 'id');
      const createdBy: unknown = Reflect.get(row, 'created_by');
      return {
        boardId,
        head: textColumn(row, 'head'),
        cursors: textColumn(row, 'cursors'),
        createdBy: typeof createdBy === 'string' ? createdBy : null,
        logBodies: statements.logBodies.all(boardId).map((logRow) => textColumn(logRow, 'body')),
      };
    });
  }

  function storedRowColumnsOf(row: unknown): StoredRowColumns {
    return { elementId: textColumn(row, 'element_id'), kind: typeof row === 'object' && row !== null ? Reflect.get(row, 'kind') : null, body: textColumn(row, 'body') };
  }

  function elementPageOf(boardId: string, afterSlot: number, limit: number): ReplyFields {
    const rows = statements.elementRows.all(boardId, afterSlot, limit);
    const lastRow = rows.at(-1);
    return { ...elementPageOfRows(rows.map(storedRowColumnsOf)), ...(lastRow ? { lastSlot: slotNumberOf(lastRow) } : {}) };
  }

  function migrateBoardToCompactRows(headRows: StoredHeadRows): void {
    const delta = compactDeltaOf(headRows, statements.allElementRows.all(headRows.boardId).map(storedRowColumnsOf));
    if (!delta) {
      statements.fillJsonRowColumns.run(headRows.boardId);
      return;
    }
    applyDelta(delta);
  }

  function isBoardUpgraded(headRows: StoredHeadRows): boolean {
    try {
      inTransaction(database, () => migrateBoardToCompactRows(headRows));
      return true;
    } catch (error) {
      if (!isUnreadableDatabase(error)) throw error;
      return false;
    }
  }

  function migrateToCompactRows(): void {
    const unreadableBoardCount = loadHeads().filter((headRows) => !isBoardUpgraded(headRows)).length;
    if (unreadableBoardCount > 0) return;
    database.exec(`PRAGMA user_version = ${COMPACT_ROWS_VERSION}`);
  }

  if (storedVersionOf(database) < COMPACT_ROWS_VERSION) {
    try {
      migrateToCompactRows();
    } catch (error) {
      database.close();
      throw error;
    }
  }

  function handle(request: StoreRequestBody): ReplyFields {
    if (request.kind === 'load-heads') return { heads: loadHeads() };
    if (request.kind === 'load-board') return elementPageOf(request.boardId, request.afterSlot, request.limit);
    if (request.kind === 'asset-ids') return { assetIds: statements.assetIds.all().map((row) => textColumn(row, 'asset_id')) };
    if (request.kind === 'boards-linking-to') return { boardIds: statements.boardsLinkingTo.all(request.boardId).map((row) => textColumn(row, 'board_id')) };
    if (request.kind === 'board-ids') return { boardIds: statements.boardIds.all().map((row) => textColumn(row, 'id')) };
    if (request.kind === 'write') {
      inTransaction(database, () => { for (const delta of request.deltas) applyDelta(delta); });
      return {};
    }
    if (request.kind === 'delete') {
      inTransaction(database, () => deleteBoard(request.boardId));
      return {};
    }
    if (request.kind === 'set-rects') {
      inTransaction(database, () => setRects(request.boardId, request.rectsByElementId));
      return {};
    }
    if (request.kind === 'query-region') {
      const { region } = request;
      return { elementIds: statements.region.all(request.boardId, region.minX, region.maxX, region.minY, region.maxY, request.limit).map((row) => textColumn(row, 'element_id')) };
    }
    const query = ftsQueryOf(request.query);
    if (!query) return { elementIds: [] };
    return { elementIds: statements.search.all(query, request.boardId, request.limit).map((row) => textColumn(row, 'element_id')) };
  }

  return { handle, close: () => database.close() };
}

function openStoreOrSetAside(databasePath: string): ReturnType<typeof openStore> {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: STORE_FOLDER_MODE });
  try {
    return openStore(databasePath);
  } catch (error) {
    if (!isUnreadableDatabase(error)) throw error;
    setAside(databasePath);
    return openStore(databasePath);
  }
}

function loadHeadsOrSetAside(databasePath: string, store: ReturnType<typeof openStore>): { store: ReturnType<typeof openStore>; fields: ReplyFields } {
  try {
    return { store, fields: store.handle({ kind: 'load-heads' }) };
  } catch (error) {
    if (!isUnreadableDatabase(error)) throw error;
    store.close();
    setAside(databasePath);
    const freshStore = openStore(databasePath);
    return { store: freshStore, fields: freshStore.handle({ kind: 'load-heads' }) };
  }
}

function serve(): void {
  const port = parentPort;
  if (!port) throw new Error('the board store runs only as a worker thread');
  const databasePath: unknown = workerData;
  if (typeof databasePath !== 'string') throw new Error('the board store needs its database path');
  let store = openStoreOrSetAside(databasePath);
  port.on('message', (message: unknown) => {
    const parsed = StoreRequest.safeParse(message);
    if (!parsed.success) {
      const requestId: unknown = typeof message === 'object' && message !== null ? Reflect.get(message, 'requestId') : null;
      port.postMessage({ requestId: typeof requestId === 'number' ? requestId : -1, ok: false, error: 'the board store refused a malformed request' });
      return;
    }
    const { requestId, ...request } = parsed.data;
    try {
      if (request.kind === 'load-heads') {
        const loaded = loadHeadsOrSetAside(databasePath, store);
        store = loaded.store;
        port.postMessage({ requestId, ok: true, ...loaded.fields });
        return;
      }
      port.postMessage({ requestId, ok: true, ...store.handle(request) });
    } catch (error) {
      port.postMessage({ requestId, ok: false, error: errorMessage(error) });
    }
  });
}

serve();
