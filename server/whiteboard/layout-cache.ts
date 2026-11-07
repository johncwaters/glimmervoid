import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { BoardChrome, PaintedElement } from '../../shared/contracts/whiteboard-tiles.ts';
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
CREATE TABLE IF NOT EXISTS laid_out (
  board_id TEXT NOT NULL,
  element_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (board_id, element_id)
) STRICT;
CREATE INDEX IF NOT EXISTS laid_out_by_slot ON laid_out (board_id, slot);
`;

const HeadRow = z.object({ version: z.number().int(), updated_at: z.number().int(), code_stamp: z.string(), chrome: z.string() });
const LaidOutRow = z.object({ slot: z.number().int().nonnegative(), body: z.string() });

interface CachedLayout {
  chrome: BoardChrome;
  painted: (PaintedElement | null)[];
}

interface LayoutStamp {
  version: number;
  updatedAt: number;
}

interface ChangedPaint {
  slot: number;
  painted: PaintedElement;
}

interface LayoutCache {
  layoutOf(boardId: string, stamp: LayoutStamp): CachedLayout | null;
  save(boardId: string, from: LayoutStamp, to: LayoutStamp, chrome: BoardChrome, changed: readonly ChangedPaint[], removedIds: readonly string[]): void;
  saveWhole(boardId: string, stamp: LayoutStamp, chrome: BoardChrome, painted: readonly (PaintedElement | null)[]): void;
  forget(boardId: string): void;
}

interface OpenCache extends LayoutCache {
  close(): void;
}

const NO_CACHE: OpenCache = { layoutOf: () => null, save: () => {}, saveWhole: () => {}, forget: () => {}, close: () => {} };

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
    rows: database.prepare('SELECT slot, body FROM laid_out WHERE board_id = ? ORDER BY slot'),
    upsertRow: database.prepare('INSERT INTO laid_out (board_id, element_id, slot, body) VALUES (?, ?, ?, ?) ON CONFLICT(board_id, element_id) DO UPDATE SET slot = excluded.slot, body = excluded.body'),
    removeRow: database.prepare('DELETE FROM laid_out WHERE board_id = ? AND element_id = ?'),
    removeRows: database.prepare('DELETE FROM laid_out WHERE board_id = ?'),
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
    const painted: (PaintedElement | null)[] = [];
    for (const row of statements.rows.iterate(boardId)) {
      const laidOut = LaidOutRow.safeParse(row);
      if (!laidOut.success) return null;
      const entry = PaintedElement.safeParse(parsedJson(laidOut.data.body));
      if (!entry.success) return null;
      while (painted.length < laidOut.data.slot) painted.push(null);
      painted[laidOut.data.slot] = entry.data;
    }
    return { chrome: chrome.data, painted };
  }

  function save(boardId: string, from: LayoutStamp, to: LayoutStamp, chrome: BoardChrome, changed: readonly ChangedPaint[], removedIds: readonly string[]): void {
    inTransaction(() => {
      if (!currentHeadOf(boardId, from)) {
        statements.removeHead.run(boardId);
        return;
      }
      for (const id of removedIds) statements.removeRow.run(boardId, id);
      for (const { slot, painted } of changed) statements.upsertRow.run(boardId, painted.element.id, slot, JSON.stringify(painted));
      writeHead(boardId, to, chrome);
    });
  }

  function saveWhole(boardId: string, stamp: LayoutStamp, chrome: BoardChrome, painted: readonly (PaintedElement | null)[]): void {
    inTransaction(() => {
      statements.removeRows.run(boardId);
      for (const [slot, entry] of painted.entries()) {
        if (entry) statements.upsertRow.run(boardId, entry.element.id, slot, JSON.stringify(entry));
      }
      writeHead(boardId, stamp, chrome);
    });
  }

  function forget(boardId: string): void {
    inTransaction(() => {
      statements.removeHead.run(boardId);
      statements.removeRows.run(boardId);
    });
  }

  return { layoutOf, save, saveWhole, forget, close: () => database.close() };
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

function openLayoutCache(filePath: string | null, codeStamp: string | null): LayoutCache {
  if (!filePath || !codeStamp) return NO_CACHE;
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

  return {
    layoutOf: (boardId, stamp) => recovered(null, (open) => open.layoutOf(boardId, stamp)),
    save: (boardId, from, to, chrome, changed, removedIds) => recovered(undefined, (open) => open.save(boardId, from, to, chrome, changed, removedIds)),
    saveWhole: (boardId, stamp, chrome, painted) => recovered(undefined, (open) => open.saveWhole(boardId, stamp, chrome, painted)),
    forget: (boardId) => recovered(undefined, (open) => open.forget(boardId)),
  };
}

export { LAYOUT_CACHE_FILENAME, openLayoutCache };
export type { LayoutCache, LayoutStamp };
