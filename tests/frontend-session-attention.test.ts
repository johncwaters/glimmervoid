import assert from 'node:assert/strict';
import test from 'node:test';
import { STATES } from '../shared/states.ts';
import { buildSessionRows, countSessionsNeedingAttention, needsAttention, sessionAttentionRank, sessionAttentionTier } from '../public/focus-view/attention-core.ts';
import type { SessionAttentionOption, SessionAttentionTier } from '../public/focus-view/attention-core.ts';
import { orderSessionsForTriage } from '../public/phone/triage-core.ts';
import { orderCalmQueue, tierOf } from '../public/calm/calm-priority-core.ts';
import { decideFaviconVariant } from '../public/favicon-core.ts';

const currentTiersByState: Record<string, readonly SessionAttentionTier[]> = {
  WAITING: ['now', 'now', 'now', 'now'],
  FAILED: ['resting', 'next', 'next', 'resting'],
  COMPLETE: ['resting', 'later', 'later', 'later'],
  IDLE: ['resting', 'resting', 'ready', 'resting'],
  RUNNING: ['resting', 'working', 'working', 'resting'],
  STARTING: ['resting', 'resting', 'working', 'resting'],
  INITIALIZING: ['resting', 'resting', 'working', 'resting'],
  DORMANT: ['resting', 'resting', 'resting', 'resting'],
  DONE: ['resting', 'resting', 'resting', 'resting'],
};
const attentionOptions: readonly SessionAttentionOption[] = ['needs-you', 'phone-triage', 'calm', 'favicon'];

test('named attention options preserve each surface choice for every built-in session state', () => {
  assert.deepEqual(Object.keys(currentTiersByState).sort(), Object.values(STATES).sort());
  for (const state of Object.values(STATES)) {
    assert.deepEqual(attentionOptions.map((option) => sessionAttentionTier({ state }, option)), currentTiersByState[state], state);
  }
});

test('FAILED stays out of the shared readout and favicon while Board ordering and Calm prioritize it', () => {
  const failed = { id: 'failed', name: 'Failed session', state: STATES.FAILED, unseen: true };
  const running = { id: 'running', name: 'Running session', state: STATES.RUNNING };
  assert.equal(needsAttention(failed), false);
  assert.equal(countSessionsNeedingAttention([failed]), 0);
  assert.equal(decideFaviconVariant([failed]), 'idle');
  assert.deepEqual(orderSessionsForTriage([running, failed]).map(({ id }) => id), ['failed', 'running']);
  assert.equal(tierOf(failed), 'next');
  assert.deepEqual(orderCalmQueue([running, failed]).map(({ id }) => id), ['failed']);
});

test('COMPLETE needs an unseen flag only in the readout while Board, Calm and favicon retain completion', () => {
  for (const unseen of [undefined, false, true]) {
    const completed = { id: 'completed', name: 'Completed session', state: STATES.COMPLETE, unseen };
    assert.equal(needsAttention(completed), unseen === true);
    assert.equal(sessionAttentionTier(completed, 'needs-you'), unseen === true ? 'later' : 'resting');
    assert.equal(sessionAttentionTier(completed, 'phone-triage'), 'later');
    assert.equal(tierOf(completed), 'later');
    assert.equal(decideFaviconVariant([completed]), 'complete');
  }
});

test('only Calm treats an ended IDLE turn as queued work and keeps an unstarted IDLE session ready', () => {
  for (const hasEndedTurn of [undefined, false, true]) {
    const idle = { id: 'idle', name: 'Idle session', state: STATES.IDLE, hasEndedTurn, unseen: true };
    assert.equal(tierOf(idle), hasEndedTurn === true ? 'later' : 'ready');
    assert.equal(needsAttention(idle), false);
    assert.equal(sessionAttentionTier(idle, 'phone-triage'), 'resting');
    assert.equal(decideFaviconVariant([idle]), 'idle');
  }
});

