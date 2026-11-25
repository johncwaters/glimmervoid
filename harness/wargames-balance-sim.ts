import { performance } from 'node:perf_hooks';

import {
  WARGAMES_MAP_SIZES,
  WargamesMatchSpec,
  seatIdsForCount,
  troopCostsFor,
  victoryPointTargetFor,
  victoryVillagesForBalance,
  wargamesBalanceFor,
} from '../shared/contracts/wargames.ts';
import type { OrderItem, SeatId, TroopCounts, WargamesBalance, WargamesEvent, WargamesSeatCount } from '../shared/contracts/wargames.ts';
import { applyEvent, createInitialMatchState } from '../shared/wargames/engine.ts';
import type { MatchState } from '../shared/wargames/engine.ts';

type VillageState = NonNullable<MatchState['villages'][number]>;

type StrategyName = 'rusher' | 'builder' | 'turtle' | 'mixed' | 'village';
const STRATEGIES: readonly StrategyName[] = ['rusher', 'builder', 'turtle', 'mixed', 'village'];
const ALL_VILLAGE_SEATS = process.argv.includes('--all-village');
const SEEDS = Array.from({ length: 24 }, (_, index) => 101 * (index + 1));
const SEAT_COUNTS: readonly WargamesSeatCount[] = [4, 6];
const ATTACK_MARGIN = 2;
const BUILD_PAYBACK_TURNS = 4;
const FLIP_BACK_WINDOW_TURNS = 3;
const BYTES_PER_MB = 2 ** 20;

interface Candidate {
  name: string;
  rulesVersion: 'v5' | 'v6' | 'v7' | 'v8' | 'v9';
  balance: WargamesBalance;
}

interface GameRecord {
  winnerStrategy: StrategyName | null;
  winKind: 'goal' | 'limit';
  endTurn: number;
  maxTicks: number;
  seatsAliveAtMidGame: number;
  seatCount: number;
  captures: number;
  flipBacks: number;
  seatsThatFell: number;
  seatsThatCameBack: number;
  buildsJudged: number;
  buildsPaidBack: number;
  midGameLeaderLost: boolean;
  landFullTurn: number | null;
}

const signer = { sign: () => 'sim', verify: () => true };

function hexDistance(first: { q: number; r: number }, second: { q: number; r: number }): number {
  return Math.max(Math.abs(first.q - second.q), Math.abs(first.r - second.r), Math.abs(first.q + first.r - second.q - second.r));
}

function step(state: MatchState, event: Record<string, unknown>): MatchState {
  const outcome = applyEvent(state, { ...event, seq: state.lastSeq + 1 } as WargamesEvent, signer);
  if (!outcome.ok) throw new Error(`${String(event.type)} rejected: ${outcome.rejection.message}`);
  return outcome.state;
}

function lastVillageMultiplierOf(state: MatchState, village: VillageState): number {
  const ownerVillages = village.owner === null ? 0 : state.villages.filter((candidate) => candidate?.owner === village.owner).length;
  return ownerVillages === 1 ? state.balance.lastVillageDefenseMultiplier : 1;
}

function defensePowerOf(state: MatchState, village: VillageState, sendingRaiders: boolean): number {
  const roles = state.balance.roles;
  if (roles !== null) {
    const troopDefense = village.troops.raider * roles.units.raider.defense + village.troops.guard * roles.units.guard.defense + village.troops.envoy * roles.units.envoy.defense;
    const wall = village.buildings.wall;
    return (troopDefense + wall * roles.wallDefensePerLevel) * (1 + wall * roles.wallBonusPerLevel) * lastVillageMultiplierOf(state, village);
  }
  const raiderPower = village.troops.raider * 10 * 1.5;
  const guardPower = village.troops.guard * 10 * (sendingRaiders ? 1.5 : 1);
  const envoyPower = village.troops.envoy * 8 * 1.5;
  return (raiderPower + guardPower + envoyPower) * (1 + village.buildings.wall * 0.15) * lastVillageMultiplierOf(state, village);
}

function raidersNeeded(state: MatchState, target: VillageState, envoys: number): number {
  const roles = state.balance.roles;
  if (roles !== null) return Math.max(0, Math.ceil((defensePowerOf(state, target, true) * ATTACK_MARGIN) / roles.units.raider.attack));
  const envoyPower = envoys * 8 * (target.troops.guard > 0 ? 1.5 : 1);
  const raiderPower = 10 * (target.troops.envoy > 0 ? 1.5 : 1);
  return Math.max(0, Math.ceil((defensePowerOf(state, target, true) * ATTACK_MARGIN - envoyPower) / raiderPower));
}

function envoysNeeded(state: MatchState, target: VillageState): number {
  const roles = state.balance.roles;
  const meanDrain = roles === null ? state.balance.envoyLoyaltyDrain : (roles.captureDrainMin + roles.captureDrainMax) / 2;
  return Math.ceil(target.loyalty / meanDrain / 0.6);
}

function ownedVillagesOf(state: MatchState, seatId: SeatId): VillageState[] {
  return state.villages.filter((village): village is VillageState => village !== null && !village.isBeacon && village.owner === seatId);
}

function standingLeaderOf(state: MatchState): SeatId {
  const usesPoints = state.balance.victory.kind === 'points';
  const scoreOf = (seatId: SeatId) => (usesPoints ? state.victoryPointsBySeat[seatId] : ownedVillagesOf(state, seatId).length);
  return state.seats.map((seat) => seat.config.seatId).sort((left, right) => scoreOf(right) - scoreOf(left))[0];
}

