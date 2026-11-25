import {
  BuildingKind,
  ImprovementKind,
  WARGAMES_HEX_RADIUS,
  WARGAMES_SEAT_COUNTS,
  WARGAMES_MAX_HEX_RADIUS,
  WARGAMES_MIN_HEX_RADIUS,
  WARGAMES_NOTE_MAX_BYTES,
  WARGAMES_SEAT_IDS,
  WARGAMES_TRAVEL_HEXES_PER_TICK,
  valueForRadius,
  foundCostFor,
  troopCostsFor,
  victoryPointTargetFor,
  WARGAMES_BALANCE,
} from '../contracts/wargames.ts';
import type {
  ArmyStatus,
  BuildingLevels,
  HexCoord,
  MatchStatus,
  MessageRecord,
  OrderItem,
  ResourceBundle,
  SeatConfig,
  SeatId,
  WargamesBalance,
  WargamesSeatCount,
  SeatStatus,
  TickPhase,
  TroopCounts,
  VillageProductionState,
  WargamesEvent,
  WargamesMatchSpec,
  WargamesRejection,
  WargamesReport,
  WargamesRolesRule,
  WargamesTerritoryRule,
} from '../contracts/wargames.ts';
import {
  transitionArmy,
  transitionMatch,
  transitionSeat,
  transitionTick,
} from './machines.ts';
import { FOREST_DEFENSE_MULTIPLIER, generateClusteredTerrain, isPassable, marchCostOf, pickBeaconKeys, pickVillageKeys, tileKey } from './terrain.ts';
import type { TerrainKind } from './terrain.ts';

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
}

interface TerritoryTile {
  owner: SeatId;
  improvement: ImprovementKind | null;
  level: number;
}

interface SeatRuntimeState {
  config: SeatConfig;
  status: SeatStatus;
  note: string;
  sealedOrders: OrderItem[];
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
  messages: MessageRecord[];
  reportsBySeat: Record<SeatId, WargamesReport[]>;
  reportsById: Map<string, WargamesReport>;
  ordersByTick: Record<number, Record<SeatId, OrderItem[]>>;
  nextArmyNumber: number;
  nextReportNumber: number;
  nextMessageNumber: number;
  lastSeq: number;
  balance: WargamesBalance;
  terrain: TerrainKind[];
  victoryPointsBySeat: Record<SeatId, number>;
  territory: Map<number, TerritoryTile>;
  villagesFoundedBySeat: Record<SeatId, number>;
}

interface EngineEffect {
  kind: 'village_captured' | 'match_finished';
  detail: Record<string, unknown>;
}

type TransitionOutcome =
  | { ok: true; state: MatchState; effects: EngineEffect[] }
  | { ok: false; rejection: WargamesRejection };

interface OwnArmyView {
  id: string;
  status: ArmyStatus;
  at: number;
  target: number;
  troops: TroopCounts;
}

interface ArmyNearYouView {
  id: string;
  at: number;
  target: number;
  troops: number;
  turnsToArrive: number | null;
}

interface OtherSeatView {
  seatId: SeatId;
  status: SeatStatus;
  victoryPoints: number;
  landHexes: number;
  borderDistance: number | null;
  lastMessageToTick: number | null;
  lastMessageFromTick: number | null;
  villages: { hexIndex: number; isBeacon: boolean; troops: number; wall: number; loyalty: number }[];
  armiesNearYou: ArmyNearYouView[];
}

interface SeatStateView {
  matchId: string;
  status: MatchStatus;
  tick: number;
  maxTicks: number;
  phase: TickPhase;
  yourSeatId: SeatId;
  yourStatus: SeatStatus;
  yourVictoryPoints: number;
  yourLand: LandSummaryView;
  yourVillages: VillageState[];
  yourArmies: OwnArmyView[];
  otherSeats: OtherSeatView[];
  unownedSites: { hexIndex: number; isBeacon: boolean; troops: number; wall: number }[];
  land: { bySeat: Partial<Record<SeatId, number[]>>; improvements: { hexIndex: number; kind: ImprovementKind; level: number }[] };
  terrain: { hexIndex: number; kind: TerrainKind }[];
  victoryPointTarget: number | null;
  winnerSeatId: SeatId | null;
  yourVillagesFounded: number;
}

interface ClaimableHexView {
  hexIndex: number;
  terrain: TerrainKind;
  suits: 'field' | 'quarry';
  incomePerLevel: number;
}

interface LandSummaryView {
  hexes: number;
  vpPerTick: number;
  claimable: ClaimableHexView[];
  examples: {
    claim: Extract<OrderItem, { kind: 'march' }> | null;
    improve: Extract<OrderItem, { kind: 'build' }> | null;
  };
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

type MarchTerrain = Pick<MatchState, 'hexes' | 'terrain' | 'spec'>;

function leastCostPathOf(state: MarchTerrain, fromIndex: number, toIndex: number): number[] {
  if (fromIndex === toIndex || !isPassable(state.terrain[toIndex] ?? 'plain')) return [];
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
  if (previousByIndex[toIndex] === -1) return [];
  const path: number[] = [];
  for (let cursor = toIndex; cursor !== fromIndex; cursor = previousByIndex[cursor]) path.unshift(cursor);
  return path;
}

function hasTerrain(state: Pick<MatchState, 'terrain'>): boolean {
  return state.terrain.some((kind) => kind !== 'plain');
}

function marchLegOf(state: MarchTerrain, fromIndex: number, toIndex: number): number[] {
  if (!hasTerrain(state)) {
    const leg: number[] = [];
    let position = fromIndex;
    for (let step = 0; step < WARGAMES_TRAVEL_HEXES_PER_TICK; step += 1) {
      const next = stepTowardHex(state.spec.mapRadius, position, toIndex, 1);
      if (next === position) break;
      leg.push(next);
      position = next;
    }
    return leg;
  }
  const leg: number[] = [];
  let remainingBudget = WARGAMES_TRAVEL_HEXES_PER_TICK;
  for (const nextIndex of leastCostPathOf(state, fromIndex, toIndex)) {
    const stepCost = marchCostOf(state.terrain[nextIndex]);
    if (stepCost > remainingBudget) break;
    remainingBudget -= stepCost;
    leg.push(nextIndex);
  }
  return leg;
}

function marchStep(state: MatchState, fromIndex: number, toIndex: number): number {
  return marchLegOf(state, fromIndex, toIndex).at(-1) ?? fromIndex;
}

interface MarchRoute {
  hexIndices: number[];
  turnEndHexIndices: number[];
  reachesTarget: boolean;
}

export function marchRouteOf(state: MarchTerrain, fromIndex: number, toIndex: number): MarchRoute {
  const route: MarchRoute = { hexIndices: [fromIndex], turnEndHexIndices: [], reachesTarget: fromIndex === toIndex };
  let position = fromIndex;
  while (position !== toIndex) {
    const leg = marchLegOf(state, position, toIndex);
    if (leg.length === 0) return route;
    route.hexIndices.push(...leg);
    position = leg[leg.length - 1];
    route.turnEndHexIndices.push(position);
  }
  route.reachesTarget = true;
  return route;
}

function nextMulberry32(rngState: number): { value: number; nextState: number } {
  const nextState = (rngState + 0x6d2b79f5) | 0;
  let mixed = Math.imul(nextState ^ (nextState >>> 15), 1 | nextState);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  const value = ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  return { value, nextState };
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
  };
}

