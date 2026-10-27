
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createUsageWiring, } from '../server/usage/usage-wiring.ts';
import type { UsageWiringOptions } from '../server/usage/usage-wiring.ts';
import { sendTelegramMessage } from '../server/telegram-transport.ts';
import type { PassOutcome } from '../server/usage/core/usage-scan-core.ts';

type ScannerFactory = NonNullable<UsageWiringOptions['createScanner']>;
type Scanner = ReturnType<ScannerFactory>;
type BudgetSpend = ReturnType<Scanner['budgetSpend']>;

const LANE_ROWS = [{ lane: 'pr-review', costUSD: 4.2, tokens: 1000, sessions: 2 }];
const PLAN_WINDOW_LANES = { fiveHour: LANE_ROWS, sevenDay: LANE_ROWS };
const BUDGET_BLOCK = {
  dailyUsd: 16,
  monthlyUsd: null,
  rows: [{ scope: 'daily' as const, spentUsd: 12.4, budgetUsd: 16, pct: 77.5, tone: 'warn' as const }],
};

type GenerationRollup = Awaited<ReturnType<Scanner['runPass']>>['generationRollup'];

function fakeScanner(
  { outcome = 'complete', spend, generationRollup = [] }: { outcome?: PassOutcome; spend: () => BudgetSpend; generationRollup?: GenerationRollup },
): Scanner {
  const isByteLimited = outcome === 'byte-limited';
  return {
    runPass: async (args?: { force?: boolean }) => ({
      files: 1,
      entries: 1,
      newEntries: 1,
      partial: isByteLimited,
      outcome,
      ioFailures: outcome === 'io-failed' ? 1 : 0,
      storeReset: args?.force === true,
      durationMs: 0,
      generationRollup,
    }),
    sessionTotals: () => new Map(),
    stats: () => ({ dirs: [], files: 0, entries: 0, lastScanMs: 0, lastOutcome: outcome, isHistoryCaughtUp: outcome === 'complete', resolutionError: null }),
    budgetSpend: spend,
    latestCodexRateLimits: () => null,
    buildReport: () => ({
      ts: 0,
      tz: 'UTC',
      blockHours: 5,
      totals: { tokens: 0, costUSD: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, byVendor: {} },
      daily: [],
      models: [],
      sessions: [],
      blocks: [],
      activeBlock: null,
      anomaly: { daily: null, burn: null },
      byLane: LANE_ROWS,
      planWindowLanes: PLAN_WINDOW_LANES,
      budget: BUDGET_BLOCK,
      tokenLimit: null,
      pricing: { missing: [] },
      scan: { dirs: [], files: 0, entries: 0, lastScanMs: 0, partial: false, outcome: 'complete', ioFailures: 0, resolutionError: null },
    }),
  };
}

const inertInterval = () => {
  const handle = setTimeout(() => {}, 0);
  handle.unref();
  return handle;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function blockAt(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (!isRecord(value)) throw new Error(`no ${key} block`);
  return value;
}

interface BudgetAlert {
  type: 'usage-budget-alert';
  scope: string;
  threshold: number;
  spentUsd: number;
  budgetUsd: number;
  periodKey: string;
  ts: number;
  text: string;
}

function isBudgetAlert(frame: Record<string, unknown>): frame is Record<string, unknown> & BudgetAlert {
  return frame.type === 'usage-budget-alert';
}

interface StoredBudgetState {
  fired: { daily: Record<string, unknown>; monthly: Record<string, unknown> };
}

const TODAY = '2026-08-19';
const MONTH = '2026-08';

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-usage-budget-'));
}

interface HarnessOptions {
  root: string;
  usage?: Record<string, unknown>;
  telegram?: { botToken?: string; chatId?: string } | null;
  telegramNotifications?: boolean;
  connections?: number;
  spend?: { todayUsd: number; monthUsd: number };
  fsPromises?: typeof fs;
  sendTelegram?: NonNullable<UsageWiringOptions['sendTelegram']>;
  telegramTimeoutMs?: number;
  outcome?: PassOutcome;
}

