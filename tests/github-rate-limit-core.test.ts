import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPrGh } from '../server/github/pr-gh.ts';

const resetAtSeconds = Math.floor(Date.now() / 1000) + 1200;

function spentGraphqlReply() {
  const headers = [
    'HTTP/2.0 403 Forbidden',
    'X-Ratelimit-Limit: 5000',
    'X-Ratelimit-Remaining: 0',
    `X-Ratelimit-Reset: ${resetAtSeconds}`,
    'X-Ratelimit-Resource: graphql',
    'X-Ratelimit-Used: 5000',
  ].join('\r\n');
  const body = JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit already exceeded for user ID 1.' }] });
  return { ok: false, out: `${headers}\r\n\r\n${body}`, err: 'gh: API rate limit already exceeded for user ID 1.' };
}

function laggingRestRateLimitReply() {
  return { ok: true, out: JSON.stringify({ graphql: { limit: 5000, used: 1976, remaining: 3024, reset: resetAtSeconds - 8 } }), err: '' };
}

test('a spent GraphQL pool is not retried and holds reads until its reset even while REST rate_limit lags', async () => {
  let graphqlCalls = 0;
  const github = createPrGh('/tmp', async (_command, args) => {
    if (args.includes('rate_limit')) return laggingRestRateLimitReply();
    graphqlCalls += 1;
    return spentGraphqlReply();
  }, null, async () => {});

  await assert.rejects(github.prsLightByKey([{ repo: 'acme/app', number: 1 }]));
  const waitMs = await github.rateLimitWaitMs(Date.now(), ['graphql']);
  const resources = await github.rateLimitResources();

  assert.equal(graphqlCalls, 1);
  assert.ok(waitMs !== null && waitMs > 1_000_000);
  assert.equal(resources?.graphql?.used, 5000);
});

function graphqlReply(status: string, remaining: number) {
  const headers = [`HTTP/2.0 ${status}`, 'X-Ratelimit-Limit: 5000', `X-Ratelimit-Remaining: ${remaining}`, `X-Ratelimit-Reset: ${resetAtSeconds}`, 'X-Ratelimit-Resource: graphql', `X-Ratelimit-Used: ${5000 - remaining}`].join('\r\n');
  return { ok: status.startsWith('200'), out: `${headers}\r\n\r\n${JSON.stringify({ data: {} })}`, err: '' };
}

test('a slow earlier GraphQL reply arriving after a refusal does not reopen the spent pool', async () => {
  const github = createPrGh('/tmp', async (_command, args) => {
    if (args.includes('rate_limit')) return laggingRestRateLimitReply();
    if (args.some((arg) => arg.includes('slow'))) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return graphqlReply('200 OK', 1);
    }
    return graphqlReply('403 Forbidden', 0);
  }, null, async () => {});

  await Promise.allSettled([
    github.prsLightByKey([{ repo: 'acme/slow', number: 1 }]),
    github.prsLightByKey([{ repo: 'acme/fast', number: 2 }]),
  ]);

  assert.ok(((await github.rateLimitWaitMs(Date.now(), ['graphql'])) ?? 0) > 1_000_000);
});

test('a pool spent on one GitHub source does not hold reads on another', async () => {
  let currentSource: { kind: 'gh' } | { kind: 'connection'; token: string } = { kind: 'gh' };
  const github = createPrGh('/tmp', async (_command, args) => {
    if (args.includes('rate_limit')) return { ok: true, out: JSON.stringify({ graphql: { limit: 5000, used: 3, remaining: 4997, reset: resetAtSeconds } }), err: '' };
    return spentGraphqlReply();
  }, null, async () => {}, { current: async () => currentSource });

  await assert.rejects(github.prsLightByKey([{ repo: 'acme/app', number: 1 }]));
  currentSource = { kind: 'connection', token: 'other-account' };

  assert.equal(await github.rateLimitWaitMs(Date.now(), ['graphql']), null);
});
