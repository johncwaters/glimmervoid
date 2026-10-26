import '../support/disable-telemetry.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Browser, BrowserContext, Page, Request, WebSocket as PageWebSocket } from 'playwright-core';
import WebSocket from 'ws';

import { createBackend } from '../../server/backend/backend.ts';
import { isolateTranscriptHomes } from '../../tests/helpers/transcript-homes.ts';
import { dashboardClient } from '../../tests/helpers/dashboard-ws.ts';
import { addSession, createProject, listProcessesMentioning, quoteShell, runCommand, snapshotEnvironment } from '../site-capture/isolated-glimmervoid.ts';
import { connectControl, prepareIsolatedEnvironment, removeHarnessTempDirectory, safeTextTail } from '../support/backend-harness.ts';
import { LoadCostResultSchema, decideShellCheck, renderComparison, renderMarkdown } from './report-core.ts';
import type { LoadCostResult, ScenarioResult, ShellCheck } from './report-core.ts';
import { THREE_G_PROFILE, median, medianRunIndex } from './shaping-core.ts';
import { PONG, fillCompleteMarker } from './scrollback-agent.ts';
import { createShapingProxy } from './shaping-proxy.ts';
import type { ChannelTallies, ShapingProxy } from './shaping-proxy.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLIENT_DIR = path.join(REPO_ROOT, 'dist', 'client');
const SCROLLBACK_AGENT_PATH = path.join(import.meta.dirname, 'scrollback-agent.ts');
const CLIENT_SOURCES = ['public', 'shared', 'assets', 'vite.config.ts', 'package.json', 'package-lock.json'];
const DEFAULT_ARTIFACTS_DIR = path.join(import.meta.dirname, 'artifacts');
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const PHONE_LABEL = 'Phone viewport 390x844';
const NETWORK_QUIET_MS = 500;
const READY_TIMEOUT_MS = 240_000;
const SEED_TIMEOUT_MS = 30_000;
const AGENT_EXIT_TIMEOUT_MS = 15_000;
const SHUTDOWN_CAP_MS = 5_000;

interface FixtureSession {
  key: string;
  name: string;
  fillLines: number;
}

interface HarnessOptions {
  runs: number;
  comparePath: string | null;
  artifactsDir: string;
  executablePath: string | undefined;
}

interface Fleet {
  port: number;
  sessionIdByKey: Map<string, string>;
}

interface RunMeasurement {
  elapsedMs: number;
  channels: ChannelTallies;
  parsed: { controlJsonBytes: number; replayBytes: number };
  shellCheck: ShellCheck | null;
}

interface Scenario {
  id: string;
  label: string;
  detail: string;
  measure(fleet: Fleet, browser: Browser, proxy: ShapingProxy): Promise<RunMeasurement>;
}

const SESSION_A: FixtureSession = { key: 'A', name: 'session-a', fillLines: 1500 };
const SESSION_B: FixtureSession = { key: 'B', name: 'session-b', fillLines: 300 };
const SESSION_C: FixtureSession = { key: 'C', name: 'session-c', fillLines: 50 };
const IDLE_FILLERS: FixtureSession[] = [1, 2, 3, 4, 5].map((number) => ({ key: `idle-${number}`, name: `idle-${number}`, fillLines: 20 }));
const FIXTURES: FixtureSession[] = [SESSION_A, SESSION_B, SESSION_C, ...IDLE_FILLERS];

function parseOptions(argv: readonly string[]): HarnessOptions {
  const options: HarnessOptions = { runs: 3, comparePath: null, artifactsDir: DEFAULT_ARTIFACTS_DIR, executablePath: process.env.CHROME_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    index += 1;
    if (flag === '--runs') {
      options.runs = Number.parseInt(value, 10);
      if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error('--runs needs a positive integer');
      continue;
    }
    if (flag === '--compare') { options.comparePath = path.resolve(value); continue; }
    if (flag === '--artifacts') { options.artifactsDir = path.resolve(value); continue; }
    if (flag === '--executable') { options.executablePath = path.resolve(value); continue; }
    throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

function payloadText(payload: string | Buffer): string {
  return typeof payload === 'string' ? payload : payload.toString('utf8');
}

async function waitFor(condition: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`${description} within ${Math.round(timeoutMs / 1000)} s`);
    await sleep(20);
  }
}

