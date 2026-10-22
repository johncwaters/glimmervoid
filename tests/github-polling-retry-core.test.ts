import test from 'node:test';
import assert from 'node:assert/strict';
import { hasGithubPollingCountdown, githubPollingAgeText, githubPollingErrorNotice, githubPollingRefreshText } from '../public/github/github-polling-retry-core.ts';
import type { GithubPollingStatus } from '../public/github/github-polling-retry-core.ts';

const failingStatus: GithubPollingStatus = { configured: true, error: 'offline.', nextAttemptAt: 25_000, retry: { attempt: 2, limit: 3 } };

test('a quick retry notice counts down with the scheduled retry number', () => {
  assert.equal(githubPollingErrorNotice(failingStatus, 1000), 'Could not reach GitHub: offline. Retrying in 24s (2 of 3).');
  assert.equal(githubPollingErrorNotice(failingStatus, 2000), 'Could not reach GitHub: offline. Retrying in 23s (2 of 3).');
  assert.equal(githubPollingErrorNotice(failingStatus, 24_001), 'Could not reach GitHub: offline. Retrying in 1s (2 of 3).');
  assert.equal(githubPollingErrorNotice(failingStatus, 25_000), 'Could not reach GitHub: offline. Retrying now.');
  assert.equal(githubPollingErrorNotice(failingStatus, 30_000), 'Could not reach GitHub: offline. Retrying now.');
  assert.equal(githubPollingErrorNotice({ ...failingStatus, incident: 'Degraded API requests.' }, 1000), 'Could not reach GitHub: offline. GitHub reports: Degraded API requests. Retrying in 24s (2 of 3).');
  assert.equal(githubPollingErrorNotice({ ...failingStatus, incident: '' }, 1000), 'Could not reach GitHub: offline. Retrying in 24s (2 of 3).');
});

test('a regular or rate-limit retry reports minutes or seconds without a quick retry number', () => {
  assert.equal(githubPollingErrorNotice({ ...failingStatus, retry: null, nextAttemptAt: 240_000 }, 0), 'Could not reach GitHub: offline. Next try in 4 min.');
  assert.equal(githubPollingErrorNotice({ ...failingStatus, retry: null }, 1000), 'Could not reach GitHub: offline. Next try in 24s.');
});

test('legacy errors work without a schedule and success removes the notice', () => {
  assert.equal(githubPollingErrorNotice({ configured: true, error: 'offline' }, 1000), 'Could not reach GitHub: offline.');
  assert.equal(githubPollingErrorNotice(null, 1000), null);
  assert.equal(githubPollingErrorNotice({ configured: true, error: null }, 1000), null);
});

test('data age appears for errors or stale reads and falls back to the Issues sync time', () => {
  const status = { ...failingStatus, lastRefreshedAt: 1000 };
  assert.equal(githubPollingAgeText({ ...status, error: null }, 301_000), null);
  assert.notEqual(githubPollingAgeText({ ...status, error: null }, 361_000), null);
  assert.equal(githubPollingAgeText({ ...status, lastRefreshedAt: null, lastSyncAt: 1000 }, 361_000), githubPollingAgeText({ ...status, lastRefreshedAt: 1000 }, 361_000));
});

test('a countdown is active only until the retry deadline while an error exists', () => {
  assert.equal(hasGithubPollingCountdown(failingStatus, 1000), true);
  assert.equal(hasGithubPollingCountdown({ ...failingStatus, isRefreshing: true }, 1000), false);
  assert.equal(hasGithubPollingCountdown(failingStatus, 25_000), false);
  assert.equal(hasGithubPollingCountdown({ ...failingStatus, error: null }, 1000), false);
  assert.equal(hasGithubPollingCountdown({ ...failingStatus, nextAttemptAt: null }, 1000), false);
  assert.equal(hasGithubPollingCountdown(null, 1000), false);
});

test('refresh progress, refusals and outcomes are copy beside the stable button label', () => {
  assert.equal(githubPollingRefreshText(failingStatus, true, ''), 'Refreshing');
  assert.equal(githubPollingRefreshText({ ...failingStatus, isRefreshing: true }, false, ''), 'Refreshing');
  assert.equal(githubPollingRefreshText({ ...failingStatus, isRefreshing: true, refreshNotice: 'A refresh is already running.' }, false, ''), 'A refresh is already running.');
  assert.equal(githubPollingRefreshText({ ...failingStatus, refreshNotice: 'GitHub rate limit asks to wait before refreshing.' }, false, ''), 'GitHub rate limit asks to wait before refreshing.');
  assert.equal(githubPollingRefreshText(null, false, 'Not connected'), 'Not connected');
  assert.equal(githubPollingRefreshText({ ...failingStatus, refreshNotice: 'Refreshed.' }, false, 'Not connected'), 'Not connected');
});