function nearestTargets(state: MatchState, from: VillageState, seatId: SeatId, onlyBarbarians: boolean): VillageState[] {
  const origin = state.hexes[from.hexIndex];
  return state.villages
    .filter((village): village is VillageState => village !== null && village.owner !== seatId && (!onlyBarbarians || village.owner === null))
    .sort((left, right) => hexDistance(origin, state.hexes[left.hexIndex]) - hexDistance(origin, state.hexes[right.hexIndex]));
}

interface Purse {
  grain: number;
  ore: number;
}

function canAfford(purse: Purse, cost: { grain: number; ore: number }, count = 1): boolean {
  return purse.grain >= cost.grain * count && purse.ore >= cost.ore * count;
}

function spend(purse: Purse, cost: { grain: number; ore: number }, count = 1): void {
  purse.grain -= cost.grain * count;
  purse.ore -= cost.ore * count;
}

function trainAffordable(state: MatchState, orders: OrderItem[], village: VillageState, purse: Purse, troop: keyof TroopCounts, wanted: number): number {
  const cost = troopCostsFor(state.balance)[troop];
  const affordable = Math.min(wanted, Math.floor(purse.grain / cost.grain), Math.floor(purse.ore / cost.ore), 200);
  if (affordable <= 0) return 0;
  spend(purse, cost, affordable);
  orders.push({ kind: 'train', hexIndex: village.hexIndex, troop, count: affordable });
  return affordable;
}

function buildIfAffordable(state: MatchState, orders: OrderItem[], village: VillageState, purse: Purse, building: 'farm' | 'mine' | 'wall'): boolean {
  const cost = state.balance.buildingCosts[building];
  if (village.buildings[building] >= 10 || !canAfford(purse, cost)) return false;
  spend(purse, cost);
  orders.push({ kind: 'build', hexIndex: village.hexIndex, building });
  return true;
}

function planAttack(state: MatchState, orders: OrderItem[], village: VillageState, purse: Purse, target: VillageState, targeted: Set<number>): void {
  const envoysWanted = envoysNeeded(state, target);
  const raidersWanted = raidersNeeded(state, target, envoysWanted);
  const envoys = village.troops.envoy + trainAffordable(state, orders, village, purse, 'envoy', Math.max(0, envoysWanted - village.troops.envoy));
  const raiders = village.troops.raider + trainAffordable(state, orders, village, purse, 'raider', Math.max(0, raidersWanted - village.troops.raider));
  if (envoys < envoysWanted || raiders < raidersWanted) return;
  targeted.add(target.hexIndex);
  orders.push({ kind: 'march', fromHexIndex: village.hexIndex, toHexIndex: target.hexIndex, troops: { raider: raiders, guard: 0, envoy: envoys } });
}

function firstUntargeted(targets: VillageState[], targeted: Set<number>): VillageState | undefined {
  return targets.find((target) => !targeted.has(target.hexIndex));
}

function ordersFor(state: MatchState, seatId: SeatId, strategy: StrategyName): OrderItem[] {
  const orders: OrderItem[] = [];
  const targeted = new Set([...state.armies.values()].filter((army) => army.owner === seatId && army.status === 'marching').map((army) => army.targetHexIndex));
  const owned = ownedVillagesOf(state, seatId);
  for (const village of owned) {
    const purse: Purse = { ...village.resources };
    if (strategy === 'rusher') {
      const target = firstUntargeted(nearestTargets(state, village, seatId, false), targeted);
      if (target) planAttack(state, orders, village, purse, target, targeted);
      continue;
    }
    if (strategy === 'turtle') {
      buildIfAffordable(state, orders, village, purse, 'wall');
      buildIfAffordable(state, orders, village, purse, village.buildings.farm <= village.buildings.mine ? 'farm' : 'mine');
      trainAffordable(state, orders, village, purse, 'guard', Math.max(0, 12 - village.troops.guard));
      const isRich = purse.grain > 300 && purse.ore > 300;
      const target = isRich ? firstUntargeted(nearestTargets(state, village, seatId, true), targeted) : undefined;
      if (target && hexDistance(state.hexes[village.hexIndex], state.hexes[target.hexIndex]) <= 2) planAttack(state, orders, village, purse, target, targeted);
      continue;
    }
    if (strategy === 'builder') {
      buildIfAffordable(state, orders, village, purse, village.buildings.farm <= village.buildings.mine ? 'farm' : 'mine');
      trainAffordable(state, orders, village, purse, 'guard', Math.max(0, 8 - village.troops.guard));
      const isEconomyBuilt = village.buildings.farm + village.buildings.mine >= 6;
      const target = isEconomyBuilt ? firstUntargeted(nearestTargets(state, village, seatId, false), targeted) : undefined;
      if (target) planAttack(state, orders, village, purse, target, targeted);
      continue;
    }
    const isEarly = state.tick <= 3;
    if (isEarly) buildIfAffordable(state, orders, village, purse, village.buildings.farm <= village.buildings.mine ? 'farm' : 'mine');
    trainAffordable(state, orders, village, purse, 'guard', Math.max(0, 6 - village.troops.guard));
    const barbarian = firstUntargeted(nearestTargets(state, village, seatId, true), targeted);
    const anyone = firstUntargeted(nearestTargets(state, village, seatId, false), targeted);
    const target = barbarian && hexDistance(state.hexes[village.hexIndex], state.hexes[barbarian.hexIndex]) <= 3 ? barbarian : anyone;
    if (target) planAttack(state, orders, village, purse, target, targeted);
  }
  if (state.balance.territory !== null && strategy !== 'village') {
    claimOrdersFor(state, seatId, strategy, owned, orders);
    improvementOrdersFor(state, seatId, strategy, orders);
  }
  return orders.slice(0, 64);
}