function watchFirstOutput(controlSocket: WebSocket, sessionName: string): () => boolean {
  let hasOutput = false;
  const onMessage = (raw: Buffer): void => {
    const frame: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof frame !== 'object' || frame === null) return;
    const stateChange = frame as { type?: unknown; session?: unknown; from?: unknown };
    if (stateChange.type !== 'state-change' || stateChange.session !== sessionName || stateChange.from !== 'STARTING') return;
    hasOutput = true;
    controlSocket.off('message', onMessage);
  };
  controlSocket.on('message', onMessage);
  return () => hasOutput;
}

async function seedScrollback(port: number, sessionId: string, fixture: FixtureSession): Promise<void> {
  const client = await dashboardClient(port);
  const socket = new WebSocket(client.url(`/terminals/${sessionId}?history=screen`), client.options);
  let received = '';
  socket.on('message', (raw: Buffer) => { received += raw.toString('utf8'); });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  try {
    const ping = setInterval(() => { socket.send(JSON.stringify({ type: 'input', data: 'ping\r' })); }, 1000);
    try {
      await waitFor(() => received.includes(PONG), SEED_TIMEOUT_MS, `${fixture.name} did not answer (terminal tail: ${safeTextTail(received, 400)})`);
    } finally {
      clearInterval(ping);
    }
    socket.send(JSON.stringify({ type: 'input', data: `fill ${fixture.fillLines}\r` }));
    await waitFor(() => received.includes(fillCompleteMarker(fixture.fillLines)), SEED_TIMEOUT_MS, `${fixture.name} did not write its scrollback`);
  } finally {
    socket.close();
  }
}

function watchPageSockets(page: Page) {
  let parsed = { controlJsonBytes: 0, replayBytes: 0 };
  let readySessionId = '';
  let readyMarker = '';
  let isMeasuring = false;
  let isOpening = false;
  let isReady = false;
  page.on('websocket', (socket: PageWebSocket) => {
    const socketPath = new URL(socket.url()).pathname;
    if (socketPath === '/control') {
      socket.on('framereceived', ({ payload }) => { if (isMeasuring && !isReady) parsed.controlJsonBytes += Buffer.byteLength(payload); });
      return;
    }
    let viewText = '';
    socket.on('framereceived', ({ payload }) => {
      if (!isMeasuring || isReady) return;
      parsed.replayBytes += Buffer.byteLength(payload);
      if (!isOpening || socketPath !== `/terminals/${readySessionId}`) return;
      viewText += payloadText(payload);
      isReady = viewText.includes(readyMarker);
    });
  });
  return {
    beginWindow(sessionId: string, fixture: FixtureSession) {
      parsed = { controlJsonBytes: 0, replayBytes: 0 };
      readySessionId = sessionId;
      readyMarker = fillCompleteMarker(fixture.fillLines);
      isMeasuring = true;
      isOpening = false;
      isReady = false;
    },
    markOpening() { isOpening = true; },
    hasReplayArrived: () => isReady,
    endWindow() {
      isMeasuring = false;
      return parsed;
    },
  };
}

function watchHttpSizes(page: Page) {
  const pending: Promise<{ url: string; status: number; bodyBytes: number; headerBytes: number; decodedBytes: number }>[] = [];
  let isCollecting = true;
  const inFlightRequests = new Set<Request>();
  let notifyNetworkQuiet: (() => void) | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  const armQuietTimer = () => {
    clearTimeout(quietTimer);
    if (inFlightRequests.size > 0 || !notifyNetworkQuiet) return;
    quietTimer = setTimeout(notifyNetworkQuiet, NETWORK_QUIET_MS);
  };
  const forgetRequest = (request: Request) => {
    inFlightRequests.delete(request);
    armQuietTimer();
  };
  page.on('request', (request) => {
    if (!isCollecting) return;
    inFlightRequests.add(request);
    clearTimeout(quietTimer);
  });
  page.on('requestfailed', forgetRequest);
  page.on('requestfinished', (request) => {
    forgetRequest(request);
    if (!isCollecting) return;
    pending.push((async () => {
      const sizes = await request.sizes();
      const response = await request.response();
      const decodedBytes = response?.status() === 200 ? (await response.body()).length : 0;
      return { url: request.url(), status: response?.status() ?? 0, bodyBytes: sizes.responseBodySize, headerBytes: sizes.responseHeadersSize, decodedBytes };
    })());
  });
  const settleRequests = () => new Promise<void>((resolve) => {
    notifyNetworkQuiet = resolve;
    armQuietTimer();
  });
  const checkShell = async (proxyHttpBytes: number): Promise<ShellCheck> => {
    isCollecting = false;
    const finished = await Promise.all(pending);
    let browserReportedHttpBytes = 0;
    let assetFilesChecked = 0;
    const assetMismatches: string[] = [];
    for (const entry of finished) {
      browserReportedHttpBytes += entry.bodyBytes + entry.headerBytes;
      const pathname = new URL(entry.url).pathname;
      const assetPath = path.join(CLIENT_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
      if (entry.status !== 200 || !assetPath.startsWith(CLIENT_DIR) || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) continue;
      assetFilesChecked += 1;
      const sizeOnDisk = fs.statSync(assetPath).size;
      if (sizeOnDisk !== entry.decodedBytes) assetMismatches.push(`${pathname} ${entry.decodedBytes} != ${sizeOnDisk}`);
    }
    return decideShellCheck(proxyHttpBytes, browserReportedHttpBytes, assetFilesChecked, assetMismatches);
  };
  return { settleRequests, checkShell };
}

async function waitForPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
}

