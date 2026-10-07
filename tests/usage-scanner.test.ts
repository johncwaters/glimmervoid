import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createUsageScanner } from '../server/usage-scanner.ts';
import type { UsageScannerOptions } from '../server/usage-scanner.ts';
import { planWindowStartsMs } from '../server/core/usage-lane-core.ts';
import { normalizePricingTable } from '../server/core/usage-pricing-core.ts';

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

test('planWindowLanes splits Claude spend by lane over the active block and the last 7 days', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'review.jsonl'), [
    usageLine({ messageId: 'old-review', requestId: 'r1', input: 100, sessionId: 'review', timestamp: '2026-08-15T10:00:00.000Z' }),
    usageLine({ messageId: 'now-review', requestId: 'r2', input: 30, sessionId: 'review', timestamp: '2026-08-19T10:00:00.000Z' }),
  ]);
  await writeLines(path.join(projectsDir, 'C--repo', 'mine.jsonl'), [
    usageLine({ messageId: 'now-mine', requestId: 'r3', input: 70, sessionId: 'mine', timestamp: '2026-08-19T11:00:00.000Z' }),
    usageLine({ messageId: 'stale-mine', requestId: 'r4', input: 500, sessionId: 'mine', timestamp: '2026-08-01T11:00:00.000Z' }),
  ]);
  const scanner = makeScanner(root, { laneMap: () => new Map([['claude:review', 'team-review']]) });
  await scanner.runPass();

  const lanes = scanner.buildReport({ days: 1 }).planWindowLanes;
  assert.ok(lanes);
  assert.deepEqual(tokensByLane(lanes.fiveHour), { 'team-review': 30, other: 70 });
  assert.deepEqual(tokensByLane(lanes.sevenDay), { 'team-review': 130, other: 70 });
});

function tokensByLane(rows: { lane: string; tokens: number }[] | null | undefined) {
  return Object.fromEntries((rows || []).map((row) => [row.lane, row.tokens]));
}

test('planWindowLanes follows the official plan windows when their resets are known', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'review.jsonl'), [
    usageLine({ messageId: 'before-week', requestId: 'r1', input: 100, sessionId: 'review', timestamp: '2026-08-13T00:00:00.000Z' }),
    usageLine({ messageId: 'before-block', requestId: 'r2', input: 20, sessionId: 'review', timestamp: '2026-08-19T08:30:00.000Z' }),
    usageLine({ messageId: 'in-block', requestId: 'r3', input: 30, sessionId: 'review', timestamp: '2026-08-19T09:00:00.000Z' }),
  ]);
  await writeLines(path.join(projectsDir, 'C--repo', 'mine.jsonl'), [
    usageLine({ messageId: 'mine', requestId: 'r4', input: 70, sessionId: 'mine', timestamp: '2026-08-19T11:00:00.000Z' }),
  ]);
  const scanner = makeScanner(root, { laneMap: () => new Map([['claude:review', 'team-review']]) });
  await scanner.runPass();
  const planWindowStarts = planWindowStartsMs({
    fiveHour: { pct: 50, resetsAtMs: Date.parse('2026-08-19T14:00:00.000Z') },
    sevenDay: { pct: 20, resetsAtMs: Date.parse('2026-08-20T12:00:00.000Z') },
  }, Date.parse('2026-08-19T12:00:00.000Z'));

  const official = scanner.buildReport({ days: 30, planWindowStarts }).planWindowLanes;
  const local = scanner.buildReport({ days: 30 }).planWindowLanes;

  assert.deepEqual(tokensByLane(official?.fiveHour), { 'team-review': 30, other: 70 });
  assert.deepEqual(tokensByLane(official?.sevenDay), { 'team-review': 50, other: 70 });
  assert.deepEqual(tokensByLane(local?.fiveHour), { 'team-review': 50, other: 70 });
  assert.deepEqual(tokensByLane(local?.sevenDay), { 'team-review': 150, other: 70 });
});