const CLAIMS_PER_VILLAGE: Readonly<Record<StrategyName, number>> = Object.freeze({ rusher: 1, builder: 2, turtle: 1, mixed: 3, village: 0 });

function isOpenTile(state: MatchState, hexIndex: number): boolean {
  return state.villages[hexIndex] === null && state.terrain[hexIndex] !== 'mountain' && state.terrain[hexIndex] !== 'lake';
}

function ownsLand(state: MatchState, seatId: SeatId, hexIndex: number): boolean {
  return state.villages[hexIndex]?.owner === seatId || state.territory.get(hexIndex)?.owner === seatId;
}

function neighborIndicesOf(state: MatchState, hexIndex: number): number[] {
  const center = state.hexes[hexIndex];
  return state.hexes.filter((tile) => hexDistance(center, tile) === 1).map((tile) => tile.index);
}

function claimOrdersFor(state: MatchState, seatId: SeatId, strategy: StrategyName, owned: readonly VillageState[], orders: OrderItem[]): void {
  const targeted = new Set([...state.armies.values()].filter((army) => army.owner === seatId && army.status === 'marching').map((army) => army.targetHexIndex));
  const frontier = state.hexes
    .filter((tile) => isOpenTile(state, tile.index) && !ownsLand(state, seatId, tile.index) && !targeted.has(tile.index))
    .filter((tile) => neighborIndicesOf(state, tile.index).some((neighbor) => ownsLand(state, seatId, neighbor)));
  for (const army of state.armies.values()) {
    if (army.owner !== seatId || army.status !== 'standing') continue;
    const tile = state.territory.get(army.currentHexIndex);
    if (tile?.owner !== seatId || tile.improvement === 'outpost') continue;
    const nextTile = frontier.find((candidate) => !targeted.has(candidate.index) && hexDistance(state.hexes[army.currentHexIndex], candidate) === 1);
    const destination = nextTile?.index ?? nearestOwnedVillage(state, seatId, army.currentHexIndex)?.hexIndex;
    if (destination === undefined) continue;
    targeted.add(destination);
    orders.push({ kind: 'march', fromHexIndex: army.currentHexIndex, toHexIndex: destination, troops: { ...army.troops } });
  }
  for (const village of owned) {
    const origin = state.hexes[village.hexIndex];
    const nearby = frontier
      .filter((tile) => !targeted.has(tile.index) && hexDistance(origin, tile) <= 3)
      .sort((left, right) => hexDistance(origin, left) - hexDistance(origin, right));
    let raidersLeft = village.troops.raider;
    for (const tile of nearby.slice(0, CLAIMS_PER_VILLAGE[strategy])) {
      if (raidersLeft < 1) break;
      raidersLeft -= 1;
      targeted.add(tile.index);
      orders.push({ kind: 'march', fromHexIndex: village.hexIndex, toHexIndex: tile.index, troops: { raider: 1, guard: 0, envoy: 0 } });
    }
  }
}

function nearestOwnedVillage(state: MatchState, seatId: SeatId, hexIndex: number): VillageState | undefined {
  const origin = state.hexes[hexIndex];
  return ownedVillagesOf(state, seatId).sort((left, right) => hexDistance(origin, state.hexes[left.hexIndex]) - hexDistance(origin, state.hexes[right.hexIndex]) || left.hexIndex - right.hexIndex)[0];
}

function improvementOrdersFor(state: MatchState, seatId: SeatId, strategy: StrategyName, orders: OrderItem[]): void {
  const rule = state.balance.territory;
  if (rule === null || strategy === 'rusher') return;
  const tiles = [...state.territory.entries()].filter(([, tile]) => tile.owner === seatId);
  const hasWatchtower = tiles.some(([, tile]) => tile.improvement === 'watchtower');
  const outposts = tiles.filter(([, tile]) => tile.improvement === 'outpost').length;
  let buildsLeft = strategy === 'builder' ? 4 : 2;
  for (const [hexIndex, tile] of tiles) {
    if (buildsLeft <= 0) break;
    const payer = nearestOwnedVillage(state, seatId, hexIndex);
    if (!payer) continue;
    const isBesideVillage = hexDistance(state.hexes[hexIndex], state.hexes[payer.hexIndex]) === 1;
    const wanted = tile.improvement
      ?? (strategy === 'turtle' && outposts === 0 && !isBesideVillage ? 'outpost'
        : strategy === 'turtle' && !hasWatchtower ? 'watchtower'
          : isBesideVillage ? 'field'
            : state.terrain[hexIndex] === 'ore' || strategy === 'builder' ? 'quarry' : null);
    if (wanted === null || tile.level >= rule.improvements[wanted].maxLevel) continue;
    orders.push({ kind: 'build', hexIndex, building: wanted });
    buildsLeft -= 1;
    if (wanted === 'outpost' && tile.improvement === 'outpost' && payer.troops.guard > 6) {
      orders.push({ kind: 'march', fromHexIndex: payer.hexIndex, toHexIndex: hexIndex, troops: { raider: 0, guard: 3, envoy: 0 } });
    }
  }
  if (strategy !== 'mixed') return;
  const site = tiles.find(([hexIndex, tile]) => tile.improvement === null
    && state.villages.every((village) => village === null || hexDistance(state.hexes[hexIndex], state.hexes[village.hexIndex]) >= rule.foundSpacing));
  if (!site) return;
  const payer = nearestOwnedVillage(state, seatId, site[0]);
  if (!payer) return;
  if (payer.troops.envoy < rule.foundEnvoys) {
    orders.push({ kind: 'train', hexIndex: payer.hexIndex, troop: 'envoy', count: rule.foundEnvoys - payer.troops.envoy });
    return;
  }
  orders.unshift({ kind: 'found', hexIndex: site[0] });
}

