import './helpers/isolate-home.ts';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  WARGAMES_BALANCE,
  WARGAMES_RULES_ID,
  WARGAMES_SEAT_IDS,
  WargamesEvent as WargamesEventSchema,
  WargamesMatchSpec,
} from '../shared/contracts/wargames.ts';
import type { WargamesEvent } from '../shared/contracts/wargames.ts';
import {
  applyEvent,
  createInitialMatchState,
  projectSeatState,
  territoryCountOf,
  villageIncomeOf,
  replayMatch,
  replayMatchAtTick,
} from '../shared/wargames/engine.ts';
import { widthRuleViolations } from '../shared/wargames/terrain.ts';
import {
  transitionArmy,
  transitionMatch,
  transitionSeat,
  transitionTick,
  transitionVillage,
} from '../shared/wargames/machines.ts';
import { EMPTY_ECONOMY_TIMELINE, economyTurnsAt, extendEconomyTimeline } from '../public/wargames/wargames-economy-core.ts';
import { applyWargamesEvents, displayedMatchState, seekReplayTurn, selectWatchedMatch } from '../public/wargames/wargames-store.ts';
import { analyzeMatch, betrayalsOf, computeEloFromSummaries, summarizeMatch } from '../shared/wargames/analytics.ts';

function buildTestSpec(seed = 424242): WargamesMatchSpec {
  const models = ['claude-opus-4-6', 'gpt-5.3-codex', 'kimi-k2.5', 'gemini-2.5-pro', 'claude-sonnet-4-6', 'o3'];
  return WargamesMatchSpec.parse({
    version: 1,
    title: 'Test Match',
    seed,
    tickDeadlineSeconds: 60,
    maxTicks: 40,
    seats: WARGAMES_SEAT_IDS.map((seatId, index) => ({
      seatId,
      label: `Seat ${index + 1}`,
      controllerKind: 'local-agent',
      setup: { agent: 'claude-code', model: models[index], options: [], instructions: '' },
      modelDisplay: models[index],
    })),
  });
}

function appendAndApply(log: WargamesEvent[], state: ReturnType<typeof createInitialMatchState>, event: WargamesEvent) {
  const outcome = applyEvent(state, event);
  assert.equal(outcome.ok, true, outcome.ok ? '' : `unexpected rejection: ${outcome.rejection.code} ${outcome.rejection.message}`);
  log.push(event);
  return outcome.state;
}

test('state machines reject disallowed transitions with typed codes', () => {
  assert.equal(transitionMatch('lobby', 'all_seats_connected').ok, false);
  assert.equal(transitionTick('talk', 'resolution_complete').ok, false);
  assert.equal(transitionSeat('disconnected', 'seat_submit').ok, false);
  assert.equal(transitionVillage('barren', 'outer_ring_squeeze').ok, false);
  assert.equal(transitionArmy('home', 'army_depart').ok, false);
});

type EventWithoutSeq<Event> = Event extends WargamesEvent ? Omit<Event, 'seq'> : never;

function present<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== null && value !== undefined);
  return value;
}

function advanceToResolution(state: ReturnType<typeof createInitialMatchState>, tickOverride?: number) {
  let current = state;
  const applyNext = (event: EventWithoutSeq<WargamesEvent>) => {
    const applied = applyEvent(current, { ...event, seq: current.lastSeq + 1 } as WargamesEvent);
    assert.equal(applied.ok, true);
    if (applied.ok) current = applied.state;
  };
  applyNext({ type: 'seating_started' });
  for (const seatId of WARGAMES_SEAT_IDS) applyNext({ type: 'seat_connected', seatId });
  if (tickOverride !== undefined) current.tick = tickOverride;
  applyNext({ type: 'phase_advanced', reason: 'deadline' });
  applyNext({ type: 'phase_advanced', reason: 'all_submitted' });
  return current;
}

