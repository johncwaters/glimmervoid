import test from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTelegramOutbox } from '../notifications/telegram-outbox.ts';
import {
  normalizeOutbox, planEnqueue, planReplay, recordFailure, removeEntry, DEFAULT_MAX_ATTEMPTS,
} from '../notifications/core/outbox-core.ts';
import type { OutboxEntry } from '../notifications/core/outbox-core.ts';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-outbox-'));
  return { dir, filePath: path.join(dir, 'telegram-outbox.json') };
}

function readOutbox(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const RETRY_INTERVAL_MS = 500;
const MAX_EVENT_LOOP_TURNS = 1000;

function makeRetryingOutbox(t: TestContext, failingAttemptCount: number) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sentTexts: string[] = [];
  let attemptCount = 0;
  const outbox = createTelegramOutbox({
    filePath: 'unused-by-the-in-memory-writer',
    retryIntervalMs: RETRY_INTERVAL_MS,
    warn: () => {},
    readFileSync: () => JSON.stringify({ version: 1, entries: [] }),
    writeJson: async () => {},
    send: async (entry) => {
      attemptCount += 1;
      if (attemptCount <= failingAttemptCount) return { ok: false };
      sentTexts.push(entry.text);
      return { ok: true };
    },
  });
  return { outbox, sentTexts, attemptCount: () => attemptCount };
}

async function waitUntil(isSettled: () => boolean): Promise<void> {
  for (let turn = 0; turn < MAX_EVENT_LOOP_TURNS; turn += 1) {
    if (isSettled()) return;
    await yieldToEventLoop();
  }
  assert.fail('the outbox never settled');
}

test('normalizeOutbox salvages what it can and discards the rest', () => {
  const entries = normalizeOutbox({
    entries: [
      { id: 'a', text: 'one', queuedAt: 5, attempts: 2 },
      { id: 'b', text: 'two' },
      { id: '', text: 'no id' },
      { id: 'c' },
      null,
      'nonsense',
    ],
  });
  assert.deepEqual(entries, [
    { id: 'a', text: 'one', queuedAt: 5, attempts: 2 },
    { id: 'b', text: 'two', queuedAt: 0, attempts: 0 },
  ]);
  assert.deepEqual(normalizeOutbox(null), []);
  assert.deepEqual(normalizeOutbox({ entries: 'nope' }), []);
});

test('the queue is capped oldest-first: an old ping is the one whose loss matters least', () => {
  let entries: OutboxEntry[] = [];
  for (let i = 0; i < 5; i += 1) {
    entries = planEnqueue(entries, { id: `e${i}`, text: `t${i}`, queuedAt: i, attempts: 0 }, { maxEntries: 3 });
  }
  assert.deepEqual(entries.map((e) => e.id), ['e2', 'e3', 'e4']);
});

test('a failure counts up and the entry is dropped once it has plainly stopped working', () => {
  const entries = [{ id: 'a', text: 'x', queuedAt: 0, attempts: 1 }];
  const once = recordFailure(entries, 'a', { maxAttempts: 3 });
  assert.equal(once.entries[0].attempts, 2);
  assert.equal(once.dropped, false);
  const again = recordFailure(once.entries, 'a', { maxAttempts: 3 });
  assert.deepEqual(again.entries, []);
  assert.equal(again.dropped, true);
});

test('a replay sends the fresh and expires the stale', () => {
  const now = 1_000_000;
  const plan = planReplay([
    { id: 'fresh', text: 'a', queuedAt: now - 1000, attempts: 0 },
    { id: 'old', text: 'b', queuedAt: now - 999_999_999, attempts: 0 },
    { id: 'exhausted', text: 'c', queuedAt: now, attempts: 9 },
  ], { now, maxAgeMs: 60_000, maxAttempts: 5 });
  assert.deepEqual(plan.send.map((e) => e.id), ['fresh']);
  assert.deepEqual(plan.expired.map((e) => e.id), ['old', 'exhausted']);
});

test('removeEntry leaves everything else alone', () => {
  const entries = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(removeEntry(entries, 'a'), [{ id: 'b' }]);
  assert.deepEqual(removeEntry(entries, 'missing'), entries);
});

