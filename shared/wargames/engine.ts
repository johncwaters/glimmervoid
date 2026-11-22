import {
  WARGAMES_HEX_COUNT,
  WARGAMES_HEX_RADIUS,
  WARGAMES_MAX_MESSAGES_PER_TICK,
  WARGAMES_MAX_TRIBE_SIZE,
  WARGAMES_NOTE_MAX_BYTES,
  WARGAMES_SEAT_IDS,
  WARGAMES_SQUEEZE_TICK,
  WARGAMES_TRAVEL_HEXES_PER_TICK,
  WARGAMES_WIN_VILLAGES,
} from '../contracts/wargames.ts';
import type {
  ArmyStatus,
  BuildingKind,
  BuildingLevels,
  ContractRecord,
  HexCoord,
  LedgerBreachEntry,
  MatchStatus,
  MessageRecord,
  OrderItem,
  ResourceBundle,
  SeatConfig,
  SeatId,
  SeatStatus,
  SignedReport,
  SignedReportPayload,
  TickPhase,
  TroopCounts,
  TroopKind,
  VillageProductionState,
  WargamesEvent,
  WargamesMatchSpec,
  WargamesRejection,
} from '../contracts/wargames.ts';
import {
  transitionArmy,
  transitionContract,
  transitionMatch,
  transitionSeat,
  transitionTick,
  transitionVillage,
} from './machines.ts';

export interface ReportSigner {
  sign(canonicalPayload: string): string;
  verify(canonicalPayload: string, signature: string): boolean;
}

interface HexTile {
  index: number;
  q: number;
  r: number;
  ring: number;
}

interface VillageState {
  hexIndex: number;
  owner: SeatId | null;
  productionState: VillageProductionState;
  loyalty: number;
  resources: ResourceBundle;
  buildings: BuildingLevels;
  troops: TroopCounts;
}

interface ArmyState {
  id: string;
  owner: SeatId;
  status: ArmyStatus;
  originHexIndex: number;
  currentHexIndex: number;
  targetHexIndex: number;
  troops: TroopCounts;
  departedTick: number;
  intendedTargetOwner: SeatId | null;
  scoutedBy: SeatId[];
}

interface ProjectedArmyView extends Omit<ArmyState, 'scoutedBy' | 'intendedTargetOwner'> {}

interface SeatRuntimeState {
  config: SeatConfig;
  status: SeatStatus;
  note: string;
  messagesSentThisTick: number;
  sealedOrders: OrderItem[];
  tribeId: string | null;
}

interface VerificationLogEntry {
  tick: number;
  seatId: SeatId;
  reportId: string;
  valid: boolean;
}

export interface MatchState {
  matchId: string;
  createdAtMs: number;
  spec: WargamesMatchSpec;
  status: MatchStatus;
  tick: number;
  phase: TickPhase;
  rngState: number;
  winnerSeatId: SeatId | null;
  abortReason: string | null;
  hexes: HexTile[];
  villages: (VillageState | null)[];
  seats: SeatRuntimeState[];
  armies: Map<string, ArmyState>;
  contracts: Map<string, ContractRecord>;
  messages: MessageRecord[];
  reportsBySeat: Record<SeatId, SignedReport[]>;
  reportsById: Map<string, SignedReport>;
  ledger: LedgerBreachEntry[];
  scoutedHexesBySeat: Record<SeatId, number[]>;
  ordersByTick: Record<number, Record<SeatId, OrderItem[]>>;
  verifications: VerificationLogEntry[];
  nextArmyNumber: number;
  nextReportNumber: number;
  nextMessageNumber: number;
  lastSeq: number;
}

interface EngineEffect {
  kind: 'report_signed' | 'contract_breached' | 'village_captured' | 'match_finished';
  detail: Record<string, unknown>;
}

type TransitionOutcome =
  | { ok: true; state: MatchState; effects: EngineEffect[] }
  | { ok: false; rejection: WargamesRejection };

interface SeatStateView {
  matchId: string;
  status: MatchStatus;
  tick: number;
  maxTicks: number;
  phase: TickPhase;
  yourSeatId: SeatId;
  yourStatus: SeatStatus;
  yourTribeId: string | null;
  tribeMembers: SeatId[];
  seatStatuses: Record<SeatId, SeatStatus>;
  visibleVillages: VillageState[];
  visibleArmies: ProjectedArmyView[];
  contracts: ContractRecord[];
  ledger: LedgerBreachEntry[];
  winnerSeatId: SeatId | null;
}

const STARTING_GRAIN = 200;
const STARTING_ORE = 200;
const BARBARIAN_GRAIN = 80;
const BARBARIAN_ORE = 80;
const BASE_WAREHOUSE_CAP = 500;
const WAREHOUSE_PER_LEVEL = 200;
const BASE_PRODUCTION_PER_TICK = 25;
const PRODUCTION_PER_LEVEL = 20;
const INITIAL_LOYALTY = 100;
const CAPTURED_LOYALTY = 25;
const ENVOY_LOYALTY_DRAIN = 35;
const MAX_SCOUTS_PER_TICK = 2;

const BUILDING_COSTS: Readonly<Record<BuildingKind, ResourceBundle>> = Object.freeze({
  farm: { grain: 40, ore: 30 },
  mine: { grain: 30, ore: 40 },
  barracks: { grain: 50, ore: 50 },
  wall: { grain: 30, ore: 60 },
});

const TROOP_COSTS: Readonly<Record<TroopKind, ResourceBundle>> = Object.freeze({
  raider: { grain: 12, ore: 8 },
  guard: { grain: 8, ore: 12 },
  envoy: { grain: 25, ore: 20 },
});

const SEAT_INDEX_BY_ID: Readonly<Record<SeatId, number>> = Object.freeze({
  s1: 0, s2: 1, s3: 2, s4: 3, s5: 4, s6: 5,
});

const AXIAL_DIRECTIONS: readonly HexCoord[] = Object.freeze([
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]);

const TEXT_ENCODER = new TextEncoder();

export function seatIndexOf(seatId: SeatId): number {
  return SEAT_INDEX_BY_ID[seatId];
}

function hexRing(axialQ: number, axialR: number): number {
  const cubeS = -axialQ - axialR;
  return Math.max(Math.abs(axialQ), Math.abs(axialR), Math.abs(cubeS));
}

function hexDistance(first: HexCoord, second: HexCoord): number {
  const deltaQ = first.q - second.q;
  const deltaR = first.r - second.r;
  const deltaS = (-first.q - first.r) - (-second.q - second.r);
  return Math.max(Math.abs(deltaQ), Math.abs(deltaR), Math.abs(deltaS));
}

