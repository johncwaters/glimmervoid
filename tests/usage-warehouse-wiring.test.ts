
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createUsageScanner } from '../server/usage/usage-scanner.ts';
import type { UsageScannerOptions } from '../server/usage/usage-scanner.ts';
import { normalizePricingTable } from '../server/usage/core/usage-pricing-core.ts';

type Scanner = ReturnType<typeof createUsageScanner>;

interface WarehouseRecord {
  day: string;
  model: string;
  tokens: number;
  costUSD: number;
}

interface WarehouseFile {
  version?: number;
  updatedAt?: unknown;
  records: WarehouseRecord[];
}

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const pricingTable = normalizePricingTable({
  'claude-sonnet-4-20250514': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
});

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-usage-warehouse-'));
}

function makeScanner(root: string, overrides: UsageScannerOptions = {}): Scanner {
  return createUsageScanner({
    env: { HOME: root },
    pricingTable,
    nowFn: () => NOW,
    retainDays: 90,
    warehousePath: path.join(root, '.glimmervoid', 'usage-warehouse.json'),
    ...overrides,
  });
}

function claudeLine({ messageId, day, model = 'claude-sonnet-4-20250514', input = 1000, output = 100 }: {
  messageId: string;
  day: string;
  model?: string;
  input?: number;
  output?: number;
}): string {
  return JSON.stringify({
    sessionId: 'inline-a',
    requestId: `req-${messageId}`,
    timestamp: `${day}T12:00:00.000Z`,
    cwd: 'C:/repo',
    isSidechain: false,
    message: {
      id: messageId,
      model,
      usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
}

async function writeTranscript(root: string, name: string, lines: string[]): Promise<string> {
  const file = path.join(root, '.claude', 'projects', 'C--repo', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

async function readWarehouse(root: string): Promise<WarehouseFile> {
  const text = await fs.readFile(path.join(root, '.glimmervoid', 'usage-warehouse.json'), 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the warehouse file is not a JSON object');
  const { version, updatedAt, records } = parsed as { version?: number; updatedAt?: unknown; records?: unknown };
  if (!Array.isArray(records)) throw new Error('the warehouse file carries no records array');
  return { version, updatedAt, records };
}

async function warehouseExists(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, '.glimmervoid', 'usage-warehouse.json'));
    return true;
  } catch {
    return false;
  }
}

test('a completed pass writes per-day per-model records atomically', async () => {
  const root = await makeTempRoot();
  await writeTranscript(root, 'a.jsonl', [
    claudeLine({ messageId: 'm1', day: '2026-08-17' }),
    claudeLine({ messageId: 'm2', day: '2026-08-18', output: 200 }),
  ]);
  const scanner = makeScanner(root);
  await scanner.runPass();

  const stored = await readWarehouse(root);
  assert.equal(stored.version, 1);
  assert.ok(stored.updatedAt, 'stamped with a write time');
  assert.deepEqual(stored.records.map((record) => record.day), ['2026-08-17', '2026-08-18']);
  assert.equal(stored.records[0].model, 'claude-sonnet-4-20250514');
  assert.equal(stored.records[0].tokens, 1100);
  assert.equal(stored.records[1].tokens, 1200);
  const glimmervoidDir = await fs.readdir(path.join(root, '.glimmervoid'));
  assert.deepEqual(glimmervoidDir, ['usage-warehouse.json']);
});

test('a deleted transcript keeps its day in the report, marked as history', async () => {
  const root = await makeTempRoot();
  const oldFile = await writeTranscript(root, 'old.jsonl', [claudeLine({ messageId: 'm1', day: '2026-06-01', output: 500 })]);
  await writeTranscript(root, 'new.jsonl', [claudeLine({ messageId: 'm2', day: '2026-08-18' })]);

  const first = makeScanner(root);
  await first.runPass();
  const before = first.buildReport({});
  assert.deepEqual(before.daily.map((row) => row.day), ['2026-06-01', '2026-08-18']);
  assert.equal(before.daily[0]?.source, undefined, 'a live day carries no history marker');

  await fs.rm(oldFile);
  const second = makeScanner(root);
  await second.runPass();
  const after = second.buildReport({});
  assert.deepEqual(after.daily.map((row) => row.day), ['2026-06-01', '2026-08-18']);
  const remembered = after.daily.find((row) => row.day === '2026-06-01');
  assert.ok(remembered, 'the pruned day survived in the report');
  assert.equal(remembered.source, 'history');
  assert.equal(remembered.tokens, 1500, 'the remembered totals are the ones that were observed');
  assert.equal(remembered.models[0]?.model, 'claude-sonnet-4-20250514');

  assert.equal(after.totals.tokens, 1100, 'totals stay live-only');
  const blockTokens = after.blocks.reduce((sum, block) => sum + block.tokens, 0);
  assert.equal(blockTokens, 1100, 'blocks stay live-only');
});

test('an unreadable warehouse warns, keeps its bytes, and never rewrites them', async () => {
  const root = await makeTempRoot();
  const warehousePath = path.join(root, '.glimmervoid', 'usage-warehouse.json');
  const original = '{ recoverable later';
  await fs.mkdir(path.dirname(warehousePath), { recursive: true });
  await fs.writeFile(warehousePath, original);
  await writeTranscript(root, 'a.jsonl', [claudeLine({ messageId: 'm1', day: '2026-08-18' })]);
  const warnings: string[] = [];
  const error: NodeJS.ErrnoException = new Error('EACCES simulated');
  error.code = 'EACCES';
  const scanner = makeScanner(root, {
    logger: { warn: (message: string) => { warnings.push(message); } },
    fsPromises: { ...fs, readFile: async () => { throw error; } },
  });
  await scanner.runPass();
  assert.equal(await fs.readFile(warehousePath, 'utf8'), original);
  assert.ok(warnings.some((message) => message.includes('warehouse unreadable') && message.includes(warehousePath)), `warned: ${warnings.join(' | ')}`);
});

test('a throwing logger during a failed write still does not fail the scan', async () => {
  const root = await makeTempRoot();
  await writeTranscript(root, 'a.jsonl', [claudeLine({ messageId: 'm1', day: '2026-08-18' })]);
  const scanner = makeScanner(root, {
    logger: { warn: (): void => { throw new Error('logger exploded'); } },
    fsPromises: brokenWriteFs(),
  });
  const pass = await scanner.runPass();
  assert.equal(pass.entries, 1, 'a history write problem never costs the scan');
  assert.equal(await warehouseExists(root), false);
});

function brokenWriteFs(): NonNullable<UsageScannerOptions['fsPromises']> {
  return {
    ...fs,
    writeFile: async () => { throw new Error('EACCES simulated'); },
  };
}
