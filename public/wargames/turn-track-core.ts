import type { MatchStatus, SeatId, SeatStatus, TickPhase } from '#shared/contracts/wargames.ts';
import type { ReplaySpeed } from './replay-core.ts';

type TurnTrackMode = 'seating' | 'live' | 'finished' | 'aborted' | 'replay';
type TurnPipState = 'played' | 'current' | 'recorded' | 'ahead';
type SeatDotState = 'lit' | 'waiting' | 'late' | 'out' | 'dim';
export type TrackPhase = 'talk' | 'orders' | 'resolving';
type ClockTone = 'calm' | 'low';
type TransportReach = 'none' | 'rewind' | 'full';
type TrackTagTone = 'accent' | 'muted' | 'neutral';

export const TRACK_PHASES: readonly TrackPhase[] = ['talk', 'orders', 'resolving'];

export const PHASE_NAMES: Readonly<Record<TrackPhase, string>> = Object.freeze({
  talk: 'Talk',
  orders: 'Orders',
  resolving: 'Resolve',
});

const TAG_BY_MODE: Readonly<Record<TurnTrackMode, { text: string; tone: TrackTagTone }>> = Object.freeze({
  seating: { text: '', tone: 'muted' },
  live: { text: 'Live', tone: 'accent' },
  replay: { text: 'Replay', tone: 'muted' },
  finished: { text: 'End', tone: 'neutral' },
  aborted: { text: 'End', tone: 'neutral' },
});

const LOW_CLOCK_FRACTION = 0.25;

interface TurnTrackSeat {
  seatId: SeatId;
  label: string;
  status: SeatStatus;
  isLockedIn: boolean;
}

interface TrackReplay {
  headTick: number;
  isAtHead: boolean;
  isPlaying: boolean;
  speed: ReplaySpeed;
}

export interface TurnTrackInput {
  status: MatchStatus;
  tick: number;
  maxTicks: number;
  phase: TickPhase;
  winnerSeatId: SeatId | null;
  seats: readonly TurnTrackSeat[];
  replay: TrackReplay | null;
}

export interface PhaseDeadline {
  deadlineAtMs: number;
  lengthMs: number;
}

interface TurnTrackClock {
  secondsLeft: number;
  remainingFraction: number;
  tone: ClockTone;
}

export interface TurnTrackView {
  mode: TurnTrackMode;
  pips: readonly TurnPipState[];
  turnText: string;
  activePhase: TrackPhase | null;
  clock: TurnTrackClock | null;
  seatDots: readonly { seatId: SeatId; state: SeatDotState }[];
  winnerSeatId: SeatId | null;
  spokenSummary: string;
  replay: TrackReplay | null;
  transport: TransportReach;
  tag: { text: string; tone: TrackTagTone };
}

function trackModeOf(status: MatchStatus, replay: TrackReplay | null): TurnTrackMode {
  if (replay !== null && !replay.isAtHead) return 'replay';
  if (status === 'running') return 'live';
  if (status === 'finished') return 'finished';
  if (status === 'aborted') return 'aborted';
  return 'seating';
}

function transportReachOf(mode: TurnTrackMode, replay: TrackReplay | null): TransportReach {
  if (replay === null || mode === 'seating') return 'none';
  return mode === 'live' ? 'rewind' : 'full';
}

function trackPhaseOf(phase: TickPhase): TrackPhase {
  return phase === 'reported' ? 'resolving' : phase;
}

function pipStateOf(turnIndex: number, mode: TurnTrackMode, tick: number, headTick: number): TurnPipState {
  const turnNumber = turnIndex + 1;
  if (mode === 'replay') {
    if (turnNumber === tick) return 'current';
    if (turnNumber < tick) return 'played';
    return turnNumber <= headTick ? 'recorded' : 'ahead';
  }
  if (mode !== 'live') return turnNumber <= tick ? 'played' : 'ahead';
  if (turnNumber < tick) return 'played';
  return turnNumber === tick ? 'current' : 'ahead';
}

