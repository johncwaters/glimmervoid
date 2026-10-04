import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnseenCompleteTracker } from '../public/focus-view/unseen-complete-core.ts';

test('first sighting of COMPLETE stays seen, including repeated sightings', () => {
  const tracker = createUnseenCompleteTracker();
  tracker.noteStates([{ id: 'session', state: 'COMPLETE' }]);
  assert.equal(tracker.isUnseen('session'), false);
  tracker.noteStates([{ id: 'session', state: 'COMPLETE' }]);
  assert.equal(tracker.isUnseen('session'), false);
  assert.equal(tracker.isUnseen('missing'), false);
});

test('transition into COMPLETE from a known different state marks unseen and preserves it', () => {
  const tracker = createUnseenCompleteTracker();
  for (const state of ['RUNNING', 'WAITING', 'FAILED', 'UNKNOWN']) {
    tracker.noteStates([{ id: 'session', state }]);
    assert.equal(tracker.isUnseen('session'), false);
    tracker.noteStates([{ id: 'session', state: 'COMPLETE' }]);
    assert.equal(tracker.isUnseen('session'), true);
    tracker.noteStates([{ id: 'session', state: 'COMPLETE' }]);
    assert.equal(tracker.isUnseen('session'), true);
  }
});

test('leaving COMPLETE clears unseen for every non-COMPLETE state', () => {
  const tracker = createUnseenCompleteTracker();
  for (const state of ['RUNNING', 'WAITING', 'FAILED', 'DORMANT', 'DONE', 'UNKNOWN']) {
    tracker.noteStates([{ id: 'session', state: 'RUNNING' }]);
    tracker.noteStates([{ id: 'session', state: 'COMPLETE' }]);
    tracker.noteStates([{ id: 'session', state }]);
    assert.equal(tracker.isUnseen('session'), false);
  }
});

test('acknowledgement clears only the selected id and a new completion can rearm it', () => {
  const tracker = createUnseenCompleteTracker();
  const entries = ['first', 'second'].map((id) => ({ id, state: 'RUNNING' }));
  tracker.noteStates(entries);
  tracker.noteStates(entries.map((entry) => ({ ...entry, state: 'COMPLETE' })));
  tracker.acknowledge('first');
  tracker.acknowledge('missing');
  tracker.noteStates(entries.map((entry) => ({ ...entry, state: 'COMPLETE' })));
  assert.equal(tracker.isUnseen('first'), false);
  assert.equal(tracker.isUnseen('second'), true);
  tracker.noteStates(entries);
  tracker.noteStates(entries.map((entry) => ({ ...entry, state: 'COMPLETE' })));
  assert.equal(tracker.isUnseen('first'), true);
});

test('missing ids are pruned from unseen membership and previous-state memory', () => {
  const tracker = createUnseenCompleteTracker();
  tracker.noteStates([{ id: 'unseen', state: 'RUNNING' }, { id: 'running', state: 'RUNNING' }]);
  tracker.noteStates([{ id: 'unseen', state: 'COMPLETE' }, { id: 'running', state: 'RUNNING' }]);
  tracker.noteStates([]);
  assert.equal(tracker.isUnseen('unseen'), false);
  tracker.noteStates([{ id: 'unseen', state: 'COMPLETE' }, { id: 'running', state: 'COMPLETE' }]);
  assert.equal(tracker.isUnseen('unseen'), false);
  assert.equal(tracker.isUnseen('running'), false);
});