function harness({ root, usage = {}, telegram = null, telegramNotifications = false, connections = 1, spend = { todayUsd: 0, monthUsd: 0 }, fsPromises = fs, sendTelegram, telegramTimeoutMs, outcome = 'complete' }: HarnessOptions) {
  const sent: Record<string, unknown>[] = [];
  const telegrams: { text?: string; botToken?: string; chatId?: string }[] = [];
  const warnings: string[] = [];
  const state = { spend };
  const spendCalls = { count: 0 };
  const scanner = fakeScanner({
    outcome,
    spend: () => {
      spendCalls.count += 1;
      return { todayKey: TODAY, monthKey: MONTH, ...state.spend };
    },
  });
  const config = { usage, telegramNotifications, telegram };
  const wiringOptions: UsageWiringOptions = {
    config,
    sessions: new Map(),
    broadcast: (message) => { sent.push(message); },
    controlClientCount: () => connections,
    createScanner: () => scanner,
    loadPricingFn: async () => ({ table: new Map(), source: 'snapshot', fetchedAt: null }),
    nowFn: () => 1_800_000_000_000,
    setIntervalFn: inertInterval,
    clearIntervalFn: (handle) => clearTimeout(handle),
    logger: { warn: (message) => { warnings.push(String(message)); }, log: () => {} },
    budgetStatePath: path.join(root, '.glimmervoid', 'usage-budget-state.json'),
    fsPromises,
    sendTelegram: sendTelegram ?? (async (args) => {
      telegrams.push(args);
      return { ok: true, error: null };
    }),
    rtkPathFn: () => null,
    telegramTimeoutMs,
  };
  const wiring = createUsageWiring(wiringOptions);
  return {
    wiring,
    scanner,
    sent,
    telegrams,
    state,
    warnings,
    spendCalls,
    alerts: (): BudgetAlert[] => sent.filter(isBudgetAlert),
    statePath: path.join(root, '.glimmervoid', 'usage-budget-state.json'),
  };
}

async function readState(statePath: string): Promise<StoredBudgetState> {
  const parsed: unknown = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.fired)) throw new Error('the budget state file carries no fired block');
  const { daily, monthly } = parsed.fired;
  if (!isRecord(daily) || !isRecord(monthly)) throw new Error('the fired block carries no period maps');
  return { fired: { daily, monthly } };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test('the fired state survives a restart', async () => {
  const root = await makeTempRoot();
  const first = harness({ root, usage: { budget: { dailyUsd: 16 } }, spend: { todayUsd: 12.4, monthUsd: 12.4 } });
  await first.wiring.start();
  assert.equal(first.alerts().length, 1);

  const second = harness({ root, usage: { budget: { dailyUsd: 16 } }, spend: { todayUsd: 12.4, monthUsd: 12.4 } });
  await second.wiring.start();
  assert.equal(second.alerts().length, 0, 'a fresh process reads the marks off disk');
});

test('an unreadable budget state warns, keeps its bytes, and never rewrites them', async () => {
  const root = await makeTempRoot();
  const statePath = path.join(root, '.glimmervoid', 'usage-budget-state.json');
  const original = '{ recoverable later';
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, original);
  const error: NodeJS.ErrnoException = new Error('EACCES simulated');
  error.code = 'EACCES';
  const h = harness({
    root,
    usage: { budget: { dailyUsd: 16 } },
    spend: { todayUsd: 12.4, monthUsd: 12.4 },
    fsPromises: { ...fs, readFile: async () => { throw error; } },
  });
  await h.wiring.start();
  assert.equal(await fs.readFile(statePath, 'utf8'), original);
  assert.ok(h.warnings.some((message) => message.includes('budget state unreadable') && message.includes(statePath)), `warned: ${h.warnings.join(' | ')}`);
});

test('a budget state that becomes readable keeps the marks that fired while it was not', async () => {
  const root = await makeTempRoot();
  const statePath = path.join(root, '.glimmervoid', 'usage-budget-state.json');
  await fs.mkdir(statePath, { recursive: true });
  const h = harness({ root, usage: { budget: { dailyUsd: 16 } }, spend: { todayUsd: 12.4, monthUsd: 12.4 } });
  await h.wiring.start();
  assert.deepEqual(h.alerts().map((alert) => alert.threshold), [75]);
  assert.ok(h.warnings.some((message) => message.includes('budget state unreadable')), `warned: ${h.warnings.join(' | ')}`);

  await fs.rm(statePath, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({ version: 1, fired: { daily: {}, monthly: {} } }));
  await h.wiring.requestReport({ force: true });
  assert.deepEqual(h.alerts().map((alert) => alert.threshold), [75], 'a recovered read never re-fires an alert already delivered');
  assert.deepEqual((await readState(statePath)).fired.daily[TODAY], [50, 75]);
});