test('4-seat matches seat s1 to s4 on an even map, refuse other seat sets, and refuse seats outside the match', () => {
  const sixSeatSpec = buildTestSpec();
  const fourSeatInput = { ...sixSeatSpec, seats: sixSeatSpec.seats.slice(0, 4) };
  assert.equal(WargamesMatchSpec.safeParse({ ...fourSeatInput, seats: sixSeatSpec.seats.slice(0, 5) }).success, false);
  assert.equal(WargamesMatchSpec.safeParse({ ...fourSeatInput, seats: [...sixSeatSpec.seats.slice(0, 3), sixSeatSpec.seats[4]] }).success, false);

  for (const mapRadius of [4, 6, 8]) {
    const spec = WargamesMatchSpec.parse({ ...fourSeatInput, mapRadius });
    const state = createInitialMatchState(`wg-four-r${mapRadius}`, 1000, spec);
    assert.deepEqual(state.seats.map((seat) => seat.config.seatId), ['s1', 's2', 's3', 's4']);
    const nearbyBarbariansBySeat = state.seats.map((seat) => {
      const homeTiles = state.villages.flatMap((village) => (village?.owner === seat.config.seatId ? [state.hexes[village.hexIndex]] : []));
      assert.equal(homeTiles.length, 3);
      return state.villages.filter((village) => village !== null && village.owner === null && homeTiles.some((home) => {
        const tile = state.hexes[village.hexIndex];
        return Math.max(Math.abs(home.q - tile.q), Math.abs(home.r - tile.r), Math.abs(home.q + home.r - tile.q - tile.r)) <= 2;
      })).length;
    });
    assert.equal(new Set(nearbyBarbariansBySeat).size, 1);
  }

  const fourSeatPlaySpec = WargamesMatchSpec.parse({ ...fourSeatInput, mapRadius: 6 });
  const log: WargamesEvent[] = [{ seq: 0, type: 'match_created', matchId: 'wg-four-play', createdAtMs: 1000, spec: fourSeatPlaySpec }];
  let state = createInitialMatchState('wg-four-play', 1000, fourSeatPlaySpec);
  let seq = 0;
  const nextSeq = () => { seq += 1; return seq; };
  const advance = (): WargamesEvent => ({ seq: nextSeq(), type: 'phase_advanced', reason: 'all_submitted' });
  state = appendAndApply(log, state, { seq: nextSeq(), type: 'seating_started' });
  for (const seatId of ['s1', 's2', 's3', 's4'] as const) {
    state = appendAndApply(log, state, { seq: nextSeq(), type: 'seat_connected', seatId });
  }
  assert.equal(state.status, 'running');

  const outsideSender = applyEvent(state, { seq: seq + 1, type: 'note_written', seatId: 's5', text: 'hi' });
  assert.equal(outsideSender.ok ? null : outsideSender.rejection.code, 'unauthorized_seat');
  const outsideRecipient = applyEvent(state, { seq: seq + 1, type: 'message_sent', seatId: 's1', to: 's6', channel: 'dm', text: 'hi' });
  assert.equal(outsideRecipient.ok ? null : outsideRecipient.rejection.code, 'invalid_target');

  state = appendAndApply(log, state, { seq: nextSeq(), type: 'message_sent', seatId: 's1', to: 's2', channel: 'dm', text: 'We are friends' });
  state = appendAndApply(log, state, advance());

  const s1Home = state.villages.find((village) => village?.owner === 's1');
  const s1Target = state.villages.find((village) => village !== null && village.owner === null);
  assert.ok(s1Home && s1Target);
  state = appendAndApply(log, state, {
    seq: nextSeq(),
    type: 'orders_submitted',
    seatId: 's1',
    orders: [
      { kind: 'march', fromHexIndex: s1Home.hexIndex, toHexIndex: s1Target.hexIndex, troops: { raider: 3, guard: 0, envoy: 0 } },
      { kind: 'march', fromHexIndex: s1Home.hexIndex, toHexIndex: present(state.villages.find((village) => village?.owner === 's2')).hexIndex, troops: { raider: 1, guard: 0, envoy: 0 } },
    ],
  });
  for (const seatId of ['s2', 's3', 's4'] as const) {
    state = appendAndApply(log, state, { seq: nextSeq(), type: 'orders_submitted', seatId, orders: [] });
  }
  state = appendAndApply(log, state, advance());
  state = appendAndApply(log, state, advance());
  assert.equal(state.tick, 2);
  assert.equal([...state.armies.values()].filter((army) => army.owner === 's1').length, 2);

  const summary = summarizeMatch(state, null, log.length + 1);
  assert.deepEqual(summary.seats.map((seat) => seat.seatId), ['s1', 's2', 's3', 's4']);
  const analytics = analyzeMatch(state);
  assert.deepEqual(analytics.highlights.map((highlight) => [highlight.kind, highlight.actor, highlight.target, highlight.relatedDmText]), [['betrayal', 's1', 's2', 'We are friends']]);
  assert.deepEqual(analytics.seats.map((seat) => seat.betrayals), [1, 0, 0, 0]);

  assert.deepEqual(replayMatch(log), state);
  const economyFromFullLog = extendEconomyTimeline(EMPTY_ECONOMY_TIMELINE, log);
  const turnEndEventCountByTick: number[] = [];
  let walkedState = replayMatch(log.slice(0, 1));
  for (let index = 1; index < log.length; index += 1) {
    const walked = applyEvent(walkedState, log[index]);
    assert.ok(walked.ok);
    if (walked.state.tick > walkedState.tick) turnEndEventCountByTick[walkedState.tick] = index;
    walkedState = walked.state;
  }
  selectWatchedMatch(state.matchId, 'turn-one');
  applyWargamesEvents({ matchId: state.matchId, events: log, reset: true, phaseClock: null });
  assert.deepEqual(displayedMatchState(), state);
  for (let tick = 1; tick <= state.tick; tick += 1) {
    seekReplayTurn(tick);
    const loggedState = replayMatchAtTick(log, tick);
    assert.deepEqual(displayedMatchState(), loggedState);
    const economyAtTurnEnd = extendEconomyTimeline(EMPTY_ECONOMY_TIMELINE, log.slice(0, turnEndEventCountByTick[tick] ?? log.length));
    assert.deepEqual(economyTurnsAt(economyFromFullLog, loggedState), economyAtTurnEnd.turns);
  }
  selectWatchedMatch(null);

  const finishedSummary = { ...summary, status: 'finished' as const, winnerSeatId: 's1' as const, winnerModelDisplay: summary.seats[0].modelDisplay };
  const elo = computeEloFromSummaries([finishedSummary]);
  assert.equal(elo[0].modelDisplay, summary.seats[0].modelDisplay);
  assert.ok(elo[0].elo > 1500);
});

