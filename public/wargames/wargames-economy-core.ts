import type { SeatId, WargamesEvent } from '#shared/contracts/wargames.ts';
import { applyEvent, createInitialMatchState, villageYieldOf, warehouseCapOf } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';

export type GrowthMode = 'build' | 'capture' | 'mixed' | 'none';

export interface SeatEconomy {
  readonly seatId: SeatId;
  readonly villages: number;
  readonly grainIncome: number;
  readonly oreIncome: number;
  readonly grain: number;
  readonly ore: number;
  readonly warehouseCap: number;
  readonly farm: number;
  readonly mine: number;
  readonly wall: number;
  readonly garrison: number;
  readonly field: number;
  readonly levelsBuilt: number;
  readonly levelsTaken: number;
}

export interface EconomyTurn {
  readonly tick: number;
  readonly seats: readonly SeatEconomy[];
}

interface VillageHolding {
  readonly owner: SeatId | null;
  readonly levels: number;
}

export interface EconomyTimeline {
  readonly firstEvent: WargamesEvent | null;
  readonly appliedEventCount: number;
  readonly cursorState: MatchState | null;
  readonly closedTurns: readonly EconomyTurn[];
  readonly holdingsAtLastClose: readonly (VillageHolding | null)[];
  readonly growthAtLastClose: ReadonlyMap<SeatId, { built: number; taken: number }>;
  readonly turns: readonly EconomyTurn[];
}

export const EMPTY_ECONOMY_TIMELINE: EconomyTimeline = {
  firstEvent: null,
  appliedEventCount: 0,
  cursorState: null,
  closedTurns: [],
  holdingsAtLastClose: [],
  growthAtLastClose: new Map(),
  turns: [],
};

function holdingsOf(state: MatchState): (VillageHolding | null)[] {
  return state.villages.map((village) => {
    if (!village) return null;
    const { farm, mine, barracks, wall } = village.buildings;
    return { owner: village.owner, levels: farm + mine + barracks + wall };
  });
}

function growthSince(
  state: MatchState,
  previousHoldings: readonly (VillageHolding | null)[],
  previousGrowth: ReadonlyMap<SeatId, { built: number; taken: number }>,
): Map<SeatId, { built: number; taken: number }> {
  const growthBySeat = new Map<SeatId, { built: number; taken: number }>();
  for (const seat of state.seats) {
    const carried = previousGrowth.get(seat.config.seatId) ?? { built: 0, taken: 0 };
    growthBySeat.set(seat.config.seatId, { ...carried });
  }
  const currentHoldings = holdingsOf(state);
  for (let hexIndex = 0; hexIndex < currentHoldings.length; hexIndex += 1) {
    const current = currentHoldings[hexIndex];
    if (!current || current.owner === null) continue;
    const growth = growthBySeat.get(current.owner);
    if (!growth) continue;
    const previous = previousHoldings[hexIndex] ?? null;
    if (previous === null || previous.owner !== current.owner) {
      growth.taken += current.levels;
      continue;
    }
    growth.built += Math.max(0, current.levels - previous.levels);
  }
  return growthBySeat;
}

function summarizeTurn(state: MatchState, growthBySeat: ReadonlyMap<SeatId, { built: number; taken: number }>): EconomyTurn {
  const seats = state.seats.map((seat): SeatEconomy => {
    const seatId = seat.config.seatId;
    const totals = { villages: 0, grainIncome: 0, oreIncome: 0, grain: 0, ore: 0, warehouseCap: 0, farm: 0, mine: 0, wall: 0, garrison: 0, field: 0 };
    for (const village of state.villages) {
      if (!village || village.owner !== seatId) continue;
      totals.villages += 1;
      totals.grain += village.resources.grain;
      totals.ore += village.resources.ore;
      totals.warehouseCap += warehouseCapOf(village);
      totals.farm += village.buildings.farm;
      totals.mine += village.buildings.mine;
      totals.wall += village.buildings.wall;
      totals.garrison += village.troops.raider + village.troops.guard + village.troops.envoy;
      if (village.productionState !== 'producing') continue;
      const villageYield = villageYieldOf(village);
      totals.grainIncome += villageYield.grain;
      totals.oreIncome += villageYield.ore;
    }
    for (const army of state.armies.values()) {
      if (army.owner !== seatId || (army.status !== 'marching' && army.status !== 'returning')) continue;
      totals.field += army.troops.raider + army.troops.guard + army.troops.envoy;
    }
    const growth = growthBySeat.get(seatId) ?? { built: 0, taken: 0 };
    return { seatId, ...totals, levelsBuilt: growth.built, levelsTaken: growth.taken };
  });
  return { tick: state.tick, seats };
}

function startTimeline(firstEvent: WargamesEvent): EconomyTimeline | null {
  if (firstEvent.type !== 'match_created') return null;
  const initialState = createInitialMatchState(firstEvent.matchId, firstEvent.createdAtMs, firstEvent.spec);
  return {
    firstEvent,
    appliedEventCount: 1,
    cursorState: initialState,
    closedTurns: [],
    holdingsAtLastClose: holdingsOf(initialState),
    growthAtLastClose: new Map(),
    turns: [],
  };
}

export function extendEconomyTimeline(previous: EconomyTimeline, events: readonly WargamesEvent[]): EconomyTimeline {
  if (events.length === 0) return EMPTY_ECONOMY_TIMELINE;
  const isSameLog = previous.firstEvent === events[0] && previous.appliedEventCount <= events.length;
  const started = isSameLog ? previous : startTimeline(events[0]);
  if (!started || !started.cursorState) return EMPTY_ECONOMY_TIMELINE;
  if (isSameLog && started.appliedEventCount === events.length) return started;

  let cursorState = started.cursorState;
  const closedTurns = [...started.closedTurns];
  let holdingsAtLastClose = started.holdingsAtLastClose;
  let growthAtLastClose = started.growthAtLastClose;
  for (let index = started.appliedEventCount; index < events.length; index += 1) {
    const outcome = applyEvent(cursorState, events[index]);
    if (!outcome.ok) continue;
    const isTurnClosing = cursorState.tick >= 1 && outcome.state.tick > cursorState.tick;
    if (isTurnClosing) {
      growthAtLastClose = growthSince(cursorState, holdingsAtLastClose, growthAtLastClose);
      holdingsAtLastClose = holdingsOf(cursorState);
      closedTurns.push(summarizeTurn(cursorState, growthAtLastClose));
    }
    cursorState = outcome.state;
  }

  const turns = cursorState.tick >= 1
    ? [...closedTurns, summarizeTurn(cursorState, growthSince(cursorState, holdingsAtLastClose, growthAtLastClose))]
    : closedTurns;
  return {
    firstEvent: events[0],
    appliedEventCount: events.length,
    cursorState,
    closedTurns,
    holdingsAtLastClose,
    growthAtLastClose,
    turns,
  };
}

export function growthModeOf(seat: Pick<SeatEconomy, 'levelsBuilt' | 'levelsTaken'>): GrowthMode {
  if (seat.levelsBuilt === 0 && seat.levelsTaken === 0) return 'none';
  if (seat.levelsTaken > seat.levelsBuilt) return 'capture';
  if (seat.levelsBuilt > seat.levelsTaken) return 'build';
  return 'mixed';
}

export function totalIncomeOf(seat: Pick<SeatEconomy, 'grainIncome' | 'oreIncome'>): number {
  return seat.grainIncome + seat.oreIncome;
}
