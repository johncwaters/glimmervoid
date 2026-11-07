import '../support/disable-telemetry.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Browser, Page } from 'playwright-core';
import type WebSocket from 'ws';
import { z } from 'zod';

import { boardReading } from '../../mcp/core/board-reading.ts';
import { toolResultFromReply } from '../../mcp/core/tool-result.ts';
import { createBackend } from '../../server/backend/backend.ts';
import { WHITEBOARDS_FOLDER_NAME } from '../../server/whiteboard/whiteboard-wiring.ts';
import { sparseBoardRecord } from '../../shared/contracts/whiteboard.ts';
import type { Board, Op } from '../../shared/contracts/whiteboard.ts';
import { layoutBoard } from '../../shared/whiteboard-layout-core.ts';
import { isolateTranscriptHomes } from '../../tests/helpers/transcript-homes.ts';
import { runCommand, snapshotEnvironment } from '../site-capture/isolated-glimmervoid.ts';
import { connectControl, prepareIsolatedEnvironment, removeHarnessTempDirectory } from '../support/backend-harness.ts';
import { percentile, renderWhiteboardComparison, renderWhiteboardMarkdown, WhiteboardBenchResultSchema } from './report-core.ts';
import type { WhiteboardBenchResult, WhiteboardMetric, WhiteboardMetricUnit } from './report-core.ts';
import { median } from './shaping-core.ts';
import { boxIdsOf, generateBoardRecord, seededRandom } from './whiteboard-board-generator.ts';

type BenchSection = WhiteboardBenchResult['sections'][number];

interface WhiteboardBenchOptions {
  sizes: number[];
  outPath: string | null;
  comparePath: string | null;
  sections: BenchSection[];
  executablePath: string | undefined;
}

interface BenchEnvironment {
  repoRoot: string;
  clientIndexPath: string;
  findStaleBuildReason: () => string | null;
}

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const BOARD_ID = 'bench-board';
const BOARD_TITLE = 'Bench board';
const PUT_BATCH_SIZES = [1, 10, 100] as const;
const PUT_ROUNDS = 10;
const LAYOUT_RUNS = 3;
const PAN_FRAMES = 120;
const ZOOM_FRAMES = 40;
const DRAG_STEPS = 60;
const FRAME_BUDGET_MS = 1000 / 60;
const DROPPED_FRAME_FACTOR = 1.5;
const CONTROL_REPLY_TIMEOUT_MS = 120_000;
const OPEN_TIMEOUT_MS = 180_000;
const SHUTDOWN_CAP_MS = 5_000;
const SECTION_FLAGS: Record<string, BenchSection> = { '--server-only': 'server', '--browser': 'browser', '--mcp': 'mcp' };