function strategyOfSeat(seatIndex: number, seed: number): StrategyName {
  if (ALL_VILLAGE_SEATS) return 'village';
  return STRATEGIES[(seatIndex + seed) % STRATEGIES.length];
}

function playGame(candidate: Candidate, seatCount: WargamesSeatCount, mapRadius: number, maxTicks: number, seed: number): GameRecord {
  const spec = WargamesMatchSpec.parse({
    version: 1, rulesVersion: candidate.rulesVersion, title: 'sim', seed, mapRadius, maxTicks,
    seats: seatIdsForCount(seatCount).map((seatId) => ({ seatId, label: seatId, setup: { agent: 'claude-code', model: null, options: [], instructions: '' }, modelDisplay: 'bot' })),
  });
  let state = createInitialMatchState(`sim-${seed}`, 0, spec, candidate.balance);
  state = step(state, { type: 'seating_started' });
  for (const seat of state.seats) state = step(state, { type: 'seat_connected', seatId: seat.config.seatId });
  const strategyBySeat = new Map(state.seats.map((seat, index) => [seat.config.seatId, strategyOfSeat(index, seed)]));
  const advance = { type: 'phase_advanced', reason: 'all_submitted', signatures: {} };
  const lastCaptureTurnByHex = new Map<number, number>();
  const pendingBuilds: { hexIndex: number; owner: SeatId; turn: number }[] = [];
  const fellSeats = new Set<SeatId>();
  const cameBackSeats = new Set<SeatId>();
  let captures = 0;
  let flipBacks = 0;
  let buildsJudged = 0;
  let buildsPaidBack = 0;
  let seatsAliveAtMidGame: number = seatCount;
  const leaderByTurn: SeatId[] = [];
  const openLandCount = state.hexes.filter((tile) => isOpenTile(state, tile.index)).length;
  let landFullTurn: number | null = null;
  while (state.status === 'running') {
    const before = state.villages.map((village) => (village ? { owner: village.owner, buildings: { ...village.buildings } } : null));
    state = step(state, advance);
    state = step(state, advance);
    for (const seat of state.seats) {
      if (seat.status !== 'acting') continue;
      const strategy = strategyBySeat.get(seat.config.seatId) ?? 'mixed';
      state = step(state, { type: 'orders_submitted', seatId: seat.config.seatId, orders: ordersFor(state, seat.config.seatId, strategy) });
    }
    state = step(state, advance);
    const turn = state.tick;
    state.villages.forEach((village, hexIndex) => {
      const previous = before[hexIndex];
      if (!village || !previous) return;
      if (village.owner !== previous.owner && village.owner !== null) {
        captures += 1;
        const lastCaptureTurn = lastCaptureTurnByHex.get(hexIndex);
        if (lastCaptureTurn !== undefined && turn - lastCaptureTurn <= FLIP_BACK_WINDOW_TURNS) flipBacks += 1;
        lastCaptureTurnByHex.set(hexIndex, turn);
      }
      const wasBuilt = village.owner === previous.owner && village.owner !== null
        && (village.buildings.farm > previous.buildings.farm || village.buildings.mine > previous.buildings.mine);
      if (wasBuilt && village.owner !== null) pendingBuilds.push({ hexIndex, owner: village.owner, turn });
    });
    for (let index = pendingBuilds.length - 1; index >= 0; index -= 1) {
      const build = pendingBuilds[index];
      const isLost = state.villages[build.hexIndex]?.owner !== build.owner;
      const isPaidBack = turn - build.turn >= BUILD_PAYBACK_TURNS;
      if (!isLost && !isPaidBack) continue;
      buildsJudged += 1;
      if (!isLost) buildsPaidBack += 1;
      pendingBuilds.splice(index, 1);
    }
    for (const seat of state.seats) {
      const villageCount = ownedVillagesOf(state, seat.config.seatId).length;
      if (villageCount <= 1) fellSeats.add(seat.config.seatId);
      if (fellSeats.has(seat.config.seatId) && villageCount >= 3) cameBackSeats.add(seat.config.seatId);
    }
    leaderByTurn.push(standingLeaderOf(state));
    const unclaimedLand = state.hexes.filter((tile) => isOpenTile(state, tile.index) && !state.territory.has(tile.index)).length;
    if (landFullTurn === null && state.balance.territory !== null && unclaimedLand <= openLandCount * 0.05) landFullTurn = turn;
    if (turn === Math.floor(maxTicks / 2)) seatsAliveAtMidGame = state.seats.filter((seat) => ownedVillagesOf(state, seat.config.seatId).length > 0).length;
    if (state.status !== 'running') break;
    state = step(state, advance);
  }
  return {
    winnerStrategy: state.winnerSeatId ? strategyBySeat.get(state.winnerSeatId) ?? null : null,
    winKind: isGoalWin(state) ? 'goal' : 'limit',
    midGameLeaderLost: state.winnerSeatId !== leaderByTurn[Math.floor((leaderByTurn.length - 1) / 2)],
    endTurn: state.tick,
    maxTicks,
    seatsAliveAtMidGame,
    seatCount,
    captures,
    flipBacks,
    seatsThatFell: fellSeats.size,
    seatsThatCameBack: cameBackSeats.size,
    buildsJudged,
    buildsPaidBack,
    landFullTurn,
  };
}