test('planWindowLanes fallback five hour window ignores the report range and configured block length', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const hourlyStartMs = Date.parse('2026-08-18T09:30:00.000Z');
  const hourlyLines = Array.from({ length: 27 }, (_, hourIndex) => usageLine({
    messageId: `hourly-${hourIndex}`,
    requestId: `r-${hourIndex}`,
    sessionId: 'review',
    timestamp: new Date(hourlyStartMs + hourIndex * 60 * 60 * 1000).toISOString(),
  }));
  await writeLines(path.join(projectsDir, 'C--repo', 'review.jsonl'), hourlyLines);
  for (const blockHours of [1, 5, 12]) {
    const scanner = makeScanner(root, { blockHours, laneMap: () => new Map([['claude:review', 'team-review']]) });
    await scanner.runPass();

    const oneDay = scanner.buildReport({ days: 1 }).planWindowLanes;
    const thirtyDays = scanner.buildReport({ days: 30 }).planWindowLanes;

    assert.deepEqual(tokensByLane(oneDay?.fiveHour), { 'team-review': 2 });
    assert.deepEqual(oneDay?.fiveHour, thirtyDays?.fiveHour);
  }
});

test('planWindowLanes reports no seven day window when retained entries cover less than seven days', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'review.jsonl'), [
    usageLine({ messageId: 'in-block', requestId: 'r1', input: 30, sessionId: 'review', timestamp: '2026-08-19T11:00:00.000Z' }),
  ]);
  const scanner = makeScanner(root, { retainDays: 3, laneMap: () => new Map([['claude:review', 'team-review']]) });
  await scanner.runPass();

  const localWindows = scanner.buildReport().planWindowLanes;
  const officialWindows = scanner.buildReport({
    planWindowStarts: { fiveHour: Date.parse('2026-08-19T09:00:00.000Z'), sevenDay: Date.parse('2026-08-14T00:00:00.000Z') },
  }).planWindowLanes;

  assert.equal(localWindows?.sevenDay, null);
  assert.equal(officialWindows?.sevenDay, null);
  assert.deepEqual(tokensByLane(localWindows?.fiveHour), { 'team-review': 30 });
  assert.deepEqual(tokensByLane(officialWindows?.fiveHour), { 'team-review': 30 });
});

test('planWindowLanes counts only Claude use while byLane still attributes a Codex session in the same window', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'claude-work.jsonl'), [
    usageLine({ messageId: 'claude-turn', requestId: 'r1', input: 30, sessionId: 'claude-work', timestamp: '2026-08-19T10:00:00.000Z' }),
  ]);
  const codexSessionId = '019f43ea-76ac-7041-bd4b-6362e85f6630';
  await writeLines(path.join(root, '.codex', 'sessions', '2026', '08', '19', `rollout-2026-08-19T10-30-00-${codexSessionId}.jsonl`), [
    JSON.stringify({ timestamp: '2026-08-19T10:30:00.000Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.5', cwd: 'C:/repo' } }),
    JSON.stringify({
      timestamp: '2026-08-19T10:30:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 },
          model_context_window: 258400,
        },
      },
    }),
  ]);
  const scanner = makeScanner(root, {
    laneMap: () => new Map([['claude:claude-work', 'claude-lane'], [`codex:${codexSessionId}`, 'codex-lane']]),
  });
  await scanner.runPass();

  const report = scanner.buildReport({ days: 1 });

  assert.ok(tokensByLane(report.byLane)['codex-lane'] > 0);
  assert.deepEqual(tokensByLane(report.planWindowLanes?.fiveHour), { 'claude-lane': 30 });
  assert.deepEqual(tokensByLane(report.planWindowLanes?.sevenDay), { 'claude-lane': 30 });
});

test('planWindowLanes is null without a lane ledger', async () => {
  const root = await makeTempRoot();
  await makeProjectsDir(root);
  const scanner = makeScanner(root);
  await scanner.runPass();
  assert.equal(scanner.buildReport().planWindowLanes, null);
});