type Visit = 'cold' | 'reconnect' | 'open';

async function loadDashboard(page: Page, port: number): Promise<void> {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'commit', timeout: READY_TIMEOUT_MS });
  await page.locator('body.app-ready').waitFor({ timeout: READY_TIMEOUT_MS });
}

function isRowTappable(rowSelector: string): boolean {
  const row = document.querySelector(rowSelector);
  if (!row) return false;
  const rect = row.getBoundingClientRect();
  return row.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
}

async function openSession(page: Page, sockets: ReturnType<typeof watchPageSockets>, sessionId: string, fixture: FixtureSession): Promise<void> {
  sockets.markOpening();
  const rowSelector = `.phone-board-list button.session-row[data-id="${sessionId}"]`;
  await page.waitForFunction(isRowTappable, rowSelector, { polling: 'raf', timeout: READY_TIMEOUT_MS });
  await page.locator(rowSelector).click({ timeout: READY_TIMEOUT_MS });
  await waitForReplay(page, sockets, fixture);
}

async function waitForReplay(page: Page, sockets: ReturnType<typeof watchPageSockets>, fixture: FixtureSession): Promise<void> {
  await waitFor(sockets.hasReplayArrived, READY_TIMEOUT_MS, `${fixture.name} replay never reached ready`);
  await waitForPaint(page);
}

async function measureVisit(fleet: Fleet, browser: Browser, proxy: ShapingProxy, fixture: FixtureSession, visit: Visit): Promise<RunMeasurement> {
  const sessionId = fleet.sessionIdByKey.get(fixture.key) ?? '';
  const context: BrowserContext = await browser.newContext(PHONE);
  try {
    const page = await context.newPage();
    const sockets = watchPageSockets(page);
    if (visit !== 'cold') {
      sockets.beginWindow(sessionId, fixture);
      await loadDashboard(page, fleet.port);
      if (visit === 'reconnect') await openSession(page, sockets, sessionId, fixture);
      sockets.endWindow();
    }
    const httpSizes = visit === 'cold' ? watchHttpSizes(page) : null;
    sockets.beginWindow(sessionId, fixture);
    proxy.beginMeasure();
    const startedAt = performance.now();
    if (visit === 'cold') await loadDashboard(page, fleet.port);
    if (visit === 'reconnect') {
      sockets.markOpening();
      await page.reload({ waitUntil: 'commit', timeout: READY_TIMEOUT_MS });
      await waitForReplay(page, sockets, fixture);
    }
    if (visit !== 'reconnect') await openSession(page, sockets, sessionId, fixture);
    const elapsedMs = performance.now() - startedAt;
    const parsed = sockets.endWindow();
    await httpSizes?.settleRequests();
    const channels = await proxy.endMeasure();
    const shellCheck = httpSizes ? await httpSizes.checkShell(channels.http.wireBytesDown) : null;
    return { elapsedMs, channels, parsed, shellCheck };
  } finally {
    await context.close();
  }
}

