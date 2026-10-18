import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAdapter } from '../../session/adapters/index.ts';
import type { Session } from '../../session/sessions.ts';
import type { CoherenceJournalEntry, CoherenceJournalReading, CoherenceRegulationReading, SessionCoherence } from '../../shared/contracts/coherence.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { COHERENCE_CONFIG_FILENAME, unreadableConfigEntry } from '../core/coherence-config-core.ts';
import type { CoherenceConfigEntry } from '../core/coherence-config-core.ts';
import {
  appendJournalWindow, changedPathsFromPorcelainStatus, COHERENCE_FEED_UNAVAILABLE, attachedCoherenceHost, journalFileNames, nextActionFromRegulateOutput,
  parseJournalLines, regulateArgs, regulationFromConfig, selectLatestShownEntry,
} from '../core/coherence-feed-core.ts';
import type { JournalSource } from '../core/coherence-feed-core.ts';
import { firstLine } from '../core/text-core.ts';
import { factoryGitEnvironment } from '../git/git-workspace.ts';
import { prepareGuardrailsLaunch } from '../guardrails/guardrails-launch.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import { createCoherenceRuntime } from './coherence-runtime.ts';

type CoherenceFeedSession = Pick<Session, 'id' | 'resumeSessionId' | 'baseSha' | 'factoryRole' | 'ephemeral' | 'agentId'> & {
  effectiveCwd(): string;
  on(event: 'exit', listener: () => void): unknown;
};

interface JournalCursor {
  offset: number;
  dev: number;
  ino: number;
}

interface SessionFeedState {
  isClosed: boolean;
  coherenceSessionId: string | null;
  cursors: Map<string, JournalCursor>;
  window: CoherenceJournalEntry[];
  published: SessionCoherence | null;
  debounceTimer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  isRerunWanted: boolean;
}

type FileRead =
  | { kind: 'missing' }
  | { kind: 'refused' }
  | { kind: 'read'; bytes: Buffer; start: number; size: number; isTail: boolean; cursor: Omit<JournalCursor, 'offset'> };

interface CoherenceSessionFeedOptions {
  broadcastControl: (message: ServerMessageOf<'session-coherence'>) => void;
  getConfig: () => { coherence?: { enabled?: unknown } | null };
  cliPath?: string | null;
  debounceMs?: number;
  timeoutMs?: number;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}

const JOURNAL_READ_MAX_BYTES = 1024 * 1024;
const CONFIG_READ_MAX_BYTES = 256 * 1024;
const REGULATE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_MAX_FILES = 20_000;
const SNAPSHOT_MAX_ALTERNATES = 8;
const SNAPSHOT_FILE_MODE_MASK = 0o755;
const SNAPSHOT_GIT_TIMEOUT_MS = 30_000;
const SNAPSHOT_GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const NEWLINE_BYTE = 0x0a;
const NO_FOLLOW_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const JOURNAL_DIRECTORIES: Record<JournalSource, string> = { decisions: 'decisions', defects: 'defects' };

async function lstatOrNull(candidatePath: string) {
  return lstat(candidatePath).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
}

async function isRealDirectory(candidatePath: string): Promise<boolean | null> {
  const entry = await lstatOrNull(candidatePath);
  if (!entry) return null;
  return entry.isDirectory() && !entry.isSymbolicLink();
}

async function readRegularFileNoFollow(filePath: string, { fromOffset, maxBytes }: { fromOffset: number; maxBytes: number }): Promise<FileRead> {
  const entry = await lstatOrNull(filePath);
  if (!entry) return { kind: 'missing' };
  if (entry.isSymbolicLink() || !entry.isFile()) return { kind: 'refused' };
  const handle = await open(filePath, NO_FOLLOW_READ_FLAGS).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (!handle) return { kind: 'missing' };
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== entry.ino || opened.dev !== entry.dev) return { kind: 'refused' };
    const size = opened.size;
    const wantedStart = fromOffset > size ? 0 : fromOffset;
    const start = Math.max(wantedStart, size - maxBytes);
    const bytes = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { kind: 'read', bytes: bytes.subarray(0, filled), start, size, isTail: start > wantedStart, cursor: { dev: opened.dev, ino: opened.ino } };
  } finally {
    await handle.close();
  }
}