function buildHexGrid(): HexTile[] {
  const tiles: HexTile[] = [];
  for (let axialQ = -WARGAMES_HEX_RADIUS; axialQ <= WARGAMES_HEX_RADIUS; axialQ += 1) {
    for (let axialR = -WARGAMES_HEX_RADIUS; axialR <= WARGAMES_HEX_RADIUS; axialR += 1) {
      const ring = hexRing(axialQ, axialR);
      if (ring > WARGAMES_HEX_RADIUS) continue;
      tiles.push({ index: tiles.length, q: axialQ, r: axialR, ring });
    }
  }
  return tiles;
}

export const ALL_HEXES: readonly HexTile[] = Object.freeze(buildHexGrid());

const HEX_INDEX_BY_KEY: ReadonlyMap<string, number> = new Map(
  ALL_HEXES.map((tile) => [`${tile.q},${tile.r}`, tile.index]),
);

export function hexIndexAt(axialQ: number, axialR: number): number {
  return HEX_INDEX_BY_KEY.get(`${axialQ},${axialR}`) ?? -1;
}

function stepTowardHex(fromIndex: number, toIndex: number, maxSteps: number): number {
  let current = fromIndex;
  for (let step = 0; step < maxSteps; step += 1) {
    if (current === toIndex) return current;
    const fromTile = ALL_HEXES[current];
    const targetTile = ALL_HEXES[toIndex];
    let bestIndex = current;
    let bestDistance = hexDistance(fromTile, targetTile);
    for (const direction of AXIAL_DIRECTIONS) {
      const candidateIndex = hexIndexAt(fromTile.q + direction.q, fromTile.r + direction.r);
      if (candidateIndex < 0) continue;
      const candidateDistance = hexDistance(ALL_HEXES[candidateIndex], targetTile);
      if (candidateDistance >= bestDistance) continue;
      bestDistance = candidateDistance;
      bestIndex = candidateIndex;
    }
    current = bestIndex;
  }
  return current;
}

function nextMulberry32(rngState: number): { value: number; nextState: number } {
  const nextState = (rngState + 0x6d2b79f5) | 0;
  let mixed = Math.imul(nextState ^ (nextState >>> 15), 1 | nextState);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  const value = ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  return { value, nextState };
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, nested]) => [key, canonicalizeValue(nested)]);
  return Object.fromEntries(entries);
}

export function canonicalReportString(payload: SignedReportPayload): string {
  return JSON.stringify(canonicalizeValue(payload));
}

function utf8ByteLength(text: string): number {
  return TEXT_ENCODER.encode(text).length;
}

function emptyTroops(): TroopCounts {
  return { raider: 0, guard: 0, envoy: 0 };
}

function totalTroops(troops: TroopCounts): number {
  return troops.raider + troops.guard + troops.envoy;
}

function cloneVillage(village: VillageState | null): VillageState | null {
  if (village === null) return null;
  return {
    hexIndex: village.hexIndex,
    owner: village.owner,
    productionState: village.productionState,
    loyalty: village.loyalty,
    resources: { ...village.resources },
    buildings: { ...village.buildings },
    troops: { ...village.troops },
  };
}

function cloneState(state: MatchState): MatchState {
  const reportsBySeat = {} as Record<SeatId, SignedReport[]>;
  const scoutedHexesBySeat = {} as Record<SeatId, number[]>;
  for (const seatId of WARGAMES_SEAT_IDS) {
    reportsBySeat[seatId] = [...state.reportsBySeat[seatId]];
    scoutedHexesBySeat[seatId] = [...state.scoutedHexesBySeat[seatId]];
  }
  const armies = new Map<string, ArmyState>();
  for (const [armyId, army] of state.armies) {
    armies.set(armyId, { ...army, troops: { ...army.troops }, scoutedBy: [...army.scoutedBy] });
  }
  const contracts = new Map<string, ContractRecord>();
  for (const [contractId, contract] of state.contracts) {
    contracts.set(contractId, { ...contract });
  }
  const ordersByTick: Record<number, Record<SeatId, OrderItem[]>> = {};
  for (const [tickKey, seatOrders] of Object.entries(state.ordersByTick)) {
    const copied = {} as Record<SeatId, OrderItem[]>;
    for (const seatId of WARGAMES_SEAT_IDS) copied[seatId] = [...(seatOrders[seatId] ?? [])];
    ordersByTick[Number(tickKey)] = copied;
  }
  return {
    ...state,
    villages: state.villages.map(cloneVillage),
    seats: state.seats.map((seat) => ({ ...seat, sealedOrders: [...seat.sealedOrders] })),
    armies,
    contracts,
    messages: [...state.messages],
    reportsBySeat,
    reportsById: new Map(state.reportsById),
    ledger: [...state.ledger],
    scoutedHexesBySeat,
    ordersByTick,
    verifications: [...state.verifications],
  };
}

function seatHomeHexCoords(): HexCoord[][] {
  return [
    [{ q: 2, r: 0 }, { q: 2, r: -1 }, { q: 3, r: -1 }],
    [{ q: 0, r: -2 }, { q: 1, r: -2 }, { q: 1, r: -3 }],
    [{ q: -2, r: 0 }, { q: -1, r: -1 }, { q: -2, r: -1 }],
    [{ q: -2, r: 2 }, { q: -2, r: 1 }, { q: -3, r: 1 }],
    [{ q: 0, r: 2 }, { q: -1, r: 2 }, { q: -1, r: 3 }],
    [{ q: 1, r: 2 }, { q: 1, r: 1 }, { q: 2, r: 1 }],
  ];
}

function barbarianHexCoords(): HexCoord[] {
  return [
    { q: 0, r: 0 },
    { q: 1, r: 0 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 },
    { q: 1, r: -1 },
    { q: 3, r: 0 },
    { q: 0, r: -3 },
    { q: -3, r: 0 },
    { q: 0, r: 3 },
    { q: 3, r: -3 },
  ];
}

