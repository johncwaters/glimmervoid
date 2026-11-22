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
} from '../shared/wargames/engine.ts';
import type { ReportSigner } from '../shared/wargames/engine.ts';
import {
  transitionArmy,
  transitionContract,
  transitionMatch,
  transitionSeat,
  transitionTick,
  transitionVillage,
} from '../shared/wargames/machines.ts';
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

test('v2 resolves simultaneous multi-attacker battles order-independently and lands reinforcements first', () => {
  type EventWithoutSeq<Event> = Event extends WargamesEvent ? Omit<Event, 'seq'> : never;
  const signer = {
    sign: (payload: string) => `sig:${payload.length}`,
    verify: (payload: string, signature: string) => signature === `sig:${payload.length}`,
  };
  const advanceToResolution = (state: ReturnType<typeof createInitialMatchState>) => {
    let current = state;
    const applyNext = (event: EventWithoutSeq<WargamesEvent>) => {
      const applied = applyEvent(current, { ...event, seq: current.lastSeq + 1 } as WargamesEvent, signer);
      assert.equal(applied.ok, true);
      if (applied.ok) current = applied.state;
    };
    applyNext({ type: 'seating_started' });
    for (const seatId of WARGAMES_SEAT_IDS) applyNext({ type: 'seat_connected', seatId });
    applyNext({ type: 'phase_advanced', reason: 'deadline', signatures: {} });
    applyNext({ type: 'phase_advanced', reason: 'deadline', signatures: {} });
    applyNext({ type: 'phase_advanced', reason: 'all_submitted', signatures: {} });
    return current;
  };

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

  assert.equal(WARGAMES_RULES_VERSION, 'v2');
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