test('runPass batches yields for unchanged files without changing results', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  for (let fileNumber = 0; fileNumber < 129; fileNumber += 1) {
    await writeLines(path.join(projectsDir, 'C--repo', `session-${fileNumber}.jsonl`), [
      usageLine({ messageId: `message-${fileNumber}`, requestId: `request-${fileNumber}`, input: fileNumber + 1 }),
    ]);
  }
  let yieldCount = 0;
  const scanner = makeScanner(root, { yieldNowFn: async () => { yieldCount += 1; } });

  const first = await scanner.runPass();
  const firstReport = scanner.buildReport();
  yieldCount = 0;
  const second = await scanner.runPass();

  assert.equal(second.entries, first.entries);
  assert.equal(second.newEntries, 0);
  assert.deepEqual(scanner.buildReport(), firstReport);
  assert.ok(yieldCount < second.files);
  assert.equal(yieldCount, 2);
});

test('truncation restarts the file and dedup prevents surviving entries from duplicating', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const survivingLine = usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 });
  await writeLines(transcript, [
    survivingLine,
    usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 }),
  ]);
  const scanner = makeScanner(root);
  assert.equal((await scanner.runPass()).entries, 2);

  await writeLines(transcript, [survivingLine]);
  const second = await scanner.runPass();
  assert.equal(second.entries, 2);
  assert.equal(second.newEntries, 0);
});

test('chunk decoding preserves a split multi-byte character', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const cjk = String.fromCharCode(0x4e2d);
  await writeLines(transcript, [usageLine({ messageId: `message-${cjk}`, requestId: 'request-a', input: 10 })]);
  const scanner = makeScanner(root, { chunkSize: 2 });

  await scanner.runPass();
  const report = scanner.buildReport();
  assert.equal(report.totals.tokens, 10);
  assert.equal(report.pricing.missing.length, 0);
});

test('an unreadable file is skipped while other files ingest', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const readable = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const unreadable = path.join(projectsDir, 'C--repo', 'session-b.jsonl');
  await writeLines(readable, [usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 })]);
  await writeLines(unreadable, [usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 })]);
  const injectedFs = {
    ...fs,
    open: async (file: string, flags: string) => {
      if (file === unreadable) throw new Error('denied');
      return fs.open(file, flags);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs });

  const result = await scanner.runPass();
  assert.equal(result.files, 2);
  assert.equal(result.entries, 1);
  assert.equal(result.newEntries, 1);
  assert.equal(result.outcome, 'io-failed');
  assert.equal(result.ioFailures, 1);
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

test('dedup across configured dirs keeps one entry', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const extraHome = path.join(root, 'extra-claude');
  const extraProjectsDir = path.join(extraHome, 'projects');
  const line = usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 });
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [line]);
  await writeLines(path.join(extraProjectsDir, 'C--repo', 'session-b.jsonl'), [line]);
  const scanner = makeScanner(root, { extraProjectsDirs: [extraHome] });

  const result = await scanner.runPass();
  assert.equal(result.files, 2);
  assert.equal(result.entries, 1);
  assert.equal(result.newEntries, 1);
});

test('runPass is single-flight', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 }),
  ]);
  let statCalls = 0;
  const injectedFs = {
    ...fs,
    stat: async (file: string) => {
      statCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fs.stat(file);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs });

  const first = scanner.runPass();
  const second = scanner.runPass();
  assert.equal(first, second);
  assert.equal((await first).entries, 1);
  assert.ok(statCalls > 0);
});

test('partial pass resumes on the next pass', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 }),
    usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 }),
    usageLine({ messageId: 'message-c', requestId: 'request-c', input: 30 }),
  ]);
  const scanner = makeScanner(root, { byteBudget: 500, chunkSize: 500 });

  const first = await scanner.runPass();
  assert.equal(first.partial, true);
  assert.ok(first.entries < 3);
  const second = await scanner.runPass();
  assert.equal(second.partial, false);
  assert.equal(second.entries, 3);
});

