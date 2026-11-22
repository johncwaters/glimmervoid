import './helpers/isolate-home.ts';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WARGAMES_HEX_COUNT,
  WARGAMES_NOTE_MAX_BYTES,
  WARGAMES_SEAT_IDS,
  WARGAMES_SQUEEZE_TICK,
  WargamesMatchSpec,
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
