import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage, isMissingFileError } from '../shared/text.ts';
import { nextBackoffMs } from '../shared/backoff.ts';
import { createKeyedSerialQueue, createSerialQueue } from './spawn-gate.ts';

interface AtomicWriteFileOptions {
  encoding: BufferEncoding;
  mode?: number;
  flag?: string;
}

interface SyncFileSystem {
  mkdirSync?: (dirPath: string, options: { recursive: true }) => unknown;
  writeFileSync: (filePath: string, data: string, options: AtomicWriteFileOptions) => void;
  renameSync: (from: string, to: string) => void;
  rmSync: (filePath: string, options: { force: boolean }) => void;
  chmodSync?: (filePath: string, mode: number) => void;
}

interface AsyncFileSystem {
  mkdir?: (dirPath: string, options: { recursive: true }) => Promise<unknown>;
  writeFile: (filePath: string, data: string, options: AtomicWriteFileOptions) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (filePath: string, options: { force: boolean }) => Promise<void>;
  chmod?: (filePath: string, mode: number) => Promise<void>;
  appendFile?: (filePath: string, data: string, options: AtomicWriteFileOptions) => Promise<void>;
}

interface JsonStateLoadFileSystem {
  readFile: (filePath: string, encoding: 'utf8') => Promise<string>;
  rename?: (from: string, to: string) => Promise<void>;
}

interface JsonStateLoadSyncFileSystem {
  readFileSync: (filePath: string, encoding: 'utf8') => string;
  renameSync?: (from: string, to: string) => void;
}

type JsonStateFileSystem = AsyncFileSystem & JsonStateLoadFileSystem;

type JsonStateLoadOutcome<T> =
  | { status: 'missing' }
  | { status: 'loaded'; value: T }
  | { status: 'corrupt'; error: unknown }
  | { status: 'quarantined'; movedTo: string }
  | { status: 'unreadable'; error: unknown };

interface JsonStateLoadPolicy {
  quarantine?: boolean;
  includeNotDir?: boolean;
}

interface AtomicWritePolicy {
  mode?: number;
  encoding?: BufferEncoding;
  mkdir?: boolean;
  exclusive?: boolean;
  enforceMode?: boolean;
}

interface SyncWriteOptions extends AtomicWritePolicy {
  fsSync?: SyncFileSystem;
}

interface AsyncWriteOptions extends AtomicWritePolicy {
  fsPromises?: AsyncFileSystem;
}

interface AppendOptions {
  mode?: number;
  encoding?: BufferEncoding;
  mkdir?: boolean;
  fsPromises?: AsyncFileSystem;
}

function tmpPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
}

function writeOptions(mode: number | undefined, encoding: BufferEncoding, exclusive: boolean): AtomicWriteFileOptions {
  return { encoding, ...(mode == null ? {} : { mode }), ...(exclusive ? { flag: 'wx' } : {}) };
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_BASE_MS = 10;
const RENAME_RETRY_MAX_MS = 50;

function renameRetryDelayMs(attempt: number): number {
  return nextBackoffMs({ attempt: attempt + 1, baseMs: RENAME_RETRY_BASE_MS, maxMs: RENAME_RETRY_MAX_MS, jitter: 'none' });
}

function isRetryableRename(error: unknown, attempt: number): boolean {
  if (attempt >= RENAME_ATTEMPTS - 1) return false;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RENAME_RETRY_CODES.has(code);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameRetryPlan(error: unknown, attempt: number): number | null {
  if (!isRetryableRename(error, attempt)) return null;
  return renameRetryDelayMs(attempt);
}

function decodeJsonState<T>(text: string, parse: (raw: unknown) => T | null): { value: T } | { error: unknown } {
  try {
    const value = parse(JSON.parse(text));
    if (value !== null) return { value };
    return { error: new Error('the parser rejected the file content') };
  } catch (error) {
    return { error };
  }
}

async function loadJsonStateFile<T>({ filePath, fsPromises = fs.promises, parse, nowMs = Date.now, quarantine = true, includeNotDir = true }: JsonStateLoadPolicy & {
  filePath: string;
  fsPromises?: JsonStateLoadFileSystem;
  parse: (raw: unknown) => T | null;
  nowMs?: () => number;
}): Promise<JsonStateLoadOutcome<T>> {
  let text: string;
  try {
    text = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error, { includeNotDir })) return { status: 'missing' };
    return { status: 'unreadable', error };
  }

  const decoded = decodeJsonState(text, parse);
  if ('value' in decoded) return { status: 'loaded', value: decoded.value };
  if (!quarantine || !fsPromises.rename) return { status: 'corrupt', error: decoded.error };

  const movedTo = `${filePath}.corrupt-${nowMs()}`;
  try {
    await fsPromises.rename(filePath, movedTo);
  } catch (error) {
    return { status: 'unreadable', error };
  }
  return { status: 'quarantined', movedTo };
}