export function createInitialMatchState(
  matchId: string,
  createdAtMs: number,
  spec: WargamesMatchSpec,
): MatchState {
  const villages: (VillageState | null)[] = Array.from({ length: WARGAMES_HEX_COUNT }, () => null);
  const homeCoords = seatHomeHexCoords();
  for (let seatIdx = 0; seatIdx < WARGAMES_SEAT_IDS.length; seatIdx += 1) {
    const seatId = WARGAMES_SEAT_IDS[seatIdx];
    for (const coord of homeCoords[seatIdx]) {
      const hexIdx = hexIndexAt(coord.q, coord.r);
      villages[hexIdx] = {
        hexIndex: hexIdx,
        owner: seatId,
        productionState: 'producing',
        loyalty: INITIAL_LOYALTY,
        resources: { grain: STARTING_GRAIN, ore: STARTING_ORE },
        buildings: { farm: 1, mine: 1, barracks: 1, wall: 0 },
        troops: { raider: 6, guard: 6, envoy: 1 },
      };
    }
  }
  for (const coord of barbarianHexCoords()) {
    const hexIdx = hexIndexAt(coord.q, coord.r);
    if (villages[hexIdx] !== null) continue;
    villages[hexIdx] = {
      hexIndex: hexIdx,
      owner: null,
      productionState: 'producing',
      loyalty: INITIAL_LOYALTY,
      resources: { grain: BARBARIAN_GRAIN, ore: BARBARIAN_ORE },
      buildings: { farm: 1, mine: 1, barracks: 0, wall: 1 },
      troops: { raider: 3, guard: 4, envoy: 0 },
    };
  }
  const orderedSeats = WARGAMES_SEAT_IDS.map((seatId) => {
    const config = spec.seats.find((entry) => entry.seatId === seatId) ?? spec.seats[0];
    return {
      config,
      status: 'disconnected' as SeatStatus,
      note: '',
      messagesSentThisTick: 0,
      sealedOrders: [] as OrderItem[],
      tribeId: null,
    };
  });
  const reportsBySeat = {} as Record<SeatId, SignedReport[]>;
  const scoutedHexesBySeat = {} as Record<SeatId, number[]>;
  for (const seatId of WARGAMES_SEAT_IDS) {
    reportsBySeat[seatId] = [];
    scoutedHexesBySeat[seatId] = [];
  }
  return {
    matchId,
    createdAtMs,
    spec,
    status: 'lobby',
    tick: 0,
    phase: 'talk',
    rngState: spec.seed | 0,
    winnerSeatId: null,
    abortReason: null,
    hexes: [...ALL_HEXES],
    villages,
    seats: orderedSeats,
    armies: new Map(),
    contracts: new Map(),
    messages: [],
    reportsBySeat,
    reportsById: new Map(),
    ledger: [],
    scoutedHexesBySeat,
    ordersByTick: {},
    verifications: [],
    nextArmyNumber: 1,
    nextReportNumber: 1,
    nextMessageNumber: 1,
    lastSeq: 0,
  };
}

function reject(code: WargamesRejection['code'], message: string): TransitionOutcome {
  return { ok: false, rejection: { code, message } };
}

function seatTotalResources(state: MatchState, seatId: SeatId): ResourceBundle {
  let grain = 0;
  let ore = 0;
  for (const village of state.villages) {
    if (!village || village.owner !== seatId) continue;
    grain += village.resources.grain;
    ore += village.resources.ore;
  }
  return { grain, ore };
}

function deductSeatResources(state: MatchState, seatId: SeatId, amount: ResourceBundle): boolean {
  const available = seatTotalResources(state, seatId);
  if (available.grain < amount.grain || available.ore < amount.ore) return false;
  let remainingGrain = amount.grain;
  let remainingOre = amount.ore;
  for (const village of state.villages) {
    if (!village || village.owner !== seatId) continue;
    const takeGrain = Math.min(village.resources.grain, remainingGrain);
    village.resources.grain -= takeGrain;
    remainingGrain -= takeGrain;
    const takeOre = Math.min(village.resources.ore, remainingOre);
    village.resources.ore -= takeOre;
    remainingOre -= takeOre;
  }
  return true;
}

function creditSeatResources(state: MatchState, seatId: SeatId, amount: ResourceBundle): void {
  const owned = state.villages.filter((village): village is VillageState => village !== null && village.owner === seatId);
  if (owned.length === 0) return;
  let remainingGrain = amount.grain;
  let remainingOre = amount.ore;
  for (const village of owned) {
    const cap = warehouseCapOf(village);
    const grainRoom = Math.max(0, cap - village.resources.grain);
    const addGrain = Math.min(grainRoom, remainingGrain);
    village.resources.grain += addGrain;
    remainingGrain -= addGrain;
    const oreRoom = Math.max(0, cap - village.resources.ore);
    const addOre = Math.min(oreRoom, remainingOre);
    village.resources.ore += addOre;
    remainingOre -= addOre;
  }
  if (remainingGrain > 0) owned[0].resources.grain += remainingGrain;
  if (remainingOre > 0) owned[0].resources.ore += remainingOre;
}

function warehouseCapOf(village: VillageState): number {
  return BASE_WAREHOUSE_CAP + (village.buildings.farm + village.buildings.mine) * WAREHOUSE_PER_LEVEL;
}

function villagesOwnedBy(state: MatchState, seatId: SeatId): number {
  let count = 0;
  for (const village of state.villages) {
    if (village && village.owner === seatId) count += 1;
  }
  return count;
}

function resolveCombatPower(attackers: TroopCounts, defenders: TroopCounts, wallLevel: number): { attackPower: number; defensePower: number } {
  const raiderBonus = defenders.envoy > 0 ? 1.5 : 1;
  const envoyBonus = defenders.guard > 0 ? 1.5 : 1;
  const guardBonus = defenders.raider > 0 ? 1.5 : 1;
  const defRaiderBonus = attackers.envoy > 0 ? 1.5 : 1;
  const defEnvoyBonus = attackers.guard > 0 ? 1.5 : 1;
  const defGuardBonus = attackers.raider > 0 ? 1.5 : 1;
  const attackPower = attackers.raider * 10 * raiderBonus + attackers.guard * 10 * guardBonus + attackers.envoy * 8 * envoyBonus;
  const wallMultiplier = 1 + wallLevel * 0.15;
  const defensePower = (defenders.raider * 10 * defRaiderBonus + defenders.guard * 10 * defGuardBonus + defenders.envoy * 8 * defEnvoyBonus) * wallMultiplier;
  return { attackPower, defensePower };
}

function applyCasualties(troops: TroopCounts, lossFraction: number): { surviving: TroopCounts; lost: TroopCounts } {
  const clamped = Math.max(0, Math.min(1, lossFraction));
  const lostRaider = Math.min(troops.raider, Math.round(troops.raider * clamped));
  const lostGuard = Math.min(troops.guard, Math.round(troops.guard * clamped));
  const lostEnvoy = Math.min(troops.envoy, Math.round(troops.envoy * clamped));
  return {
    surviving: {
      raider: troops.raider - lostRaider,
      guard: troops.guard - lostGuard,
      envoy: troops.envoy - lostEnvoy,
    },
    lost: { raider: lostRaider, guard: lostGuard, envoy: lostEnvoy },
  };
}

