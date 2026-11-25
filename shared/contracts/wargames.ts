import { z } from 'zod';
import { AgentSetup } from './agent-models.ts';

export const WARGAMES_RULES_ID = 'r2' as const;
const WargamesRulesId = z.literal(WARGAMES_RULES_ID);

export const WARGAMES_SEAT_IDS = ['s1', 's2', 's3', 's4', 's5', 's6'] as const;
export const WARGAMES_SEAT_COUNTS = [4, 6] as const;
export type WargamesSeatCount = (typeof WARGAMES_SEAT_COUNTS)[number];
export const WARGAMES_HEX_RADIUS = 3;
export const WARGAMES_MIN_HEX_RADIUS = 3;
export const WARGAMES_MAX_HEX_RADIUS = 8;
const WARGAMES_MAX_HEX_COUNT = 3 * WARGAMES_MAX_HEX_RADIUS * (WARGAMES_MAX_HEX_RADIUS + 1) + 1;
const WARGAMES_MAX_TICKS = 40;
const WARGAMES_TICK_DEADLINE_SECONDS = 60;
export const WARGAMES_MAP_SIZES = [
  { name: 'Standard', mapRadius: 4, maxTicks: 25 },
  { name: 'Large', mapRadius: 6, maxTicks: 40 },
  { name: 'Huge', mapRadius: 8, maxTicks: 70 },
] as const;
export type WargamesMapSize = (typeof WARGAMES_MAP_SIZES)[number];
export const WARGAMES_NOTE_MAX_BYTES = 4096;
export const WARGAMES_TRAVEL_HEXES_PER_TICK = 2;

export const SeatId = z.enum(WARGAMES_SEAT_IDS);
export type SeatId = z.infer<typeof SeatId>;

export function seatIdsForCount(seatCount: WargamesSeatCount): SeatId[] {
  return WARGAMES_SEAT_IDS.slice(0, seatCount);
}

function isAllowedSeatCount(seatCount: number): seatCount is WargamesSeatCount {
  return WARGAMES_SEAT_COUNTS.some((allowedCount) => allowedCount === seatCount);
}

function hasExactSeatIds(seats: readonly { seatId: SeatId }[]): boolean {
  if (!isAllowedSeatCount(seats.length)) return false;
  const expectedSeatIds = new Set<SeatId>(seatIdsForCount(seats.length));
  const givenSeatIds = new Set(seats.map((seat) => seat.seatId));
  return givenSeatIds.size === expectedSeatIds.size && [...givenSeatIds].every((seatId) => expectedSeatIds.has(seatId));
}

export const MatchStatus = z.enum(['lobby', 'seating', 'running', 'finished', 'aborted']);
export type MatchStatus = z.infer<typeof MatchStatus>;

export const TickPhase = z.enum(['talk', 'orders', 'resolving', 'reported']);
export type TickPhase = z.infer<typeof TickPhase>;

export const SeatStatus = z.enum(['disconnected', 'connected', 'acting', 'submitted', 'timedOut', 'eliminated']);
export type SeatStatus = z.infer<typeof SeatStatus>;

export const VillageProductionState = z.enum(['producing', 'barren']);
export type VillageProductionState = z.infer<typeof VillageProductionState>;

export const ArmyStatus = z.enum(['mustering', 'marching', 'arrived', 'standing', 'returning', 'home', 'destroyed']);
export type ArmyStatus = z.infer<typeof ArmyStatus>;

export const BuildingKind = z.enum(['farm', 'mine', 'wall']);
export type BuildingKind = z.infer<typeof BuildingKind>;

export const ImprovementKind = z.enum(['field', 'quarry', 'watchtower', 'outpost']);
export type ImprovementKind = z.infer<typeof ImprovementKind>;

const TroopKind = z.enum(['raider', 'guard', 'envoy']);
type TroopKind = z.infer<typeof TroopKind>;

const SeatControllerKind = z.enum(['local-agent']);

export const WargamesMatchId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export type WargamesMatchId = z.infer<typeof WargamesMatchId>;

