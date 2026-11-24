import './helpers/isolate-home.ts';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WARGAMES_HEX_COUNT,
  WARGAMES_NOTE_MAX_BYTES,
  WARGAMES_RULES_VERSION,
  WARGAMES_SEAT_IDS,
  WARGAMES_SQUEEZE_TICK,
  WargamesMatchSpec,
  WargamesMatchSummary,
} from '../shared/contracts/wargames.ts';
import type { WargamesEvent } from '../shared/contracts/wargames.ts';
import {
  ALL_HEXES,
  applyEvent,
  createInitialMatchState,
  hexIndexAt,
  projectSeatState,
  replayMatch,
  replayMatchAtTick,
  victoryVillagesFor,
} from '../shared/wargames/engine.ts';
import type { MatchState } from '../shared/wargames/engine.ts';
import type { ReportSigner } from '../shared/wargames/engine.ts';
import {
  transitionArmy,
  transitionContract,
  transitionMatch,
  transitionSeat,
  transitionTick,
  transitionVillage,
} from '../shared/wargames/machines.ts';
import { EMPTY_ECONOMY_TIMELINE, extendEconomyTimeline } from '../public/wargames/wargames-economy-core.ts';
import { analyzeMatch, computeEloByVersion, computeEloFromSummaries, summarizeMatch } from '../shared/wargames/analytics.ts';

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

test('full recorded match replays byte-identically and enforces ruleset, NAP breach, squeeze, fog of war, and analytics', () => {
  const spec = buildTestSpec(9001);
  const signer = createTestSigner(spec.seed);
  const log: WargamesEvent[] = [
    { seq: 0, type: 'match_created', matchId: 'wg-replay-1', createdAtMs: 1_700_000_000_000, spec },
  ];
  let state = createInitialMatchState('wg-replay-1', 1_700_000_000_000, spec);
  assert.equal(ALL_HEXES.length, WARGAMES_HEX_COUNT);
  assert.equal(state.villages.filter((village) => village !== null).length, 30);

  let seq = 1;
  state = appendAndApply(log, state, { seq: seq++, type: 'seating_started' }, signer);
  for (const seatId of WARGAMES_SEAT_IDS) {
    state = appendAndApply(log, state, { seq: seq++, type: 'seat_connected', seatId }, signer);
  }
  assert.equal(state.status, 'running');
  assert.equal(state.tick, 1);
  assert.equal(state.phase, 'talk');

  const tooLongNote = applyEvent(state, { seq, type: 'note_written', seatId: 's1', text: 'x'.repeat(WARGAMES_NOTE_MAX_BYTES + 1) }, signer);
  assert.equal(tooLongNote.ok, false);
  if (!tooLongNote.ok) assert.equal(tooLongNote.rejection.code, 'note_too_large');

  const surrogateBypass = applyEvent(state, { seq, type: 'note_written', seatId: 's1', text: '\uD800\u4E00'.repeat(1024) }, signer);
  assert.equal(surrogateBypass.ok, false);
  if (!surrogateBypass.ok) assert.equal(surrogateBypass.rejection.code, 'note_too_large');

  state = appendAndApply(log, state, { seq: seq++, type: 'note_written', seatId: 's1', text: 'Plan: betray s2 after NAP.' }, signer);
  state = appendAndApply(log, state, { seq: seq++, type: 'message_sent', seatId: 's1', to: 's2', channel: 'dm', text: 'Let us sign a peace NAP ally deal.', attachedReport: null }, signer);
  state = appendAndApply(log, state, { seq: seq++, type: 'message_sent', seatId: 's1', to: 's3', channel: 'dm', text: 'Watch the center.', attachedReport: null }, signer);

  const thirdMessage = applyEvent(state, { seq, type: 'message_sent', seatId: 's1', to: 's4', channel: 'dm', text: 'Over limit', attachedReport: null }, signer);
  assert.equal(thirdMessage.ok, false);
  if (!thirdMessage.ok) assert.equal(thirdMessage.rejection.code, 'message_limit_exceeded');

  state = appendAndApply(log, state, { seq: seq++, type: 'phase_advanced', reason: 'all_submitted', signatures: {} }, signer);
  assert.equal(state.phase, 'contracts');

  state = appendAndApply(log, state, {
    seq: seq++,
    type: 'contract_proposed',
    seatId: 's1',
    contractId: 'nap-1',
    terms: { kind: 'nap', counterparty: 's2', durationTicks: 5, collateral: { grain: 50, ore: 50 } },
  }, signer);
  state = appendAndApply(log, state, { seq: seq++, type: 'contract_accepted', seatId: 's2', contractId: 'nap-1' }, signer);
  assert.equal(state.contracts.get('nap-1')?.status, 'active');

  state = appendAndApply(log, state, { seq: seq++, type: 'phase_advanced', reason: 'all_submitted', signatures: {} }, signer);
  assert.equal(state.phase, 'orders');

  const s1Home = hexIndexAt(2, -1);
  const s2Home = hexIndexAt(1, -2);
  state = appendAndApply(log, state, {
    seq: seq++,
    type: 'orders_submitted',
    seatId: 's1',
    orders: [
      { kind: 'build', hexIndex: s1Home, building: 'farm' },
      { kind: 'scout', fromHexIndex: s1Home, toHexIndex: s2Home },
      { kind: 'march', fromHexIndex: s1Home, toHexIndex: s2Home, troops: { raider: 5, guard: 2, envoy: 1 } },
    ],
  }, signer);
  state = appendAndApply(log, state, { seq: seq++, type: 'phase_advanced', reason: 'deadline', signatures: {} }, signer);
  assert.equal(state.phase, 'reported');
  assert.equal(state.contracts.get('nap-1')?.status, 'breached');
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0].breacher, 's1');
  assert.equal(state.ledger[0].victim, 's2');
  assert.ok(state.reportsBySeat.s1.length >= 2);

  const scoutReport = state.reportsBySeat.s1.find((report) => report.payload.kind === 'scout');
  assert.ok(scoutReport);
  const forgedReport = {
    payload: { ...scoutReport.payload, loyalty: 10 },
    signature: 'sig_forged_deadbeef',
  };

  state = appendAndApply(log, state, { seq: seq++, type: 'phase_advanced', reason: 'all_submitted', signatures: {} }, signer);
  assert.equal(state.tick, 2);
  assert.equal(state.phase, 'talk');

  state = appendAndApply(log, state, {
    seq: seq++,
    type: 'message_sent',
    seatId: 's1',
    to: 's3',
    channel: 'dm',
    text: 'Here is my scout report on s2',
    attachedReport: forgedReport,
  }, signer);
  state = appendAndApply(log, state, {
    seq: seq++,
    type: 'report_verified',
    seatId: 's3',
    reportId: forgedReport.payload.reportId,
    valid: false,
  }, signer);

  while (state.tick < WARGAMES_SQUEEZE_TICK) {
    state = appendAndApply(log, state, { seq: seq++, type: 'phase_advanced', reason: 'deadline', signatures: {} }, signer);
  }
  while (state.phase !== 'reported') {
    state = appendAndApply(log, state, { seq: seq++, type: 'phase_advanced', reason: 'deadline', signatures: {} }, signer);
  }
  const outerRingVillage = state.villages.find((village) => village !== null && ALL_HEXES[village.hexIndex].ring === 3);
  assert.ok(outerRingVillage);
  assert.equal(outerRingVillage.productionState, 'barren');

  const replayed = replayMatch(log);
  assert.deepEqual(replayed, state);
  const replayedTick1 = replayMatchAtTick(log, 1);
  assert.equal(replayedTick1.tick, 1);

  const s4View = projectSeatState(state, 's4');
  assert.equal(s4View.yourSeatId, 's4');
  assert.equal(s4View.ledger.length, 1);
  assert.equal(s4View.visibleArmies.every((army) => !('scoutedBy' in army)), true);

  const analytics = analyzeMatch(log, state, { s1: 2500 });
  assert.ok(analytics.highlights.some((item) => item.kind === 'contract_breach'));
  assert.ok(analytics.highlights.some((item) => item.kind === 'forged_report' && item.detected === true));
  assert.equal(analytics.forgedReportDetectionRate, 1);

  let economyFedEventByEvent = EMPTY_ECONOMY_TIMELINE;
  for (let eventCount = 1; eventCount <= log.length; eventCount += 1) {
    economyFedEventByEvent = extendEconomyTimeline(economyFedEventByEvent, log.slice(0, eventCount));
  }
  const economyFromFullLog = extendEconomyTimeline(EMPTY_ECONOMY_TIMELINE, log);
  assert.deepEqual(economyFedEventByEvent.turns, economyFromFullLog.turns);

  const finishedSummary = {
    ...summarizeMatch(state, 1_700_000_060_000, log.length),
    status: 'finished' as const,
    winnerSeatId: 's1' as const,
    winnerModelDisplay: 'claude-opus-4-6',
  };
  const elo = computeEloFromSummaries([finishedSummary]);
  assert.equal(elo[0].modelDisplay, 'claude-opus-4-6');
  assert.ok(elo[0].elo > 1500);
  const eloSum = elo.reduce((sum, row) => sum + row.elo, 0);
  assert.ok(Math.abs(eloSum - 6 * 1500) < 0.5);
});

