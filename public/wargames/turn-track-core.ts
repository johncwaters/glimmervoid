import type { MatchStatus, SeatId, SeatStatus, TickPhase } from '#shared/contracts/wargames.ts';

type TurnTrackMode = 'seating' | 'live' | 'finished' | 'aborted';
type TurnPipState = 'played' | 'current' | 'ahead';
type SeatDotState = 'lit' | 'waiting' | 'late' | 'out' | 'dim';
export type TrackPhase = 'talk' | 'contracts' | 'orders' | 'resolving';
type ClockTone = 'calm' | 'low';

export const TRACK_PHASES: readonly TrackPhase[] = ['talk', 'contracts', 'orders', 'resolving'];

const SPOKEN_PHASE_NAMES: Readonly<Record<TrackPhase, string>> = Object.freeze({
  talk: 'Talk',
  contracts: 'Negotiate',
  orders: 'Orders',
  resolving: 'Resolving',
});

const LOW_CLOCK_FRACTION = 0.25;

interface TurnTrackSeat {
  seatId: SeatId;
  label: string;
  status: SeatStatus;
  isLockedIn: boolean;
}

export interface TurnTrackInput {
  status: MatchStatus;
  tick: number;
  maxTicks: number;
  phase: TickPhase;
  winnerSeatId: SeatId | null;
  seats: readonly TurnTrackSeat[];
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
}

function trackModeOf(status: MatchStatus): TurnTrackMode {
  if (status === 'running') return 'live';
  if (status === 'finished') return 'finished';
  if (status === 'aborted') return 'aborted';
  return 'seating';
}

function trackPhaseOf(phase: TickPhase): TrackPhase {
  return phase === 'reported' ? 'resolving' : phase;
}

function pipStateOf(turnIndex: number, mode: TurnTrackMode, tick: number): TurnPipState {
  const turnNumber = turnIndex + 1;
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
  const phaseName = SPOKEN_PHASE_NAMES[trackPhaseOf(input.phase)];
  const clockText = clock ? ` ${clock.secondsLeft} seconds left.` : '';
  const lockedCount = input.seats.filter((seat) => seat.isLockedIn).length;
  return `Live. Turn ${input.tick} of ${input.maxTicks}. ${phaseName} phase.${clockText} ${lockedCount} of ${seatTotal} seats locked in.`;
}

export function deriveTurnTrack(input: TurnTrackInput, deadline: PhaseDeadline | null, nowMs: number): TurnTrackView {
  const mode = trackModeOf(input.status);
  const clock = mode === 'live' ? clockOf(deadline, nowMs) : null;
  const pips = Array.from({ length: input.maxTicks }, (_unused, turnIndex) => pipStateOf(turnIndex, mode, input.tick));
  return {
    mode,
    pips,
    turnText: `${input.tick}/${input.maxTicks}`,
    activePhase: mode === 'live' ? trackPhaseOf(input.phase) : null,
    clock,
    seatDots: input.seats.map((seat) => ({ seatId: seat.seatId, state: seatDotStateOf(seat, mode, input.winnerSeatId) })),
    winnerSeatId: mode === 'finished' ? input.winnerSeatId : null,
    spokenSummary: spokenSummaryOf(input, mode, clock),
  };
}
