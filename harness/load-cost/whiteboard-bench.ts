import '../support/disable-telemetry.ts';
import crypto from 'node:crypto';
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
import { createBoardStore } from '../../server/whiteboard/board-store-client.ts';
import { BOARD_STORE_FILENAME } from '../../server/whiteboard/board-store-core.ts';
import { WHITEBOARDS_FOLDER_NAME } from '../../server/whiteboard/whiteboard-wiring.ts';
import type { Board, BoardRecord, BoxMedia, Op } from '../../shared/contracts/whiteboard.ts';
import { layoutBoard } from '../../shared/whiteboard-layout-core.ts';
import type { BoardLayout } from '../../shared/whiteboard-layout-core.ts';
import { boardOutlineOf, defaultFocusOf, elementIdsTouching, elementPageOf, fitsOnePage, tileIndexOf } from '../../shared/whiteboard-tile-core.ts';
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
  hasMedia: boolean;
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
const SINGLE_LAYOUT_RUN_FROM_ELEMENTS = 100_000;
const OPEN_VIEW = { x: 0, y: 0, width: DESKTOP_VIEWPORT.width, height: DESKTOP_VIEWPORT.height };
const PANNED_VIEW = { ...OPEN_VIEW, x: DESKTOP_VIEWPORT.width * 4 };
const PAN_FRAMES = 120;
const ZOOM_FRAMES = 40;
const DRAG_STEPS = 60;
const BOX_SEARCH_STEP_PX = 40;
const FRAME_BUDGET_MS = 1000 / 60;
const DROPPED_FRAME_FACTOR = 1.5;
const CONTROL_REPLY_TIMEOUT_MS = 120_000;
const OPEN_TIMEOUT_MS = 180_000;
const FIRST_VIEW_TIMEOUT_MS = 900_000;
const SHUTDOWN_CAP_MS = 5_000;
const MEDIA_EVERY_NTH_BOX = 10;
const PAGE_EVERY_NTH_MEDIA = 8;
const DISTINCT_PICTURE_COUNT = 48;
const PICTURE_WIDTH_PX = 1600;
const PICTURE_HEIGHT_PX = 1000;
const PREVIEW_WIDTH_PX = 1024;
const PAGE_WIDTH_PX = 1280;
const PAGE_HEIGHT_PX = 800;
const BENCH_PAGE_HTML = '<!doctype html><html><body><h1>Bench page</h1><p>A page on the bench board.</p></body></html>';
const SECTION_FLAGS: Record<string, BenchSection> = { '--server-only': 'server', '--browser': 'browser', '--mcp': 'mcp' };

