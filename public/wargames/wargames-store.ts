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
import { applyEvent, createInitialMatchState } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import {
  createReplayTimeline,
  lastRecordedTick,
  phaseStartEventCount,
  recordReplayState,
  replayStateAt,
  stepTurnEventCount,
  tickAtEventCount,
  turnDwellMs,
  turnEndEventCount,
  turnStartEventCount,
} from './replay-core.ts';
import type { ReplaySpeed, ReplayTimeline } from './replay-core.ts';
import type { SeatNote } from './diplomacy-log-core.ts';
import type { PhaseDeadline, TrackPhase } from './turn-track-core.ts';

export type WargamesPov = 'god' | SeatId;

type ReplayStart = 'turn-one' | 'head';

interface ReplayView {
  headTick: number;
  isAtHead: boolean;
  isPlaying: boolean;
  speed: ReplaySpeed;
}

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

type ResyncRequester = (matchId: string) => Promise<void>;

const listeners = new Set<Listener>();

let matches: WargamesMatchSummary[] = [];
let history: WargamesHistory = { currentRulesVersion: WARGAMES_RULES_VERSION, eloByModel: [], eloByVersion: {}, matches: [] };
let watchedMatchId: string | null = null;
let events: WargamesEvent[] = [];
let headState: MatchState | null = null;
let phaseDeadline: PhaseDeadline | null = null;
let pov: WargamesPov = 'god';
let timeline: ReplayTimeline = createReplayTimeline();
let replayCursor: number | null = null;
let isReplayPlaying = false;
let replaySpeed: ReplaySpeed = 1;
let pendingReplayStart: ReplayStart = 'head';
let cursorState: MatchState | null = null;
let recordedNotes: (SeatNote & { eventCount: number })[] = [];
let playTimer: ReturnType<typeof setTimeout> | null = null;
let requestResync: ResyncRequester | null = null;
let isResyncPending = false;

export function setWargamesResyncRequester(requester: ResyncRequester | null): void {
  requestResync = requester;
}

function resyncWatchedMatch(): void {
  if (watchedMatchId === null || requestResync === null || isResyncPending) return;
  isResyncPending = true;
  const matchId = watchedMatchId;
  void requestResync(matchId).finally(() => {
    if (watchedMatchId === matchId) isResyncPending = false;
  });
}

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
  return replayCursor === null ? headState : cursorState;
}

export function displayedMatchAnalytics(state: MatchState | null = displayedMatchState()): MatchAnalytics | null {
  if (!state) return null;
  return analyzeMatch(events, state);
}

export function displayedNotes(): SeatNote[] {
  if (replayCursor === null) return recordedNotes;
  const shownEventCount = replayCursor;
  let low = 0;
  let high = recordedNotes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (recordedNotes[middle].eventCount <= shownEventCount) {
      low = middle + 1;
      continue;
    }
    high = middle;
  }
  return recordedNotes.slice(0, low);
}

function recordNote(event: WargamesEvent, eventCount: number, tick: number): void {
  if (event.type !== 'note_written' || event.text.trim().length === 0) return;
  recordedNotes.push({ eventCount, tick, seatId: event.seatId, text: event.text });
}

export function replayView(): ReplayView {
  return {
    headTick: lastRecordedTick(timeline),
    isAtHead: replayCursor === null,
    isPlaying: isReplayPlaying,
    speed: replaySpeed,
  };
}

function stopPlayTimer(): void {
  if (playTimer === null) return;
  clearTimeout(playTimer);
  playTimer = null;
}

function schedulePlayStep(): void {
  stopPlayTimer();
  if (!isReplayPlaying) return;
  playTimer = setTimeout(() => {
    playTimer = null;
    if (!isReplayPlaying || replayCursor === null) return;
    moveCursor(stepTurnEventCount(timeline, replayCursor, 1));
  }, turnDwellMs(replaySpeed));
}

function moveCursor(eventCount: number | null): void {
  const isPastHead = eventCount === null || eventCount >= events.length;
  replayCursor = isPastHead ? null : Math.max(1, eventCount);
  cursorState = replayCursor === null ? null : replayStateAt(timeline, events, replayCursor);
  if (replayCursor === null) isReplayPlaying = false;
  schedulePlayStep();
  notify();
}

function cursorOrHead(): number {
  return replayCursor ?? events.length;
}

export function seekReplayTurn(tick: number): void {
  if (events.length === 0) return;
  moveCursor(turnEndEventCount(timeline, tick));
}

export function seekReplayPhase(phase: TrackPhase): void {
  if (events.length === 0) return;
  const cursorTick = tickAtEventCount(timeline, cursorOrHead());
  moveCursor(phaseStartEventCount(timeline, cursorTick, phase) ?? cursorOrHead());
}

export function stepReplayTurn(direction: -1 | 1): void {
  if (events.length === 0) return;
  moveCursor(stepTurnEventCount(timeline, cursorOrHead(), direction));
}

