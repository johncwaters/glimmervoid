import { realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { getAdapter } from '../../session/adapters/index.ts';
import type { Session } from '../../session/sessions.ts';
import type { CoherenceJournalEntry, CoherenceJournalReading, CoherenceRegulationReading, SessionCoherence } from '../../shared/contracts/coherence.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import { errorMessage } from '../../shared/text.ts';
import {
  appendJournalWindow, COHERENCE_FEED_UNAVAILABLE, attachedCoherenceHost, journalFileNames, nextActionFromRegulateOutput,
  parseJournalLines, regulateArgs, regulationFromConfig, selectLatestShownEntry,
} from './core/coherence-feed-core.ts';
import type { JournalSource } from './core/coherence-feed-core.ts';
import { firstLine } from '../core/text-core.ts';
import { checkGitEnvironment } from '../git/git-workspace.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import { createCoherenceRuntime } from './coherence-runtime.ts';
import {
  coherenceEnv, completedFailureStdout, lstatOrNull, mirrorLifecycleTargets, nodeModulesHolding, readCoherenceConfigEntry, readRegularFileNoFollow, snapshotCheckout,
  wasKilledByTimeout, withGuardrailsLaunch,
} from './coherence-sandboxed-run.ts';
import type { CheckoutSnapshot, FileRead } from './coherence-sandboxed-run.ts';

type CoherenceFeedSession = Pick<Session, 'id' | 'resumeSessionId' | 'baseSha' | 'coherenceHooks' | 'agentId'> & {
  effectiveCwd(): string;
  on(event: 'exit', listener: () => void): unknown;
};

interface JournalCursor {
  offset: number;
  dev: number;
  ino: number;
}

interface RegulationMemo {
  inputKey: string;
  reading: CoherenceRegulationReading;
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
  regulationMemo: RegulationMemo | null;
}

interface CoherenceSessionFeedOptions {
  broadcastControl: (message: ServerMessageOf<'session-coherence'>) => void;
  cliPath?: string | null;
  debounceMs?: number;
  timeoutMs?: number;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}

const JOURNAL_READ_MAX_BYTES = 1024 * 1024;
const NEWLINE_BYTE = 0x0a;
const JOURNAL_DIRECTORIES: Record<JournalSource, string> = { decisions: 'decisions', defects: 'defects' };

async function isRealDirectory(candidatePath: string): Promise<boolean | null> {
  const entry = await lstatOrNull(candidatePath);
  if (!entry) return null;
  return entry.isDirectory() && !entry.isSymbolicLink();
}

function completeLines(read: Extract<FileRead, { kind: 'read' }>): { text: string; nextOffset: number } {
  const firstLineStart = read.isTail ? read.bytes.indexOf(NEWLINE_BYTE) + 1 : 0;
  const lastNewline = read.bytes.lastIndexOf(NEWLINE_BYTE);
  if (lastNewline < firstLineStart) return { text: '', nextOffset: read.isTail ? read.size : read.start };
  return { text: read.bytes.subarray(firstLineStart, lastNewline + 1).toString('utf8'), nextOffset: read.start + lastNewline + 1 };
}

type SessionSnapshot = Extract<CheckoutSnapshot, { ok: true }> | { ok: false; reason: string };

function createCoherenceSessionFeed({
  broadcastControl, cliPath = createCoherenceRuntime().cliPath, debounceMs = 1500, timeoutMs = 30_000, now = Date.now, log = console,
}: CoherenceSessionFeedOptions) {
  const states = new Map<string, SessionFeedState>();

  function stateOf(sessionId: string): SessionFeedState {
    const existing = states.get(sessionId);
    if (existing) return existing;
    const created: SessionFeedState = {
      isClosed: false, coherenceSessionId: null, cursors: new Map(), window: [], published: null, debounceTimer: null, inFlight: null, isRerunWanted: false, regulationMemo: null,
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

  function attachedHost(session: CoherenceFeedSession): 'claude' | 'codex' | null {
    return attachedCoherenceHost({ host: getAdapter(session.agentId)?.usageVendor, coherenceHooks: session.coherenceHooks });
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
      const snapshot = await snapshotCheckout({ cwd, snapshotRoot, env, source: { kind: 'working-tree' } });
      if (snapshot.ok) return snapshot;
      return { ok: false, reason: snapshot.failure === 'too-large' ? COHERENCE_FEED_UNAVAILABLE.snapshotTooLarge : COHERENCE_FEED_UNAVAILABLE.snapshotFailed };
    } catch (error) {
      log.warn(`[coherence-feed] snapshot failed for session ${session.id}: ${firstLine(errorMessage(error))}`);
      return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.snapshotFailed };
    }
  }

  async function regulateInSnapshot(
    session: CoherenceFeedSession, state: SessionFeedState | null, cwd: string, host: 'claude' | 'codex', resolvedCliPath: string, scratch: string,
  ): Promise<CoherenceRegulationReading> {
    const env = coherenceEnv(await checkGitEnvironment(cwd));
    const snapshot = await snapshotFor(session, cwd, path.join(scratch, 'snapshot'), env);
    if (!snapshot.ok) return snapshot;
    const configRefusal = regulationFromConfig(await readCoherenceConfigEntry(snapshot.cwd));
    if (configRefusal) return configRefusal;
    const mirroredBinNames = await mirrorLifecycleTargets(cwd, snapshot);
    const inputKey = [resolvedCliPath, host, session.baseSha ?? '', snapshot.inputDigest, ...mirroredBinNames].join('\0');
    if (state?.regulationMemo?.inputKey === inputKey) return state.regulationMemo.reading;
    const readablePaths = [await nodeModulesHolding(resolvedCliPath), await realpath(process.execPath)];
    const args = [resolvedCliPath, ...regulateArgs({ host, baseSha: session.baseSha })];
    const stdout = await withGuardrailsLaunch({ scratch, snapshot, readablePaths, env }, (runGuarded) => runGuarded(process.execPath, args, { timeoutMs }));
    if (stdout === null) return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.guardrails };
    const reading = nextActionFromRegulateOutput(stdout);
    if (state) state.regulationMemo = reading.ok ? { inputKey, reading } : null;
    return reading;
  }

  async function regulationReadingFor(session: CoherenceFeedSession, state: SessionFeedState | null, cwd: string, host: 'claude' | 'codex'): Promise<CoherenceRegulationReading> {
    if (!cliPath) return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.noCli };
    const scratch = await makeHostScratchDirectory('coherence-regulate-');
    try {
      return await regulateInSnapshot(session, state, cwd, host, cliPath, scratch);
    } catch (error) {
      const finishedStdout = completedFailureStdout(error);
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
    const host = attachedHost(session);
    if (!host || state.isClosed) return;
    const journal = await journalReadingFor(state, cwd, session);
    const regulation = await regulationReadingFor(session, state, cwd, host);
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
    if (!attachedHost(session)) return { ok: false, error: 'Coherence is not attached to this session' };
    const state = stateOf(session.id);
    const journal = await journalReadingFor(state, cwd, session);
    if (!journal.ok) return { ok: false, error: journal.reason };
    return { ok: true, entries: [...state.window] };
  }

  async function readNextAction(session: CoherenceFeedSession): Promise<CoherenceRegulationReading> {
    const host = attachedHost(session);
    if (!host) return { ok: false, reason: 'Coherence is not attached to this session' };
    return regulationReadingFor(session, null, session.effectiveCwd(), host);
  }

  function snapshotMessage(): ServerMessageOf<'session-coherence-snapshot'> {
    const sessions: Record<string, SessionCoherence> = {};
    for (const [sessionId, state] of states) {
      if (state.published) sessions[sessionId] = state.published;
    }
    return { type: 'session-coherence-snapshot', sessions };
  }

  return { attachSession, onTurnEnd, readJournal, readNextAction, snapshotMessage };
}

type CoherenceSessionFeed = ReturnType<typeof createCoherenceSessionFeed>;

export { createCoherenceSessionFeed };
export type { CoherenceFeedSession, CoherenceSessionFeed };