test('sidechain replacement reindexes in place and marks the report dirty', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [
    usageLine({ messageId: 'message-a', requestId: 'request-side', input: 5, isSidechain: true }),
  ]);
  const scanner = makeScanner(root);

  await scanner.runPass();
  const staleReport = scanner.buildReport();
  assert.equal(staleReport.totals.tokens, 5);

  await fs.appendFile(transcript, `${usageLine({ messageId: 'message-a', requestId: 'request-main', input: 11 })}\n`);
  const replacement = await scanner.runPass();
  assert.equal(replacement.entries, 1);
  assert.equal(replacement.newEntries, 0);
  assert.equal(scanner.buildReport().totals.tokens, 11);

  await fs.appendFile(transcript, `${usageLine({ messageId: 'message-a', requestId: 'request-side', input: 5, isSidechain: true })}\n`);
  await fs.appendFile(transcript, `${usageLine({ messageId: 'message-a', requestId: 'request-main', input: 11 })}\n`);
  await scanner.runPass();
  assert.equal(scanner.buildReport().totals.tokens, 11);
});

test('report time fields are fresh when no entries changed', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10, timestamp: '2026-08-19T10:00:00.000Z' }),
  ]);
  let now = Date.parse('2026-08-19T12:00:00.000Z');
  const scanner = makeScanner(root, { nowFn: () => now, blockHours: 5 });

  await scanner.runPass();
  const first = scanner.buildReport();
  assert.equal(first.activeBlock?.isActive, true);

  now = Date.parse('2026-08-20T23:00:00.000Z');
  await scanner.runPass();
  const second = scanner.buildReport();
  assert.equal(second.ts, now);
  assert.equal(second.activeBlock, null);
});

test('id-less entries dedup across force rebuilds and force reingests once', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [
    usageLine({ messageId: undefined, requestId: undefined, input: 10 }),
  ]);
  const scanner = makeScanner(root);

  await scanner.runPass({ force: true });
  await scanner.runPass({ force: true });
  assert.equal(scanner.buildReport().totals.tokens, 10);

  await fs.appendFile(transcript, `${usageLine({ messageId: undefined, requestId: undefined, input: 20 })}\n`);
  await scanner.runPass({ force: true });
  assert.equal(scanner.buildReport().totals.tokens, 30);
  assert.equal(scanner.stats().entries, 2);
});

test('missing model tracking respects mode, tokens and pruning', async () => {
  const displayRoot = await makeTempRoot();
  const displayProjectsDir = await makeProjectsDir(displayRoot);
  await writeLines(path.join(displayProjectsDir, 'C--repo', 'display.jsonl'), [
    usageLine({ messageId: 'display-a', requestId: 'request-a', model: 'unknown-model', input: 10 }),
  ]);
  const displayScanner = makeScanner(displayRoot, { costMode: 'display' });
  await displayScanner.runPass();
  assert.deepEqual(displayScanner.buildReport().pricing.missing, []);

  const zeroRoot = await makeTempRoot();
  const zeroProjectsDir = await makeProjectsDir(zeroRoot);
  await writeLines(path.join(zeroProjectsDir, 'C--repo', 'zero.jsonl'), [
    usageLine({ messageId: 'zero-a', requestId: 'request-a', model: 'unknown-model', input: 0 }),
  ]);
  const zeroScanner = makeScanner(zeroRoot);
  await zeroScanner.runPass();
  assert.deepEqual(zeroScanner.buildReport().pricing.missing, []);

  const pruneRoot = await makeTempRoot();
  const pruneProjectsDir = await makeProjectsDir(pruneRoot);
  await writeLines(path.join(pruneProjectsDir, 'C--repo', 'prune.jsonl'), [
    usageLine({ messageId: 'prune-a', requestId: 'request-a', model: 'unknown-model', input: 10 }),
  ]);
  let now = Date.parse('2026-08-19T12:00:00.000Z');
  const pruneScanner = makeScanner(pruneRoot, { nowFn: () => now, retainDays: 1 });
  await pruneScanner.runPass();
  assert.deepEqual(pruneScanner.buildReport().pricing.missing, ['unknown-model']);
  now = Date.parse('2026-08-21T12:00:00.000Z');
  await pruneScanner.runPass();
  assert.deepEqual(pruneScanner.buildReport().pricing.missing, []);
});