const SCENARIOS: Scenario[] = [
  { id: 'cold', label: 'Cold connect', detail: 'shell + session A', measure: (fleet, browser, proxy) => measureVisit(fleet, browser, proxy, SESSION_A, 'cold') },
  { id: 'reconnect', label: 'Reconnect', detail: 'warm-cache reload, session A restores', measure: (fleet, browser, proxy) => measureVisit(fleet, browser, proxy, SESSION_A, 'reconnect') },
  { id: 'open-a', label: 'Open session A', detail: `${SESSION_A.fillLines} lines`, measure: (fleet, browser, proxy) => measureVisit(fleet, browser, proxy, SESSION_A, 'open') },
  { id: 'open-b', label: 'Open session B', detail: `${SESSION_B.fillLines} lines`, measure: (fleet, browser, proxy) => measureVisit(fleet, browser, proxy, SESSION_B, 'open') },
  { id: 'open-c', label: 'Open session C', detail: `${SESSION_C.fillLines} lines`, measure: (fleet, browser, proxy) => measureVisit(fleet, browser, proxy, SESSION_C, 'open') },
];

async function runScenario(scenario: Scenario, runs: number, fleet: Fleet, browser: Browser, proxy: ShapingProxy): Promise<{ result: ScenarioResult; shellCheck: ShellCheck | null }> {
  const measurements: RunMeasurement[] = [];
  for (let run = 0; run < runs; run += 1) {
    const measurement = await scenario.measure(fleet, browser, proxy);
    console.log(`${scenario.label} run ${run + 1}: ${(measurement.elapsedMs / 1000).toFixed(2)} s`);
    measurements.push(measurement);
  }
  const runsMs = measurements.map((measurement) => measurement.elapsedMs);
  const representative = measurements[medianRunIndex(runsMs)] ?? measurements[0];
  if (!representative) throw new Error(`${scenario.label} produced no runs`);
  return {
    result: { id: scenario.id, label: scenario.label, detail: scenario.detail, runsMs, medianMs: median(runsMs), channels: representative.channels, parsed: representative.parsed },
    shellCheck: representative.shellCheck,
  };
}

async function writeShim(tempDirectory: string): Promise<void> {
  const shimDirectory = path.join(tempDirectory, 'shim');
  await fs.promises.mkdir(shimDirectory);
  await fs.promises.writeFile(path.join(shimDirectory, 'claude'), `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(SCROLLBACK_AGENT_PATH)} "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${shimDirectory}${path.delimiter}${process.env.PATH ?? ''}`;
}

async function stopBackend(backend: ReturnType<typeof createBackend>, httpServer: http.Server): Promise<void> {
  const outcome = backend.shutdown();
  const settled = Promise.allSettled([...outcome.reaps, ...outcome.stoppers.map((entry) => entry.promise)]);
  await Promise.race([settled, sleep(SHUTDOWN_CAP_MS)]);
  httpServer.closeAllConnections();
  await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
}

async function waitForAgentsToExit(tempDirectory: string): Promise<void> {
  const deadline = Date.now() + AGENT_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await listProcessesMentioning([tempDirectory])).length === 0) return;
    await sleep(200);
  }
  const leftovers = await listProcessesMentioning([tempDirectory]);
  if (leftovers.length > 0) throw new Error(`processes left behind:\n${leftovers.join('\n')}`);
}

