import assert from 'node:assert/strict';
import test from 'node:test';
import { STATES } from '../shared/states.ts';
import { decideSessionOpenAction, pickRestorableSessionId } from '../public/session-actions-core.ts';
import type { SessionStateSource } from '../public/session-actions-core.ts';

test('opening starts dormant sessions and dismisses completed sessions without restarting live or exited sessions', () => {
  for (const statePolicy of ['explicit-state', 'dormant-fallback'] as const) {
    assert.equal(decideSessionOpenAction(STATES.DORMANT, statePolicy), 'start-session');
    assert.equal(decideSessionOpenAction(STATES.COMPLETE, statePolicy), 'dismiss');
    for (const state of [STATES.INITIALIZING, STATES.STARTING, STATES.RUNNING, STATES.WAITING, STATES.IDLE, STATES.DONE, STATES.FAILED, 'UNKNOWN']) {
      assert.equal(decideSessionOpenAction(state, statePolicy), null, `${statePolicy}: ${state}`);
    }
  }
});

test('opening preserves the rail and phone choices for a missing state', () => {
  for (const currentState of [undefined, null, '']) {
    assert.equal(decideSessionOpenAction(currentState), null);
    assert.equal(decideSessionOpenAction(currentState, 'explicit-state'), null);
    assert.equal(decideSessionOpenAction(currentState, 'dormant-fallback'), 'start-session');
  }
});

test('restoration chooses only the saved existing session and never wakes a dormant session', () => {
  const sessions = new Map<string, SessionStateSource>([
    ['live', { currentState: STATES.RUNNING }],
    ['dormant', { currentState: STATES.DORMANT }],
    ['missing-state', {}],
    ['empty-state', { currentState: '' }],
    ['null-state', { currentState: null }],
  ]);
  assert.equal(pickRestorableSessionId('live', sessions), 'live');
  for (const savedId of [undefined, null, '', 'missing', 'dormant', 'missing-state', 'empty-state', 'null-state']) {
    assert.equal(pickRestorableSessionId(savedId, sessions), null, String(savedId));
  }
  assert.equal(pickRestorableSessionId('live', new Map()), null);
});

test('restoration keeps completed, failed and exited sessions available without selecting another session', () => {
  for (const currentState of Object.values(STATES)) {
    if (currentState === STATES.DORMANT) continue;
    const sessions = new Map([['saved', { currentState }], ['other', { currentState: STATES.RUNNING }]]);
    assert.equal(pickRestorableSessionId('saved', sessions), 'saved', currentState);
  }
  assert.equal(pickRestorableSessionId('saved', new Map([['saved', { currentState: 'UNKNOWN' }]])), 'saved');
});