function cloneState(state: MatchState): MatchState {
  const reportsBySeat = {} as Record<SeatId, WargamesReport[]>;
  for (const seatId of matchSeatIds(state)) {
    reportsBySeat[seatId] = [...state.reportsBySeat[seatId]];
  }
  const armies = new Map<string, ArmyState>();
  for (const [armyId, army] of state.armies) {
    armies.set(armyId, { ...army, troops: { ...army.troops } });
  }
  const territory = new Map<number, TerritoryTile>();
  for (const [hexIndex, tile] of state.territory) territory.set(hexIndex, { ...tile });
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
    messages: [...state.messages],
    reportsBySeat,
    reportsById: new Map(state.reportsById),
    ordersByTick,
    victoryPointsBySeat: { ...state.victoryPointsBySeat },
    territory,
    villagesFoundedBySeat: { ...state.villagesFoundedBySeat },
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

function terrainForSpec(spec: WargamesMatchSpec, balance: WargamesBalance): TerrainKind[] {
  const mapRadius = spec.mapRadius ?? WARGAMES_HEX_RADIUS;
  const tiles = hexGridForRadius(mapRadius);
  const seatLayout = seatLayoutFor(spec.seats.length);
  const protectedKeys = new Set<string>(seatLayout.openLandKeys(mapRadius));
  for (const homeTile of seatLayout.homeHexCoords(mapRadius).flat()) {
    protectedKeys.add(tileKey(homeTile));
    for (const direction of AXIAL_DIRECTIONS) protectedKeys.add(tileKey({ q: homeTile.q + direction.q, r: homeTile.r + direction.r }));
  }
  const request = { tiles, radius: mapRadius, seatCount: spec.seats.length, seed: spec.seed, protectedKeys };
  const passableKeys = new Set<string>();
  for (const beaconKey of beaconKeysFor(spec, balance, seatLayout)) {
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

function beaconKeysFor(spec: WargamesMatchSpec, balance: WargamesBalance, seatLayout: SeatLayout): Set<string> {
  const mapRadius = spec.mapRadius ?? WARGAMES_HEX_RADIUS;
  const tiles = hexGridForRadius(mapRadius);
  return pickBeaconKeys({
    tiles,
    seatCount: spec.seats.length,
    seed: spec.seed,
    protectedKeys: sparseProtectedKeysFor(seatLayout, mapRadius),
    kinds: tiles.map(() => 'plain'),
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
  const beaconKeys = beaconKeysFor(spec, balance, seatLayout);
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

export function terrainOf(spec: WargamesMatchSpec): readonly TerrainKind[] {
  return terrainForSpec(spec, WARGAMES_BALANCE);
}

export function createInitialMatchState(
  matchId: string,
  createdAtMs: number,
  spec: WargamesMatchSpec,
  balance: WargamesBalance = WARGAMES_BALANCE,
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
        buildings: { farm: 1, mine: 1, wall: 0 },
        troops: { raider: 6, guard: 6, envoy: 1 },
        isBeacon: false,
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
      buildings: { farm: 0, mine: 0, wall: 0 },
      troops: { raider: 0, guard: BEACON_GUARDS, envoy: 0 },
      isBeacon: true,
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
      buildings: { farm: 1, mine: 1, wall: 1 },
      troops: { raider: 3, guard: 4, envoy: 0 },
      isBeacon: false,
    };
  }
  const orderedSeats = seatIds.map((seatId) => {
    const config = spec.seats.find((entry) => entry.seatId === seatId) ?? spec.seats[0];
    return {
      config,
      status: 'disconnected' as SeatStatus,
      note: '',
      sealedOrders: [] as OrderItem[],
    };
  });
  const reportsBySeat = {} as Record<SeatId, WargamesReport[]>;
  for (const seatId of seatIds) {
    reportsBySeat[seatId] = [];
  }
  const state: MatchState = {
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
    messages: [],
    reportsBySeat,
    reportsById: new Map(),
    ordersByTick: {},
    nextArmyNumber: 1,
    nextReportNumber: 1,
    nextMessageNumber: 1,
    lastSeq: 0,
    balance,
    terrain,
    victoryPointsBySeat: Object.fromEntries(seatIds.map((seatId) => [seatId, 0])) as Record<SeatId, number>,
    territory: new Map(),
    villagesFoundedBySeat: Object.fromEntries(seatIds.map((seatId) => [seatId, 0])) as Record<SeatId, number>,
  };
  for (const village of villages) {
    if (village !== null) grantUnownedRing(state, village);
  }
  return state;
}

function reject(code: WargamesRejection['code'], message: string): TransitionOutcome {
  return { ok: false, rejection: { code, message } };
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

export function villageIncomeOf(state: MatchState, village: VillageState): ResourceBundle {
  if (village.isBeacon) return { grain: 0, ore: 0 };
  const gain = villageYieldOf(village);
  const improvementGain = improvementIncomeOf(state, village);
  return {
    grain: gain.grain + improvementGain.grain,
    ore: gain.ore + improvementGain.ore,
  };
}

function nearestOwnedVillageOf(state: MatchState, seatId: SeatId, hexIndex: number): VillageState | null {
  const origin = state.hexes[hexIndex];
  let nearest: VillageState | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const village of state.villages) {
    if (!village || village.isBeacon || village.owner !== seatId) continue;
    const distance = hexDistance(origin, state.hexes[village.hexIndex]);
    if (distance >= nearestDistance) continue;
    nearest = village;
    nearestDistance = distance;
  }
  return nearest;
}

const BONUS_TERRAIN_BY_IMPROVEMENT: Readonly<Partial<Record<ImprovementKind, TerrainKind>>> = Object.freeze({ field: 'fertile', quarry: 'ore' });

export function improvementYieldPerLevelOn(state: Pick<MatchState, 'terrain' | 'balance'>, hexIndex: number, kind: 'field' | 'quarry'): number {
  const rule = state.balance.territory;
  const tileBonus = state.terrain[hexIndex] === BONUS_TERRAIN_BY_IMPROVEMENT[kind] ? rule.tileBonusPerLevel : 0;
  return rule.improvements[kind].yieldPerLevel + tileBonus;
}

function yieldPerLevelOf(state: MatchState, hexIndex: number, kind: ImprovementKind, payerDistance: number): ResourceBundle {
  if (kind === 'field' && payerDistance === 1) return { grain: improvementYieldPerLevelOn(state, hexIndex, 'field'), ore: 0 };
  if (kind !== 'quarry') return { grain: 0, ore: 0 };
  return { grain: 0, ore: improvementYieldPerLevelOn(state, hexIndex, 'quarry') };
}

function improvementYieldOf(state: MatchState, hexIndex: number, tile: TerritoryTile, village: VillageState): ResourceBundle {
  if (tile.improvement === null) return { grain: 0, ore: 0 };
  const perLevel = yieldPerLevelOf(state, hexIndex, tile.improvement, hexDistance(state.hexes[hexIndex], state.hexes[village.hexIndex]));
  return { grain: tile.level * perLevel.grain, ore: tile.level * perLevel.ore };
}

function landPointsFor(rule: WargamesTerritoryRule, landHexes: number): number {
  return Math.floor(landHexes / rule.tilesPerPoint);
}

function improvementIncomeOf(state: MatchState, village: VillageState): ResourceBundle {
  const income = { grain: 0, ore: 0 };
  if (village.owner === null) return income;
  for (const [hexIndex, tile] of state.territory) {
    if (tile.owner !== village.owner || tile.level === 0) continue;
    if (nearestOwnedVillageOf(state, tile.owner, hexIndex) !== village) continue;
    const tileYield = improvementYieldOf(state, hexIndex, tile, village);
    income.grain += tileYield.grain;
    income.ore += tileYield.ore;
  }
  return income;
}

export function territoryCountOf(state: Pick<MatchState, 'territory'>, seatId: SeatId): number {
  let count = 0;
  for (const tile of state.territory.values()) {
    if (tile.owner === seatId) count += 1;
  }
  return count;
}

function territoryOwnerAt(state: MatchState, hexIndex: number): SeatId | null {
  return state.territory.get(hexIndex)?.owner ?? null;
}

function isLandOwnedBy(state: MatchState, seatId: SeatId, hexIndex: number): boolean {
  return state.villages[hexIndex]?.owner === seatId || territoryOwnerAt(state, hexIndex) === seatId;
}

function touchesLandOf(state: MatchState, seatId: SeatId, hexIndex: number): boolean {
  const center = state.hexes[hexIndex];
  return AXIAL_DIRECTIONS.some((direction) => {
    const neighborIndex = hexIndexAt(center.q + direction.q, center.r + direction.r, state.spec.mapRadius);
    return neighborIndex >= 0 && isLandOwnedBy(state, seatId, neighborIndex);
  });
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

function defendingTroopsOf(village: VillageState): TroopCounts {
  return { ...village.troops };
}

function applyDefenderCasualties(village: VillageState, lossFraction: number): TroopCounts {
  const outcome = applyCasualties(village.troops, lossFraction);
  village.troops = outcome.surviving;
  return outcome.lost;
}

function troopCapOf(roles: WargamesRolesRule, village: VillageState): number {
  return roles.troopCapBase + roles.troopCapPerFarmLevel * village.buildings.farm;
}

function troopsCountedAt(state: MatchState, village: VillageState): number {
  let counted = totalTroops(defendingTroopsOf(village));
  for (const army of state.armies.values()) {
    if (army.owner !== village.owner || army.originHexIndex !== village.hexIndex) continue;
    if (army.status === 'marching' || army.status === 'arrived' || army.status === 'standing' || army.status === 'returning') counted += totalTroops(army.troops);
  }
  return counted;
}

export function villageTroopLoadOf(state: MatchState, village: VillageState): { counted: number; cap: number } | null {
  const roles = state.balance.roles;
  if (village.owner === null) return null;
  return { counted: troopsCountedAt(state, village), cap: troopCapOf(roles, village) };
}

function troopRoomAt(state: MatchState, village: VillageState): number {
  const roles = state.balance.roles;
  if (village.owner === null) return Number.POSITIVE_INFINITY;
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

function settleArmyAfterEntry(army: ArmyState, leftover: TroopCounts): void {
  army.troops = leftover;
  const returning = transitionArmy(army.status, 'army_return');
  if (!returning.ok) return;
  army.status = returning.state;
  if (totalTroops(leftover) > 0) return;
  const home = transitionArmy(army.status, 'army_reach_home');
  if (home.ok) army.status = home.state;
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
  if (defender === null) return 1;
  const attackerPoints = state.victoryPointsBySeat[attacker] ?? 0;
  if (attackerPoints < roles.moraleMinAttackerPoints) return 1;
  const pointsRatio = (state.victoryPointsBySeat[defender] ?? 0) / attackerPoints;
  return Math.min(1, Math.max(roles.moraleFloor, Math.sqrt(pointsRatio)));
}

function seatAttackPowerOf(state: MatchState, armies: readonly ArmyState[], village: VillageState): number {
  const roles = state.balance.roles;
  return armies.reduce((sum, army) => sum + rolesAttackOf(roles, army.troops) * moraleOf(state, army.owner, village.owner), 0);
}

function villageDefensePowerOf(state: MatchState, village: VillageState): number {
  const roles = state.balance.roles;
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
  lossFraction: number,
): { surviving: TroopCounts; lost: TroopCounts }[] {
  const roles = state.balance.roles;
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

function defenseMultiplierOf(state: MatchState, village: VillageState): number {
  return state.terrain[village.hexIndex] === 'forest' ? FOREST_DEFENSE_MULTIPLIER : 1;
}

function openRingOf(state: MatchState, hexIndex: number): number[] {
  const center = state.hexes[hexIndex];
  return AXIAL_DIRECTIONS
    .map((direction) => hexIndexAt(center.q + direction.q, center.r + direction.r, state.spec.mapRadius))
    .filter((neighborIndex) => neighborIndex >= 0 && state.villages[neighborIndex] === null && isPassable(state.terrain[neighborIndex]));
}

function grantUnownedRing(state: MatchState, village: VillageState): void {
  const owner = village.owner;
  if (owner === null || village.isBeacon) return;
  for (const hexIndex of openRingOf(state, village.hexIndex)) {
    if (!state.territory.has(hexIndex)) state.territory.set(hexIndex, { owner, improvement: null, level: 0 });
  }
}

function captureVillage(state: MatchState, village: VillageState, newOwner: SeatId): void {
  village.owner = newOwner;
  village.loyalty = state.balance.capturedLoyalty;
  grantUnownedRing(state, village);
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

function recordReport(state: MatchState, report: WargamesReport): WargamesReport {
  state.reportsById.set(report.reportId, report);
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

function returnArmyHome(army: ArmyState): void {
  const returning = transitionArmy(army.status, 'army_return');
  if (returning.ok) army.status = returning.state;
}

function resolveVillageBattles(state: MatchState, hostileByHex: Map<number, ArmyState[]>, effects: EngineEffect[]): void {
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
      const combinedTroops = sumTroopCounts(seatArmies.map((army) => army.troops));
      const attackPower = seatAttackPowerOf(state, seatArmies, targetVillage);
      activeAttackerSeats.push({ seatId: attackerSeat, armies: seatArmies, combinedTroops, attackPower, morale: moraleOf(state, attackerSeat, previousOwner) });
    }
    const defenderBefore = defendingTroopsOf(targetVillage);
    const loyaltyBefore = targetVillage.loyalty;
    const totalAttackPower = activeAttackerSeats.reduce((sum, entry) => sum + entry.attackPower, 0);
    const defensePower = villageDefensePowerOf(state, targetVillage);
    const { value: rngRoll, nextState: nextRng } = nextMulberry32(state.rngState);
    state.rngState = nextRng;
    const roles = state.balance.roles;
    const jitteredTotalAttack = totalAttackPower * (1 - roles.attackVariance + rngRoll * 2 * roles.attackVariance);
    const isBeatenInBattle = jitteredTotalAttack >= defensePower;
    const defenderFalls = isBeatenInBattle || totalTroops(defenderBefore) === 0;

    const defenderLossFraction = defenderFalls ? 1 : (jitteredTotalAttack / Math.max(1, defensePower)) * roles.repelledAttackDefenderLoss;
    const defenderLost = applyDefenderCasualties(targetVillage, defenderLossFraction);
    const wallBefore = targetVillage.buildings.wall;
    if (isBeatenInBattle) knockDownWall(targetVillage, jitteredTotalAttack, defensePower);

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

    const baseDefenderToll = defenderFalls ? Math.min(roles.maxWinningAttackLoss, (defensePower / Math.max(1, jitteredTotalAttack)) * roles.winningAttackLoss) : 1;
    const resolvedAttackers = activeAttackerSeats.map((entry) => {
      let lossFraction = baseDefenderToll;
      if (contestOutcome.kind === 'tie_bounce') {
        lossFraction = Math.min(roles.maxWinningAttackLoss, baseDefenderToll + roles.tiedAttackExtraLoss);
      }
      if (contestOutcome.kind === 'won' && entry.seatId === contestOutcome.winnerSeatId && contestOutcome.runnerUpPower > 0) {
        lossFraction = Math.min(roles.maxWinningAttackLoss, baseDefenderToll + (contestOutcome.runnerUpPower / Math.max(1, entry.attackPower)) * roles.contestedAttackExtraLoss);
      }
      if (contestOutcome.kind === 'won' && entry.seatId !== contestOutcome.winnerSeatId) {
        lossFraction = 1;
      }

      const survivingByArmy = casualtiesByArmy(state, entry.armies, lossFraction);
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
      const report = recordReport(state, {
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
        wallBefore,
        wallAfter: targetVillage.buildings.wall,
        ...(resolved.entry.morale < 1 ? { morale: Math.round(resolved.entry.morale * 100) / 100 } : {}),
      });
      state.reportsBySeat[resolved.entry.seatId].push(report);
      if (previousOwner !== null) state.reportsBySeat[previousOwner].push(report);

      const shouldGarrisonCapturedVillage = resolved.captured;
      for (let index = 0; index < resolved.entry.armies.length; index += 1) {
        const army = resolved.entry.armies[index];
        const surviving = resolved.survivingByArmy[index].surviving;
        if (shouldGarrisonCapturedVillage) {
          garrisonArmyInVillage(state, army, targetVillage, surviving);
          continue;
        }
        finalizeArmyAfterCombat(army, surviving);
      }
    }
  }
}

function villageGarrisonOf(state: MatchState, seatId: SeatId, hexIndex: number): TroopCounts | null {
  const village = state.villages[hexIndex];
  return village && village.owner === seatId ? village.troops : null;
}

function isImprovementKind(kind: BuildingKind | ImprovementKind): kind is ImprovementKind {
  return ImprovementKind.safeParse(kind).success;
}

function payFromVillage(village: VillageState, cost: ResourceBundle): boolean {
  if (village.resources.grain < cost.grain || village.resources.ore < cost.ore) return false;
  village.resources.grain -= cost.grain;
  village.resources.ore -= cost.ore;
  return true;
}

function canImproveTile(rule: WargamesTerritoryRule, tile: TerritoryTile | undefined, seatId: SeatId, kind: ImprovementKind): tile is TerritoryTile {
  if (!tile || tile.owner !== seatId) return false;
  if (tile.improvement !== null && tile.improvement !== kind) return false;
  return tile.level < rule.improvements[kind].maxLevel;
}

function buildImprovement(state: MatchState, seatId: SeatId, hexIndex: number, kind: ImprovementKind): boolean {
  const rule = state.balance.territory;
  const tile = state.territory.get(hexIndex);
  if (state.villages[hexIndex] !== null || !canImproveTile(rule, tile, seatId, kind)) return false;
  const improvementRule = rule.improvements[kind];
  const payer = nearestOwnedVillageOf(state, seatId, hexIndex);
  if (payer === null || !payFromVillage(payer, improvementRule.cost)) return false;
  tile.improvement = kind;
  tile.level += 1;
  return true;
}

function isFarFromEveryVillage(state: MatchState, hexIndex: number, spacing: number): boolean {
  const site = state.hexes[hexIndex];
  return state.villages.every((village) => village === null || hexDistance(site, state.hexes[village.hexIndex]) >= spacing);
}

function standingArmiesAt(state: MatchState, hexIndex: number): ArmyState[] {
  return [...state.armies.values()].filter((army) => army.status === 'standing' && army.currentHexIndex === hexIndex);
}

function garrisonNewVillage(state: MatchState, village: VillageState, army: ArmyState): void {
  const accepted = takeTroopsUpTo(army.troops, troopRoomAt(state, village));
  addTroopsInto(village.troops, accepted);
  army.currentHexIndex = village.hexIndex;
  settleArmyAfterEntry(army, subtractTroops(army.troops, accepted));
}

function foundVillage(state: MatchState, seatId: SeatId, hexIndex: number): boolean {
  const rule = state.balance.territory;
  const tile = state.territory.get(hexIndex);
  if (!tile || tile.owner !== seatId || tile.improvement !== null) return false;
  if (standingArmiesAt(state, hexIndex).some((army) => army.owner !== seatId)) return false;
  if (!isFarFromEveryVillage(state, hexIndex, rule.foundSpacing)) return false;
  const villagesFounded = state.villagesFoundedBySeat[seatId] ?? 0;
  if (villagesFounded >= valueForRadius(rule.foundLimitByRadius, state.spec.mapRadius)) return false;
  const payer = nearestOwnedVillageOf(state, seatId, hexIndex);
  if (payer === null || payer.troops.envoy < rule.foundEnvoys || !payFromVillage(payer, foundCostFor(rule, villagesFounded))) return false;
  payer.troops.envoy -= rule.foundEnvoys;
  state.villagesFoundedBySeat[seatId] = villagesFounded + 1;
  state.territory.delete(hexIndex);
  const village: VillageState = {
    hexIndex,
    owner: seatId,
    productionState: 'producing',
    loyalty: state.balance.capturedLoyalty,
    resources: { grain: 0, ore: 0 },
    buildings: { farm: 0, mine: 0, wall: 0 },
    troops: emptyTroops(),
    isBeacon: false,
  };
  state.villages[hexIndex] = village;
  grantUnownedRing(state, village);
  for (const army of standingArmiesAt(state, hexIndex)) garrisonNewVillage(state, village, army);
  return true;
}

function redeployStandingTroops(state: MatchState, seatId: SeatId, order: Extract<OrderItem, { kind: 'march' }>): void {
  const standing = standingArmiesAt(state, order.fromHexIndex).filter((army) => army.owner === seatId);
  const available = sumTroopCounts(standing.map((army) => army.troops));
  if (available.raider < order.troops.raider || available.guard < order.troops.guard || available.envoy < order.troops.envoy) return;
  let remaining: TroopCounts = { ...order.troops };
  for (const army of standing) {
    const taken = { raider: Math.min(army.troops.raider, remaining.raider), guard: Math.min(army.troops.guard, remaining.guard), envoy: Math.min(army.troops.envoy, remaining.envoy) };
    if (totalTroops(taken) === 0) continue;
    remaining = subtractTroops(remaining, taken);
    const leftover = subtractTroops(army.troops, taken);
    const moving: ArmyState = totalTroops(leftover) === 0 ? army : { ...army, id: `army-${state.nextArmyNumber}`, troops: taken };
    if (moving !== army) {
      state.nextArmyNumber += 1;
      army.troops = leftover;
      state.armies.set(moving.id, moving);
    }
    const redeployed = transitionArmy(moving.status, 'army_redeploy');
    if (!redeployed.ok) continue;
    moving.status = redeployed.state;
    moving.targetHexIndex = order.toHexIndex;
    moving.departedTick = state.tick;
  }
}

function addArrivalTo(armiesByHex: Map<number, ArmyState[]>, army: ArmyState): void {
  const list = armiesByHex.get(army.targetHexIndex);
  if (list) {
    list.push(army);
    return;
  }
  armiesByHex.set(army.targetHexIndex, [army]);
}

function tileDefenseMultiplierOf(state: MatchState, rule: WargamesTerritoryRule, hexIndex: number, holder: SeatId): number {
  const forestMultiplier = state.terrain[hexIndex] === 'forest' ? FOREST_DEFENSE_MULTIPLIER : 1;
  const tile = state.territory.get(hexIndex);
  const outpostMultiplier = tile && tile.owner === holder && tile.improvement === 'outpost' ? 1 + rule.outpostDefenseBonus : 1;
  return forestMultiplier * outpostMultiplier;
}

interface TileBattle {
  hexIndex: number;
  holder: SeatId;
  defenders: ArmyState[];
  attackers: ArmyState[];
}

function fightOnTile(state: MatchState, rule: WargamesTerritoryRule, battle: TileBattle): void {
  const roles = state.balance.roles;
  const attackPowerBySeat = new Map<SeatId, number>();
  for (const army of battle.attackers) {
    attackPowerBySeat.set(army.owner, (attackPowerBySeat.get(army.owner) ?? 0) + rolesAttackOf(roles, army.troops) * moraleOf(state, army.owner, battle.holder));
  }
  const totalAttack = [...attackPowerBySeat.values()].reduce((sum, power) => sum + power, 0);
  const defenderBefore = sumTroopCounts(battle.defenders.map((army) => army.troops));
  const defensePower = rolesDefenseOf(roles, defenderBefore) * tileDefenseMultiplierOf(state, rule, battle.hexIndex, battle.holder);
  const { value: rngRoll, nextState } = nextMulberry32(state.rngState);
  state.rngState = nextState;
  const jitteredAttack = totalAttack * (1 - roles.attackVariance + rngRoll * 2 * roles.attackVariance);
  const defenderFalls = jitteredAttack >= defensePower;
  const defenderLossFraction = defenderFalls ? 1 : (jitteredAttack / Math.max(1, defensePower)) * roles.repelledAttackDefenderLoss;
  const attackerLossFraction = defenderFalls ? (defensePower / Math.max(1, jitteredAttack)) * roles.winningAttackLoss : 1;
  const strongestSeat = [...attackPowerBySeat.entries()].sort((left, right) => right[1] - left[1] || seatIndexOf(left[0]) - seatIndexOf(right[0]))[0][0];
  const defenderLost = emptyTroops();
  for (const army of battle.defenders) {
    const outcome = applyCasualties(army.troops, defenderLossFraction);
    addTroopsInto(defenderLost, outcome.lost);
    army.troops = outcome.surviving;
    if (totalTroops(outcome.surviving) > 0) continue;
    const destroyed = transitionArmy(army.status, 'army_destroy');
    if (destroyed.ok) army.status = destroyed.state;
  }
  for (const seatId of [...attackPowerBySeat.keys()].sort((left, right) => seatIndexOf(left) - seatIndexOf(right))) {
    const seatArmies = battle.attackers.filter((army) => army.owner === seatId);
    const attackerSent = sumTroopCounts(seatArmies.map((army) => army.troops));
    const attackerLost = emptyTroops();
    for (const army of seatArmies) {
      const outcome = applyCasualties(army.troops, attackerLossFraction);
      addTroopsInto(attackerLost, outcome.lost);
      if (defenderFalls && seatId === strongestSeat && totalTroops(outcome.surviving) > 0) {
        army.troops = outcome.surviving;
        continue;
      }
      finalizeArmyAfterCombat(army, outcome.surviving);
    }
    const reportId = `rep-${state.nextReportNumber}`;
    state.nextReportNumber += 1;
    const report = recordReport(state, {
      kind: 'battle', reportId, tick: state.tick, hexIndex: battle.hexIndex, attacker: seatId, defender: battle.holder,
      attackerSent, attackerLost, defenderBefore, defenderLost, loyaltyBefore: 0, loyaltyAfter: 0, captured: false,
    });
    state.reportsBySeat[seatId].push(report);
    state.reportsBySeat[battle.holder].push(report);
  }
}

function resolveTileArrivals(state: MatchState, rule: WargamesTerritoryRule, arrivalsByHex: Map<number, ArmyState[]>): void {
  for (const hexIndex of [...arrivalsByHex.keys()].sort((left, right) => left - right)) {
    const standing = standingArmiesAt(state, hexIndex);
    const holder = standing[0]?.owner ?? null;
    const arrivals = arrivalsByHex.get(hexIndex) ?? [];
    const hostileSeats = [...new Set(arrivals.map((army) => army.owner).filter((owner) => owner !== holder))];
    if (hostileSeats.length === 0) continue;
    if (holder === null) {
      if (hostileSeats.length > 1) for (const army of arrivals) returnArmyHome(army);
      continue;
    }
    const attackers = arrivals.filter((army) => army.owner !== holder);
    const defenders = [...standing, ...arrivals.filter((army) => army.owner === holder)];
    fightOnTile(state, rule, { hexIndex, holder, defenders, attackers });
  }
  for (const army of [...arrivalsByHex.values()].flat()) {
    const stood = transitionArmy(army.status, 'army_stand');
    if (stood.ok) army.status = stood.state;
  }
}

function reportLandChange(state: MatchState, hexIndex: number, claimer: SeatId, previousOwner: SeatId | null): void {
  const reportId = `rep-${state.nextReportNumber}`;
  state.nextReportNumber += 1;
  const report = recordReport(state, { kind: 'land', reportId, tick: state.tick, hexIndex, claimer, previousOwner });
  for (const seatId of previousOwner === null ? [claimer] : [claimer, previousOwner]) state.reportsBySeat[seatId].push(report);
}

function takeTile(state: MatchState, rule: WargamesTerritoryRule, hexIndex: number, seatId: SeatId): void {
  const tile = state.territory.get(hexIndex);
  reportLandChange(state, hexIndex, seatId, tile?.owner ?? null);
  if (!tile) {
    state.territory.set(hexIndex, { owner: seatId, improvement: null, level: 0 });
    return;
  }
  tile.owner = seatId;
  tile.level -= Math.ceil(tile.level * rule.captureLevelLoss);
  if (tile.level === 0) tile.improvement = null;
}

function settleStandingClaims(state: MatchState, rule: WargamesTerritoryRule, arrivedThisTurn: ReadonlySet<string>): void {
  const holdersByHex = new Map<number, ArmyState[]>();
  for (const army of state.armies.values()) {
    if (army.status !== 'standing' || state.villages[army.currentHexIndex] !== null) continue;
    holdersByHex.set(army.currentHexIndex, [...(holdersByHex.get(army.currentHexIndex) ?? []), army]);
  }
  const claims: { hexIndex: number; seatId: SeatId }[] = [];
  for (const hexIndex of [...holdersByHex.keys()].sort((left, right) => left - right)) {
    const armies = holdersByHex.get(hexIndex) ?? [];
    const seatId = armies[0]?.owner;
    if (seatId === undefined || armies.some((army) => army.owner !== seatId)) continue;
    if (armies.every((army) => arrivedThisTurn.has(army.id))) continue;
    const tile = state.territory.get(hexIndex);
    if (tile?.owner === seatId || !touchesLandOf(state, seatId, hexIndex)) continue;
    claims.push({ hexIndex, seatId });
  }
  const claimsLeftBySeat = new Map<SeatId, number>();
  for (const claim of claims) {
    const claimsLeft = claimsLeftBySeat.get(claim.seatId) ?? villagesOwnedBy(state, claim.seatId) * rule.claimsPerVillagePerTurn;
    if (claimsLeft <= 0) continue;
    claimsLeftBySeat.set(claim.seatId, claimsLeft - 1);
    takeTile(state, rule, claim.hexIndex, claim.seatId);
  }
}

function resolveTick(state: MatchState, effects: EngineEffect[]): void {


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
    const builtHexes = new Set<number>();
    for (const order of seat.sealedOrders) {
      if (order.kind === 'found') {
        if (builtHexes.has(order.hexIndex)) continue;
        if (foundVillage(state, seat.config.seatId, order.hexIndex)) builtHexes.add(order.hexIndex);
        continue;
      }
      if (order.kind === 'build') {
        const building = order.building;
        if (isImprovementKind(building)) {
          if (!builtHexes.has(order.hexIndex) && buildImprovement(state, seat.config.seatId, order.hexIndex, building)) builtHexes.add(order.hexIndex);
          continue;
        }
        const village = state.villages[order.hexIndex];
        if (!village || village.isBeacon || village.owner !== seat.config.seatId || builtHexes.has(order.hexIndex)) continue;
        const cost = state.balance.buildingCosts[building];
        if (village.resources.grain < cost.grain || village.resources.ore < cost.ore) continue;
        if (village.buildings[building] >= 10) continue;
        village.resources.grain -= cost.grain;
        village.resources.ore -= cost.ore;
        village.buildings[building] += 1;
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
      if (state.villages[order.fromHexIndex] === null) {
        if (order.toHexIndex >= 0 && order.toHexIndex < state.hexes.length && isPassable(state.terrain[order.toHexIndex])) redeployStandingTroops(state, seat.config.seatId, order);
        continue;
      }
      const garrison = villageGarrisonOf(state, seat.config.seatId, order.fromHexIndex);
      if (garrison === null) continue;
      if (order.toHexIndex < 0 || order.toHexIndex >= state.hexes.length) continue;
      if (!isPassable(state.terrain[order.toHexIndex])) continue;
      if (totalTroops(order.troops) <= 0) continue;
      if (garrison.raider < order.troops.raider || garrison.guard < order.troops.guard || garrison.envoy < order.troops.envoy) continue;
      garrison.raider -= order.troops.raider;
      garrison.guard -= order.troops.guard;
      garrison.envoy -= order.troops.envoy;
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
      });
    }
  }

  for (const seat of state.seats) {
    seat.sealedOrders = [];
  }
  state.ordersByTick[state.tick] = tickOrdersRecord;

  const returningBeforeCombat = new Set<string>();
  for (const army of state.armies.values()) {
    if (army.status === 'returning') returningBeforeCombat.add(army.id);
  }
  const hostileByHex = new Map<number, ArmyState[]>();
  const tileArrivalsByHex = new Map<number, ArmyState[]>();
  for (const army of state.armies.values()) {
    if (army.status !== 'marching') continue;
    army.currentHexIndex = marchStep(state, army.currentHexIndex, army.targetHexIndex);
    if (army.currentHexIndex !== army.targetHexIndex) continue;
    const arrived = transitionArmy(army.status, 'army_arrive');
    if (!arrived.ok) continue;
    army.status = arrived.state;
    const targetVillage = state.villages[army.targetHexIndex];
    if (!targetVillage) {
      addArrivalTo(tileArrivalsByHex, army);
      continue;
    }
    if (targetVillage.owner === army.owner) {
      const accepted = takeTroopsUpTo(army.troops, troopRoomAt(state, targetVillage));
      addTroopsInto(targetVillage.troops, accepted);
      settleArmyAfterEntry(army, subtractTroops(army.troops, accepted));
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
    const homeGarrison = villageGarrisonOf(state, army.owner, army.originHexIndex);
    if (homeGarrison !== null) addTroopsInto(homeGarrison, army.troops);
    army.troops = emptyTroops();
    const home = transitionArmy(army.status, 'army_reach_home');
    if (home.ok) army.status = home.state;
  }
  resolveVillageBattles(state, hostileByHex, effects);
  resolveTileArrivals(state, state.balance.territory, tileArrivalsByHex);
  settleStandingClaims(state, state.balance.territory, new Set([...tileArrivalsByHex.values()].flat().map((army) => army.id)));

  for (const seat of state.seats) {
    if (seat.status === 'eliminated') continue;
    if (villagesOwnedBy(state, seat.config.seatId) > 0) continue;
    const eliminated = transitionSeat(seat.status, 'seat_eliminated');
    if (eliminated.ok) seat.status = eliminated.state;
  }
}

function settleBeaconsAndVictoryPoints(state: MatchState): void {
  const victory = state.balance.victory;
  for (const village of state.villages) {
    if (!village || !village.isBeacon || village.owner === null || totalTroops(defendingTroopsOf(village)) > 0) continue;
    village.owner = null;
    village.loyalty = INITIAL_LOYALTY;
  }
  for (const seat of state.seats) {
    if (seat.status === 'eliminated') continue;
    const seatId = seat.config.seatId;
    const territoryPoints = landPointsFor(state.balance.territory, territoryCountOf(state, seatId));
    state.victoryPointsBySeat[seatId] += villagesOwnedBy(state, seatId) + beaconsHeldBy(state, seatId) * victory.beaconPoints + territoryPoints;
  }
}

export function victoryPointTargetOf(state: Pick<MatchState, 'balance' | 'spec'>): number | null {
  return victoryPointTargetFor(state.balance, state.spec.mapRadius, state.spec.seats.length);
}

interface SeatStanding {
  score: number;
  goal: number;
}

export function seatStandingOf(state: MatchState, seatId: SeatId): SeatStanding {
  return { score: state.victoryPointsBySeat[seatId] ?? 0, goal: victoryPointTargetOf(state) ?? 0 };
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

function goalWinnerAfterTurn(state: MatchState): SeatId | null {
  const target = victoryPointTargetOf(state);
  if (target === null) return null;
  const seatsAtTarget = standingSeats(state).filter((seatId) => state.victoryPointsBySeat[seatId] >= target);
  return seatsAtTarget.length > 0 ? bestSeatByPoints(state, seatsAtTarget) : null;
}

function determineWinnerAtLimit(state: MatchState): SeatId {
  const standing = standingSeats(state);
  return bestSeatByPoints(state, standing.length > 0 ? standing : matchSeatIds(state));
}

function seatsNamedAsTargets(event: WargamesEvent): SeatId[] {
  if (event.type === 'message_sent') return event.to === null ? [] : [event.to];
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
    if (state.status === 'running' && (state.phase === 'talk' || state.phase === 'orders')) {
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

  if (event.type === 'message_sent') {
    if (state.phase !== 'talk') return reject('invalid_phase', `send_message allowed only in talk phase, got ${state.phase}`);
    const seat = state.seats[seatIndexOf(event.seatId)];
    if (seat.status !== 'acting') return reject('invalid_seat_state', `seat ${event.seatId} is ${seat.status}`);
    if (event.channel === 'dm' && (event.to === null || event.to === event.seatId)) {
      return reject('invalid_target', 'dm requires another seat as recipient');
    }
    const id = `msg-${state.nextMessageNumber}`;
    state.nextMessageNumber += 1;
    state.messages.push({
      id,
      tick: state.tick,
      from: event.seatId,
      to: event.channel === 'dm' ? event.to : null,
      channel: event.channel,
      text: event.text,
    });
    state.lastSeq = event.seq;
    return { ok: true, state, effects };
  }

  if (event.type === 'seat_ready') {
    if (state.phase !== 'talk') return reject('invalid_phase', `ready allowed only in talk, got ${state.phase}`);
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
    if (state.phase === 'talk') {
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
      resolveTick(state, effects);
      const reported = transitionTick(state.phase, 'resolution_complete');
      if (!reported.ok) return reported;
      state.phase = reported.state;
      settleBeaconsAndVictoryPoints(state);
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

export function replayMatch(events: readonly WargamesEvent[]): MatchState {
  if (events.length === 0 || events[0].type !== 'match_created') {
    throw new Error('Wargames event log must start with match_created');
  }
  const first = events[0];
  let state = createInitialMatchState(first.matchId, first.createdAtMs, first.spec);
  for (let index = 1; index < events.length; index += 1) {
    const outcome = applyEvent(state, events[index]);
    if (!outcome.ok) {
      throw new Error(`Replay rejected event #${index} (${events[index].type}): ${outcome.rejection.message}`);
    }
    state = outcome.state;
  }
  return state;
}

export function replayMatchAtTick(events: readonly WargamesEvent[], targetTick: number): MatchState {
  if (events.length === 0 || events[0].type !== 'match_created') {
    throw new Error('Wargames event log must start with match_created');
  }
  const first = events[0];
  let state = createInitialMatchState(first.matchId, first.createdAtMs, first.spec);
  for (let index = 1; index < events.length; index += 1) {
    const outcome = applyEvent(state, events[index]);
    if (!outcome.ok) {
      throw new Error(`Replay rejected event #${index} (${events[index].type}): ${outcome.rejection.message}`);
    }
    if (outcome.state.tick > targetTick) break;
    state = outcome.state;
  }
  return state;
}

const NEAR_YOU_HEXES = 3;

function heldHexesOf(state: MatchState, seatId: SeatId): number[] {
  const villageHexes = state.villages.flatMap((village) => (village?.owner === seatId ? [village.hexIndex] : []));
  const landHexes = [...state.territory.entries()].flatMap(([hexIndex, tile]) => (tile.owner === seatId ? [hexIndex] : []));
  return [...villageHexes, ...landHexes];
}

function nearestDistance(state: MatchState, fromHexes: readonly number[], toHexes: readonly number[]): number | null {
  let nearest: number | null = null;
  for (const from of fromHexes) {
    for (const to of toHexes) {
      const distance = hexDistance(state.hexes[from], state.hexes[to]);
      if (nearest === null || distance < nearest) nearest = distance;
    }
  }
  return nearest;
}

function lastDirectMessageTick(state: MatchState, from: SeatId, to: SeatId): number | null {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message.channel === 'dm' && message.from === from && message.to === to) return message.tick;
  }
  return null;
}

function isFieldArmy(army: ArmyState): boolean {
  return army.status === 'marching' || army.status === 'standing' || army.status === 'returning';
}

function armiesNearOf(state: MatchState, owner: SeatId, yourHexes: ReadonlySet<number>): ArmyNearYouView[] {
  return [...state.armies.values()]
    .filter((army) => army.owner === owner && isFieldArmy(army))
    .filter((army) => (army.status === 'marching' && yourHexes.has(army.targetHexIndex))
      || (nearestDistance(state, [army.currentHexIndex], [...yourHexes]) ?? Number.POSITIVE_INFINITY) <= NEAR_YOU_HEXES)
    .map((army) => {
      const route = army.status === 'marching' ? marchRouteOf(state, army.currentHexIndex, army.targetHexIndex) : null;
      return {
        id: army.id,
        at: army.currentHexIndex,
        target: army.targetHexIndex,
        troops: totalTroops(army.troops),
        turnsToArrive: route?.reachesTarget ? route.turnEndHexIndices.length : null,
      };
    });
}

export function projectSeatState(state: MatchState, seatId: SeatId): SeatStateView {
  const seat = state.seats[seatIndexOf(seatId)];
  const yourHexes = heldHexesOf(state, seatId);
  const yourHexSet = new Set(yourHexes);
  const otherSeats: OtherSeatView[] = state.seats
    .filter((other) => other.config.seatId !== seatId)
    .map((other) => {
      const otherId = other.config.seatId;
      return {
        seatId: otherId,
        status: other.status,
        victoryPoints: state.victoryPointsBySeat[otherId] ?? 0,
        landHexes: territoryCountOf(state, otherId),
        borderDistance: nearestDistance(state, yourHexes, heldHexesOf(state, otherId)),
        lastMessageToTick: lastDirectMessageTick(state, seatId, otherId),
        lastMessageFromTick: lastDirectMessageTick(state, otherId, seatId),
        villages: state.villages.flatMap((village) => (village?.owner === otherId
          ? [{ hexIndex: village.hexIndex, isBeacon: village.isBeacon, troops: totalTroops(village.troops), wall: village.buildings.wall, loyalty: village.loyalty }]
          : [])),
        armiesNearYou: armiesNearOf(state, otherId, yourHexSet),
      };
    });
  const bySeat: Partial<Record<SeatId, number[]>> = {};
  for (const [hexIndex, tile] of [...state.territory.entries()].sort(([left], [right]) => left - right)) {
    bySeat[tile.owner] = [...(bySeat[tile.owner] ?? []), hexIndex];
  }
  return {
    matchId: state.matchId,
    status: state.status,
    tick: state.tick,
    maxTicks: state.spec.maxTicks,
    phase: state.phase,
    yourSeatId: seatId,
    yourStatus: seat.status,
    yourVictoryPoints: state.victoryPointsBySeat[seatId] ?? 0,
    yourLand: landSummaryOf(state, state.balance.territory, seatId),
    yourVillages: state.villages.filter((village): village is VillageState => village?.owner === seatId).map((village) => cloneVillage(village) as VillageState),
    yourArmies: [...state.armies.values()]
      .filter((army) => army.owner === seatId && isFieldArmy(army))
      .map((army) => ({ id: army.id, status: army.status, at: army.currentHexIndex, target: army.targetHexIndex, troops: { ...army.troops } })),
    otherSeats,
    unownedSites: state.villages.flatMap((village) => (village !== null && village.owner === null
      ? [{ hexIndex: village.hexIndex, isBeacon: village.isBeacon, troops: totalTroops(village.troops), wall: village.buildings.wall }]
      : [])),
    land: {
      bySeat,
      improvements: [...state.territory.entries()].flatMap(([hexIndex, tile]) => (tile.improvement === null ? [] : [{ hexIndex, kind: tile.improvement, level: tile.level }])),
    },
    terrain: state.terrain.flatMap((kind, hexIndex) => (kind === 'plain' ? [] : [{ hexIndex, kind }])),
    victoryPointTarget: victoryPointTargetOf(state),
    winnerSeatId: state.winnerSeatId,
    yourVillagesFounded: state.villagesFoundedBySeat[seatId] ?? 0,
  };
}

const MAX_CLAIMABLE_HEXES_SHOWN = 8;

function ownedVillagesOf(state: MatchState, seatId: SeatId): VillageState[] {
  return state.villages.filter((village): village is VillageState => village !== null && !village.isBeacon && village.owner === seatId);
}

function distanceToNearest(state: MatchState, hexIndex: number, villages: readonly VillageState[]): number {
  return Math.min(...villages.map((village) => hexDistance(state.hexes[hexIndex], state.hexes[village.hexIndex])));
}

function suitedImprovementAt(state: MatchState, hexIndex: number, villages: readonly VillageState[]): Omit<ClaimableHexView, 'hexIndex' | 'terrain'> {
  const payerDistance = distanceToNearest(state, hexIndex, villages);
  const fieldYield = yieldPerLevelOf(state, hexIndex, 'field', payerDistance);
  if (fieldYield.grain > 0) return { suits: 'field', incomePerLevel: fieldYield.grain };
  return { suits: 'quarry', incomePerLevel: yieldPerLevelOf(state, hexIndex, 'quarry', payerDistance).ore };
}

function claimableHexesOf(state: MatchState, seatId: SeatId, villages: readonly VillageState[]): ClaimableHexView[] {
  const busyHexes = new Set([...state.armies.values()]
    .filter((army) => army.status === 'standing' || (army.status === 'marching' && army.owner === seatId))
    .map((army) => (army.status === 'standing' ? army.currentHexIndex : army.targetHexIndex)));
  return state.hexes
    .filter((tile) => state.villages[tile.index] === null && isPassable(state.terrain[tile.index]) && !state.territory.has(tile.index) && !busyHexes.has(tile.index))
    .filter((tile) => touchesLandOf(state, seatId, tile.index))
    .map((tile) => ({ hexIndex: tile.index, terrain: state.terrain[tile.index], ...suitedImprovementAt(state, tile.index, villages) }))
    .sort((left, right) => right.incomePerLevel - left.incomePerLevel
      || distanceToNearest(state, left.hexIndex, villages) - distanceToNearest(state, right.hexIndex, villages)
      || left.hexIndex - right.hexIndex)
    .slice(0, MAX_CLAIMABLE_HEXES_SHOWN);
}

function claimExampleOf(state: MatchState, claimable: readonly ClaimableHexView[], villages: readonly VillageState[]): LandSummaryView['examples']['claim'] {
  const target = claimable[0];
  if (target === undefined) return null;
  const senders = villages
    .filter((village) => village.troops.raider + village.troops.guard > 0)
    .sort((left, right) => hexDistance(state.hexes[left.hexIndex], state.hexes[target.hexIndex]) - hexDistance(state.hexes[right.hexIndex], state.hexes[target.hexIndex]));
  const sender = senders[0];
  if (sender === undefined) return null;
  const troops = sender.troops.raider > 0 ? { raider: 1, guard: 0, envoy: 0 } : { raider: 0, guard: 1, envoy: 0 };
  return { kind: 'march', fromHexIndex: sender.hexIndex, toHexIndex: target.hexIndex, troops };
}

function improveExampleOf(state: MatchState, rule: WargamesTerritoryRule, seatId: SeatId, villages: readonly VillageState[]): LandSummaryView['examples']['improve'] {
  const candidates = [...state.territory.entries()]
    .map(([hexIndex, tile]) => ({ hexIndex, tile, suited: suitedImprovementAt(state, hexIndex, villages) }))
    .filter(({ tile, suited }) => canImproveTile(rule, tile, seatId, suited.suits))
    .sort((left, right) => left.tile.level - right.tile.level || right.suited.incomePerLevel - left.suited.incomePerLevel || left.hexIndex - right.hexIndex);
  const best = candidates[0];
  if (best === undefined) return null;
  return { kind: 'build', hexIndex: best.hexIndex, building: best.suited.suits };
}

function landSummaryOf(state: MatchState, rule: WargamesTerritoryRule, seatId: SeatId): LandSummaryView {
  const hexes = territoryCountOf(state, seatId);
  const villages = ownedVillagesOf(state, seatId);
  const claimable = villages.length === 0 ? [] : claimableHexesOf(state, seatId, villages);
  return {
    hexes,
    vpPerTick: landPointsFor(rule, hexes),
    claimable,
    examples: {
      claim: claimExampleOf(state, claimable, villages),
      improve: villages.length === 0 ? null : improveExampleOf(state, rule, seatId, villages),
    },
  };
}
