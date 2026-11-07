import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SQLITE_FILE_MODE = 0o600;
const UNREADABLE_DATABASE_CODES = new Set([11, 26]);

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

export { isUnreadableDatabase, openDatabase, setAside };
