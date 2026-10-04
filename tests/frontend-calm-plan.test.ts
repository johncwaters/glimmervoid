import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlanReview } from '../shared/contracts/plan-review.ts';
import { latestPendingReview } from '../public/calm/calm-plan-core.ts';

test('calm chooses the newest open plan and preserves the main agent identity', () => {
  const reviews: PlanReview[] = [
    { agentId: 'older', agentType: null, revisions: [], state: 'open', openRevision: { revision: 1, since: 10 }, approvedRevision: null, lastDecision: null },
    { agentId: null, agentType: null, revisions: [], state: 'open', openRevision: { revision: 3, since: 20 }, approvedRevision: null, lastDecision: null },
    { agentId: 'closed', agentType: null, revisions: [], state: 'closed', openRevision: { revision: 4, since: 30 }, approvedRevision: null, lastDecision: null },
  ];
  assert.equal(latestPendingReview({ reviews }), reviews[1]);
  assert.equal(reviews[0].agentId, 'older');
});

test('calm falls back to opening the plan when no pending revision exists', () => {
  assert.equal(latestPendingReview({ reviews: [] }), null);
  assert.equal(latestPendingReview({ reviews: [{ agentId: null, agentType: null, revisions: [], state: 'open', openRevision: null, approvedRevision: null, lastDecision: null }] }), null);
});
