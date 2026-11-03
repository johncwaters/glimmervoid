import assert from 'node:assert/strict';
import { test } from 'node:test';
import { raceWithAbort } from '../server/lanes/ephemeral-session.ts';

test('a lane run limit counts only awake time, so waking from a sleep longer than the limit does not time the run out', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 });
  const thirtyMinutesMs = 30 * 60 * 1000;
  let hasTimedOut = false;
  const outcome = raceWithAbort<string>({
    timeoutMs: 120000,
    start: () => new Promise<null>(() => {}),
    onTimeout: () => { hasTimedOut = true; return 'timed out'; },
    onEmpty: () => 'empty',
  });
  for (let wakeIndex = 0; wakeIndex < 3; wakeIndex += 1) {
    context.mock.timers.setTime(Date.now() + thirtyMinutesMs);
    context.mock.timers.tick(15000);
    await Promise.resolve();
    assert.equal(hasTimedOut, false);
  }
  context.mock.timers.setTime(Date.now() + thirtyMinutesMs);
  context.mock.timers.tick(15000);
  assert.equal(await outcome, 'timed out');
});