async function readCoherenceConfigEntry(cwd: string): Promise<CoherenceConfigEntry> {
  const configPath = path.join(cwd, COHERENCE_CONFIG_FILENAME);
  const unreadable = unreadableConfigEntry(await lstatOrNull(configPath));
  if (unreadable) return unreadable;
  const read = await readRegularFileNoFollow(configPath, { fromOffset: 0, maxBytes: CONFIG_READ_MAX_BYTES + 1 });
  if (read.kind === 'missing') return { kind: 'missing' };
  if (read.kind === 'refused') return { kind: 'not-a-file' };
  if (read.size > CONFIG_READ_MAX_BYTES) return { kind: 'too-large' };
  return { kind: 'file', text: read.bytes.toString('utf8') };
}

function completeLines(read: Extract<FileRead, { kind: 'read' }>): { text: string; nextOffset: number } {
  const firstLineStart = read.isTail ? read.bytes.indexOf(NEWLINE_BYTE) + 1 : 0;
  const lastNewline = read.bytes.lastIndexOf(NEWLINE_BYTE);
  if (lastNewline < firstLineStart) return { text: '', nextOffset: read.isTail ? read.size : read.start };
  return { text: read.bytes.subarray(firstLineStart, lastNewline + 1).toString('utf8'), nextOffset: read.start + lastNewline + 1 };
}

function regulateFailureStdout(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const exitCode: unknown = Reflect.get(error, 'code');
  const stdout: unknown = Reflect.get(error, 'stdout');
  if (typeof exitCode !== 'number' || typeof stdout !== 'string' || stdout.trim() === '') return null;
  return stdout;
}

function wasKilledByTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'killed') === true;
}

function coherenceEnv(gitEnvironment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(gitEnvironment).filter(([key]) => !key.startsWith('COHERENCE_') && key !== 'CODEX_THREAD_ID'));
}

type SessionSnapshot =
  | { ok: true; root: string; cwd: string; readDenied: string[]; objectDirs: string[] }
  | { ok: false; reason: string };

async function gitText(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env, timeout: SNAPSHOT_GIT_TIMEOUT_MS, maxBuffer: SNAPSHOT_GIT_MAX_BUFFER_BYTES, encoding: 'utf8' });
  return stdout;
}

