import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientMessage, ServerMessage } from '../shared/contracts/control-messages.ts';
import { MyPrsStatus } from '../shared/contracts/my-prs.ts';
import { TeamReviewStatus } from '../shared/contracts/team-review.ts';

const statuses = [
  { type: 'my-prs-status', ts: 1000, configured: true, viewer: null, prs: [] },
  { type: 'team-review-status', ts: 1000, configured: true, drafts: [], inFlight: [] },
];

test('Reviews statuses accept old snapshots and optional polling metadata', () => {
  for (const status of statuses) {
    const schema = status.type === 'my-prs-status' ? MyPrsStatus : TeamReviewStatus;
    assert.equal(schema.safeParse(status).success, true);
    const polling = { error: 'offline', nextAttemptAt: 11_000, retry: { attempt: 1, limit: 3 }, isRefreshing: false, refreshNotice: null };
    const parsed = schema.parse({ ...status, ...polling });
    for (const key of ['error', 'nextAttemptAt', 'retry', 'isRefreshing', 'refreshNotice'] as const) assert.deepEqual(parsed[key], polling[key]);
    assert.equal(ServerMessage.safeParse({ ...status, ...polling }).success, true);
    assert.equal(schema.safeParse({ ...status, error: null, nextAttemptAt: null, retry: null }).success, true);
    for (const invalid of [{ nextAttemptAt: -1 }, { nextAttemptAt: Number.NaN }, { error: 12 }, { retry: { attempt: 0, limit: 3 } }, { retry: { attempt: 4, limit: 3 } }, { retry: { attempt: 1.5, limit: 3 } }, { isRefreshing: 'yes' }]) {
      assert.equal(schema.safeParse({ ...status, ...invalid }).success, false);
    }
  }
});

test('Reviews refresh accepts only the two lanes with an optional request id', () => {
  for (const lane of ['my-prs', 'team-review']) {
    assert.equal(ClientMessage.safeParse({ type: 'reviews-refresh', lane }).success, true);
    assert.equal(ClientMessage.safeParse({ type: 'reviews-refresh', lane, requestId: 'refresh-1' }).success, true);
  }
  assert.equal(ClientMessage.safeParse({ type: 'reviews-refresh', lane: 'posthog' }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'reviews-refresh' }).success, false);
  assert.equal(ServerMessage.safeParse({ type: 'reviews-refresh-result', requestId: 'refresh-1', ok: false, error: 'GitHub rate limit asks to wait.' }).success, true);
  assert.equal(ServerMessage.safeParse({ type: 'reviews-refresh-result', ok: 'yes' }).success, false);
});
