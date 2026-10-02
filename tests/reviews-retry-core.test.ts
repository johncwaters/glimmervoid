import test from 'node:test';
import assert from 'node:assert/strict';
import { hasReviewsCountdown, reviewsErrorNotice, reviewsRefreshText } from '../public/reviews-retry-core.ts';
import type { ReviewsPollingStatus } from '../public/reviews-retry-core.ts';

const failingStatus: ReviewsPollingStatus = { configured: true, error: 'offline.', nextAttemptAt: 25_000, retry: { attempt: 2, limit: 3 } };

test('a quick retry notice counts down with the scheduled retry number', () => {
  assert.equal(reviewsErrorNotice(failingStatus, 1000), 'Could not reach GitHub: offline. Retrying in 24s (2 of 3).');
  assert.equal(reviewsErrorNotice(failingStatus, 2000), 'Could not reach GitHub: offline. Retrying in 23s (2 of 3).');
  assert.equal(reviewsErrorNotice(failingStatus, 24_001), 'Could not reach GitHub: offline. Retrying in 1s (2 of 3).');
  assert.equal(reviewsErrorNotice(failingStatus, 25_000), 'Could not reach GitHub: offline. Retrying now.');
  assert.equal(reviewsErrorNotice(failingStatus, 30_000), 'Could not reach GitHub: offline. Retrying now.');
});

test('a regular or rate-limit retry reports minutes or seconds without a quick retry number', () => {
  assert.equal(reviewsErrorNotice({ ...failingStatus, retry: null, nextAttemptAt: 240_000 }, 0), 'Could not reach GitHub: offline. Next try in 4 min.');
  assert.equal(reviewsErrorNotice({ ...failingStatus, retry: null }, 1000), 'Could not reach GitHub: offline. Next try in 24s.');
});

test('legacy errors work without a schedule and success removes the notice', () => {
  assert.equal(reviewsErrorNotice({ configured: true, error: 'offline' }, 1000), 'Could not reach GitHub: offline.');
  assert.equal(reviewsErrorNotice(null, 1000), null);
  assert.equal(reviewsErrorNotice({ configured: true, error: null }, 1000), null);
});

test('a countdown is active only until the retry deadline while an error exists', () => {
  assert.equal(hasReviewsCountdown(failingStatus, 1000), true);
  assert.equal(hasReviewsCountdown({ ...failingStatus, isRefreshing: true }, 1000), false);
  assert.equal(hasReviewsCountdown(failingStatus, 25_000), false);
  assert.equal(hasReviewsCountdown({ ...failingStatus, error: null }, 1000), false);
  assert.equal(hasReviewsCountdown({ ...failingStatus, nextAttemptAt: null }, 1000), false);
  assert.equal(hasReviewsCountdown(null, 1000), false);
});

test('refresh progress, refusals and outcomes are copy beside the stable button label', () => {
  assert.equal(reviewsRefreshText(failingStatus, true, ''), 'Refreshing.');
  assert.equal(reviewsRefreshText({ ...failingStatus, isRefreshing: true }, false, ''), 'Refreshing.');
  assert.equal(reviewsRefreshText({ ...failingStatus, isRefreshing: true, refreshNotice: 'A refresh is already running.' }, false, ''), 'A refresh is already running.');
  assert.equal(reviewsRefreshText({ ...failingStatus, refreshNotice: 'GitHub rate limit asks to wait before refreshing.' }, false, ''), 'GitHub rate limit asks to wait before refreshing.');
  assert.equal(reviewsRefreshText(null, false, 'Not connected'), 'Not connected');
  assert.equal(reviewsRefreshText({ ...failingStatus, refreshNotice: 'Refreshed.' }, false, 'Not connected'), 'Not connected');
});