function makeSignedReport(
  state: MatchState,
  payload: SignedReportPayload,
  signatures: Readonly<Record<string, string>>,
  signer?: ReportSigner,
): SignedReport {
  const canonical = canonicalReportString(payload);
  const signature = signatures[payload.reportId] ?? signer?.sign(canonical);
  if (!signature) {
    throw new Error(`Missing report signature for ${payload.reportId}: supply a ReportSigner or recorded signatures`);
  }
  const report: SignedReport = { payload, signature };
  state.reportsById.set(payload.reportId, report);
  return report;
}

function startActiveSeatsForPhase(state: MatchState): void {
  for (const seat of state.seats) {
    if (seat.status === 'eliminated' || seat.status === 'disconnected') continue;
    const transitioned = transitionSeat(seat.status, 'phase_start');
    if (transitioned.ok) seat.status = transitioned.state;
  }
}

function markUnsubmittedSeatsTimedOut(state: MatchState): void {
  for (const seat of state.seats) {
    if (seat.status !== 'acting') continue;
    const transitioned = transitionSeat(seat.status, 'phase_deadline');
    if (transitioned.ok) seat.status = transitioned.state;
  }
}

function resolveTick(
  state: MatchState,
  signatures: Readonly<Record<string, string>>,
  effects: EngineEffect[],
  signer?: ReportSigner,
): void {
  for (const seatId of WARGAMES_SEAT_IDS) {
    state.scoutedHexesBySeat[seatId] = [];
  }

  if (state.tick >= WARGAMES_SQUEEZE_TICK) {
    for (const village of state.villages) {
      if (!village || state.hexes[village.hexIndex].ring !== WARGAMES_HEX_RADIUS) continue;
      if (village.productionState !== 'producing') continue;
      const squeezed = transitionVillage(village.productionState, 'outer_ring_squeeze');
      if (squeezed.ok) village.productionState = squeezed.state;
    }
  }

  for (const village of state.villages) {
    if (!village || village.productionState !== 'producing') continue;
    const cap = warehouseCapOf(village);
    const grainGain = BASE_PRODUCTION_PER_TICK + village.buildings.farm * PRODUCTION_PER_LEVEL;
    const oreGain = BASE_PRODUCTION_PER_TICK + village.buildings.mine * PRODUCTION_PER_LEVEL;
    if (village.resources.grain < cap) village.resources.grain = Math.min(cap, village.resources.grain + grainGain);
    if (village.resources.ore < cap) village.resources.ore = Math.min(cap, village.resources.ore + oreGain);
  }

  const tickOrdersRecord = {} as Record<SeatId, OrderItem[]>;
  for (const seat of state.seats) {
    tickOrdersRecord[seat.config.seatId] = [...seat.sealedOrders];
  }

  for (const seat of state.seats) {
    for (const order of seat.sealedOrders) {
      if (order.kind !== 'tribe_leave' || seat.tribeId === null) continue;
      const formerTribe = seat.tribeId;
      for (const member of state.seats) {
        if (member.tribeId === formerTribe) member.tribeId = null;
      }
    }
  }

  for (const seat of state.seats) {
    for (const order of seat.sealedOrders) {
      if (order.kind !== 'tribe_join' || order.partner === seat.config.seatId) continue;
      const partnerSeat = state.seats[seatIndexOf(order.partner)];
      if (seat.tribeId !== null || partnerSeat.tribeId !== null) continue;
      const partnerRequested = partnerSeat.sealedOrders.some(
        (partnerOrder) => partnerOrder.kind === 'tribe_join' && partnerOrder.partner === seat.config.seatId,
      );
      if (!partnerRequested) continue;
      const pair = [seat.config.seatId, order.partner].sort();
      const tribeId = `tribe-${pair[0]}-${pair[1]}`;
      const membersCount = state.seats.filter((candidate) => candidate.tribeId === tribeId).length;
      if (membersCount >= WARGAMES_MAX_TRIBE_SIZE) continue;
      seat.tribeId = tribeId;
      partnerSeat.tribeId = tribeId;
    }
  }

  for (const seat of state.seats) {
    const builtHexes = new Set<number>();
    for (const order of seat.sealedOrders) {
      if (order.kind === 'build') {
        const village = state.villages[order.hexIndex];
        if (!village || village.owner !== seat.config.seatId || builtHexes.has(order.hexIndex)) continue;
        const cost = BUILDING_COSTS[order.building];
        if (village.resources.grain < cost.grain || village.resources.ore < cost.ore) continue;
        if (village.buildings[order.building] >= 10) continue;
        village.resources.grain -= cost.grain;
        village.resources.ore -= cost.ore;
        village.buildings[order.building] += 1;
        builtHexes.add(order.hexIndex);
        continue;
      }
      if (order.kind === 'train') {
        const village = state.villages[order.hexIndex];
        if (!village || village.owner !== seat.config.seatId) continue;
        const unitCost = TROOP_COSTS[order.troop];
        const totalGrain = unitCost.grain * order.count;
        const totalOre = unitCost.ore * order.count;
        if (village.resources.grain < totalGrain || village.resources.ore < totalOre) continue;
        village.resources.grain -= totalGrain;
        village.resources.ore -= totalOre;
        village.troops[order.troop] += order.count;
      }
    }
  }

  for (const seat of state.seats) {
    for (const order of seat.sealedOrders) {
      if (order.kind !== 'march') continue;
      const village = state.villages[order.fromHexIndex];
      if (!village || village.owner !== seat.config.seatId) continue;
      if (totalTroops(order.troops) <= 0) continue;
      if (village.troops.raider < order.troops.raider || village.troops.guard < order.troops.guard || village.troops.envoy < order.troops.envoy) continue;
      village.troops.raider -= order.troops.raider;
      village.troops.guard -= order.troops.guard;
      village.troops.envoy -= order.troops.envoy;
      const armyId = `army-${state.nextArmyNumber}`;
      state.nextArmyNumber += 1;
      const departed = transitionArmy('mustering', 'army_depart');
      if (!departed.ok) continue;
      state.armies.set(armyId, {
        id: armyId,
        owner: seat.config.seatId,
        status: departed.state,
        originHexIndex: order.fromHexIndex,
        currentHexIndex: order.fromHexIndex,
        targetHexIndex: order.toHexIndex,
        troops: { ...order.troops },
        departedTick: state.tick,
        intendedTargetOwner: state.villages[order.toHexIndex]?.owner ?? null,
        scoutedBy: [],
      });
    }
  }

  for (const seat of state.seats) {
    let scoutsUsed = 0;
    for (const order of seat.sealedOrders) {
      if (order.kind !== 'scout') continue;
      if (scoutsUsed >= MAX_SCOUTS_PER_TICK) break;
      const origin = state.villages[order.fromHexIndex];
      const target = state.villages[order.toHexIndex];
      if (!origin || origin.owner !== seat.config.seatId || !target) continue;
      scoutsUsed += 1;
      const scoutedSet = new Set(state.scoutedHexesBySeat[seat.config.seatId]);
      scoutedSet.add(order.toHexIndex);
      state.scoutedHexesBySeat[seat.config.seatId] = [...scoutedSet];
      const spottedArmyIds: string[] = [];
      for (const army of state.armies.values()) {
        if (army.status !== 'marching' && army.status !== 'returning') continue;
        if (army.currentHexIndex !== order.toHexIndex && army.targetHexIndex !== order.toHexIndex) continue;
        if (!army.scoutedBy.includes(seat.config.seatId)) army.scoutedBy.push(seat.config.seatId);
        spottedArmyIds.push(army.id);
      }
      const reportId = `rep-${state.nextReportNumber}`;
      state.nextReportNumber += 1;
      const report = makeSignedReport(state, {
        kind: 'scout',
        reportId,
        tick: state.tick,
        scoutSeat: seat.config.seatId,
        targetHexIndex: order.toHexIndex,
        owner: target.owner,
        productionState: target.productionState,
        loyalty: target.loyalty,
        resources: { ...target.resources },
        troops: { ...target.troops },
        buildings: { ...target.buildings },
        spottedArmyIds,
      }, signatures, signer);
      state.reportsBySeat[seat.config.seatId].push(report);
      effects.push({ kind: 'report_signed', detail: { reportId, seatId: seat.config.seatId, signature: report.signature } });
    }
  }

  for (const seat of state.seats) {
    seat.sealedOrders = [];
    seat.messagesSentThisTick = 0;
  }
  state.ordersByTick[state.tick] = tickOrdersRecord;

  for (const army of state.armies.values()) {
    if (army.status === 'marching') {
      army.currentHexIndex = stepTowardHex(army.currentHexIndex, army.targetHexIndex, WARGAMES_TRAVEL_HEXES_PER_TICK);
      if (army.currentHexIndex !== army.targetHexIndex) continue;
      const arrived = transitionArmy(army.status, 'army_arrive');
      if (!arrived.ok) continue;
      army.status = arrived.state;
      const targetVillage = state.villages[army.targetHexIndex];
      if (!targetVillage) {
        const returning = transitionArmy(army.status, 'army_return');
        if (returning.ok) army.status = returning.state;
        continue;
      }
      if (targetVillage.owner === army.owner) {
        targetVillage.troops.raider += army.troops.raider;
        targetVillage.troops.guard += army.troops.guard;
        targetVillage.troops.envoy += army.troops.envoy;
        army.troops = emptyTroops();
        const reached = transitionArmy(army.status, 'army_return');
        if (reached.ok) {
          const home = transitionArmy(reached.state, 'army_reach_home');
          if (home.ok) army.status = home.state;
        }
        continue;
      }
      if (targetVillage.owner !== null) {
        const activeNaps = [...state.contracts.values()].filter((contract) => {
          if (contract.status !== 'active' || contract.terms.kind !== 'nap') return false;
          return (contract.proposer === army.owner && contract.counterparty === targetVillage.owner)
            || (contract.counterparty === army.owner && contract.proposer === targetVillage.owner);
        });
        if (army.intendedTargetOwner !== targetVillage.owner && activeNaps.length > 0) {
          const returning = transitionArmy(army.status, 'army_return');
          if (returning.ok) army.status = returning.state;
          continue;
        }
        for (const contract of activeNaps) {
          if (contract.terms.kind !== 'nap') continue;
          const breached = transitionContract(contract.status, 'contract_breach');
          if (!breached.ok) continue;
          contract.status = breached.state;
          contract.breachedBy = army.owner;
          contract.breachedTick = state.tick;
          const collateral = contract.terms.collateral;
          creditSeatResources(state, targetVillage.owner, {
            grain: collateral.grain * 2,
            ore: collateral.ore * 2,
          });
          state.ledger.push({
            tick: state.tick,
            contractId: contract.id,
            breacher: army.owner,
            victim: targetVillage.owner,
            collateralTransferred: { ...collateral },
          });
          effects.push({ kind: 'contract_breached', detail: { contractId: contract.id, breacher: army.owner, victim: targetVillage.owner } });
        }
      }
      const defenderBefore = { ...targetVillage.troops };
      const attackerSent = { ...army.troops };
      const loyaltyBefore = targetVillage.loyalty;
      const { value: rngRoll, nextState: nextRng } = nextMulberry32(state.rngState);
      state.rngState = nextRng;
      const { attackPower, defensePower } = resolveCombatPower(army.troops, targetVillage.troops, targetVillage.buildings.wall);
      const jitteredAttack = attackPower * (0.9 + rngRoll * 0.2);
      const attackerWins = jitteredAttack >= defensePower;
      const attackerLossFraction = attackerWins ? (defensePower / Math.max(1, jitteredAttack)) * 0.65 : 1;
      const defenderLossFraction = attackerWins ? 1 : (jitteredAttack / Math.max(1, defensePower)) * 0.65;
      const attackerOutcome = applyCasualties(army.troops, attackerLossFraction);
      const defenderOutcome = applyCasualties(targetVillage.troops, defenderLossFraction);
      targetVillage.troops = defenderOutcome.surviving;
      let captured = false;
      const previousOwner = targetVillage.owner;
      if (attackerWins && attackerOutcome.surviving.envoy > 0) {
        const drained = Math.max(0, targetVillage.loyalty - attackerOutcome.surviving.envoy * ENVOY_LOYALTY_DRAIN);
        targetVillage.loyalty = drained;
        if (drained === 0) {
          targetVillage.owner = army.owner;
          targetVillage.loyalty = CAPTURED_LOYALTY;
          captured = true;
          effects.push({ kind: 'village_captured', detail: { hexIndex: targetVillage.hexIndex, newOwner: army.owner, previousOwner } });
        }
      }
      const reportId = `rep-${state.nextReportNumber}`;
      state.nextReportNumber += 1;
      const report = makeSignedReport(state, {
        kind: 'battle',
        reportId,
        tick: state.tick,
        hexIndex: targetVillage.hexIndex,
        attacker: army.owner,
        defender: previousOwner,
        attackerSent,
        attackerLost: attackerOutcome.lost,
        defenderBefore,
        defenderLost: defenderOutcome.lost,
        loyaltyBefore,
        loyaltyAfter: targetVillage.loyalty,
        captured,
      }, signatures, signer);
      state.reportsBySeat[army.owner].push(report);
      if (previousOwner !== null) state.reportsBySeat[previousOwner].push(report);
      effects.push({ kind: 'report_signed', detail: { reportId, seatId: army.owner, signature: report.signature } });
      if (totalTroops(attackerOutcome.surviving) <= 0) {
        army.troops = emptyTroops();
        const destroyed = transitionArmy(army.status, 'army_destroy');
        if (destroyed.ok) army.status = destroyed.state;
        continue;
      }
      army.troops = attackerOutcome.surviving;
      const returning = transitionArmy(army.status, 'army_return');
      if (returning.ok) army.status = returning.state;
      continue;
    }
    if (army.status === 'returning') {
      army.currentHexIndex = stepTowardHex(army.currentHexIndex, army.originHexIndex, WARGAMES_TRAVEL_HEXES_PER_TICK);
      if (army.currentHexIndex !== army.originHexIndex) continue;
      const homeVillage = state.villages[army.originHexIndex];
      if (homeVillage && homeVillage.owner === army.owner) {
        homeVillage.troops.raider += army.troops.raider;
        homeVillage.troops.guard += army.troops.guard;
        homeVillage.troops.envoy += army.troops.envoy;
      }
      army.troops = emptyTroops();
      const home = transitionArmy(army.status, 'army_reach_home');
      if (home.ok) army.status = home.state;
    }
  }

  for (const contract of state.contracts.values()) {
    if (contract.status === 'proposed' && contract.proposedTick < state.tick) {
      const expired = transitionContract(contract.status, 'contract_expire');
      if (expired.ok) contract.status = expired.state;
      continue;
    }
    if (contract.status === 'active' && contract.terms.kind === 'nap' && contract.endTick !== null && state.tick >= contract.endTick) {
      const fulfilled = transitionContract(contract.status, 'contract_fulfill');
      if (!fulfilled.ok) continue;
      contract.status = fulfilled.state;
      creditSeatResources(state, contract.proposer, contract.terms.collateral);
      creditSeatResources(state, contract.counterparty, contract.terms.collateral);
    }
  }

  for (const seat of state.seats) {
    if (seat.status === 'eliminated') continue;
    if (villagesOwnedBy(state, seat.config.seatId) > 0) continue;
    const eliminated = transitionSeat(seat.status, 'seat_eliminated');
    if (eliminated.ok) seat.status = eliminated.state;
  }
}