test('stored entries strip ingest-only iteration payloads', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10, iterations: [{ type: 'other', usage: { input_tokens: 99 } }] }),
  ]);
  const scanner = makeScanner(root);

  await scanner.runPass();
  const stored = scanner._entriesForTest()[0];
  assert.ok(stored, 'the pass stored an entry');
  assert.equal(Object.hasOwn(stored, 'iterations'), false);
});

test('force requested during an active pass chains a rebuild pass', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 }),
  ]);
  let fileStatCalls = 0;
  const injectedFs = {
    ...fs,
    stat: async (file: string) => {
      const stat = await fs.stat(file);
      if (!file.endsWith('.jsonl')) return stat;
      fileStatCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return stat;
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs });

  const active = scanner.runPass();
  const forced = scanner.runPass({ force: true });
  assert.equal(active, forced);
  const result = await forced;
  assert.equal(result.entries, 1);
  assert.ok(fileStatCalls >= 2);
});

test('resolution errors are captured in stats', async () => {
  const root = await makeTempRoot();
  const scanner = makeScanner(root, {
    env: { HOME: root, CLAUDE_CONFIG_DIR: 'C:/missing' },
    fsPromises: {
      ...fs,
      stat: async () => ({ isDirectory: () => false, size: 0, mtimeMs: 0 }),
      readdir: async () => [],
    },
  });

  await scanner.runPass();
  const resolutionError = scanner.stats().resolutionError;
  assert.ok(resolutionError, 'a resolution failure was captured');
  assert.match(resolutionError, /CLAUDE_CONFIG_DIR/);
});

test('partial byte budget does not flush an incomplete utf8 sequence', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const cjk = String.fromCharCode(0x4e2d);
  const model = `claude-sonnet-4-20250514-${cjk}`;
  const line = usageLineWithModelLast({ messageId: 'message-a', requestId: 'request-a', model, input: 10 });
  const bytesBeforeCjk = Buffer.byteLength(line.slice(0, line.indexOf(cjk)));
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [line]);
  const scanner = makeScanner(root, { byteBudget: bytesBeforeCjk + 1, chunkSize: bytesBeforeCjk + 1 });

  const first = await scanner.runPass();
  assert.equal(first.partial, true);
  assert.equal(first.entries, 0);
  const second = await scanner.runPass();
  assert.equal(second.partial, false);
  const report = scanner.buildReport();
  assert.equal(report.totals.tokens, 10);
  assert.equal(report.models[0].model.includes(String.fromCharCode(0xfffd)), false);
});

test('report and session total memo results are mutation safe', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10, sessionId: 'inline-a' }),
  ]);
  const scanner = makeScanner(root);

  await scanner.runPass();
  const report = scanner.buildReport();
  const mutableDay = report.daily[0];
  assert.ok(mutableDay, 'the report carries a day');
  mutableDay.tokens = 999;
  const mutableTotal = scanner.sessionTotals().get('inline-a');
  assert.ok(mutableTotal, 'the scanner carries a session total');
  mutableTotal.tokens = 999;

  assert.equal(scanner.buildReport().daily[0]?.tokens, 10);
  assert.equal(scanner.sessionTotals().get('inline-a')?.tokens, 10);
});