test('a confirmed send leaves nothing behind', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const outbox = createTelegramOutbox({
    filePath,
    send: async (entry) => { sent.push(entry.text); return { ok: true }; },
  });

  await outbox.deliver('complete: build finished');
  await outbox.idle();

  assert.deepEqual(sent, ['complete: build finished']);
  assert.deepEqual(readOutbox(filePath).entries, [], 'the record exists only until the send is confirmed');
});

test('a failed send stays queued for the next boot', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outbox = createTelegramOutbox({ filePath, send: async () => ({ ok: false }) });

  await outbox.deliver('waiting: needs your input');
  await outbox.idle();

  const stored = readOutbox(filePath).entries;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, 'waiting: needs your input');
  assert.equal(stored[0].attempts, 1);
});

test('every telegram send attempt is counted, confirmed and failed apart', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recorded: string[] = [];
  let confirmNext = false;
  const outbox = createTelegramOutbox({
    filePath,
    warn: () => {},
    recordOutcome: (name) => recorded.push(name),
    send: async () => {
      confirmNext = !confirmNext;
      return { ok: confirmNext };
    },
  });

  await outbox.deliver('waiting: needs your input');
  await outbox.deliver('complete: build finished');
  await outbox.idle();

  assert.deepEqual(recorded, ['telegramDelivered', 'telegramFailed']);
});

test('a ping queued by a dead process is replayed by the next one', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const crashed = createTelegramOutbox({ filePath, send: async () => { throw new Error('process died'); } });
  await crashed.deliver('complete: the one that mattered');
  await crashed.idle();
  assert.equal(readOutbox(filePath).entries.length, 1);

  const sent: string[] = [];
  const rebooted = createTelegramOutbox({
    filePath,
    send: async (entry) => { sent.push(entry.text); return { ok: true }; },
  });
  const result = await rebooted.replay();
  await rebooted.idle();

  assert.deepEqual(sent, ['complete: the one that mattered']);
  assert.deepEqual(result, { sent: 1, expired: 0 });
  assert.deepEqual(readOutbox(filePath).entries, []);
});

test('a replay drops what has gone stale rather than announcing yesterday on boot', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    entries: [{ id: 'ancient', text: 'complete: last week', queuedAt: 0, attempts: 0 }],
  }), 'utf8');

  const sent: string[] = [];
  const outbox = createTelegramOutbox({
    filePath,
    send: async (entry) => { sent.push(entry.text); return { ok: true }; },
    now: () => 999_999_999_999,
  });
  const result = await outbox.replay();
  await outbox.idle();

  assert.deepEqual(sent, []);
  assert.deepEqual(result, { sent: 0, expired: 1 });
  assert.deepEqual(readOutbox(filePath).entries, []);
});

test('a corrupt outbox starts empty and warns, which can only ever lose a ping, never invent one', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(filePath, '{ not json', 'utf8');
  const warnings: string[] = [];
  const outbox = createTelegramOutbox({
    filePath, send: async () => ({ ok: true }), warn: (line) => warnings.push(line),
  });

  const result = await outbox.replay();
  assert.deepEqual(result, { sent: 0, expired: 0 });
  assert.equal(warnings.length, 1);
});

test('a missing outbox file is the normal fresh-install case and says nothing', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const warnings: string[] = [];
  const outbox = createTelegramOutbox({
    filePath, send: async () => ({ ok: true }), warn: (line) => warnings.push(line),
  });
  await outbox.replay();
  assert.deepEqual(warnings, []);
});

test('a write failure is warned about and the send still happens', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const warnings: string[] = [];
  const outbox = createTelegramOutbox({
    filePath,
    send: async (entry) => { sent.push(entry.text); return { ok: true }; },
    writeJson: async () => { throw new Error('read-only filesystem'); },
    warn: (line) => warnings.push(line),
  });

  await outbox.deliver('complete: still delivered');
  await outbox.idle();

  assert.deepEqual(sent, ['complete: still delivered']);
  assert.equal(warnings.some((line) => line.includes('read-only filesystem')), true);
});

test('a failed first attempt is retried by the timer and delivers without a restart', async (t) => {
  const { outbox, sentTexts, attemptCount } = makeRetryingOutbox(t, 1);

  await outbox.deliver('waiting: needs your input');
  assert.deepEqual(sentTexts, []);
  assert.equal(outbox.pending().length, 1);

  t.mock.timers.tick(RETRY_INTERVAL_MS - 1);
  await yieldToEventLoop();
  assert.equal(attemptCount(), 1);

  t.mock.timers.tick(1);
  await waitUntil(() => outbox.pending().length === 0);

  assert.deepEqual(sentTexts, ['waiting: needs your input']);
});