export const HexCoord = z.strictObject({
  q: z.number().int().min(-WARGAMES_MAX_HEX_RADIUS).max(WARGAMES_MAX_HEX_RADIUS),
  r: z.number().int().min(-WARGAMES_MAX_HEX_RADIUS).max(WARGAMES_MAX_HEX_RADIUS),
}).refine((coord) => Math.abs(coord.q + coord.r) <= WARGAMES_MAX_HEX_RADIUS, {
  error: 'hex coordinate outside radius',
});
export type HexCoord = z.infer<typeof HexCoord>;

export const ResourceBundle = z.strictObject({
  grain: z.number().int().min(0),
  ore: z.number().int().min(0),
});
export type ResourceBundle = z.infer<typeof ResourceBundle>;

export const TroopCounts = z.strictObject({
  raider: z.number().int().min(0),
  guard: z.number().int().min(0),
  envoy: z.number().int().min(0),
});
export type TroopCounts = z.infer<typeof TroopCounts>;

export const BuildingLevels = z.strictObject({
  farm: z.number().int().min(0).max(10),
  mine: z.number().int().min(0).max(10),
  wall: z.number().int().min(0).max(10),
});
export type BuildingLevels = z.infer<typeof BuildingLevels>;

export const SeatConfig = z.strictObject({
  seatId: SeatId,
  label: z.string().trim().min(1).max(60),
  controllerKind: SeatControllerKind.default('local-agent'),
  setup: AgentSetup,
  modelDisplay: z.string().trim().min(1).max(120),
});
export type SeatConfig = z.infer<typeof SeatConfig>;

export const WargamesMatchSpec = z.strictObject({
  version: z.literal(1),
  rules: WargamesRulesId.default(WARGAMES_RULES_ID),
  title: z.string().trim().min(1).max(120).default('Wargames Match'),
  seed: z.number().int().min(1).max(2147483647),
  mapRadius: z.number().int().min(WARGAMES_MIN_HEX_RADIUS).max(WARGAMES_MAX_HEX_RADIUS).default(WARGAMES_HEX_RADIUS),
  tickDeadlineSeconds: z.number().int().min(5).max(300).default(WARGAMES_TICK_DEADLINE_SECONDS),
  maxTicks: z.number().int().min(5).max(80).default(WARGAMES_MAX_TICKS),
  seats: z.array(SeatConfig),
}).refine((spec) => hasExactSeatIds(spec.seats), {
  error: 'a match takes 4 seats (s1 to s4) or 6 seats (s1 to s6)',
  path: ['seats'],
});
export type WargamesMatchSpec = z.infer<typeof WargamesMatchSpec>;

interface WargamesVictoryRule {
  readonly beaconPoints: number;
  readonly targetByRadius: Readonly<Record<number, Readonly<Record<WargamesSeatCount, number>>>>;
}

interface WargamesSparseSites {
  readonly villageShareByRadius: Readonly<Record<number, number>>;
  readonly villageSpacing: number;
  readonly beaconRingsByRadius: Readonly<Record<number, readonly number[]>>;
}

interface WargamesTerrainRule {
  readonly minBlockedShare: number;
  readonly maxBlockedShare: number;
  readonly lakeFeatureChance: number;
  readonly rangeLengths: readonly number[];
  readonly lakeSizes: readonly number[];
  readonly forestShare: number;
  readonly forestPatchSizes: readonly number[];
  readonly bonusChance: number;
}

interface WargamesImprovementRule {
  readonly cost: ResourceBundle;
  readonly maxLevel: number;
  readonly yieldPerLevel: number;
}

export interface WargamesTerritoryRule {
  readonly tilesPerPoint: number;
  readonly claimsPerVillagePerTurn: number;
  readonly improvements: Readonly<Record<ImprovementKind, WargamesImprovementRule>>;
  readonly tileBonusPerLevel: number;
  readonly watchtowerRange: number;
  readonly outpostDefenseBonus: number;
  readonly captureLevelLoss: number;
  readonly foundCost: ResourceBundle;
  readonly foundEnvoys: number;
  readonly foundSpacing: number;
  readonly foundLimitByRadius: Readonly<Record<number, number>>;
}

