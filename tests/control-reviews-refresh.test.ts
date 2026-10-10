import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage } from '../shared/contracts/control-messages.ts';
import type { ReviewsRefreshResult } from '../shared/contracts/reviews.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

function refreshHarness(outcome: ReviewsRefreshResult = { ok: true }) {
  const refreshedLanes: string[] = [];
  const server = createControlServer(controlDeps({ projects: [] }, {
    issues: { refresh: async () => { refreshedLanes.push('issues'); return outcome; } },
    myPrs: {
      mergePr: async () => ({ ok: false, error: 'Unused merge' }),
      refresh: async () => { refreshedLanes.push('my-prs'); return outcome; },
    },
    teamReview: {
      isRunning: () => true,
      submitAction: async () => ({ ok: false, error: 'Unused action' }),
      refresh: async () => { refreshedLanes.push('team-review'); return outcome; },
    },
  }));
  const connection = connectControl<ServerMessage>(server);
  return { connection, refreshedLanes, results: () => connection.sent.filter((frame) => frame.type === 'reviews-refresh-result') };
}

test('Reviews refresh routes to exactly the requested lane and correlates the reply', async () => {
  const harness = refreshHarness();
  await harness.connection.send({ type: 'reviews-refresh', lane: 'my-prs', requestId: 'refresh-1' });
  await harness.connection.send({ type: 'reviews-refresh', lane: 'team-review', requestId: 'refresh-2' });
  await harness.connection.send({ type: 'reviews-refresh', lane: 'issues', requestId: 'refresh-3' });
  assert.deepEqual(harness.refreshedLanes, ['my-prs', 'team-review', 'issues']);
  assert.deepEqual(harness.results(), [
    { type: 'reviews-refresh-result', requestId: 'refresh-1', ok: true },
    { type: 'reviews-refresh-result', requestId: 'refresh-2', ok: true },
    { type: 'reviews-refresh-result', requestId: 'refresh-3', ok: true },
  ]);
});

test('Reviews refresh returns busy and rate-limit refusals from the lane', async () => {
  for (const error of ['A refresh is already running.', 'GitHub rate limit asks to wait before refreshing.']) {
    const harness = refreshHarness({ ok: false, error });
    await harness.connection.send({ type: 'reviews-refresh', lane: 'my-prs', requestId: 'refresh-1' });
    assert.deepEqual(harness.results(), [{ type: 'reviews-refresh-result', requestId: 'refresh-1', ok: false, error }]);
  }
});

test('a malformed refresh lane never reaches a runner', async () => {
  const harness = refreshHarness();
  await harness.connection.send({ type: 'reviews-refresh', lane: 'other', requestId: 'refresh-1' });
  assert.deepEqual(harness.refreshedLanes, []);
  assert.equal(harness.results()[0]?.ok, false);
});

test('Reviews refresh reports an unavailable lane', async () => {
  const server = createControlServer(controlDeps({ projects: [] }));
  const connection = connectControl<ServerMessage>(server);
  await connection.send({ type: 'reviews-refresh', lane: 'team-review', requestId: 'refresh-1' });
  assert.ok(connection.sent.some((frame) => frame.type === 'reviews-refresh-result' && !frame.ok && frame.error === 'Reviews polling is not running.'));
});
