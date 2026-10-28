
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import realFsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend/backend.ts';
import { createUsageWiring } from '../server/usage/usage-wiring.ts';
import { createKimiPlanLimitsReader } from '../server/usage/usage-kimi-limits.ts';
import { ServerMessage } from '../shared/contracts/control-messages.ts';
import type { UsageWiringOptions } from '../server/usage/usage-wiring.ts';
import { createUsageScanner } from '../server/usage/usage-scanner.ts';
import { loadPricing } from '../server/usage/usage-pricing.ts';
import { closeSocket, dashboardClient, openRecordingSocket, waitForMessage } from './helpers/dashboard-ws.ts';
import type { DashboardClient } from './helpers/dashboard-ws.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';

const SESSION_ID = 'b0000000-0000-4000-8000-000000000001';
const CLAUDE_SESSION_ID = 'c1c1c1c1-2222-4333-8444-555555555555';
const MODEL = 'claude-opus-4-5';
const MESSAGE_WAIT_MS = 5000;

interface UsageSessionRow {
  id: string;
  tokens: number;
  costUSD: number;
  lastTs: number;
}

type ControlFrame =
  | { type: 'usage-sessions'; pricingSource: string; ts: number; sessions: UsageSessionRow[] }
  | {
    type: 'usage-report';
    requestId: string | null;
    error: string | null;
    warning?: string | null;
    blockHours?: number;
    totals?: { tokens: number; input: number; output: number };
    daily?: unknown[];
    models?: { model: string }[];
    sessions?: unknown[];
    blocks?: unknown[];
    activeBlock?: unknown;
    pricing?: { source: string; missing: string[] };
    scan?: { files: number; entries: number; partial: boolean; dirs: string[] };
  }
  | { type: 'settings-updated'; requestId: string | null; settings: { usage?: unknown } }
  | { type: 'snapshot' };

type UsageSessions = Extract<ControlFrame, { type: 'usage-sessions' }>;
type UsageReport = Extract<ControlFrame, { type: 'usage-report' }>;
type SettingsUpdated = Extract<ControlFrame, { type: 'settings-updated' }>;

const isUsageSessions = (m: ControlFrame): m is UsageSessions => m.type === 'usage-sessions';
const isUsageReport = (m: ControlFrame): m is UsageReport => m.type === 'usage-report';
const isSnapshot = (m: ControlFrame) => m.type === 'snapshot';
const settingsUpdatedFor = (requestId: string) => (m: ControlFrame): m is SettingsUpdated =>
  m.type === 'settings-updated' && m.requestId === requestId;

function transcriptLine({ sessionId, requestId, messageId, input, output, timestampMs }: {
  sessionId: string;
  requestId: string;
  messageId: string;
  input: number;
  output: number;
  timestampMs: number;
}): string {
  return `${JSON.stringify({
    sessionId,
    requestId,
    timestamp: new Date(timestampMs).toISOString(),
    cwd: 'C:/fixture/repo',
    version: '2.1.200',
    isSidechain: false,
    message: {
      id: messageId,
      model: MODEL,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })}\n`;
}

function writeTranscriptFixture(claudeHome: string): void {
  const projectDir = path.join(claudeHome, 'projects', 'C--fixture-repo');
  fs.mkdirSync(projectDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(projectDir, `${CLAUDE_SESSION_ID}.jsonl`),
    transcriptLine({ sessionId: CLAUDE_SESSION_ID, requestId: 'req-1', messageId: 'msg-1', input: 100, output: 50, timestampMs: now - 60000 })
      + transcriptLine({ sessionId: CLAUDE_SESSION_ID, requestId: 'req-2', messageId: 'msg-2', input: 200, output: 25, timestampMs: now - 30000 }),
    'utf8',
  );
}

interface ScanCounts {
  scanners: number;
  stat: number;
  readdir: number;
  open: number;
}