test('terrain on Large and Huge is seeded, the same around every seat, never under a village and in seat vision, while Standard stays plain', () => {
  {
    for (const [seatCount, mapRadius] of [[4, 6], [4, 8], [6, 6], [6, 8]] as const) {
      const spec = WargamesMatchSpec.parse({ ...buildTestSpec(777001), mapRadius, seats: buildTestSpec().seats.slice(0, seatCount) });
      const state = createInitialMatchState(`wg-terrain-${seatCount}-${mapRadius}`, 1000, spec);
      assert.deepEqual(createInitialMatchState('again', 0, spec).terrain, state.terrain);
      assert.ok(state.terrain.some((kind) => kind === 'mountain' || kind === 'lake'));
      const isBlocked = (hexIndex: number) => state.terrain[hexIndex] === 'mountain' || state.terrain[hexIndex] === 'lake';
      assert.equal(state.villages.some((village) => village !== null && isBlocked(village.hexIndex)), false);
      const blockedNearSeat = state.seats.map((seat) => {
        const homes = state.villages.flatMap((village) => (village?.owner === seat.config.seatId ? [state.hexes[village.hexIndex]] : []));
        return state.hexes.filter((tile) => isBlocked(tile.index) && homes.some((home) => Math.max(Math.abs(home.q - tile.q), Math.abs(home.r - tile.r), Math.abs(home.q + home.r - tile.q - tile.r)) <= 4)).length;
      });
      assert.equal(new Set(blockedNearSeat).size, 1);
      assert.equal(projectSeatState(state, 's1').terrain.length, state.terrain.filter((kind) => kind !== 'plain').length);
      assert.equal(widthRuleViolations(state.hexes, state.terrain), 0);
    }
  }
  const standard = createInitialMatchState('wg-standard', 0, WargamesMatchSpec.parse({ ...buildTestSpec(), mapRadius: 4 }));
  assert.equal(standard.terrain.every((kind) => kind === 'plain'), true);
});

