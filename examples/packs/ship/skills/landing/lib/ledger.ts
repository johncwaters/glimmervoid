import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type ParkedEntry = {
  v: 1;
  at: string;
  machine: string;
  repo: string;
  gitCommonDir: string;
  branch: string;
  mainline: string | null;
  commit: string;
  outcome: string;
  pushed: boolean;
  conflicts: string[];
};

export type ParsedLedger = { entries: ParkedEntry[]; unrecognizedLines: string[] };

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;

function isParkedEntry(value: unknown): value is ParkedEntry {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    entry.v === 1 &&
    typeof entry.at === "string" &&
    typeof entry.machine === "string" &&
    typeof entry.repo === "string" &&
    typeof entry.gitCommonDir === "string" &&
    typeof entry.branch === "string" &&
    (entry.mainline === null || typeof entry.mainline === "string") &&
    typeof entry.commit === "string" &&
    typeof entry.outcome === "string" &&
    typeof entry.pushed === "boolean" &&
    Array.isArray(entry.conflicts) &&
    entry.conflicts.every((conflict) => typeof conflict === "string")
  );
}

export function ledgerPath(): string {
  const configuredPath = process.env.CLAUDE_COMMIT_LEDGER;
  if (configuredPath !== undefined && isAbsolute(configuredPath)) {
    return configuredPath;
  }
  return join(homedir(), ".local", "state", "ship", "commit-ledger.jsonl");
}

export function entryPathsAreAbsolute(entry: ParkedEntry): boolean {
  return isAbsolute(entry.gitCommonDir) && isAbsolute(entry.repo);
}

function parkedEntryFromLine(line: string): ParkedEntry | null {
  try {
    const value: unknown = JSON.parse(line);
    if (isParkedEntry(value)) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseLedger(text: string): ParsedLedger {
  const entries: ParkedEntry[] = [];
  const unrecognizedLines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const entry = parkedEntryFromLine(line);
    if (entry === null) {
      unrecognizedLines.push(line);
      continue;
    }
    entries.push(entry);
  }
  return { entries, unrecognizedLines };
}

function lockPathFor(atPath: string): string {
  return `${atPath}.lock`;
}

function openLockFile(lockPath: string): number | null {
  try {
    return openSync(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return null;
  }
}

function discardStaleLock(lockPath: string): void {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs < LOCK_STALE_MS) {
      return;
    }
    unlinkSync(lockPath);
  } catch {
    return;
  }
}

function sleepBriefly(durationMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function acquireLedgerLock(atPath: string): number | null {
  try {
    mkdirSync(dirname(atPath), { recursive: true });
  } catch {
    return null;
  }
  const lockPath = lockPathFor(atPath);
  const waitUntilMs = Date.now() + LOCK_WAIT_MS;
  let lockDescriptor = openLockFile(lockPath);
  while (lockDescriptor === null && Date.now() < waitUntilMs) {
    discardStaleLock(lockPath);
    sleepBriefly(LOCK_RETRY_MS);
    lockDescriptor = openLockFile(lockPath);
  }
  return lockDescriptor;
}

function releaseLedgerLock(lockDescriptor: number, lockPath: string): void {
  try {
    closeSync(lockDescriptor);
  } catch {
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    return;
  }
}

export function withLedgerLock<T>(atPath: string, run: () => T): T | null {
  const lockDescriptor = acquireLedgerLock(atPath);
  if (lockDescriptor === null) {
    return null;
  }
  try {
    return run();
  } finally {
    releaseLedgerLock(lockDescriptor, lockPathFor(atPath));
  }
}

function appendEntryLine(entry: ParkedEntry, atPath: string): boolean {
  let ledgerDescriptor: number | null = null;
  try {
    ledgerDescriptor = openSync(
      atPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    const entryLine = `${JSON.stringify(entry)}\n`;
    if (writeSync(ledgerDescriptor, entryLine) !== Buffer.byteLength(entryLine)) {
      throw new Error("ledger append write was incomplete");
    }
    closeSync(ledgerDescriptor);
    return true;
  } catch {
    if (ledgerDescriptor !== null) {
      try {
        closeSync(ledgerDescriptor);
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function appendParkedEntry(entry: ParkedEntry, atPath = ledgerPath()): boolean {
  return withLedgerLock(atPath, () => appendEntryLine(entry, atPath)) === true;
}

function writeLedgerFile(
  entries: ParkedEntry[],
  atPath: string,
  unrecognizedLines: string[] = [],
): boolean {
  const temporaryPath = `${atPath}.${process.pid}`;
  let temporaryDescriptor: number | null = null;
  try {
    mkdirSync(dirname(atPath), { recursive: true });
    temporaryDescriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const lines = [...entries.map((entry) => JSON.stringify(entry)), ...unrecognizedLines];
    const ledgerText = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    if (writeSync(temporaryDescriptor, ledgerText) !== Buffer.byteLength(ledgerText)) {
      throw new Error("ledger write was incomplete");
    }
    closeSync(temporaryDescriptor);
    temporaryDescriptor = null;
    renameSync(temporaryPath, atPath);
    return true;
  } catch {
    if (temporaryDescriptor !== null) {
      try {
        closeSync(temporaryDescriptor);
      } catch {
        return false;
      }
    }
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      return false;
    }
    return false;
  }
}

function readLedgerText(atPath: string): string {
  try {
    return readFileSync(atPath, "utf8");
  } catch {
    return "";
  }
}

export function compactLedger(
  atPath: string,
  isDropped: (entry: ParkedEntry) => boolean,
): boolean {
  if (!existsSync(atPath)) {
    return true;
  }
  const compacted = withLedgerLock(atPath, () => {
    const current = parseLedger(readLedgerText(atPath));
    const keptEntries = current.entries.filter((entry) => !isDropped(entry));
    if (keptEntries.length === current.entries.length) {
      return true;
    }
    return writeLedgerFile(keptEntries, atPath, current.unrecognizedLines);
  });
  return compacted === true;
}

function branchKey(target: { gitCommonDir: string; branch: string }): string {
  return JSON.stringify([target.gitCommonDir, target.branch]);
}

function parkedAtMs(entry: ParkedEntry): number {
  const parsedMs = Date.parse(entry.at);
  return Number.isFinite(parsedMs) ? parsedMs : 0;
}

export function entryKey(entry: ParkedEntry): string {
  return JSON.stringify([entry.at, entry.gitCommonDir, entry.branch, entry.commit]);
}

export function newestEntryPerBranch(entries: ParkedEntry[]): Set<ParkedEntry> {
  const newestByBranch = new Map<string, ParkedEntry>();
  for (const entry of entries) {
    const previous = newestByBranch.get(branchKey(entry));
    if (previous === undefined || parkedAtMs(entry) >= parkedAtMs(previous)) {
      newestByBranch.set(branchKey(entry), entry);
    }
  }
  return new Set(newestByBranch.values());
}

export function supersededKeys(
  entries: ParkedEntry[],
  newestEntries: Set<ParkedEntry>,
): Set<string> {
  const newestKeys = new Set(Array.from(newestEntries, entryKey));
  const superseded = new Set<string>();
  for (const entry of entries) {
    if (newestEntries.has(entry) || newestKeys.has(entryKey(entry))) {
      continue;
    }
    superseded.add(entryKey(entry));
  }
  return superseded;
}

export function dropParkedEntries(
  target: { gitCommonDir: string; branch: string },
  atPath = ledgerPath(),
): boolean {
  return compactLedger(atPath, (entry) => branchKey(entry) === branchKey(target));
}
