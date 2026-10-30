import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createUsageScanner } from '../server/usage/usage-scanner.ts';
import type { UsageScannerOptions } from '../server/usage/usage-scanner.ts';
import { laneSpendStatus } from '../server/usage/core/usage-scan-core.ts';
import { normalizePricingTable } from '../server/usage/core/usage-pricing-core.ts';

type Scanner = ReturnType<typeof createUsageScanner>;

const pricingTable = normalizePricingTable({
  'claude-sonnet-4-20250514': {
    input_cost_per_token: 1,
    output_cost_per_token: 2,
    cache_creation_input_token_cost: 3,
    cache_read_input_token_cost: 4,
  },
});

test('runPass ingests a fixture tree and append reruns ingest only new entries', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10, output: 1, sessionId: 'inline-a' }),
    usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20, output: 1, sessionId: 'inline-a' }),
  ]);
  const scanner = makeScanner(root);

  const first = await scanner.runPass();
  assert.equal(first.files, 1);
  assert.equal(first.entries, 2);
  assert.equal(first.newEntries, 2);
  assert.equal(scanner.stats().entries, 2);

  const firstSize = (await fs.stat(transcript)).size;
  await fs.appendFile(transcript, `${usageLine({ messageId: 'message-c', requestId: 'request-c', input: 30, output: 1, sessionId: 'inline-a' })}\n`);
  const second = await scanner.runPass();
  assert.equal(second.entries, 3);
  assert.equal(second.newEntries, 1);
  assert.equal(scanner.sessionTotals().get('inline-a')?.tokens, 63);
  assert.ok((await fs.stat(transcript)).size > firstSize);
});

test('an unreadable transcript directory yields io-failed and leaves an unchanged warehouse byte-identical', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcriptDir = path.join(projectsDir, 'C--repo');
  const transcript = path.join(transcriptDir, 'session-a.jsonl');
  const warehousePath = path.join(root, '.glimmervoid', 'usage-warehouse.json');
  await writeLines(transcript, [usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 })]);
  let isTranscriptDirUnreadable = false;
  let now = Date.parse('2026-08-19T12:00:00.000Z');
  const injectedFs = {
    ...fs,
    readdir: async (dir: string, options: { withFileTypes: true }) => {
      if (isTranscriptDirUnreadable && dir === transcriptDir) throw new Error('denied');
      return fs.readdir(dir, options);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs, warehousePath, nowFn: () => now });

  const complete = await scanner.runPass();
  assert.equal(complete.outcome, 'complete');
  const beforeFailure = await fs.readFile(warehousePath);
  now += 60_000;
  isTranscriptDirUnreadable = true;

  const failed = await scanner.runPass();
  assert.equal(failed.outcome, 'io-failed');
  assert.equal(failed.ioFailures, 1);
  assert.equal(failed.partial, false);
  assert.deepEqual(await fs.readFile(warehousePath), beforeFailure);
});

test('an incremental io-failed pass still persists what the readable files added', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const readableDir = path.join(projectsDir, 'C--repo');
  const deniedDir = path.join(projectsDir, 'C--other');
  const warehousePath = path.join(root, '.glimmervoid', 'usage-warehouse.json');
  await writeLines(path.join(readableDir, 'session-a.jsonl'), [usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 })]);
  await writeLines(path.join(deniedDir, 'session-b.jsonl'), [usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 })]);
  let isDeniedDirUnreadable = false;
  let now = Date.parse('2026-08-19T12:00:00.000Z');
  const injectedFs = {
    ...fs,
    readdir: async (dir: string, options: { withFileTypes: true }) => {
      if (isDeniedDirUnreadable && dir === deniedDir) throw new Error('denied');
      return fs.readdir(dir, options);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs, warehousePath, nowFn: () => now });

  assert.equal((await scanner.runPass()).outcome, 'complete');
  const tokensAfterComplete = await warehouseTokens(warehousePath);
  now += 60_000;
  isDeniedDirUnreadable = true;
  await fs.appendFile(
    path.join(readableDir, 'session-a.jsonl'),
    `${usageLine({ messageId: 'message-c', requestId: 'request-c', input: 30 })}\n`,
  );

  const failed = await scanner.runPass();
  assert.equal(failed.outcome, 'io-failed');
  assert.equal(failed.storeReset, false);
  assert.equal(await warehouseTokens(warehousePath), tokensAfterComplete + 30);
});

