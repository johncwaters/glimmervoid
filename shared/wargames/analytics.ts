import type {
  DramaHighlight,
  MatchAnalytics,
  ModelEloRow,
  OrderItem,
  SeatId,
  SeatMetrics,
  WargamesMatchSummary,
} from '../contracts/wargames.ts';
import type { MatchState } from './engine.ts';
import { createInitialMatchState, matchSeatIds, seatIndexOf, seatStandingOf } from './engine.ts';

const BETRAYAL_WINDOW_TICKS = 3;
const ELO_DEFAULT = 1500;
const ELO_K_FACTOR = 24;

function summarizeOrder(order: OrderItem): string {
  if (order.kind === 'march') {
    return `march(${order.fromHexIndex}->${order.toHexIndex}: R${order.troops.raider}/G${order.troops.guard}/E${order.troops.envoy})`;
  }
  if (order.kind === 'build') return `build(${order.building}@${order.hexIndex})`;
  if (order.kind === 'train') return `train(${order.count} ${order.troop}@${order.hexIndex})`;
  return `found(${order.hexIndex})`;
}

export function summarizeMatch(state: MatchState, finishedAtMs: number | null, eventCount: number): WargamesMatchSummary {
  const villageCounts = villageCountsOf(state);
  const winnerSeat = state.winnerSeatId ? state.seats[seatIndexOf(state.winnerSeatId)] : null;
  const hasCustomStrategy = state.spec.seats.some((seat) => seat.setup.instructions.trim().length > 0);
  return {
    matchId: state.matchId,
    rules: state.spec.rules,
    hasCustomStrategy,
    title: state.spec.title,
    seed: state.spec.seed,
    createdAtMs: state.createdAtMs,
    finishedAtMs,
    status: state.status,
    tick: state.tick,
    maxTicks: state.spec.maxTicks,
    phase: state.phase,
    winnerSeatId: state.winnerSeatId,
    winnerModelDisplay: winnerSeat ? winnerSeat.config.modelDisplay : null,
    eventCount,
    seats: state.seats.map((seat) => ({
      seatId: seat.config.seatId,
      label: seat.config.label,
      modelDisplay: seat.config.modelDisplay,
      status: seat.status,
      villagesHeld: villageCounts.get(seat.config.seatId) ?? 0,
      victoryPoints: state.victoryPointsBySeat[seat.config.seatId] ?? 0,
    })),
  };
}

function villageCountsOf(state: MatchState): Map<SeatId, number> {
  const villageCounts = new Map<SeatId, number>(matchSeatIds(state).map((seatId) => [seatId, 0]));
  for (const village of state.villages) {
    if (village && !village.isBeacon && village.owner !== null) {
      villageCounts.set(village.owner, (villageCounts.get(village.owner) ?? 0) + 1);
    }
  }
  return villageCounts;
}

function buildOwnershipTimeline(state: MatchState): Map<number, Map<number, SeatId | null>> {
  const initial = createInitialMatchState(state.matchId, state.createdAtMs, state.spec);
  const currentOwnerByHex = new Map<number, SeatId | null>();
  for (const village of initial.villages) {
    if (village) currentOwnerByHex.set(village.hexIndex, village.owner);
  }
  const ownerChangesByTick = new Map<number, { hexIndex: number; owner: SeatId }[]>();
  const recordOwnerChange = (tick: number, hexIndex: number, owner: SeatId) => {
    ownerChangesByTick.set(tick, [...(ownerChangesByTick.get(tick) ?? []), { hexIndex, owner }]);
  };
  const foundedHexes = new Set<number>();
  for (const tick of Object.keys(state.ordersByTick).map(Number).sort((left, right) => left - right)) {
    for (const seatId of matchSeatIds(state)) {
      for (const order of state.ordersByTick[tick][seatId] ?? []) {
        if (order.kind !== 'found' || foundedHexes.has(order.hexIndex)) continue;
        if (initial.villages[order.hexIndex] !== null || state.villages[order.hexIndex] === null) continue;
        foundedHexes.add(order.hexIndex);
        recordOwnerChange(tick, order.hexIndex, seatId);
      }
    }
  }
  for (const report of state.reportsById.values()) {
    if (report.kind === 'battle' && report.captured) recordOwnerChange(report.tick, report.hexIndex, report.attacker);
  }
  const ownerBeforeTick = new Map<number, Map<number, SeatId | null>>();
  for (let tick = 1; tick <= state.tick; tick += 1) {
    ownerBeforeTick.set(tick, new Map(currentOwnerByHex));
    for (const change of ownerChangesByTick.get(tick) ?? []) currentOwnerByHex.set(change.hexIndex, change.owner);
  }
  return ownerBeforeTick;
}

