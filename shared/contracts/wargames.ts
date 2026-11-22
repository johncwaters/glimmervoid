import { z } from 'zod';
import { AgentSetup } from './agent-models.ts';

export const WARGAMES_RULES_VERSION = 'v2' as const;
const LEGACY_WARGAMES_RULES_VERSION = 'v1' as const;
const WargamesRulesVersion = z.string().regex(/^v[1-9]\d*$/);

export const WARGAMES_SEAT_IDS = ['s1', 's2', 's3', 's4', 's5', 's6'] as const;
const WARGAMES_SEAT_COUNT = 6;
export const WARGAMES_HEX_RADIUS = 3;
export const WARGAMES_HEX_COUNT = 37;
const WARGAMES_MAX_TICKS = 40;
const WARGAMES_TICK_DEADLINE_SECONDS = 60;
export const WARGAMES_SQUEEZE_TICK = 25;
export const WARGAMES_WIN_VILLAGES = 12;
export const WARGAMES_NOTE_MAX_BYTES = 4096;
export const WARGAMES_MAX_MESSAGES_PER_TICK = 2;
export const WARGAMES_MAX_TRIBE_SIZE = 2;
export const WARGAMES_TRAVEL_HEXES_PER_TICK = 2;

export const SeatId = z.enum(WARGAMES_SEAT_IDS);
export type SeatId = z.infer<typeof SeatId>;

export const MatchStatus = z.enum(['lobby', 'seating', 'running', 'finished', 'aborted']);
export type MatchStatus = z.infer<typeof MatchStatus>;

export const TickPhase = z.enum(['talk', 'contracts', 'orders', 'resolving', 'reported']);
export type TickPhase = z.infer<typeof TickPhase>;

export const SeatStatus = z.enum(['disconnected', 'connected', 'acting', 'submitted', 'timedOut', 'eliminated']);
export type SeatStatus = z.infer<typeof SeatStatus>;

export const ContractStatus = z.enum(['proposed', 'active', 'fulfilled', 'breached', 'rejected', 'expired']);
export type ContractStatus = z.infer<typeof ContractStatus>;

export const VillageProductionState = z.enum(['producing', 'barren']);
export type VillageProductionState = z.infer<typeof VillageProductionState>;

export const ArmyStatus = z.enum(['mustering', 'marching', 'arrived', 'returning', 'home', 'destroyed']);
export type ArmyStatus = z.infer<typeof ArmyStatus>;

export const BuildingKind = z.enum(['farm', 'mine', 'barracks', 'wall']);
export type BuildingKind = z.infer<typeof BuildingKind>;

export const TroopKind = z.enum(['raider', 'guard', 'envoy']);
export type TroopKind = z.infer<typeof TroopKind>;

const SeatControllerKind = z.enum(['local-agent']);

export const WargamesMatchId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export type WargamesMatchId = z.infer<typeof WargamesMatchId>;

export const HexCoord = z.strictObject({
  q: z.number().int().min(-WARGAMES_HEX_RADIUS).max(WARGAMES_HEX_RADIUS),
  r: z.number().int().min(-WARGAMES_HEX_RADIUS).max(WARGAMES_HEX_RADIUS),
}).refine((coord) => Math.abs(coord.q + coord.r) <= WARGAMES_HEX_RADIUS, {
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
  barracks: z.number().int().min(0).max(10),
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
  rulesVersion: WargamesRulesVersion.default(LEGACY_WARGAMES_RULES_VERSION),
  title: z.string().trim().min(1).max(120).default('Wargames Match'),
  seed: z.number().int().min(1).max(2147483647),
  tickDeadlineSeconds: z.number().int().min(5).max(300).default(WARGAMES_TICK_DEADLINE_SECONDS),
  maxTicks: z.number().int().min(5).max(80).default(WARGAMES_MAX_TICKS),
  seats: z.array(SeatConfig).length(WARGAMES_SEAT_COUNT),
}).refine((spec) => new Set(spec.seats.map((seat) => seat.seatId)).size === WARGAMES_SEAT_COUNT, {
  error: 'all 6 seat ids must be distinct',
  path: ['seats'],
});
export type WargamesMatchSpec = z.infer<typeof WargamesMatchSpec>;

const EscrowTerms = z.strictObject({
  kind: z.literal('escrow'),
  counterparty: SeatId,
  proposerGives: ResourceBundle,
  counterpartyGives: ResourceBundle,
});

