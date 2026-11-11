import { errorMessage } from '../../shared/text.ts';
import { firstLine } from '../core/text-core.ts';
import type { Session } from '../../session/sessions.ts';
import type { CoherenceJournalEntry, CoherenceJournalReading, SessionCoherence } from '../../shared/contracts/coherence.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import type { CoherenceAttachment } from './coherence-runtime.ts';
import { appendJournalWindow, journalEntries, judgeTurnEnd, selectLatestShownEntry, startVerdictWatch, type CoherenceVerdictWatch } from './core/coherence-feed-core.ts';
import { clock } from '../../shared/clock.ts';

type CoherenceFeedSession = Pick<Session, 'id' | 'resumeSessionId' | 'coherenceHooks' | 'coherenceAttachment' | 'refreshCoherenceHooks' | 'raiseAttention' | 'baseSha'> & Partial<Pick<Session, 'onBeforeWorktreeDiscard'>> & {
  on(event: 'exit', listener: () => void): unknown;
};

interface SessionFeedState {
  isClosed: boolean;
  coherenceSessionId: string | null;
  window: CoherenceJournalEntry[];
  published: SessionCoherence | null;
  debounceTimer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  isRerunWanted: boolean;
  watchedAttachment: CoherenceAttachment | null;
  verdictWatch: CoherenceVerdictWatch | null;
}