function parseWhiteboardOptions(argv: readonly string[]): WhiteboardBenchOptions {
  const options: WhiteboardBenchOptions = { sizes: [1000], outPath: null, comparePath: null, sections: [], executablePath: process.env.CHROME_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (flag === '--whiteboard') continue;
    const section = SECTION_FLAGS[flag];
    if (section) { options.sections.push(section); continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    index += 1;
    if (flag === '--sizes') { options.sizes = value.split(',').map(parseSize); continue; }
    if (flag === '--out') { options.outPath = path.resolve(value); continue; }
    if (flag === '--compare') { options.comparePath = path.resolve(value); continue; }
    if (flag === '--executable') { options.executablePath = path.resolve(value); continue; }
    throw new Error(`unknown whiteboard argument ${flag}`);
  }
  if (options.sections.length === 0) options.sections = ['server', 'browser', 'mcp'];
  if (!options.sections.includes('server')) options.sections.unshift('server');
  return options;
}

function parseSize(text: string): number {
  const size = Number.parseInt(text, 10);
  if (!Number.isInteger(size) || size < 20) throw new Error(`--sizes takes element counts of at least 20, not ${text}`);
  return size;
}

function metricOf(key: string, label: string, unit: WhiteboardMetricUnit, value: number | null): WhiteboardMetric {
  return { key, label, unit, value };
}

function megabytes(byteCount: number): number {
  return byteCount / 1_000_000;
}

async function seedBoard(configPath: string, elementCount: number): Promise<{ board: Board; fileBytes: number }> {
  const record = generateBoardRecord({ elementCount, seed: elementCount, boardId: BOARD_ID, title: BOARD_TITLE, createdAt: Date.now() });
  const boardsRoot = path.join(path.dirname(configPath), WHITEBOARDS_FOLDER_NAME);
  await fs.promises.mkdir(boardsRoot, { recursive: true });
  const serialized = JSON.stringify(sparseBoardRecord(record));
  await fs.promises.writeFile(path.join(boardsRoot, `${BOARD_ID}.json`), serialized, { mode: 0o600 });
  return { board: record.board, fileBytes: Buffer.byteLength(serialized) };
}

function measureLayoutMs(board: Board): number {
  const runsMs = Array.from({ length: LAYOUT_RUNS }, () => {
    const startedAt = performance.now();
    layoutBoard(board);
    return performance.now() - startedAt;
  });
  return median(runsMs);
}

function measureMcpChars(board: Board): number {
  const replyBody = { ok: true, board, changes: [], readingVersion: board.version, ...boardReading(board) };
  return JSON.stringify(toolResultFromReply({ status: 200, body: replyBody })).length;
}

const ControlReplySchema = z.object({ requestId: z.string(), ok: z.boolean(), error: z.string().nullish() });

type ControlReply = z.infer<typeof ControlReplySchema>;

function controlRequest(socket: WebSocket, type: string, payload: Record<string, unknown>): Promise<{ reply: ControlReply; replyBytes: number; elapsedMs: number }> {
  const requestId = `bench-${type}-${performance.now()}`;
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`${type} got no reply in ${CONTROL_REPLY_TIMEOUT_MS} ms`));
    }, CONTROL_REPLY_TIMEOUT_MS);
    function onMessage(data: Buffer | ArrayBuffer | Buffer[]): void {
      const text = Array.isArray(data) ? Buffer.concat(data).toString() : Buffer.from(new Uint8Array(data)).toString();
      if (!text.includes(requestId)) return;
      const parsed = ControlReplySchema.safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.requestId !== requestId) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve({ reply: parsed.data, replyBytes: Buffer.byteLength(text), elapsedMs: performance.now() - startedAt });
    }
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type, requestId, ...payload }));
  });
}

function retitleOps(boxIds: readonly string[], count: number, round: number, nextRandom: () => number): Op[] {
  return Array.from({ length: count }, (_, index) => {
    const id = boxIds[Math.floor(nextRandom() * boxIds.length)] ?? boxIds[0] ?? '';
    return { op: 'set' as const, id, fields: { title: `retitled ${round} ${index}` } };
  });
}

async function measurePuts(socket: WebSocket, board: Board): Promise<WhiteboardMetric[]> {
  const boxIds = boxIdsOf(board);
  const nextRandom = seededRandom(board.version + boxIds.length);
  const metrics: WhiteboardMetric[] = [];
  for (const batchSize of PUT_BATCH_SIZES) {
    const runsMs: number[] = [];
    for (let round = 0; round < PUT_ROUNDS; round += 1) {
      const { reply, elapsedMs } = await controlRequest(socket, 'whiteboard-op', { boardId: BOARD_ID, ops: retitleOps(boxIds, batchSize, round, nextRandom) });
      if (!reply.ok) throw new Error(`a ${batchSize} op put was refused: ${reply.error ?? 'no reason'}`);
      runsMs.push(elapsedMs);
    }
    metrics.push(metricOf(`put-${batchSize}-p50`, `Put of ${batchSize} op(s), p50`, 'ms', percentile(runsMs, 0.5)));
    metrics.push(metricOf(`put-${batchSize}-p95`, `Put of ${batchSize} op(s), p95`, 'ms', percentile(runsMs, 0.95)));
  }
  return metrics;
}

interface FrameSample {
  framesMs: number[];
}