function parseWhiteboardOptions(argv: readonly string[]): WhiteboardBenchOptions {
  const options: WhiteboardBenchOptions = { sizes: [1000], outPath: null, comparePath: null, sections: [], executablePath: process.env.CHROME_PATH, hasMedia: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (flag === '--whiteboard') continue;
    if (flag === '--media') { options.hasMedia = true; continue; }
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

function assetIdOf(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function writeBenchMedia(assetsRoot: string): Promise<{ pictures: BoxMedia[]; page: BoxMedia }> {
  const { default: sharp } = await import('sharp');
  await fs.promises.mkdir(assetsRoot, { recursive: true });
  const pictures: BoxMedia[] = [];
  for (let pictureIndex = 0; pictureIndex < DISTINCT_PICTURE_COUNT; pictureIndex += 1) {
    const hue = Math.round((pictureIndex * 360) / DISTINCT_PICTURE_COUNT);
    const png = await sharp({ create: { width: PICTURE_WIDTH_PX, height: PICTURE_HEIGHT_PX, channels: 3, background: `hsl(${hue}, 60%, 55%)` } }).png().toBuffer();
    const asset = assetIdOf(png);
    const preview = await sharp(png).resize({ width: PREVIEW_WIDTH_PX }).webp().toBuffer();
    await fs.promises.writeFile(path.join(assetsRoot, `${asset}.png`), png);
    await fs.promises.writeFile(path.join(assetsRoot, `${asset}.preview.webp`), preview);
    pictures.push({ kind: 'image', asset, mime: 'image/png', width: PICTURE_WIDTH_PX, height: PICTURE_HEIGHT_PX, alt: `picture ${pictureIndex}`, hasPreview: true });
  }
  const pageAsset = assetIdOf(BENCH_PAGE_HTML);
  await fs.promises.writeFile(path.join(assetsRoot, `${pageAsset}.html`), BENCH_PAGE_HTML);
  return { pictures, page: { kind: 'page', asset: pageAsset, mime: 'text/html', width: PAGE_WIDTH_PX, height: PAGE_HEIGHT_PX, alt: 'bench page', hasPreview: false } };
}

async function withBenchMedia(board: Board, assetsRoot: string): Promise<number> {
  const { pictures, page } = await writeBenchMedia(assetsRoot);
  let mediaCount = 0;
  for (const boxId of boxIdsOf(board).filter((_, boxIndex) => boxIndex % MEDIA_EVERY_NTH_BOX === 0)) {
    const box = board.elements.get(boxId);
    if (box?.kind !== 'box' || box.shape === 'icon') continue;
    const picture = pictures[mediaCount % pictures.length];
    const media = mediaCount % PAGE_EVERY_NTH_MEDIA === PAGE_EVERY_NTH_MEDIA - 1 ? page : picture;
    if (!media) continue;
    board.elements.put({ ...box, media });
    mediaCount += 1;
  }
  return mediaCount;
}

async function benchBoardRecordOf(elementCount: number, boardsRoot: string, hasMedia: boolean): Promise<{ record: BoardRecord; mediaCount: number }> {
  const record = generateBoardRecord({ elementCount, seed: elementCount, boardId: BOARD_ID, title: BOARD_TITLE, createdAt: Date.now() });
  await fs.promises.mkdir(boardsRoot, { recursive: true });
  const mediaCount = hasMedia ? await withBenchMedia(record.board, path.join(boardsRoot, 'assets')) : 0;
  return { record, mediaCount };
}

function measureLayout(board: Board): { layoutMs: number; layout: BoardLayout } {
  const runCount = board.elements.size >= SINGLE_LAYOUT_RUN_FROM_ELEMENTS ? 1 : LAYOUT_RUNS;
  const runs = Array.from({ length: runCount }, () => {
    const startedAt = performance.now();
    const layout = layoutBoard(board);
    return { layout, elapsedMs: performance.now() - startedAt };
  });
  const lastRun = runs.at(-1);
  if (!lastRun) throw new Error('the layout ran no times');
  return { layoutMs: median(runs.map((run) => run.elapsedMs)), layout: lastRun.layout };
}

function mcpGetReplyBody(board: Board, layout: BoardLayout): Record<string, unknown> {
  if (fitsOnePage(board)) return { ok: true, board, changes: [], readingVersion: board.version, ...boardReading(board, layout.warnings) };
  const index = tileIndexOf(layout, board.version, board);
  const focus = defaultFocusOf(index);
  const summary = { id: board.id, title: board.title, version: board.version, updatedAt: board.updatedAt, connectedSessionIds: [], queuedBySessionId: {} };
  return { ok: true, board: summary, outline: boardOutlineOf(board, index, focus), focus, elements: elementPageOf(board, elementIdsTouching(index, focus), 0).elements, nextCursor: null, changes: [] };
}

function measureMcpChars(board: Board, layout: BoardLayout): number {
  return JSON.stringify(toolResultFromReply({ status: 200, body: mcpGetReplyBody(board, layout) })).length;
}

function viewRequest(socket: WebSocket, view: typeof OPEN_VIEW, knownVersion: number | null): Promise<{ version: number; tileCount: number; replyBytes: number; elapsedMs: number }> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`whiteboard-view got no tiles in ${FIRST_VIEW_TIMEOUT_MS} ms`));
    }, FIRST_VIEW_TIMEOUT_MS);
    function onMessage(data: Buffer | ArrayBuffer | Buffer[]): void {
      const text = Array.isArray(data) ? Buffer.concat(data).toString() : Buffer.from(new Uint8Array(data)).toString();
      if (!text.includes('"whiteboard-tiles"')) return;
      const parsed = TilesReplySchema.safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.boardId !== BOARD_ID) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve({ version: parsed.data.version, tileCount: parsed.data.tiles.length, replyBytes: Buffer.byteLength(text), elapsedMs: performance.now() - startedAt });
    }
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type: 'whiteboard-view', requestId: `bench-view-${startedAt}`, boardId: BOARD_ID, view, lod: 'full', knownVersion }));
  });
}