function latestDirectMessage(state: MatchState, from: SeatId, to: SeatId, tick: number): MatchState['messages'][number] | null {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message.channel !== 'dm' || message.from !== from || message.to !== to || message.tick > tick) continue;
    return tick - message.tick <= BETRAYAL_WINDOW_TICKS ? message : null;
  }
  return null;
}

export function betrayalsOf(state: MatchState): DramaHighlight[] {
  const betrayalsById = new Map<string, DramaHighlight>();
  const ownerBeforeTick = buildOwnershipTimeline(state);
  const orderedTicks = Object.keys(state.ordersByTick).map(Number).sort((left, right) => left - right);
  for (const tick of orderedTicks) {
    const ownerAtTick = ownerBeforeTick.get(tick);
    for (const seatId of matchSeatIds(state)) {
      for (const order of state.ordersByTick[tick][seatId] ?? []) {
        if (order.kind !== 'march') continue;
        const targetOwner = ownerAtTick?.get(order.toHexIndex) ?? null;
        if (targetOwner === null || targetOwner === seatId) continue;
        const message = latestDirectMessage(state, seatId, targetOwner, tick);
        if (message === null) continue;
        const betrayalId = `betrayal-${tick}-${seatId}-${targetOwner}`;
        const existing = betrayalsById.get(betrayalId);
        if (existing) {
          existing.relatedOrderText = `${existing.relatedOrderText}, ${summarizeOrder(order)}`;
          continue;
        }
        betrayalsById.set(betrayalId, {
          id: betrayalId,
          kind: 'betrayal',
          tick,
          actor: seatId,
          target: targetOwner,
          summary: `${seatId} attacked ${targetOwner} ${tick - message.tick === 0 ? 'the same turn' : `${tick - message.tick} turns`} after messaging them`,
          relatedDmText: message.text,
          relatedOrderText: summarizeOrder(order),
        });
      }
    }
  }
  return [...betrayalsById.values()];
}

export function analyzeMatch(state: MatchState, tokensBySeat: Partial<Record<SeatId, number>> = {}): MatchAnalytics {
  const highlights = betrayalsOf(state);
  const villageCounts = villageCountsOf(state);
  const ticksPlayed = Math.max(1, state.tick);
  const seats: SeatMetrics[] = state.seats.map((seat) => {
    const seatId = seat.config.seatId;
    const sent = state.messages.filter((message) => message.from === seatId);
    const betrayals = highlights.filter((highlight) => highlight.actor === seatId);
    const tokens = tokensBySeat[seatId];
    return {
      seatId,
      modelDisplay: seat.config.modelDisplay,
      villagesHeld: villageCounts.get(seatId) ?? 0,
      messagesSent: sent.length,
      publicMessages: sent.filter((message) => message.channel === 'public').length,
      betrayals: betrayals.length,
      firstBetrayalTick: betrayals.length === 0 ? null : Math.min(...betrayals.map((highlight) => highlight.tick)),
      tokensPerTurn: tokens !== undefined ? tokens / ticksPlayed : null,
    };
  });
  highlights.sort((left, right) => right.tick - left.tick);
  return { highlights, seats };
}

interface DiplomacySeatRow {
  seatId: SeatId;
  modelDisplay: string;
  messagesSent: number;
  publicMessages: number;
  betrayals: number;
  standing: number;
}

export interface DiplomacyMetrics {
  matchId: string;
  ticksPlayed: number;
  winnerSeatId: SeatId | null;
  messagesPerSeatPerTick: number;
  publicMessages: number;
  talkingPairs: number;
  betrayals: number;
  seats: DiplomacySeatRow[];
}