function makeUsageProbe(claudeHome: string) {
  const counts: ScanCounts = { scanners: 0, stat: 0, readdir: 0, open: 0 };
  const fsPromises = {
    stat: (...args: Parameters<typeof realFsp.stat>) => { counts.stat += 1; return realFsp.stat(...args); },
    readdir: (...args: Parameters<typeof realFsp.readdir>) => { counts.readdir += 1; return realFsp.readdir(...args); },
    open: (...args: Parameters<typeof realFsp.open>) => { counts.open += 1; return realFsp.open(...args); },
  };
  const options = {
    loadPricingFn: (args: Parameters<typeof loadPricing>[0]) => loadPricing({ ...args, fetchEnabled: false }),
    createScanner: (deps: Parameters<typeof createUsageScanner>[0]) => {
      counts.scanners += 1;
      return createUsageScanner(deps);
    },
    scannerDeps: { env: { CLAUDE_CONFIG_DIR: claudeHome, HOME: path.dirname(claudeHome), USERPROFILE: path.dirname(claudeHome) }, fsPromises },
    logger: { warn: () => {}, log: () => {} },
  };
  return { counts, options };
}

interface UsageHarness {
  dash: DashboardClient;
  counts: ScanCounts;
  cfgPath: string;
}

function withBackend({ usage }: { usage?: Record<string, unknown> }, fn: (harness: UsageHarness) => Promise<void>) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-usage-'));
    const projectDir = path.join(tmpDir, 'project');
    const claudeHome = path.join(tmpDir, 'claude');
    fs.mkdirSync(projectDir);
    writeTranscriptFixture(claudeHome);

    const cfgPath = path.join(tmpDir, 'config.json');
    const cfg: Record<string, unknown> = {
      projects: [{ id: SESSION_ID, name: 'usage probe', path: projectDir, resumeSessionId: CLAUDE_SESSION_ID }],
      teams: [],
      repoRoots: [],
      checkForUpdates: false,
    };
    if (usage) cfg.usage = usage;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    const prevEnv = process.env.GLIMMERVOID_CONFIG;
    process.env.GLIMMERVOID_CONFIG = cfgPath;

    const probe = makeUsageProbe(claudeHome);
    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null, usageWiringOptions: probe.options });
    server.on('request', backend.app);
    await listenOnLoopback(server);
    const dash = await dashboardClient(boundPort(server));

    try {
      await fn({ dash, counts: probe.counts, cfgPath });
    } finally {
      await settleBackendShutdown(backend);
      server.closeAllConnections();
      await closeServer(server);
      if (prevEnv == null) delete process.env.GLIMMERVOID_CONFIG;
      if (prevEnv != null) process.env.GLIMMERVOID_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

function openControl(dash: DashboardClient, pathAndSearch = '/control') {
  return openRecordingSocket<ControlFrame>(dash, pathAndSearch);
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + MESSAGE_WAIT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function settle(ms = 250): Promise<void> {
  return new Promise((resolve) => { setTimeout(() => resolve(), ms); });
}

test('no transcript is read until the first control connection, then the boot pass runs once', withBackend({}, async ({ dash, counts }) => {
  await settle();
  assert.equal(counts.scanners, 0, 'cold boot constructs no scanner');
  assert.equal(counts.readdir, 0, 'cold boot walks no directory');
  assert.equal(counts.open, 0, 'cold boot reads no transcript');

  const first = await openControl(dash);
  await waitForMessage(first.received, isUsageSessions, 'the first usage-sessions push');
  assert.equal(counts.scanners, 1);
  assert.ok(counts.readdir > 0, 'the deferred boot pass walked the transcript tree');
  assert.ok(counts.open > 0, 'the deferred boot pass read the transcript');

  const second = await openControl(dash);
  await waitForMessage(second.received, isUsageSessions, 'usage-sessions replayed to a later client');
  assert.equal(counts.scanners, 1, 'a second connection reuses the warm scanner');

  await closeSocket(first.ws);
  await closeSocket(second.ws);
}));

test('usage-sessions attributes the fixture transcript to the card through its live Claude session id', withBackend({}, async ({ dash }) => {
  const client = await openControl(dash);
  const message = await waitForMessage(client.received, isUsageSessions, 'usage-sessions');

  assert.equal(message.pricingSource, 'snapshot');
  assert.equal(typeof message.ts, 'number');
  assert.deepEqual(message.sessions.map((row) => row.id), [SESSION_ID]);
  const row = message.sessions[0];
  assert.equal(row.tokens, 375, 'both transcript lines counted (100+50 and 200+25)');
  assert.ok(row.costUSD > 0, 'priced from the committed snapshot');
  assert.equal(typeof row.lastTs, 'number');

  await closeSocket(client.ws);
}));

test('request-usage-report replies to the requesting socket only, with the full report shape', withBackend({}, async ({ dash }) => {
  const asker = await openControl(dash);
  await waitForMessage(asker.received, isUsageSessions, 'the boot push');
  const bystander = await openControl(dash);
  await waitForMessage(bystander.received, isUsageSessions, 'the bystander connect replay');
  bystander.received.length = 0;

  asker.ws.send(JSON.stringify({ type: 'request-usage-report', requestId: 'r1', days: 30 }));
  const report = await waitForMessage(asker.received, isUsageReport, 'usage-report');

  assert.equal(report.requestId, 'r1');
  assert.equal(report.error, null);
  assert.equal(report.warning, null);
  assert.equal(report.blockHours, 5);
  assert.equal(report.totals?.tokens, 375);
  assert.equal(report.totals?.input, 300);
  assert.equal(report.totals?.output, 75);
  assert.equal(report.daily?.length, 1, 'both entries land in one local-tz day');
  assert.deepEqual(report.models?.map((m) => m.model), [MODEL]);
  assert.equal(report.sessions?.length, 1);
  assert.ok((report.blocks?.length ?? 0) >= 1);
  assert.ok(report.activeBlock, 'the fixture entries are minutes old, so the block is still active');
  assert.equal(report.pricing?.source, 'snapshot');
  assert.deepEqual(report.pricing?.missing, []);
  assert.equal(report.scan?.files, 1);
  assert.equal(report.scan?.entries, 2);
  assert.equal(report.scan?.partial, false);
  assert.equal(report.scan?.dirs.length, 1);

  await settle();
  assert.equal(bystander.received.filter(isUsageReport).length, 0, 'the report is replied, never broadcast');

  const latecomer = await openControl(dash);
  const replayed = await waitForMessage(latecomer.received, isUsageReport, 'the replayed report');
  assert.equal(replayed.requestId, null);
  assert.equal(replayed.totals?.tokens, 375);

  await closeSocket(asker.ws);
  await closeSocket(bystander.ws);
  await closeSocket(latecomer.ws);
}));

test('usage.enabled false: no scanner, no messages, and a refused report request', withBackend({ usage: { enabled: false } }, async ({ dash, counts }) => {
  const client = await openControl(dash);
  await waitForMessage(client.received, isSnapshot, 'the snapshot');
  await settle();

  assert.equal(counts.scanners, 0, 'a disabled lane constructs no scanner');
  assert.equal(counts.readdir, 0, 'a disabled lane walks no directory');
  assert.equal(client.received.filter(isUsageSessions).length, 0, 'no usage message on the wire');

  client.ws.send(JSON.stringify({ type: 'request-usage-report', requestId: 'r9' }));
  const report = await waitForMessage(client.received, isUsageReport, 'the refusal');
  assert.equal(report.requestId, 'r9');
  assert.ok(report.error, 'the refusal names a reason');
  assert.match(report.error, /disabled/);
  assert.equal(report.totals, undefined, 'a refusal carries no report body');
  assert.equal(counts.scanners, 0, 'the refused request still constructed nothing');

  await closeSocket(client.ws);
}));

test('a settings save restarts the lane only when the usage block actually changed', withBackend({}, async ({ dash, counts }) => {
  const client = await openControl(dash);
  await waitForMessage(client.received, isUsageSessions, 'the boot push');
  assert.equal(counts.scanners, 1);

  client.ws.send(JSON.stringify({ type: 'update-settings', requestId: 's1', settings: { cursorBlink: true } }));
  await waitForMessage(client.received, settingsUpdatedFor('s1'), 'the unrelated save');
  await settle();
  assert.equal(counts.scanners, 1, 'a save that touches no usage key leaves the warm scanner alone');

  client.ws.send(JSON.stringify({
    type: 'update-settings',
    requestId: 's2',
    settings: { usage: { enabled: true, fetchPricing: false, scanIntervalMinutes: 7, costMode: 'calculate' } },
  }));
  const updated = await waitForMessage(client.received, settingsUpdatedFor('s2'), 'the usage save');
  await waitUntil(() => counts.scanners === 2, 'the lane to restart with a fresh scanner');

  assert.deepEqual(updated.settings.usage, { enabled: true, fetchPricing: false, scanIntervalMinutes: 7, costMode: 'calculate' });

  await closeSocket(client.ws);
}));


type PassResult = Awaited<ReturnType<ReturnType<typeof createUsageScanner>['runPass']>>;
type PassArgs = Parameters<ReturnType<typeof createUsageScanner>['runPass']>[0];

function scriptedScanner(passes: PassArgs[], passResults: PassResult[]) {
  const scanner = createUsageScanner({ env: {}, homeDir: path.join(os.tmpdir(), 'glimmervoid-usage-nowhere') });
  scanner.runPass = async (args?: PassArgs) => {
    passes.push(args);
    return passResults[Math.min(passes.length - 1, passResults.length - 1)];
  };
  return scanner;
}

function stubScannerWiring({ passResults, clients = 1, setTimeoutFn }: {
  passResults: PassResult[];
  clients?: number;
  setTimeoutFn?: NonNullable<UsageWiringOptions['setTimeoutFn']>;
}) {
  const passes: PassArgs[] = [];
  const scanner = scriptedScanner(passes, passResults);
  const wiring = createUsageWiring({
    config: {},
    sessions: new Map(),
    controlClientCount: () => clients,
    createScanner: () => scanner,
    loadPricingFn: async () => ({ table: new Map(), source: 'snapshot', fetchedAt: null }),
    partialContinueMs: 10,
    setTimeoutFn,
    logger: { warn: () => {}, log: () => {} },
  });
  return { wiring, passes };
}

const COMPLETE_PASS: PassResult = {
  files: 1,
  entries: 1,
  newEntries: 0,
  partial: false,
  outcome: 'complete',
  ioFailures: 0,
  storeReset: false,
  durationMs: 1,
  generationRollup: [],
};
const IO_FAILED_PASS: PassResult = {
  files: 1,
  entries: 0,
  newEntries: 0,
  partial: false,
  outcome: 'io-failed',
  ioFailures: 1,
  storeReset: false,
  durationMs: 1,
  generationRollup: [],
};
const FORCED_IO_FAILED_PASS: PassResult = { ...IO_FAILED_PASS, storeReset: true };

test('a pass with no new entries pushes its changed totals, an incremental io-failed pass still pushes, and a forced one does not', async () => {
  const passResults: PassResult[] = [COMPLETE_PASS, IO_FAILED_PASS, FORCED_IO_FAILED_PASS];
  const totalsByPass = [
    { tokens: 10, costUSD: 1, lastTs: 1 },
    { tokens: 20, costUSD: 2, lastTs: 2 },
    { tokens: 0, costUSD: 0, lastTs: null },
  ];
  let passCount = 0;
  const scanner = scriptedScanner([], passResults);
  scanner.runPass = async () => {
    passCount += 1;
    return passResults[Math.min(passCount - 1, passResults.length - 1)];
  };
  scanner.sessionTotals = () => new Map([
    ['resume-a', totalsByPass[Math.min(passCount - 1, totalsByPass.length - 1)]],
  ]);
  const pushedTokens: number[] = [];
  const wiring = createUsageWiring({
    config: {},
    sessions: new Map([['card-a', { resumeSessionId: 'resume-a' }]]),
    broadcast: (message) => {
      if (message.type !== 'usage-sessions') return;
      if (!Array.isArray(message.sessions)) return;
      const firstSession: unknown = message.sessions[0];
      if (!firstSession || typeof firstSession !== 'object') return;
      const tokens = (firstSession as { tokens?: unknown }).tokens;
      if (typeof tokens === 'number') pushedTokens.push(tokens);
    },
    createScanner: () => scanner,
    loadPricingFn: async () => ({ table: new Map(), source: 'snapshot', fetchedAt: null }),
    logger: { warn: () => {}, log: () => {} },
  });

  await wiring.start();
  await wiring.requestReport({ force: true });
  await wiring.requestReport({ force: true });

  assert.deepEqual(pushedTokens, [10, 20]);
  await wiring.stop();
});

test('a byte-limited continuation re-arms while a real scan is in flight without starting a concurrent pass', async (context) => {
  const directory = await realFsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-usage-continuation-'));
  const claudeHome = path.join(directory, 'claude');
  writeTranscriptFixture(claudeHome);
  const transcriptPath = path.join(claudeHome, 'projects', 'C--fixture-repo', `${CLAUDE_SESSION_ID}.jsonl`);
  const transcript = await realFsp.readFile(transcriptPath, 'utf8');
  const { options } = makeUsageProbe(claudeHome);
  const continuations: { run: () => void; delayMs: number; handle: NodeJS.Timeout }[] = [];
  const completedPasses: PassResult[] = [];
  let startedPassCount = 0;
  let intervalTick = () => {};
  let releasePass = () => {};
  const passBarrier = new Promise<void>((resolve) => { releasePass = resolve; });
  const wiring = createUsageWiring({
    ...options,
    config: { usage: { vendors: { codex: false, grok: false } } },
    scannerDeps: {
      ...options.scannerDeps,
      byteBudget: Buffer.byteLength(transcript.split('\n')[0]) + 1,
      fsPromises: {
        ...options.scannerDeps.fsPromises,
        stat: async (...args: Parameters<typeof realFsp.stat>) => {
          if (startedPassCount === 2) await passBarrier;
          return options.scannerDeps.fsPromises.stat(...args);
        },
      },
    },
    createScanner: (deps) => {
      const scanner = options.createScanner(deps);
      const runPass = scanner.runPass;
      scanner.runPass = async (args) => {
        startedPassCount += 1;
        const completedPass = await runPass(args);
        completedPasses.push(completedPass);
        return completedPass;
      };
      return scanner;
    },
    partialContinueMs: 10,
    setTimeoutFn: (run, delayMs) => {
      const handle = setTimeout(run, 60_000);
      handle.unref();
      continuations.push({ run, delayMs, handle });
      return handle;
    },
    setIntervalFn: (run, delayMs) => {
      intervalTick = run;
      return setInterval(run, delayMs);
    },
  });
  context.after(async () => {
    releasePass();
    await wiring.stop();
    for (const continuation of continuations) clearTimeout(continuation.handle);
    await realFsp.rm(directory, { recursive: true, force: true });
  });
  await wiring.start();
  assert.equal(completedPasses[0].outcome, 'byte-limited');
  intervalTick();
  assert.equal(startedPassCount, 2);
  clearTimeout(continuations[0].handle);
  continuations[0].run();
  assert.equal(continuations.length, 2, 'the busy continuation re-arms its short timer');
  assert.equal(continuations[1].delayMs, 10);
  assert.equal(startedPassCount, 2, 'the busy continuation starts no concurrent pass');
  releasePass();
  await waitUntil(() => completedPasses.length === 2, 'the in-flight scan to settle');
  clearTimeout(continuations[1].handle);
  continuations[1].run();
  await waitUntil(() => completedPasses.length === 3, 'the re-armed continuation to finish');
  assert.equal(completedPasses.at(-1)?.outcome, 'complete');
  assert.equal(continuations.length, 2, 'a complete scan schedules no further continuation');
  const report = await wiring.requestReport();
  assert.ok(report.totals && typeof report.totals === 'object' && 'tokens' in report.totals);
  assert.equal(report.totals.tokens, 375);
});

test('io-failed passes retry with capped backoff and warn once per standing failure', async (context) => {
  context.mock.method(Math, 'random', () => 1);
  const passes: PassArgs[] = [];
  const delays: number[] = [];
  const warnings: string[] = [];
  const scanner = scriptedScanner(passes, [
    IO_FAILED_PASS,
    IO_FAILED_PASS,
    IO_FAILED_PASS,
    COMPLETE_PASS,
    IO_FAILED_PASS,
    COMPLETE_PASS,
  ]);
  const wiring = createUsageWiring({
    config: {},
    sessions: new Map(),
    controlClientCount: () => 1,
    createScanner: () => scanner,
    loadPricingFn: async () => ({ table: new Map(), source: 'snapshot', fetchedAt: null }),
    setTimeoutFn: (fn, ms) => {
      delays.push(ms);
      const handle = setTimeout(fn, 0);
      handle.unref();
      return handle;
    },
    logger: { warn: (message: string) => { warnings.push(message); }, log: () => {} },
  });

  await wiring.start();
  await waitUntil(() => passes.length === 4, 'three io retries followed by recovery');
  assert.deepEqual(delays, [30_000, 60_000, 120_000]);
  assert.deepEqual(warnings, ['[usage] scan pass lost files to io errors ioFailures=1 files=1']);

  await wiring.requestReport({ force: true });
  await waitUntil(() => passes.length === 6, 'a second io streak followed by recovery');
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 30_000]);
  assert.deepEqual(warnings, [
    '[usage] scan pass lost files to io errors ioFailures=1 files=1',
    '[usage] scan pass lost files to io errors ioFailures=1 files=1',
  ]);
  await wiring.stop();
});