async function isRealDirectoryChainUnder(root: string, relativeDirectory: string, { isCreating }: { isCreating: boolean }): Promise<boolean> {
  let current = root;
  for (const segment of relativeDirectory === '.' ? [] : relativeDirectory.split('/')) {
    current = path.join(current, segment);
    const entry = await lstatOrNull(current);
    if (entry === null && !isCreating) return false;
    if (entry === null) {
      await mkdir(current);
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
  }
  return true;
}

async function isSourceParentInsideTree(realTop: string, relativePath: string): Promise<boolean | null> {
  const expectedParent = path.join(realTop, path.posix.dirname(relativePath));
  const realParent = await realpath(expectedParent).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (realParent === null) return null;
  return realParent === expectedParent;
}

async function removeFromSnapshot(snapshotRoot: string, relativePath: string): Promise<void> {
  if (!await isRealDirectoryChainUnder(snapshotRoot, path.posix.dirname(relativePath), { isCreating: false })) return;
  const destinationPath = path.join(snapshotRoot, relativePath);
  const existing = await lstatOrNull(destinationPath);
  if (existing === null || existing.isDirectory()) return;
  await rm(destinationPath, { force: true });
}

async function overlayChangedFile(realTop: string, snapshotRoot: string, relativePath: string, remainingBytes: number): Promise<number | 'too-large'> {
  const isParentInside = await isSourceParentInsideTree(realTop, relativePath);
  if (isParentInside === false) return 0;
  const sourcePath = path.join(realTop, relativePath);
  const source = isParentInside === null ? null : await lstatOrNull(sourcePath);
  if (source === null) {
    await removeFromSnapshot(snapshotRoot, relativePath);
    return 0;
  }
  if (source.isSymbolicLink() || !source.isFile()) return 0;
  if (source.size > remainingBytes) return 'too-large';
  const read = await readRegularFileNoFollow(sourcePath, { fromOffset: 0, maxBytes: remainingBytes + 1 });
  if (read.kind === 'missing') {
    await removeFromSnapshot(snapshotRoot, relativePath);
    return 0;
  }
  if (read.kind === 'refused') return 0;
  if (read.size > remainingBytes) return 'too-large';
  if (!await isRealDirectoryChainUnder(snapshotRoot, path.posix.dirname(relativePath), { isCreating: true })) return 0;
  const destinationPath = path.join(snapshotRoot, relativePath);
  const existing = await lstatOrNull(destinationPath);
  if (existing?.isDirectory()) return 0;
  await rm(destinationPath, { force: true });
  await writeFile(destinationPath, read.bytes, { flag: 'wx', mode: source.mode & SNAPSHOT_FILE_MODE_MASK });
  return read.bytes.length;
}

async function alternateObjectDirectories(snapshotRoot: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [path.join(snapshotRoot, '.git', 'objects')];
  for (let objectsDir = pending.shift(); objectsDir !== undefined && found.length < SNAPSHOT_MAX_ALTERNATES; objectsDir = pending.shift()) {
    const alternatesText = await readFile(path.join(objectsDir, 'info', 'alternates'), 'utf8').catch((error: unknown) => {
      if (isMissingFileError(error)) return '';
      throw error;
    });
    const alternateLines = alternatesText.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
    for (const alternateLine of alternateLines) {
      const alternate = await realpath(path.resolve(objectsDir, alternateLine));
      if (found.includes(alternate)) continue;
      found.push(alternate);
      pending.push(alternate);
    }
  }
  return found;
}

async function snapshotSessionTree({ cwd, snapshotRoot, env }: { cwd: string; snapshotRoot: string; env: Record<string, string> }): Promise<SessionSnapshot> {
  const realCwd = await realpath(cwd);
  const realTop = await realpath((await gitText(['rev-parse', '--show-toplevel'], realCwd, env)).trim());
  const relativeCwd = path.relative(realTop, realCwd);
  if (relativeCwd.startsWith('..') || path.isAbsolute(relativeCwd)) return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.snapshotFailed };
  const commonGitDir = await realpath((await gitText(['rev-parse', '--path-format=absolute', '--git-common-dir'], realTop, env)).trim());
  const headSha = (await gitText(['rev-parse', '--verify', 'HEAD^{commit}'], realTop, env)).trim();
  const status = await gitText(['--no-optional-locks', 'status', '-z', '--porcelain=v1', '--untracked-files=all', '--no-renames', '--ignore-submodules=all'], realTop, env);
  const changedPaths = changedPathsFromPorcelainStatus(status);
  if (changedPaths.length > SNAPSHOT_MAX_FILES) return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.snapshotTooLarge };
  await gitText(['clone', '--quiet', '--shared', '--no-checkout', realTop, snapshotRoot], path.dirname(snapshotRoot), env);
  await gitText(['checkout', '--quiet', '--detach', headSha], snapshotRoot, env);
  let remainingBytes = SNAPSHOT_MAX_BYTES;
  for (const relativePath of changedPaths) {
    const copiedBytes = await overlayChangedFile(realTop, snapshotRoot, relativePath, remainingBytes);
    if (copiedBytes === 'too-large') return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.snapshotTooLarge };
    remainingBytes -= copiedBytes;
  }
  const objectDirs = await alternateObjectDirectories(snapshotRoot);
  return { ok: true, root: snapshotRoot, cwd: path.join(snapshotRoot, relativeCwd), readDenied: [realTop, commonGitDir], objectDirs };
}

async function nodeModulesHolding(filePath: string): Promise<string> {
  const realFile = await realpath(filePath);
  for (let current = path.dirname(realFile); path.dirname(current) !== current; current = path.dirname(current)) {
    if (path.basename(current) === 'node_modules') return current;
  }
  return path.dirname(realFile);
}

async function runInsideGuardrails({ scratch, snapshot, readablePaths, file, args, env, timeoutMs }: {
  scratch: string; snapshot: Extract<SessionSnapshot, { ok: true }>; readablePaths: string[]; file: string; args: string[]; env: Record<string, string>; timeoutMs: number;
}): Promise<string | null> {
  const tempDir = path.join(scratch, 'tmp');
  await mkdir(tempDir);
  const prepared = await prepareGuardrailsLaunch({
    role: {
      vendors: [], vendorHome: { scope: 'state' }, network: { access: 'none' }, writableRoots: [snapshot.root],
      lockedCheckouts: [], commitCheckouts: [], readDenied: snapshot.readDenied, readableWithinDenied: [...snapshot.objectDirs, ...readablePaths],
    },
    launchId: path.basename(scratch),
    tempDir,
    enterDir: snapshot.cwd,
  });
  if (!prepared.ok) return null;
  try {
    const wrapped = await prepared.launch.wrap(file, args, { hasTerminal: false });
    const { stdout } = await execFileAsync(wrapped.file, wrapped.args, {
      cwd: prepared.launch.cwd, env: { ...env, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir, ...prepared.launch.env },
      timeout: timeoutMs, maxBuffer: REGULATE_MAX_BUFFER_BYTES, encoding: 'utf8',
    });
    return stdout;
  } finally {
    await prepared.launch.dispose();
  }
}