test('a budget state that goes missing after an unreadable read keeps the marks that fired while it was not', async () => {
  const root = await makeTempRoot();
  const statePath = path.join(root, '.glimmervoid', 'usage-budget-state.json');
  await fs.mkdir(statePath, { recursive: true });
  const h = harness({ root, usage: { budget: { dailyUsd: 16 } }, spend: { todayUsd: 12.4, monthUsd: 12.4 } });
  await h.wiring.start();
  assert.deepEqual(h.alerts().map((alert) => alert.threshold), [75]);
  assert.ok(h.warnings.some((message) => message.includes('budget state unreadable')), `warned: ${h.warnings.join(' | ')}`);

  await fs.rm(statePath, { recursive: true });
  await h.wiring.requestReport({ force: true });
  assert.deepEqual(h.alerts().map((alert) => alert.threshold), [75], 'a read that finds nothing never re-fires an alert already delivered');
  assert.deepEqual((await readState(statePath)).fired.daily[TODAY], [50, 75]);
});

test('an io-failed pass never evaluates budgets', async () => {
  const root = await makeTempRoot();
  let budgetSpendCalls = 0;
  const wiring = createUsageWiring({
    config: { usage: { budget: { dailyUsd: 16 } } },
    sessions: new Map(),
    controlClientCount: () => 0,
    createScanner: () => fakeScanner({
      outcome: 'io-failed',
      spend: () => {
        budgetSpendCalls += 1;
        return { todayKey: TODAY, monthKey: MONTH, todayUsd: 12.4, monthUsd: 12.4 };
      },
    }),
    loadPricingFn: async () => ({ table: new Map(), source: 'snapshot', fetchedAt: null }),
    nowFn: () => 1,
    setIntervalFn: inertInterval,
    clearIntervalFn: (handle) => clearTimeout(handle),
    logger: { warn: () => {}, log: () => {} },
    budgetStatePath: path.join(root, '.glimmervoid', 'usage-budget-state.json'),
  });

  await wiring.start();
  assert.equal(budgetSpendCalls, 0);
  assert.equal(await exists(path.join(root, '.glimmervoid', 'usage-budget-state.json')), false);
  await wiring.stop();
});


test('a rejected Telegram send leaves the threshold unfired, warns, and alerts again', async () => {
  const root = await makeTempRoot();
  let sendAttempts = 0;
  const h = harness({
    root,
    usage: { budget: { dailyUsd: 16 } },
    spend: { todayUsd: 12.4, monthUsd: 12.4 },
    connections: 0,
    telegramNotifications: true,
    telegram: { botToken: 'bot', chatId: 'chat' },
    sendTelegram: async () => {
      sendAttempts += 1;
      throw new Error('offline');
    },
  });

  await h.wiring.start();
  assert.equal(sendAttempts, 1);
  assert.equal(h.alerts().length, 1);
  assert.equal((await readState(h.statePath)).fired.daily[TODAY], undefined);
  assert.deepEqual(h.warnings, [`[usage] budget telegram failed scope=daily period=${TODAY} error=offline`]);

  await h.wiring.requestReport({ force: true });
  assert.equal(sendAttempts, 2);
  assert.equal(h.alerts().length, 2);
  assert.equal((await readState(h.statePath)).fired.daily[TODAY], undefined);
});

test('a resolved Telegram send stamps the threshold and the next pass stays silent', async () => {
  const root = await makeTempRoot();
  let sendAttempts = 0;
  const h = harness({
    root,
    usage: { budget: { dailyUsd: 16 } },
    spend: { todayUsd: 12.4, monthUsd: 12.4 },
    connections: 0,
    telegramNotifications: true,
    telegram: { botToken: 'bot', chatId: 'chat' },
    sendTelegram: async () => {
      sendAttempts += 1;
      return { ok: true, error: null };
    },
  });

  await h.wiring.start();
  await h.wiring.requestReport({ force: true });

  assert.equal(sendAttempts, 1);
  assert.equal(h.alerts().length, 1);
  assert.deepEqual((await readState(h.statePath)).fired.daily[TODAY], [50, 75]);
});