const NapTerms = z.strictObject({
  kind: z.literal('nap'),
  counterparty: SeatId,
  durationTicks: z.number().int().min(1).max(40),
  collateral: ResourceBundle,
});

export const ContractTerms = z.discriminatedUnion('kind', [EscrowTerms, NapTerms]);
export type ContractTerms = z.infer<typeof ContractTerms>;

export const ContractRecord = z.strictObject({
  id: z.string().min(1).max(64),
  proposer: SeatId,
  counterparty: SeatId,
  terms: ContractTerms,
  status: ContractStatus,
  proposedTick: z.number().int().min(0),
  activatedTick: z.number().int().min(0).nullable(),
  endTick: z.number().int().min(0).nullable(),
  breachedBy: SeatId.nullable(),
  breachedTick: z.number().int().min(0).nullable(),
});
export type ContractRecord = z.infer<typeof ContractRecord>;

const BuildOrder = z.strictObject({
  kind: z.literal('build'),
  hexIndex: z.number().int().min(0).max(WARGAMES_HEX_COUNT - 1),
  building: BuildingKind,
});

const TrainOrder = z.strictObject({
  kind: z.literal('train'),
  hexIndex: z.number().int().min(0).max(WARGAMES_HEX_COUNT - 1),
  troop: TroopKind,
  count: z.number().int().min(1).max(200),
});

const MarchOrder = z.strictObject({
  kind: z.literal('march'),
  fromHexIndex: z.number().int().min(0).max(WARGAMES_HEX_COUNT - 1),
  toHexIndex: z.number().int().min(0).max(WARGAMES_HEX_COUNT - 1),
  troops: TroopCounts,
});

const ScoutOrder = z.strictObject({
  kind: z.literal('scout'),
  fromHexIndex: z.number().int().min(0).max(WARGAMES_HEX_COUNT - 1),
  toHexIndex: z.number().int().min(0).max(WARGAMES_HEX_COUNT - 1),
});

const TribeJoinOrder = z.strictObject({
  kind: z.literal('tribe_join'),
  partner: SeatId,
});

const TribeLeaveOrder = z.strictObject({
  kind: z.literal('tribe_leave'),
});

export const OrderItem = z.discriminatedUnion('kind', [
  BuildOrder,
  TrainOrder,
  MarchOrder,
  ScoutOrder,
  TribeJoinOrder,
  TribeLeaveOrder,
]);
export type OrderItem = z.infer<typeof OrderItem>;

export const SignedReportPayload = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('battle'),
    reportId: z.string().min(1).max(64),
    tick: z.number().int().min(1),
    hexIndex: z.number().int().min(0).max(WARGAMES_HEX_COUNT - 1),
    attacker: SeatId,
    defender: SeatId.nullable(),
    attackerSent: TroopCounts,
    attackerLost: TroopCounts,
    defenderBefore: TroopCounts,
    defenderLost: TroopCounts,
    loyaltyBefore: z.number().int().min(0).max(100),
    loyaltyAfter: z.number().int().min(0).max(100),
    captured: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('scout'),
    reportId: z.string().min(1).max(64),
    tick: z.number().int().min(1),
    scoutSeat: SeatId,
    targetHexIndex: z.number().int().min(0).max(WARGAMES_HEX_COUNT - 1),
    owner: SeatId.nullable(),
    productionState: VillageProductionState,
    loyalty: z.number().int().min(0).max(100),
    resources: ResourceBundle,
    troops: TroopCounts,
    buildings: BuildingLevels,
    spottedArmyIds: z.array(z.string().min(1).max(64)).max(128),
  }),
]);
export type SignedReportPayload = z.infer<typeof SignedReportPayload>;

export const SignedReport = z.strictObject({
  payload: SignedReportPayload,
  signature: z.string().min(1).max(128),
});
export type SignedReport = z.infer<typeof SignedReport>;

export const MessageChannel = z.enum(['dm', 'tribe']);
export type MessageChannel = z.infer<typeof MessageChannel>;

export const MessageRecord = z.strictObject({
  id: z.string().min(1).max(64),
  tick: z.number().int().min(0),
  from: SeatId,
  to: SeatId.nullable(),
  channel: MessageChannel,
  tribeId: z.string().max(64).nullable().default(null),
  text: z.string().min(1).max(2000),
  attachedReport: SignedReport.nullable().default(null),
});
export type MessageRecord = z.infer<typeof MessageRecord>;

