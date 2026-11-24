import {
  BuildingKind,
  WARGAMES_HEX_RADIUS,
  WARGAMES_SEAT_COUNTS,
  WARGAMES_MAX_HEX_RADIUS,
  WARGAMES_MAX_MESSAGES_PER_TICK,
  WARGAMES_MAX_TRIBE_SIZE,
  WARGAMES_MIN_HEX_RADIUS,
  WARGAMES_NOTE_MAX_BYTES,
  WARGAMES_SEAT_IDS,
  WARGAMES_SQUEEZE_TICK,
  WARGAMES_TRAVEL_HEXES_PER_TICK,
  valueForRadius,
  troopCostsFor,
  victoryPointTargetFor,
  victoryVillagesForBalance,
  wargamesBalanceFor,
} from '../contracts/wargames.ts';
import type {
  ArmyStatus,
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
  WargamesBalance,
  WargamesSeatCount,
  SeatStatus,
  SignedReport,
  SignedReportPayload,
  TickPhase,
  TroopCounts,
  VillageProductionState,
  WargamesEvent,
  WargamesMatchSpec,
  WargamesRejection,
  WargamesRolesRule,
} from '../contracts/wargames.ts';
import {
  transitionArmy,
  transitionContract,
  transitionMatch,
  transitionSeat,
  transitionTick,
  transitionVillage,
} from './machines.ts';
import { BONUS_TILE_YIELD, FOREST_DEFENSE_MULTIPLIER, generateClusteredTerrain, generateTerrain, isPassable, marchCostOf, pickBeaconKeys, pickVillageKeys, tileKey } from './terrain.ts';
import type { TerrainKind } from './terrain.ts';

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
  isBeacon: boolean;
  guests: StationedGuest[];
}

interface StationedGuest {
  owner: SeatId;
  originHexIndex: number;
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
  supporting?: SeatId;
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
  readySeatIds: SeatId[];
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
  balance: WargamesBalance;
  goalStreak: GoalStreak;
  terrain: TerrainKind[];
  victoryPointsBySeat: Record<SeatId, number>;
}

interface GoalStreak {
  seatId: SeatId | null;
  turns: number;
}

interface EngineEffect {
  kind: 'report_signed' | 'contract_breached' | 'village_captured' | 'match_finished';
  detail: Record<string, unknown>;
}

type TransitionOutcome =
  | { ok: true; state: MatchState; effects: EngineEffect[] }
  | { ok: false; rejection: WargamesRejection };

interface NearbyHexOwner {
  hexIndex: number;
  owner: SeatId | null;
}

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
  nearbyHexOwners: NearbyHexOwner[];
  visibleArmies: ProjectedArmyView[];
  contracts: ContractRecord[];
  ledger: LedgerBreachEntry[];
  reputation: SeatReputation[];
  winnerSeatId: SeatId | null;
  terrain: { hexIndex: number; kind: TerrainKind }[];
  sites: { hexIndex: number; isBeacon: boolean }[];
  victoryPointsBySeat: Record<SeatId, number>;
  victoryPointTarget: number | null;
}