interface WargamesUnitRole {
  readonly attack: number;
  readonly defense: number;
  readonly cost: ResourceBundle;
}

export interface WargamesRolesRule {
  readonly units: Readonly<Record<TroopKind, WargamesUnitRole>>;
  readonly wallDefensePerLevel: number;
  readonly wallBonusPerLevel: number;
  readonly captureDrainMin: number;
  readonly captureDrainMax: number;
  readonly troopCapBase: number;
  readonly troopCapPerFarmLevel: number;
  readonly moraleFloor: number;
  readonly moraleMinAttackerPoints: number;
  readonly repelledAttackDefenderLoss: number;
  readonly winningAttackLoss: number;
  readonly maxWinningAttackLoss: number;
  readonly tiedAttackExtraLoss: number;
  readonly contestedAttackExtraLoss: number;
  readonly attackVariance: number;
}

export interface WargamesBalance {
  readonly capturedLoyalty: number;
  readonly loyaltyRegenPerTurn: number;
  readonly captureRazeFraction: number;
  readonly buildingCosts: Readonly<Record<BuildingKind, ResourceBundle>>;
  readonly barbarianGuardGrowthPerTurn: number;
  readonly barbarianGuardCap: number;
  readonly victory: WargamesVictoryRule;
  readonly sparseSites: WargamesSparseSites;
  readonly clusteredTerrain: WargamesTerrainRule;
  readonly roles: WargamesRolesRule;
  readonly territory: WargamesTerritoryRule;
}

export const WARGAMES_BALANCE: WargamesBalance = Object.freeze({
  capturedLoyalty: 25,
  loyaltyRegenPerTurn: 10,
  captureRazeFraction: 0.5,
  buildingCosts: Object.freeze({
    farm: Object.freeze({ grain: 40, ore: 30 }),
    mine: Object.freeze({ grain: 30, ore: 40 }),
    wall: Object.freeze({ grain: 30, ore: 60 }),
  }),
  barbarianGuardGrowthPerTurn: 1,
  barbarianGuardCap: 10,
  victory: Object.freeze({
    beaconPoints: 4,
    targetByRadius: Object.freeze({
      4: Object.freeze({ 4: 139, 6: 151 }),
      6: Object.freeze({ 4: 427, 6: 413 }),
      8: Object.freeze({ 4: 962, 6: 947 }),
    }),
  }),
  sparseSites: Object.freeze({
    villageShareByRadius: Object.freeze({ 4: 0.125, 6: 0.1, 8: 0.09 }),
    villageSpacing: 2,
    beaconRingsByRadius: Object.freeze({ 4: Object.freeze([0]), 6: Object.freeze([0, 3]), 8: Object.freeze([0, 4]) }),
  }),
  clusteredTerrain: Object.freeze({
    minBlockedShare: 0.08,
    maxBlockedShare: 0.12,
    lakeFeatureChance: 0.4,
    rangeLengths: Object.freeze([2, 3, 3, 4, 4, 5]),
    lakeSizes: Object.freeze([2, 3, 3, 4]),
    forestShare: 0.05,
    forestPatchSizes: Object.freeze([3, 4, 4, 5]),
    bonusChance: 0.05,
  }),
  roles: Object.freeze({
    units: Object.freeze({
      raider: Object.freeze({ attack: 12, defense: 3, cost: Object.freeze({ grain: 12, ore: 8 }) }),
      guard: Object.freeze({ attack: 3, defense: 12, cost: Object.freeze({ grain: 5, ore: 7 }) }),
      envoy: Object.freeze({ attack: 0, defense: 1, cost: Object.freeze({ grain: 25, ore: 20 }) }),
    }),
    wallDefensePerLevel: 15,
    wallBonusPerLevel: 0.04,
    captureDrainMin: 20,
    captureDrainMax: 35,
    troopCapBase: 40,
    troopCapPerFarmLevel: 20,
    moraleFloor: 0.5,
    moraleMinAttackerPoints: 20,
    repelledAttackDefenderLoss: 0.9,
    winningAttackLoss: 0.65,
    maxWinningAttackLoss: 0.9,
    tiedAttackExtraLoss: 0.35,
    contestedAttackExtraLoss: 0.45,
    attackVariance: 0.1,
  }),
  territory: Object.freeze({
    tilesPerPoint: 6,
    claimsPerVillagePerTurn: 1,
    improvements: Object.freeze({
      field: Object.freeze({ cost: Object.freeze({ grain: 30, ore: 30 }), maxLevel: 5, yieldPerLevel: 15 }),
      quarry: Object.freeze({ cost: Object.freeze({ grain: 30, ore: 30 }), maxLevel: 5, yieldPerLevel: 15 }),
      watchtower: Object.freeze({ cost: Object.freeze({ grain: 20, ore: 40 }), maxLevel: 1, yieldPerLevel: 0 }),
      outpost: Object.freeze({ cost: Object.freeze({ grain: 40, ore: 60 }), maxLevel: 1, yieldPerLevel: 0 }),
    }),
    tileBonusPerLevel: 10,
    watchtowerRange: 2,
    outpostDefenseBonus: 0.5,
    captureLevelLoss: 0.5,
    foundCost: Object.freeze({ grain: 150, ore: 150 }),
    foundEnvoys: 2,
    foundSpacing: 2,
    foundLimitByRadius: Object.freeze({ 4: 1, 6: 2, 8: 3 }),
  }),
});