export const LedgerBreachEntry = z.strictObject({
  tick: z.number().int().min(1),
  contractId: z.string().min(1).max(64),
  breacher: SeatId,
  victim: SeatId,
  collateralTransferred: ResourceBundle,
});
export type LedgerBreachEntry = z.infer<typeof LedgerBreachEntry>;

export const RejectionCode = z.enum([
  'invalid_match_state',
  'invalid_phase',
  'invalid_seat_state',
  'invalid_contract_state',
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
    attachedReport: SignedReport.nullable().default(null),
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('contract_proposed'),
    seatId: SeatId,
    contractId: z.string().min(1).max(64),
    terms: ContractTerms,
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('contract_accepted'),
    seatId: SeatId,
    contractId: z.string().min(1).max(64),
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('contract_rejected'),
    seatId: SeatId,
    contractId: z.string().min(1).max(64),
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
    type: z.literal('report_verified'),
    seatId: SeatId,
    reportId: z.string().min(1).max(64),
    valid: z.boolean(),
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('phase_advanced'),
    reason: z.enum(['all_submitted', 'deadline']),
    signatures: z.record(z.string(), z.string()).default({}),
  }),
  z.strictObject({
    seq: z.number().int().min(1),
    type: z.literal('match_aborted'),
    reason: z.string().min(1).max(400),
  }),
]);
export type WargamesEvent = z.infer<typeof WargamesEvent>;

const DramaKind = z.enum(['contract_breach', 'ally_attack', 'forged_report']);

export const DramaHighlight = z.strictObject({
  id: z.string().min(1).max(80),
  kind: DramaKind,
  tick: z.number().int().min(1),
  actor: SeatId,
  target: SeatId,
  summary: z.string().min(1).max(300),
  relatedDmText: z.string().max(2000).nullable(),
  relatedOrderText: z.string().max(400).nullable(),
  detected: z.boolean().nullable(),
});
export type DramaHighlight = z.infer<typeof DramaHighlight>;

export const SeatMetrics = z.strictObject({
  seatId: SeatId,
  modelDisplay: z.string().min(1).max(120),
  villagesHeld: z.number().int().min(0),
  promisesKeptTalkRate: z.number().min(0).max(1).nullable(),
  promisesKeptContractRate: z.number().min(0).max(1).nullable(),
  firstBetrayalTick: z.number().int().min(1).nullable(),
  forgedReportsSent: z.number().int().min(0),
  forgedReportsDetected: z.number().int().min(0),
  tokensPerTurn: z.number().min(0).nullable(),
});
export type SeatMetrics = z.infer<typeof SeatMetrics>;

export const MatchAnalytics = z.strictObject({
  highlights: z.array(DramaHighlight),
  seats: z.array(SeatMetrics),
  avgCoalitionLifetimeTicks: z.number().min(0).nullable(),
  forgedReportDetectionRate: z.number().min(0).max(1).nullable(),
  sameModelCollusionRate: z.number().min(0).max(1).nullable(),
});
export type MatchAnalytics = z.infer<typeof MatchAnalytics>;

export const ModelEloRow = z.strictObject({
  modelDisplay: z.string().min(1).max(120),
  elo: z.number(),
  matchesPlayed: z.number().int().min(0),
  wins: z.number().int().min(0),
  avgVillages: z.number().min(0),
  breaches: z.number().int().min(0),
});
export type ModelEloRow = z.infer<typeof ModelEloRow>;

export const WargamesMatchSummary = z.strictObject({
  matchId: WargamesMatchId,
  rulesVersion: WargamesRulesVersion.default(LEGACY_WARGAMES_RULES_VERSION),
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
  breachCount: z.number().int().min(0),
  eventCount: z.number().int().min(0),
  seats: z.array(z.strictObject({
    seatId: SeatId,
    label: z.string(),
    modelDisplay: z.string(),
    status: SeatStatus,
    villagesHeld: z.number().int().min(0),
    breaches: z.number().int().min(0).default(0),
  })),
});
export type WargamesMatchSummary = z.infer<typeof WargamesMatchSummary>;

export const WargamesHistory = z.strictObject({
  currentRulesVersion: WargamesRulesVersion.default(LEGACY_WARGAMES_RULES_VERSION),
  eloByModel: z.array(ModelEloRow),
  eloByVersion: z.record(WargamesRulesVersion, z.array(ModelEloRow)).default({}),
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