interface SeatReputation {
  seatId: SeatId;
  kept: number;
  broken: number;
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
const BEACON_GUARDS = 6;
const MAX_SCOUTS_PER_TICK = 2;

const SEAT_INDEX_BY_ID: Readonly<Record<SeatId, number>> = Object.freeze({
  s1: 0, s2: 1, s3: 2, s4: 3, s5: 4, s6: 5,
});

const RULES_VERSION_RANK: Readonly<Record<WargamesMatchSpec['rulesVersion'], number>> = Object.freeze({
  v1: 1, v2: 2, v3: 3, v4: 4, v5: 5, v6: 6, v7: 7, v8: 8,
});

function isRulesAtLeast(
  version: WargamesMatchSpec['rulesVersion'],
  minimumVersion: WargamesMatchSpec['rulesVersion'],
): boolean {
  return RULES_VERSION_RANK[version] >= RULES_VERSION_RANK[minimumVersion];
}

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

export function matchSeatIds(state: Pick<MatchState, 'seats'>): SeatId[] {
  return state.seats.map((seat) => seat.config.seatId);
}

function isSeatInMatch(state: Pick<MatchState, 'seats'>, seatId: SeatId): boolean {
  return seatIndexOf(seatId) < state.seats.length;
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

function buildHexGrid(radius: number): HexTile[] {
  const tiles: HexTile[] = [];
  for (let axialQ = -radius; axialQ <= radius; axialQ += 1) {
    for (let axialR = -radius; axialR <= radius; axialR += 1) {
      const ring = hexRing(axialQ, axialR);
      if (ring > radius) continue;
      tiles.push({ index: tiles.length, q: axialQ, r: axialR, ring });
    }
  }
  return tiles;
}

const HEX_GRIDS_BY_RADIUS = new Map<number, readonly HexTile[]>();
const HEX_INDEX_MAPS_BY_RADIUS = new Map<number, ReadonlyMap<string, number>>();
for (let radius = WARGAMES_MIN_HEX_RADIUS; radius <= WARGAMES_MAX_HEX_RADIUS; radius += 1) {
  const grid = Object.freeze(buildHexGrid(radius));
  HEX_GRIDS_BY_RADIUS.set(radius, grid);
  HEX_INDEX_MAPS_BY_RADIUS.set(radius, new Map(grid.map((tile) => [`${tile.q},${tile.r}`, tile.index])));
}

export const ALL_HEXES: readonly HexTile[] = HEX_GRIDS_BY_RADIUS.get(WARGAMES_HEX_RADIUS) ?? Object.freeze(buildHexGrid(WARGAMES_HEX_RADIUS));

function hexGridForRadius(radius: number): readonly HexTile[] {
  return HEX_GRIDS_BY_RADIUS.get(radius) ?? ALL_HEXES;
}

export function hexIndexAt(axialQ: number, axialR: number, radius = WARGAMES_HEX_RADIUS): number {
  return HEX_INDEX_MAPS_BY_RADIUS.get(radius)?.get(`${axialQ},${axialR}`) ?? -1;
}

function stepTowardHex(radius: number, fromIndex: number, toIndex: number, maxSteps: number): number {
  const grid = hexGridForRadius(radius);
  let current = fromIndex;
  for (let step = 0; step < maxSteps; step += 1) {
    if (current === toIndex) return current;
    const fromTile = grid[current];
    const targetTile = grid[toIndex];
    if (!fromTile || !targetTile) return current;
    let bestIndex = current;
    let bestDistance = hexDistance(fromTile, targetTile);
    for (const direction of AXIAL_DIRECTIONS) {
      const candidateIndex = hexIndexAt(fromTile.q + direction.q, fromTile.r + direction.r, radius);
      if (candidateIndex < 0) continue;
      const candidateDistance = hexDistance(grid[candidateIndex], targetTile);
      if (candidateDistance >= bestDistance) continue;
      bestDistance = candidateDistance;
      bestIndex = candidateIndex;
    }
    current = bestIndex;
  }
  return current;
}

function marchStepsAlongTerrain(state: MatchState, fromIndex: number, toIndex: number, travelBudget: number): number {
  if (fromIndex === toIndex || !isPassable(state.terrain[toIndex] ?? 'plain')) return fromIndex;
  const grid = state.hexes;
  const costByIndex = new Array<number>(grid.length).fill(Number.POSITIVE_INFINITY);
  const previousByIndex = new Array<number>(grid.length).fill(-1);
  const settled = new Array<boolean>(grid.length).fill(false);
  costByIndex[fromIndex] = 0;
  for (let round = 0; round < grid.length; round += 1) {
    let current = -1;
    for (let index = 0; index < grid.length; index += 1) {
      if (settled[index] || costByIndex[index] === Number.POSITIVE_INFINITY) continue;
      if (current === -1 || costByIndex[index] < costByIndex[current]) current = index;
    }
    if (current === -1 || current === toIndex) break;
    settled[current] = true;
    for (const direction of AXIAL_DIRECTIONS) {
      const neighbor = hexIndexAt(grid[current].q + direction.q, grid[current].r + direction.r, state.spec.mapRadius);
      if (neighbor < 0 || settled[neighbor] || !isPassable(state.terrain[neighbor])) continue;
      const candidateCost = costByIndex[current] + marchCostOf(state.terrain[neighbor]);
      if (candidateCost >= costByIndex[neighbor]) continue;
      costByIndex[neighbor] = candidateCost;
      previousByIndex[neighbor] = current;
    }
  }
  if (previousByIndex[toIndex] === -1) return fromIndex;
  const path: number[] = [];
  for (let cursor = toIndex; cursor !== fromIndex; cursor = previousByIndex[cursor]) path.unshift(cursor);
  let position = fromIndex;
  let remainingBudget = travelBudget;
  for (const nextIndex of path) {
    const stepCost = marchCostOf(state.terrain[nextIndex]);
    if (stepCost > remainingBudget) break;
    remainingBudget -= stepCost;
    position = nextIndex;
  }
  return position;
}

function hasTerrain(state: MatchState): boolean {
  return state.terrain.some((kind) => kind !== 'plain');
}

function marchStep(state: MatchState, fromIndex: number, toIndex: number): number {
  if (!hasTerrain(state)) return stepTowardHex(state.spec.mapRadius, fromIndex, toIndex, WARGAMES_TRAVEL_HEXES_PER_TICK);
  return marchStepsAlongTerrain(state, fromIndex, toIndex, WARGAMES_TRAVEL_HEXES_PER_TICK);
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
    isBeacon: village.isBeacon,
    guests: village.guests.map((guest) => ({ ...guest, troops: { ...guest.troops } })),
  };
}

function cloneState(state: MatchState): MatchState {
  const reportsBySeat = {} as Record<SeatId, SignedReport[]>;
  const scoutedHexesBySeat = {} as Record<SeatId, number[]>;
  for (const seatId of matchSeatIds(state)) {
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
    for (const seatId of matchSeatIds(state)) copied[seatId] = [...(seatOrders[seatId] ?? [])];
    ordersByTick[Number(tickKey)] = copied;
  }
  return {
    ...state,
    villages: state.villages.map(cloneVillage),
    seats: state.seats.map((seat) => ({ ...seat, sealedOrders: [...seat.sealedOrders] })),
    readySeatIds: [...state.readySeatIds],
    armies,
    contracts,
    messages: [...state.messages],
    reportsBySeat,
    reportsById: new Map(state.reportsById),
    ledger: [...state.ledger],
    scoutedHexesBySeat,
    ordersByTick,
    verifications: [...state.verifications],
    goalStreak: { ...state.goalStreak },
    victoryPointsBySeat: { ...state.victoryPointsBySeat },
  };
}

function cornerHomeClusters(radius: number): HexCoord[][] {
  return AXIAL_DIRECTIONS.map((primaryAxis, directionIndex) => {
    const nextAxis = AXIAL_DIRECTIONS[(directionIndex + 1) % AXIAL_DIRECTIONS.length];
    return [
      { q: primaryAxis.q * radius, r: primaryAxis.r * radius },
      { q: primaryAxis.q * (radius - 1), r: primaryAxis.r * (radius - 1) },
      { q: primaryAxis.q * (radius - 1) + nextAxis.q, r: primaryAxis.r * (radius - 1) + nextAxis.r },
    ];
  });
}

function sixSeatHomeHexCoords(radius: number): HexCoord[][] {
  if (radius !== WARGAMES_HEX_RADIUS) return cornerHomeClusters(radius);
  return [
    [{ q: 2, r: 0 }, { q: 2, r: -1 }, { q: 3, r: -1 }],
    [{ q: 0, r: -2 }, { q: 1, r: -2 }, { q: 1, r: -3 }],
    [{ q: -2, r: 0 }, { q: -1, r: -1 }, { q: -2, r: -1 }],
    [{ q: -2, r: 2 }, { q: -2, r: 1 }, { q: -3, r: 1 }],
    [{ q: 0, r: 2 }, { q: -1, r: 2 }, { q: -1, r: 3 }],
    [{ q: 1, r: 2 }, { q: 1, r: 1 }, { q: 2, r: 1 }],
  ];
}

const FOUR_SEAT_HOME_DIRECTIONS = [0, 1, 3, 4] as const;
const FOUR_SEAT_EMPTY_DIRECTIONS = [2, 5] as const;

function axialAt(directionIndex: number, steps: number): HexCoord {
  const axis = AXIAL_DIRECTIONS[directionIndex];
  return { q: axis.q * steps, r: axis.r * steps };
}

function stepFrom(coord: HexCoord, directionIndex: number): HexCoord {
  const axis = AXIAL_DIRECTIONS[directionIndex];
  return { q: coord.q + axis.q, r: coord.r + axis.r };
}

function fourSeatHomeHexCoords(radius: number): HexCoord[][] {
  return FOUR_SEAT_HOME_DIRECTIONS.map((directionIndex) => [
    axialAt(directionIndex, radius),
    axialAt(directionIndex, radius - 1),
    axialAt(directionIndex, radius - 2),
  ]);
}

function fourSeatOpenLandKeys(radius: number): Set<string> {
  const openCoords = FOUR_SEAT_EMPTY_DIRECTIONS.map((directionIndex) => axialAt(directionIndex, radius));
  for (const directionIndex of FOUR_SEAT_HOME_DIRECTIONS) {
    const isEmptyCornerNext = FOUR_SEAT_EMPTY_DIRECTIONS.some((emptyIndex) => emptyIndex === (directionIndex + 1) % AXIAL_DIRECTIONS.length);
    const ringStepTowardEmptyCorner = isEmptyCornerNext ? (directionIndex + 2) % AXIAL_DIRECTIONS.length : (directionIndex + 4) % AXIAL_DIRECTIONS.length;
    openCoords.push(stepFrom(axialAt(directionIndex, radius), ringStepTowardEmptyCorner));
  }
  return new Set(openCoords.map((coord) => `${coord.q},${coord.r}`));
}

function denseOpenLandKeys(radius: number): Set<string> {
  const keys = new Set<string>();
  if (radius === WARGAMES_HEX_RADIUS) {
    for (const axis of AXIAL_DIRECTIONS) {
      keys.add(`${axis.q * radius},${axis.r * radius}`);
    }
    return keys;
  }
  for (let directionIndex = 0; directionIndex < AXIAL_DIRECTIONS.length; directionIndex += 1) {
    const primaryAxis = AXIAL_DIRECTIONS[directionIndex];
    const nextAxis = AXIAL_DIRECTIONS[(directionIndex + 1) % AXIAL_DIRECTIONS.length];
    keys.add(`${primaryAxis.q + nextAxis.q * (radius - 1)},${primaryAxis.r + nextAxis.r * (radius - 1)}`);
  }
  return keys;
}

interface SeatLayout {
  homeHexCoords(radius: number): HexCoord[][];
  openLandKeys(radius: number): Set<string>;
}

const SEAT_LAYOUT_BY_COUNT: Readonly<Record<WargamesSeatCount, SeatLayout>> = Object.freeze({
  4: { homeHexCoords: fourSeatHomeHexCoords, openLandKeys: fourSeatOpenLandKeys },
  6: { homeHexCoords: sixSeatHomeHexCoords, openLandKeys: denseOpenLandKeys },
});

function seatLayoutFor(seatCount: number): SeatLayout {
  const declaredCount = WARGAMES_SEAT_COUNTS.find((allowedCount) => allowedCount === seatCount);
  if (declaredCount === undefined) throw new Error(`a match takes ${WARGAMES_SEAT_COUNTS.join(' or ')} seats, not ${seatCount}`);
  return SEAT_LAYOUT_BY_COUNT[declaredCount];
}

function barbarianHexCoords(radius: number, rulesVersion: WargamesMatchSpec['rulesVersion'], seatLayout: SeatLayout): HexCoord[] {
  if (isRulesAtLeast(rulesVersion, 'v5')) {
    const openKeys = seatLayout.openLandKeys(radius);
    return hexGridForRadius(radius)
      .filter((tile) => !openKeys.has(`${tile.q},${tile.r}`))
      .map((tile) => ({ q: tile.q, r: tile.r }));
  }
  if (radius === WARGAMES_HEX_RADIUS) {
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
  const coords: HexCoord[] = [{ q: 0, r: 0 }, ...AXIAL_DIRECTIONS];
  for (let ring = 2; ring <= radius - 2; ring += 1) {
    for (const axis of AXIAL_DIRECTIONS) {
      coords.push({ q: axis.q * ring, r: axis.r * ring });
    }
  }
  const outerFirstHalf = Math.floor(radius / 2);
  const outerSecondHalf = radius - outerFirstHalf;
  for (let directionIndex = 0; directionIndex < AXIAL_DIRECTIONS.length; directionIndex += 1) {
    const primaryAxis = AXIAL_DIRECTIONS[directionIndex];
    const nextAxis = AXIAL_DIRECTIONS[(directionIndex + 1) % AXIAL_DIRECTIONS.length];
    coords.push({
      q: primaryAxis.q * outerFirstHalf + nextAxis.q * outerSecondHalf,
      r: primaryAxis.r * outerFirstHalf + nextAxis.r * outerSecondHalf,
    });
  }
  if (radius >= 5) {
    const innerRing = radius - 2;
    const innerFirstHalf = Math.floor(innerRing / 2);
    const innerSecondHalf = innerRing - innerFirstHalf;
    for (let directionIndex = 0; directionIndex < AXIAL_DIRECTIONS.length; directionIndex += 1) {
      const primaryAxis = AXIAL_DIRECTIONS[directionIndex];
      const nextAxis = AXIAL_DIRECTIONS[(directionIndex + 1) % AXIAL_DIRECTIONS.length];
      coords.push({
        q: primaryAxis.q * innerFirstHalf + nextAxis.q * innerSecondHalf,
        r: primaryAxis.r * innerFirstHalf + nextAxis.r * innerSecondHalf,
      });
    }
  }
  return coords;
}

function terrainForSpec(spec: WargamesMatchSpec, balance: WargamesBalance): TerrainKind[] {
  const mapRadius = spec.mapRadius ?? WARGAMES_HEX_RADIUS;
  const tiles = hexGridForRadius(mapRadius);
  if (!isRulesAtLeast(spec.rulesVersion, 'v6')) return tiles.map(() => 'plain');
  const seatLayout = seatLayoutFor(spec.seats.length);
  const protectedKeys = new Set<string>(seatLayout.openLandKeys(mapRadius));
  for (const homeTile of seatLayout.homeHexCoords(mapRadius).flat()) {
    protectedKeys.add(tileKey(homeTile));
    for (const direction of AXIAL_DIRECTIONS) protectedKeys.add(tileKey({ q: homeTile.q + direction.q, r: homeTile.r + direction.r }));
  }
  const request = { tiles, radius: mapRadius, seatCount: spec.seats.length, seed: spec.seed, protectedKeys };
  if (balance.clusteredTerrain === null) return generateTerrain(request);
  const passableKeys = new Set<string>();
  for (const beaconKey of beaconKeysFor(spec, balance, seatLayout, tiles.map(() => 'plain'))) {
    const [q, r] = beaconKey.split(',').map(Number);
    protectedKeys.add(beaconKey);
    for (const direction of AXIAL_DIRECTIONS) passableKeys.add(tileKey({ q: q + direction.q, r: r + direction.r }));
  }
  return generateClusteredTerrain({ ...request, passableKeys, rule: balance.clusteredTerrain });
}

function sparseProtectedKeysFor(seatLayout: SeatLayout, mapRadius: number): Set<string> {
  const protectedKeys = new Set<string>(seatLayout.openLandKeys(mapRadius));
  for (const homeTile of seatLayout.homeHexCoords(mapRadius).flat()) protectedKeys.add(tileKey(homeTile));
  return protectedKeys;
}

function beaconKeysFor(spec: WargamesMatchSpec, balance: WargamesBalance, seatLayout: SeatLayout, kinds: readonly TerrainKind[]): Set<string> {
  const mapRadius = spec.mapRadius ?? WARGAMES_HEX_RADIUS;
  if (balance.sparseSites === null) return new Set();
  const tiles = hexGridForRadius(mapRadius);
  return pickBeaconKeys({
    tiles,
    seatCount: spec.seats.length,
    seed: spec.seed,
    protectedKeys: sparseProtectedKeysFor(seatLayout, mapRadius),
    kinds: balance.clusteredTerrain === null ? kinds : tiles.map(() => 'plain'),
    beaconRings: valueForRadius(balance.sparseSites.beaconRingsByRadius, mapRadius),
  });
}

interface MapSites {
  villageCoords: HexCoord[];
  beaconCoords: HexCoord[];
}

function sitesForSpec(spec: WargamesMatchSpec, balance: WargamesBalance, terrain: readonly TerrainKind[], seatLayout: SeatLayout): MapSites {
  const mapRadius = spec.mapRadius ?? WARGAMES_HEX_RADIUS;
  const sparseSites = balance.sparseSites;
  if (sparseSites === null) return { villageCoords: barbarianHexCoords(mapRadius, spec.rulesVersion, seatLayout), beaconCoords: [] };
  const beaconKeys = beaconKeysFor(spec, balance, seatLayout, terrain);
  const villageKeys = pickVillageKeys({
    tiles: hexGridForRadius(mapRadius),
    seatCount: spec.seats.length,
    seed: spec.seed,
    protectedKeys: sparseProtectedKeysFor(seatLayout, mapRadius),
    kinds: terrain,
    beaconKeys,
    villageShare: valueForRadius(sparseSites.villageShareByRadius, mapRadius),
    villageSpacing: sparseSites.villageSpacing,
  });
  const coordOf = (key: string): HexCoord => {
    const [q, r] = key.split(',').map(Number);
    return { q, r };
  };
  return { villageCoords: [...villageKeys].map(coordOf), beaconCoords: [...beaconKeys].map(coordOf) };
}

export function matchVillageCount(spec: WargamesMatchSpec): number {
  return villageCountOf(createInitialMatchState('village-count', 0, spec));
}

export function victoryVillagesFor(spec: WargamesMatchSpec): number {
  return victoryVillagesForBalance(wargamesBalanceFor(spec.rulesVersion), matchVillageCount(spec));
}

export function villageCountOf(state: Pick<MatchState, 'villages'>): number {
  return state.villages.filter((village) => village !== null && !village.isBeacon).length;
}

function victoryVillagesOf(state: Pick<MatchState, 'villages' | 'balance'>): number {
  return victoryVillagesForBalance(state.balance, villageCountOf(state));
}

export function terrainOf(spec: WargamesMatchSpec): readonly TerrainKind[] {
  return terrainForSpec(spec, wargamesBalanceFor(spec.rulesVersion));
}

export function createInitialMatchState(
  matchId: string,
  createdAtMs: number,
  spec: WargamesMatchSpec,
  balance: WargamesBalance = wargamesBalanceFor(spec.rulesVersion),
): MatchState {
  const mapRadius = spec.mapRadius ?? WARGAMES_HEX_RADIUS;
  const hexes = hexGridForRadius(mapRadius);
  const villages: (VillageState | null)[] = Array.from({ length: hexes.length }, () => null);
  const seatIds = WARGAMES_SEAT_IDS.slice(0, spec.seats.length);
  const seatLayout = seatLayoutFor(seatIds.length);
  const terrain = terrainForSpec(spec, balance);
  const homeCoords = seatLayout.homeHexCoords(mapRadius);
  for (let seatIdx = 0; seatIdx < seatIds.length; seatIdx += 1) {
    const seatId = seatIds[seatIdx];
    for (const coord of homeCoords[seatIdx]) {
      const hexIdx = hexIndexAt(coord.q, coord.r, mapRadius);
      if (hexIdx < 0) continue;
      villages[hexIdx] = {
        hexIndex: hexIdx,
        owner: seatId,
        productionState: 'producing',
        loyalty: INITIAL_LOYALTY,
        resources: { grain: STARTING_GRAIN, ore: STARTING_ORE },
        buildings: { farm: 1, mine: 1, barracks: 1, wall: 0 },
        troops: { raider: 6, guard: 6, envoy: 1 },
        isBeacon: false,
        guests: [],
      };
    }
  }
  const sites = sitesForSpec(spec, balance, terrain, seatLayout);
  for (const coord of sites.beaconCoords) {
    const hexIdx = hexIndexAt(coord.q, coord.r, mapRadius);
    if (hexIdx < 0 || villages[hexIdx] !== null) continue;
    villages[hexIdx] = {
      hexIndex: hexIdx,
      owner: null,
      productionState: 'producing',
      loyalty: INITIAL_LOYALTY,
      resources: { grain: 0, ore: 0 },
      buildings: { farm: 0, mine: 0, barracks: 0, wall: 0 },
      troops: { raider: 0, guard: BEACON_GUARDS, envoy: 0 },
      isBeacon: true,
      guests: [],
    };
  }
  for (const coord of sites.villageCoords) {
    const hexIdx = hexIndexAt(coord.q, coord.r, mapRadius);
    if (hexIdx < 0 || villages[hexIdx] !== null || !isPassable(terrain[hexIdx])) continue;
    villages[hexIdx] = {
      hexIndex: hexIdx,
      owner: null,
      productionState: 'producing',
      loyalty: INITIAL_LOYALTY,
      resources: { grain: BARBARIAN_GRAIN, ore: BARBARIAN_ORE },
      buildings: { farm: 1, mine: 1, barracks: 0, wall: 1 },
      troops: { raider: 3, guard: 4, envoy: 0 },
      isBeacon: false,
      guests: [],
    };
  }
  const orderedSeats = seatIds.map((seatId) => {
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
  for (const seatId of seatIds) {
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
    hexes: [...hexes],
    villages,
    seats: orderedSeats,
    readySeatIds: [],
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
    balance,
    goalStreak: { seatId: null, turns: 0 },
    terrain,
    victoryPointsBySeat: Object.fromEntries(seatIds.map((seatId) => [seatId, 0])) as Record<SeatId, number>,
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
  const owned = state.villages.filter((village): village is VillageState => village !== null && !village.isBeacon && village.owner === seatId);
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

export function warehouseCapOf(village: Pick<VillageState, 'buildings'>): number {
  return BASE_WAREHOUSE_CAP + (village.buildings.farm + village.buildings.mine) * WAREHOUSE_PER_LEVEL;
}

export function villageYieldOf(village: Pick<VillageState, 'buildings'>): ResourceBundle {
  return {
    grain: BASE_PRODUCTION_PER_TICK + village.buildings.farm * PRODUCTION_PER_LEVEL,
    ore: BASE_PRODUCTION_PER_TICK + village.buildings.mine * PRODUCTION_PER_LEVEL,
  };
}

function villagesOwnedBy(state: MatchState, seatId: SeatId): number {
  let count = 0;
  for (const village of state.villages) {
    if (village && !village.isBeacon && village.owner === seatId) count += 1;
  }
  return count;
}

function beaconsHeldBy(state: MatchState, seatId: SeatId): number {
  let count = 0;
  for (const village of state.villages) {
    if (village && village.isBeacon && village.owner === seatId && totalTroops(defendingTroopsOf(village)) > 0) count += 1;
  }
  return count;
}

function bonusTilesAround(state: MatchState, hexIndex: number, kind: TerrainKind): number {
  const center = state.hexes[hexIndex];
  let count = state.terrain[hexIndex] === kind ? 1 : 0;
  for (const direction of AXIAL_DIRECTIONS) {
    const neighborIndex = hexIndexAt(center.q + direction.q, center.r + direction.r, state.spec.mapRadius);
    if (neighborIndex >= 0 && state.terrain[neighborIndex] === kind) count += 1;
  }
  return count;
}

export function villageIncomeOf(state: MatchState, village: VillageState): ResourceBundle {
  if (village.isBeacon) return { grain: 0, ore: 0 };
  const gain = villageYieldOf(village);
  const productionMultiplier = isLastVillage(state, village) ? state.balance.lastVillageProductionMultiplier : 1;
  return {
    grain: gain.grain * productionMultiplier + bonusTilesAround(state, village.hexIndex, 'fertile') * BONUS_TILE_YIELD,
    ore: gain.ore * productionMultiplier + bonusTilesAround(state, village.hexIndex, 'ore') * BONUS_TILE_YIELD,
  };
}

function seatIncomeOf(state: MatchState, seatId: SeatId): number {
  let income = 0;
  for (const village of state.villages) {
    if (!village || village.owner !== seatId || village.productionState !== 'producing') continue;
    const villageIncome = villageIncomeOf(state, village);
    income += villageIncome.grain + villageIncome.ore;
  }
  return income;
}

function resolveCombatPower(attackers: TroopCounts, defenders: TroopCounts, wallLevel: number, defenseMultiplier: number): { attackPower: number; defensePower: number } {
  const raiderBonus = defenders.envoy > 0 ? 1.5 : 1;
  const envoyBonus = defenders.guard > 0 ? 1.5 : 1;
  const guardBonus = defenders.raider > 0 ? 1.5 : 1;
  const defRaiderBonus = attackers.envoy > 0 ? 1.5 : 1;
  const defEnvoyBonus = attackers.guard > 0 ? 1.5 : 1;
  const defGuardBonus = attackers.raider > 0 ? 1.5 : 1;
  const attackPower = attackers.raider * 10 * raiderBonus + attackers.guard * 10 * guardBonus + attackers.envoy * 8 * envoyBonus;
  const wallMultiplier = 1 + wallLevel * 0.15;
  const defensePower = (defenders.raider * 10 * defRaiderBonus + defenders.guard * 10 * defGuardBonus + defenders.envoy * 8 * defEnvoyBonus) * wallMultiplier * defenseMultiplier;
  return { attackPower, defensePower };
}

export function guestTroopsOwnedBy(village: Pick<VillageState, 'guests'>, seatId: SeatId): TroopCounts {
  return sumTroopCounts(village.guests.filter((guest) => guest.owner === seatId).map((guest) => guest.troops));
}

function defendingTroopsOf(village: VillageState): TroopCounts {
  return sumTroopCounts([village.troops, ...village.guests.map((guest) => guest.troops)]);
}

function applyDefenderCasualties(village: VillageState, lossFraction: number): TroopCounts {
  const hostOutcome = applyCasualties(village.troops, lossFraction);
  village.troops = hostOutcome.surviving;
  const guestOutcomes = village.guests.map((guest) => ({ guest, outcome: applyCasualties(guest.troops, lossFraction) }));
  village.guests = guestOutcomes
    .filter(({ outcome }) => totalTroops(outcome.surviving) > 0)
    .map(({ guest, outcome }) => ({ ...guest, troops: outcome.surviving }));
  return sumTroopCounts([hostOutcome.lost, ...guestOutcomes.map(({ outcome }) => outcome.lost)]);
}

function troopCapOf(roles: WargamesRolesRule, village: VillageState): number {
  return roles.troopCapBase + roles.troopCapPerFarmLevel * village.buildings.farm;
}

function troopsCountedAt(state: MatchState, village: VillageState): number {
  let counted = totalTroops(defendingTroopsOf(village));
  for (const army of state.armies.values()) {
    if (army.owner !== village.owner || army.originHexIndex !== village.hexIndex) continue;
    if (army.status === 'marching' || army.status === 'arrived' || army.status === 'returning') counted += totalTroops(army.troops);
  }
  return counted;
}

export function villageTroopLoadOf(state: MatchState, village: VillageState): { counted: number; cap: number } | null {
  const roles = state.balance.roles;
  if (roles === null || village.owner === null) return null;
  return { counted: troopsCountedAt(state, village), cap: troopCapOf(roles, village) };
}

function troopRoomAt(state: MatchState, village: VillageState): number {
  const roles = state.balance.roles;
  if (roles === null || village.owner === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, troopCapOf(roles, village) - troopsCountedAt(state, village));
}

function takeTroopsUpTo(troops: TroopCounts, room: number): TroopCounts {
  const guard = Math.min(troops.guard, room);
  const raider = Math.min(troops.raider, room - guard);
  const envoy = Math.min(troops.envoy, room - guard - raider);
  return { raider, guard, envoy };
}

function subtractTroops(from: TroopCounts, amount: TroopCounts): TroopCounts {
  return { raider: from.raider - amount.raider, guard: from.guard - amount.guard, envoy: from.envoy - amount.envoy };
}

function addTroopsInto(into: TroopCounts, amount: TroopCounts): void {
  into.raider += amount.raider;
  into.guard += amount.guard;
  into.envoy += amount.envoy;
}

function stationGuests(village: VillageState, army: ArmyState, troops: TroopCounts): void {
  const existing = village.guests.find((guest) => guest.owner === army.owner && guest.originHexIndex === army.originHexIndex);
  if (existing) {
    addTroopsInto(existing.troops, troops);
    return;
  }
  village.guests.push({ owner: army.owner, originHexIndex: army.originHexIndex, troops: { ...troops } });
}

function settleArmyAfterEntry(army: ArmyState, leftover: TroopCounts): void {
  army.troops = leftover;
  const returning = transitionArmy(army.status, 'army_return');
  if (!returning.ok) return;
  army.status = returning.state;
  if (totalTroops(leftover) > 0) return;
  const home = transitionArmy(army.status, 'army_reach_home');
  if (home.ok) army.status = home.state;
}

function sendGuestsHome(state: MatchState): void {
  for (const village of state.villages) {
    if (!village || village.guests.length === 0) continue;
    const staying: StationedGuest[] = [];
    for (const guest of village.guests) {
      if (village.owner !== null && hasActiveAlliance(state, guest.owner, village.owner)) {
        staying.push(guest);
        continue;
      }
      const armyId = `army-${state.nextArmyNumber}`;
      state.nextArmyNumber += 1;
      state.armies.set(armyId, {
        id: armyId,
        owner: guest.owner,
        status: 'returning',
        originHexIndex: guest.originHexIndex,
        currentHexIndex: village.hexIndex,
        targetHexIndex: village.hexIndex,
        troops: { ...guest.troops },
        departedTick: state.tick,
        intendedTargetOwner: null,
        scoutedBy: [],
      });
    }
    village.guests = staying;
  }
}

function rolesAttackOf(roles: WargamesRolesRule, troops: TroopCounts): number {
  return troops.raider * roles.units.raider.attack + troops.guard * roles.units.guard.attack + troops.envoy * roles.units.envoy.attack;
}

function rolesDefenseOf(roles: WargamesRolesRule, troops: TroopCounts): number {
  return troops.raider * roles.units.raider.defense + troops.guard * roles.units.guard.defense + troops.envoy * roles.units.envoy.defense;
}

function isCaptureWave(roles: WargamesRolesRule, army: ArmyState): boolean {
  return rolesAttackOf(roles, army.troops) === 0;
}

function moraleOf(state: MatchState, attacker: SeatId, defender: SeatId | null): number {
  const roles = state.balance.roles;
  if (roles === null || defender === null) return 1;
  const attackerPoints = state.victoryPointsBySeat[attacker] ?? 0;
  if (attackerPoints < roles.moraleMinAttackerPoints) return 1;
  const pointsRatio = (state.victoryPointsBySeat[defender] ?? 0) / attackerPoints;
  return Math.min(1, Math.max(roles.moraleFloor, Math.sqrt(pointsRatio)));
}

function seatAttackPowerOf(state: MatchState, armies: readonly ArmyState[], combinedTroops: TroopCounts, village: VillageState): number {
  const roles = state.balance.roles;
  if (roles === null) return resolveCombatPower(combinedTroops, village.troops, village.buildings.wall, defenseMultiplierOf(state, village)).attackPower;
  return armies.reduce((sum, army) => sum + rolesAttackOf(roles, army.troops) * moraleOf(state, army.owner, village.owner), 0);
}

function villageDefensePowerOf(state: MatchState, village: VillageState, allAttackers: TroopCounts): number {
  const roles = state.balance.roles;
  if (roles === null) return resolveCombatPower(allAttackers, village.troops, village.buildings.wall, defenseMultiplierOf(state, village)).defensePower;
  const troopDefense = rolesDefenseOf(roles, defendingTroopsOf(village));
  const wall = village.buildings.wall;
  return (troopDefense + wall * roles.wallDefensePerLevel) * (1 + wall * roles.wallBonusPerLevel) * defenseMultiplierOf(state, village);
}

function knockDownWall(village: VillageState, attackPower: number, defensePower: number): void {
  const wall = village.buildings.wall;
  if (wall === 0 || attackPower <= 0) return;
  const margin = 1 - defensePower / attackPower;
  village.buildings.wall = Math.max(0, wall - Math.max(1, Math.round(wall * margin)));
}

function drainedLoyaltyOf(state: MatchState, loyalty: number, envoys: number): number {
  const roles = state.balance.roles;
  if (roles === null) return Math.max(0, loyalty - envoys * state.balance.envoyLoyaltyDrain);
  let remaining = loyalty;
  const rollSpan = roles.captureDrainMax - roles.captureDrainMin + 1;
  for (let envoy = 0; envoy < envoys && remaining > 0; envoy += 1) {
    const { value, nextState } = nextMulberry32(state.rngState);
    state.rngState = nextState;
    remaining = Math.max(0, remaining - (roles.captureDrainMin + Math.floor(value * rollSpan)));
  }
  return remaining;
}

function casualtiesByArmy(
  state: MatchState,
  armies: readonly ArmyState[],
  combinedTroops: TroopCounts,
  lossFraction: number,
): { surviving: TroopCounts; lost: TroopCounts }[] {
  if (state.spec.rulesVersion === 'v2') return armies.map((army) => applyCasualties(army.troops, lossFraction));
  const roles = state.balance.roles;
  if (roles === null) return spreadSeatLossesAcrossArmies(armies, applyCasualties(combinedTroops, lossFraction).lost);
  const fighting = armies.filter((army) => !isCaptureWave(roles, army));
  const fightingTroops = sumTroopCounts(fighting.map((army) => army.troops));
  const fightingOutcomes = spreadSeatLossesAcrossArmies(fighting, applyCasualties(fightingTroops, lossFraction).lost);
  return armies.map((army) => {
    const fightingIndex = fighting.indexOf(army);
    if (fightingIndex >= 0) return fightingOutcomes[fightingIndex];
    if (lossFraction >= 1) return { surviving: emptyTroops(), lost: { ...army.troops } };
    return { surviving: { ...army.troops }, lost: emptyTroops() };
  });
}

function isLastVillage(state: MatchState, village: VillageState): boolean {
  return village.owner !== null && villagesOwnedBy(state, village.owner) === 1;
}

function defenseMultiplierOf(state: MatchState, village: VillageState): number {
  const forestMultiplier = state.terrain[village.hexIndex] === 'forest' ? FOREST_DEFENSE_MULTIPLIER : 1;
  return (isLastVillage(state, village) ? state.balance.lastVillageDefenseMultiplier : 1) * forestMultiplier;
}

function captureVillage(state: MatchState, village: VillageState, newOwner: SeatId): void {
  village.owner = newOwner;
  village.loyalty = state.balance.capturedLoyalty;
  const razeFraction = state.balance.captureRazeFraction;
  if (razeFraction <= 0) return;
  for (const building of BuildingKind.options) {
    village.buildings[building] -= Math.ceil(village.buildings[building] * razeFraction);
  }
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

function spreadSeatLossesAcrossArmies(
  armies: readonly ArmyState[],
  seatLost: TroopCounts,
): { surviving: TroopCounts; lost: TroopCounts }[] {
  const lossStillOwed = { ...seatLost };
  return armies.map((army) => {
    const lost = {
      raider: Math.min(army.troops.raider, lossStillOwed.raider),
      guard: Math.min(army.troops.guard, lossStillOwed.guard),
      envoy: Math.min(army.troops.envoy, lossStillOwed.envoy),
    };
    lossStillOwed.raider -= lost.raider;
    lossStillOwed.guard -= lost.guard;
    lossStillOwed.envoy -= lost.envoy;
    return {
      surviving: {
        raider: army.troops.raider - lost.raider,
        guard: army.troops.guard - lost.guard,
        envoy: army.troops.envoy - lost.envoy,
      },
      lost,
    };
  });
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
  state.readySeatIds = [];
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

function sumTroopCounts(troopLists: readonly TroopCounts[]): TroopCounts {
  let raider = 0;
  let guard = 0;
  let envoy = 0;
  for (const troops of troopLists) {
    raider += troops.raider;
    guard += troops.guard;
    envoy += troops.envoy;
  }
  return { raider, guard, envoy };
}

function finalizeArmyAfterCombat(army: ArmyState, surviving: TroopCounts): void {
  if (totalTroops(surviving) <= 0) {
    army.troops = emptyTroops();
    const destroyed = transitionArmy(army.status, 'army_destroy');
    if (destroyed.ok) army.status = destroyed.state;
    return;
  }
  army.troops = surviving;
  const returning = transitionArmy(army.status, 'army_return');
  if (returning.ok) army.status = returning.state;
}

function garrisonArmyInVillage(state: MatchState, army: ArmyState, village: VillageState, surviving: TroopCounts): void {
  if (totalTroops(surviving) <= 0) {
    finalizeArmyAfterCombat(army, surviving);
    return;
  }
  const accepted = takeTroopsUpTo(surviving, troopRoomAt(state, village));
  addTroopsInto(village.troops, accepted);
  settleArmyAfterEntry(army, subtractTroops(surviving, accepted));
}

function resolveV1MarchArrival(
  state: MatchState,
  army: ArmyState,
  effects: EngineEffect[],
  signatures: Readonly<Record<string, string>>,
  signer?: ReportSigner,
): void {
  const targetVillage = state.villages[army.targetHexIndex];
  if (!targetVillage) {
    const returning = transitionArmy(army.status, 'army_return');
    if (returning.ok) army.status = returning.state;
    return;
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
    return;
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
      return;
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
  const { attackPower, defensePower } = resolveCombatPower(army.troops, targetVillage.troops, targetVillage.buildings.wall, defenseMultiplierOf(state, targetVillage));
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
    const drained = Math.max(0, targetVillage.loyalty - attackerOutcome.surviving.envoy * state.balance.envoyLoyaltyDrain);
    targetVillage.loyalty = drained;
    if (drained === 0) {
      captureVillage(state, targetVillage, army.owner);
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
  finalizeArmyAfterCombat(army, attackerOutcome.surviving);
}

export function isPactTerms(terms: ContractRecord['terms']): terms is Extract<ContractRecord['terms'], { kind: 'nap' | 'alliance' }> {
  return terms.kind === 'nap' || terms.kind === 'alliance';
}

function isPairedWith(contract: ContractRecord, first: SeatId, second: SeatId): boolean {
  return (contract.proposer === first && contract.counterparty === second)
    || (contract.counterparty === first && contract.proposer === second);
}

function activePactsBetween(state: MatchState, first: SeatId, second: SeatId): ContractRecord[] {
  return [...state.contracts.values()].filter((contract) => contract.status === 'active' && isPactTerms(contract.terms) && isPairedWith(contract, first, second));
}

function hasOpenAlliance(state: MatchState, first: SeatId, second: SeatId): boolean {
  return [...state.contracts.values()].some((contract) => contract.terms.kind === 'alliance'
    && (contract.status === 'proposed' || contract.status === 'active')
    && isPairedWith(contract, first, second));
}

function hasActiveAlliance(state: MatchState, first: SeatId, second: SeatId): boolean {
  return activePactsBetween(state, first, second).some((contract) => contract.terms.kind === 'alliance');
}

function breachPacts(state: MatchState, pacts: readonly ContractRecord[], breacher: SeatId, victim: SeatId, effects: EngineEffect[]): void {
  for (const contract of pacts) {
    if (!isPactTerms(contract.terms)) continue;
    const breached = transitionContract(contract.status, 'contract_breach');
    if (!breached.ok) continue;
    contract.status = breached.state;
    contract.breachedBy = breacher;
    contract.breachedTick = state.tick;
    const breacherStake = pactStakeOf(contract, breacher);
    const victimStake = pactStakeOf(contract, victim);
    creditSeatResources(state, victim, { grain: victimStake.grain + breacherStake.grain, ore: victimStake.ore + breacherStake.ore });
    state.ledger.push({
      tick: state.tick,
      contractId: contract.id,
      breacher,
      victim,
      collateralTransferred: { ...breacherStake },
    });
    state.victoryPointsBySeat[victim] += allianceVpEarnedBy(state, contract);
    effects.push({ kind: 'contract_breached', detail: { contractId: contract.id, breacher, victim } });
  }
}

function allianceVpEarnedBy(state: MatchState, contract: ContractRecord): number {
  const diplomacy = state.balance.diplomacy;
  if (!diplomacy || contract.terms.kind !== 'alliance' || contract.activatedTick === null) return 0;
  return Math.max(0, state.tick - contract.activatedTick) * diplomacy.allianceVpPerTurn;
}

function settleAllianceVictoryPoints(state: MatchState): void {
  const diplomacy = state.balance.diplomacy;
  if (!diplomacy) return;
  for (const contract of state.contracts.values()) {
    if (contract.terms.kind !== 'alliance' || contract.status !== 'active') continue;
    state.victoryPointsBySeat[contract.proposer] += diplomacy.allianceVpPerTurn;
    state.victoryPointsBySeat[contract.counterparty] += diplomacy.allianceVpPerTurn;
  }
}

function pactStakeOf(contract: ContractRecord, seatId: SeatId): ResourceBundle {
  const stated = isPactTerms(contract.terms) ? contract.terms.collateral : { grain: 0, ore: 0 };
  if (!contract.lockedCollateral) return stated;
  return seatId === contract.proposer ? contract.lockedCollateral.proposer : contract.lockedCollateral.counterparty;
}

export function seatReputationOf(state: MatchState, seatId: SeatId): SeatReputation {
  return { seatId, kept: keptDealsOf(state, seatId), broken: brokenDealsOf(state, seatId) };
}

function brokenDealsOf(state: MatchState, seatId: SeatId): number {
  return state.ledger.filter((entry) => entry.breacher === seatId).length;
}

function keptDealsOf(state: MatchState, seatId: SeatId): number {
  return [...state.contracts.values()].filter((contract) => contract.status === 'fulfilled' && (contract.proposer === seatId || contract.counterparty === seatId)).length;
}

function requiredPactStake(state: MatchState, seatId: SeatId, stated: ResourceBundle): ResourceBundle {
  const diplomacy = state.balance.diplomacy;
  if (!diplomacy) return stated;
  const multiplier = 1 + brokenDealsOf(state, seatId) * diplomacy.breachCollateralStep;
  return { grain: Math.ceil(stated.grain * multiplier), ore: Math.ceil(stated.ore * multiplier) };
}

function hasResources(available: ResourceBundle, needed: ResourceBundle): boolean {
  return available.grain >= needed.grain && available.ore >= needed.ore;
}

function supportArmiesFor(state: MatchState, waitingSupport: ArmyState[], supportedSeat: SeatId): ArmyState[] {
  const joining = waitingSupport.filter((army) => army.supporting === supportedSeat && hasActiveAlliance(state, army.owner, supportedSeat));
  for (const army of joining) waitingSupport.splice(waitingSupport.indexOf(army), 1);
  return joining;
}

function returnArmyHome(army: ArmyState): void {
  const returning = transitionArmy(army.status, 'army_return');
  if (returning.ok) army.status = returning.state;
}

function resolveV2SimultaneousBattles(
  state: MatchState,
  hostileByHex: Map<number, ArmyState[]>,
  supportByHex: Map<number, ArmyState[]>,
  effects: EngineEffect[],
  signatures: Readonly<Record<string, string>>,
  signer?: ReportSigner,
): void {
  const orderedHexes = [...hostileByHex.keys()].sort((left, right) => left - right);
  for (const hexIndex of orderedHexes) {
    const targetVillage = state.villages[hexIndex];
    const incomingArmies = hostileByHex.get(hexIndex) ?? [];
    if (!targetVillage || incomingArmies.length === 0) continue;

    const previousOwner = targetVillage.owner;
    const armiesBySeat = new Map<SeatId, ArmyState[]>();
    for (const army of incomingArmies) {
      const seatArmies = armiesBySeat.get(army.owner);
      if (seatArmies) {
        seatArmies.push(army);
        continue;
      }
      armiesBySeat.set(army.owner, [army]);
    }

    const orderedAttackerSeats = [...armiesBySeat.keys()].sort((left, right) => seatIndexOf(left) - seatIndexOf(right));
    const activeAttackerSeats: { seatId: SeatId; armies: ArmyState[]; combinedTroops: TroopCounts; attackPower: number; morale: number }[] = [];
    for (const attackerSeat of orderedAttackerSeats) {
      const seatArmies = armiesBySeat.get(attackerSeat) ?? [];
      if (previousOwner !== null) {
        const activePacts = activePactsBetween(state, attackerSeat, previousOwner);
        const allUnintended = seatArmies.every((army) => army.intendedTargetOwner !== previousOwner);
        if (allUnintended && activePacts.length > 0) {
          for (const army of seatArmies) {
            const returning = transitionArmy(army.status, 'army_return');
            if (returning.ok) army.status = returning.state;
          }
          continue;
        }
        breachPacts(state, activePacts, attackerSeat, previousOwner, effects);
      }
      const supportingArmies = supportArmiesFor(state, supportByHex.get(hexIndex) ?? [], attackerSeat);
      for (const supportArmy of supportingArmies) {
        if (previousOwner !== null) breachPacts(state, activePactsBetween(state, supportArmy.owner, previousOwner), supportArmy.owner, previousOwner, effects);
        seatArmies.push(supportArmy);
      }
      const combinedTroops = sumTroopCounts(seatArmies.map((army) => army.troops));
      const attackPower = seatAttackPowerOf(state, seatArmies, combinedTroops, targetVillage);
      activeAttackerSeats.push({ seatId: attackerSeat, armies: seatArmies, combinedTroops, attackPower, morale: moraleOf(state, attackerSeat, previousOwner) });
    }
    if (activeAttackerSeats.length === 0) continue;

    const defenderBefore = defendingTroopsOf(targetVillage);
    const guestOwnersBefore = new Set(targetVillage.guests.map((guest) => guest.owner));
    const loyaltyBefore = targetVillage.loyalty;
    const allCombinedTroops = sumTroopCounts(activeAttackerSeats.map((entry) => entry.combinedTroops));
    const totalAttackPower = activeAttackerSeats.reduce((sum, entry) => sum + entry.attackPower, 0);
    const defensePower = villageDefensePowerOf(state, targetVillage, allCombinedTroops);
    const { value: rngRoll, nextState: nextRng } = nextMulberry32(state.rngState);
    state.rngState = nextRng;
    const jitteredTotalAttack = totalAttackPower * (0.9 + rngRoll * 0.2);
    const defenderFalls = jitteredTotalAttack >= defensePower;

    const defenderLossFraction = defenderFalls ? 1 : (jitteredTotalAttack / Math.max(1, defensePower)) * 0.65;
    const defenderLost = applyDefenderCasualties(targetVillage, defenderLossFraction);
    const wallBefore = targetVillage.buildings.wall;
    if (defenderFalls && state.balance.roles !== null) knockDownWall(targetVillage, jitteredTotalAttack, defensePower);

    type HexContestOutcome =
      | { kind: 'held' }
      | { kind: 'tie_bounce' }
      | { kind: 'won'; winnerSeatId: SeatId; runnerUpPower: number };
    let contestOutcome: HexContestOutcome = { kind: 'held' };
    if (defenderFalls) {
      const sortedByPower = [...activeAttackerSeats].sort((left, right) => right.attackPower - left.attackPower);
      const topPower = sortedByPower[0].attackPower;
      const topSeats = sortedByPower.filter((entry) => entry.attackPower === topPower);
      contestOutcome = topSeats.length === 1
        ? {
          kind: 'won',
          winnerSeatId: topSeats[0].seatId,
          runnerUpPower: sortedByPower.slice(1).reduce((sum, entry) => sum + entry.attackPower, 0),
        }
        : { kind: 'tie_bounce' };
    }

    const baseDefenderToll = defenderFalls ? (defensePower / Math.max(1, jitteredTotalAttack)) * 0.65 : 1;
    const resolvedAttackers = activeAttackerSeats.map((entry) => {
      let lossFraction = baseDefenderToll;
      if (contestOutcome.kind === 'tie_bounce') {
        lossFraction = Math.min(0.9, baseDefenderToll + 0.35);
      }
      if (contestOutcome.kind === 'won' && entry.seatId === contestOutcome.winnerSeatId && contestOutcome.runnerUpPower > 0) {
        lossFraction = Math.min(0.9, baseDefenderToll + (contestOutcome.runnerUpPower / Math.max(1, entry.attackPower)) * 0.45);
      }
      if (contestOutcome.kind === 'won' && entry.seatId !== contestOutcome.winnerSeatId) {
        lossFraction = 1;
      }

      const survivingByArmy = casualtiesByArmy(state, entry.armies, entry.combinedTroops, lossFraction);
      const totalSurviving = sumTroopCounts(survivingByArmy.map((outcome) => outcome.surviving));
      const totalLost = sumTroopCounts(survivingByArmy.map((outcome) => outcome.lost));
      const canDrainLoyalty = contestOutcome.kind === 'won' && entry.seatId === contestOutcome.winnerSeatId && totalSurviving.envoy > 0;
      const drainedLoyalty = canDrainLoyalty ? drainedLoyaltyOf(state, targetVillage.loyalty, totalSurviving.envoy) : targetVillage.loyalty;
      const captured = canDrainLoyalty && drainedLoyalty === 0;
      if (canDrainLoyalty) targetVillage.loyalty = drainedLoyalty;
      if (captured) {
        captureVillage(state, targetVillage, entry.seatId);
        effects.push({ kind: 'village_captured', detail: { hexIndex: targetVillage.hexIndex, newOwner: entry.seatId, previousOwner } });
      }
      return { entry, survivingByArmy, totalLost, captured };
    });

    const finalLoyaltyAfter = targetVillage.loyalty;
    for (const resolved of resolvedAttackers) {
      const reportId = `rep-${state.nextReportNumber}`;
      state.nextReportNumber += 1;
      const report = makeSignedReport(state, {
        kind: 'battle',
        reportId,
        tick: state.tick,
        hexIndex: targetVillage.hexIndex,
        attacker: resolved.entry.seatId,
        defender: previousOwner,
        attackerSent: resolved.entry.combinedTroops,
        attackerLost: resolved.totalLost,
        defenderBefore,
        defenderLost,
        loyaltyBefore,
        loyaltyAfter: finalLoyaltyAfter,
        captured: resolved.captured,
        ...(state.balance.roles === null ? {} : { wallBefore, wallAfter: targetVillage.buildings.wall }),
        ...(resolved.entry.morale < 1 ? { morale: Math.round(resolved.entry.morale * 100) / 100 } : {}),
      }, signatures, signer);
      state.reportsBySeat[resolved.entry.seatId].push(report);
      if (previousOwner !== null) state.reportsBySeat[previousOwner].push(report);
      const supporterSeats = new Set(resolved.entry.armies.map((army) => army.owner).filter((owner) => owner !== resolved.entry.seatId));
      for (const supporterSeat of supporterSeats) state.reportsBySeat[supporterSeat].push(report);
      for (const guestOwner of guestOwnersBefore) {
        if (guestOwner !== previousOwner && guestOwner !== resolved.entry.seatId && !supporterSeats.has(guestOwner)) state.reportsBySeat[guestOwner].push(report);
      }
      effects.push({ kind: 'report_signed', detail: { reportId, seatId: resolved.entry.seatId, signature: report.signature } });

      const shouldGarrisonCapturedVillage = isRulesAtLeast(state.spec.rulesVersion, 'v4') && resolved.captured;
      for (let index = 0; index < resolved.entry.armies.length; index += 1) {
        const army = resolved.entry.armies[index];
        const surviving = resolved.survivingByArmy[index].surviving;
        if (shouldGarrisonCapturedVillage && army.owner === resolved.entry.seatId) {
          garrisonArmyInVillage(state, army, targetVillage, surviving);
          continue;
        }
        finalizeArmyAfterCombat(army, surviving);
      }
    }
  }
  for (const waitingSupport of supportByHex.values()) {
    for (const army of waitingSupport) returnArmyHome(army);
  }
}

function resolveTick(
  state: MatchState,
  signatures: Readonly<Record<string, string>>,
  effects: EngineEffect[],
  signer?: ReportSigner,
): void {
  for (const seatId of matchSeatIds(state)) {
    state.scoutedHexesBySeat[seatId] = [];
  }

  if (!isRulesAtLeast(state.spec.rulesVersion, 'v4') && state.tick >= WARGAMES_SQUEEZE_TICK) {
    for (const village of state.villages) {
      if (!village || state.hexes[village.hexIndex].ring !== state.spec.mapRadius) continue;
      if (village.productionState !== 'producing') continue;
      const squeezed = transitionVillage(village.productionState, 'outer_ring_squeeze');
      if (squeezed.ok) village.productionState = squeezed.state;
    }
  }

  for (const village of state.villages) {
    if (!village || village.productionState !== 'producing') continue;
    if (village.isBeacon) continue;
    const cap = warehouseCapOf(village);
    const income = villageIncomeOf(state, village);
    if (village.resources.grain < cap) village.resources.grain = Math.min(cap, village.resources.grain + income.grain);
    if (village.resources.ore < cap) village.resources.ore = Math.min(cap, village.resources.ore + income.ore);
  }

  for (const village of state.villages) {
    if (!village) continue;
    if (village.owner !== null) {
      village.loyalty = Math.min(INITIAL_LOYALTY, village.loyalty + state.balance.loyaltyRegenPerTurn);
      continue;
    }
    if (village.troops.guard >= state.balance.barbarianGuardCap) continue;
    village.troops.guard = Math.min(state.balance.barbarianGuardCap, village.troops.guard + state.balance.barbarianGuardGrowthPerTurn);
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
        if (!village || village.isBeacon || village.owner !== seat.config.seatId || builtHexes.has(order.hexIndex)) continue;
        const cost = state.balance.buildingCosts[order.building];
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
        const count = Math.min(order.count, troopRoomAt(state, village));
        if (count <= 0) continue;
        const unitCost = troopCostsFor(state.balance)[order.troop];
        const totalGrain = unitCost.grain * count;
        const totalOre = unitCost.ore * count;
        if (village.resources.grain < totalGrain || village.resources.ore < totalOre) continue;
        village.resources.grain -= totalGrain;
        village.resources.ore -= totalOre;
        village.troops[order.troop] += count;
      }
    }
  }

  for (const seat of state.seats) {
    for (const order of seat.sealedOrders) {
      if (order.kind !== 'march') continue;
      const village = state.villages[order.fromHexIndex];
      if (!village || village.owner !== seat.config.seatId) continue;
      if (order.toHexIndex < 0 || order.toHexIndex >= state.hexes.length) continue;
      if (!isPassable(state.terrain[order.toHexIndex])) continue;
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
        ...supportFieldOf(state, seat.config.seatId, order.support),
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
        troops: defendingTroopsOf(target),
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

  if (state.spec.rulesVersion === 'v1') {
    for (const army of state.armies.values()) {
      if (army.status === 'marching') {
        army.currentHexIndex = marchStep(state, army.currentHexIndex, army.targetHexIndex);
        if (army.currentHexIndex !== army.targetHexIndex) continue;
        const arrived = transitionArmy(army.status, 'army_arrive');
        if (!arrived.ok) continue;
        army.status = arrived.state;
        resolveV1MarchArrival(state, army, effects, signatures, signer);
        continue;
      }
      if (army.status === 'returning') {
        army.currentHexIndex = marchStep(state, army.currentHexIndex, army.originHexIndex);
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
  }
  if (state.spec.rulesVersion !== 'v1') {
    const returningBeforeCombat = new Set<string>();
    for (const army of state.armies.values()) {
      if (army.status === 'returning') returningBeforeCombat.add(army.id);
    }
    const hostileByHex = new Map<number, ArmyState[]>();
    const supportByHex = new Map<number, ArmyState[]>();
    for (const army of state.armies.values()) {
      if (army.status !== 'marching') continue;
      army.currentHexIndex = marchStep(state, army.currentHexIndex, army.targetHexIndex);
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
      const isAlliedGarrison = army.supporting !== undefined && targetVillage.owner === army.supporting && hasActiveAlliance(state, army.owner, army.supporting);
      if (targetVillage.owner === army.owner || isAlliedGarrison) {
        const accepted = takeTroopsUpTo(army.troops, troopRoomAt(state, targetVillage));
        if (isAlliedGarrison && state.balance.roles !== null && totalTroops(accepted) > 0) stationGuests(targetVillage, army, accepted);
        if (!isAlliedGarrison || state.balance.roles === null) addTroopsInto(targetVillage.troops, accepted);
        settleArmyAfterEntry(army, subtractTroops(army.troops, accepted));
        continue;
      }
      if (army.supporting !== undefined) {
        const waitingSupport = supportByHex.get(army.targetHexIndex);
        if (waitingSupport) {
          waitingSupport.push(army);
          continue;
        }
        supportByHex.set(army.targetHexIndex, [army]);
        continue;
      }
      const list = hostileByHex.get(army.targetHexIndex);
      if (list) {
        list.push(army);
        continue;
      }
      hostileByHex.set(army.targetHexIndex, [army]);
    }
    for (const armyId of returningBeforeCombat) {
      const army = state.armies.get(armyId);
      if (!army || army.status !== 'returning') continue;
      army.currentHexIndex = marchStep(state, army.currentHexIndex, army.originHexIndex);
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
    resolveV2SimultaneousBattles(state, hostileByHex, supportByHex, effects, signatures, signer);
  }

  for (const contract of state.contracts.values()) {
    if (contract.status === 'proposed' && contract.proposedTick < state.tick) {
      const expired = transitionContract(contract.status, 'contract_expire');
      if (expired.ok) contract.status = expired.state;
      continue;
    }
    if (contract.status === 'active' && isPactTerms(contract.terms) && contract.endTick !== null && state.tick >= contract.endTick) {
      const fulfilled = transitionContract(contract.status, 'contract_fulfill');
      if (!fulfilled.ok) continue;
      contract.status = fulfilled.state;
      creditSeatResources(state, contract.proposer, pactStakeOf(contract, contract.proposer));
      creditSeatResources(state, contract.counterparty, pactStakeOf(contract, contract.counterparty));
    }
  }

  sendGuestsHome(state);

  for (const seat of state.seats) {
    if (seat.status === 'eliminated') continue;
    if (villagesOwnedBy(state, seat.config.seatId) > 0) continue;
    const eliminated = transitionSeat(seat.status, 'seat_eliminated');
    if (eliminated.ok) seat.status = eliminated.state;
  }
}

function settleBeaconsAndVictoryPoints(state: MatchState): void {
  const victory = state.balance.victory;
  if (victory.kind !== 'points') return;
  for (const village of state.villages) {
    if (!village || !village.isBeacon || village.owner === null || totalTroops(defendingTroopsOf(village)) > 0) continue;
    village.owner = null;
    village.loyalty = INITIAL_LOYALTY;
  }
  for (const seat of state.seats) {
    if (seat.status === 'eliminated') continue;
    const seatId = seat.config.seatId;
    const economyPoints = victory.economyIncomePerPoint > 0 ? Math.floor(seatIncomeOf(state, seatId) / victory.economyIncomePerPoint) : 0;
    state.victoryPointsBySeat[seatId] += villagesOwnedBy(state, seatId) + beaconsHeldBy(state, seatId) * victory.beaconPoints + economyPoints;
  }
}

export function victoryPointTargetOf(state: Pick<MatchState, 'balance' | 'spec'>): number | null {
  return victoryPointTargetFor(state.balance, state.spec.mapRadius, state.spec.seats.length);
}

export interface SeatStanding {
  score: number;
  goal: number;
  isPoints: boolean;
}

export function seatStandingOf(state: MatchState, seatId: SeatId): SeatStanding {
  const pointTarget = victoryPointTargetOf(state);
  if (pointTarget !== null) return { score: state.victoryPointsBySeat[seatId] ?? 0, goal: pointTarget, isPoints: true };
  return { score: villagesOwnedBy(state, seatId), goal: victoryVillagesOf(state), isPoints: false };
}

function standingSeats(state: MatchState): SeatId[] {
  return state.seats.filter((seat) => seat.status !== 'eliminated').map((seat) => seat.config.seatId);
}

function bestSeatByPoints(state: MatchState, seatIds: readonly SeatId[]): SeatId {
  const ranked = seatIds.map((seatId) => ({
    seatId,
    points: state.victoryPointsBySeat[seatId],
    villages: villagesOwnedBy(state, seatId),
    income: seatIncomeOf(state, seatId),
  }));
  ranked.sort((left, right) => right.points - left.points || right.villages - left.villages || right.income - left.income);
  return ranked[0].seatId;
}

function pointsWinnerAfterTurn(state: MatchState, target: number): SeatId | null {
  const seatsAtTarget = standingSeats(state).filter((seatId) => state.victoryPointsBySeat[seatId] >= target);
  return seatsAtTarget.length > 0 ? bestSeatByPoints(state, seatsAtTarget) : null;
}

function goalWinnerAfterTurn(state: MatchState): SeatId | null {
  const pointTarget = victoryPointTargetOf(state);
  if (pointTarget !== null) return pointsWinnerAfterTurn(state, pointTarget);
  const winVillages = victoryVillagesOf(state);
  const seatsAtGoal = matchSeatIds(state).filter((seatId) => villagesOwnedBy(state, seatId) >= winVillages);
  const holdTurns = state.balance.victory.kind === 'heldShare' ? state.balance.victory.holdTurns : 1;
  if (holdTurns <= 1) return seatsAtGoal.length > 0 ? determineWinnerAtLimit(state) : null;
  if (seatsAtGoal.length !== 1) {
    state.goalStreak = { seatId: null, turns: 0 };
    return null;
  }
  const holder = seatsAtGoal[0];
  const turns = holder === state.goalStreak.seatId ? state.goalStreak.turns + 1 : 1;
  state.goalStreak = { seatId: holder, turns };
  return turns >= holdTurns ? holder : null;
}

function determineWinnerAtLimit(state: MatchState): SeatId {
  if (state.balance.victory.kind === 'points') {
    const standing = standingSeats(state);
    return bestSeatByPoints(state, standing.length > 0 ? standing : matchSeatIds(state));
  }
  let bestSeat: SeatId = state.seats[0].config.seatId;
  let bestVillages = -1;
  let bestTroops = -1;
  let bestResources = -1;
  for (const seatId of matchSeatIds(state)) {
    const owned = villagesOwnedBy(state, seatId);
    let troops = 0;
    let resources = 0;
    for (const village of state.villages) {
      if (!village) continue;
      troops += totalTroops(guestTroopsOwnedBy(village, seatId));
      if (village.owner !== seatId) continue;
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

function supportFieldOf(state: MatchState, owner: SeatId, support: SeatId | undefined): { supporting?: SeatId } {
  if (support === undefined || support === owner || !isRulesAtLeast(state.spec.rulesVersion, 'v7')) return {};
  return { supporting: support };
}

function pactKindRejectionFor(state: MatchState, kind: ContractRecord['terms']['kind']): TransitionOutcome | null {
  const hasAlliances = isRulesAtLeast(state.spec.rulesVersion, 'v7');
  if (kind === 'alliance' && !hasAlliances) return reject('invalid_order', 'alliance contracts open in rules v7');
  if (kind === 'nap' && hasAlliances) return reject('invalid_order', 'rules v7 replace the NAP with the alliance contract');
  return null;
}

function seatsNamedAsTargets(event: WargamesEvent): SeatId[] {
  if (event.type === 'message_sent') return event.to === null ? [] : [event.to];
  if (event.type === 'contract_proposed') return [event.terms.counterparty];
  if (event.type === 'orders_submitted') {
    return event.orders.flatMap((order) => {
      if (order.kind === 'tribe_join') return [order.partner];
      if (order.kind === 'march' && order.support !== undefined) return [order.support];
      return [];
    });
  }
  return [];
}

function rejectSeatsOutsideMatch(state: MatchState, event: WargamesEvent): TransitionOutcome | null {
  if ('seatId' in event && !isSeatInMatch(state, event.seatId)) {
    return reject('unauthorized_seat', `seat ${event.seatId} is not in this match`);
  }
  const outsideTarget = seatsNamedAsTargets(event).find((seatId) => !isSeatInMatch(state, seatId));
  if (outsideTarget === undefined) return null;
  return reject('invalid_target', `seat ${outsideTarget} is not in this match`);
}

export function applyEvent(
  currentState: MatchState,
  event: WargamesEvent,
  signer?: ReportSigner,
): TransitionOutcome {
  if (event.type === 'match_created') {
    return reject('invalid_match_state', 'match_created initializes a match via createInitialMatchState only');
  }

  const outsideSeatRejection = rejectSeatsOutsideMatch(currentState, event);
  if (outsideSeatRejection) return outsideSeatRejection;

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
    if (!isRulesAtLeast(state.spec.rulesVersion, 'v4') && seat.messagesSentThisTick >= WARGAMES_MAX_MESSAGES_PER_TICK) {
      return reject('message_limit_exceeded', `at most ${WARGAMES_MAX_MESSAGES_PER_TICK} messages per tick`);
    }
    if (event.channel === 'dm' && (event.to === null || event.to === event.seatId)) {
      return reject('invalid_target', 'dm requires another seat as recipient');
    }
    if (event.channel === 'public' && !isRulesAtLeast(state.spec.rulesVersion, 'v7')) {
      return reject('invalid_target', 'the public channel opens in rules v7');
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
    const pactKindRejection = pactKindRejectionFor(state, event.terms.kind);
    if (pactKindRejection) return pactKindRejection;
    if (event.terms.kind === 'alliance' && hasOpenAlliance(state, event.seatId, event.terms.counterparty)) {
      return reject('invalid_contract_state', `an alliance between ${event.seatId} and ${event.terms.counterparty} is already proposed or active`);
    }
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
    const proposerStake = requiredPactStake(state, contract.proposer, contract.terms.collateral);
    const counterpartyStake = requiredPactStake(state, contract.counterparty, contract.terms.collateral);
    if (!hasResources(seatTotalResources(state, contract.proposer), proposerStake)) {
      return reject('insufficient_resources', 'proposer lacks pact collateral');
    }
    if (!hasResources(seatTotalResources(state, contract.counterparty), counterpartyStake)) {
      return reject('insufficient_resources', 'counterparty lacks pact collateral');
    }
    deductSeatResources(state, contract.proposer, proposerStake);
    deductSeatResources(state, contract.counterparty, counterpartyStake);
    if (state.balance.diplomacy) contract.lockedCollateral = { proposer: proposerStake, counterparty: counterpartyStake };
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

  if (event.type === 'seat_ready') {
    if (state.phase !== 'talk' && state.phase !== 'contracts') return reject('invalid_phase', `ready allowed only in talk or contracts, got ${state.phase}`);
    const seat = state.seats[seatIndexOf(event.seatId)];
    if (seat.status !== 'acting') return reject('invalid_seat_state', `seat ${event.seatId} is ${seat.status}`);
    if (!state.readySeatIds.includes(event.seatId)) state.readySeatIds.push(event.seatId);
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
      settleBeaconsAndVictoryPoints(state);
      settleAllianceVictoryPoints(state);
      const winSeat = goalWinnerAfterTurn(state);
      if (winSeat !== null) {
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
  const hostedHexIndices = state.villages
    .filter((village): village is VillageState => village !== null && village.guests.some((guest) => guest.owner === seatId))
    .map((village) => village.hexIndex);
  const fullIntelHexes = new Set<number>([...ownedHexIndices, ...scoutedSet, ...hostedHexIndices]);
  const nearbyHexIndices = new Set<number>();
  for (const ownedIdx of ownedHexIndices) {
    const ownedTile = state.hexes[ownedIdx];
    if (!ownedTile) continue;
    for (const tile of state.hexes) {
      if (fullIntelHexes.has(tile.index)) continue;
      if (state.villages[tile.index] === null) continue;
      if (hexDistance(ownedTile, tile) <= 2) nearbyHexIndices.add(tile.index);
    }
  }
  const visibleVillages = state.villages
    .filter((village): village is VillageState => village !== null && fullIntelHexes.has(village.hexIndex))
    .map((village) => cloneVillage(village) as VillageState);
  const nearbyHexOwners: NearbyHexOwner[] = [...nearbyHexIndices]
    .sort((left, right) => left - right)
    .map((hexIndex) => ({
      hexIndex,
      owner: state.villages[hexIndex]?.owner ?? null,
    }));
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
      ...(army.supporting === undefined ? {} : { supporting: army.supporting }),
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
    nearbyHexOwners,
    visibleArmies,
    contracts: visibleContracts,
    ledger: [...state.ledger],
    reputation: matchSeatIds(state).map((entrySeatId) => seatReputationOf(state, entrySeatId)),
    winnerSeatId: state.winnerSeatId,
    terrain: state.terrain.flatMap((kind, hexIndex) => (kind === 'plain' ? [] : [{ hexIndex, kind }])),
    sites: state.villages.flatMap((village) => (village === null ? [] : [{ hexIndex: village.hexIndex, isBeacon: village.isBeacon }])),
    victoryPointsBySeat: { ...state.victoryPointsBySeat },
    victoryPointTarget: victoryPointTargetOf(state),
  };
}