async function currentCommit(): Promise<string> {
  const { stdout } = await runCommand('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

function newestSourceChange(sourcePath: string): { path: string; mtimeMs: number } {
  const stats = fs.statSync(sourcePath);
  if (!stats.isDirectory()) return { path: sourcePath, mtimeMs: stats.mtimeMs };
  let newest = { path: sourcePath, mtimeMs: 0 };
  for (const entry of fs.readdirSync(sourcePath)) {
    const candidate = newestSourceChange(path.join(sourcePath, entry));
    if (candidate.mtimeMs > newest.mtimeMs) newest = candidate;
  }
  return newest;
}

function findStaleBuildReason(): string | null {
  const builtAtMs = fs.statSync(path.join(CLIENT_DIR, 'index.html')).mtimeMs;
  const newest = CLIENT_SOURCES.map((source) => newestSourceChange(path.join(REPO_ROOT, source))).reduce((latest, candidate) => (candidate.mtimeMs > latest.mtimeMs ? candidate : latest));
  if (newest.mtimeMs <= builtAtMs) return null;
  return `dist/client is older than ${path.relative(REPO_ROOT, newest.path)}`;
}

async function measureAll(options: HarnessOptions): Promise<LoadCostResult> {
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-load-cost-'));
  const restoreEnvironment = snapshotEnvironment();
  let browser: Browser | undefined;
  let proxy: ShapingProxy | undefined;
  let controlSocket: WebSocket | undefined;
  let backend: ReturnType<typeof createBackend> | undefined;
  const httpServer = http.createServer();
  try {
    isolateTranscriptHomes(tempDirectory);
    const projectPath = await createProject(tempDirectory, 'load-cost');
    const { port } = await prepareIsolatedEnvironment({ tempDirectory, repoRoots: [projectPath], recordSessions: false });
    await writeShim(tempDirectory);
    backend = createBackend(httpServer, { staticDir: 'auto' });
    httpServer.on('request', backend.app);
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', () => resolve());
    });
    controlSocket = await connectControl(port);
    const fleet: Fleet = { port, sessionIdByKey: new Map() };
    for (const fixture of FIXTURES) {
      const hasStarted = watchFirstOutput(controlSocket, fixture.name);
      const sessionId = await addSession(controlSocket, fixture.name, projectPath);
      await waitFor(hasStarted, SEED_TIMEOUT_MS, `${fixture.name} produced no output`);
      fleet.sessionIdByKey.set(fixture.key, sessionId);
      await seedScrollback(port, sessionId, fixture);
    }
    proxy = await createShapingProxy({ targetPort: port, profile: THREE_G_PROFILE });
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath: options.executablePath,
      args: [`--proxy-server=socks5://127.0.0.1:${proxy.port}`, '--proxy-bypass-list=<-loopback>'],
    });
    const scenarios: ScenarioResult[] = [];
    let shellCheck: ShellCheck | null = null;
    for (const scenario of SCENARIOS) {
      const measured = await runScenario(scenario, options.runs, fleet, browser, proxy);
      scenarios.push(measured.result);
      if (scenario.id === 'cold') shellCheck = measured.shellCheck;
    }
    return {
      schemaVersion: 1,
      commit: await currentCommit(),
      recordedAt: new Date().toISOString(),
      profile: THREE_G_PROFILE.name,
      viewport: PHONE_LABEL,
      runs: options.runs,
      scenarios,
      shellCheck,
    };
  } finally {
    await browser?.close().catch(() => {});
    await proxy?.close().catch(() => {});
    controlSocket?.terminate();
    if (backend) await stopBackend(backend, httpServer);
    try {
      await waitForAgentsToExit(tempDirectory);
    } finally {
      removeHarnessTempDirectory(tempDirectory);
      restoreEnvironment();
    }
  }
}

async function writeArtifacts(result: LoadCostResult, artifactsDir: string): Promise<string> {
  await fs.promises.mkdir(artifactsDir, { recursive: true });
  const stamp = result.recordedAt.replace(/[:.]/g, '-');
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const resultPath = path.join(artifactsDir, `${stamp}-${result.commit.slice(0, 8)}.json`);
  await fs.promises.writeFile(resultPath, serialized);
  await fs.promises.writeFile(path.join(artifactsDir, 'latest.json'), serialized);
  await fs.promises.writeFile(path.join(artifactsDir, 'latest.md'), renderMarkdown(result));
  return resultPath;
}

async function main(): Promise<number> {
  if (process.platform === 'win32') {
    console.error('the load-cost harness runs on Linux and macOS only: the agent shim it spawns is a POSIX sh script');
    return 2;
  }
  const options = parseOptions(process.argv.slice(2));
  if (!fs.existsSync(path.join(CLIENT_DIR, 'index.html'))) {
    console.error('dist/client/index.html is missing: run npm run build first');
    return 1;
  }
  const staleBuildReason = findStaleBuildReason();
  if (staleBuildReason) {
    console.error(`${staleBuildReason}: run npm run build first`);
    return 1;
  }
  const baseline = options.comparePath ? LoadCostResultSchema.parse(JSON.parse(await fs.promises.readFile(options.comparePath, 'utf8'))) : null;
  const result = await measureAll(options);
  const resultPath = await writeArtifacts(result, options.artifactsDir);
  console.log(`\n${renderMarkdown(result)}`);
  if (baseline) console.log(renderComparison(baseline, result));
  console.log(`result: ${resultPath}`);
  if (result.shellCheck && !result.shellCheck.isConsistent) {
    console.error('shell check failed: proxy byte counts disagree with the browser or dist/client');
    return 1;
  }
  return 0;
}

main().then(
  (exitCode) => { process.exit(exitCode); },
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  },
);