export function toggleReplayPlay(): void {
  if (events.length === 0) return;
  if (isReplayPlaying) {
    isReplayPlaying = false;
    stopPlayTimer();
    notify();
    return;
  }
  isReplayPlaying = true;
  moveCursor(replayCursor ?? turnStartEventCount(timeline, 1));
}

export function setReplaySpeed(speed: ReplaySpeed): void {
  if (replaySpeed === speed) return;
  replaySpeed = speed;
  schedulePlayStep();
  notify();
}

export function jumpReplayToEnd(): void {
  moveCursor(null);
}

function resetReplay(start: ReplayStart): void {
  stopPlayTimer();
  timeline = createReplayTimeline();
  replayCursor = null;
  isReplayPlaying = false;
  pendingReplayStart = start;
  cursorState = null;
  recordedNotes = [];
}

export function setWargamesPov(nextPov: WargamesPov): void {
  if (pov === nextPov) return;
  pov = nextPov;
  notify();
}

export function selectWatchedMatch(matchId: string | null, start: ReplayStart = 'head'): void {
  if (watchedMatchId === matchId) {
    if (start === 'turn-one' && headState !== null && headState.status !== 'running') moveCursor(turnStartEventCount(timeline, 1));
    return;
  }
  watchedMatchId = matchId;
  events = [];
  headState = null;
  phaseDeadline = null;
  isResyncPending = false;
  resetReplay(start);
  notify();
}

function recordedReplayOf(log: readonly WargamesEvent[]): { replayed: MatchState; recorded: ReplayTimeline; notes: typeof recordedNotes } {
  const first = log[0];
  if (first.type !== 'match_created') throw new Error('Wargames event log must start with match_created');
  const recorded = createReplayTimeline();
  const notes: typeof recordedNotes = [];
  let replayed = createInitialMatchState(first.matchId, first.createdAtMs, first.spec);
  recordReplayState(recorded, 1, replayed);
  for (let index = 1; index < log.length; index += 1) {
    const outcome = applyEvent(replayed, log[index]);
    if (!outcome.ok) throw new Error(`Replay rejected event #${index} (${log[index].type}): ${outcome.rejection.message}`);
    replayed = outcome.state;
    recordReplayState(recorded, index + 1, replayed);
    const event = log[index];
    if (event.type === 'note_written' && event.text.trim().length > 0) notes.push({ eventCount: index + 1, tick: replayed.tick, seatId: event.seatId, text: event.text });
  }
  return { replayed, recorded, notes };
}

function placeCursorAfterReset(): void {
  const keptCursor = replayCursor !== null && replayCursor < events.length ? replayCursor : null;
  const isReplayStart = pendingReplayStart === 'turn-one' && headState !== null && headState.status !== 'running';
  pendingReplayStart = 'head';
  replayCursor = isReplayStart ? turnStartEventCount(timeline, 1) : keptCursor;
  cursorState = replayCursor === null ? null : replayStateAt(timeline, events, replayCursor);
  if (replayCursor === null) isReplayPlaying = false;
  schedulePlayStep();
}

function isServerLogAhead(): boolean {
  if (headState === null) return false;
  const watchedSummary = matches.find((summary) => summary.matchId === watchedMatchId);
  return watchedSummary !== undefined && watchedSummary.eventCount > events.length;
}

export function applyWargamesStatus(frame: { matches: WargamesMatchSummary[] }): void {
  matches = frame.matches;
  if (isServerLogAhead()) resyncWatchedMatch();
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
    isResyncPending = false;
    const eventCountBeforeReset = events.length;
    if (frame.events.length === 0 || frame.events[0].type !== 'match_created') {
      events = [];
      headState = null;
      notify();
      return;
    }
    try {
      const { replayed, recorded, notes } = recordedReplayOf(frame.events);
      events = [...frame.events];
      headState = replayed;
      timeline = recorded;
      recordedNotes = notes;
    } catch {
      events = [];
      headState = null;
      timeline = createReplayTimeline();
      recordedNotes = [];
    }
    placeCursorAfterReset();
    if (events.length > eventCountBeforeReset && isServerLogAhead()) resyncWatchedMatch();
    notify();
    return;
  }
  if (headState === null || isResyncPending) return;
  let current = headState;
  for (const incoming of frame.events) {
    if (incoming.seq <= current.lastSeq) continue;
    const outcome = incoming.seq === current.lastSeq + 1 ? applyEvent(current, incoming) : null;
    if (outcome === null || !outcome.ok) {
      headState = current;
      resyncWatchedMatch();
      notify();
      return;
    }
    current = outcome.state;
    events.push(incoming);
    recordReplayState(timeline, events.length, current);
    recordNote(incoming, events.length, current.tick);
  }
  headState = current;
  notify();
}