test('requested days window filters rollups and blocks consistently', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'old-a', requestId: 'request-a', input: 10, timestamp: '2026-08-17T12:00:00.000Z' }),
    usageLine({ messageId: 'new-a', requestId: 'request-b', input: 20, timestamp: '2026-08-19T12:00:00.000Z' }),
  ]);
  const scanner = makeScanner(root, { nowFn: () => Date.parse('2026-08-19T13:00:00.000Z') });

  await scanner.runPass();
  const report = scanner.buildReport({ days: 1 });
  assert.equal(report.totals.tokens, 20);
  assert.equal(report.blocks.length, 1);
  assert.equal(report.activeBlock?.tokens, 20);
});

test('prune removes entries and dedup keys so a pruned line can reingest once', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const oldLine = usageLine({ messageId: 'old-a', requestId: 'request-a', input: 10, timestamp: '2026-08-19T12:00:00.000Z' });
  await writeLines(transcript, [oldLine]);
  let now = Date.parse('2026-08-19T13:00:00.000Z');
  const scanner = makeScanner(root, { nowFn: () => now, retainDays: 1 });

  await scanner.runPass();
  assert.equal(scanner.buildReport().totals.tokens, 10);
  now = Date.parse('2026-08-21T13:00:00.000Z');
  const pruned = await scanner.runPass();
  assert.equal(pruned.newEntries, 0);
  assert.equal(scanner.buildReport().totals.tokens, 0);

  await fs.appendFile(transcript, `${oldLine}\n`);
  await scanner.runPass();
  assert.equal(scanner.buildReport().totals.tokens, 0);
  now = Date.parse('2026-08-19T13:00:00.000Z');
  await scanner.runPass({ force: true });
  assert.equal(scanner.buildReport().totals.tokens, 10);
});

test('mid-file read failure rolls back file state and entries', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const firstLine = usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 });
  await writeLines(transcript, [
    firstLine,
    usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 }),
  ]);
  let shouldFail = true;
  const injectedFs = {
    ...fs,
    open: async (file: string, flags: string) => {
      const handle = await fs.open(file, flags);
      if (file !== transcript) return handle;
      let readCalls = 0;
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          readCalls += 1;
          if (shouldFail && readCalls > 1) throw new Error('mid file');
          return handle.read(buffer, offset, length, position);
        },
        close: () => handle.close(),
      };
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs, chunkSize: Buffer.byteLength(firstLine) + 1 });

  const failed = await scanner.runPass();
  assert.equal(failed.entries, 0);
  shouldFail = false;
  const recovered = await scanner.runPass();
  assert.equal(recovered.entries, 2);
  assert.equal(scanner.buildReport().totals.tokens, 30);
});

test('stats reports dirs, files, entries and lastScanMs', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 }),
  ]);
  const scanner = makeScanner(root);

  await scanner.runPass();
  const stats = scanner.stats();
  assert.deepEqual(stats.dirs, [projectsDir]);
  assert.equal(stats.files, 1);
  assert.equal(stats.entries, 1);
  assert.equal(stats.lastScanMs, Date.parse('2026-08-19T12:00:00.000Z'));
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

test('the first pass and a store reset pass report no generation rollup so history never replays', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10, output: 2 }),
  ]);
  const scanner = makeScanner(root);

  const first = await scanner.runPass();
  assert.equal(first.newEntries, 1);
  assert.deepEqual(first.generationRollup, []);

  const reset = await scanner.runPass({ force: true });
  assert.equal(reset.storeReset, true);
  assert.equal(reset.newEntries, 1);
  assert.deepEqual(reset.generationRollup, []);
});

test('a byte limited catch up pass keeps the generation rollup off until history is read', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const firstLine = usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 });
  await writeLines(transcript, [firstLine, usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 })]);
  const scanner = makeScanner(root, { byteBudget: firstLine.length + 1 });

  const partialPass = await scanner.runPass();
  assert.equal(partialPass.partial, true);
  const catchUpPass = await scanner.runPass();
  assert.equal(catchUpPass.newEntries, 1);
  assert.deepEqual(catchUpPass.generationRollup, []);
});

