import type { TickPhase, WargamesEvent } from '#shared/contracts/wargames.ts';
import { applyEvent } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';

const KEPT_STATE_EVERY_TURNS = 5;

export type ReplaySpeed = 1 | 2 | 4;

export const REPLAY_SPEEDS: readonly ReplaySpeed[] = [1, 2, 4];

const REPLAY_TURN_MS_AT_1X = 4000;

interface ReplayStop {
  readonly eventCount: number;
  readonly tick: number;
  readonly phase: TickPhase;
}

interface KeptState {
  readonly eventCount: number;
  readonly state: MatchState;
}

export interface ReplayTimeline {
  readonly stops: ReplayStop[];
  readonly firstStopIndexByTick: number[];
  readonly keptStates: KeptState[];
  recordedEventCount: number;
}

export function createReplayTimeline(): ReplayTimeline {
  return { stops: [], firstStopIndexByTick: [], keptStates: [], recordedEventCount: 0 };
}

export function recordReplayState(timeline: ReplayTimeline, eventCount: number, state: MatchState): void {
  const previousStop = timeline.stops.at(-1);
  timeline.recordedEventCount = eventCount;
  if (previousStop && previousStop.tick === state.tick && previousStop.phase === state.phase) return;
  const isNewTurn = !previousStop || previousStop.tick !== state.tick;
  if (isNewTurn) timeline.firstStopIndexByTick[state.tick] = timeline.stops.length;
  timeline.stops.push({ eventCount, tick: state.tick, phase: state.phase });
  const isKeptTurn = (state.tick - 1) % KEPT_STATE_EVERY_TURNS === 0;
  if (timeline.keptStates.length === 0 || (isNewTurn && isKeptTurn)) timeline.keptStates.push({ eventCount, state });
}

function nearestStart(timeline: ReplayTimeline, eventCount: number): KeptState | null {
  let nearest: KeptState | null = null;
  for (const kept of timeline.keptStates) {
    if (kept.eventCount > eventCount) break;
    nearest = kept;
  }
  return nearest;
}

export function replayStateAt(timeline: ReplayTimeline, events: readonly WargamesEvent[], eventCount: number): MatchState | null {
  const start = nearestStart(timeline, eventCount);
  if (start === null) return null;
  let state = start.state;
  for (let index = start.eventCount; index < Math.min(eventCount, events.length); index += 1) {
    const outcome = applyEvent(state, events[index]);
    if (outcome.ok) state = outcome.state;
  }
  return state;
}

function firstStopOfTurn(timeline: ReplayTimeline, tick: number): ReplayStop | null {
  const stopIndex = timeline.firstStopIndexByTick[tick];
  return stopIndex === undefined ? null : timeline.stops[stopIndex];
}

export function turnStartEventCount(timeline: ReplayTimeline, tick: number): number | null {
  return firstStopOfTurn(timeline, tick)?.eventCount ?? null;
}

export function turnEndEventCount(timeline: ReplayTimeline, tick: number): number {
  const nextTurnStart = firstStopOfTurn(timeline, tick + 1);
  return nextTurnStart ? nextTurnStart.eventCount - 1 : timeline.recordedEventCount;
}

export function phaseStartEventCount(timeline: ReplayTimeline, tick: number, phase: TickPhase): number | null {
  if (phase === 'resolving' || phase === 'reported') return turnEndEventCount(timeline, tick);
  const firstStopIndex = timeline.firstStopIndexByTick[tick];
  if (firstStopIndex === undefined) return null;
  for (let stopIndex = firstStopIndex; stopIndex < timeline.stops.length && timeline.stops[stopIndex].tick === tick; stopIndex += 1) {
    if (timeline.stops[stopIndex].phase === phase) return timeline.stops[stopIndex].eventCount;
  }
  return null;
}

export function lastRecordedTick(timeline: ReplayTimeline): number {
  return timeline.stops.at(-1)?.tick ?? 0;
}

export function tickAtEventCount(timeline: ReplayTimeline, eventCount: number): number {
  let low = 0;
  let high = timeline.stops.length - 1;
  let tick = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (timeline.stops[middle].eventCount > eventCount) {
      high = middle - 1;
      continue;
    }
    tick = timeline.stops[middle].tick;
    low = middle + 1;
  }
  return tick;
}

export function stepTurnEventCount(timeline: ReplayTimeline, cursorEventCount: number, direction: -1 | 1): number {
  const cursorTick = tickAtEventCount(timeline, cursorEventCount);
  const cursorTurnEnd = turnEndEventCount(timeline, cursorTick);
  if (direction === 1) {
    if (cursorEventCount < cursorTurnEnd) return cursorTurnEnd;
    return turnEndEventCount(timeline, cursorTick + 1);
  }
  const firstTurnStart = turnStartEventCount(timeline, 1) ?? cursorEventCount;
  if (cursorTick <= 1) return firstTurnStart;
  return Math.max(firstTurnStart, turnEndEventCount(timeline, cursorTick - 1));
}

export function turnDwellMs(speed: ReplaySpeed): number {
  return REPLAY_TURN_MS_AT_1X / speed;
}