function isGoalWin(state: MatchState): boolean {
  if (state.winnerSeatId === null) return false;
  const pointTarget = victoryPointTargetFor(state.balance, state.spec.mapRadius, state.seats.length);
  if (pointTarget !== null) return state.victoryPointsBySeat[state.winnerSeatId] >= pointTarget;
  const winVillages = victoryVillagesForBalance(state.balance, state.villages.filter((village) => village !== null && !village.isBeacon).length);
  return ownedVillagesOf(state, state.winnerSeatId).length >= winVillages;
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '-' : `${Math.round((part / whole) * 100)}%`;
}

function summarize(candidate: Candidate, sizeName: string, records: GameRecord[]): string {
  const winsByStrategy = STRATEGIES.map((strategy) => `${strategy} ${percent(records.filter((record) => record.winnerStrategy === strategy).length, records.length)}`).join(' ');
  const goalWins = records.filter((record) => record.winKind === 'goal');
  const goalEndTurns = goalWins.map((record) => record.endTurn);
  const aliveShare = records.reduce((sum, record) => sum + record.seatsAliveAtMidGame / record.seatCount, 0) / records.length;
  const captures = records.reduce((sum, record) => sum + record.captures, 0);
  const flipBacks = records.reduce((sum, record) => sum + record.flipBacks, 0);
  const fell = records.reduce((sum, record) => sum + record.seatsThatFell, 0);
  const cameBack = records.reduce((sum, record) => sum + record.seatsThatCameBack, 0);
  const judged = records.reduce((sum, record) => sum + record.buildsJudged, 0);
  const paidBack = records.reduce((sum, record) => sum + record.buildsPaidBack, 0);
  return [
    `| ${candidate.name} | ${sizeName} | ${winsByStrategy}`,
    `goal wins ${percent(goalWins.length, records.length)}, median goal turn ${median(goalEndTurns)} of ${records[0].maxTicks}`,
    `alive at mid ${Math.round(aliveShare * 100)}%`,
    `flip-backs ${percent(flipBacks, captures)} of ${captures} captures`,
    `comebacks ${percent(cameBack, fell)} of ${fell}`,
    `mid-game leader lost ${percent(records.filter((record) => record.midGameLeaderLost).length, records.length)}`,
    `builds paid back ${percent(paidBack, judged)}`,
    `land 95% claimed by turn ${median(records.map((record) => record.landFullTurn ?? record.maxTicks + 1))} |`,
  ].join(' | ');
}

