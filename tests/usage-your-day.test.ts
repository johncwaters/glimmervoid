import test from 'node:test';
import assert from 'node:assert/strict';

import { buildYourDay } from '../server/usage/core/usage-your-day-core.ts';
import type { ActivityEvent } from '../server/usage/core/usage-your-day-core.ts';
import { yourDayHint } from '../public/usage/usage-view-core.ts';
import { localDayKey } from '../shared/display-text.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function promptAt(sessionId: string, ts: number): ActivityEvent {
  return { vendor: 'claude', sessionId, ts, kind: 'prompt' };
}

function promptsEveryTenMinutes(sessionId: string, startTs: number, durationMs: number): ActivityEvent[] {
  return Array.from({ length: durationMs / (10 * MINUTE_MS) + 1 }, (_, index) => promptAt(sessionId, startTs + index * 10 * MINUTE_MS));
}

function findLocalDayAfterShortDay(): Date | null {
  for (let dayOffset = 0; dayOffset < 366; dayOffset += 1) {
    const dayStart = new Date(2026, 0, 1 + dayOffset);
    const nextDayStart = new Date(2026, 0, 2 + dayOffset);
    if (nextDayStart.getTime() - dayStart.getTime() < 24 * HOUR_MS) return nextDayStart;
  }
  return null;
}

test('yourDay names the recap day instead of calling an older day yesterday', () => {
  const now = new Date(2026, 10, 6, 12).getTime();
  const events = [
    ...promptsEveryTenMinutes('baseline-a', new Date(2026, 9, 27, 9).getTime(), 30 * MINUTE_MS),
    ...promptsEveryTenMinutes('baseline-b', new Date(2026, 9, 29, 9).getTime(), 30 * MINUTE_MS),
    ...promptsEveryTenMinutes('focused', new Date(2026, 10, 1, 9).getTime(), 4 * HOUR_MS),
    promptAt('today', new Date(2026, 10, 6, 9).getTime()),
  ];

  const yourDay = buildYourDay(events, { now });

  assert.equal(yourDay?.yesterday.day, '2026-11-01');
  assert.deepEqual(yourDay?.insights.map((insight) => insight.text), ['On Nov 1 you went 4h without a break, 8.0x your usual.']);
});

test('yourDay hint calls the day before a 23 hour day yesterday just after midnight', (t) => {
  const dayAfterShortDay = findLocalDayAfterShortDay();
  if (!dayAfterShortDay) {
    t.skip('this time zone has no 23 hour day in 2026');
    return;
  }
  const shortDay = new Date(dayAfterShortDay.getFullYear(), dayAfterShortDay.getMonth(), dayAfterShortDay.getDate() - 1);
  const yourDay = {
    yesterday: { day: localDayKey(shortDay), sessionCount: 2, activeMs: 90 * MINUTE_MS },
    insights: [],
    usual: { peakWaiting: 0, stretchMs: 0 },
    currentStretchStartedAt: null,
    activeDayCount: 3,
  };

  assert.equal(yourDayHint(yourDay, dayAfterShortDay.getTime() + 30 * MINUTE_MS), 'yesterday: 2 sessions, 1h 30m');
});