test('wargames engine bounces neutral-hex NAP collisions without breaching and aggregates duplicate ally_attack highlights', () => {
  const spec = buildTestSpec();
  const matchId = 'wg-nap-bounce';
  const createdAtMs = 1_700_000_000_000;
  let state = createInitialMatchState(matchId, createdAtMs, spec);
  const log: WargamesEvent[] = [{ seq: 0, type: 'match_created', matchId, createdAtMs, spec }];
  type EventWithoutSeq<T> = T extends WargamesEvent ? Omit<T, 'seq'> : never;
  const signer = {
    sign: (payload: string) => `sig:${payload.length}`,
    verify: (payload: string, signature: string) => signature === `sig:${payload.length}`,
  };
  const push = (event: EventWithoutSeq<WargamesEvent>) => {
    const full = { ...event, seq: state.lastSeq + 1 } as WargamesEvent;
    const applied = applyEvent(state, full, signer);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    state = applied.state;
    log.push(full);
  };
  push({ type: 'seating_started' });
  for (const seatId of WARGAMES_SEAT_IDS) push({ type: 'seat_connected', seatId });
  push({ type: 'message_sent', seatId: 's1', channel: 'dm', to: 's2', text: 'peace alliance', attachedReport: null });
  push({ type: 'phase_advanced', reason: 'deadline', signatures: {} });
  push({
    type: 'contract_proposed',
    seatId: 's1',
    contractId: 'ctr-nap-race',
    terms: { kind: 'nap', counterparty: 's2', durationTicks: 5, collateral: { grain: 20, ore: 20 } },
  });
  push({ type: 'contract_accepted', seatId: 's2', contractId: 'ctr-nap-race' });
  push({ type: 'phase_advanced', reason: 'deadline', signatures: {} });

  const s1Home = hexIndexAt(2, 0);
  const s1Second = hexIndexAt(2, -1);
  const s2Home = hexIndexAt(1, -2);
  const neutralTarget = hexIndexAt(1, -1);
  const s2Village = hexIndexAt(0, -2);
  const targetVillage = state.villages[neutralTarget];
  assert.ok(targetVillage);
  targetVillage.owner = null;
  targetVillage.loyalty = 15;
  targetVillage.troops = { raider: 0, guard: 0, envoy: 0 };

  push({
    type: 'orders_submitted',
    seatId: 's1',
    orders: [
      { kind: 'march', fromHexIndex: s1Home, toHexIndex: neutralTarget, troops: { raider: 2, guard: 2, envoy: 1 } },
    ],
  });
  push({
    type: 'orders_submitted',
    seatId: 's2',
    orders: [
      { kind: 'march', fromHexIndex: s2Home, toHexIndex: neutralTarget, troops: { raider: 2, guard: 2, envoy: 1 } },
    ],
  });
  for (const seatId of ['s3', 's4', 's5', 's6'] as const) {
    push({ type: 'orders_submitted', seatId, orders: [] });
  }
  push({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
  push({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });

  assert.equal(state.ledger.length, 0);
  assert.equal(state.contracts.get('ctr-nap-race')?.status, 'active');

  push({ type: 'phase_advanced', reason: 'deadline', signatures: {} });
  push({ type: 'phase_advanced', reason: 'deadline', signatures: {} });
  push({
    type: 'orders_submitted',
    seatId: 's1',
    orders: [
      { kind: 'march', fromHexIndex: s1Home, toHexIndex: s2Village, troops: { raider: 1, guard: 0, envoy: 0 } },
      { kind: 'march', fromHexIndex: s1Second, toHexIndex: s2Village, troops: { raider: 1, guard: 0, envoy: 0 } },
    ],
  });
  for (const seatId of ['s2', 's3', 's4', 's5', 's6'] as const) {
    push({ type: 'orders_submitted', seatId, orders: [] });
  }
  push({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
  push({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });

  const analytics = analyzeMatch(log, state);
  const allyHighlights = analytics.highlights.filter((item) => item.kind === 'ally_attack' && item.actor === 's1' && item.target === 's2');
  assert.equal(allyHighlights.length, 1);
  assert.match(allyHighlights[0].relatedOrderText ?? '', /,/);
});

test('rulesVersion defaults on legacy summaries, tags custom strategy, and isolates Elo by version', () => {
  const legacyParsed = WargamesMatchSummary.parse({
    matchId: 'wg-legacy-1',
    title: 'Legacy Match',
    seed: 1,
    createdAtMs: 1000,
    finishedAtMs: 2000,
    status: 'finished',
    tick: 10,
    maxTicks: 10,
    phase: 'reported',
    winnerSeatId: 's1',
    winnerModelDisplay: 'model-a',
    breachCount: 0,
    eventCount: 50,
    seats: WARGAMES_SEAT_IDS.map((seatId, index) => ({
      seatId,
      label: `Seat ${index + 1}`,
      modelDisplay: index === 0 ? 'model-a' : 'model-b',
      status: 'submitted',
      villagesHeld: index === 0 ? 12 : 2,
      breaches: 0,
    })),
  });
  assert.equal(legacyParsed.rulesVersion, 'v1');
  assert.equal(legacyParsed.hasCustomStrategy, false);

  const v2Summary: WargamesMatchSummary = {
    ...legacyParsed,
    matchId: 'wg-v2-1',
    rulesVersion: 'v2',
    createdAtMs: 3000,
    winnerSeatId: 's2',
    winnerModelDisplay: 'model-b',
    seats: legacyParsed.seats.map((seat) => ({
      ...seat,
      villagesHeld: seat.seatId === 's2' ? 12 : 1,
    })),
  };

  const eloByVersion = computeEloByVersion([legacyParsed, v2Summary]);
  assert.deepEqual(Object.keys(eloByVersion).sort(), ['v1', 'v2']);
  const v1ModelA = eloByVersion.v1.find((row) => row.modelDisplay === 'model-a');
  const v2ModelA = eloByVersion.v2.find((row) => row.modelDisplay === 'model-a');
  assert.ok(v1ModelA && v2ModelA);
  assert.ok(v1ModelA.elo > 1500);
  assert.ok(v2ModelA.elo < 1500);
  assert.equal(v1ModelA.matchesPlayed, 1);
  assert.equal(v2ModelA.matchesPlayed, 1);

  const baseSpec = buildTestSpec();
  const coachedSpec: WargamesMatchSpec = {
    ...baseSpec,
    rulesVersion: 'v2',
    seats: baseSpec.seats.map((seat) => ({
      ...seat,
      setup: { ...seat.setup, instructions: seat.seatId === 's1' ? 'Rush center hexes' : '' },
    })),
  };
  const coachedSummary = summarizeMatch(createInitialMatchState('wg-coached-1', 5000, coachedSpec), null, 1);
  assert.equal(coachedSummary.rulesVersion, 'v2');
  assert.equal(coachedSummary.hasCustomStrategy, true);
});

type EventWithoutSeq<Event> = Event extends WargamesEvent ? Omit<Event, 'seq'> : never;

const lengthSigner: ReportSigner = {
  sign: (payload) => `sig:${payload.length}`,
  verify: (payload, signature) => signature === `sig:${payload.length}`,
};

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

test('v2 resolves simultaneous multi-attacker battles order-independently and lands reinforcements first', () => {
  const runContestedAttack = (s1Raiders: number, s6Raiders: number, insertOrder: readonly ('s1' | 's6')[] = ['s1', 's6']) => {
    const spec: WargamesMatchSpec = { ...buildTestSpec(), rulesVersion: 'v2' };
    const state = createInitialMatchState('wg-v2-sim', 1000, spec);
    const s1Capital = state.villages.find((village) => village?.owner === 's1');
    const s6Capital = state.villages.find((village) => village?.owner === 's6');
    const neutralVillage = state.villages.find((village) => village && village.owner === null);
    assert.ok(s1Capital && s6Capital && neutralVillage);

    neutralVillage.troops = { raider: 0, guard: 1, envoy: 0 };
    neutralVillage.loyalty = 40;

    for (const seatId of insertOrder) {
      const originHexIndex = seatId === 's1' ? s1Capital.hexIndex : s6Capital.hexIndex;
      const raiders = seatId === 's1' ? s1Raiders : s6Raiders;
      state.armies.set(`army-test-${seatId}`, {
        id: `army-test-${seatId}`,
        owner: seatId,
        status: 'marching',
        originHexIndex,
        currentHexIndex: neutralVillage.hexIndex,
        targetHexIndex: neutralVillage.hexIndex,
        troops: { raider: raiders, guard: 0, envoy: 3 },
        departedTick: 0,
        intendedTargetOwner: null,
        scoutedBy: [],
      });
    }

    const resolved = advanceToResolution(state);
    return {
      owner: resolved.villages[neutralVillage.hexIndex]?.owner ?? null,
      loyalty: resolved.villages[neutralVillage.hexIndex]?.loyalty ?? -1,
      rngState: resolved.rngState,
      s1Reports: resolved.reportsBySeat.s1,
      s6Reports: resolved.reportsBySeat.s6,
    };
  };

  const s1StrongFirst = runContestedAttack(20, 4, ['s1', 's6']);
  const s1StrongSecond = runContestedAttack(20, 4, ['s6', 's1']);
  assert.equal(s1StrongFirst.owner, 's1');
  assert.deepEqual(s1StrongFirst, s1StrongSecond);
  assert.equal(runContestedAttack(4, 20, ['s1', 's6']).owner, 's6');
  assert.equal(runContestedAttack(4, 20, ['s6', 's1']).owner, 's6');
  assert.equal(runContestedAttack(12, 12, ['s1', 's6']).owner, null);
  assert.equal(runContestedAttack(12, 12, ['s6', 's1']).owner, null);

  const reinforceSpec: WargamesMatchSpec = { ...buildTestSpec(), rulesVersion: 'v2' };
  const reinforceState = createInitialMatchState('wg-v2-reinf', 2000, reinforceSpec);
  const s1Home = reinforceState.villages.find((village) => village?.owner === 's1');
  const s2Home = reinforceState.villages.find((village) => village?.owner === 's2');
  assert.ok(s1Home && s2Home);
  s1Home.troops = { raider: 0, guard: 1, envoy: 0 };
  s1Home.loyalty = 40;
  reinforceState.armies.set('army-hostile', {
    id: 'army-hostile',
    owner: 's2',
    status: 'marching',
    originHexIndex: s2Home.hexIndex,
    currentHexIndex: s1Home.hexIndex,
    targetHexIndex: s1Home.hexIndex,
    troops: { raider: 10, guard: 0, envoy: 3 },
    departedTick: 0,
    intendedTargetOwner: 's1',
    scoutedBy: [],
  });
  reinforceState.armies.set('army-friendly', {
    id: 'army-friendly',
    owner: 's1',
    status: 'marching',
    originHexIndex: s1Home.hexIndex,
    currentHexIndex: s1Home.hexIndex,
    targetHexIndex: s1Home.hexIndex,
    troops: { raider: 0, guard: 40, envoy: 0 },
    departedTick: 0,
    intendedTargetOwner: 's1',
    scoutedBy: [],
  });
  const resolvedReinforce = advanceToResolution(reinforceState);
  assert.equal(resolvedReinforce.villages[s1Home.hexIndex]?.owner, 's1');
  assert.ok((resolvedReinforce.villages[s1Home.hexIndex]?.troops.guard ?? 0) > 20);
});

test('v3 charges an attack split into one-troop armies the same losses as one army, and v2 replays its per-army rounding', () => {
  const raidersSent = 20;
  const attackerLossesOf = (rulesVersion: WargamesMatchSpec['rulesVersion'], armySizes: readonly number[]) => {
    const state = createInitialMatchState('wg-split', 1000, { ...buildTestSpec(), rulesVersion });
    const s1Capital = state.villages.find((village) => village?.owner === 's1');
    const neutralVillage = state.villages.find((village) => village && village.owner === null);
    assert.ok(s1Capital && neutralVillage);
    neutralVillage.troops = { raider: 0, guard: 6, envoy: 0 };
    armySizes.forEach((raiders, armyIndex) => {
      state.armies.set(`army-split-${armyIndex}`, {
        id: `army-split-${armyIndex}`,
        owner: 's1',
        status: 'marching',
        originHexIndex: s1Capital.hexIndex,
        currentHexIndex: neutralVillage.hexIndex,
        targetHexIndex: neutralVillage.hexIndex,
        troops: { raider: raiders, guard: 0, envoy: 0 },
        departedTick: 0,
        intendedTargetOwner: null,
        scoutedBy: [],
      });
    });
    const resolved = advanceToResolution(state);
    const [battleReport] = resolved.reportsBySeat.s1;
    assert.ok(battleReport && battleReport.payload.kind === 'battle');
    const raidersStillMarching = [...resolved.armies.values()].reduce((sum, army) => sum + army.troops.raider, 0);
    assert.equal(raidersSent - raidersStillMarching, battleReport.payload.attackerLost.raider);
    return battleReport.payload.attackerLost.raider;
  };
  const oneArmy = [raidersSent];
  const oneTroopArmies = Array.from({ length: raidersSent }, () => 1);

  assert.equal(WARGAMES_RULES_VERSION, 'v7');
  const lostAsOneArmy = attackerLossesOf('v3', oneArmy);
  assert.ok(lostAsOneArmy > 0);
  assert.equal(attackerLossesOf('v3', oneTroopArmies), lostAsOneArmy);
  assert.equal(attackerLossesOf('v2', oneArmy), lostAsOneArmy);
  assert.equal(attackerLossesOf('v2', oneTroopArmies), 0);
});

test('v4 garrisons surviving attackers in captured villages, returns non-capturing raiders, and removes the per-tick message cap', () => {
  const runCapture = (rulesVersion: WargamesMatchSpec['rulesVersion'], envoys: number) => {
    const state = createInitialMatchState('wg-v4-cap', 1000, { ...buildTestSpec(), rulesVersion });
    const s1Capital = state.villages.find((village) => village?.owner === 's1');
    const neutralVillage = state.villages.find((village) => village && village.owner === null);
    assert.ok(s1Capital && neutralVillage);
    neutralVillage.troops = { raider: 0, guard: 2, envoy: 0 };
    state.armies.set('army-capture', {
      id: 'army-capture',
      owner: 's1',
      status: 'marching',
      originHexIndex: s1Capital.hexIndex,
      currentHexIndex: neutralVillage.hexIndex,
      targetHexIndex: neutralVillage.hexIndex,
      troops: { raider: 12, guard: 0, envoy: envoys },
      departedTick: 0,
      intendedTargetOwner: null,
      scoutedBy: [],
    });
    const resolved = advanceToResolution(state);
    return {
      village: resolved.villages[neutralVillage.hexIndex],
      army: resolved.armies.get('army-capture'),
    };
  };

  const v4Captured = runCapture('v4', 4);
  assert.equal(v4Captured.village?.owner, 's1');
  assert.equal(v4Captured.village?.loyalty, 25);
  assert.ok((v4Captured.village?.troops.raider ?? 0) > 0);
  assert.equal(v4Captured.army?.status, 'home');
  assert.equal(v4Captured.army?.troops.raider, 0);

  const v4RaidOnly = runCapture('v4', 0);
  assert.equal(v4RaidOnly.village?.owner, null);
  assert.equal(v4RaidOnly.army?.status, 'returning');
  assert.ok((v4RaidOnly.army?.troops.raider ?? 0) > 0);

  const v3Captured = runCapture('v3', 4);
  assert.equal(v3Captured.village?.owner, 's1');
  assert.equal(v3Captured.village?.troops.raider, 0);
  assert.equal(v3Captured.army?.status, 'returning');

  const sendThreeMessages = (rulesVersion: WargamesMatchSpec['rulesVersion']) => {
    const spec = { ...buildTestSpec(), rulesVersion };
    let state = createInitialMatchState('wg-v4-msg', 1000, spec);
    let seq = 1;
    const apply = (event: WargamesEvent) => {
      const appliedOutcome = applyEvent(state, event);
      seq += 1;
      if (appliedOutcome.ok) state = appliedOutcome.state;
      return appliedOutcome;
    };
    assert.equal(apply({ seq, type: 'seating_started' }).ok, true);
    for (const seatId of WARGAMES_SEAT_IDS) {
      assert.equal(apply({ seq, type: 'seat_connected', seatId }).ok, true);
    }
    assert.equal(apply({ seq, type: 'message_sent', seatId: 's1', channel: 'dm', to: 's2', text: 'one', attachedReport: null }).ok, true);
    assert.equal(apply({ seq, type: 'message_sent', seatId: 's1', channel: 'dm', to: 's3', text: 'two', attachedReport: null }).ok, true);
    return apply({ seq, type: 'message_sent', seatId: 's1', channel: 'dm', to: 's4', text: 'three', attachedReport: null });
  };

  assert.equal(sendThreeMessages('v4').ok, true);
  const v3Third = sendThreeMessages('v3');
  assert.equal(v3Third.ok, false);
  if (!v3Third.ok) assert.equal(v3Third.rejection.code, 'message_limit_exceeded');

  const checkSqueeze = (rulesVersion: WargamesMatchSpec['rulesVersion']) => {
    const state = createInitialMatchState('wg-v4-squeeze', 1000, { ...buildTestSpec(), rulesVersion });
    const resolved = advanceToResolution(state, WARGAMES_SQUEEZE_TICK);
    const outerHex = ALL_HEXES.find((hex) => hex.ring === 3 && resolved.villages[hex.index] !== null);
    assert.ok(outerHex);
    return resolved.villages[outerHex.index]?.productionState;
  };
  assert.equal(checkSqueeze('v4'), 'producing');
  assert.equal(checkSqueeze('v3'), 'barren');
});

test('customizable mapRadius deterministically generates larger symmetric grids and steps armies across them', () => {
  for (const radius of [4, 5, 6] as const) {
    const expectedHexes = 3 * radius * (radius + 1) + 1;
    const spec = WargamesMatchSpec.parse({ ...buildTestSpec(), rulesVersion: 'v4', mapRadius: radius });
    const firstState = createInitialMatchState(`wg-r${radius}-a`, 1000, spec);
    const secondState = createInitialMatchState(`wg-r${radius}-b`, 1000, spec);
    assert.equal(firstState.hexes.length, expectedHexes);
    assert.equal(firstState.villages.length, expectedHexes);
    assert.deepEqual(firstState.villages, secondState.villages);
    for (const seatId of WARGAMES_SEAT_IDS) {
      const owned = firstState.villages.filter((village) => village?.owner === seatId);
      assert.equal(owned.length, 3);
    }
    const barbarians = firstState.villages.filter((village) => village !== null && village.owner === null);
    assert.ok(barbarians.length >= 19);
  }

  const radiusFourSpec = WargamesMatchSpec.parse({ ...buildTestSpec(), rulesVersion: 'v4', mapRadius: 4 });
  const marchState = createInitialMatchState('wg-r4-march', 1000, radiusFourSpec);
  const s1Home = marchState.villages.find((village) => village?.owner === 's1');
  const centerIndex = hexIndexAt(0, 0, 4);
  assert.ok(s1Home && centerIndex >= 0);
  marchState.armies.set('army-r4', {
    id: 'army-r4',
    owner: 's1',
    status: 'marching',
    originHexIndex: s1Home.hexIndex,
    currentHexIndex: s1Home.hexIndex,
    targetHexIndex: centerIndex,
    troops: { raider: 4, guard: 0, envoy: 0 },
    departedTick: 0,
    intendedTargetOwner: null,
    scoutedBy: [],
  });
  const stepped = advanceToResolution(marchState);
  const movedArmy = stepped.armies.get('army-r4');
  assert.ok(movedArmy);
  assert.notEqual(movedArmy.currentHexIndex, s1Home.hexIndex);
});

test('v5 populates dense maps, scales victory goal with mapRadius, and projects 2-deep owner-only border intel', () => {
  const expectedByRadius = [
    { radius: 3, villages: 31, goal: 12 },
    { radius: 4, villages: 55, goal: 22 },
    { radius: 5, villages: 85, goal: 34 },
  ] as const;

  for (const { radius, villages, goal } of expectedByRadius) {
    const spec = WargamesMatchSpec.parse({ ...buildTestSpec(), rulesVersion: 'v5', mapRadius: radius });
    const state = createInitialMatchState(`wg-v5-r${radius}`, 1000, spec);
    const activeVillages = state.villages.filter((village) => village !== null);
    assert.equal(activeVillages.length, villages);
    assert.equal(victoryVillagesFor(spec), goal);
  }

  assert.equal(victoryVillagesFor(WargamesMatchSpec.parse({ ...buildTestSpec(), rulesVersion: 'v4', mapRadius: 4 })), 12);

  const r4Spec = WargamesMatchSpec.parse({ ...buildTestSpec(), rulesVersion: 'v5', mapRadius: 4 });
  const r4State = createInitialMatchState('wg-v5-vision', 1000, r4Spec);
  const s1View = projectSeatState(r4State, 's1');
  assert.equal(s1View.visibleVillages.length, 3);
  assert.equal(s1View.visibleVillages.every((village) => village.owner === 's1'), true);
  assert.ok(s1View.nearbyHexOwners.length > 0);
  for (const entry of s1View.nearbyHexOwners) {
    assert.deepEqual(Object.keys(entry).sort(), ['hexIndex', 'owner']);
    const targetTile = r4State.hexes[entry.hexIndex];
    const minDist = Math.min(
      ...s1View.visibleVillages.map((owned) => {
        const ownedTile = r4State.hexes[owned.hexIndex];
        return Math.max(
          Math.abs(ownedTile.q - targetTile.q),
          Math.abs(ownedTile.r - targetTile.r),
          Math.abs((-ownedTile.q - ownedTile.r) - (-targetTile.q - targetTile.r)),
        );
      }),
    );
    assert.ok(minDist >= 1 && minDist <= 2);
  }
});

test('4-seat matches seat s1 to s4 on an even dense map, refuse other seat sets, and refuse seats outside the match', () => {
  const sixSeatSpec = buildTestSpec();
  const fourSeatInput = { ...sixSeatSpec, rulesVersion: 'v5', seats: sixSeatSpec.seats.slice(0, 4) };
  assert.equal(WargamesMatchSpec.safeParse({ ...fourSeatInput, seats: sixSeatSpec.seats.slice(0, 5) }).success, false);
  assert.equal(WargamesMatchSpec.safeParse({ ...fourSeatInput, seats: [...sixSeatSpec.seats.slice(0, 3), sixSeatSpec.seats[4]] }).success, false);

  for (const mapRadius of [4, 6, 8]) {
    const spec = WargamesMatchSpec.parse({ ...fourSeatInput, mapRadius });
    const state = createInitialMatchState(`wg-four-r${mapRadius}`, 1000, spec);
    assert.deepEqual(state.seats.map((seat) => seat.config.seatId), ['s1', 's2', 's3', 's4']);
    const hexCount = 3 * mapRadius * (mapRadius + 1) + 1;
    assert.equal(state.villages.filter((village) => village !== null).length, hexCount - 6);
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
  const log: WargamesEvent[] = [];
  let state = createInitialMatchState('wg-four-play', 1000, WargamesMatchSpec.parse({ ...fourSeatInput, mapRadius: 6 }));
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
  const outsidePartner = applyEvent(state, { seq: seq + 1, type: 'orders_submitted', seatId: 's1', orders: [{ kind: 'tribe_join', partner: 's5' }] }, signer);
  assert.equal(outsidePartner.ok ? null : outsidePartner.rejection.code, 'invalid_target');

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
});

const playEmptyTurn = (state: MatchState, signer: ReturnType<typeof createTestSigner>, seqStart: number): { state: MatchState; seq: number } => {
  let current = state;
  let seq = seqStart;
  const apply = (event: Record<string, unknown>) => {
    seq += 1;
    const outcome = applyEvent(current, { ...event, seq } as WargamesEvent, signer);
    assert.equal(outcome.ok, true);
    if (outcome.ok) current = outcome.state;
  };
  apply({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
  apply({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
  for (const seat of current.seats) apply({ type: 'orders_submitted', seatId: seat.config.seatId, orders: [] });
  apply({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
  if (current.status === 'running') apply({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
  return { state: current, seq };
};

const startFourSeatMatch = (rulesVersion: 'v5' | 'v6') => {
  const spec = WargamesMatchSpec.parse({ ...buildTestSpec(), rulesVersion, mapRadius: 4, seats: buildTestSpec().seats.slice(0, 4) });
  let state = createInitialMatchState(`wg-goal-${rulesVersion}`, 1000, spec);
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

test('v5 still ends on its village goal, while v6 scores victory points each turn, counts a beacon only while garrisoned, and ends when a seat reaches the target', () => {
  const v5 = startFourSeatMatch('v5');
  let granted = v5.state.villages.filter((village) => village?.owner === 's1').length;
  for (const village of v5.state.villages) {
    if (granted >= victoryVillagesFor(v5.spec) || village === null || village.owner !== null) continue;
    village.owner = 's1';
    granted += 1;
  }
  const v5AfterTurn = playEmptyTurn(v5.state, v5.signer, v5.seq).state;
  assert.equal(v5AfterTurn.status, 'finished');
  assert.equal(v5AfterTurn.winnerSeatId, 's1');

  const v6 = startFourSeatMatch('v6');
  const beacon = v6.state.villages.find((village) => village?.isBeacon);
  assert.ok(beacon);
  beacon.owner = 's1';
  beacon.troops = { raider: 0, guard: 1, envoy: 0 };
  const homeVillages = v6.state.villages.filter((village) => village?.owner === 's1').length - 1;
  const firstTurn = playEmptyTurn(v6.state, v6.signer, v6.seq);
  assert.equal(firstTurn.state.status, 'running');
  const beaconPoints = v6.state.balance.victory.kind === 'points' ? v6.state.balance.victory.beaconPoints : 0;
  const firstTurnPoints = firstTurn.state.victoryPointsBySeat;
  assert.ok(firstTurnPoints.s2 >= homeVillages);
  assert.deepEqual(firstTurnPoints, { s1: firstTurnPoints.s2 + beaconPoints, s2: firstTurnPoints.s2, s3: firstTurnPoints.s2, s4: firstTurnPoints.s2 });
  assert.deepEqual(projectSeatState(firstTurn.state, 's2').victoryPointsBySeat, firstTurn.state.victoryPointsBySeat);

  const heldBeacon = firstTurn.state.villages[beacon.hexIndex];
  assert.ok(heldBeacon);
  heldBeacon.troops = { raider: 0, guard: 0, envoy: 0 };
  const secondTurn = playEmptyTurn(firstTurn.state, v6.signer, firstTurn.seq);
  assert.equal(secondTurn.state.villages[beacon.hexIndex]?.owner, null);
  const secondTurnGain = secondTurn.state.victoryPointsBySeat.s2 - firstTurnPoints.s2;
  assert.equal(secondTurn.state.victoryPointsBySeat.s1, firstTurnPoints.s1 + secondTurnGain);

  const target = projectSeatState(secondTurn.state, 's1').victoryPointTarget;
  assert.ok(target !== null);
  secondTurn.state.victoryPointsBySeat.s2 = target - secondTurnGain;
  const thirdTurn = playEmptyTurn(secondTurn.state, v6.signer, secondTurn.seq);
  assert.equal(thirdTurn.state.status, 'finished');
  assert.equal(thirdTurn.state.winnerSeatId, 's2');
});

test('v6 terrain on Large and Huge is seeded, the same around every seat, never under a village and in seat vision, while Standard stays plain', () => {
  for (const seatCount of [4, 6] as const) {
    for (const mapRadius of [6, 8]) {
      const spec = WargamesMatchSpec.parse({ ...buildTestSpec(777001), rulesVersion: 'v6', mapRadius, seats: buildTestSpec().seats.slice(0, seatCount) });
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
    }
  }
  const standard = createInitialMatchState('wg-standard', 0, WargamesMatchSpec.parse({ ...buildTestSpec(), rulesVersion: 'v6', mapRadius: 4 }));
  assert.equal(standard.terrain.every((kind) => kind === 'plain'), true);
});

test('v6 trade credit never lands in a beacon, so a beacon reverting to unowned takes no goods with it', () => {
  const match = startFourSeatMatch('v6');
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

test('v7 folds an allied support march into the ally attack, garrisons an ally village, and leaves unallied joint attackers competing', () => {
  const runSupportedAttack = ({ isAllied, isSupport }: { isAllied: boolean; isSupport: boolean }) => {
    const spec: WargamesMatchSpec = { ...buildTestSpec(), rulesVersion: 'v7' };
    const state = createInitialMatchState('wg-v7-support', 1000, spec);
    const s1Capital = state.villages.find((village) => village?.owner === 's1');
    const s2Capital = state.villages.find((village) => village?.owner === 's2');
    const neutralVillage = state.villages.find((village) => village && village.owner === null);
    assert.ok(s1Capital && s2Capital && neutralVillage);
    neutralVillage.troops = { raider: 0, guard: 30, envoy: 0 };
    neutralVillage.loyalty = 40;
    if (isAllied) {
      state.contracts.set('ctr-ally', {
        id: 'ctr-ally',
        proposer: 's1',
        counterparty: 's2',
        terms: { kind: 'alliance', counterparty: 's2', durationTicks: 5, collateral: { grain: 0, ore: 0 } },
        status: 'active',
        proposedTick: 1,
        activatedTick: 1,
        endTick: 10,
        breachedBy: null,
        breachedTick: null,
      });
    }
    const marchingArmy = (owner: 's1' | 's2', originHexIndex: number, troops: { raider: number; guard: number; envoy: number }) => ({
      id: `army-${owner}`,
      owner,
      status: 'marching' as const,
      originHexIndex,
      currentHexIndex: neutralVillage.hexIndex,
      targetHexIndex: neutralVillage.hexIndex,
      troops,
      departedTick: 0,
      intendedTargetOwner: null,
      scoutedBy: [],
    });
    state.armies.set('army-s1', marchingArmy('s1', s1Capital.hexIndex, { raider: 16, guard: 0, envoy: 4 }));
    state.armies.set('army-s2', { ...marchingArmy('s2', s2Capital.hexIndex, { raider: 40, guard: 0, envoy: 0 }), ...(isSupport ? { supporting: 's1' as const } : {}) });
    const resolved = advanceToResolution(state);
    return {
      owner: resolved.villages[neutralVillage.hexIndex]?.owner ?? null,
      s1Status: resolved.armies.get('army-s1')?.status,
      s2Status: resolved.armies.get('army-s2')?.status,
      s2Reports: resolved.reportsBySeat.s2.length,
    };
  };

  const allied = runSupportedAttack({ isAllied: true, isSupport: true });
  assert.equal(allied.owner, 's1');
  assert.equal(allied.s2Status, 'returning');
  assert.equal(allied.s2Reports, 1);

  const supportWithoutAlliance = runSupportedAttack({ isAllied: false, isSupport: true });
  assert.equal(supportWithoutAlliance.owner, null);
  assert.equal(supportWithoutAlliance.s1Status, 'destroyed');
  assert.equal(supportWithoutAlliance.s2Reports, 0);

  const unalliedJointAttack = runSupportedAttack({ isAllied: false, isSupport: false });
  assert.equal(unalliedJointAttack.s1Status, 'destroyed');
  assert.equal(unalliedJointAttack.owner, null);

  const garrisonSpec: WargamesMatchSpec = { ...buildTestSpec(), rulesVersion: 'v7' };
  const garrisonState = createInitialMatchState('wg-v7-garrison', 2000, garrisonSpec);
  const s1Home = garrisonState.villages.find((village) => village?.owner === 's1');
  const s2Home = garrisonState.villages.find((village) => village?.owner === 's2');
  assert.ok(s1Home && s2Home);
  const guardsBefore = s1Home.troops.guard;
  garrisonState.contracts.set('ctr-ally', {
    id: 'ctr-ally', proposer: 's2', counterparty: 's1',
    terms: { kind: 'alliance', counterparty: 's1', durationTicks: 5, collateral: { grain: 0, ore: 0 } },
    status: 'active', proposedTick: 1, activatedTick: 1, endTick: 10, breachedBy: null, breachedTick: null,
  });
  garrisonState.armies.set('army-guard', {
    id: 'army-guard', owner: 's2', status: 'marching', originHexIndex: s2Home.hexIndex,
    currentHexIndex: s1Home.hexIndex, targetHexIndex: s1Home.hexIndex,
    troops: { raider: 0, guard: 12, envoy: 0 }, departedTick: 0, intendedTargetOwner: 's1', scoutedBy: [], supporting: 's1',
  });
  const garrisoned = advanceToResolution(garrisonState);
  assert.equal(garrisoned.villages[s1Home.hexIndex]?.troops.guard, guardsBefore + 12);
  assert.equal(garrisoned.ledger.length, 0);
  assert.equal(garrisoned.contracts.get('ctr-ally')?.status, 'active');
});

test('v7 breaches an alliance on attack, opens the public channel, and swaps the NAP for the alliance', () => {
  const spec: WargamesMatchSpec = { ...buildTestSpec(), rulesVersion: 'v7' };
  const resolveBetrayal = (isAllied: boolean, isBetrayal: boolean) => {
    const state = createInitialMatchState('wg-v7-breach', 3000, spec);
    const s1Home = state.villages.find((village) => village?.owner === 's1');
    const s2Home = state.villages.find((village) => village?.owner === 's2');
    assert.ok(s1Home && s2Home);
    if (isAllied) {
      state.contracts.set('ctr-ally', {
        id: 'ctr-ally', proposer: 's1', counterparty: 's2',
        terms: { kind: 'alliance', counterparty: 's2', durationTicks: 5, collateral: { grain: 10, ore: 10 } },
        status: 'active', proposedTick: 1, activatedTick: 1, endTick: 10, breachedBy: null, breachedTick: null,
      });
    }
    if (!isBetrayal) return advanceToResolution(state, 6);
    state.armies.set('army-betray', {
      id: 'army-betray', owner: 's2', status: 'marching', originHexIndex: s2Home.hexIndex,
      currentHexIndex: s1Home.hexIndex, targetHexIndex: s1Home.hexIndex,
      troops: { raider: 5, guard: 0, envoy: 0 }, departedTick: 0, intendedTargetOwner: 's1', scoutedBy: [],
    });
    return advanceToResolution(state, 6);
  };
  const resolved = resolveBetrayal(true, true);
  const unallied = resolveBetrayal(false, true);
  assert.equal(resolved.victoryPointsBySeat.s1 - unallied.victoryPointsBySeat.s1, 10);
  assert.equal(resolved.victoryPointsBySeat.s2, unallied.victoryPointsBySeat.s2);
  const keptTurn = resolveBetrayal(true, false);
  const unalliedTurn = resolveBetrayal(false, false);
  assert.equal(keptTurn.victoryPointsBySeat.s1 - unalliedTurn.victoryPointsBySeat.s1, 2);
  assert.equal(keptTurn.victoryPointsBySeat.s2 - unalliedTurn.victoryPointsBySeat.s2, 2);
  assert.equal(resolved.contracts.get('ctr-ally')?.status, 'breached');
  assert.deepEqual(resolved.ledger.map((entry) => [entry.breacher, entry.victim]), [['s2', 's1']]);
  const reputationSeenByS3 = projectSeatState(resolved, 's3').reputation;
  assert.deepEqual(reputationSeenByS3.find((entry) => entry.seatId === 's2'), { seatId: 's2', kept: 0, broken: 1 });
  let afterBreach = resolved;
  const applyAfterBreach = (event: EventWithoutSeq<WargamesEvent>) => {
    const applied = applyEvent(afterBreach, { ...event, seq: afterBreach.lastSeq + 1 } as WargamesEvent, lengthSigner);
    assert.equal(applied.ok, true, applied.ok ? '' : applied.rejection.message);
    if (applied.ok) afterBreach = applied.state;
  };
  applyAfterBreach({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
  applyAfterBreach({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
  applyAfterBreach({ type: 'contract_proposed', seatId: 's2', contractId: 'ctr-next', terms: { kind: 'alliance', counterparty: 's3', durationTicks: 2, collateral: { grain: 10, ore: 10 } } });
  applyAfterBreach({ type: 'contract_accepted', seatId: 's3', contractId: 'ctr-next' });
  assert.deepEqual(afterBreach.contracts.get('ctr-next')?.lockedCollateral, { proposer: { grain: 20, ore: 20 }, counterparty: { grain: 10, ore: 10 } });

  const talkState = createInitialMatchState('wg-v7-talk', 4000, spec);
  let running = talkState;
  const applyNext = (event: EventWithoutSeq<WargamesEvent>) => applyEvent(running, { ...event, seq: running.lastSeq + 1 } as WargamesEvent, lengthSigner);
  for (const event of [{ type: 'seating_started' as const }, ...WARGAMES_SEAT_IDS.map((seatId) => ({ type: 'seat_connected' as const, seatId }))]) {
    const applied = applyNext(event);
    assert.equal(applied.ok, true);
    if (applied.ok) running = applied.state;
  }
  const publicMessage = applyNext({ type: 'message_sent', seatId: 's1', to: null, channel: 'public', text: 'Who holds the center?', attachedReport: null });
  assert.equal(publicMessage.ok, true);
  const v6Public = applyEvent({ ...running, spec: { ...running.spec, rulesVersion: 'v6' } }, { seq: running.lastSeq + 1, type: 'message_sent', seatId: 's1', to: null, channel: 'public', text: 'hello', attachedReport: null }, lengthSigner);
  assert.equal(v6Public.ok, false);

  const toContracts = applyNext({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
  assert.ok(toContracts.ok);
  if (!toContracts.ok) return;
  running = toContracts.state;
  const napProposal = applyNext({ type: 'contract_proposed', seatId: 's1', contractId: 'ctr-nap', terms: { kind: 'nap', counterparty: 's2', durationTicks: 3, collateral: { grain: 0, ore: 0 } } });
  assert.equal(napProposal.ok, false);
  const allianceProposal = applyNext({ type: 'contract_proposed', seatId: 's1', contractId: 'ctr-alliance', terms: { kind: 'alliance', counterparty: 's2', durationTicks: 3, collateral: { grain: 0, ore: 0 } } });
  assert.equal(allianceProposal.ok, true);
  if (!allianceProposal.ok) return;
  running = allianceProposal.state;
  const stackedAlliance = applyNext({ type: 'contract_proposed', seatId: 's2', contractId: 'ctr-stacked', terms: { kind: 'alliance', counterparty: 's1', durationTicks: 3, collateral: { grain: 0, ore: 0 } } });
  assert.equal(stackedAlliance.ok, false);
});
