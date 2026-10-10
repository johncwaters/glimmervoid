import { createSerialQueue } from '../server/spawn-gate.ts';
import { errorMessage } from "../shared/text.ts";
import crypto from 'node:crypto';
import fs from 'node:fs';

import { loadJsonStateFileSync, loadedJsonValue, writeJsonAtomic } from '../server/json-file.ts';
import type { OutcomeRecorder } from '../shared/outcome-names.ts';
import {
  normalizeOutbox, planEnqueue, planReplay, recordFailure, removeEntry,
  DEFAULT_MAX_AGE_MS, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ENTRIES,
} from './core/outbox-core.ts';
import type { OutboxEntry } from './core/outbox-core.ts';

const OUTBOX_VERSION = 1;
const DEFAULT_RETRY_INTERVAL_MS = 60000;

export interface TelegramOutboxDeps {
  filePath: string;

  send: (entry: OutboxEntry) => Promise<{ ok: boolean }>;
  now?: () => number;
  maxEntries?: number;
  maxAttempts?: number;
  maxAgeMs?: number;
  retryIntervalMs?: number;
  warn?: (message: string) => void;
  readFileSync?: (filePath: string, encoding: BufferEncoding) => string;
  writeJson?: typeof writeJsonAtomic;
  recordOutcome?: OutcomeRecorder;
}

function createTelegramOutbox({
  filePath,
  send,
  now = Date.now,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
  warn = console.warn,
  readFileSync = fs.readFileSync,
  writeJson = writeJsonAtomic,
  recordOutcome = () => {},
}: TelegramOutboxDeps) {
  let entries: OutboxEntry[] = [];
  const writeQueue = createSerialQueue();
  let loaded = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let isReplayRunning = false;
  const entryIdsInFlight = new Set<string>();
  const entryIdsWithFailureCounted = new Set<string>();

  function isPending(entryId: string): boolean {
    return entries.some((entry) => entry.id === entryId);
  }

  function forgetDepartedEntries(): void {
    for (const entryId of entryIdsWithFailureCounted) {
      if (!isPending(entryId)) entryIdsWithFailureCounted.delete(entryId);
    }
  }

  function armRetry(): void {
    if (retryTimer !== null) return;
    if (isReplayRunning) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      replay().catch((error) => warn(`[telegram-outbox] retry failed: ${errorMessage(error)}`));
    }, retryIntervalMs);
    retryTimer.unref();
  }

  function countFailureOncePerProcess(entryId: string): void {
    if (entryIdsWithFailureCounted.has(entryId)) return;
    const outcome = recordFailure(entries, entryId, { maxAttempts });
    entries = outcome.entries;
    if (outcome.dropped) {
      warn(`[telegram-outbox] giving up on a ping after ${maxAttempts} attempts`);
      return;
    }
    if (isPending(entryId)) entryIdsWithFailureCounted.add(entryId);
  }

  function load(): void {
    if (loaded) return;
    loaded = true;
    const outcome = loadJsonStateFileSync({
      filePath,
      fsSync: { readFileSync },
      parse: normalizeOutbox,
      quarantine: false,
      includeNotDir: false,
    });
    entries = loadedJsonValue(outcome) ?? [];
    if ('error' in outcome && outcome.error) {
      warn(`[telegram-outbox] unreadable, starting empty: ${errorMessage(outcome.error)}`);
    }
  }

  function persist(): Promise<unknown> {
    const snapshot = { version: OUTBOX_VERSION, entries: entries.slice() };
    return writeQueue
      .run(() => writeJson(filePath, snapshot, { mkdir: true }))
      .catch((error) => warn(`[telegram-outbox] write failed: ${errorMessage(error)}`));
  }

  async function deliver(text: string): Promise<void> {
    load();
    const entry: OutboxEntry = { id: crypto.randomUUID(), text, queuedAt: now(), attempts: 0 };
    entries = planEnqueue(entries, entry, { maxEntries });
    forgetDepartedEntries();
    await persist();
    await attempt(entry);
  }

  async function attempt(entry: OutboxEntry): Promise<void> {
    let ok = false;
    entryIdsInFlight.add(entry.id);
    try {
      const result = await send(entry);
      ok = result?.ok === true;
    } catch (error) {
      warn(`[telegram-outbox] send threw: ${errorMessage(error)}`);
    } finally {
      entryIdsInFlight.delete(entry.id);
    }
    if (ok) {
      recordOutcome('telegramDelivered');
      entries = removeEntry(entries, entry.id);
      forgetDepartedEntries();
      await persist();
      return;
    }
    recordOutcome('telegramFailed');
    countFailureOncePerProcess(entry.id);
    if (isPending(entry.id)) armRetry();
    await persist();
  }

  async function attemptEachIdleEntry(plannedEntries: OutboxEntry[]): Promise<number> {
    let attemptedCount = 0;
    for (const entry of plannedEntries) {
      if (entryIdsInFlight.has(entry.id)) continue;
      if (!isPending(entry.id)) continue;
      attemptedCount += 1;
      await attempt(entry);
    }
    return attemptedCount;
  }

  async function replay(): Promise<{ sent: number; expired: number }> {
    load();
    isReplayRunning = true;
    try {
      const plan = planReplay(entries, { now: now(), maxAgeMs, maxAttempts });
      if (plan.expired.length > 0) {
        for (const entry of plan.expired) entries = removeEntry(entries, entry.id);
        forgetDepartedEntries();
        await persist();
      }
      const sent = await attemptEachIdleEntry(plan.send);
      return { sent, expired: plan.expired.length };
    } finally {
      isReplayRunning = false;
      if (entries.some((entry) => !entryIdsInFlight.has(entry.id))) armRetry();
    }
  }

  return {
    deliver,
    replay,
    idle: () => writeQueue.idle(),
    isRetryArmed: () => retryTimer !== null,
    pending: () => { load(); return entries.slice(); },
  };
}

export { createTelegramOutbox, OUTBOX_VERSION };