function determineWinnerAtLimit(state: MatchState): SeatId {
  let bestSeat: SeatId = WARGAMES_SEAT_IDS[0];
  let bestVillages = -1;
  let bestTroops = -1;
  let bestResources = -1;
  for (const seatId of WARGAMES_SEAT_IDS) {
    const owned = villagesOwnedBy(state, seatId);
    let troops = 0;
    let resources = 0;
    for (const village of state.villages) {
      if (!village || village.owner !== seatId) continue;
      troops += totalTroops(village.troops);
      resources += village.resources.grain + village.resources.ore;
    }
    const isBetter = owned > bestVillages
      || (owned === bestVillages && troops > bestTroops)
      || (owned === bestVillages && troops === bestTroops && resources > bestResources);
    if (!isBetter) continue;
    bestSeat = seatId;
    bestVillages = owned;
    bestTroops = troops;
    bestResources = resources;
  }
  return bestSeat;
}

export function applyEvent(
  currentState: MatchState,
  event: WargamesEvent,
  signer?: ReportSigner,
): TransitionOutcome {
  if (event.type === 'match_created') {
    return reject('invalid_match_state', 'match_created initializes a match via createInitialMatchState only');
  }

  const state = cloneState(currentState);
  const effects: EngineEffect[] = [];

  if (event.type === 'match_aborted') {
    const nextMatch = transitionMatch(state.status, 'abort_match');
    if (!nextMatch.ok) return nextMatch;
    state.status = nextMatch.state;
    state.abortReason = event.reason;
    state.lastSeq = event.seq;
    return { ok: true, state, effects };
  }

  if (event.type === 'seating_started') {
    const nextMatch = transitionMatch(state.status, 'begin_seating');
    if (!nextMatch.ok) return nextMatch;
    state.status = nextMatch.state;
    state.lastSeq = event.seq;
    return { ok: true, state, effects };
  }

  if (event.type === 'seat_connected') {
    if (state.status !== 'seating' && state.status !== 'running') {
      return reject('invalid_match_state', `cannot connect seat in ${state.status}`);
    }
    const seat = state.seats[seatIndexOf(event.seatId)];
    const nextSeat = transitionSeat(seat.status, 'seat_connect');
    if (!nextSeat.ok) return nextSeat;
    seat.status = nextSeat.state;
    if (state.status === 'seating' && state.seats.every((entry) => entry.status === 'connected')) {
      const started = transitionMatch(state.status, 'all_seats_connected');
      if (!started.ok) return started;
      state.status = started.state;
      state.tick = 1;
      state.phase = 'talk';
      startActiveSeatsForPhase(state);
    }
    if (state.status === 'running' && (state.phase === 'talk' || state.phase === 'contracts' || state.phase === 'orders')) {
      const acting = transitionSeat(seat.status, 'phase_start');
      if (acting.ok) seat.status = acting.state;
    }
    state.lastSeq = event.seq;
    return { ok: true, state, effects };
  }

  if (event.type === 'seat_disconnected') {
    if (state.status !== 'seating' && state.status !== 'running') {
      return reject('invalid_match_state', `cannot disconnect seat in ${state.status}`);
    }
    const seat = state.seats[seatIndexOf(event.seatId)];
    const nextSeat = transitionSeat(seat.status, 'seat_disconnect');
    if (!nextSeat.ok) return nextSeat;
    seat.status = nextSeat.state;
    state.lastSeq = event.seq;
    return { ok: true, state, effects };
  }

  if (state.status !== 'running') {
    return reject('invalid_match_state', `action ${event.type} requires running match, got ${state.status}`);
  }

  if (event.type === 'note_written') {
    if (utf8ByteLength(event.text) > WARGAMES_NOTE_MAX_BYTES) {
      return reject('note_too_large', `note exceeds ${WARGAMES_NOTE_MAX_BYTES} bytes`);
    }
    const seat = state.seats[seatIndexOf(event.seatId)];
    if (seat.status === 'eliminated') return reject('invalid_seat_state', 'eliminated seat cannot write notes');
    seat.note = event.text;
    state.lastSeq = event.seq;
    return { ok: true, state, effects };
  }

  if (event.type === 'report_verified') {
    const seat = state.seats[seatIndexOf(event.seatId)];
    if (seat.status === 'eliminated' || seat.status === 'disconnected') {
      return reject('invalid_seat_state', `seat ${event.seatId} cannot verify reports while ${seat.status}`);
    }
    state.verifications.push({
      tick: state.tick,
      seatId: event.seatId,
      reportId: event.reportId,
      valid: event.valid,
    });
    state.lastSeq = event.seq;
    return { ok: true, state, effects };
  }

  if (event.type === 'message_sent') {
    if (state.phase !== 'talk') return reject('invalid_phase', `send_message allowed only in talk phase, got ${state.phase}`);
    const seat = state.seats[seatIndexOf(event.seatId)];
    if (seat.status !== 'acting') return reject('invalid_seat_state', `seat ${event.seatId} is ${seat.status}`);
    if (seat.messagesSentThisTick >= WARGAMES_MAX_MESSAGES_PER_TICK) {
      return reject('message_limit_exceeded', `at most ${WARGAMES_MAX_MESSAGES_PER_TICK} messages per tick`);
    }
    if (event.channel === 'dm' && (event.to === null || event.to === event.seatId)) {
      return reject('invalid_target', 'dm requires another seat as recipient');
    }
    if (event.channel === 'tribe' && seat.tribeId === null) {
      return reject('invalid_target', 'seat is not in a tribe');
    }
    const id = `msg-${state.nextMessageNumber}`;
    state.nextMessageNumber += 1;
    seat.messagesSentThisTick += 1;
    state.messages.push({
      id,
      tick: state.tick,
      from: event.seatId,
      to: event.channel === 'dm' ? event.to : null,
      channel: event.channel,
      tribeId: event.channel === 'tribe' ? seat.tribeId : null,
      text: event.text,
      attachedReport: event.attachedReport,
    });
    state.lastSeq = event.seq;
    return { ok: true, state, effects };
  }

  if (event.type === 'contract_proposed') {
    if (state.phase !== 'contracts') return reject('invalid_phase', `propose_contract allowed only in contracts phase, got ${state.phase}`);
    const seat = state.seats[seatIndexOf(event.seatId)];
    if (seat.status !== 'acting') return reject('invalid_seat_state', `seat ${event.seatId} is ${seat.status}`);
    if (event.terms.counterparty === event.seatId) return reject('invalid_target', 'cannot propose contract to self');
    if (state.contracts.has(event.contractId)) return reject('invalid_contract_state', `duplicate contract id ${event.contractId}`);
    state.contracts.set(event.contractId, {
      id: event.contractId,
      proposer: event.seatId,
      counterparty: event.terms.counterparty,
      terms: event.terms,
      status: 'proposed',
      proposedTick: state.tick,
      activatedTick: null,
      endTick: null,
      breachedBy: null,
      breachedTick: null,
    });
    state.lastSeq = event.seq;
    return { ok: true, state, effects };
  }

  if (event.type === 'contract_accepted') {
    if (state.phase !== 'contracts') return reject('invalid_phase', `accept_contract allowed only in contracts phase, got ${state.phase}`);
    const actingSeat = state.seats[seatIndexOf(event.seatId)];
    if (actingSeat.status !== 'acting') return reject('invalid_seat_state', `seat ${event.seatId} is ${actingSeat.status}`);
    const contract = state.contracts.get(event.contractId);
    if (!contract) return reject('invalid_contract_state', `unknown contract ${event.contractId}`);
    if (contract.counterparty !== event.seatId) return reject('unauthorized_seat', 'only the counterparty can accept a contract');
    if (state.seats[seatIndexOf(contract.proposer)].status === 'eliminated') {
      return reject('invalid_seat_state', `proposer ${contract.proposer} is eliminated`);
    }
    const activated = transitionContract(contract.status, 'contract_accept');
    if (!activated.ok) return activated;
    if (contract.terms.kind === 'escrow') {
      const proposerResources = seatTotalResources(state, contract.proposer);
      const counterResources = seatTotalResources(state, contract.counterparty);
      if (proposerResources.grain < contract.terms.proposerGives.grain || proposerResources.ore < contract.terms.proposerGives.ore) {
        return reject('insufficient_resources', 'proposer lacks escrow resources');
      }
      if (counterResources.grain < contract.terms.counterpartyGives.grain || counterResources.ore < contract.terms.counterpartyGives.ore) {
        return reject('insufficient_resources', 'counterparty lacks escrow resources');
      }
      deductSeatResources(state, contract.proposer, contract.terms.proposerGives);
      deductSeatResources(state, contract.counterparty, contract.terms.counterpartyGives);
      creditSeatResources(state, contract.proposer, contract.terms.counterpartyGives);
      creditSeatResources(state, contract.counterparty, contract.terms.proposerGives);
      const fulfilled = transitionContract(activated.state, 'contract_fulfill');
      if (!fulfilled.ok) return fulfilled;
      contract.status = fulfilled.state;
      contract.activatedTick = state.tick;
      contract.endTick = state.tick;
      state.lastSeq = event.seq;
      return { ok: true, state, effects };
    }
    const proposerFunds = seatTotalResources(state, contract.proposer);
    const counterFunds = seatTotalResources(state, contract.counterparty);
    if (proposerFunds.grain < contract.terms.collateral.grain || proposerFunds.ore < contract.terms.collateral.ore) {
      return reject('insufficient_resources', 'proposer lacks NAP collateral');
    }
    if (counterFunds.grain < contract.terms.collateral.grain || counterFunds.ore < contract.terms.collateral.ore) {
      return reject('insufficient_resources', 'counterparty lacks NAP collateral');
    }
    deductSeatResources(state, contract.proposer, contract.terms.collateral);
    deductSeatResources(state, contract.counterparty, contract.terms.collateral);
    contract.status = activated.state;
    contract.activatedTick = state.tick;
    contract.endTick = state.tick + contract.terms.durationTicks;
    state.lastSeq = event.seq;
    return { ok: true, state, effects };
  }

  if (event.type === 'contract_rejected') {
    if (state.phase !== 'contracts') return reject('invalid_phase', `reject_contract allowed only in contracts phase, got ${state.phase}`);
    const actingSeat = state.seats[seatIndexOf(event.seatId)];
    if (actingSeat.status !== 'acting') return reject('invalid_seat_state', `seat ${event.seatId} is ${actingSeat.status}`);
    const contract = state.contracts.get(event.contractId);
    if (!contract) return reject('invalid_contract_state', `unknown contract ${event.contractId}`);
    if (contract.counterparty !== event.seatId) return reject('unauthorized_seat', 'only the counterparty can reject a contract');
    const rejected = transitionContract(contract.status, 'contract_reject');
    if (!rejected.ok) return rejected;
    contract.status = rejected.state;
    state.lastSeq = event.seq;
    return { ok: true, state, effects };
  }

  if (event.type === 'orders_submitted') {
    if (state.phase !== 'orders') return reject('invalid_phase', `submit_orders allowed only in orders phase, got ${state.phase}`);
    const seat = state.seats[seatIndexOf(event.seatId)];
    const submitted = transitionSeat(seat.status, 'seat_submit');
    if (!submitted.ok) return submitted;
    seat.status = submitted.state;
    seat.sealedOrders = [...event.orders];
    state.lastSeq = event.seq;
    return { ok: true, state, effects };
  }

  if (event.type === 'phase_advanced') {
    if (event.reason === 'deadline') markUnsubmittedSeatsTimedOut(state);
    if (state.phase === 'talk' || state.phase === 'contracts') {
      const nextPhase = transitionTick(state.phase, 'phase_complete');
      if (!nextPhase.ok) return nextPhase;
      state.phase = nextPhase.state;
      startActiveSeatsForPhase(state);
      state.lastSeq = event.seq;
      return { ok: true, state, effects };
    }
    if (state.phase === 'orders') {
      const resolving = transitionTick(state.phase, 'phase_complete');
      if (!resolving.ok) return resolving;
      state.phase = resolving.state;
      resolveTick(state, event.signatures, effects, signer);
      const reported = transitionTick(state.phase, 'resolution_complete');
      if (!reported.ok) return reported;
      state.phase = reported.state;
      const hasThresholdWinner = WARGAMES_SEAT_IDS.some((seatId) => villagesOwnedBy(state, seatId) >= WARGAMES_WIN_VILLAGES);
      if (hasThresholdWinner) {
        const winSeat = determineWinnerAtLimit(state);
        const finished = transitionMatch(state.status, 'match_won');
        if (!finished.ok) return finished;
        state.status = finished.state;
        state.winnerSeatId = winSeat;
        effects.push({ kind: 'match_finished', detail: { winnerSeatId: winSeat, reason: 'villages' } });
        state.lastSeq = event.seq;
        return { ok: true, state, effects };
      }
      if (state.tick >= state.spec.maxTicks) {
        const finished = transitionMatch(state.status, 'tick_limit_reached');
        if (!finished.ok) return finished;
        state.status = finished.state;
        state.winnerSeatId = determineWinnerAtLimit(state);
        effects.push({ kind: 'match_finished', detail: { winnerSeatId: state.winnerSeatId, reason: 'tick_limit' } });
        state.lastSeq = event.seq;
        return { ok: true, state, effects };
      }
      state.lastSeq = event.seq;
      return { ok: true, state, effects };
    }
    if (state.phase === 'reported') {
      const nextTalk = transitionTick(state.phase, 'next_tick');
      if (!nextTalk.ok) return nextTalk;
      state.phase = nextTalk.state;
      state.tick += 1;
      startActiveSeatsForPhase(state);
      state.lastSeq = event.seq;
      return { ok: true, state, effects };
    }
    return reject('invalid_phase', `cannot advance from ${state.phase}`);
  }

  return reject('invalid_order', 'unhandled event');
}