export function troopCostsFor(balance: Pick<WargamesBalance, 'roles'>): Readonly<Record<TroopKind, ResourceBundle>> {
  const { units } = balance.roles;
  return { raider: units.raider.cost, guard: units.guard.cost, envoy: units.envoy.cost };
}

export function foundCostFor(rule: Pick<WargamesTerritoryRule, 'foundCost'>, villagesFounded: number): ResourceBundle {
  return { grain: rule.foundCost.grain * (villagesFounded + 1), ore: rule.foundCost.ore * (villagesFounded + 1) };
}

export function victoryPointTargetFor(balance: Pick<WargamesBalance, 'victory'>, mapRadius: number, seatCount: number): number | null {
  if (!isAllowedSeatCount(seatCount)) return null;
  return valueForRadius(balance.victory.targetByRadius, mapRadius)[seatCount];
}

export function valueForRadius<Value>(valueByRadius: Readonly<Record<number, Value>>, mapRadius: number): Value {
  const radii = Object.keys(valueByRadius).map(Number).sort((left, right) => left - right);
  const closestRadius = radii.filter((radius) => radius <= mapRadius).pop() ?? radii[0];
  return valueByRadius[closestRadius];
}

const BuildOrder = z.strictObject({
  kind: z.literal('build'),
  hexIndex: z.number().int().min(0).max(WARGAMES_MAX_HEX_COUNT - 1),
  building: z.union([BuildingKind, ImprovementKind]),
});

const FoundOrder = z.strictObject({
  kind: z.literal('found'),
  hexIndex: z.number().int().min(0).max(WARGAMES_MAX_HEX_COUNT - 1),
});

const TrainOrder = z.strictObject({
  kind: z.literal('train'),
  hexIndex: z.number().int().min(0).max(WARGAMES_MAX_HEX_COUNT - 1),
  troop: TroopKind,
  count: z.number().int().min(1).max(200),
});

const MarchOrder = z.strictObject({
  kind: z.literal('march'),
  fromHexIndex: z.number().int().min(0).max(WARGAMES_MAX_HEX_COUNT - 1),
  toHexIndex: z.number().int().min(0).max(WARGAMES_MAX_HEX_COUNT - 1),
  troops: TroopCounts,
});

const ScoutOrder = z.strictObject({
  kind: z.literal('scout'),
  fromHexIndex: z.number().int().min(0).max(WARGAMES_MAX_HEX_COUNT - 1),
  toHexIndex: z.number().int().min(0).max(WARGAMES_MAX_HEX_COUNT - 1),
});

export const OrderItem = z.discriminatedUnion('kind', [
  BuildOrder,
  FoundOrder,
  TrainOrder,
  MarchOrder,
  ScoutOrder,
]);
export type OrderItem = z.infer<typeof OrderItem>;