test('an io-failed pass is retried with no dashboard connected', async () => {
  const { wiring, passes } = stubScannerWiring({
    passResults: [IO_FAILED_PASS, COMPLETE_PASS],
    clients: 0,
    setTimeoutFn: (fn, _ms) => {
      const handle = setTimeout(fn, 0);
      handle.unref();
      return handle;
    },
  });
  await wiring.start();
  assert.equal(passes.length, 1);

  await waitUntil(() => passes.length === 2, 'the io retry to run with nobody watching');
  await settle(60);
  assert.equal(passes.length, 2, 'the recovered pass schedules no further continuation');
  await wiring.stop();
});

test('a config with no usage block never materializes one on an unrelated save', withBackend({}, async ({ dash, cfgPath }) => {
  const client = await openControl(dash);
  await waitForMessage(client.received, isSnapshot, 'the snapshot');

  client.ws.send(JSON.stringify({ type: 'update-settings', requestId: 'u1', settings: { cursorBlink: false } }));
  const updated = await waitForMessage(client.received, settingsUpdatedFor('u1'), 'the save');
  assert.equal(updated.settings.usage, null, 'getSettings echoes null while the block is unconfigured');
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).usage, undefined, 'config.json still has no usage key');

  await closeSocket(client.ws);
}));

test('kimi usage is read only from wire.jsonl usage records, keyed to the session folder, and counted once across passes', async () => {
  const directory = await realFsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-usage-kimi-'));
  try {
    const kimiHome = path.join(directory, 'kimi-home');
    const sessionId = 'session_6442c213-af31-4eef-a846-093cfc5851a4';
    const sessionFolder = path.join(kimiHome, 'sessions', 'wd_repo_1137a7e482d8', sessionId);
    const now = Date.now();
    const usageRecord = (agentId: string, time: number, usageScope: string) => JSON.stringify({
      type: 'usage.record', agentId, model: 'kimi-code/kimi-for-coding', usage: { inputOther: 900, output: 70, inputCacheRead: 19000, inputCacheCreation: 0 }, usageScope, time,
    });
    for (const [agent, lines] of [
      ['main', [usageRecord('main', now - 2000, 'turn'), '{"type":"turn.ended"}', usageRecord('main', now - 1000, 'session')]],
      ['explore-1', [usageRecord('explore-1', now - 1500, 'turn')]],
    ] as const) {
      await realFsp.mkdir(path.join(sessionFolder, 'agents', agent), { recursive: true });
      await realFsp.writeFile(path.join(sessionFolder, 'agents', agent, 'wire.jsonl'), `${lines.join('\n')}\n`);
    }
    await realFsp.writeFile(path.join(sessionFolder, 'agents', 'main', 'context.jsonl'), `${usageRecord('main', now - 500, 'turn')}\n`);
    const scanner = createUsageScanner({
      env: { KIMI_CODE_HOME: kimiHome, CLAUDE_CONFIG_DIR: path.join(directory, 'no-claude'), CODEX_HOME: path.join(directory, 'no-codex'), GROK_HOME: path.join(directory, 'no-grok') },
      homeDir: directory,
      pricingTable: new Map(),
    });
    await scanner.runPass({ force: true });
    await scanner.runPass({ force: true });
    const kimiEntries = scanner._entriesForTest().filter((entry) => entry.vendor === 'kimi');
    assert.deepEqual(kimiEntries.map((entry) => [entry.sessionId, entry.input, entry.output, entry.cacheRead]), [
      [sessionId, 900, 70, 19000],
      [sessionId, 900, 70, 19000],
    ]);
  } finally {
    await realFsp.rm(directory, { recursive: true, force: true });
  }
});