test('Board ranks only RUNNING as working while Calm also recognizes STARTING and INITIALIZING', () => {
  const states = [STATES.IDLE, STATES.STARTING, STATES.DONE, STATES.INITIALIZING, STATES.DORMANT, STATES.RUNNING];
  const rows = states.map((state) => ({ id: state, name: state, state }));
  assert.deepEqual(orderSessionsForTriage(rows).map(({ id }) => id), [STATES.RUNNING, ...states.slice(0, -1)]);
  assert.deepEqual(rows.map(tierOf), ['ready', 'working', 'resting', 'working', 'resting', 'working']);
  assert.deepEqual(orderCalmQueue(rows), []);
});

test('attention conditions require true flags and unfamiliar states stay resting under every option', () => {
  for (const flag of [undefined, null, false, 1, 'true']) {
    assert.equal(sessionAttentionTier({ state: STATES.COMPLETE, unseen: flag }, 'needs-you'), 'resting');
    assert.equal(sessionAttentionTier({ state: STATES.IDLE, hasEndedTurn: flag }, 'calm'), 'ready');
  }
  for (const state of [undefined, null, '', 'UNKNOWN', 42, {}]) {
    for (const option of attentionOptions) {
      assert.equal(sessionAttentionTier({ state, unseen: true, hasEndedTurn: true }, option), 'resting');
    }
  }
});

test('favicon preserves waiting priority and accepts absent or malformed session collections', () => {
  assert.equal(decideFaviconVariant([{ state: STATES.FAILED }, { state: STATES.COMPLETE }, { state: STATES.WAITING }]), 'waiting');
  assert.equal(decideFaviconVariant([null, undefined, { state: STATES.FAILED }, { state: STATES.COMPLETE }]), 'complete');
  for (const sessions of [undefined, null, {}, 'WAITING']) assert.equal(decideFaviconVariant(sessions), 'idle');
});

test('named ranking preserves waiting, failure, completion and working priority without promoting unseen live states', () => {
  const states = [STATES.WAITING, STATES.FAILED, STATES.COMPLETE, STATES.RUNNING, STATES.IDLE];
  for (let index = 1; index < states.length; index += 1) {
    assert.ok(sessionAttentionRank({ state: states[index - 1] }, 'phone-triage') < sessionAttentionRank({ state: states[index] }, 'phone-triage'));
  }
  assert.equal(sessionAttentionTier({ state: STATES.RUNNING, unseen: true }, 'needs-you'), 'resting');
});

test('row snapshots preserve stable ids, source references and layout-specific names without changing their order', () => {
  const firstSession = { currentState: STATES.RUNNING, railName: 'Session 10', cardName: 'Renamed card' };
  const secondSession = { currentState: STATES.DORMANT, railName: null, cardName: '' };
  const sessions = new Map<string, { currentState: string; railName: string | null; cardName: string }>([
    ['first-id', firstSession], ['second-id', secondSession],
  ]);
  const railRows = buildSessionRows(sessions, (session) => session.railName);
  const boardRows = buildSessionRows(sessions, (session) => session.cardName);
  assert.deepEqual(railRows, [
    { id: 'first-id', ui: firstSession, name: 'Session 10', isDormant: false, state: STATES.RUNNING, unseen: false },
    { id: 'second-id', ui: secondSession, name: null, isDormant: true, state: STATES.DORMANT, unseen: false },
  ]);
  assert.deepEqual(boardRows.map(({ id, name }) => ({ id, name })), [
    { id: 'first-id', name: 'Renamed card' }, { id: 'second-id', name: '' },
  ]);
  assert.equal(railRows[0].ui, firstSession);
  assert.equal(boardRows[1].ui, secondSession);
  railRows[0].unseen = true;
  assert.equal(boardRows[0].unseen, false);
  assert.deepEqual([...sessions.keys()], ['first-id', 'second-id']);
  assert.deepEqual(firstSession, { currentState: STATES.RUNNING, railName: 'Session 10', cardName: 'Renamed card' });
});

test('row snapshots default absent states to dormant while retaining unknown and known non-dormant states', () => {
  for (const currentState of [...Object.values(STATES), undefined, null, '', 'UNKNOWN']) {
    const rows = buildSessionRows([['id', { currentState }]], () => 'Session');
    assert.equal(rows[0].state, currentState || STATES.DORMANT);
    assert.equal(rows[0].isDormant, !currentState || currentState === STATES.DORMANT);
    assert.equal(rows[0].unseen, false);
  }
  assert.deepEqual(buildSessionRows([], () => 'Session'), []);
});