export const WargamesReport = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('battle'),
    reportId: z.string().min(1).max(64),
    tick: z.number().int().min(1),
    hexIndex: z.number().int().min(0).max(WARGAMES_MAX_HEX_COUNT - 1),
    attacker: SeatId,
    defender: SeatId.nullable(),
    attackerSent: TroopCounts,
    attackerLost: TroopCounts,
    defenderBefore: TroopCounts,
    defenderLost: TroopCounts,
    loyaltyBefore: z.number().int().min(0).max(100),
    loyaltyAfter: z.number().int().min(0).max(100),
    captured: z.boolean(),
    wallBefore: z.number().int().min(0).max(10).optional(),
    wallAfter: z.number().int().min(0).max(10).optional(),
    morale: z.number().min(0).max(1).optional(),
  }),
  z.strictObject({
    kind: z.literal('scout'),
    reportId: z.string().min(1).max(64),
    tick: z.number().int().min(1),
    scoutSeat: SeatId,
    targetHexIndex: z.number().int().min(0).max(WARGAMES_MAX_HEX_COUNT - 1),
    owner: SeatId.nullable(),
    productionState: VillageProductionState,
    loyalty: z.number().int().min(0).max(100),
    resources: ResourceBundle,
    troops: TroopCounts,
    buildings: BuildingLevels,
    spottedArmyIds: z.array(z.string().min(1).max(64)).max(128),
  }),
  z.strictObject({
    kind: z.literal('land'),
    reportId: z.string().min(1).max(64),
    tick: z.number().int().min(1),
    hexIndex: z.number().int().min(0).max(WARGAMES_MAX_HEX_COUNT - 1),
    claimer: SeatId,
    previousOwner: SeatId.nullable(),
  }),
]);
export type WargamesReport = z.infer<typeof WargamesReport>;

export const MessageChannel = z.enum(['dm', 'public']);
export type MessageChannel = z.infer<typeof MessageChannel>;

export const MessageRecord = z.strictObject({
  id: z.string().min(1).max(64),
  tick: z.number().int().min(0),
  from: SeatId,
  to: SeatId.nullable(),
  channel: MessageChannel,
  text: z.string().min(1).max(2000),
});
export type MessageRecord = z.infer<typeof MessageRecord>;

export const RejectionCode = z.enum([
  'invalid_match_state',
  'invalid_phase',
  'invalid_seat_state',
  'invalid_village_state',
  'invalid_army_state',
  'message_limit_exceeded',
  'note_too_large',
  'insufficient_resources',
  'invalid_target',
  'invalid_order',
  'unauthorized_seat',
]);
export type RejectionCode = z.infer<typeof RejectionCode>;

export const WargamesRejection = z.strictObject({
  code: RejectionCode,
  message: z.string().min(1).max(400),
});
export type WargamesRejection = z.infer<typeof WargamesRejection>;

export const WargamesEvent = z.discriminatedUnion('type', [
  z.strictObject({
    seq: z.number().int().min(0),
    type: z.literal('match_created'),
    matchId: WargamesMatchId,
    createdAtMs: z.number().int().min(0),
    spec: WargamesMatchSpec,
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('seating_started'),
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('seat_connected'),
    seatId: SeatId,
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('seat_disconnected'),
    seatId: SeatId,
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('message_sent'),
    seatId: SeatId,
    to: SeatId.nullable(),
    channel: MessageChannel,
    text: z.string().min(1).max(2000),
    }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('seat_ready'),
    seatId: SeatId,
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('orders_submitted'),
    seatId: SeatId,
    orders: z.array(OrderItem).max(64),
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('note_written'),
    seatId: SeatId,
    text: z.string().max(WARGAMES_NOTE_MAX_BYTES),
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('phase_advanced'),
    reason: z.enum(['all_submitted', 'deadline']),
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('match_aborted'),
    reason: z.string().min(1).max(400),
  }),
]);
export type WargamesEvent = z.infer<typeof WargamesEvent>;