test('a Telegram send that never answers times out inside the transport, leaving the threshold unfired', async () => {
  const root = await makeTempRoot();
  let sendAttempts = 0;
  const transportWarnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => { transportWarnings.push(String(message)); };
  const h = harness({
    root,
    usage: { budget: { dailyUsd: 16 } },
    spend: { todayUsd: 12.4, monthUsd: 12.4 },
    connections: 0,
    telegramNotifications: true,
    telegram: { botToken: 'bot', chatId: 'chat' },
    telegramTimeoutMs: 5,
    sendTelegram: (options) => {
      sendAttempts += 1;
      return sendTelegramMessage({ ...options, transport: () => new Promise(() => {}) });
    },
  });

  try {
    await h.wiring.start();
    assert.equal(sendAttempts, 1);
    assert.equal(h.alerts().length, 1);
    assert.equal((await readState(h.statePath)).fired.daily[TODAY], undefined);
    assert.deepEqual(h.warnings, [`[usage] budget telegram failed scope=daily period=${TODAY} error="Telegram did not answer within 5 ms"`]);

    await h.wiring.requestReport({ force: true });
    assert.equal(sendAttempts, 2, 'an undelivered threshold is retried on the next pass');
    assert.equal(h.alerts().length, 2);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(transportWarnings, ['[telegram] Telegram did not answer within 5 ms', '[telegram] Telegram did not answer within 5 ms']);
});

test('a declined Telegram send logs the transport error', async () => {
  const root = await makeTempRoot();
  const h = harness({
    root,
    usage: { budget: { dailyUsd: 16 } },
    spend: { todayUsd: 12.4, monthUsd: 12.4 },
    connections: 0,
    telegramNotifications: true,
    telegram: { botToken: 'bot', chatId: 'chat' },
    sendTelegram: async () => ({ ok: false, error: 'telegram 429' }),
  });

  await h.wiring.start();
  assert.deepEqual(h.warnings, [`[usage] budget telegram failed scope=daily period=${TODAY} error="telegram 429"`]);
  assert.equal((await readState(h.statePath)).fired.daily[TODAY], undefined);
});

test('evaluations queued behind an outstanding delivery coalesce into one', async () => {
  const root = await makeTempRoot();
  let releaseSend = () => {};
  let markSendStarted = () => {};
  const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
  const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
  const h = harness({
    root,
    usage: { budget: { dailyUsd: 16 } },
    spend: { todayUsd: 0, monthUsd: 0 },
    connections: 0,
    telegramNotifications: true,
    telegram: { botToken: 'bot', chatId: 'chat' },
    sendTelegram: async () => {
      markSendStarted();
      await sendGate;
      return { ok: true, error: null };
    },
  });

  await h.wiring.start();
  assert.equal(h.spendCalls.count, 1, 'the boot evaluation');
  h.state.spend = { todayUsd: 12.4, monthUsd: 12.4 };

  const alerting = h.wiring.requestReport({ force: true });
  await sendStarted;
  const queued = [
    h.wiring.requestReport({ force: true }),
    h.wiring.requestReport({ force: true }),
    h.wiring.requestReport({ force: true }),
  ];
  releaseSend();
  await Promise.all([alerting, ...queued]);

  assert.equal(h.spendCalls.count, 3, 'three passes behind the outstanding send collapse to one evaluation');
  assert.equal(h.alerts().length, 1);
  assert.deepEqual((await readState(h.statePath)).fired.daily[TODAY], [50, 75]);
});

test('a standing io failure evaluates budgets once the streak passes its bound, and never before', async () => {
  const root = await makeTempRoot();
  const h = harness({
    root,
    usage: { budget: { dailyUsd: 16 } },
    spend: { todayUsd: 12.4, monthUsd: 12.4 },
    outcome: 'io-failed',
  });

  await h.wiring.start();
  assert.equal(h.spendCalls.count, 0, 'the first io-failed pass evaluates nothing');
  await h.wiring.requestReport({ force: true });
  assert.equal(h.spendCalls.count, 0, 'nor the second');

  await h.wiring.requestReport({ force: true });
  assert.equal(h.spendCalls.count, 1, 'the third breaks the stall');
  assert.equal(h.alerts().length, 1, 'an undercount can only delay an alert, never fabricate one');
  await h.wiring.stop();
});

test('byLane, planWindowLanes and budget reach the wire on a pulled report', async () => {
  const root = await makeTempRoot();
  const h = harness({ root });
  const report = await h.wiring.requestReport({ requestId: 'r1' });
  assert.equal(report.type, 'usage-report');
  assert.deepEqual(report.byLane, LANE_ROWS);
  assert.deepEqual(report.planWindowLanes, PLAN_WINDOW_LANES);
  assert.deepEqual(report.budget, BUDGET_BLOCK);
  const cached = h.wiring.getCachedReport();
  assert.ok(cached, 'a pulled report is cached for the next connect');
  assert.deepEqual(blockAt(cached, 'budget'), BUDGET_BLOCK);
  assert.deepEqual(cached.byLane, report.byLane);
});