async function startFrameSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sampler = { framesMs: [] as number[], isRunning: true, lastAt: performance.now() };
    Object.assign(window, { benchFrameSampler: sampler });
    const tick = (at: number) => {
      sampler.framesMs.push(at - sampler.lastAt);
      sampler.lastAt = at;
      if (sampler.isRunning) requestAnimationFrame(tick);
    };
    requestAnimationFrame((at) => { sampler.lastAt = at; requestAnimationFrame(tick); });
  });
}

async function stopFrameSampler(page: Page): Promise<FrameSample> {
  return page.evaluate(() => {
    const sampler: unknown = Reflect.get(window, 'benchFrameSampler');
    if (typeof sampler !== 'object' || sampler === null || !('framesMs' in sampler) || !Array.isArray(sampler.framesMs)) throw new Error('the frame sampler never started');
    Reflect.set(sampler, 'isRunning', false);
    return { framesMs: sampler.framesMs.slice(1).filter((frameMs): frameMs is number => typeof frameMs === 'number') };
  });
}

async function wheelEveryFrame(page: Page, frames: number, wheel: { deltaX: number; deltaY: number; ctrlKey: boolean }): Promise<void> {
  await page.evaluate(async ({ frames, wheel }) => {
    const viewport = document.querySelector('.wb-viewport');
    if (!viewport) throw new Error('the board viewport is missing');
    const viewportRect = viewport.getBoundingClientRect();
    const clientX = viewportRect.left + viewportRect.width / 2;
    const clientY = viewportRect.top + viewportRect.height / 2;
    for (let frame = 0; frame < frames; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      viewport.dispatchEvent(new WheelEvent('wheel', { ...wheel, clientX, clientY, bubbles: true, cancelable: true }));
    }
  }, { frames, wheel });
}

function frameMetrics(prefix: string, label: string, sample: FrameSample): WhiteboardMetric[] {
  const framesMs = sample.framesMs;
  const droppedFrames = framesMs.filter((frameMs) => frameMs > FRAME_BUDGET_MS * DROPPED_FRAME_FACTOR).length;
  const totalMs = framesMs.reduce((total, frameMs) => total + frameMs, 0);
  return [
    metricOf(`${prefix}-frame-p50`, `${label}, frame time p50`, 'ms', percentile(framesMs, 0.5)),
    metricOf(`${prefix}-frame-p95`, `${label}, frame time p95`, 'ms', percentile(framesMs, 0.95)),
    metricOf(`${prefix}-frame-max`, `${label}, frame time max`, 'ms', framesMs.length > 0 ? Math.max(...framesMs) : null),
    metricOf(`${prefix}-fps`, `${label}, frames per second`, 'fps', totalMs > 0 ? (framesMs.length * 1000) / totalMs : null),
    metricOf(`${prefix}-dropped`, `${label}, dropped frames`, 'count', droppedFrames),
  ];
}

async function sampleFrames(page: Page, prefix: string, label: string, drive: () => Promise<void>): Promise<WhiteboardMetric[]> {
  await startFrameSampler(page);
  await drive();
  return frameMetrics(prefix, label, await stopFrameSampler(page));
}

async function openBoardInFocus(page: Page, port: number): Promise<number> {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#loading-screen').waitFor({ state: 'hidden', timeout: OPEN_TIMEOUT_MS });
  const boardsSection = page.locator('.rail-boards-details');
  if (await boardsSection.getAttribute('open') === null) await boardsSection.locator('summary').click();
  const boardRow = page.locator('.focus-board-list .session-row', { hasText: BOARD_TITLE });
  await boardRow.waitFor({ timeout: OPEN_TIMEOUT_MS });
  const startedAt = performance.now();
  await boardRow.click();
  await page.waitForFunction(() => document.querySelectorAll('.wb-viewport .wb-element').length > 0, null, { timeout: OPEN_TIMEOUT_MS, polling: 50 });
  return performance.now() - startedAt;
}