test('a forced io-failed pass leaves the warehouse untouched rather than persisting the half-rebuilt store', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const readableDir = path.join(projectsDir, 'C--repo');
  const deniedDir = path.join(projectsDir, 'C--other');
  const warehousePath = path.join(root, '.glimmervoid', 'usage-warehouse.json');
  await writeLines(path.join(readableDir, 'session-a.jsonl'), [usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 })]);
  await writeLines(path.join(deniedDir, 'session-b.jsonl'), [usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 })]);
  let isDeniedDirUnreadable = false;
  let now = Date.parse('2026-08-19T12:00:00.000Z');
  const injectedFs = {
    ...fs,
    readdir: async (dir: string, options: { withFileTypes: true }) => {
      if (isDeniedDirUnreadable && dir === deniedDir) throw new Error('denied');
      return fs.readdir(dir, options);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs, warehousePath, nowFn: () => now });

  assert.equal((await scanner.runPass()).outcome, 'complete');
  const beforeFailure = await fs.readFile(warehousePath);
  now += 60_000;
  isDeniedDirUnreadable = true;

  const forced = await scanner.runPass({ force: true });
  assert.equal(forced.outcome, 'io-failed');
  assert.equal(forced.storeReset, true);
  assert.deepEqual(await fs.readFile(warehousePath), beforeFailure);
});

test('a file deleted between the stat and the open is skipped, not counted as an io failure', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const present = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const deleted = path.join(projectsDir, 'C--repo', 'session-b.jsonl');
  await writeLines(present, [usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 })]);
  await writeLines(deleted, [usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 })]);
  const missing: NodeJS.ErrnoException = new Error('ENOENT simulated');
  missing.code = 'ENOENT';
  const injectedFs = {
    ...fs,
    open: async (file: string, flags: string) => {
      if (file === deleted) throw missing;
      return fs.open(file, flags);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs });

  const result = await scanner.runPass();
  assert.equal(result.files, 2);
  assert.equal(result.entries, 1);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.ioFailures, 0);
});

test('failing opens cost no extra pricing sweep over the entries already held', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const readable = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(readable, [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 }),
    usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 }),
    usageLine({ messageId: 'message-c', requestId: 'request-c', input: 30 }),
  ]);
  const unreadable = ['session-b.jsonl', 'session-c.jsonl', 'session-d.jsonl']
    .map((name) => path.join(projectsDir, 'C--repo', name));
  for (const file of unreadable) await writeLines(file, [usageLine({ messageId: `message-${path.basename(file)}`, requestId: 'request-x', input: 5 })]);
  const injectedFs = {
    ...fs,
    open: async (file: string, flags: string) => {
      if (unreadable.includes(file)) throw new Error('denied');
      return fs.open(file, flags);
    },
  };
  let priceLookups = 0;
  const countingPricingTable = new Map(pricingTable);
  const lookupPrice = countingPricingTable.get.bind(countingPricingTable);
  countingPricingTable.get = (key: string) => {
    priceLookups += 1;
    return lookupPrice(key);
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs, pricingTable: countingPricingTable });

  const result = await scanner.runPass();
  assert.equal(result.ioFailures, 3);
  assert.equal(result.entries, 3);
  assert.equal(priceLookups, 3, 'one lookup per ingested entry, none re-swept per failed file');
});

test('a file that vanishes between the walk and the stat is skipped, not counted as an io failure', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const present = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const vanished = path.join(projectsDir, 'C--repo', 'session-b.jsonl');
  await writeLines(present, [usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 })]);
  await writeLines(vanished, [usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 })]);
  const missing: NodeJS.ErrnoException = new Error('ENOENT simulated');
  missing.code = 'ENOENT';
  const injectedFs = {
    ...fs,
    stat: async (file: string) => {
      if (file === vanished) throw missing;
      return fs.stat(file);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs });

  const result = await scanner.runPass();
  assert.equal(result.files, 2);
  assert.equal(result.entries, 1);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.ioFailures, 0);
});