test('a file that failed to read during catch up never replays its history into the generation rollup', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const readable = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const flakyFile = path.join(projectsDir, 'C--repo', 'session-b.jsonl');
  await writeLines(readable, [usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10, sessionId: 'session-a' })]);
  await writeLines(flakyFile, [usageLine({ messageId: 'history-b', requestId: 'history-b', input: 20, sessionId: 'session-b' })]);
  let isFlakyFileDenied = true;
  const injectedFs = {
    ...fs,
    open: async (file: string, flags: string) => {
      if (isFlakyFileDenied && file === flakyFile) throw new Error('denied');
      return fs.open(file, flags);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs });

  const failedPass = await scanner.runPass();
  assert.equal(failedPass.outcome, 'io-failed');
  isFlakyFileDenied = false;
  const recoveredPass = await scanner.runPass();
  assert.equal(recoveredPass.outcome, 'complete');
  assert.equal(recoveredPass.newEntries, 1);
  assert.deepEqual(recoveredPass.generationRollup, []);
});

test('a later pass sums new entries per session and model into the generation rollup', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const sessionAFile = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const sessionBFile = path.join(projectsDir, 'C--repo', 'session-b.jsonl');
  await writeLines(sessionAFile, [usageLine({ messageId: 'history-a', requestId: 'history-a', input: 1000, sessionId: 'session-a' })]);
  const scanner = makeScanner(root);
  await scanner.runPass();

  await fs.appendFile(sessionAFile, `${[
    usageLine({ messageId: 'message-a1', requestId: 'request-a1', input: 10, output: 1, sessionId: 'session-a' }),
    usageLine({ messageId: 'message-a2', requestId: 'request-a2', input: 20, output: 2, sessionId: 'session-a' }),
    usageLine({ messageId: 'message-a3', requestId: 'request-a3', input: 5, output: 5, sessionId: 'session-a', model: 'claude-opus-4-1' }),
  ].join('\n')}\n`);
  await writeLines(sessionBFile, [
    usageLine({ messageId: 'message-b1', requestId: 'request-b1', input: 7, output: 3, sessionId: 'session-b' }),
  ]);
  const later = await scanner.runPass();

  const rowsByKey = new Map(later.generationRollup.map((row) => [`${row.sessionId}|${row.model}`, row]));
  assert.equal(rowsByKey.size, 3);
  const sessionASonnet = rowsByKey.get('session-a|claude-sonnet-4-20250514');
  assert.equal(sessionASonnet?.input, 30);
  assert.equal(sessionASonnet?.output, 3);
  assert.equal(sessionASonnet?.vendor, 'claude');
  assert.equal(sessionASonnet?.hasKnownCost, true);
  assert.equal(sessionASonnet?.costUSD, 30 * 1 + 3 * 2);
  assert.equal(rowsByKey.get('session-a|unknown')?.input, 5);
  assert.equal(rowsByKey.get('session-a|unknown')?.hasKnownCost, false);
  assert.equal(rowsByKey.get('session-a|unknown')?.isModelKnown, false);
  assert.equal(rowsByKey.get('session-b|claude-sonnet-4-20250514')?.output, 3);

  const quiet = await scanner.runPass();
  assert.deepEqual(quiet.generationRollup, []);
});