const ControlReplySchema = z.object({ requestId: z.string(), ok: z.boolean(), error: z.string().nullish() });
const TilesReplySchema = z.object({ type: z.literal('whiteboard-tiles'), boardId: z.string(), version: z.number(), tiles: z.array(z.unknown()) });

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

interface SeededBoard {
  boxIds: string[];
  version: number;
  metrics: WhiteboardMetric[];
}

async function measurePuts(socket: WebSocket, { boxIds, version }: SeededBoard): Promise<WhiteboardMetric[]> {
  const nextRandom = seededRandom(version + boxIds.length);
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
  await page.waitForFunction(() => Number(document.querySelector<HTMLCanvasElement>('.wb-viewport .wb-gl')?.dataset.drawnElements ?? 0) > 0, null, { timeout: OPEN_TIMEOUT_MS, polling: 50 });
  return performance.now() - startedAt;
}

async function boxBodyPoint(page: Page): Promise<{ x: number; y: number } | null> {
  const viewport = await page.locator('.wb-viewport').boundingBox();
  if (!viewport) return null;
  for (let y = viewport.y + BOX_SEARCH_STEP_PX; y < viewport.y + viewport.height - BOX_SEARCH_STEP_PX; y += BOX_SEARCH_STEP_PX) {
    for (let x = viewport.x + BOX_SEARCH_STEP_PX; x < viewport.x + viewport.width - BOX_SEARCH_STEP_PX; x += BOX_SEARCH_STEP_PX) {
      await page.mouse.move(x, y);
      const isBoxBody = await page.locator('.wb-viewport').evaluate((node) => node instanceof HTMLElement && node.style.cursor === 'move');
      if (isBoxBody) return { x, y };
    }
  }
  return null;
}

