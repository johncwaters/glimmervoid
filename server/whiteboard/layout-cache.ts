import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod';

import { BoardChrome, RememberedRoute } from '../../shared/contracts/whiteboard-tiles.ts';
import type { PlacedPaint } from '../../shared/contracts/whiteboard-tiles.ts';
import type { SavedWorldParts, WarningChange } from '../../shared/whiteboard-layout-engine.ts';
import { elementTableOfStoredRows, isElementKind } from '../../shared/whiteboard-element-table.ts';
import type { ElementTable, StoredElementRow } from '../../shared/whiteboard-element-table.ts';
import { committed, inTransaction, isUnreadableDatabase, openDatabase, setAside, truncateWriteAheadLogLikeAutocheckpoint } from './sqlite-files.ts';

const LAYOUT_CACHE_FILENAME = 'layout-cache.sqlite';
const CACHE_FOLDER_MODE = 0o700;
const WRITE_ROWS_PER_SLICE = 2000;

const LAYOUT_CACHE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS layout_head (
  board_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  code_stamp TEXT NOT NULL,
  chrome TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS placed (
  board_id TEXT NOT NULL,
  element_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  body TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_body TEXT NOT NULL,
  PRIMARY KEY (board_id, element_id)
) STRICT;
CREATE INDEX IF NOT EXISTS placed_by_slot ON placed (board_id, slot);
CREATE TABLE IF NOT EXISTS saved_route (
  board_id TEXT NOT NULL,
  wire_id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (board_id, wire_id)
) STRICT;
CREATE TABLE IF NOT EXISTS saved_warning (
  board_id TEXT NOT NULL,
  book TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (board_id, book, text)
) STRICT;
`;

const HeadRow = z.object({ version: z.number().int(), updated_at: z.number().int(), code_stamp: z.string(), chrome: z.string() });
const RouteRow = z.object({ wire_id: z.string(), body: z.string() });
const WarningRow = z.object({ book: z.enum(['route', 'placement']), text: z.string() });

interface CachedLayout {
  chrome: BoardChrome;
  painted: (PlacedPaint | null)[];
  records: ElementTable;
}

interface SavedPaint {
  slot: number;
  painted: PlacedPaint;
  record: StoredElementRow;
}

interface SavedRows {
  count: number;
  at(slot: number): SavedPaint | null;
}

interface WholeSave {
  stamp: LayoutStamp;
  chrome: BoardChrome;
  rows: SavedRows;
  savedWorld(): SavedWorldParts;
}

type WholeSaveSource = () => WholeSave | null;

interface LayoutStamp {
  version: number;
  updatedAt: number;
}

interface WorldSave {
  routes: readonly (readonly [string, RememberedRoute | null])[];
  warnings: readonly WarningChange[];
}

interface LayoutCache {
  layoutOf(boardId: string, stamp: LayoutStamp): CachedLayout | null;
  worldOf(boardId: string, stamp: LayoutStamp): SavedWorldParts | null;
  save(boardId: string, from: LayoutStamp, to: LayoutStamp, chrome: BoardChrome, changed: readonly SavedPaint[], removedIds: readonly string[], world: WorldSave): void;
  saveWhole(boardId: string, latest: WholeSaveSource): void;
  forget(boardId: string): void;
}

interface OpenCache extends Omit<LayoutCache, 'saveWhole'> {
  savingWhole(boardId: string, latest: WholeSaveSource): Generator<void, boolean>;
  saveBesideWhole(boardId: string, changed: readonly SavedPaint[], removedIds: readonly string[], routes: WorldSave['routes']): void;
  close(): void;
}

interface QueuedLayoutCache extends LayoutCache {
  runQueuedSlice(): boolean;
}

interface QueuedWriteTiming {
  boardId: string;
  elapsedMs: number;
}

function* nothingToSave(): Generator<void, boolean> {
  yield* [];
  return false;
}

const NO_CACHE: OpenCache = { layoutOf: () => null, worldOf: () => null, save: () => {}, savingWhole: nothingToSave, saveBesideWhole: () => {}, forget: () => {}, close: () => {} };

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isPaintOfElement(value: unknown, elementId: string): value is PlacedPaint {
  if (typeof value !== 'object' || value === null) return false;
  const element = Reflect.get(value, 'element');
  return Number.isInteger(Reflect.get(value, 'paintOrder')) && typeof element === 'object' && element !== null && Reflect.get(element, 'id') === elementId;
}

function isSlot(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function columnsOnly(statement: StatementSync): StatementSync {
  statement.setReturnArrays(true);
  return statement;
}

function statementsOf(database: DatabaseSync) {
  return {
    head: database.prepare('SELECT version, updated_at, code_stamp, chrome FROM layout_head WHERE board_id = ?'),
    upsertHead: database.prepare('INSERT INTO layout_head (board_id, version, updated_at, code_stamp, chrome) VALUES (?, ?, ?, ?, ?) ON CONFLICT(board_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, code_stamp = excluded.code_stamp, chrome = excluded.chrome'),
    removeHead: database.prepare('DELETE FROM layout_head WHERE board_id = ?'),
    rowColumns: columnsOnly(database.prepare('SELECT slot, element_id, body, record_kind, record_body FROM placed WHERE board_id = ? ORDER BY slot')),
    upsertRow: database.prepare('INSERT INTO placed (board_id, element_id, slot, body, record_kind, record_body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(board_id, element_id) DO UPDATE SET slot = excluded.slot, body = excluded.body, record_kind = excluded.record_kind, record_body = excluded.record_body'),
    removeRow: database.prepare('DELETE FROM placed WHERE board_id = ? AND element_id = ?'),
    removeRows: database.prepare('DELETE FROM placed WHERE board_id = ?'),
    removeSomeRows: database.prepare('DELETE FROM placed WHERE rowid IN (SELECT rowid FROM placed WHERE board_id = ? LIMIT ?)'),
    routes: database.prepare('SELECT wire_id, body FROM saved_route WHERE board_id = ?'),
    upsertRoute: database.prepare('INSERT INTO saved_route (board_id, wire_id, body) VALUES (?, ?, ?) ON CONFLICT(board_id, wire_id) DO UPDATE SET body = excluded.body'),
    removeRoute: database.prepare('DELETE FROM saved_route WHERE board_id = ? AND wire_id = ?'),
    removeRoutes: database.prepare('DELETE FROM saved_route WHERE board_id = ?'),
    warnings: database.prepare('SELECT book, text FROM saved_warning WHERE board_id = ? ORDER BY rowid'),
    insertWarning: database.prepare('INSERT INTO saved_warning (board_id, book, text) VALUES (?, ?, ?)'),
    removeWarning: database.prepare('DELETE FROM saved_warning WHERE board_id = ? AND book = ? AND text = ?'),
    removeWarnings: database.prepare('DELETE FROM saved_warning WHERE board_id = ?'),
  };
}

function cacheOver(database: DatabaseSync, codeStamp: string): OpenCache {
  const statements = statementsOf(database);

  function currentHeadOf(boardId: string, stamp: LayoutStamp): z.infer<typeof HeadRow> | null {
    const head = HeadRow.safeParse(statements.head.get(boardId));
    if (!head.success) return null;
    const isCurrent = head.data.version === stamp.version && head.data.updated_at === stamp.updatedAt && head.data.code_stamp === codeStamp;
    return isCurrent ? head.data : null;
  }

  function writeHead(boardId: string, stamp: LayoutStamp, chrome: BoardChrome): void {
    statements.upsertHead.run(boardId, stamp.version, stamp.updatedAt, codeStamp, JSON.stringify(chrome));
  }

  function layoutOf(boardId: string, stamp: LayoutStamp): CachedLayout | null {
    const head = currentHeadOf(boardId, stamp);
    if (!head) return null;
    const chrome = BoardChrome.safeParse(parsedJson(head.chrome));
    if (!chrome.success) return null;
    const painted: (PlacedPaint | null)[] = [];
    const records: StoredElementRow[] = [];
    for (const row of statements.rowColumns.iterate(boardId)) {
      if (!Array.isArray(row)) return null;
      const [slot, elementId, body, recordKind, recordBody] = row;
      if (!isSlot(slot) || typeof elementId !== 'string' || typeof body !== 'string' || !isElementKind(recordKind) || typeof recordBody !== 'string') return null;
      const paint = parsedJson(body);
      if (!isPaintOfElement(paint, elementId)) return null;
      while (painted.length < slot) painted.push(null);
      painted[slot] = paint;
      records.push({ id: elementId, kind: recordKind, body: recordBody });
    }
    return { chrome: chrome.data, painted, records: elementTableOfStoredRows(records) };
  }

  function worldOf(boardId: string, stamp: LayoutStamp): SavedWorldParts | null {
    if (!currentHeadOf(boardId, stamp)) return null;
    const routeById = new Map<string, RememberedRoute>();
    for (const row of statements.routes.iterate(boardId)) {
      const routeRow = RouteRow.safeParse(row);
      const route = routeRow.success ? RememberedRoute.safeParse(parsedJson(routeRow.data.body)) : null;
      if (!routeRow.success || !route?.success) return null;
      routeById.set(routeRow.data.wire_id, route.data);
    }
    const textsByBook = { route: [] as string[], placement: [] as string[] };
    for (const row of statements.warnings.iterate(boardId)) {
      const warning = WarningRow.safeParse(row);
      if (!warning.success) return null;
      textsByBook[warning.data.book].push(warning.data.text);
    }
    return { routeById, routeWarnings: textsByBook.route, placementWarnings: textsByBook.placement };
  }

  function writeWarningChanges(boardId: string, warnings: readonly WarningChange[]): void {
    for (const { book, text, isPresent } of warnings) {
      statements.removeWarning.run(boardId, book, text);
      if (isPresent) statements.insertWarning.run(boardId, book, text);
    }
  }

  function save(boardId: string, from: LayoutStamp, to: LayoutStamp, chrome: BoardChrome, changed: readonly SavedPaint[], removedIds: readonly string[], world: WorldSave): void {
    inTransaction(database, () => {
      if (!currentHeadOf(boardId, from)) {
        statements.removeHead.run(boardId);
        return;
      }
      writeChanges(boardId, changed, removedIds, world.routes);
      writeWarningChanges(boardId, world.warnings);
      writeHead(boardId, to, chrome);
    });
  }

  function writeChanges(boardId: string, changed: readonly SavedPaint[], removedIds: readonly string[], routes: WorldSave['routes']): void {
    for (const id of removedIds) statements.removeRow.run(boardId, id);
    for (const saved of changed) upsertPlaced(boardId, saved);
    for (const [wireId, route] of routes) {
      if (route) statements.upsertRoute.run(boardId, wireId, JSON.stringify(route));
      if (!route) statements.removeRoute.run(boardId, wireId);
    }
  }

  function saveBesideWhole(boardId: string, changed: readonly SavedPaint[], removedIds: readonly string[], routes: WorldSave['routes']): void {
    inTransaction(database, () => writeChanges(boardId, changed, removedIds, routes));
  }

  function upsertPlaced(boardId: string, { slot, painted, record }: SavedPaint): void {
    statements.upsertRow.run(boardId, painted.element.id, slot, JSON.stringify(painted), record.kind, record.body);
  }

  function* removingRows(boardId: string): Generator<void, void> {
    for (;;) {
      const { changes } = committed(database, () => statements.removeSomeRows.run(boardId, WRITE_ROWS_PER_SLICE));
      if (Number(changes) < WRITE_ROWS_PER_SLICE) return;
      yield;
    }
  }

  function* writingRows(boardId: string, latest: WholeSaveSource): Generator<void, boolean> {
    for (let start = 0; ; start += WRITE_ROWS_PER_SLICE) {
      const rows = latest()?.rows;
      if (!rows) return false;
      if (start >= rows.count) return true;
      committed(database, () => {
        for (let slot = start; slot < Math.min(start + WRITE_ROWS_PER_SLICE, rows.count); slot += 1) {
          const saved = rows.at(slot);
          if (saved) upsertPlaced(boardId, saved);
        }
      });
      yield;
    }
  }

  function* writingRoutes(boardId: string, latest: WholeSaveSource): Generator<void, boolean> {
    const routes = latest()?.savedWorld().routeById.entries();
    if (!routes) return false;
    for (;;) {
      const isDone = committed(database, () => {
        for (let written = 0; written < WRITE_ROWS_PER_SLICE; written += 1) {
          const next = routes.next();
          if (next.done) return true;
          statements.upsertRoute.run(boardId, next.value[0], JSON.stringify(next.value[1]));
        }
        return false;
      });
      if (isDone) return true;
      yield;
      if (!latest()) return false;
    }
  }

  function* savingWhole(boardId: string, latest: WholeSaveSource): Generator<void, boolean> {
    inTransaction(database, () => {
      statements.removeHead.run(boardId);
      statements.removeRoutes.run(boardId);
      statements.removeWarnings.run(boardId);
    });
    yield;
    yield* removingRows(boardId);
    if (!(yield* writingRows(boardId, latest))) return false;
    if (!(yield* writingRoutes(boardId, latest))) return false;
    const whole = latest();
    if (!whole) return false;
    const { routeWarnings, placementWarnings } = whole.savedWorld();
    inTransaction(database, () => {
      for (const text of routeWarnings) statements.insertWarning.run(boardId, 'route', text);
      for (const text of placementWarnings) statements.insertWarning.run(boardId, 'placement', text);
      writeHead(boardId, whole.stamp, whole.chrome);
    });
    truncateWriteAheadLogLikeAutocheckpoint(database);
    return true;
  }

  function forget(boardId: string): void {
    inTransaction(database, () => {
      statements.removeHead.run(boardId);
      statements.removeRows.run(boardId);
      statements.removeRoutes.run(boardId);
      statements.removeWarnings.run(boardId);
    });
  }

  return { layoutOf, worldOf, save, savingWhole, saveBesideWhole, forget, close: () => database.close() };
}

function openOrSetAside(filePath: string, codeStamp: string): OpenCache {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: CACHE_FOLDER_MODE });
  try {
    return cacheOver(openDatabase(filePath, LAYOUT_CACHE_SCHEMA), codeStamp);
  } catch (error) {
    if (!isUnreadableDatabase(error)) throw error;
    setAside(filePath);
    return cacheOver(openDatabase(filePath, LAYOUT_CACHE_SCHEMA), codeStamp);
  }
}

function openCacheFile(filePath: string, codeStamp: string): OpenCache {
  try {
    return openOrSetAside(filePath, codeStamp);
  } catch {
    return NO_CACHE;
  }
}

function reopenedAfter(filePath: string, codeStamp: string, failed: OpenCache, error: unknown): OpenCache {
  try {
    failed.close();
    if (!isUnreadableDatabase(error)) return NO_CACHE;
    setAside(filePath);
    return openCacheFile(filePath, codeStamp);
  } catch {
    return NO_CACHE;
  }
}

function openLayoutCache(filePath: string | null, codeStamp: string | null, onQueuedWrite: (timing: QueuedWriteTiming) => void = () => {}): QueuedLayoutCache {
  if (!filePath || !codeStamp) return { ...NO_CACHE, saveWhole: () => {}, runQueuedSlice: () => false };
  const cacheFilePath = filePath;
  const layoutCodeStamp = codeStamp;
  let cache = openCacheFile(cacheFilePath, layoutCodeStamp);

  function recovered<Value>(fallback: Value, work: (open: OpenCache) => Value): Value {
    try {
      return work(cache);
    } catch (error) {
      cache = reopenedAfter(cacheFilePath, layoutCodeStamp, cache, error);
      return fallback;
    }
  }

  interface QueuedWrite {
    boardId: string;
    steps: Generator<void, boolean>;
    openedOn: OpenCache;
    elapsedMs: number;
  }

  const queuedWrites: QueuedWrite[] = [];

  function isWriteDone(write: QueuedWrite): boolean {
    if (write.openedOn !== cache) return true;
    const startedAt = performance.now();
    const step = recovered(null, () => write.steps.next());
    write.elapsedMs += performance.now() - startedAt;
    if (step?.done && step.value) onQueuedWrite({ boardId: write.boardId, elapsedMs: write.elapsedMs });
    return step?.done !== false;
  }

  function runQueuedSlice(): boolean {
    const oldest = queuedWrites[0];
    if (oldest && isWriteDone(oldest)) queuedWrites.shift();
    return queuedWrites.length > 0;
  }

  function isWriteQueuedFor(boardId: string): boolean {
    return queuedWrites.some((write) => write.boardId === boardId);
  }

  function finishQueuedWritesOf(boardId: string): void {
    for (const write of queuedWrites.filter((queued) => queued.boardId === boardId)) {
      while (!isWriteDone(write));
      queuedWrites.splice(queuedWrites.indexOf(write), 1);
    }
  }

  function dropQueuedWritesOf(boardId: string): void {
    const kept = queuedWrites.filter((write) => write.boardId !== boardId);
    queuedWrites.splice(0, queuedWrites.length, ...kept);
  }

  function afterQueuedWritesOf<Value>(boardId: string, work: () => Value): Value {
    finishQueuedWritesOf(boardId);
    return work();
  }

  function save(boardId: string, from: LayoutStamp, to: LayoutStamp, chrome: BoardChrome, changed: readonly SavedPaint[], removedIds: readonly string[], world: WorldSave): void {
    if (isWriteQueuedFor(boardId)) {
      recovered(undefined, (open) => open.saveBesideWhole(boardId, changed, removedIds, world.routes));
      return;
    }
    recovered(undefined, (open) => open.save(boardId, from, to, chrome, changed, removedIds, world));
  }

  function saveWhole(boardId: string, latest: WholeSaveSource): void {
    dropQueuedWritesOf(boardId);
    queuedWrites.push({ boardId, steps: cache.savingWhole(boardId, latest), openedOn: cache, elapsedMs: 0 });
  }

  function forget(boardId: string): void {
    dropQueuedWritesOf(boardId);
    recovered(undefined, (open) => open.forget(boardId));
  }

  return {
    layoutOf: (boardId, stamp) => afterQueuedWritesOf(boardId, () => recovered(null, (open) => open.layoutOf(boardId, stamp))),
    worldOf: (boardId, stamp) => afterQueuedWritesOf(boardId, () => recovered(null, (open) => open.worldOf(boardId, stamp))),
    save,
    saveWhole,
    forget,
    runQueuedSlice,
  };
}

export { LAYOUT_CACHE_FILENAME, openLayoutCache };
export type { LayoutCache, LayoutStamp, SavedPaint, WholeSave };