test('kimi plan limits poll /usages read-only while a kimi session is live, rarely when idle, and keep the last windows on a 401', async (context) => {
  const directory = await realFsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-usage-kimi-limits-'));
  const kimiHome = path.join(directory, 'kimi-home');
  const credentialsPath = path.join(kimiHome, 'credentials', 'kimi-code-env-0e4f99c69cc27850.json');
  await realFsp.mkdir(path.dirname(credentialsPath), { recursive: true });
  await realFsp.writeFile(path.join(kimiHome, 'config.toml'), [
    '[providers."managed:kimi-code"]',
    'type = "kimi"',
    'base_url = "https://api.kimi.ai/coding/v1"',
    '',
    '[providers."managed:kimi-code".oauth]',
    'storage = "file"',
    'key = "oauth/kimi-code-env-0e4f99c69cc27850"',
    '',
  ].join('\n'));
  let nowMs = Date.parse('2026-10-28T12:00:00Z');
  const credentials = JSON.stringify({ access_token: 'kimi-access', refresh_token: 'kimi-refresh', expires_at: nowMs / 1000 + 7200 });
  await realFsp.writeFile(credentialsPath, credentials);
  const requests: { url: string; authorization: string | null }[] = [];
  const usagesBody = { usages: { limit_5h: { used_ratio: 0.25, reset_time: '2026-10-28T14:00:00Z' }, limit_7d: { used_ratio: '0.5' } } };
  const responses = [Response.json(usagesBody), Response.json(usagesBody), new Response('{}', { status: 401 })];
  const fetchFn: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    return responses[Math.min(requests.length - 1, responses.length - 1)];
  };
  const planLimitBroadcasts: Record<string, unknown>[] = [];
  const sessions = new Map([['kimi-card', { agentId: 'kimi', hasLivePty: true }]]);
  let intervalTick = () => {};
  const wiring = createUsageWiring({
    config: {},
    sessions,
    broadcast: (message) => {
      if (message.type === 'plan-limits') planLimitBroadcasts.push(message);
    },
    createScanner: () => scriptedScanner([], [COMPLETE_PASS]),
    loadPricingFn: async () => ({ table: new Map(), source: 'snapshot', fetchedAt: null }),
    readKimiPlanLimits: createKimiPlanLimitsReader({ env: { KIMI_CODE_HOME: kimiHome }, homeDir: directory, fetchFn, nowFn: () => nowMs }).readPlanLimits,
    nowFn: () => nowMs,
    setIntervalFn: (run) => {
      intervalTick = run;
      return setInterval(() => {}, 60_000);
    },
    logger: { warn: () => {}, log: () => {} },
  });
  context.after(async () => {
    await wiring.stop();
    await realFsp.rm(directory, { recursive: true, force: true });
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  await wiring.start();
  await wiring.requestReport();
  await settle();
  assert.deepEqual(requests, [{ url: 'https://api.kimi.ai/coding/v1/usages', authorization: 'Bearer kimi-access' }]);
  const firstWindows = wiring.getPlanLimitsMessage('kimi');
  assert.deepEqual(firstWindows, {
    type: 'plan-limits',
    ts: nowMs,
    fiveHour: { pct: 25, resetsAtMs: Date.parse('2026-10-28T14:00:00Z') },
    sevenDay: { pct: 50, resetsAtMs: null },
    source: 'usages',
    vendor: 'kimi',
  });
  assert.equal(ServerMessage.safeParse(firstWindows).success, true);
  assert.equal(planLimitBroadcasts.length, 1);

  nowMs += 30_000;
  await wiring.requestReport();
  intervalTick();
  await settle();
  assert.equal(requests.length, 1);

  nowMs += 16 * 60 * 1000;
  intervalTick();
  await settle();
  const unchangedWindows = { ...firstWindows, ts: nowMs };
  assert.equal(requests.length, 2);
  assert.deepEqual(planLimitBroadcasts.at(-1), unchangedWindows);

  nowMs += 16 * 60 * 1000;
  intervalTick();
  await settle();
  assert.equal(requests.length, 3);
  assert.deepEqual(wiring.getPlanLimitsMessage('kimi'), unchangedWindows);
  assert.equal(planLimitBroadcasts.length, 2);
  assert.equal(await realFsp.readFile(credentialsPath, 'utf8'), credentials);

  sessions.clear();
  nowMs += 16 * 60 * 1000;
  intervalTick();
  await wiring.requestReport();
  await settle();
  assert.equal(requests.length, 3);
});