export function replayMatch(events: readonly WargamesEvent[], signer?: ReportSigner): MatchState {
  if (events.length === 0 || events[0].type !== 'match_created') {
    throw new Error('Wargames event log must start with match_created');
  }
  const first = events[0];
  let state = createInitialMatchState(first.matchId, first.createdAtMs, first.spec);
  for (let index = 1; index < events.length; index += 1) {
    const outcome = applyEvent(state, events[index], signer);
    if (!outcome.ok) {
      throw new Error(`Replay rejected event #${index} (${events[index].type}): ${outcome.rejection.message}`);
    }
    state = outcome.state;
  }
  return state;
}

export function replayMatchAtTick(events: readonly WargamesEvent[], targetTick: number, signer?: ReportSigner): MatchState {
  if (events.length === 0 || events[0].type !== 'match_created') {
    throw new Error('Wargames event log must start with match_created');
  }
  const first = events[0];
  let state = createInitialMatchState(first.matchId, first.createdAtMs, first.spec);
  for (let index = 1; index < events.length; index += 1) {
    const outcome = applyEvent(state, events[index], signer);
    if (!outcome.ok) {
      throw new Error(`Replay rejected event #${index} (${events[index].type}): ${outcome.rejection.message}`);
    }
    if (outcome.state.tick > targetTick) break;
    state = outcome.state;
  }
  return state;
}