function loadJsonStateFileSync<T>({ filePath, fsSync = fs, parse, nowMs = Date.now, quarantine = true, includeNotDir = true }: JsonStateLoadPolicy & {
  filePath: string;
  fsSync?: JsonStateLoadSyncFileSystem;
  parse: (raw: unknown) => T | null;
  nowMs?: () => number;
}): JsonStateLoadOutcome<T> {
  let text: string;
  try {
    text = fsSync.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error, { includeNotDir })) return { status: 'missing' };
    return { status: 'unreadable', error };
  }

  const decoded = decodeJsonState(text, parse);
  if ('value' in decoded) return { status: 'loaded', value: decoded.value };
  if (!quarantine || !fsSync.renameSync) return { status: 'corrupt', error: decoded.error };

  const movedTo = `${filePath}.corrupt-${nowMs()}`;
  try {
    fsSync.renameSync(filePath, movedTo);
  } catch (error) {
    return { status: 'unreadable', error };
  }
  return { status: 'quarantined', movedTo };
}

function loadedJsonValue<T>(outcome: JsonStateLoadOutcome<T>): T | null {
  return outcome.status === 'loaded' ? outcome.value : null;
}

function jsonStateLoadError(outcome: JsonStateLoadOutcome<unknown>): unknown {
  if ('error' in outcome) return outcome.error;
  return new Error(`the state file is ${outcome.status}`);
}

function renameWithRetrySync(fsSync: SyncFileSystem, tmpPath: string, filePath: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fsSync.renameSync(tmpPath, filePath);
      return;
    } catch (error) {
      const delayMs = renameRetryPlan(error, attempt);
      if (delayMs === null) throw error;
      sleepSync(delayMs);
    }
  }
}

async function renameWithRetry(fsPromises: AsyncFileSystem, tmpPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsPromises.rename(tmpPath, filePath);
      return;
    } catch (error) {
      const delayMs = renameRetryPlan(error, attempt);
      if (delayMs === null) throw error;
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    }
  }
}

function mkdirSyncOf(fsSync: SyncFileSystem): NonNullable<SyncFileSystem['mkdirSync']> {
  if (!fsSync.mkdirSync) throw new Error('the file system cannot create directories');
  return fsSync.mkdirSync;
}

function mkdirOf(fsPromises: AsyncFileSystem): NonNullable<AsyncFileSystem['mkdir']> {
  if (!fsPromises.mkdir) throw new Error('the file system cannot create directories');
  return fsPromises.mkdir;
}

function appendFileOf(fsPromises: AsyncFileSystem): NonNullable<AsyncFileSystem['appendFile']> {
  if (!fsPromises.appendFile) throw new Error('the file system cannot append to files');
  return fsPromises.appendFile;
}

function writeTextAtomicSync(filePath: string, content: string, {
  mode, encoding = 'utf8', mkdir = false, exclusive = false, enforceMode = false, fsSync = fs,
}: SyncWriteOptions = {}): void {
  if (mkdir) mkdirSyncOf(fsSync)(path.dirname(filePath), { recursive: true });
  const tmpPath = tmpPathFor(filePath);
  try {
    fsSync.writeFileSync(tmpPath, content, writeOptions(mode, encoding, exclusive));
    renameWithRetrySync(fsSync, tmpPath, filePath);
  } catch (error) {
    try {
      fsSync.rmSync(tmpPath, { force: true });
    } catch {}
    throw error;
  }
  if (!enforceMode || mode == null || !fsSync.chmodSync) return;
  try {
    fsSync.chmodSync(filePath, mode);
  } catch {}
}

function writeJsonAtomicSync(filePath: string, value: unknown, options?: SyncWriteOptions): void {
  writeTextAtomicSync(filePath, JSON.stringify(value, null, 2), options);
}

async function writeTextAtomic(filePath: string, content: string, {
  mode, encoding = 'utf8', mkdir = false, exclusive = false, enforceMode = false, fsPromises = fs.promises,
}: AsyncWriteOptions = {}): Promise<void> {
  if (mkdir) await mkdirOf(fsPromises)(path.dirname(filePath), { recursive: true });
  const tmpPath = tmpPathFor(filePath);
  try {
    await fsPromises.writeFile(tmpPath, content, writeOptions(mode, encoding, exclusive));
    await renameWithRetry(fsPromises, tmpPath, filePath);
  } catch (error) {
    try {
      await fsPromises.rm(tmpPath, { force: true });
    } catch {}
    throw error;
  }
  if (!enforceMode || mode == null || !fsPromises.chmod) return;
  try {
    await fsPromises.chmod(filePath, mode);
  } catch {}
}