export function diplomacyMetrics(state: MatchState): DiplomacyMetrics {
  const seatIds = matchSeatIds(state);
  const ticksPlayed = Math.max(1, state.tick);
  const analytics = analyzeMatch(state);
  const talkingPairs = new Set(state.messages
    .filter((message) => message.channel === 'dm' && message.to !== null)
    .map((message) => [message.from, message.to].sort().join('+')));
  return {
    matchId: state.matchId,
    ticksPlayed,
    winnerSeatId: state.winnerSeatId,
    messagesPerSeatPerTick: state.messages.length / (seatIds.length * ticksPlayed),
    publicMessages: state.messages.filter((message) => message.channel === 'public').length,
    talkingPairs: talkingPairs.size,
    betrayals: analytics.highlights.length,
    seats: analytics.seats.map((seat) => ({
      seatId: seat.seatId,
      modelDisplay: seat.modelDisplay,
      messagesSent: seat.messagesSent,
      publicMessages: seat.publicMessages,
      betrayals: seat.betrayals,
      standing: seatStandingOf(state, seat.seatId).score,
    })),
  };
}

function pairwiseScore(
  seatA: WargamesMatchSummary['seats'][number],
  seatB: WargamesMatchSummary['seats'][number],
  winnerSeatId: SeatId | null,
): number {
  if (seatA.seatId === winnerSeatId) return 1;
  if (seatB.seatId === winnerSeatId) return 0;
  if (seatA.victoryPoints !== seatB.victoryPoints) return seatA.victoryPoints > seatB.victoryPoints ? 1 : 0;
  if (seatA.villagesHeld > seatB.villagesHeld) return 1;
  if (seatB.villagesHeld > seatA.villagesHeld) return 0;
  return 0.5;
}

function updateModelElo(
  currentRows: ReadonlyMap<string, ModelEloRow>,
  summary: WargamesMatchSummary,
): Map<string, ModelEloRow> {
  const next = new Map<string, ModelEloRow>();
  for (const [model, row] of currentRows) next.set(model, { ...row });
  if (summary.status !== 'finished') return next;
  const ratedSeats = summary.seats.filter((seat) => seat.status !== 'disconnected');

  for (const seat of ratedSeats) {
    if (next.has(seat.modelDisplay)) continue;
    next.set(seat.modelDisplay, {
      modelDisplay: seat.modelDisplay,
      elo: ELO_DEFAULT,
      matchesPlayed: 0,
      wins: 0,
      avgVillages: 0,
    });
  }

  const deltas = new Map<string, number>();
  for (let i = 0; i < ratedSeats.length; i += 1) {
    for (let j = i + 1; j < ratedSeats.length; j += 1) {
      const seatA = ratedSeats[i];
      const seatB = ratedSeats[j];
      if (seatA.modelDisplay === seatB.modelDisplay) continue;
      const ratingA = next.get(seatA.modelDisplay)?.elo ?? ELO_DEFAULT;
      const ratingB = next.get(seatB.modelDisplay)?.elo ?? ELO_DEFAULT;
      const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
      const scoreA = pairwiseScore(seatA, seatB, summary.winnerSeatId);
      const deltaA = (ELO_K_FACTOR / (ratedSeats.length - 1)) * (scoreA - expectedA);
      deltas.set(seatA.modelDisplay, (deltas.get(seatA.modelDisplay) ?? 0) + deltaA);
      deltas.set(seatB.modelDisplay, (deltas.get(seatB.modelDisplay) ?? 0) - deltaA);
    }
  }

  for (const seat of ratedSeats) {
    const row = next.get(seat.modelDisplay);
    if (!row) continue;
    const totalVillages = row.avgVillages * row.matchesPlayed + seat.villagesHeld;
    row.matchesPlayed += 1;
    row.avgVillages = totalVillages / row.matchesPlayed;
    if (seat.seatId === summary.winnerSeatId) row.wins += 1;
  }

  for (const [modelDisplay, delta] of deltas) {
    const row = next.get(modelDisplay);
    if (!row) continue;
    row.elo = Math.round((row.elo + delta) * 10) / 10;
  }

  return next;
}

export function computeEloFromSummaries(summaries: readonly WargamesMatchSummary[]): ModelEloRow[] {
  const ordered = [...summaries].sort((left, right) => left.createdAtMs - right.createdAtMs);
  let table = new Map<string, ModelEloRow>();
  for (const summary of ordered) {
    table = updateModelElo(table, summary);
  }
  return [...table.values()].sort((left, right) => right.elo - left.elo);
}