test('a lone raid bounces off a guarded wall, but one seat can clear it and another seat\'s envoy-only wave takes it next turn despite the wall', () => {
  type Troops = { raider: number; guard: number; envoy: number };
  const state = createInitialMatchState('wg-sequential-raid', 1000, { ...buildTestSpec() });
  const target = present(state.villages.find((village) => village && village.owner === null && !village.isBeacon));
  Object.assign(target, { owner: 's3', troops: { raider: 0, guard: 20, envoy: 0 } });
  target.buildings.wall = 3;
  const marchOn = (current: typeof state, owner: 's1' | 's2', armyId: string, troops: Troops) => current.armies.set(armyId, {
    id: armyId, owner, status: 'marching', originHexIndex: target.hexIndex, currentHexIndex: target.hexIndex, targetHexIndex: target.hexIndex,
    troops, departedTick: current.tick, scoutedBy: [],
  });
  const nextTurn = (current: typeof state) => {
    let next = current;
    for (const reason of ['all_submitted', 'deadline', 'all_submitted'] as const) {
      const outcome = applyEvent(next, { seq: next.lastSeq + 1, type: 'phase_advanced', reason });
      assert.equal(outcome.ok, true);
      if (outcome.ok) next = outcome.state;
    }
    return next;
  };

  const loneState = structuredClone(state);
  marchOn(loneState, 's1', 'lone-clear', { raider: 20, guard: 0, envoy: 0 });
  marchOn(loneState, 's1', 'lone-wave', { raider: 0, guard: 0, envoy: 6 });
  const lone = advanceToResolution(loneState);
  assert.equal(lone.villages[target.hexIndex]?.owner, 's3');
  assert.equal(lone.villages[target.hexIndex]?.buildings.wall, 3);
  assert.equal(lone.armies.get('lone-wave')?.status, 'destroyed');

  marchOn(state, 's1', 'clear', { raider: 40, guard: 0, envoy: 0 });
  const cleared = advanceToResolution(state);
  const clearedVillage = present(cleared.villages[target.hexIndex]);
  assert.deepEqual([clearedVillage.owner, clearedVillage.troops.guard], ['s3', 0]);
  assert.ok(clearedVillage.buildings.wall > 0 && clearedVillage.buildings.wall < 3);
  marchOn(cleared, 's2', 'wave', { raider: 0, guard: 0, envoy: 6 });
  const captured = nextTurn(cleared);
  assert.equal(captured.villages[target.hexIndex]?.owner, 's2');
});