export const WargamesPhaseClock = z.strictObject({
  remainingMs: z.number().int().min(0),
  lengthMs: z.number().int().min(1),
});
export type WargamesPhaseClock = z.infer<typeof WargamesPhaseClock>;

const DramaKind = z.enum(['betrayal']);

export const DramaHighlight = z.strictObject({
  id: z.string().min(1).max(80),
  kind: DramaKind,
  tick: z.number().int().min(1),
  actor: SeatId,
  target: SeatId,
  summary: z.string().min(1).max(300),
  relatedDmText: z.string().max(2000).nullable(),
  relatedOrderText: z.string().max(400).nullable(),
});
export type DramaHighlight = z.infer<typeof DramaHighlight>;

export const SeatMetrics = z.strictObject({
  seatId: SeatId,
  modelDisplay: z.string().min(1).max(120),
  villagesHeld: z.number().int().min(0),
  messagesSent: z.number().int().min(0),
  publicMessages: z.number().int().min(0),
  betrayals: z.number().int().min(0),
  firstBetrayalTick: z.number().int().min(1).nullable(),
  tokensPerTurn: z.number().min(0).nullable(),
});
export type SeatMetrics = z.infer<typeof SeatMetrics>;

export const MatchAnalytics = z.strictObject({
  highlights: z.array(DramaHighlight),
  seats: z.array(SeatMetrics),
});
export type MatchAnalytics = z.infer<typeof MatchAnalytics>;

export const ModelEloRow = z.strictObject({
  modelDisplay: z.string().min(1).max(120),
  elo: z.number(),
  matchesPlayed: z.number().int().min(0),
  wins: z.number().int().min(0),
  avgVillages: z.number().min(0),
});
export type ModelEloRow = z.infer<typeof ModelEloRow>;

export const WargamesMatchSummary = z.strictObject({
  matchId: WargamesMatchId,
  rules: WargamesRulesId,
  hasCustomStrategy: z.boolean().default(false),
  title: z.string().min(1).max(120),
  seed: z.number().int().min(1),
  createdAtMs: z.number().int().min(0),
  finishedAtMs: z.number().int().min(0).nullable(),
  status: MatchStatus,
  tick: z.number().int().min(0),
  maxTicks: z.number().int().min(1),
  phase: TickPhase,
  winnerSeatId: SeatId.nullable(),
  winnerModelDisplay: z.string().nullable(),
  eventCount: z.number().int().min(0),
  seats: z.array(z.strictObject({
    seatId: SeatId,
    label: z.string(),
    modelDisplay: z.string(),
    status: SeatStatus,
    villagesHeld: z.number().int().min(0),
    victoryPoints: z.number().int().min(0).default(0),
  })),
});
export type WargamesMatchSummary = z.infer<typeof WargamesMatchSummary>;

export const WargamesHistory = z.strictObject({
  eloByModel: z.array(ModelEloRow),
  matches: z.array(WargamesMatchSummary),
});
export type WargamesHistory = z.infer<typeof WargamesHistory>;

export const AgentWargamesRequest = z.discriminatedUnion('sub', [
  z.strictObject({ sub: z.literal('start'), spec: z.record(z.string(), z.unknown()) }),
  z.strictObject({ sub: z.literal('matches') }),
  z.strictObject({ sub: z.literal('match'), match: WargamesMatchId }),
  z.strictObject({ sub: z.literal('abort'), match: WargamesMatchId, reason: z.string().trim().min(1).max(400).optional() }),
  z.strictObject({ sub: z.literal('history') }),
]);
export type AgentWargamesRequest = z.infer<typeof AgentWargamesRequest>;

export const AgentWargamesReply = z.union([
  z.strictObject({ ok: z.literal(true), matchId: WargamesMatchId, warning: z.string().nullable() }),
  z.strictObject({ ok: z.literal(true), matches: z.array(WargamesMatchSummary) }),
  z.strictObject({ ok: z.literal(true), match: WargamesMatchSummary }),
  z.strictObject({ ok: z.literal(true), history: WargamesHistory }),
  z.strictObject({ ok: z.literal(true) }),
]);
export type AgentWargamesReply = z.infer<typeof AgentWargamesReply>;