async function dragOneBox(page: Page): Promise<void> {
  const boxCenter = await page.evaluate(() => {
    const viewport = document.querySelector('.wb-viewport')?.getBoundingClientRect();
    if (!viewport) return null;
    for (const node of document.querySelectorAll('.wb-viewport .wb-element[data-element-kind="box"]')) {
      const rect = node.getBoundingClientRect();
      const isInView = rect.left > viewport.left && rect.top > viewport.top && rect.right < viewport.right && rect.bottom < viewport.bottom;
      if (isInView && rect.width > 8 && rect.height > 8) return { x: rect.left + rect.width / 2, y: rect.top + 6 };
    }
    return null;
  });
  if (!boxCenter) throw new Error('no box is fully in view to drag');
  await page.mouse.move(boxCenter.x, boxCenter.y);
  await page.mouse.down();
  for (let step = 1; step <= DRAG_STEPS; step += 1) await page.mouse.move(boxCenter.x + step * 2, boxCenter.y + step);
  await page.mouse.up();
}

async function measureBrowser(browser: Browser, port: number): Promise<WhiteboardMetric[]> {
  const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  try {
    const page = await context.newPage();
    const openMs = await openBoardInFocus(page, port);
    await sleep(500);
    const pan = await sampleFrames(page, 'pan', 'Pan', () => wheelEveryFrame(page, PAN_FRAMES, { deltaX: 14, deltaY: 9, ctrlKey: false }));
    const zoom = await sampleFrames(page, 'zoom', 'Zoom sweep', async () => {
      await wheelEveryFrame(page, ZOOM_FRAMES, { deltaX: 0, deltaY: 1, ctrlKey: true });
      await wheelEveryFrame(page, ZOOM_FRAMES, { deltaX: 0, deltaY: -1, ctrlKey: true });
    });
    const drag = await sampleFrames(page, 'drag', 'Drag a box', () => dragOneBox(page));
    const pageFacts = await page.evaluate(() => ({
      domNodes: document.querySelectorAll('*').length,
      heapBytes: Number(Reflect.get(Reflect.get(performance, 'memory') ?? {}, 'usedJSHeapSize')) || null,
    }));
    return [
      metricOf('open', 'Open the board, first element drawn', 'ms', openMs),
      ...pan, ...zoom, ...drag,
      metricOf('dom-nodes', 'DOM nodes after the run', 'count', pageFacts.domNodes),
      metricOf('js-heap', 'JS heap after the run', 'mb', pageFacts.heapBytes === null ? null : megabytes(pageFacts.heapBytes)),
    ];
  } finally {
    await context.close();
  }
}

async function stopBackend(backend: ReturnType<typeof createBackend>, httpServer: http.Server): Promise<void> {
  const outcome = backend.shutdown();
  const settled = Promise.allSettled([...outcome.reaps, ...outcome.stoppers.map((entry) => entry.promise)]);
  await Promise.race([settled, sleep(SHUTDOWN_CAP_MS)]);
  httpServer.closeAllConnections();
  await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
}

async function measureSize(elementCount: number, options: WhiteboardBenchOptions, browser: Browser | null): Promise<WhiteboardMetric[]> {
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-whiteboard-bench-'));
  const restoreEnvironment = snapshotEnvironment();
  const httpServer = http.createServer();
  let backend: ReturnType<typeof createBackend> | undefined;
  let controlSocket: WebSocket | undefined;
  try {
    isolateTranscriptHomes(tempDirectory);
    const { port, configPath } = await prepareIsolatedEnvironment({ tempDirectory, repoRoots: [], recordSessions: false });
    const { board, fileBytes } = await seedBoard(configPath, elementCount);
    const metrics: WhiteboardMetric[] = [
      metricOf('file-bytes', 'Stored board size', 'bytes', fileBytes),
      metricOf('layout', 'Whole-board layout', 'ms', measureLayoutMs(board)),
    ];
    if (options.sections.includes('mcp')) metrics.push(metricOf('mcp-get-chars', 'MCP whiteboard get tool result, text plus structured copy', 'chars', measureMcpChars(board)));
    const rssBeforeBoot = process.memoryUsage().rss;
    backend = createBackend(httpServer, { staticDir: 'auto' });
    httpServer.on('request', backend.app);
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', () => resolve());
    });
    controlSocket = await connectControl(port);
    const firstGet = await controlRequest(controlSocket, 'whiteboard-get', { boardId: BOARD_ID });
    if (!firstGet.reply.ok) throw new Error(`the seeded board did not load: ${firstGet.reply.error ?? 'no reason'}`);
    const warmGet = await controlRequest(controlSocket, 'whiteboard-get', { boardId: BOARD_ID });
    metrics.push(
      metricOf('get-first', 'First get over the control socket', 'ms', firstGet.elapsedMs),
      metricOf('get-warm', 'Warm get over the control socket', 'ms', warmGet.elapsedMs),
      metricOf('get-bytes', 'Get reply size', 'bytes', warmGet.replyBytes),
      metricOf('rss-growth', 'Server RSS growth after boot and open', 'mb', megabytes(process.memoryUsage().rss - rssBeforeBoot)),
      ...await measurePuts(controlSocket, board),
    );
    if (browser && options.sections.includes('browser')) metrics.push(...await measureBrowser(browser, port));
    return metrics;
  } finally {
    controlSocket?.terminate();
    if (backend) await stopBackend(backend, httpServer);
    removeHarnessTempDirectory(tempDirectory);
    restoreEnvironment();
  }
}