function createCoherenceSessionFeed({
  broadcastControl, getConfig, cliPath = createCoherenceRuntime().cliPath, debounceMs = 1500, timeoutMs = 30_000, now = Date.now, log = console,
}: CoherenceSessionFeedOptions) {
  const states = new Map<string, SessionFeedState>();

  function stateOf(sessionId: string): SessionFeedState {
    const existing = states.get(sessionId);
    if (existing) return existing;
    const created: SessionFeedState = {
      isClosed: false, coherenceSessionId: null, cursors: new Map(), window: [], published: null, debounceTimer: null, inFlight: null, isRerunWanted: false,
    };
    states.set(sessionId, created);
    return created;
  }

  function forget(sessionId: string): void {
    const state = states.get(sessionId);
    if (!state) return;
    state.isClosed = true;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    states.delete(sessionId);
  }

  function publish(session: CoherenceFeedSession, state: SessionFeedState, coherence: Omit<SessionCoherence, 'updatedAt'>): void {
    if (state.isClosed) return;
    state.published = { ...coherence, updatedAt: now() };
    broadcastControl({ type: 'session-coherence', id: session.id, ...state.published });
  }

  async function attachedHost(session: CoherenceFeedSession, cwd: string): Promise<'claude' | 'codex' | null> {
    const configEntry = await readCoherenceConfigEntry(cwd).catch((): CoherenceConfigEntry => ({ kind: 'not-a-file' }));
    return attachedCoherenceHost({
      host: getAdapter(session.agentId)?.usageVendor, factoryRole: session.factoryRole, isEphemeral: session.ephemeral,
      isSettingOn: getConfig().coherence?.enabled === true, hasRepoConfig: configEntry.kind !== 'missing',
    });
  }

  async function readJournalFile(state: SessionFeedState, filePath: string, source: JournalSource, coherenceSessionId: string): Promise<'ok' | 'refused'> {
    const cursor = state.cursors.get(filePath);
    const read = await readRegularFileNoFollow(filePath, { fromOffset: cursor?.offset ?? 0, maxBytes: JOURNAL_READ_MAX_BYTES });
    if (read.kind === 'missing') {
      state.cursors.delete(filePath);
      return 'ok';
    }
    if (read.kind === 'refused') return 'refused';
    const isSameFile = cursor !== undefined && cursor.dev === read.cursor.dev && cursor.ino === read.cursor.ino;
    const reread = isSameFile ? read : await readRegularFileNoFollow(filePath, { fromOffset: 0, maxBytes: JOURNAL_READ_MAX_BYTES });
    if (reread.kind === 'missing') return 'ok';
    if (reread.kind === 'refused') return 'refused';
    const { text, nextOffset } = completeLines(reread);
    state.cursors.set(filePath, { ...reread.cursor, offset: nextOffset });
    state.window = appendJournalWindow(state.window, parseJournalLines(text, source, coherenceSessionId));
    return 'ok';
  }

  async function refreshJournal(state: SessionFeedState, cwd: string, coherenceSessionId: string | null): Promise<CoherenceJournalReading> {
    if (coherenceSessionId !== state.coherenceSessionId) {
      state.coherenceSessionId = coherenceSessionId;
      state.cursors.clear();
      state.window = [];
    }
    if (coherenceSessionId === null) return { ok: true, latest: null };
    const coherenceDir = path.join(cwd, '.coherence');
    const isCoherenceDirReal = await isRealDirectory(coherenceDir);
    if (isCoherenceDirReal === null) return { ok: true, latest: selectLatestShownEntry(state.window) };
    if (!isCoherenceDirReal) return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.journalNotAFile };
    const fileNames = journalFileNames(coherenceSessionId);
    for (const source of ['decisions', 'defects'] as const) {
      const sourceDir = path.join(coherenceDir, JOURNAL_DIRECTORIES[source]);
      const isSourceDirReal = await isRealDirectory(sourceDir);
      if (isSourceDirReal === null) continue;
      if (!isSourceDirReal) return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.journalNotAFile };
      for (const fileName of fileNames[source]) {
        if (await readJournalFile(state, path.join(sourceDir, fileName), source, coherenceSessionId) === 'refused') {
          return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.journalNotAFile };
        }
      }
    }
    return { ok: true, latest: selectLatestShownEntry(state.window) };
  }

  async function snapshotFor(session: CoherenceFeedSession, cwd: string, snapshotRoot: string, env: Record<string, string>): Promise<SessionSnapshot> {
    try {
      return await snapshotSessionTree({ cwd, snapshotRoot, env });
    } catch (error) {
      log.warn(`[coherence-feed] snapshot failed for session ${session.id}: ${firstLine(errorMessage(error))}`);
      return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.snapshotFailed };
    }
  }

  async function regulateInSnapshot(session: CoherenceFeedSession, cwd: string, host: 'claude' | 'codex', resolvedCliPath: string, scratch: string): Promise<CoherenceRegulationReading> {
    const env = coherenceEnv(await factoryGitEnvironment(cwd));
    const snapshot = await snapshotFor(session, cwd, path.join(scratch, 'snapshot'), env);
    if (!snapshot.ok) return snapshot;
    const configRefusal = regulationFromConfig(await readCoherenceConfigEntry(snapshot.cwd));
    if (configRefusal) return configRefusal;
    const readablePaths = [await nodeModulesHolding(resolvedCliPath), await realpath(process.execPath)];
    const args = [resolvedCliPath, ...regulateArgs({ host, baseSha: session.baseSha })];
    const stdout = await runInsideGuardrails({ scratch, snapshot, readablePaths, file: process.execPath, args, env, timeoutMs });
    if (stdout === null) return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.guardrails };
    return nextActionFromRegulateOutput(stdout);
  }

  async function regulationReadingFor(session: CoherenceFeedSession, cwd: string, host: 'claude' | 'codex'): Promise<CoherenceRegulationReading> {
    if (!cliPath) return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.noCli };
    const scratch = await makeHostScratchDirectory('coherence-regulate-');
    try {
      return await regulateInSnapshot(session, cwd, host, cliPath, scratch);
    } catch (error) {
      const finishedStdout = regulateFailureStdout(error);
      if (finishedStdout !== null) return nextActionFromRegulateOutput(finishedStdout);
      log.warn(`[coherence-feed] regulate failed for session ${session.id}: ${firstLine(errorMessage(error))}`);
      return { ok: false, reason: wasKilledByTimeout(error) ? COHERENCE_FEED_UNAVAILABLE.timedOut : COHERENCE_FEED_UNAVAILABLE.failed };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async function journalReadingFor(state: SessionFeedState, cwd: string, session: CoherenceFeedSession): Promise<CoherenceJournalReading> {
    try {
      return await refreshJournal(state, cwd, session.resumeSessionId);
    } catch (error) {
      log.warn(`[coherence-feed] journal read failed for session ${session.id}: ${firstLine(errorMessage(error))}`);
      return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.journalUnreadable };
    }
  }

  async function refreshOnce(session: CoherenceFeedSession, state: SessionFeedState): Promise<void> {
    const cwd = session.effectiveCwd();
    const host = await attachedHost(session, cwd);
    if (!host || state.isClosed) return;
    const journal = await journalReadingFor(state, cwd, session);
    const regulation = await regulationReadingFor(session, cwd, host);
    publish(session, state, { journal, regulation });
  }

  function refresh(session: CoherenceFeedSession, state: SessionFeedState): void {
    if (state.inFlight) {
      state.isRerunWanted = true;
      return;
    }
    state.inFlight = (async () => {
      do {
        state.isRerunWanted = false;
        await refreshOnce(session, state).catch((error: unknown) => log.warn(`[coherence-feed] refresh failed for session ${session.id}: ${firstLine(errorMessage(error))}`));
      } while (state.isRerunWanted && !state.isClosed);
    })().finally(() => {
      state.inFlight = null;
    });
  }

  function onTurnEnd(session: CoherenceFeedSession): void {
    const state = stateOf(session.id);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      refresh(session, state);
    }, debounceMs);
    state.debounceTimer.unref();
  }

  function attachSession(session: CoherenceFeedSession): void {
    session.on('exit', () => forget(session.id));
  }

  async function readJournal(session: CoherenceFeedSession): Promise<{ ok: true; entries: CoherenceJournalEntry[] } | { ok: false; error: string }> {
    const cwd = session.effectiveCwd();
    if (!await attachedHost(session, cwd)) return { ok: false, error: 'Coherence is not attached to this session' };
    const state = stateOf(session.id);
    const journal = await journalReadingFor(state, cwd, session);
    if (!journal.ok) return { ok: false, error: journal.reason };
    return { ok: true, entries: [...state.window] };
  }

  function snapshotMessage(): ServerMessageOf<'session-coherence-snapshot'> {
    const sessions: Record<string, SessionCoherence> = {};
    for (const [sessionId, state] of states) {
      if (state.published) sessions[sessionId] = state.published;
    }
    return { type: 'session-coherence-snapshot', sessions };
  }

  return { attachSession, onTurnEnd, readJournal, snapshotMessage };
}

type CoherenceSessionFeed = ReturnType<typeof createCoherenceSessionFeed>;

export { createCoherenceSessionFeed };
export type { CoherenceSessionFeed };
