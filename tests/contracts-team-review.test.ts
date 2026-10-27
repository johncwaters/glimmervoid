import test from 'node:test';
import assert from 'node:assert/strict';

import { ReviewAssessment, TeamReviewStateEntry } from '../shared/contracts/team-review.ts';

const HEAD = 'a'.repeat(40);

test('saved review entries accept both legacy state and a resumable session', () => {
  const oldEntry = { draft: null, reviewedHead: null, inFlight: false, reviewAttempts: 0, updatedAt: 1000 };
  const resumable = { sessionId: 'claude-1', workDir: '/work/review', worktreePath: '/work/tree', head: HEAD, deadlineAt: 9000, savedAt: 1000 };
  assert.deepEqual(TeamReviewStateEntry.parse(oldEntry), oldEntry);
  assert.deepEqual(TeamReviewStateEntry.parse({ ...oldEntry, resumable }), { ...oldEntry, resumable });
  assert.deepEqual(TeamReviewStateEntry.parse({ ...oldEntry, reviewedAt: 2000 }).reviewedAt, 2000);
  assert.equal(TeamReviewStateEntry.safeParse({ ...oldEntry, resumable: { ...resumable, sessionId: '' } }).success, false);
  assert.equal(TeamReviewStateEntry.safeParse({ ...oldEntry, resumable: { ...resumable, head: 'bad' } }).success, false);
});

test('saved review records parse with and without a remaining awake budget', () => {
  const oldEntry = { draft: null, reviewedHead: null, inFlight: false, reviewAttempts: 0, updatedAt: 1000 };
  const legacyResumable = { sessionId: 'claude-1', workDir: '/work/review', worktreePath: '/work/tree', head: HEAD, deadlineAt: 9000, savedAt: 1000 };
  const budgetedResumable = { ...legacyResumable, remainingAwakeMs: 120000 };
  assert.equal(TeamReviewStateEntry.parse({ ...oldEntry, resumable: legacyResumable }).resumable?.remainingAwakeMs, undefined);
  assert.equal(TeamReviewStateEntry.parse({ ...oldEntry, resumable: budgetedResumable }).resumable?.remainingAwakeMs, 120000);
  assert.equal(TeamReviewStateEntry.safeParse({ ...oldEntry, resumable: { ...legacyResumable, remainingAwakeMs: -1 } }).success, false);
});

test('an old assessment without a goal or hand checks parses with an empty goal and no hand checks', () => {
  const oldAssessment = { change: 'Re-arm the timer.', checked: ['Old timer cleared.'], gaps: [] };
  assert.deepEqual(ReviewAssessment.parse(oldAssessment), { goal: '', handChecks: [], ...oldAssessment });
});
