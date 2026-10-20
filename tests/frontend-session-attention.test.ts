import assert from 'node:assert/strict';
import test from 'node:test';
import { STATES } from '../shared/states.ts';
import { buildSessionRows, countAttentionByKind, needsAttention, orderAttentionQueue, sessionAttentionTier } from '../public/focus-view/attention-core.ts';
import type { SessionAttentionTier } from '../public/focus-view/attention-core.ts';
import { decideFaviconVariant } from '../public/favicon-core.ts';

const currentTierByState: Record<string, SessionAttentionTier> = {
  WAITING: 'now',
  FAILED: 'resting',
  COMPLETE: 'later',
  IDLE: 'resting',
  RUNNING: 'resting',
  STARTING: 'resting',
  INITIALIZING: 'resting',
  DORMANT: 'resting',
  DONE: 'resting',
};

test('every built-in session state has one attention tier shared by the rail and the Board', () => {
  assert.deepEqual(Object.keys(currentTierByState).sort(), Object.values(STATES).sort());
  for (const state of Object.values(STATES)) {
    assert.equal(sessionAttentionTier({ state }), currentTierByState[state], state);
  }
});

test('an unseen failure joins the jump queue and marks the favicon until the operator sees it', () => {
  const failed = { id: 'failed', name: 'Failed session', state: STATES.FAILED, unseenOutcome: 'failed' };
  assert.equal(needsAttention(failed), true);
  assert.deepEqual(orderAttentionQueue([failed]), ['failed']);
  assert.deepEqual(countAttentionByKind([failed]), { waitingCount: 0, finishedCount: 0, failedCount: 1 });
  assert.equal(decideFaviconVariant([failed]), 'failed');

  const seenFailed = { ...failed, unseenOutcome: null };
  assert.equal(needsAttention(seenFailed), false);
  assert.deepEqual(orderAttentionQueue([seenFailed]), []);
  assert.equal(decideFaviconVariant([seenFailed]), 'idle');
});

test('an unseen finish counts in the readout through a background-driven turn but never marks the favicon', () => {
  const completed = { id: 'completed', name: 'Completed session', state: STATES.COMPLETE, unseenOutcome: 'finished' };
  const monitoring = { ...completed, id: 'monitoring', state: STATES.RUNNING };
  assert.equal(needsAttention(completed), true);
  assert.deepEqual(orderAttentionQueue([completed, monitoring]), ['completed', 'monitoring']);
  assert.deepEqual(countAttentionByKind([monitoring]), { waitingCount: 0, finishedCount: 1, failedCount: 0 });
  assert.equal(decideFaviconVariant([completed]), 'idle');
});

test('unfamiliar states stay resting', () => {
  for (const state of [undefined, null, '', 'UNKNOWN', 42, {}]) {
    assert.equal(sessionAttentionTier({ state }), 'resting');
  }
});

test('favicon preserves waiting priority and accepts absent or malformed session collections', () => {
  const unseenFailure = { state: STATES.FAILED, unseenOutcome: 'failed' };
  const unseenFinish = { state: STATES.COMPLETE, unseenOutcome: 'finished' };
  assert.equal(decideFaviconVariant([unseenFailure, unseenFinish, { state: STATES.WAITING }]), 'waiting');
  assert.equal(decideFaviconVariant([null, undefined, unseenFailure, unseenFinish]), 'failed');
  for (const sessions of [undefined, null, {}, 'WAITING']) assert.equal(decideFaviconVariant(sessions), 'idle');
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
    { id: 'first-id', ui: firstSession, name: 'Session 10', isDormant: false, state: STATES.RUNNING, unseenOutcome: null, ownerId: null },
    { id: 'second-id', ui: secondSession, name: null, isDormant: true, state: STATES.DORMANT, unseenOutcome: null, ownerId: null },
  ]);
  assert.deepEqual(boardRows.map(({ id, name }) => ({ id, name })), [
    { id: 'first-id', name: 'Renamed card' }, { id: 'second-id', name: '' },
  ]);
  assert.equal(railRows[0].ui, firstSession);
  assert.equal(boardRows[1].ui, secondSession);
  railRows[0].name = 'Mutated';
  assert.equal(boardRows[0].name, 'Renamed card');
  assert.deepEqual([...sessions.keys()], ['first-id', 'second-id']);
  assert.deepEqual(firstSession, { currentState: STATES.RUNNING, railName: 'Session 10', cardName: 'Renamed card' });
});

test('row snapshots default absent states to dormant while retaining unknown and known non-dormant states', () => {
  for (const currentState of [...Object.values(STATES), undefined, null, '', 'UNKNOWN']) {
    const rows = buildSessionRows([['id', { currentState }]], () => 'Session');
    assert.equal(rows[0].state, currentState || STATES.DORMANT);
    assert.equal(rows[0].isDormant, !currentState || currentState === STATES.DORMANT);
  }
  assert.deepEqual(buildSessionRows([], () => 'Session'), []);
});