export function projectSeatState(state: MatchState, seatId: SeatId): SeatStateView {
  const seat = state.seats[seatIndexOf(seatId)];
  const ownedHexIndices = state.villages
    .filter((village): village is VillageState => village !== null && village.owner === seatId)
    .map((village) => village.hexIndex);
  const scoutedSet = new Set(state.scoutedHexesBySeat[seatId]);
  const visibleHexes = new Set<number>([...ownedHexIndices, ...scoutedSet]);
  for (const ownedIdx of ownedHexIndices) {
    const ownedTile = state.hexes[ownedIdx];
    for (const tile of state.hexes) {
      if (hexDistance(ownedTile, tile) <= 1) visibleHexes.add(tile.index);
    }
  }
  const visibleVillages = state.villages
    .filter((village): village is VillageState => village !== null && visibleHexes.has(village.hexIndex))
    .map((village) => {
      if (village.owner === seatId || scoutedSet.has(village.hexIndex)) return cloneVillage(village) as VillageState;
      return {
        ...cloneVillage(village) as VillageState,
        resources: { grain: 0, ore: 0 },
        troops: emptyTroops(),
      };
    });
  const visibleArmies: ProjectedArmyView[] = [];
  for (const army of state.armies.values()) {
    if (army.status !== 'marching' && army.status !== 'returning') continue;
    if (army.owner !== seatId && !army.scoutedBy.includes(seatId)) continue;
    visibleArmies.push({
      id: army.id,
      owner: army.owner,
      status: army.status,
      originHexIndex: army.originHexIndex,
      currentHexIndex: army.currentHexIndex,
      targetHexIndex: army.targetHexIndex,
      troops: { ...army.troops },
      departedTick: army.departedTick,
    });
  }
  const seatStatuses = {} as Record<SeatId, SeatStatus>;
  for (const entry of state.seats) seatStatuses[entry.config.seatId] = entry.status;
  const tribeMembers = seat.tribeId === null
    ? []
    : state.seats.filter((entry) => entry.tribeId === seat.tribeId).map((entry) => entry.config.seatId);
  const visibleContracts = [...state.contracts.values()].filter(
    (contract) => contract.proposer === seatId || contract.counterparty === seatId,
  );
  return {
    matchId: state.matchId,
    status: state.status,
    tick: state.tick,
    maxTicks: state.spec.maxTicks,
    phase: state.phase,
    yourSeatId: seatId,
    yourStatus: seat.status,
    yourTribeId: seat.tribeId,
    tribeMembers,
    seatStatuses,
    visibleVillages,
    visibleArmies,
    contracts: visibleContracts,
    ledger: [...state.ledger],
    winnerSeatId: state.winnerSeatId,
  };
}