test('a directory that vanishes between the walk and the readdir is skipped, not counted as an io failure', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcriptDir = path.join(projectsDir, 'C--repo');
  await writeLines(path.join(transcriptDir, 'session-a.jsonl'), [usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 })]);
  const missing: NodeJS.ErrnoException = new Error('ENOENT simulated');
  missing.code = 'ENOENT';
  const injectedFs = {
    ...fs,
    readdir: async (dir: string, options: { withFileTypes: true }) => {
      if (dir === transcriptDir) throw missing;
      return fs.readdir(dir, options);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs });

  const result = await scanner.runPass();
  assert.equal(result.files, 0);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.ioFailures, 0);
});

test('an unreadable projects root is an io failure, never an empty complete pass', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 }),
  ]);
  const denied: NodeJS.ErrnoException = new Error('EACCES simulated');
  denied.code = 'EACCES';
  const injectedFs = {
    ...fs,
    stat: async (file: string) => {
      if (file === projectsDir) throw denied;
      return fs.stat(file);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs });

  const result = await scanner.runPass();
  assert.equal(result.files, 0);
  assert.equal(result.outcome, 'io-failed');
  assert.equal(result.ioFailures, 1);
  const scan = scanner.buildReport().scan;
  assert.equal(scan.outcome, 'io-failed');
  assert.equal(scan.ioFailures, 1);
});

test('an unreadable vendor root is an io failure', async () => {
  const root = await makeTempRoot();
  await makeProjectsDir(root);
  const codexSessions = path.join(root, '.codex', 'sessions');
  await fs.mkdir(codexSessions, { recursive: true });
  const denied: NodeJS.ErrnoException = new Error('EIO simulated');
  denied.code = 'EIO';
  const injectedFs = {
    ...fs,
    stat: async (file: string) => {
      if (file === codexSessions) throw denied;
      return fs.stat(file);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs });

  const result = await scanner.runPass();
  assert.equal(result.outcome, 'io-failed');
  assert.equal(result.ioFailures, 1);
});

test('budgetSpend sees the whole month even when retainDays is shorter than it', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');

  await writeLines(transcript, [
    usageLine({ messageId: 'm-early', requestId: 'r1', input: 1000, timestamp: '2026-08-02T10:00:00.000Z' }),
    usageLine({ messageId: 'm-mid', requestId: 'r2', input: 1000, timestamp: '2026-08-09T10:00:00.000Z' }),
    usageLine({ messageId: 'm-today', requestId: 'r3', input: 1000, timestamp: '2026-08-19T10:00:00.000Z' }),
  ]);
  const scanner = makeScanner(root, { retainDays: 7, budget: { monthlyUsd: 100 } });
  await scanner.runPass();

  const spend = scanner.budgetSpend();
  assert.equal(spend.todayKey, '2026-08-19');
  assert.equal(spend.monthKey, '2026-08');

  assert.equal(spend.monthUsd > spend.todayUsd, true, `month ${spend.monthUsd} should exceed today ${spend.todayUsd}`);
  assert.equal(Math.round(spend.monthUsd / spend.todayUsd), 3, 'all three days');

  assert.equal(scanner.buildReport({}).daily.length, 1, 'the report window is untouched');

  const narrow = makeScanner(root, { retainDays: 7 });
  await narrow.runPass();
  assert.equal(narrow.budgetSpend().monthUsd, narrow.budgetSpend().todayUsd, 'no budget, no widening');
});

test('budgetSpend shares the report rollups when retainDays already covers the month', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'm1', requestId: 'r1', input: 1000, timestamp: '2026-08-19T10:00:00.000Z' }),
  ]);

  const scanner = makeScanner(root);
  await scanner.runPass();
  const spend = scanner.budgetSpend();
  assert.equal(spend.todayUsd, spend.monthUsd);
  assert.equal(spend.monthUsd > 0, true);
});

