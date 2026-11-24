import type {
  ArmyStatus,
  ContractStatus,
  MatchStatus,
  RejectionCode,
  SeatStatus,
  TickPhase,
  VillageProductionState,
  WargamesRejection,
} from '../contracts/wargames.ts';

type MatchEventKind = 'begin_seating' | 'all_seats_connected' | 'match_won' | 'tick_limit_reached' | 'abort_match';
type TickEventKind = 'phase_complete' | 'resolution_complete' | 'next_tick';
type SeatEventKind = 'seat_connect' | 'phase_start' | 'seat_submit' | 'phase_deadline' | 'seat_disconnect' | 'seat_eliminated';
type ContractEventKind = 'contract_accept' | 'contract_reject' | 'contract_expire' | 'contract_fulfill' | 'contract_breach';
type VillageEventKind = 'outer_ring_squeeze';
type ArmyEventKind = 'army_depart' | 'army_arrive' | 'army_stand' | 'army_redeploy' | 'army_return' | 'army_reach_home' | 'army_destroy';

type MachineResult<State extends string> =
  | { ok: true; state: State }
  | { ok: false; rejection: WargamesRejection };

type TransitionTable<State extends string, Event extends string> = Readonly<Record<State, Readonly<Partial<Record<Event, State>>>>>;

const MATCH_TRANSITIONS: TransitionTable<MatchStatus, MatchEventKind> = Object.freeze({
  lobby: { begin_seating: 'seating', abort_match: 'aborted' },
  seating: { all_seats_connected: 'running', abort_match: 'aborted' },
  running: { match_won: 'finished', tick_limit_reached: 'finished', abort_match: 'aborted' },
  finished: {},
  aborted: {},
});

const TICK_TRANSITIONS: TransitionTable<TickPhase, TickEventKind> = Object.freeze({
  talk: { phase_complete: 'contracts' },
  contracts: { phase_complete: 'orders' },
  orders: { phase_complete: 'resolving' },
  resolving: { resolution_complete: 'reported' },
  reported: { next_tick: 'talk' },
});

const SEAT_TRANSITIONS: TransitionTable<SeatStatus, SeatEventKind> = Object.freeze({
  disconnected: { seat_connect: 'connected', seat_eliminated: 'eliminated' },
  connected: { phase_start: 'acting', seat_disconnect: 'disconnected', seat_eliminated: 'eliminated' },
  acting: { seat_submit: 'submitted', phase_deadline: 'timedOut', seat_disconnect: 'disconnected', seat_eliminated: 'eliminated' },
  submitted: { phase_start: 'acting', seat_disconnect: 'disconnected', seat_eliminated: 'eliminated' },
  timedOut: { phase_start: 'acting', seat_disconnect: 'disconnected', seat_eliminated: 'eliminated' },
  eliminated: {},
});

const CONTRACT_TRANSITIONS: TransitionTable<ContractStatus, ContractEventKind> = Object.freeze({
  proposed: { contract_accept: 'active', contract_reject: 'rejected', contract_expire: 'expired' },
  active: { contract_fulfill: 'fulfilled', contract_breach: 'breached' },
  fulfilled: {},
  breached: {},
  rejected: {},
  expired: {},
});

const VILLAGE_TRANSITIONS: TransitionTable<VillageProductionState, VillageEventKind> = Object.freeze({
  producing: { outer_ring_squeeze: 'barren' },
  barren: {},
});

const ARMY_TRANSITIONS: TransitionTable<ArmyStatus, ArmyEventKind> = Object.freeze({
  mustering: { army_depart: 'marching', army_destroy: 'destroyed' },
  marching: { army_arrive: 'arrived', army_destroy: 'destroyed' },
  arrived: { army_stand: 'standing', army_return: 'returning', army_destroy: 'destroyed' },
  standing: { army_redeploy: 'marching', army_return: 'returning', army_destroy: 'destroyed' },
  returning: { army_reach_home: 'home', army_destroy: 'destroyed' },
  home: {},
  destroyed: {},
});

function runTransition<State extends string, Event extends string>(
  table: TransitionTable<State, Event>,
  state: State,
  event: Event,
  code: RejectionCode,
  label: string,
): MachineResult<State> {
  const nextState = table[state][event];
  if (nextState !== undefined) return { ok: true, state: nextState };
  return { ok: false, rejection: { code, message: `${label} cannot apply ${event} from ${state}` } };
}

export function transitionMatch(state: MatchStatus, event: MatchEventKind): MachineResult<MatchStatus> {
  return runTransition(MATCH_TRANSITIONS, state, event, 'invalid_match_state', 'match');
}

export function transitionTick(state: TickPhase, event: TickEventKind): MachineResult<TickPhase> {
  return runTransition(TICK_TRANSITIONS, state, event, 'invalid_phase', 'tick');
}

export function transitionSeat(state: SeatStatus, event: SeatEventKind): MachineResult<SeatStatus> {
  return runTransition(SEAT_TRANSITIONS, state, event, 'invalid_seat_state', 'seat');
}

export function transitionContract(state: ContractStatus, event: ContractEventKind): MachineResult<ContractStatus> {
  return runTransition(CONTRACT_TRANSITIONS, state, event, 'invalid_contract_state', 'contract');
}

export function transitionVillage(state: VillageProductionState, event: VillageEventKind): MachineResult<VillageProductionState> {
  return runTransition(VILLAGE_TRANSITIONS, state, event, 'invalid_village_state', 'village');
}

export function transitionArmy(state: ArmyStatus, event: ArmyEventKind): MachineResult<ArmyStatus> {
  return runTransition(ARMY_TRANSITIONS, state, event, 'invalid_army_state', 'army');
}