const LIVE_DOT_BY_STATUS: Readonly<Record<SeatStatus, SeatDotState>> = Object.freeze({
  disconnected: 'out',
  connected: 'waiting',
  acting: 'waiting',
  submitted: 'lit',
  timedOut: 'late',
  eliminated: 'out',
});

function seatDotStateOf(seat: TurnTrackSeat, mode: TurnTrackMode, winnerSeatId: SeatId | null): SeatDotState {
  if (mode === 'seating') return seat.status === 'disconnected' ? 'waiting' : 'lit';
  if (mode === 'finished') return seat.seatId === winnerSeatId ? 'lit' : 'dim';
  if (mode === 'aborted') return 'dim';
  if (mode === 'replay') return seat.status === 'eliminated' ? 'out' : 'lit';
  return seat.isLockedIn ? 'lit' : LIVE_DOT_BY_STATUS[seat.status];
}

function clockOf(deadline: PhaseDeadline | null, nowMs: number): TurnTrackClock | null {
  if (deadline === null) return null;
  const remainingMs = Math.max(0, deadline.deadlineAtMs - nowMs);
  const remainingFraction = Math.min(1, remainingMs / deadline.lengthMs);
  return {
    secondsLeft: Math.ceil(remainingMs / 1000),
    remainingFraction,
    tone: remainingFraction <= LOW_CLOCK_FRACTION ? 'low' : 'calm',
  };
}

function countSeats(seats: readonly TurnTrackSeat[], matches: (status: SeatStatus) => boolean): number {
  return seats.filter((seat) => matches(seat.status)).length;
}

function spokenSummaryOf(input: TurnTrackInput, mode: TurnTrackMode, clock: TurnTrackClock | null): string {
  const seatTotal = input.seats.length;
  if (mode === 'seating') {
    const connectedCount = countSeats(input.seats, (status) => status !== 'disconnected');
    return `Seating. ${connectedCount} of ${seatTotal} seats connected.`;
  }
  if (mode === 'finished') {
    const winner = input.seats.find((seat) => seat.seatId === input.winnerSeatId);
    const winnerText = winner ? ` Winner: ${winner.label}.` : '';
    return `Finished after turn ${input.tick} of ${input.maxTicks}.${winnerText}`;
  }
  if (mode === 'aborted') return `Aborted on turn ${input.tick} of ${input.maxTicks}.`;
  if (mode === 'replay') return `Replay. Turn ${input.tick} of ${input.replay?.headTick ?? input.maxTicks}. ${PHASE_NAMES[trackPhaseOf(input.phase)]} phase.`;
  const phaseName = PHASE_NAMES[trackPhaseOf(input.phase)];
  const clockText = clock ? ` ${clock.secondsLeft} seconds left.` : '';
  const lockedCount = input.seats.filter((seat) => seat.isLockedIn).length;
  return `Live. Turn ${input.tick} of ${input.maxTicks}. ${phaseName} phase.${clockText} ${lockedCount} of ${seatTotal} seats locked in.`;
}

export function deriveTurnTrack(input: TurnTrackInput, deadline: PhaseDeadline | null, nowMs: number): TurnTrackView {
  const mode = trackModeOf(input.status, input.replay);
  const clock = mode === 'live' ? clockOf(deadline, nowMs) : null;
  const headTick = input.replay?.headTick ?? input.tick;
  const pips = Array.from({ length: input.maxTicks }, (_unused, turnIndex) => pipStateOf(turnIndex, mode, input.tick, headTick));
  return {
    mode,
    pips,
    turnText: `${input.tick}/${input.maxTicks}`,
    activePhase: mode === 'seating' ? null : trackPhaseOf(input.phase),
    clock,
    seatDots: input.seats.map((seat) => ({ seatId: seat.seatId, state: seatDotStateOf(seat, mode, input.winnerSeatId) })),
    winnerSeatId: mode === 'finished' ? input.winnerSeatId : null,
    spokenSummary: spokenSummaryOf(input, mode, clock),
    replay: input.replay,
    transport: transportReachOf(mode, input.replay),
    tag: TAG_BY_MODE[mode],
  };
}
