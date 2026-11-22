import { DatabaseSync } from 'node:sqlite';
import type { LaneLog } from '../lanes/lane-log.ts';
import { decideFileRead } from './core/usage-scan-core.ts';
import { parseOpenCodeMessageRow } from './core/usage-opencode-core.ts';
import type { OpenCodeMessageRow } from './core/usage-opencode-core.ts';
import type { UsageEntry } from './core/usage-entry-core.ts';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';

export interface OpenCodeDbCursor {
  dbSize: number;
  dbMtimeMs: number;
  walSize: number;
  walMtimeMs: number;
  watermarkUpdatedMs: number;
  watermarkId: string;
  hasMore: boolean;
}

interface StatLike {
  size: number;
  mtimeMs: number;
  isDirectory(): boolean;
  isFile?(): boolean;
}

interface StatFs {
  stat(targetPath: string): Promise<StatLike>;
}

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES_PER_PASS = 4;

async function statOptionalFile(targetPath: string, fsPromises: StatFs): Promise<StatLike | null> {
  try {
    const fileStat = await fsPromises.stat(targetPath);
    if (typeof fileStat.isFile === 'function' ? !fileStat.isFile() : fileStat.isDirectory()) return null;
    return fileStat;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function readOpenCodeDbPage(
  { dbPath, cursor, force, fsPromises, pageSize = DEFAULT_PAGE_SIZE, maxPages = DEFAULT_MAX_PAGES_PER_PASS, yieldNowFn, laneLog }: {
    dbPath: string;
    cursor: OpenCodeDbCursor | null;
    force: boolean;
    fsPromises: StatFs;
    pageSize?: number;
    maxPages?: number;
    yieldNowFn: () => Promise<void>;
    laneLog: LaneLog;
  },
): Promise<{
  exists: boolean;
  entries: UsageEntry[];
  nextCursor: OpenCodeDbCursor | null;
  partial: boolean;
  failed: boolean;
}> {
  let dbStat: StatLike | null = null;
  let walStat: StatLike | null = null;
  try {
    dbStat = await statOptionalFile(dbPath, fsPromises);
    if (!dbStat) return { exists: false, entries: [], nextCursor: null, partial: false, failed: false };
    walStat = await statOptionalFile(`${dbPath}-wal`, fsPromises);
  } catch (error) {
    laneLog.warn('opencode db stat failed', { path: dbPath, error: errorMessage(error) });
    return { exists: true, entries: [], nextCursor: cursor, partial: false, failed: true };
  }

  const walSize = walStat?.size ?? 0;
  const walMtimeMs = walStat?.mtimeMs ?? 0;
  const dbDecision = decideFileRead(
    cursor ? { size: cursor.dbSize, mtimeMs: cursor.dbMtimeMs, offset: cursor.dbSize } : null,
    dbStat,
  );
  const walUnchanged = cursor !== null && cursor.walSize === walSize && cursor.walMtimeMs === walMtimeMs;
  if (!force && cursor && !cursor.hasMore && dbDecision.action === 'skip' && walUnchanged) {
    return { exists: true, entries: [], nextCursor: cursor, partial: false, failed: false };
  }

  const shouldRestart = force || !cursor || dbDecision.action === 'restart';
  let watermarkUpdatedMs = shouldRestart ? 0 : cursor.watermarkUpdatedMs;
  let watermarkId = shouldRestart ? '' : cursor.watermarkId;
  const entries: UsageEntry[] = [];
  let hasMore = false;

  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    const tableRow = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message'").get() as { name?: string } | undefined;
    if (!tableRow?.name) {
      return {
        exists: true,
        entries: [],
        nextCursor: { dbSize: dbStat.size, dbMtimeMs: dbStat.mtimeMs, walSize, walMtimeMs, watermarkUpdatedMs, watermarkId, hasMore: false },
        partial: false,
        failed: false,
      };
    }

    const statement = database.prepare(
      "SELECT id, session_id, time_created, time_updated, data FROM message WHERE typeof(time_updated) IN ('integer', 'real') AND (time_updated > ? OR (time_updated = ? AND id > ?)) ORDER BY time_updated ASC, id ASC LIMIT ?",
    );
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const rows = statement.all(watermarkUpdatedMs, watermarkUpdatedMs, watermarkId, pageSize);
      for (const rawRow of rows) {
        const row: OpenCodeMessageRow = {
          id: String(rawRow.id ?? ''),
          session_id: String(rawRow.session_id ?? ''),
          time_created: Number(rawRow.time_created ?? 0),
          time_updated: Number(rawRow.time_updated ?? 0),
          data: String(rawRow.data ?? ''),
        };
        const entry = parseOpenCodeMessageRow(row);
        if (entry) entries.push(entry);
        watermarkUpdatedMs = Number.isFinite(row.time_updated) ? row.time_updated : watermarkUpdatedMs;
        watermarkId = row.id;
      }
      if (rows.length < pageSize) {
        hasMore = false;
        break;
      }
      hasMore = true;
      if (pageIndex + 1 < maxPages) await yieldNowFn();
    }
  } catch (error) {
    laneLog.warn('opencode db read failed', { path: dbPath, error: errorMessage(error) });
    return { exists: true, entries: [], nextCursor: cursor, partial: false, failed: true };
  } finally {
    if (database) database.close();
  }

  return {
    exists: true,
    entries,
    nextCursor: {
      dbSize: dbStat.size,
      dbMtimeMs: dbStat.mtimeMs,
      walSize,
      walMtimeMs,
      watermarkUpdatedMs,
      watermarkId,
      hasMore,
    },
    partial: hasMore,
    failed: false,
  };
}

export { readOpenCodeDbPage };
