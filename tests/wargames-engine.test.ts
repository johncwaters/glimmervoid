import './helpers/isolate-home.ts';
import { createHash, createHmac } from 'node:crypto';
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
  transitionContract,
  transitionMatch,
  transitionSeat,
  transitionTick,
  transitionVillage,
} from '../shared/wargames/machines.ts';
import type { ReportSigner } from '../shared/wargames/engine.ts';
import { EMPTY_ECONOMY_TIMELINE, economyTurnsAt, extendEconomyTimeline } from '../public/wargames/wargames-economy-core.ts';
import { applyWargamesEvents, displayedMatchState, seekReplayTurn, selectWatchedMatch } from '../public/wargames/wargames-store.ts';
import { analyzeMatch, computeEloFromSummaries, summarizeMatch } from '../shared/wargames/analytics.ts';

function createTestSigner(seed: number): ReportSigner {
  const key = `wargames-test-key-${seed}`;
  return {
    sign: (canonicalPayload) => createHmac('sha256', key).update(canonicalPayload).digest('hex'),
    verify: (canonicalPayload, signature) => createHmac('sha256', key).update(canonicalPayload).digest('hex') === signature,
  };
}

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

function appendAndApply(
  log: WargamesEvent[],
  state: ReturnType<typeof createInitialMatchState>,
  event: WargamesEvent,
  signer: ReportSigner,
) {
  const outcome = applyEvent(state, event, signer);
  assert.equal(outcome.ok, true, outcome.ok ? '' : `unexpected rejection: ${outcome.rejection.code} ${outcome.rejection.message}`);
  if (event.type === 'phase_advanced') {
    const signatures: Record<string, string> = {};
    for (const effect of outcome.effects) {
      if (effect.kind === 'report_signed' && typeof effect.detail.reportId === 'string' && typeof effect.detail.signature === 'string') {
        signatures[effect.detail.reportId] = effect.detail.signature;
      }
    }
    log.push({ ...event, signatures });
    return outcome.state;
  }
  log.push(event);
  return outcome.state;
}

test('state machines reject disallowed transitions with typed codes', () => {
  assert.equal(transitionMatch('lobby', 'all_seats_connected').ok, false);
  assert.equal(transitionTick('talk', 'resolution_complete').ok, false);
  assert.equal(transitionSeat('disconnected', 'seat_submit').ok, false);
  assert.equal(transitionContract('proposed', 'contract_breach').ok, false);
  assert.equal(transitionVillage('barren', 'outer_ring_squeeze').ok, false);
  assert.equal(transitionArmy('home', 'army_depart').ok, false);
});

type EventWithoutSeq<Event> = Event extends WargamesEvent ? Omit<Event, 'seq'> : never;

const lengthSigner: ReportSigner = {
  sign: (payload) => `sig:${payload.length}`,
  verify: (payload, signature) => signature === `sig:${payload.length}`,
};

function present<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== null && value !== undefined);
  return value;
}