test('v9 starts villages with their land ring, claims land as a front with land reports, builds improvements paid by the nearest village, halves them on capture, founds villages and scores territory VP', () => {
  const spec = WargamesMatchSpec.parse({ ...buildTestSpec(), mapRadius: 6, seats: buildTestSpec().seats.slice(0, 4) });
  let state = createInitialMatchState('wg-v9-land', 1000, spec);
  const apply = (event: Record<string, unknown>) => {
    const outcome = applyEvent(state, { ...event, seq: state.lastSeq + 1 } as WargamesEvent);
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.rejection.message);
    if (outcome.ok) state = outcome.state;
  };
  apply({ type: 'seating_started' });
  for (const seat of state.seats) apply({ type: 'seat_connected', seatId: seat.config.seatId });
  const playTurn = (ordersBySeat: Partial<Record<'s1' | 's2' | 's3' | 's4', unknown[]>>) => {
    apply({ type: 'phase_advanced', reason: 'all_submitted' });
    for (const seat of state.seats) apply({ type: 'orders_submitted', seatId: seat.config.seatId, orders: ordersBySeat[seat.config.seatId as 's1'] ?? [] });
    apply({ type: 'phase_advanced', reason: 'all_submitted' });
    apply({ type: 'phase_advanced', reason: 'all_submitted' });
  };
  const home = present(state.villages.find((village) => village?.owner === 's1'));
  const homeVillage = () => present(state.villages[home.hexIndex]);
  const distanceBetween = (first: number, second: number) => {
    const [from, to] = [state.hexes[first], state.hexes[second]];
    return Math.max(Math.abs(from.q - to.q), Math.abs(from.r - to.r), Math.abs(from.q + from.r - to.q - to.r));
  };
  const isOpenLand = (hexIndex: number) => state.villages[hexIndex] === null && state.terrain[hexIndex] !== 'mountain' && state.terrain[hexIndex] !== 'lake';
  const neighborsOf = (hexIndex: number) => state.hexes.filter((tile) => distanceBetween(hexIndex, tile.index) === 1).map((tile) => tile.index);
  const [fieldHex, outpostHex] = neighborsOf(home.hexIndex).filter(isOpenLand);
  assert.ok(fieldHex !== undefined && outpostHex !== undefined);
  for (const village of state.villages) {
    if (village === null) continue;
    const ringOwner = village.owner !== null && !village.isBeacon ? village.owner : undefined;
    for (const hexIndex of neighborsOf(village.hexIndex).filter(isOpenLand)) {
      if (ringOwner !== undefined) assert.equal(state.territory.get(hexIndex)?.owner, ringOwner);
    }
  }
  const touchesS1Land = (hexIndex: number) => neighborsOf(hexIndex).some((neighbor) => state.territory.get(neighbor)?.owner === 's1' || state.villages[neighbor]?.owner === 's1');
  const frontierHex = present(state.hexes.find((tile) => isOpenLand(tile.index) && !state.territory.has(tile.index) && distanceBetween(home.hexIndex, tile.index) === 2 && touchesS1Land(tile.index))).index;
  const farHex = present(state.hexes.find((tile) => isOpenLand(tile.index) && !state.territory.has(tile.index) && distanceBetween(home.hexIndex, tile.index) === 3 && !touchesS1Land(tile.index))).index;
  const s1LandView = projectSeatState(state, 's1').yourLand;
  assert.equal(s1LandView?.hexes, territoryCountOf(state, 's1'));
  assert.ok((s1LandView?.claimable.length ?? 0) > 0 && s1LandView?.claimable.every((hex) => touchesS1Land(hex.hexIndex) && !state.territory.has(hex.hexIndex)));
  assert.equal(s1LandView?.examples.claim?.toHexIndex, s1LandView?.claimable[0].hexIndex);
  assert.equal(s1LandView?.examples.improve?.building, 'field');
  const scout = (toHexIndex: number) => ({ kind: 'march', fromHexIndex: home.hexIndex, toHexIndex, troops: { raider: 1, guard: 0, envoy: 0 } });

  playTurn({ s1: [present(s1LandView?.examples.claim), scout(frontierHex), scout(farHex), scout(fieldHex)] });
  assert.equal(state.territory.has(frontierHex), false);
  playTurn({});
  assert.equal(state.territory.get(frontierHex)?.owner, 's1');
  assert.equal(state.territory.get(present(s1LandView?.examples.claim).toHexIndex)?.owner, 's1');
  assert.equal(state.territory.has(farHex), false);
  assert.ok(state.reportsBySeat.s1.some((report) => report.kind === 'land' && report.hexIndex === frontierHex && report.claimer === 's1' && report.previousOwner === null));

  state.terrain[fieldHex] = 'fertile';
  const incomeBefore = villageIncomeOf(state, homeVillage());
  const stockBefore = { ...homeVillage().resources };
  playTurn({ s1: [{ kind: 'build', hexIndex: fieldHex, building: 'field' }, { kind: 'build', hexIndex: outpostHex, building: 'outpost' }] });
  const territoryRule = present(state.balance.territory);
  assert.equal(state.territory.get(fieldHex)?.level, 1);
  assert.equal(state.territory.get(outpostHex)?.improvement, 'outpost');
  assert.equal(villageIncomeOf(state, homeVillage()).grain, incomeBefore.grain + territoryRule.improvements.field.yieldPerLevel + territoryRule.tileBonusPerLevel);
  assert.ok(homeVillage().resources.ore < stockBefore.ore + incomeBefore.ore);

  const standingAt = (hexIndex: number) => [...state.armies.values()].filter((army) => army.status === 'standing' && army.currentHexIndex === hexIndex);
  assert.equal(standingAt(fieldHex).length, 1);
  playTurn({ s1: [{ kind: 'march', fromHexIndex: home.hexIndex, toHexIndex: outpostHex, troops: { raider: 0, guard: 3, envoy: 0 } }, { kind: 'march', fromHexIndex: farHex, toHexIndex: home.hexIndex, troops: { raider: 1, guard: 0, envoy: 0 } }] });
  assert.equal(standingAt(outpostHex).reduce((sum, army) => sum + army.troops.guard, 0), 3);
  assert.equal(standingAt(farHex).length, 0);

  const s2Home = present(state.villages.find((village) => village?.owner === 's2'));
  state.territory.set(present(neighborsOf(fieldHex).find((hexIndex) => state.villages[hexIndex] === null && !state.territory.has(hexIndex))), { owner: 's2', improvement: null, level: 0});
  present(state.territory.get(fieldHex)).level = 3;
  state.armies.set('army-s2', {
    id: 'army-s2', owner: 's2', status: 'marching', originHexIndex: s2Home.hexIndex, currentHexIndex: fieldHex, targetHexIndex: fieldHex,
    troops: { raider: 2, guard: 0, envoy: 0 }, departedTick: state.tick, scoutedBy: [],
  });
  playTurn({});
  assert.deepEqual(standingAt(fieldHex).map((army) => army.owner), ['s2']);
  assert.equal(state.territory.get(fieldHex)?.owner, 's1');
  playTurn({});
  assert.equal(state.territory.get(fieldHex)?.owner, 's2');
  assert.equal(state.territory.get(fieldHex)?.level, 1);
  for (const seatId of ['s1', 's2'] as const) {
    assert.ok(state.reportsBySeat[seatId].some((report) => report.kind === 'land' && report.hexIndex === fieldHex && report.claimer === 's2' && report.previousOwner === 's1'));
  }
  assert.deepEqual(standingAt(fieldHex).map((army) => army.owner), ['s2']);
  assert.ok(state.reportsBySeat.s1.some((report) => report.kind === 'battle' && report.hexIndex === fieldHex));

  const pointsBefore = state.victoryPointsBySeat.s1;
  const extraLand = state.hexes.filter((tile) => isOpenLand(tile.index) && !state.territory.has(tile.index)).slice(-territoryRule.tilesPerPoint * 2).map((tile) => tile.index);
  for (const hexIndex of extraLand) state.territory.set(hexIndex, { owner: 's1', improvement: null, level: 0});
  const s1Land = territoryCountOf(state, 's1');
  playTurn({});
  const s1Villages = state.villages.filter((village): village is NonNullable<typeof village> => village?.owner === 's1' && !village.isBeacon);
  assert.equal(state.victoryPointsBySeat.s1 - pointsBefore, s1Villages.length + Math.floor(s1Land / territoryRule.tilesPerPoint));
  for (const hexIndex of extraLand) state.territory.delete(hexIndex);

  const siteHex = present(state.hexes.find((tile) => isOpenLand(tile.index) && !state.territory.has(tile.index)
    && state.villages.every((village) => village === null || distanceBetween(tile.index, village.hexIndex) >= territoryRule.foundSpacing)));
  state.territory.set(siteHex.index, { owner: 's1', improvement: null, level: 0});
  const payer = present(state.villages.find((village) => village?.owner === 's1'));
  payer.troops.envoy = territoryRule.foundEnvoys;
  payer.resources = { grain: 400, ore: 400 };
  const villagesBefore = state.villages.filter((village) => village?.owner === 's1').length;
  playTurn({ s1: [{ kind: 'found', hexIndex: neighborsOf(home.hexIndex)[0] }, { kind: 'found', hexIndex: siteHex.index }] });
  assert.equal(state.villages.filter((village) => village?.owner === 's1').length, villagesBefore + 1);
  assert.equal(state.villages[siteHex.index]?.owner, 's1');
  assert.equal(state.territory.has(siteHex.index), false);
  assert.ok(neighborsOf(siteHex.index).filter(isOpenLand).every((hexIndex) => state.territory.has(hexIndex)));
  apply({ type: 'message_sent', seatId: 's2', to: 's1', channel: 'dm', text: 'You have my word' });
  playTurn({ s2: [{ kind: 'march', fromHexIndex: s2Home.hexIndex, toHexIndex: siteHex.index, troops: { raider: 1, guard: 0, envoy: 0 } }] });
  assert.deepEqual(betrayalsOf(state).map((betrayal) => [betrayal.actor, betrayal.target]), [['s2', 's1']]);

  const barbarian = present(state.villages.find((village) => village?.owner === null && !village.isBeacon
    && neighborsOf(village.hexIndex).some((hexIndex) => isOpenLand(hexIndex) && !state.territory.has(hexIndex))));
  const barbarianRing = neighborsOf(barbarian.hexIndex).filter(isOpenLand);
  const heldRingHex = present(barbarianRing.find((hexIndex) => !state.territory.has(hexIndex)));
  const unownedRing = barbarianRing.filter((hexIndex) => !state.territory.has(hexIndex) && hexIndex !== heldRingHex);
  state.territory.set(heldRingHex, { owner: 's3', improvement: null, level: 0 });
  barbarian.troops = { raider: 0, guard: 0, envoy: 0 };
  barbarian.buildings.wall = 0;
  barbarian.loyalty = 1;
  state.armies.set('army-capture', {
    id: 'army-capture', owner: 's1', status: 'marching', originHexIndex: home.hexIndex, currentHexIndex: barbarian.hexIndex, targetHexIndex: barbarian.hexIndex,
    troops: { raider: 6, guard: 0, envoy: 2 }, departedTick: state.tick, scoutedBy: [],
  });
  playTurn({});
  assert.equal(state.villages[barbarian.hexIndex]?.owner, 's1');
  assert.ok(unownedRing.every((hexIndex) => state.territory.get(hexIndex)?.owner === 's1'));
  assert.equal(state.territory.get(heldRingHex)?.owner, 's3');
});

test('the rules id names one balance and one event schema, so a saved log replays on the rules that made it', () => {
  const rulesFingerprint = createHash('sha256').update(JSON.stringify([WARGAMES_BALANCE, z.toJSONSchema(WargamesEventSchema, { io: 'input' })])).digest('hex').slice(0, 16);
  assert.deepEqual({ rules: WARGAMES_RULES_ID, rulesFingerprint }, { rules: 'r2', rulesFingerprint: '5828715e97312616' });
});
