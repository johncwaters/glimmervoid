import test from 'node:test';
import assert from 'node:assert/strict';

import { BADGE_LABELS, STATES } from '../shared/states.ts';
import { STATUS_LEGEND } from '../public/status-legend-core.ts';

const LIFECYCLE_ORDER = [
  STATES.DORMANT,
  STATES.INITIALIZING,
  STATES.STARTING,
  STATES.RUNNING,
  STATES.RUNNING,
  STATES.WAITING,
  STATES.IDLE,
  STATES.COMPLETE,
  STATES.DONE,
  STATES.FAILED,
];

test('status legend lists every session state in lifecycle order with Monitoring after Working', () => {
  assert.deepEqual(STATUS_LEGEND.map((entry) => entry.state), LIFECYCLE_ORDER);
  assert.deepEqual(STATUS_LEGEND.map((entry) => entry.awaitingBackgroundTasks), LIFECYCLE_ORDER.map((_, index) => index === 4));
});

test('status legend covers each session state exactly once besides the Monitoring pseudo-status', () => {
  const plainStates = STATUS_LEGEND.filter((entry) => !entry.awaitingBackgroundTasks).map((entry) => entry.state);
  assert.deepEqual([...plainStates].sort(), Object.values(STATES).sort());
});

test('status legend names come from BADGE_LABELS and every row has a meaning', () => {
  for (const entry of STATUS_LEGEND) {
    assert.equal(entry.label, entry.awaitingBackgroundTasks ? 'Monitoring' : BADGE_LABELS[entry.state]);
    assert.ok(entry.meaning.length > 0);
  }
});
