import { clock } from '#shared/clock.ts';
import { WARGAMES_RULES_VERSION } from '#shared/contracts/wargames.ts';
import type {
  MatchAnalytics,
  SeatId,
  WargamesEvent,
  WargamesHistory,
  WargamesMatchSummary,
  WargamesPhaseClock,
} from '#shared/contracts/wargames.ts';
import { analyzeMatch } from '#shared/wargames/analytics.ts';
import { applyEvent, createInitialMatchState, replayMatch } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import type { PhaseDeadline } from './turn-track-core.ts';

export type WargamesPov = 'god' | SeatId;

interface WargamesStoreSnapshot {
  matches: readonly WargamesMatchSummary[];
  history: WargamesHistory;
  watchedMatchId: string | null;
  events: readonly WargamesEvent[];
  headState: MatchState | null;
  phaseDeadline: PhaseDeadline | null;
  pov: WargamesPov;
}

type Listener = () => void;

const listeners = new Set<Listener>();

let matches: WargamesMatchSummary[] = [];
let history: WargamesHistory = { currentRulesVersion: WARGAMES_RULES_VERSION, eloByModel: [], eloByVersion: {}, matches: [] };
let watchedMatchId: string | null = null;
let events: WargamesEvent[] = [];
let headState: MatchState | null = null;
let phaseDeadline: PhaseDeadline | null = null;
let pov: WargamesPov = 'god';

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeWargames(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function wargamesSnapshot(): WargamesStoreSnapshot {
  return { matches, history, watchedMatchId, events, headState, phaseDeadline, pov };
}

export function displayedMatchState(): MatchState | null {
  return headState;
}

export function displayedMatchAnalytics(state: MatchState | null = displayedMatchState()): MatchAnalytics | null {
  if (!state) return null;
  return analyzeMatch(events, state);
}

export function setWargamesPov(nextPov: WargamesPov): void {
  if (pov === nextPov) return;
  pov = nextPov;
  notify();
}

export function selectWatchedMatch(matchId: string | null): void {
  if (watchedMatchId === matchId) return;
  watchedMatchId = matchId;
  events = [];
  headState = null;
  phaseDeadline = null;
  notify();
}

export function applyWargamesStatus(frame: { matches: WargamesMatchSummary[] }): void {
  matches = frame.matches;
  notify();
}

export function applyWargamesHistory(frame: { history: WargamesHistory }): void {
  history = frame.history;
  notify();
}

function deadlineFromClock(phaseClock: WargamesPhaseClock | null): PhaseDeadline | null {
  if (phaseClock === null) return null;
  return { deadlineAtMs: clock.nowMs() + phaseClock.remainingMs, lengthMs: phaseClock.lengthMs };
}

export function applyWargamesEvents(frame: { matchId: string; events: WargamesEvent[]; reset: boolean; phaseClock: WargamesPhaseClock | null }): void {
  if (watchedMatchId === null || frame.matchId !== watchedMatchId) return;
  phaseDeadline = deadlineFromClock(frame.phaseClock);
  if (frame.reset) {
    if (frame.events.length === 0 || frame.events[0].type !== 'match_created') {
      events = [];
      headState = null;
      notify();
      return;
    }
    try {
      const replayed = replayMatch(frame.events);
      events = [...frame.events];
      headState = replayed;
      notify();
    } catch {
      events = [];
      headState = null;
      notify();
    }
    return;
  }
  if (headState === null) return;
  let current = headState;
  for (const incoming of frame.events) {
    if (incoming.seq <= current.lastSeq && incoming.type !== 'match_created') continue;
    if (incoming.type === 'match_created') {
      current = createInitialMatchState(incoming.matchId, incoming.createdAtMs, incoming.spec);
      events = [incoming];
      continue;
    }
    const outcome = applyEvent(current, incoming);
    if (!outcome.ok) continue;
    current = outcome.state;
    events.push(incoming);
  }
  headState = current;
  notify();
}
