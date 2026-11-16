import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withGithubTrigger } from '../server/github/github-call-scope.ts';
import { createGithubClock } from '../server/github/github-clock.ts';
import { createPrGh } from '../server/github/pr-gh.ts';

test('GitHub calls queued behind a busy shared clock keep the trigger that queued them', async () => {
  const recordedCalls: string[] = [];
  const github = createPrGh('/tmp', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, out: '', err: '' };
  }, { record: (call) => recordedCalls.push(`${call.operation}/${call.trigger}`), recordRefusal() {} }, async () => {});
  const clock = createGithubClock({ baseIntervalMs: 60_000 });

  await Promise.all([
    withGithubTrigger('timer', () => clock.exclusive(() => github.conditionalGet('/timer'))),
    withGithubTrigger('nudge', () => clock.exclusive(() => github.conditionalGet('/nudge'), { isPriority: true })),
    clock.exclusive(() => github.conditionalGet('/lane')),
    withGithubTrigger('request', () => clock.exclusive(() => github.conditionalGet('/request'))),
  ]);

  assert.deepEqual(recordedCalls, ['conditionalGet/timer', 'conditionalGet/nudge', 'conditionalGet/lane', 'conditionalGet/request']);
});
