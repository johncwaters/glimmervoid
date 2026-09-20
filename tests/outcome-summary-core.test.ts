import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countOutcome,
  drainOutcomeSummary,
  emptyOutcomeCounts,
  LOOP_LAG_REPORT_THRESHOLD_MS,
} from '../server/core/outcome-summary-core.ts';
import { OUTCOME_NAMES } from '../shared/outcome-names.ts';

test('a minute summary carries every counted outcome and none of the untouched ones', () => {
  const counts = emptyOutcomeCounts();
  countOutcome(counts, 'notifyDelivered');
  countOutcome(counts, 'notifyDelivered');
  countOutcome(counts, 'notifyDelivered');
  countOutcome(counts, 'notifyFailed');
  countOutcome(counts, 'hookRejected403');
  countOutcome(counts, 'dataWsOpened');
  countOutcome(counts, 'dataWsClosed');

  const drained = drainOutcomeSummary(counts, null);

  assert.deepEqual(drained.fields, {
    notifyDelivered: 3,
    notifyFailed: 1,
    hookRejected403: 1,
    dataWsOpened: 1,
    dataWsClosed: 1,
  });
});

test('draining resets the counters, so the next minute starts from nothing', () => {
  const counts = emptyOutcomeCounts();
  countOutcome(counts, 'telegramDelivered');
  const drained = drainOutcomeSummary(counts, null);

  assert.deepEqual(drained.fields, { telegramDelivered: 1 });
  assert.deepEqual(drainOutcomeSummary(drained.next, null).fields, null);
});

test('an idle minute under the lag threshold renders no line at all', () => {
  assert.equal(drainOutcomeSummary(emptyOutcomeCounts(), null).fields, null);
  assert.equal(drainOutcomeSummary(emptyOutcomeCounts(), LOOP_LAG_REPORT_THRESHOLD_MS).fields, null);
});

test('loop lag is reported only once it crosses the threshold, rounded to whole milliseconds', () => {
  const quiet = drainOutcomeSummary(emptyOutcomeCounts(), LOOP_LAG_REPORT_THRESHOLD_MS + 0.4);
  assert.deepEqual(quiet.fields, { loopLagP99Ms: LOOP_LAG_REPORT_THRESHOLD_MS });

  const counts = emptyOutcomeCounts();
  countOutcome(counts, 'controlWsOpened');
  const busy = drainOutcomeSummary(counts, 180.6);
  assert.deepEqual(busy.fields, { controlWsOpened: 1, loopLagP99Ms: 181 });
});

test('the summary key order is stable, so a log line reads the same every minute', () => {
  const counts = emptyOutcomeCounts();
  for (const name of [...OUTCOME_NAMES].reverse()) countOutcome(counts, name);
  const drained = drainOutcomeSummary(counts, null);

  assert.deepEqual(Object.keys(drained.fields ?? {}), [...OUTCOME_NAMES]);
});

test('a trust boundary refusal reads apart from a bad token refusal', () => {
  const counts = emptyOutcomeCounts();
  countOutcome(counts, 'hookRejectedNonLoopback');
  countOutcome(counts, 'hookRejectedNonLoopback');
  countOutcome(counts, 'hookRejected403');

  assert.deepEqual(drainOutcomeSummary(counts, null).fields, {
    hookRejected403: 1,
    hookRejectedNonLoopback: 2,
  });
});

test('an unmeasured event loop leaves the lag key off entirely', () => {
  const counts = emptyOutcomeCounts();
  countOutcome(counts, 'hookRejected404');
  assert.deepEqual(drainOutcomeSummary(counts, null).fields, { hookRejected404: 1 });
});