test('a report for N days covers today and the N-1 previous local calendar days, not a rolling window', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const localIso = (day: number, hour: number) => new Date(2026, 7, day, hour).toISOString();
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'm-before-window', requestId: 'r1', input: 1000, timestamp: localIso(17, 20) }),
    usageLine({ messageId: 'm-yesterday', requestId: 'r2', input: 1000, timestamp: localIso(18, 1) }),
    usageLine({ messageId: 'm-today', requestId: 'r3', input: 1000, timestamp: localIso(19, 9) }),
  ]);
  const scanner = makeScanner(root, { nowFn: () => new Date(2026, 7, 19, 12).getTime() });
  await scanner.runPass();

  const twoDays = scanner.buildReport({ days: 2 });
  assert.deepEqual(twoDays.daily.map((row) => row.day), ['2026-08-18', '2026-08-19']);
  assert.equal(twoDays.totals.tokens, 2000);
  assert.equal(twoDays.totals.costUSD, twoDays.daily.reduce((sum, row) => sum + row.costUSD, 0));
  assert.equal(scanner.buildReport({ days: 1 }).totals.tokens, 1000, 'one day is today only');
});

test('yourDay recaps yesterday from operator-typed Claude and Codex prompts and skips lane and automated sessions', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 7, day, hour, minute).getTime();
  const baselineDayLines = [15, 16, 17].flatMap((day) => [promptLine(`baseline-${day}`, at(day, 9)), turnEndLine(`baseline-${day}`, at(day, 9, 1)), promptLine(`baseline-${day}`, at(day, 9, 30))]);
  const longStretchLines = Array.from({ length: 23 }, (_, index) => promptLine('focused', at(18, 10, index * 10)));
  const jugglingLines = Array.from({ length: 6 }, (_, index) => promptLine(`juggled-${index}`, at(18, 15, index * 5)));
  const laneLines = Array.from({ length: 8 }, (_, index) => promptLine('lane-review', at(18, 20, index * 2)));
  await writeLines(path.join(projectsDir, 'C--repo', 'baseline.jsonl'), baselineDayLines);
  await writeLines(path.join(projectsDir, 'C--repo', 'focused.jsonl'), longStretchLines);
  await writeLines(path.join(projectsDir, 'C--repo', 'juggled.jsonl'), jugglingLines);
  await writeLines(path.join(projectsDir, 'C--repo', 'lane-review.jsonl'), laneLines);
  const timerLines = Array.from({ length: 96 }, (_, index) => promptLine('sdk-timer', at(18, 0, index * 15), { entrypoint: 'sdk-cli', turnOrigin: 'sdk' }));
  const notificationLines = [promptLine('focused', at(18, 21), { entrypoint: 'cli', turnOrigin: 'task_notification' })];
  await writeLines(path.join(projectsDir, 'C--repo', 'sdk-timer.jsonl'), timerLines);
  await writeLines(path.join(projectsDir, 'C--repo', 'focused-notified.jsonl'), notificationLines);
  await writeLines(path.join(projectsDir, 'C--repo', 'long-open.jsonl'), [promptLine('long-open', at(15, 11)), promptLine('long-open', at(18, 16))]);
  const codexSessionId = '01a14ecf-57c8-75c2-a17d-3f989a77596f';
  await writeLines(path.join(root, '.codex', 'sessions', '2026', '08', '18', `rollout-2026-08-18T17-00-00-${codexSessionId}.jsonl`), [
    JSON.stringify({ timestamp: new Date(at(18, 17)).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'fix it' } }),
    JSON.stringify({ timestamp: new Date(at(18, 17, 5)).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }),
  ]);
  const scanner = makeScanner(root, { nowFn: () => at(19, 12), laneMap: () => new Map([['claude:lane-review', 'review']]) });

  await scanner.runPass();
  const { yourDay } = scanner.buildReport();

  assert.equal(yourDay?.yesterday.day, '2026-08-18');
  assert.equal(yourDay?.yesterday.sessionCount, 9);
  assert.deepEqual(yourDay?.insights.map((insight) => insight.kind).sort(), ['juggling', 'longestStretch']);
  assert.ok(yourDay?.insights.some((insight) => insight.text === '3h 40m without a break. Break every 90m.'));
  assert.ok(yourDay?.insights.every((insight) => !/operator/i.test(insight.text)));
  assert.equal(yourDay?.currentStretchStartedAt, null);
});

function makeScanner(root: string, overrides: UsageScannerOptions = {}): Scanner {
  return createUsageScanner({
    env: { HOME: root },
    pricingTable,
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
    ...overrides,
  });
}

