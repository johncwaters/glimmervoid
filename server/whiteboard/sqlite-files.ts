import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SQLITE_FILE_MODE = 0o600;
const UNREADABLE_DATABASE_CODES = new Set([11, 26]);
const BULK_TRANSACTION_ROWS = 1000;

function openDatabase(databasePath: string, schema: string): DatabaseSync {
  fs.closeSync(fs.openSync(databasePath, 'a', SQLITE_FILE_MODE));
  fs.chmodSync(databasePath, SQLITE_FILE_MODE);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(schema);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function totalChangesOf(database: DatabaseSync): number {
  const totalChanges: unknown = Reflect.get(database.prepare('SELECT total_changes() AS total').get() ?? {}, 'total');
  return typeof totalChanges === 'number' ? totalChanges : 0;
}

function committed<Value>(database: DatabaseSync, work: () => Value): Value {
  database.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function truncateWriteAheadLogLikeAutocheckpoint(database: DatabaseSync): void {
  try {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    return;
  }
}

function inTransaction<Value>(database: DatabaseSync, work: () => Value): Value {
  const changesBefore = totalChangesOf(database);
  const value = committed(database, work);
  if (totalChangesOf(database) - changesBefore >= BULK_TRANSACTION_ROWS) truncateWriteAheadLogLikeAutocheckpoint(database);
  return value;
}

function isUnreadableDatabase(error: unknown): boolean {
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'errcode') : undefined;
  return typeof code === 'number' && UNREADABLE_DATABASE_CODES.has(code);
}

function setAside(databasePath: string): void {
  const setAsidePath = `${databasePath}.corrupt-${Date.now()}`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(`${databasePath}${suffix}`)) fs.renameSync(`${databasePath}${suffix}`, `${setAsidePath}${suffix}`);
  }
}

export { committed, inTransaction, isUnreadableDatabase, openDatabase, setAside, truncateWriteAheadLogLikeAutocheckpoint };