function megabytes(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

function candidatesToRun(): Candidate[] {
  const v5 = wargamesBalanceFor('v5');
  const v6 = wargamesBalanceFor('v6');
  const denseHeldMajority: WargamesBalance = { ...v6, victory: { kind: 'heldShare', share: 0.51, holdTurns: 2 }, sparseSites: null };
  const withoutEconomyPoints: WargamesBalance = v6.victory.kind === 'points' ? { ...v6, victory: { ...v6.victory, economyIncomePerPoint: 0 } } : v6;
  return [
    { name: 'v5 today', rulesVersion: 'v5', balance: v5 },
    { name: 'v6 51% dense', rulesVersion: 'v6', balance: denseHeldMajority },
    { name: 'v6 VP without economy', rulesVersion: 'v6', balance: withoutEconomyPoints },
    { name: 'v6 VP', rulesVersion: 'v6', balance: v6 },
    { name: 'v8 roles', rulesVersion: 'v8', balance: wargamesBalanceFor('v8') },
  ];
}

interface SizeScore {
  topStrategyWinShare: number;
  rusherWinShare: number;
  goalWinShare: number;
  medianGoalTurnShare: number;
  leaderLostShare: number;
  flipBackShare: number;
  buildPaybackShare: number;
}

function scoreSize(records: GameRecord[]): SizeScore {
  const winShares = STRATEGIES.map((strategy) => records.filter((record) => record.winnerStrategy === strategy).length / records.length);
  const goalWins = records.filter((record) => record.winKind === 'goal');
  const captures = records.reduce((sum, record) => sum + record.captures, 0);
  const judged = records.reduce((sum, record) => sum + record.buildsJudged, 0);
  return {
    topStrategyWinShare: Math.max(...winShares),
    rusherWinShare: winShares[STRATEGIES.indexOf('rusher')],
    goalWinShare: goalWins.length / records.length,
    medianGoalTurnShare: goalWins.length === 0 ? 1 : median(goalWins.map((record) => record.endTurn)) / records[0].maxTicks,
    leaderLostShare: records.filter((record) => record.midGameLeaderLost).length / records.length,
    flipBackShare: captures === 0 ? 0 : records.reduce((sum, record) => sum + record.flipBacks, 0) / captures,
    buildPaybackShare: judged === 0 ? 0 : records.reduce((sum, record) => sum + record.buildsPaidBack, 0) / judged,
  };
}

const SEARCH_VILLAGE_SHARE_SCALES = [1, 1.5];
const SEARCH_BEACON_POINTS = [2, 4];
const SEARCH_TARGET_FACTORS = [0.5, 0.65, 0.8];

function scaledTargets(balance: WargamesBalance, targetFactor: number): Record<number, Record<WargamesSeatCount, number>> {
  const targets: Record<number, Record<WargamesSeatCount, number>> = {};
  const beaconPoints = balance.victory.kind === 'points' ? balance.victory.beaconPoints : 0;
  for (const mapSize of WARGAMES_MAP_SIZES) {
    const targetBySeatCount = { 4: 0, 6: 0 };
    for (const seatCount of SEAT_COUNTS) {
      const sample = createInitialMatchState('sample', 0, WargamesMatchSpec.parse({
        version: 1, rulesVersion: 'v6', title: 'sample', seed: SEEDS[0], mapRadius: mapSize.mapRadius, maxTicks: mapSize.maxTicks,
        seats: seatIdsForCount(seatCount).map((seatId) => ({ seatId, label: seatId, setup: { agent: 'claude-code', model: null, options: [], instructions: '' }, modelDisplay: 'bot' })),
      }), balance);
      const villages = sample.villages.filter((village) => village !== null && !village.isBeacon).length;
      const beacons = sample.villages.filter((village) => village?.isBeacon).length;
      targetBySeatCount[seatCount] = Math.round((targetFactor * mapSize.maxTicks * (villages + beacons * beaconPoints)) / seatCount);
    }
    targets[mapSize.mapRadius] = targetBySeatCount;
  }
  return targets;
}

function searchGrid(): Candidate[] {
  const v6 = wargamesBalanceFor('v6');
  const candidates: Candidate[] = [];
  if (v6.victory.kind !== 'points' || v6.sparseSites === null) return candidates;
  for (const villageShareScale of SEARCH_VILLAGE_SHARE_SCALES) {
    for (const beaconPoints of SEARCH_BEACON_POINTS) {
      const villageShareByRadius = Object.fromEntries(Object.entries(v6.sparseSites.villageShareByRadius).map(([radius, share]) => [radius, share * villageShareScale]));
      const mapBalance: WargamesBalance = { ...v6, sparseSites: { ...v6.sparseSites, villageShareByRadius }, victory: { ...v6.victory, beaconPoints } };
      for (const targetFactor of SEARCH_TARGET_FACTORS) {
        const targetByRadius = scaledTargets(mapBalance, targetFactor);
        const balance: WargamesBalance = { ...mapBalance, victory: { ...v6.victory, beaconPoints, targetByRadius } };
        const targetsText = Object.entries(targetByRadius).map(([radius, bySeats]) => `r${radius} ${bySeats[4]}/${bySeats[6]}`).join(' ');
        candidates.push({ name: `villages x${villageShareScale} beacon ${beaconPoints} target ${targetFactor} (${targetsText})`, rulesVersion: 'v6', balance });
      }
    }
  }
  return candidates;
}

function v8Candidates(): Candidate[] {
  return [
    { name: 'v7 VP', rulesVersion: 'v7', balance: wargamesBalanceFor('v7') },
    { name: 'v8 VP', rulesVersion: 'v8', balance: wargamesBalanceFor('v8') },
  ];
}

function v9Candidates(): Candidate[] {
  return [
    { name: 'v8 VP', rulesVersion: 'v8', balance: wargamesBalanceFor('v8') },
    { name: 'v9 land', rulesVersion: 'v9', balance: wargamesBalanceFor('v9') },
  ];
}

const V9_GRID_TILES_PER_POINT = [5, 6, 8];
const V9_GRID_YIELDS = [12, 15, 20];
const V9_GRID_TARGET_SCALES = [0.9, 1, 1.1];

function v9Grid(): Candidate[] {
  const v9 = wargamesBalanceFor('v9');
  const { territory, victory } = v9;
  if (territory === null || victory.kind !== 'points') return [];
  return V9_GRID_TILES_PER_POINT.flatMap((tilesPerPoint) => V9_GRID_YIELDS.flatMap((yieldPerLevel) => V9_GRID_TARGET_SCALES.map((targetScale) => {
    const targetByRadius = Object.fromEntries(Object.entries(victory.targetByRadius).map(([radius, bySeats]) => [radius, { 4: Math.round(bySeats[4] * targetScale), 6: Math.round(bySeats[6] * targetScale) }]));
    const improvements = { ...territory.improvements, field: { ...territory.improvements.field, yieldPerLevel }, quarry: { ...territory.improvements.quarry, yieldPerLevel } };
    return {
      name: `v9 tiles/VP ${tilesPerPoint} yield ${yieldPerLevel} target x${targetScale}`,
      rulesVersion: 'v9' as const,
      balance: { ...v9, victory: { ...victory, targetByRadius }, territory: { ...territory, tilesPerPoint, improvements } },
    };
  })));
}

const V9_TARGET_SCALES = [0.6, 0.7, 0.8, 0.9, 1];

function v9TargetCandidates(): Candidate[] {
  const v9 = wargamesBalanceFor('v9');
  const { victory } = v9;
  if (victory.kind !== 'points') return [];
  return V9_TARGET_SCALES.map((targetScale) => {
    const targetByRadius = Object.fromEntries(Object.entries(victory.targetByRadius).map(([radius, bySeats]) => [radius, { ...bySeats, 4: Math.round(bySeats[4] * targetScale) }]));
    return { name: `v9 4-seat target x${targetScale} (Large ${targetByRadius[6][4]})`, rulesVersion: 'v9' as const, balance: { ...v9, victory: { ...victory, targetByRadius } } };
  });
}

function runSearch(seedCount: number): void {
  const seeds = SEEDS.slice(0, seedCount);
  console.log('candidate | worst top-strategy win | worst rusher win | min goal-win share | goal turn share by size | min leader-lost | worst churn | min payback');
  for (const candidate of searchGrid()) {
    const scores = WARGAMES_MAP_SIZES.map((mapSize) => {
      const records: GameRecord[] = [];
      for (const seatCount of SEAT_COUNTS) {
        for (const seed of seeds) records.push(playGame(candidate, seatCount, mapSize.mapRadius, mapSize.maxTicks, seed));
      }
      return scoreSize(records);
    });
    const round = (value: number) => Math.round(value * 100);
    console.log([
      candidate.name,
      round(Math.max(...scores.map((score) => score.topStrategyWinShare))),
      round(Math.max(...scores.map((score) => score.rusherWinShare))),
      round(Math.min(...scores.map((score) => score.goalWinShare))),
      scores.map((score) => round(score.medianGoalTurnShare)).join('/'),
      round(Math.min(...scores.map((score) => score.leaderLostShare))),
      round(Math.max(...scores.map((score) => score.flipBackShare))),
      round(Math.min(...scores.map((score) => score.buildPaybackShare))),
    ].join(' | '));
  }
}

const COALITION_SEEDS = Array.from({ length: 400 }, (_, index) => 7919 * (index + 1));
const COALITION_BUDGET_MIN = 600;
const COALITION_BUDGET_MAX = 1200;
const COALITION_WALL_SHARE_MAX = 0.45;
const COALITION_ENVOYS_MIN = 4;
const COALITION_ENVOYS_MAX = 6;
const SOLO_CAPTURE_CEILING = 0.2;
const PAIR_CAPTURE_FLOOR = 0.6;

interface CoalitionRow {
  name: string;
  allyBudgetShare: number | null;
}

const COALITION_ROWS: readonly CoalitionRow[] = [
  { name: 'one seat alone (B)', allyBudgetShare: null },
  { name: 'two allies (B + B)', allyBudgetShare: 1 },
  { name: 'two allies (B + B/2)', allyBudgetShare: 0.5 },
];

function seededRandom(seed: number): () => number {
  let rngState = seed | 0;
  return () => {
    rngState = (rngState + 0x6d2b79f5) | 0;
    let mixed = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function totalCostOf(cost: { grain: number; ore: number }): number {
  return cost.grain + cost.ore;
}

function unitsWithin(budget: number, cost: { grain: number; ore: number }): number {
  return Math.max(0, Math.floor(budget / totalCostOf(cost)));
}

function marchingArmyAt(id: string, owner: SeatId, hexIndex: number, troops: TroopCounts, supporting?: SeatId): Parameters<MatchState['armies']['set']>[1] {
  return {
    id, owner, status: 'marching', originHexIndex: hexIndex, currentHexIndex: hexIndex, targetHexIndex: hexIndex,
    troops, departedTick: 0, intendedTargetOwner: 's3', scoutedBy: [], ...(supporting === undefined ? {} : { supporting }),
  };
}

function garrisonWithinFarmRoom(state: MatchState, village: VillageState, budget: number): void {
  const roles = state.balance.roles;
  if (roles === null) throw new Error('the coalition scenario needs v8 roles');
  const guardCost = totalCostOf(roles.units.guard.cost);
  const farmCost = totalCostOf(state.balance.buildingCosts.farm);
  let best = { farm: village.buildings.farm, guards: 0 };
  for (let extraFarmLevels = 0; village.buildings.farm + extraFarmLevels <= 10; extraFarmLevels += 1) {
    const farm = village.buildings.farm + extraFarmLevels;
    const affordable = unitsWithin(budget - extraFarmLevels * farmCost, roles.units.guard.cost);
    const guards = Math.min(affordable, roles.troopCapBase + roles.troopCapPerFarmLevel * farm);
    if (guards > best.guards) best = { farm, guards };
    if (affordable * guardCost < farmCost) break;
  }
  village.buildings.farm = best.farm;
  village.troops.guard = best.guards;
}

function playCoalitionRaid(row: CoalitionRow, seed: number): boolean {
  const random = seededRandom(seed);
  const spec = WargamesMatchSpec.parse({
    version: 1, rulesVersion: 'v9', title: 'coalition', seed, mapRadius: 6, maxTicks: 40,
    seats: seatIdsForCount(4).map((seatId) => ({ seatId, label: seatId, setup: { agent: 'claude-code', model: null, options: [], instructions: '' }, modelDisplay: 'bot' })),
  });
  let state = createInitialMatchState(`coalition-${seed}`, 0, spec);
  const costs = troopCostsFor(state.balance);
  const wallCost = totalCostOf(state.balance.buildingCosts.wall);
  const budget = COALITION_BUDGET_MIN + Math.floor(random() * (COALITION_BUDGET_MAX - COALITION_BUDGET_MIN + 1));
  const target = state.villages.find((village): village is VillageState => village !== null && village.owner === null && !village.isBeacon && state.terrain[village.hexIndex] === 'plain');
  if (!target) throw new Error(`seed ${seed}: no plain barbarian village to defend`);
  const wallLevels = Math.min(10, Math.floor(random() * (Math.floor((budget * COALITION_WALL_SHARE_MAX) / wallCost) + 1)));
  target.owner = 's3';
  target.loyalty = 100;
  target.buildings.wall = wallLevels;
  target.troops = { raider: 0, guard: 0, envoy: 0 };
  garrisonWithinFarmRoom(state, target, budget - wallLevels * wallCost);
  const envoys = COALITION_ENVOYS_MIN + Math.floor(random() * (COALITION_ENVOYS_MAX - COALITION_ENVOYS_MIN + 1));
  const leadRaiders = unitsWithin(budget - envoys * totalCostOf(costs.envoy), costs.raider);
  state.armies.set('lead-clear', marchingArmyAt('lead-clear', 's1', target.hexIndex, { raider: leadRaiders, guard: 0, envoy: 0 }));
  state.armies.set('lead-wave', marchingArmyAt('lead-wave', 's1', target.hexIndex, { raider: 0, guard: 0, envoy: envoys }));
  if (row.allyBudgetShare !== null) {
    state.contracts.set('ally', {
      id: 'ally', proposer: 's1', counterparty: 's2',
      terms: { kind: 'alliance', counterparty: 's2', durationTicks: 10, collateral: { grain: 0, ore: 0 } },
      status: 'active', proposedTick: 0, activatedTick: 0, endTick: 10, breachedBy: null, breachedTick: null,
    });
    const allyRaiders = unitsWithin(budget * row.allyBudgetShare, costs.raider);
    state.armies.set('ally-clear', marchingArmyAt('ally-clear', 's2', target.hexIndex, { raider: allyRaiders, guard: 0, envoy: 0 }, 's1'));
  }
  state = step(state, { type: 'seating_started' });
  for (const seat of state.seats) state = step(state, { type: 'seat_connected', seatId: seat.config.seatId });
  state = step(state, { type: 'phase_advanced', reason: 'deadline', signatures: {} });
  state = step(state, { type: 'phase_advanced', reason: 'deadline', signatures: {} });
  state = step(state, { type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
  return state.villages[target.hexIndex]?.owner === 's1';
}

function runCoalition(shouldAssert: boolean): void {
  console.log(`Equal budget B per seat (${COALITION_BUDGET_MIN} to ${COALITION_BUDGET_MAX} grain+ore, ${COALITION_SEEDS.length} seeds): defender B in wall, farm room and guards, attackers B each in raiders, lead adds ${COALITION_ENVOYS_MIN} to ${COALITION_ENVOYS_MAX} envoys as a capture wave`);
  console.log('| Attack | Captured |');
  console.log('|---|---|');
  const captureRateByRow = new Map<string, number>();
  for (const row of COALITION_ROWS) {
    const captures = COALITION_SEEDS.filter((seed) => playCoalitionRaid(row, seed)).length;
    const captureRate = captures / COALITION_SEEDS.length;
    captureRateByRow.set(row.name, captureRate);
    console.log(`| ${row.name} | ${percent(captures, COALITION_SEEDS.length)} |`);
  }
  if (!shouldAssert) return;
  const soloRate = captureRateByRow.get(COALITION_ROWS[0].name) ?? 1;
  const pairRate = captureRateByRow.get(COALITION_ROWS[1].name) ?? 0;
  if (soloRate < SOLO_CAPTURE_CEILING && pairRate > PAIR_CAPTURE_FLOOR) return;
  console.error(`coalition targets missed: solo ${soloRate} (needs under ${SOLO_CAPTURE_CEILING}), pair ${pairRate} (needs over ${PAIR_CAPTURE_FLOOR})`);
  process.exitCode = 1;
}

function main(): void {
  if (process.argv.includes('--coalition')) {
    runCoalition(process.argv.includes('--assert'));
    return;
  }
  const searchSeeds = process.argv.find((argument) => argument.startsWith('--search='))?.slice('--search='.length);
  if (searchSeeds !== undefined) {
    runSearch(Number(searchSeeds));
    return;
  }
  const onlyCandidate = process.argv.find((argument) => argument.startsWith('--only='))?.slice('--only='.length);
  const versionCandidates = process.argv.includes('--v9-targets') ? v9TargetCandidates() : process.argv.includes('--v9-grid') ? v9Grid() : process.argv.includes('--v9') ? v9Candidates() : process.argv.includes('--v8') ? v8Candidates() : candidatesToRun();
  const candidates = versionCandidates.filter((candidate) => onlyCandidate === undefined || candidate.name.startsWith(onlyCandidate));
  const onlySeats = process.argv.find((argument) => argument.startsWith('--seats='))?.slice('--seats='.length);
  const seedCount = Number(process.argv.find((argument) => argument.startsWith('--seeds='))?.slice('--seeds='.length) ?? SEEDS.length);
  const seedsToRun = Array.from({ length: seedCount }, (_, index) => 101 * (index + 1));
  const onlySize = process.argv.find((argument) => argument.startsWith('--size='))?.slice('--size='.length);
  const seatCountsToRun = SEAT_COUNTS.filter((seatCount) => onlySeats === undefined || String(seatCount) === onlySeats);
  console.log('| Rules | Size | Win rate by strategy | Goal win | Alive mid-game | Churn | Comeback | Mid-game leader lost | Build payback |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const candidate of candidates) {
    for (const mapSize of WARGAMES_MAP_SIZES.filter((size) => onlySize === undefined || size.name === onlySize)) {
      const startedAt = performance.now();
      const records: GameRecord[] = [];
      for (const seatCount of seatCountsToRun) {
        for (const seed of seedsToRun) records.push(playGame(candidate, seatCount, mapSize.mapRadius, mapSize.maxTicks, seed));
      }
      console.log(summarize(candidate, mapSize.name, records));
      const { heapUsed, rss } = process.memoryUsage();
      console.error(`${candidate.name} ${mapSize.name}: ${records.length} games in ${(performance.now() - startedAt).toFixed(0)} ms, heap ${megabytes(heapUsed)}, rss ${megabytes(rss)}`);
    }
  }
}

main();