async function launchBenchBrowser(executablePath: string | undefined): Promise<Browser> {
  const playwright = await import('playwright-core');
  return playwright.chromium.launch({ headless: true, executablePath, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
}

interface TreeSnapshot {
  commit: string;
  statusText: string;
}

async function snapshotTree(repoRoot: string): Promise<TreeSnapshot> {
  const { stdout: headText } = await runCommand('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
  const { stdout: statusText } = await runCommand('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=no']);
  return { commit: headText.trim(), statusText: statusText.trim() };
}

function measuredTreeOf(atStart: TreeSnapshot, atEnd: TreeSnapshot): { commit: string; hasUncommittedChanges: boolean } {
  const didTreeMove = atStart.commit !== atEnd.commit || atStart.statusText !== atEnd.statusText;
  return { commit: atStart.commit, hasUncommittedChanges: atStart.statusText.length > 0 || didTreeMove };
}

async function runWhiteboardBench(argv: readonly string[], environment: BenchEnvironment): Promise<number> {
  const options = parseWhiteboardOptions(argv);
  const needsBrowser = options.sections.includes('browser');
  if (needsBrowser && !fs.existsSync(environment.clientIndexPath)) {
    console.error('dist/client/index.html is missing: run npm run build first');
    return 1;
  }
  const staleBuildReason = needsBrowser ? environment.findStaleBuildReason() : null;
  if (staleBuildReason) {
    console.error(`${staleBuildReason}: run npm run build first`);
    return 1;
  }
  const treeAtStart = await snapshotTree(environment.repoRoot);
  const baseline = options.comparePath ? WhiteboardBenchResultSchema.parse(JSON.parse(await fs.promises.readFile(options.comparePath, 'utf8'))) : null;
  const browser = needsBrowser ? await launchBenchBrowser(options.executablePath) : null;
  const sizes: WhiteboardBenchResult['sizes'] = [];
  try {
    for (const elementCount of options.sizes) {
      console.log(`measuring a ${elementCount} element board`);
      sizes.push({ elementCount, metrics: await measureSize(elementCount, options, browser) });
    }
  } finally {
    await browser?.close().catch(() => {});
  }
  const result: WhiteboardBenchResult = {
    schemaVersion: 1,
    kind: 'whiteboard',
    ...measuredTreeOf(treeAtStart, await snapshotTree(environment.repoRoot)),
    recordedAt: new Date().toISOString(),
    node: process.version,
    sections: options.sections,
    viewport: `Desktop viewport ${DESKTOP_VIEWPORT.width}x${DESKTOP_VIEWPORT.height}, headless Chromium`,
    sizes,
  };
  console.log(`\n${renderWhiteboardMarkdown(result)}`);
  if (baseline) console.log(renderWhiteboardComparison(baseline, result));
  if (options.outPath) {
    await fs.promises.writeFile(options.outPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`result: ${options.outPath}`);
  }
  return 0;
}

export { runWhiteboardBench };
