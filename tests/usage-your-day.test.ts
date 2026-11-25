import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildYourDay } from '../server/usage/core/usage-your-day-core.ts';
import type { ActivityEvent } from '../server/usage/core/usage-your-day-core.ts';
import { limitCards, yourDayHint } from '../public/usage/usage-view-core.ts';
import { railFieldsOf, railTextOf } from '../public/chat/status-rail-core.ts';
import type { PlanLimits } from '../public/usage/usage-store-core.ts';
import { clock } from '../shared/clock.ts';

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
  assert.deepEqual(yourDay?.insights.map(({ title, detail }) => ({ title, detail })), [
    { title: 'On Nov 1 you went 4h without a break', detail: "Your usual longest run is 30m. Attention fades deep into a run, which is when an agent's mistake gets approved. Agents keep their place, so a 15m break costs them nothing." },
  ]);
});

test('yourDay hint calls the day before a 23 hour day yesterday just after midnight', (t) => {
  const dayAfterShortDay = findLocalDayAfterShortDay();
  if (!dayAfterShortDay) {
    t.skip('this time zone has no 23 hour day in 2026');
    return;
  }
  const shortDay = new Date(dayAfterShortDay.getFullYear(), dayAfterShortDay.getMonth(), dayAfterShortDay.getDate() - 1);
  const yourDay = {
    yesterday: { day: clock.dayKeyOf(shortDay), sessionCount: 2, activeMs: 90 * MINUTE_MS, longestStretchMs: 60 * MINUTE_MS },
    insights: [],
    usual: { peakWaiting: 0, stretchMs: 0 },
    currentStretchStartedAt: null,
    currentStretchEndsAt: null,
    activeDayCount: 3,
  };

  assert.equal(yourDayHint(yourDay, dayAfterShortDay.getTime() + 30 * MINUTE_MS), 'Yesterday: 2 sessions, 1h 30m');
});

test('status rail and limitCards scope multi-bucket plan limits to the active model for Antigravity and Codex', () => {
  const nowMs = Date.parse('2026-11-24T22:55:00Z');
  const futureResetMs = nowMs + 4 * HOUR_MS;
  const antigravityLimits: PlanLimits = {
    ts: nowMs,
    vendor: 'antigravity',
    fiveHour: { pct: 0.1, resetsAtMs: futureResetMs },
    sevenDay: { pct: 0.7, resetsAtMs: futureResetMs + 24 * HOUR_MS },
    buckets: [
      { id: 'gemini', label: 'Gemini', fiveHour: { pct: 0.1, resetsAtMs: futureResetMs }, sevenDay: { pct: 0.7, resetsAtMs: futureResetMs + 24 * HOUR_MS } },
      { id: '3p', label: '3rd-party', fiveHour: null, sevenDay: { pct: 100, resetsAtMs: futureResetMs + 24 * HOUR_MS } },
    ],
  };
  const codexLimits: PlanLimits = {
    ts: nowMs,
    vendor: 'codex',
    fiveHour: { pct: 12, resetsAtMs: futureResetMs },
    sevenDay: { pct: 25, resetsAtMs: futureResetMs + 24 * HOUR_MS },
    buckets: [
      { id: 'codex', label: 'Codex', fiveHour: { pct: 12, resetsAtMs: futureResetMs }, sevenDay: { pct: 25, resetsAtMs: futureResetMs + 24 * HOUR_MS } },
      { id: 'codex_bengalfox', label: 'GPT-5.3-Codex-Spark', fiveHour: { pct: 80, resetsAtMs: futureResetMs }, sevenDay: null },
    ],
  };

  const geminiRail = railFieldsOf({
    meter: { model: 'Gemini 4 Neon (Medium)', effort: 'medium', contextTokens: 50_000, contextWindow: 1_048_576, callCostUSD: null, outputStyle: null },
    selection: null,
    planLimits: antigravityLimits,
    sessionCostUSD: null,
    nowMs,
    agent: 'antigravity',
  });
  assert.equal(geminiRail.find((field) => field.kind === 'plan')?.pct, 0.7);
  const geminiModel = geminiRail.find((field) => field.kind === 'model');
  assert.ok(geminiModel);
  assert.equal(railTextOf(geminiModel), 'Gemini 4 Neon (Medium)');
  assert.equal(railTextOf({ kind: 'model', name: 'Opus 4.5', effort: 'high', canChange: false, agent: 'claude-code' }), 'Opus 4.5 high');
  assert.equal(railTextOf({ kind: 'model', name: 'Orchestrator (Neon)', effort: 'medium', canChange: false, agent: 'antigravity' }), 'Orchestrator (Neon) medium');

  const thirdPartyRail = railFieldsOf({
    meter: { model: 'Claude Sonnet 4.6', effort: null, contextTokens: null, contextWindow: null, callCostUSD: null, outputStyle: null },
    selection: null,
    planLimits: antigravityLimits,
    sessionCostUSD: null,
    nowMs,
    agent: 'antigravity',
  });
  assert.equal(thirdPartyRail.find((field) => field.kind === 'plan')?.pct, 100);

  const sparkRail = railFieldsOf({
    meter: null,
    selection: { agent: 'codex', model: 'gpt-5.3-codex-spark', options: [] },
    planLimits: codexLimits,
    sessionCostUSD: null,
    nowMs,
    agent: 'codex',
  });
  assert.equal(sparkRail.find((field) => field.kind === 'plan')?.pct, 80);

  const defaultCodexRail = railFieldsOf({
    meter: null,
    selection: { agent: 'codex', model: 'gpt-5.3-codex', options: [] },
    planLimits: codexLimits,
    sessionCostUSD: null,
    nowMs,
    agent: 'codex',
  });
  assert.equal(defaultCodexRail.find((field) => field.kind === 'plan')?.pct, 25);

  const missingAntigravityBucketRail = railFieldsOf({
    meter: { model: 'Claude Sonnet 4.6', effort: null, contextTokens: null, contextWindow: null, callCostUSD: null, outputStyle: null },
    selection: null,
    planLimits: { ...antigravityLimits, buckets: (antigravityLimits.buckets ?? []).slice(0, 1) },
    sessionCostUSD: null,
    nowMs,
    agent: 'antigravity',
  });
  assert.equal(missingAntigravityBucketRail.find((field) => field.kind === 'plan'), undefined);

  const missingCodexDefaultRail = railFieldsOf({
    meter: null,
    selection: { agent: 'codex', model: 'gpt-5.4', options: [] },
    planLimits: { ...codexLimits, buckets: (codexLimits.buckets ?? []).slice(1, 2) },
    sessionCostUSD: null,
    nowMs,
    agent: 'codex',
  });
  assert.equal(missingCodexDefaultRail.find((field) => field.kind === 'plan'), undefined);

  const cards = limitCards(
    { claude: null, codex: codexLimits, kimi: null, antigravity: antigravityLimits },
    [],
    nowMs,
  );
  assert.deepEqual(
    cards.map((card) => ({ label: card.vendorLabel, bindingPct: card.binding.usedPct, otherPct: card.other?.usedPct ?? null })),
    [
      { label: 'Codex / GPT-5.3-Codex-Spark', bindingPct: 80, otherPct: null },
      { label: 'Antigravity / 3rd-party', bindingPct: 100, otherPct: null },
      { label: 'Codex', bindingPct: 12, otherPct: 25 },
      { label: 'Antigravity / Gemini', bindingPct: 0.7, otherPct: 0.1 },
    ],
  );
});