async function dragOneBox(page: Page, boxCenter: { x: number; y: number }): Promise<void> {
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
    const boxCenter = await boxBodyPoint(page);
    if (!boxCenter) throw new Error('no box body is in view to drag');
    const drag = await sampleFrames(page, 'drag', 'Drag a box', () => dragOneBox(page, boxCenter));
    const pageFacts = await page.evaluate(() => ({
      mediaTextures: Number(document.querySelector<HTMLCanvasElement>('.wb-viewport .wb-gl')?.dataset.mediaTextures ?? 0),
      livePages: document.querySelectorAll('.wb-media-layer iframe').length,
      domNodes: document.querySelectorAll('*').length,
      heapBytes: Number(Reflect.get(Reflect.get(performance, 'memory') ?? {}, 'usedJSHeapSize')) || null,
    }));
    return [
      metricOf('open', 'Open the board, first element drawn', 'ms', openMs),
      ...pan, ...zoom, ...drag,
      metricOf('media-textures', 'Picture textures held after the run', 'count', pageFacts.mediaTextures),
      metricOf('live-pages', 'Live page frames after the run', 'count', pageFacts.livePages),
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

async function seedAndMeasureStore(configPath: string, elementCount: number, options: WhiteboardBenchOptions): Promise<SeededBoard> {
  const boardsRoot = path.join(path.dirname(configPath), WHITEBOARDS_FOLDER_NAME);
  const { record, mediaCount } = await benchBoardRecordOf(elementCount, boardsRoot, options.hasMedia);
  await createBoardStore(boardsRoot).saveMany([record]);
  const storeFilenames = (await fs.promises.readdir(boardsRoot)).filter((filename) => filename.startsWith(BOARD_STORE_FILENAME));
  const storeFileSizes = await Promise.all(storeFilenames.map(async (filename) => (await fs.promises.stat(path.join(boardsRoot, filename))).size));
  const fileBytes = storeFileSizes.reduce((total, size) => total + size, 0);
  const metrics: WhiteboardMetric[] = [
    metricOf('media-count', 'Boxes carrying media', 'count', mediaCount),
    metricOf('file-bytes', 'Stored board size', 'bytes', fileBytes),
  ];
  return { boxIds: boxIdsOf(record.board), version: record.board.version, metrics };
}

async function measureInProcessLayout(elementCount: number, options: WhiteboardBenchOptions): Promise<WhiteboardMetric[]> {
  const scratchDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-whiteboard-layout-'));
  try {
    const { record: { board } } = await benchBoardRecordOf(elementCount, scratchDirectory, options.hasMedia);
    const { layoutMs, layout } = measureLayout(board);
    const metrics = [metricOf('layout', 'Whole-board layout', 'ms', layoutMs)];
    if (options.sections.includes('mcp')) metrics.push(metricOf('mcp-get-chars', 'MCP whiteboard get tool result, text plus structured copy', 'chars', measureMcpChars(board, layout)));
    return metrics;
  } finally {
    removeHarnessTempDirectory(scratchDirectory);
  }
}

async function measureSize(elementCount: number, options: WhiteboardBenchOptions, browser: Browser | null): Promise<WhiteboardMetric[]> {
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-whiteboard-bench-'));
  const restoreEnvironment = snapshotEnvironment();
  const httpServer = http.createServer();
  let backend: ReturnType<typeof createBackend> | undefined;
  let controlSocket: WebSocket | undefined;
  let seeded: SeededBoard | undefined;
  try {
    isolateTranscriptHomes(tempDirectory);
    const { port, configPath } = await prepareIsolatedEnvironment({ tempDirectory, repoRoots: [], recordSessions: false });
    seeded = await seedAndMeasureStore(configPath, elementCount, options);
    const { metrics } = seeded;
    const rssBeforeBoot = process.memoryUsage().rss;
    backend = createBackend(httpServer, { staticDir: 'auto' });
    httpServer.on('request', backend.app);
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', () => resolve());
    });
    controlSocket = await connectControl(port);
    const firstView = await viewRequest(controlSocket, OPEN_VIEW, null);
    if (firstView.tileCount === 0) throw new Error('the seeded board sent no tiles for the open view');
    const pannedView = await viewRequest(controlSocket, PANNED_VIEW, firstView.version);
    metrics.push(
      metricOf('view-first', 'First open view over the control socket, board load and layout included', 'ms', firstView.elapsedMs),
      metricOf('view-pan', 'Panned view over the control socket, warm', 'ms', pannedView.elapsedMs),
      metricOf('view-bytes', 'Open view reply size, head and tiles in view', 'bytes', firstView.replyBytes),
      metricOf('rss-growth', 'Server RSS growth after boot and open', 'mb', megabytes(process.memoryUsage().rss - rssBeforeBoot)),
      ...await measurePuts(controlSocket, seeded),
    );
    if (browser && options.sections.includes('browser')) metrics.push(...await measureBrowser(browser, port));
  } finally {
    controlSocket?.terminate();
    if (backend) await stopBackend(backend, httpServer);
    removeHarnessTempDirectory(tempDirectory);
    restoreEnvironment();
  }
  return [...seeded.metrics, ...await measureInProcessLayout(elementCount, options)];
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
