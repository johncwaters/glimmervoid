import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { BoardChrome, PlacedPaint, RememberedRoute } from '../../shared/contracts/whiteboard-tiles.ts';
import type { SavedWorldParts, WarningChange } from '../../shared/whiteboard-layout-engine.ts';
import { ELEMENT_KIND_NAMES, elementTableOfStoredRows } from '../../shared/whiteboard-element-table.ts';
import type { ElementTable, StoredElementRow } from '../../shared/whiteboard-element-table.ts';
import { isUnreadableDatabase, openDatabase, setAside } from './sqlite-files.ts';

const LAYOUT_CACHE_FILENAME = 'layout-cache.sqlite';
const CACHE_FOLDER_MODE = 0o700;

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
const PlacedRow = z.object({ slot: z.number().int().nonnegative(), element_id: z.string(), body: z.string(), record_kind: z.enum(ELEMENT_KIND_NAMES), record_body: z.string() });
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
  saveWhole(boardId: string, stamp: LayoutStamp, chrome: BoardChrome, painted: readonly SavedPaint[], world: SavedWorldParts): void;
  forget(boardId: string): void;
}

interface OpenCache extends LayoutCache {
  close(): void;
}

interface QueuedLayoutCache extends LayoutCache {
  runQueuedWrites(): void;
}

interface QueuedWriteTiming {
  boardId: string;
  elapsedMs: number;
}

const NO_CACHE: OpenCache = { layoutOf: () => null, worldOf: () => null, save: () => {}, saveWhole: () => {}, forget: () => {}, close: () => {} };

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function statementsOf(database: DatabaseSync) {
  return {
    head: database.prepare('SELECT version, updated_at, code_stamp, chrome FROM layout_head WHERE board_id = ?'),
    upsertHead: database.prepare('INSERT INTO layout_head (board_id, version, updated_at, code_stamp, chrome) VALUES (?, ?, ?, ?, ?) ON CONFLICT(board_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, code_stamp = excluded.code_stamp, chrome = excluded.chrome'),
    removeHead: database.prepare('DELETE FROM layout_head WHERE board_id = ?'),
    rows: database.prepare('SELECT slot, element_id, body, record_kind, record_body FROM placed WHERE board_id = ? ORDER BY slot'),
    upsertRow: database.prepare('INSERT INTO placed (board_id, element_id, slot, body, record_kind, record_body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(board_id, element_id) DO UPDATE SET slot = excluded.slot, body = excluded.body, record_kind = excluded.record_kind, record_body = excluded.record_body'),
    removeRow: database.prepare('DELETE FROM placed WHERE board_id = ? AND element_id = ?'),
    removeRows: database.prepare('DELETE FROM placed WHERE board_id = ?'),
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

  function inTransaction(work: () => void): void {
    database.exec('BEGIN IMMEDIATE');
    try {
      work();
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

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
    for (const row of statements.rows.iterate(boardId)) {
      const placed = PlacedRow.safeParse(row);
      if (!placed.success) return null;
      const entry = PlacedPaint.safeParse(parsedJson(placed.data.body));
      if (!entry.success || entry.data.element.id !== placed.data.element_id) return null;
      while (painted.length < placed.data.slot) painted.push(null);
      painted[placed.data.slot] = entry.data;
      records.push({ id: placed.data.element_id, kind: placed.data.record_kind, body: placed.data.record_body });
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
    inTransaction(() => {
      if (!currentHeadOf(boardId, from)) {
        statements.removeHead.run(boardId);
        return;
      }
      for (const id of removedIds) statements.removeRow.run(boardId, id);
      for (const saved of changed) upsertPlaced(boardId, saved);
      for (const [wireId, route] of world.routes) {
        if (route) statements.upsertRoute.run(boardId, wireId, JSON.stringify(route));
        if (!route) statements.removeRoute.run(boardId, wireId);
      }
      writeWarningChanges(boardId, world.warnings);
      writeHead(boardId, to, chrome);
    });
  }

  function upsertPlaced(boardId: string, { slot, painted, record }: SavedPaint): void {
    statements.upsertRow.run(boardId, painted.element.id, slot, JSON.stringify(painted), record.kind, record.body);
  }

  function saveWhole(boardId: string, stamp: LayoutStamp, chrome: BoardChrome, painted: readonly SavedPaint[], world: SavedWorldParts): void {
    inTransaction(() => {
      statements.removeRows.run(boardId);
      statements.removeRoutes.run(boardId);
      statements.removeWarnings.run(boardId);
      for (const saved of painted) upsertPlaced(boardId, saved);
      for (const [wireId, route] of world.routeById) statements.upsertRoute.run(boardId, wireId, JSON.stringify(route));
      for (const text of world.routeWarnings) statements.insertWarning.run(boardId, 'route', text);
      for (const text of world.placementWarnings) statements.insertWarning.run(boardId, 'placement', text);
      writeHead(boardId, stamp, chrome);
    });
  }

  function forget(boardId: string): void {
    inTransaction(() => {
      statements.removeHead.run(boardId);
      statements.removeRows.run(boardId);
      statements.removeRoutes.run(boardId);
      statements.removeWarnings.run(boardId);
    });
  }

  return { layoutOf, worldOf, save, saveWhole, forget, close: () => database.close() };
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
  if (!filePath || !codeStamp) return { ...NO_CACHE, runQueuedWrites: () => {} };
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

  const queuedWrites: (() => void)[] = [];

  function runQueuedWrites(): void {
    for (let write = queuedWrites.shift(); write; write = queuedWrites.shift()) write();
  }

  function afterQueuedWrites<Value>(work: () => Value): Value {
    runQueuedWrites();
    return work();
  }

  function queueWholeSave(boardId: string, write: () => void): void {
    queuedWrites.push(() => {
      const startedAt = performance.now();
      write();
      onQueuedWrite({ boardId, elapsedMs: performance.now() - startedAt });
    });
  }

  return {
    layoutOf: (boardId, stamp) => afterQueuedWrites(() => recovered(null, (open) => open.layoutOf(boardId, stamp))),
    worldOf: (boardId, stamp) => afterQueuedWrites(() => recovered(null, (open) => open.worldOf(boardId, stamp))),
    save: (boardId, from, to, chrome, changed, removedIds, world) => afterQueuedWrites(() => recovered(undefined, (open) => open.save(boardId, from, to, chrome, changed, removedIds, world))),
    saveWhole: (boardId, stamp, chrome, painted, world) => queueWholeSave(boardId, () => recovered(undefined, (open) => open.saveWhole(boardId, stamp, chrome, painted, world))),
    forget: (boardId) => afterQueuedWrites(() => recovered(undefined, (open) => open.forget(boardId))),
    runQueuedWrites,
  };
}

export { LAYOUT_CACHE_FILENAME, openLayoutCache };
export type { LayoutCache, LayoutStamp, SavedPaint };