test('a file at a new path after a complete pass reports only its entries from the last 24 hours into the generation rollup', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'history-a', requestId: 'history-a', input: 1000, sessionId: 'session-a' }),
  ]);
  const scanner = makeScanner(root);
  const completePass = await scanner.runPass();
  assert.equal(completePass.outcome, 'complete');

  await writeLines(path.join(projectsDir, 'C--repo', 'archived', 'session-b.jsonl'), [
    usageLine({ messageId: 'old-b1', requestId: 'old-b1', input: 400, sessionId: 'session-b', timestamp: '2026-08-17T10:00:00.000Z' }),
    usageLine({ messageId: 'old-b2', requestId: 'old-b2', input: 300, sessionId: 'session-b', timestamp: '2026-08-18T11:59:00.000Z' }),
  ]);
  const oldOnlyPass = await scanner.runPass();
  assert.equal(oldOnlyPass.newEntries, 2);
  assert.deepEqual(oldOnlyPass.generationRollup, []);

  await writeLines(path.join(projectsDir, 'C--repo', 'archived', 'session-c.jsonl'), [
    usageLine({ messageId: 'old-c1', requestId: 'old-c1', input: 500, sessionId: 'session-c', timestamp: '2026-08-16T10:00:00.000Z' }),
    usageLine({ messageId: 'recent-c1', requestId: 'recent-c1', input: 7, sessionId: 'session-c', timestamp: '2026-08-19T09:00:00.000Z' }),
  ]);
  const mixedPass = await scanner.runPass();
  assert.equal(mixedPass.newEntries, 2);
  assert.equal(mixedPass.generationRollup.length, 1);
  assert.equal(mixedPass.generationRollup[0]?.sessionId, 'session-c');
  assert.equal(mixedPass.generationRollup[0]?.input, 7);
});

test('a message rewritten with more tokens in a later pass reports only the growth so totals match the local report', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [usageLine({ messageId: 'history-a', requestId: 'history-a', input: 1000 })]);
  const scanner = makeScanner(root);
  await scanner.runPass();

  await fs.appendFile(transcript, `${usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10, output: 1 })}\n`);
  const streamingPass = await scanner.runPass();
  await fs.appendFile(transcript, `${usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10, output: 500 })}\n`);
  const finalPass = await scanner.runPass();

  const reportedRows = [...streamingPass.generationRollup, ...finalPass.generationRollup];
  assert.equal(reportedRows.reduce((total, row) => total + row.output, 0), 500);
  assert.equal(reportedRows.reduce((total, row) => total + row.input, 0), 10);
  assert.equal(reportedRows.reduce((total, row) => total + row.costUSD, 0), 10 * 1 + 500 * 2);
});

test('gateway model aliases and inference profile arns reach the generation rollup only as a pricing table name or unknown', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [usageLine({ messageId: 'history-a', requestId: 'history-a', input: 1000 })]);
  const scanner = makeScanner(root);
  await scanner.runPass();

  await fs.appendFile(transcript, `${[
    usageLine({ messageId: 'message-a1', requestId: 'request-a1', input: 10, model: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123' }),
    usageLine({ messageId: 'message-a2', requestId: 'request-a2', input: 20, model: 'corp-gateway-default' }),
    usageLine({ messageId: 'message-a3', requestId: 'request-a3', input: 30, model: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-20250514-v1:0' }),
  ].join('\n')}\n`);
  const later = await scanner.runPass();

  const rowsByModel = new Map(later.generationRollup.map((row) => [row.model, row]));
  assert.deepEqual([...rowsByModel.keys()].sort(), ['claude-sonnet-4-20250514', 'unknown']);
  assert.equal(rowsByModel.get('unknown')?.input, 30);
  assert.equal(rowsByModel.get('claude-sonnet-4-20250514')?.input, 30);
  assert.equal(rowsByModel.get('claude-sonnet-4-20250514')?.isModelKnown, true);
  assert.equal(JSON.stringify(later.generationRollup).includes('123456789012'), false);
  assert.equal(JSON.stringify(later.generationRollup).includes('corp-gateway'), false);
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

function usageLineWithModelLast({ messageId, requestId, model, input }: {
  messageId: string;
  requestId: string;
  model: string;
  input: number;
}): string {
  return JSON.stringify({
    timestamp: '2026-08-19T10:00:00.000Z',
    sessionId: 'session-a',
    requestId,
    cwd: 'C:/repo',
    version: '2.1.200',
    isSidechain: false,
    message: {
      id: messageId,
      usage: {
        input_tokens: input,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model,
    },
  });
}