async function writeJsonAtomic(filePath: string, value: unknown, options?: AsyncWriteOptions): Promise<void> {
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2), options);
}

const appendQueue = createKeyedSerialQueue();

function appendChained(filePath: string, payload: string, {
  fsPromises = fs.promises, mkdir = false, encoding = 'utf8', mode,
}: AppendOptions = {}): Promise<void> {
  return appendQueue.run(filePath, async () => {
    if (mkdir) await mkdirOf(fsPromises)(path.dirname(filePath), { recursive: true });
    await appendFileOf(fsPromises)(filePath, payload, writeOptions(mode, encoding, false));
  });
}

function appendJsonLine(filePath: string, value: unknown, options?: AppendOptions): Promise<void> {
  return appendChained(filePath, `${JSON.stringify(value)}\n`, options);
}

function appendJsonLines(filePath: string, values: unknown[], options?: AppendOptions): Promise<void> {
  if (values.length === 0) return Promise.resolve();
  return appendChained(filePath, values.map((value) => `${JSON.stringify(value)}\n`).join(''), options);
}

interface JsonStateWriter {
  write(subject: unknown, buildPayload: () => string): Promise<void>;
  reset(): void;
  idle(): Promise<void>;
}

function createJsonStateWriter({ filePath, fsPromises = fs.promises, warn = () => {} }: {
  filePath: string;
  fsPromises?: AsyncFileSystem;
  warn?: (error: unknown) => void;
}): JsonStateWriter {
  let signature: string | null = null;
  const writeQueue = createSerialQueue();

  async function commit(payload: string): Promise<void> {
    try {
      await writeTextAtomic(filePath, payload, { fsPromises, mkdir: true });
    } catch (error) {
      warn(error);
      signature = null;
    }
  }

  async function write(subject: unknown, buildPayload: () => string): Promise<void> {
    const next = JSON.stringify(subject);
    if (next === signature) return;
    signature = next;
    await writeQueue.run(() => commit(buildPayload())).catch(() => {});
  }

  function reset(): void {
    signature = null;
  }

  return { write, reset, idle: () => writeQueue.idle() };
}

interface JsonStateStore {
  load(): Promise<void>;
  write(subject: unknown, buildPayload: () => string): Promise<void>;
  idle(): Promise<void>;
}

function createJsonStateStore<T>({
  name,
  filePath,
  fsPromises = fs.promises,
  parse,
  adopt,
  nowMs = Date.now,
  warn = () => {},
}: {
  name: string;
  filePath: string | null;
  fsPromises?: JsonStateFileSystem;
  parse: (raw: unknown) => T | null;
  adopt: (loadedValue: T | null) => void;
  nowMs?: () => number;
  warn?: (message: string, fields: Record<string, string>) => void;
}): JsonStateStore {
  const writer = filePath
    ? createJsonStateWriter({
      filePath,
      fsPromises,
      warn: (error: unknown) => warn(`${name} write failed`, { error: errorMessage(error) }),
    })
    : null;
  let isFileReadable = true;
  let loadPromise: Promise<void> | null = null;

  function load(): Promise<void> {
    const statePath = filePath;
    if (!statePath) return Promise.resolve();
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const outcome = await loadJsonStateFile({ filePath: statePath, fsPromises, parse, nowMs });
      if (outcome.status === 'unreadable' || outcome.status === 'corrupt') {
        isFileReadable = false;
        loadPromise = null;
        warn(`${name} unreadable`, { path: statePath, error: errorMessage(outcome.error) });
        return;
      }
      if (outcome.status === 'quarantined') warn(`${name} quarantined`, { path: statePath, movedTo: outcome.movedTo });
      isFileReadable = true;
      adopt(loadedJsonValue(outcome));
      writer?.reset();
    })();
    return loadPromise;
  }

  async function write(subject: unknown, buildPayload: () => string): Promise<void> {
    if (!writer || !isFileReadable) return;
    await writer.write(subject, buildPayload);
  }

  return { load, write, idle: () => (writer ? writer.idle() : Promise.resolve()) };
}

export {
  appendJsonLine,
  appendJsonLines,
  createJsonStateStore,
  createJsonStateWriter,
  jsonStateLoadError,
  loadJsonStateFile,
  loadJsonStateFileSync,
  loadedJsonValue,
  sleepSync,
  writeJsonAtomic,
  writeJsonAtomicSync,
  writeTextAtomic,
  writeTextAtomicSync,
};
export type {
  AppendOptions,
  AsyncFileSystem,
  AsyncWriteOptions,
  JsonStateLoadOutcome,
  JsonStateLoadSyncFileSystem,
  JsonStateStore,
  JsonStateWriter,
  SyncFileSystem,
  SyncWriteOptions,
};