test('the retry timer re-arms while a ping is still pending and only one is ever alive', async (t) => {
  const { outbox, sentTexts, attemptCount } = makeRetryingOutbox(t, 3);

  await outbox.deliver('first ping');
  await outbox.deliver('second ping');
  assert.equal(attemptCount(), 2);
  assert.equal(outbox.isRetryArmed(), true);

  t.mock.timers.tick(RETRY_INTERVAL_MS);
  await waitUntil(() => attemptCount() === 4 && outbox.pending().length === 1 && outbox.isRetryArmed());

  t.mock.timers.tick(RETRY_INTERVAL_MS);
  await waitUntil(() => outbox.pending().length === 0);

  assert.equal(attemptCount(), 5);
  assert.deepEqual(sentTexts, ['second ping', 'first ping']);
});

test('no retry timer stays armed once the outbox is empty', async (t) => {
  const { outbox, attemptCount } = makeRetryingOutbox(t, 1);

  await outbox.deliver('waiting: needs your input');
  assert.equal(outbox.isRetryArmed(), true);

  t.mock.timers.tick(RETRY_INTERVAL_MS);
  await waitUntil(() => outbox.pending().length === 0);
  assert.equal(outbox.isRetryArmed(), false);

  t.mock.timers.tick(RETRY_INTERVAL_MS * 10);
  await yieldToEventLoop();
  assert.equal(attemptCount(), 2);
});

test('a confirmed first send arms no retry timer', async (t) => {
  const { outbox } = makeRetryingOutbox(t, 0);

  await outbox.deliver('complete: build finished');

  assert.equal(outbox.isRetryArmed(), false);
});

test('a ping that keeps failing past the attempt budget in one process stays queued and is delivered once sends recover', async (t) => {
  const failingAttemptCount = DEFAULT_MAX_ATTEMPTS + 3;
  const { outbox, sentTexts, attemptCount } = makeRetryingOutbox(t, failingAttemptCount);

  await outbox.deliver('waiting: needs your input');
  for (let failedAttemptCount = 2; failedAttemptCount <= failingAttemptCount; failedAttemptCount += 1) {
    t.mock.timers.tick(RETRY_INTERVAL_MS);
    await waitUntil(() => attemptCount() === failedAttemptCount && outbox.isRetryArmed());
  }
  assert.deepEqual(outbox.pending().map((entry) => entry.attempts), [1]);
  assert.deepEqual(sentTexts, []);

  t.mock.timers.tick(RETRY_INTERVAL_MS);
  await waitUntil(() => outbox.pending().length === 0);

  assert.deepEqual(sentTexts, ['waiting: needs your input']);
  assert.equal(outbox.isRetryArmed(), false);
});

test('a send still in flight when the retry timer fires is attempted once, not twice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attemptCountByText = new Map<string, number>();
  let confirmSlowSend: (result: { ok: boolean }) => void = () => {};
  const slowSend = new Promise<{ ok: boolean }>((resolve) => { confirmSlowSend = resolve; });
  const outbox = createTelegramOutbox({
    filePath: 'unused-by-the-in-memory-writer',
    retryIntervalMs: RETRY_INTERVAL_MS,
    warn: () => {},
    readFileSync: () => JSON.stringify({ version: 1, entries: [] }),
    writeJson: async () => {},
    send: (entry) => {
      attemptCountByText.set(entry.text, (attemptCountByText.get(entry.text) ?? 0) + 1);
      if (entry.text === 'slow ping') return slowSend;
      return Promise.resolve({ ok: false });
    },
  });

  await outbox.deliver('failing ping');
  const slowDelivery = outbox.deliver('slow ping');
  await waitUntil(() => attemptCountByText.get('slow ping') === 1);

  t.mock.timers.tick(RETRY_INTERVAL_MS);
  await waitUntil(() => attemptCountByText.get('failing ping') === 2 && outbox.isRetryArmed());
  confirmSlowSend({ ok: true });
  await slowDelivery;

  assert.equal(attemptCountByText.get('slow ping'), 1);
  assert.deepEqual(outbox.pending().map((entry) => entry.text), ['failing ping']);
});