function createCoherenceSessionFeed({ broadcastControl, debounceMs = 1500, now = clock.nowMs, log = console }: {
  broadcastControl: (message: ServerMessageOf<'session-coherence'>) => void;
  debounceMs?: number; now?: () => number; log?: Pick<Console, 'warn'>;
}) {
  const states = new Map<string, SessionFeedState>();

  function stateOf(sessionId: string): SessionFeedState {
    const existing = states.get(sessionId);
    if (existing) return existing;
    const created: SessionFeedState = {
      isClosed: false, coherenceSessionId: null, window: [], published: null, debounceTimer: null, inFlight: null, isRerunWanted: false,
      watchedAttachment: null, verdictWatch: null,
    };
    states.set(sessionId, created);
    return created;
  }

  const runningReadingsBySessionId = new Map<string, Set<Promise<unknown>>>();
  const attachedSessionsById = new Map<string, CoherenceFeedSession>();
  const settledSessions = new WeakSet<CoherenceFeedSession>();

  function trackReading<Reading>(sessionId: string, reading: Promise<Reading>): Promise<Reading> {
    const runningReadings = runningReadingsBySessionId.get(sessionId) ?? new Set<Promise<unknown>>();
    runningReadingsBySessionId.set(sessionId, runningReadings);
    runningReadings.add(reading);
    const untrack = () => {
      runningReadings.delete(reading);
      if (runningReadings.size === 0 && runningReadingsBySessionId.get(sessionId) === runningReadings) runningReadingsBySessionId.delete(sessionId);
    };
    reading.then(untrack, untrack);
    return reading;
  }

  function forget(sessionId: string): void {
    const state = states.get(sessionId);
    if (!state) return;
    state.isClosed = true;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    states.delete(sessionId);
  }

  const discardHoldCountBySession = new WeakMap<CoherenceFeedSession, number>();

  function isRefusingReadings(session: CoherenceFeedSession): boolean {
    return settledSessions.has(session) || (discardHoldCountBySession.get(session) ?? 0) > 0;
  }

  async function drainReadings(sessionId: string, session: CoherenceFeedSession | undefined): Promise<void> {
    const debounceTimer = states.get(sessionId)?.debounceTimer;
    if (debounceTimer) clearTimeout(debounceTimer);
    await session?.coherenceAttachment?.idle();
    for (let runningReadings = runningReadingsBySessionId.get(sessionId); runningReadings; runningReadings = runningReadingsBySessionId.get(sessionId)) {
      await Promise.allSettled([...runningReadings]);
    }
  }

  async function holdForWorktreeDiscard(session: CoherenceFeedSession): Promise<() => void> {
    discardHoldCountBySession.set(session, (discardHoldCountBySession.get(session) ?? 0) + 1);
    let isReleased = false;
    const release = () => {
      if (isReleased) return;
      isReleased = true;
      discardHoldCountBySession.set(session, (discardHoldCountBySession.get(session) ?? 1) - 1);
    };
    await drainReadings(session.id, session).catch(() => {});
    return release;
  }

  async function settle(sessionId: string): Promise<void> {
    const session = attachedSessionsById.get(sessionId);
    attachedSessionsById.delete(sessionId);
    if (session) settledSessions.add(session);
    forget(sessionId);
    await drainReadings(sessionId, session);
  }

  async function journalReadingFor(state: SessionFeedState, session: CoherenceFeedSession): Promise<CoherenceJournalReading> {
    const sessionId = session.resumeSessionId;
    if (sessionId !== state.coherenceSessionId) {
      state.coherenceSessionId = sessionId;
      state.window = [];
    }
    if (!sessionId) return { ok: true, latest: null };
    if (!session.coherenceAttachment) return { ok: false, reason: 'Coherence is not attached to this session' };
    try {
      const output = await session.coherenceAttachment.readJournal(sessionId);
      state.window = appendJournalWindow(state.window, journalEntries(output, sessionId));
      return { ok: true, latest: selectLatestShownEntry(state.window) };
    } catch {
      return { ok: false, reason: 'the Coherence journal could not be read' };
    }
  }

  async function healHooks(session: CoherenceFeedSession, state: SessionFeedState): Promise<void> {
    if (!session.coherenceAttachment || state.isClosed) return;
    const outcome = await session.coherenceAttachment.healHooks();
    if (state.isClosed || outcome.status === 'not-needed') return;
    if (outcome.status === 'failed') {
      session.raiseAttention('coherence-hooks', `Coherence hooks could not be installed: ${outcome.reason}`);
      return;
    }
    await session.refreshCoherenceHooks();
  }

  async function watchVerdicts(session: CoherenceFeedSession, state: SessionFeedState): Promise<void> {
    const attachment = session.coherenceAttachment;
    if (!attachment) return;
    if (state.watchedAttachment !== attachment) {
      state.watchedAttachment = attachment;
      state.verdictWatch = null;
    }
    try {
      if (!state.verdictWatch) {
        const baseline = await attachment.readVerdictBaseline();
        if (!baseline || state.isClosed) return;
        state.verdictWatch = startVerdictWatch(baseline);
      }
      const reading = await attachment.rerunTouchedVerdicts({
        sinceHead: state.verdictWatch.head, baseSha: session.baseSha, sessionId: session.resumeSessionId, standingInvariantIds: state.verdictWatch.standingFailures, isSpecCheckStanding: state.verdictWatch.spec === 'standing',
      });
      if (state.isClosed) return;
      const judged = judgeTurnEnd(state.verdictWatch, reading);
      state.verdictWatch = judged.watch;
      for (const { origin, note } of judged.notes) session.raiseAttention(origin, note);
    } catch (error) {
      if (state.isClosed) return;
      session.raiseAttention('coherence-error', `Coherence could not re-run invariants after the turn: ${firstLine(errorMessage(error))}`);
    }
  }

  async function refreshOnce(session: CoherenceFeedSession, state: SessionFeedState): Promise<void> {
    await healHooks(session, state);
    if (session.coherenceHooks?.active !== true || state.isClosed) return;
    const journal = await journalReadingFor(state, session);
    if (state.isClosed) return;
    state.published = { journal, updatedAt: now() };
    broadcastControl({ type: 'session-coherence', id: session.id, ...state.published });
    await watchVerdicts(session, state);
  }

  function refresh(session: CoherenceFeedSession, state: SessionFeedState): void {
    if (state.inFlight) {
      state.isRerunWanted = true;
      return;
    }
    state.inFlight = trackReading(session.id, (async () => {
      do {
        state.isRerunWanted = false;
        await refreshOnce(session, state).catch((error: unknown) => log.warn(`[coherence-feed] refresh failed for session ${session.id}: ${firstLine(errorMessage(error))}`));
      } while (state.isRerunWanted && !state.isClosed);
    })().finally(() => {
      state.inFlight = null;
    }));
  }

  function onTurnEnd(session: CoherenceFeedSession): void {
    if (isRefusingReadings(session)) return;
    const state = stateOf(session.id);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      refresh(session, state);
    }, debounceMs);
    state.debounceTimer.unref();
  }

  function attachSession(session: CoherenceFeedSession): void {
    attachedSessionsById.set(session.id, session);
    session.onBeforeWorktreeDiscard?.(() => holdForWorktreeDiscard(session));
    session.on('exit', () => forget(session.id));
  }

  async function readJournal(session: CoherenceFeedSession): Promise<{ ok: true; entries: CoherenceJournalEntry[] } | { ok: false; error: string }> {
    if (isRefusingReadings(session) || session.coherenceHooks?.active !== true || !session.coherenceAttachment) return { ok: false, error: 'Coherence is not attached to this session' };
    const state = stateOf(session.id);
    const journal = await trackReading(session.id, journalReadingFor(state, session));
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

  return { attachSession, onTurnEnd, readJournal, settle, snapshotMessage };
}

type CoherenceSessionFeed = ReturnType<typeof createCoherenceSessionFeed>;

export { createCoherenceSessionFeed };
export type { CoherenceSessionFeed };