function advanceToResolution(state: ReturnType<typeof createInitialMatchState>, tickOverride?: number) {
  let current = state;
  const applyNext = (event: EventWithoutSeq<WargamesEvent>) => {
    const applied = applyEvent(current, { ...event, seq: current.lastSeq + 1 } as WargamesEvent, lengthSigner);
    assert.equal(applied.ok, true);
    if (applied.ok) current = applied.state;
  };
  applyNext({ type: 'seating_started' });
  for (const seatId of WARGAMES_SEAT_IDS) applyNext({ type: 'seat_connected', seatId });
  if (tickOverride !== undefined) current.tick = tickOverride;
  applyNext({ type: 'phase_advanced', reason: 'deadline', signatures: {} });
  applyNext({ type: 'phase_advanced', reason: 'deadline', signatures: {} });
  applyNext({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
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

  const signer = createTestSigner(4);
  const fourSeatPlaySpec = WargamesMatchSpec.parse({ ...fourSeatInput, mapRadius: 6 });
  const log: WargamesEvent[] = [{ seq: 0, type: 'match_created', matchId: 'wg-four-play', createdAtMs: 1000, spec: fourSeatPlaySpec }];
  let state = createInitialMatchState('wg-four-play', 1000, fourSeatPlaySpec);
  let seq = 0;
  const nextSeq = () => { seq += 1; return seq; };
  const advance = (): WargamesEvent => ({ seq: nextSeq(), type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
  state = appendAndApply(log, state, { seq: nextSeq(), type: 'seating_started' }, signer);
  for (const seatId of ['s1', 's2', 's3', 's4'] as const) {
    state = appendAndApply(log, state, { seq: nextSeq(), type: 'seat_connected', seatId }, signer);
  }
  assert.equal(state.status, 'running');

  const outsideSender = applyEvent(state, { seq: seq + 1, type: 'note_written', seatId: 's5', text: 'hi' }, signer);
  assert.equal(outsideSender.ok ? null : outsideSender.rejection.code, 'unauthorized_seat');
  const outsideRecipient = applyEvent(state, { seq: seq + 1, type: 'message_sent', seatId: 's1', to: 's6', channel: 'dm', text: 'hi', attachedReport: null }, signer);
  assert.equal(outsideRecipient.ok ? null : outsideRecipient.rejection.code, 'invalid_target');

  state = appendAndApply(log, state, advance(), signer);
  state = appendAndApply(log, state, advance(), signer);

  const s1Home = state.villages.find((village) => village?.owner === 's1');
  const s1Target = state.villages.find((village) => village !== null && village.owner === null);
  assert.ok(s1Home && s1Target);
  state = appendAndApply(log, state, {
    seq: nextSeq(),
    type: 'orders_submitted',
    seatId: 's1',
    orders: [{ kind: 'march', fromHexIndex: s1Home.hexIndex, toHexIndex: s1Target.hexIndex, troops: { raider: 3, guard: 0, envoy: 0 } }],
  }, signer);
  for (const seatId of ['s2', 's3', 's4'] as const) {
    state = appendAndApply(log, state, { seq: nextSeq(), type: 'orders_submitted', seatId, orders: [] }, signer);
  }
  state = appendAndApply(log, state, advance(), signer);
  state = appendAndApply(log, state, advance(), signer);
  assert.equal(state.tick, 2);
  assert.equal([...state.armies.values()].filter((army) => army.owner === 's1').length, 1);

  const summary = summarizeMatch(state, null, log.length + 1);
  assert.deepEqual(summary.seats.map((seat) => seat.seatId), ['s1', 's2', 's3', 's4']);
  assert.equal(analyzeMatch(log, state).seats.length, 4);

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

const startFourSeatMatch = () => {
  const spec = WargamesMatchSpec.parse({ ...buildTestSpec(), mapRadius: 4, seats: buildTestSpec().seats.slice(0, 4) });
  let state = createInitialMatchState('wg-goal', 1000, spec);
  const signer = createTestSigner(6);
  let seq = 0;
  for (const event of [{ type: 'seating_started' }, ...state.seats.map((seat) => ({ type: 'seat_connected', seatId: seat.config.seatId }))]) {
    seq += 1;
    const outcome = applyEvent(state, { ...event, seq } as WargamesEvent, signer);
    assert.equal(outcome.ok, true);
    if (outcome.ok) state = outcome.state;
  }
  return { spec, state, signer, seq };
};

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

test('trade credit never lands in a beacon, so a beacon reverting to unowned takes no goods with it', () => {
  const match = startFourSeatMatch();
  let state = match.state;
  let seq = match.seq;
  const beacon = state.villages.find((village) => village?.isBeacon);
  assert.ok(beacon);
  beacon.owner = 's1';
  beacon.troops = { raider: 0, guard: 1, envoy: 0 };
  const apply = (event: Record<string, unknown>) => {
    seq += 1;
    const outcome = applyEvent(state, { ...event, seq } as WargamesEvent, match.signer);
    assert.equal(outcome.ok, true);
    if (outcome.ok) state = outcome.state;
  };
  apply({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
  apply({
    type: 'contract_proposed',
    seatId: 's2',
    contractId: 'escrow-to-beacon-holder',
    terms: { kind: 'escrow', counterparty: 's1', proposerGives: { grain: 150, ore: 0 }, counterpartyGives: { grain: 0, ore: 0 } },
  });
  apply({ type: 'contract_accepted', seatId: 's1', contractId: 'escrow-to-beacon-holder' });
  assert.equal(state.villages[beacon.hexIndex]?.resources.grain, 0);
});

test('v8 makes a lone raid fail where an allied pair clears the wall and its envoy-only wave captures', () => {
  type Troops = { raider: number; guard: number; envoy: number };
  const runRaid = (marches: readonly { owner: 's1' | 's2'; troops: Troops; supporting?: 's1' }[], defenders: Troops = { raider: 0, guard: 20, envoy: 0 }, owner: 's3' | null = null) => {
    const spec: WargamesMatchSpec = { ...buildTestSpec() };
    const state = createInitialMatchState('wg-v8-raid', 1000, spec);
    const target = state.villages.find((village) => village && village.owner === null && !village.isBeacon);
    assert.ok(target);
    target.troops = defenders;
    target.owner = owner;
    target.buildings.wall = 3;
    state.contracts.set('ctr-ally', {
      id: 'ctr-ally', proposer: 's1', counterparty: 's2',
      terms: { kind: 'alliance', counterparty: 's2', durationTicks: 5, collateral: { grain: 0, ore: 0 } },
      status: 'active', proposedTick: 1, activatedTick: 1, endTick: 10, breachedBy: null, breachedTick: null,
    });
    marches.forEach((march, index) => {
      state.armies.set(`army-${index}`, {
        id: `army-${index}`, owner: march.owner, status: 'marching', originHexIndex: target.hexIndex,
        currentHexIndex: target.hexIndex, targetHexIndex: target.hexIndex, troops: march.troops,
        departedTick: 0, intendedTargetOwner: null, scoutedBy: [], ...(march.supporting ? { supporting: march.supporting } : {}),
      });
    });
    const resolved = advanceToResolution(state);
    const report = resolved.reportsBySeat.s1.find((entry) => entry.payload.kind === 'battle')?.payload;
    assert.ok(report && report.kind === 'battle');
    return { resolved, report, village: resolved.villages[target.hexIndex] };
  };

  const lone = runRaid([{ owner: 's1', troops: { raider: 20, guard: 0, envoy: 0 } }, { owner: 's1', troops: { raider: 0, guard: 0, envoy: 6 } }]);
  assert.equal(lone.village?.owner, null);
  assert.equal(lone.village?.loyalty, 100);
  assert.equal(lone.report.wallAfter, 3);
  assert.equal(lone.resolved.armies.get('army-1')?.status, 'destroyed');

  const pair = runRaid([
    { owner: 's1', troops: { raider: 20, guard: 0, envoy: 0 } },
    { owner: 's1', troops: { raider: 0, guard: 0, envoy: 6 } },
    { owner: 's2', troops: { raider: 20, guard: 0, envoy: 0 }, supporting: 's1' },
  ]);
  assert.equal(pair.village?.owner, 's1');
  assert.equal(pair.report.wallBefore, 3);
  assert.ok((pair.report.wallAfter ?? 3) < 3);
  assert.equal(pair.report.attackerLost.envoy, 0);
  assert.equal(pair.resolved.armies.get('army-2')?.status, 'returning');

  const envoysAtEmptyWall = runRaid([{ owner: 's1', troops: { raider: 0, guard: 0, envoy: 6 } }], { raider: 0, guard: 0, envoy: 0 }, 's3');
  assert.equal(envoysAtEmptyWall.village?.owner, 's3');
  assert.equal(envoysAtEmptyWall.resolved.armies.get('army-0')?.status, 'destroyed');
});

test('v8 keeps lent guards the sender\'s, caps them by the host farm, and sends them home when the alliance ends', () => {
  const lendGuards = (allianceEndTick: number, hostGuards?: number) => {
    const spec: WargamesMatchSpec = { ...buildTestSpec() };
    const state = createInitialMatchState('wg-v8-guests', 1000, spec);
    const s1Home = state.villages.find((village) => village?.owner === 's1');
    const s2Home = state.villages.find((village) => village?.owner === 's2');
    assert.ok(s1Home && s2Home);
    if (hostGuards !== undefined) s1Home.troops.guard = hostGuards;
    state.contracts.set('ctr-ally', {
      id: 'ctr-ally', proposer: 's2', counterparty: 's1',
      terms: { kind: 'alliance', counterparty: 's1', durationTicks: 5, collateral: { grain: 0, ore: 0 } },
      status: 'active', proposedTick: 0, activatedTick: 0, endTick: allianceEndTick, breachedBy: null, breachedTick: null,
    });
    state.armies.set('army-lend', {
      id: 'army-lend', owner: 's2', status: 'marching', originHexIndex: s2Home.hexIndex,
      currentHexIndex: s1Home.hexIndex, targetHexIndex: s1Home.hexIndex,
      troops: { raider: 0, guard: 50, envoy: 0 }, departedTick: 0, intendedTargetOwner: 's1', scoutedBy: [], supporting: 's1',
    });
    const resolved = advanceToResolution(state);
    return { resolved, host: resolved.villages[s1Home.hexIndex], hostTroopsBefore: { ...s1Home.troops } };
  };

  const standing = lendGuards(10);
  assert.deepEqual(standing.host?.troops, standing.hostTroopsBefore);
  assert.deepEqual(standing.host?.guests.map((guest) => [guest.owner, guest.troops.guard]), [['s2', 47]]);
  assert.equal(standing.resolved.armies.get('army-lend')?.status, 'returning');
  assert.equal(standing.resolved.armies.get('army-lend')?.troops.guard, 3);

  const full = lendGuards(10, 60);
  assert.deepEqual(full.host?.guests, []);
  assert.equal(full.resolved.armies.get('army-lend')?.troops.guard, 50);
  assert.deepEqual(projectSeatState(full.resolved, 's2').visibleVillages.map((village) => village.hexIndex).includes(full.host?.hexIndex ?? -1), false);

  const ended = lendGuards(1);
  assert.deepEqual(ended.host?.guests, []);
  const guestsGoingHome = [...ended.resolved.armies.values()].filter((army) => army.owner === 's2' && army.status === 'returning');
  assert.equal(guestsGoingHome.reduce((sum, army) => sum + army.troops.guard, 0), 50);
});

test('v9 starts villages with their land ring, claims land as a front with land reports, builds improvements paid by the nearest village, halves them on capture, founds villages and scores territory VP', () => {
  const spec = WargamesMatchSpec.parse({ ...buildTestSpec(), mapRadius: 6, seats: buildTestSpec().seats.slice(0, 4) });
  let state = createInitialMatchState('wg-v9-land', 1000, spec);
  const signer = createTestSigner(9);
  const apply = (event: Record<string, unknown>) => {
    const outcome = applyEvent(state, { ...event, seq: state.lastSeq + 1 } as WargamesEvent, signer);
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.rejection.message);
    if (outcome.ok) state = outcome.state;
  };
  apply({ type: 'seating_started' });
  for (const seat of state.seats) apply({ type: 'seat_connected', seatId: seat.config.seatId });
  const playTurn = (ordersBySeat: Partial<Record<'s1' | 's2' | 's3' | 's4', unknown[]>>) => {
    apply({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
    apply({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
    for (const seat of state.seats) apply({ type: 'orders_submitted', seatId: seat.config.seatId, orders: ordersBySeat[seat.config.seatId as 's1'] ?? [] });
    apply({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
    apply({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
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
  assert.ok(state.reportsBySeat.s1.some((report) => report.payload.kind === 'land' && report.payload.hexIndex === frontierHex && report.payload.claimer === 's1' && report.payload.previousOwner === null));

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
    troops: { raider: 2, guard: 0, envoy: 0 }, departedTick: state.tick, intendedTargetOwner: 's1', scoutedBy: [],
  });
  playTurn({});
  assert.deepEqual(standingAt(fieldHex).map((army) => army.owner), ['s2']);
  assert.equal(state.territory.get(fieldHex)?.owner, 's1');
  playTurn({});
  assert.equal(state.territory.get(fieldHex)?.owner, 's2');
  assert.equal(state.territory.get(fieldHex)?.level, 1);
  for (const seatId of ['s1', 's2'] as const) {
    assert.ok(state.reportsBySeat[seatId].some((report) => report.payload.kind === 'land' && report.payload.hexIndex === fieldHex && report.payload.claimer === 's2' && report.payload.previousOwner === 's1'));
  }
  assert.deepEqual(standingAt(fieldHex).map((army) => army.owner), ['s2']);
  assert.ok(state.reportsBySeat.s1.some((report) => report.payload.kind === 'battle' && report.payload.hexIndex === fieldHex));

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
    troops: { raider: 6, guard: 0, envoy: 2 }, departedTick: state.tick, intendedTargetOwner: null, scoutedBy: [],
  });
  playTurn({});
  assert.equal(state.villages[barbarian.hexIndex]?.owner, 's1');
  assert.ok(unownedRing.every((hexIndex) => state.territory.get(hexIndex)?.owner === 's1'));
  assert.equal(state.territory.get(heldRingHex)?.owner, 's3');
});

test('the rules id names one balance and one event schema, so a saved log replays on the rules that made it', () => {
  const rulesFingerprint = createHash('sha256').update(JSON.stringify([WARGAMES_BALANCE, z.toJSONSchema(WargamesEventSchema, { io: 'input' })])).digest('hex').slice(0, 16);
  assert.deepEqual({ rules: WARGAMES_RULES_ID, rulesFingerprint }, { rules: 'r1', rulesFingerprint: 'aeaac3175e51b803' });
});
