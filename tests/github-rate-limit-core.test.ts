import test from 'node:test';
import assert from 'node:assert/strict';
import { githubRateLimitWaitMs } from '../server/core/github-rate-limit-core.ts';

test('no exhausted resource means no rate-limit wait', () => {
  assert.equal(githubRateLimitWaitMs({ core: { remaining: 1, reset: 5 }, search: { remaining: 30, reset: 5 } }, 0, ['core', 'search']), null);
});

test('the wait runs to the latest reset among exhausted resources', () => {
  assert.equal(githubRateLimitWaitMs({ search: { remaining: 0, reset: 10 }, graphql: { remaining: 0, reset: 40 }, core: { remaining: 9, reset: 99 } }, 5_000, ['search', 'graphql', 'core']), 35_000);
});

test('an exhausted resource whose reset already passed needs no wait', () => {
  assert.equal(githubRateLimitWaitMs({ search: { remaining: 0, reset: 1 } }, 5_000, ['search']), null);
});

test('an exhausted resource outside the named resources is ignored', () => {
  assert.equal(githubRateLimitWaitMs({ code_search: { remaining: 0, reset: 99 }, graphql: { remaining: 10, reset: 40 } }, 5_000, ['graphql']), null);
});

test('a named resource missing from the response needs no wait', () => {
  assert.equal(githubRateLimitWaitMs({ core: { remaining: 0, reset: 99 } }, 5_000, ['graphql']), null);
});