async function warehouseTokens(warehousePath: string): Promise<number> {
  const parsed: unknown = JSON.parse(await fs.readFile(warehousePath, 'utf8'));
  const records = (parsed as { records?: { tokens?: number }[] }).records || [];
  return records.reduce((total, record) => total + (record.tokens || 0), 0);
}

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-usage-scanner-'));
}

async function makeProjectsDir(root: string): Promise<string> {
  const projectsDir = path.join(root, '.claude', 'projects');
  await fs.mkdir(projectsDir, { recursive: true });
  return projectsDir;
}

async function writeLines(file: string, lines: string[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${lines.join('\n')}\n`);
}

function usageLine({
  messageId,
  requestId,
  input = 1,
  output = 0,
  sessionId = 'session-a',
  model = 'claude-sonnet-4-20250514',
  timestamp = '2026-08-19T10:00:00.000Z',
  isSidechain = false,
  iterations = [],
}: {
  messageId?: string;
  requestId?: string;
  input?: number;
  output?: number;
  sessionId?: string;
  model?: string;
  timestamp?: string;
  isSidechain?: boolean;
  iterations?: unknown[];
}): string {
  return JSON.stringify({
    timestamp,
    sessionId,
    requestId,
    cwd: 'C:/repo',
    version: '2.1.200',
    isSidechain,
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations,
      },
    },
  });
}

test('scanner catch-up survives a later byte limit and resets on a forced partial scan', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const firstLine = usageLine({ messageId: 'history', requestId: 'history', input: 10 });
  const secondLine = usageLine({ messageId: 'later-a', requestId: 'later-a', input: 20 });
  const thirdLine = usageLine({ messageId: 'later-b', requestId: 'later-b', input: 30 });
  await writeLines(transcript, [firstLine]);
  const scanner = makeScanner(root, { byteBudget: Buffer.byteLength(firstLine) + 1 });
  assert.equal(scanner.stats().isHistoryCaughtUp, false);
  assert.equal((await scanner.runPass()).outcome, 'complete');
  assert.equal(scanner.stats().isHistoryCaughtUp, true);
  await fs.appendFile(transcript, `${secondLine}\n${thirdLine}\n`);
  assert.equal((await scanner.runPass()).outcome, 'byte-limited');
  assert.equal(scanner.stats().isHistoryCaughtUp, true);
  assert.equal(laneSpendStatus({ isTrackingEnabled: true, scan: scanner.stats() }), 'known');
  assert.equal((await scanner.runPass({ force: true })).outcome, 'byte-limited');
  assert.equal(scanner.stats().isHistoryCaughtUp, false);
  assert.equal(laneSpendStatus({ isTrackingEnabled: true, scan: scanner.stats() }), 'catching-up');
});

test('scanner IO failure after catch-up makes lane spend read-failing until recovery', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [usageLine({ messageId: 'history', requestId: 'history', input: 10 })]);
  let shouldFailRead = false;
  const scanner = makeScanner(root, { fsPromises: { ...fs, readdir: async (directory: string, options: { withFileTypes: true }) => {
    if (shouldFailRead && directory === path.dirname(transcript)) throw new Error('denied');
    return fs.readdir(directory, options);
  } } });
  assert.equal((await scanner.runPass()).outcome, 'complete');
  shouldFailRead = true;
  assert.equal((await scanner.runPass()).outcome, 'io-failed');
  assert.equal(scanner.stats().isHistoryCaughtUp, true);
  assert.equal(laneSpendStatus({ isTrackingEnabled: true, scan: scanner.stats() }), 'read-failing');
  shouldFailRead = false;
  assert.equal((await scanner.runPass()).outcome, 'complete');
  assert.equal(laneSpendStatus({ isTrackingEnabled: true, scan: scanner.stats() }), 'known');
});

function promptLine(sessionId: string, timestampMs: number, origin: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', sessionId, timestamp: new Date(timestampMs).toISOString(), isSidechain: false, ...origin, message: { role: 'user', content: 'keep going' } });
}

function turnEndLine(sessionId: string, timestampMs: number): string {
  return JSON.stringify({ type: 'assistant', sessionId, timestamp: new Date(timestampMs).toISOString(), isSidechain: false, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
}
