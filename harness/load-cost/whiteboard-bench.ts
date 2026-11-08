import '../support/disable-telemetry.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import v8 from 'node:v8';
import vm from 'node:vm';
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
import { boardIndexOf } from '../../shared/whiteboard-board-index.ts';
import { createLayoutWorld, layoutOf } from '../../shared/whiteboard-layout-engine.ts';
import type { LayoutWorld } from '../../shared/whiteboard-layout-engine.ts';
import { pointsOfPath } from '../../shared/whiteboard-route-core.ts';
import type { PlacedLayout } from '../../shared/whiteboard-layout-core.ts';
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
const GC_SETTLE_PASSES = 4;
const LOOP_DELAY_RESOLUTION_MS = 10;
const NANOSECONDS_PER_MS = 1e6;
const CHILD_RESULT_PREFIX = 'whiteboard-child-result ';
const STEP_LINE_PREFIX = '[bench-step] ';
const SERVER_OPEN_LINE_PREFIX = '[whiteboard] open ';
const CHILD_TIMEOUT_MS = 1_200_000;
const CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;
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

let previousStepAt = performance.now();

function logStep(step: string): void {
  const now = performance.now();
  const usage = process.memoryUsage();
  console.error(`${STEP_LINE_PREFIX}${step}: +${Math.round(now - previousStepAt)} ms, heap ${Math.round(megabytes(usage.heapUsed))} MB, buffers ${Math.round(megabytes(usage.arrayBuffers))} MB, rss ${Math.round(megabytes(usage.rss))} MB`);
  previousStepAt = now;
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

function measureLayout(board: Board): { layoutMs: number; layout: PlacedLayout; world: LayoutWorld } {
  const runCount = board.elements.size >= SINGLE_LAYOUT_RUN_FROM_ELEMENTS ? 1 : LAYOUT_RUNS;
  const elapsedMsPerRun: number[] = [];
  let laidOut: { layout: PlacedLayout; world: LayoutWorld } | null = null;
  for (let run = 0; run < runCount; run += 1) {
    const startedAt = performance.now();
    const world = createLayoutWorld(board);
    laidOut = { layout: layoutOf(world), world };
    elapsedMsPerRun.push(performance.now() - startedAt);
  }
  if (!laidOut) throw new Error('the layout ran no times');
  return { layoutMs: median(elapsedMsPerRun), ...laidOut };
}

const RouteQualitySchema = z.object({
  wires: z.number(),
  unrouted: z.number(),
  overlaps: z.number(),
  crossings: z.number(),
  runsThrough: z.number(),
  bendsPerWire: z.number(),
  labelsWithoutSpot: z.number(),
});

type RouteQuality = z.infer<typeof RouteQualitySchema>;

const ROUTE_WARNING_KINDS = [
  { key: 'unrouted', pattern: / found no clear route/ },
  { key: 'overlaps', pattern: / overlaps wire / },
  { key: 'crossings', pattern: / crosses wire / },
  { key: 'runsThrough', pattern: / runs through / },
  { key: 'labelsWithoutSpot', pattern: / has no clear spot$/ },
] as const;

function routeQualityOf(world: LayoutWorld, layout: PlacedLayout): RouteQuality {
  const countByKind = { unrouted: 0, overlaps: 0, crossings: 0, runsThrough: 0, labelsWithoutSpot: 0 };
  for (const text of world.routeWarnings.idsByText.keys()) {
    const kind = ROUTE_WARNING_KINDS.find((candidate) => candidate.pattern.test(text));
    if (kind) countByKind[kind.key] += 1;
  }
  let wireCount = 0;
  let bendCount = 0;
  for (const element of layout.elements) {
    if (element.kind !== 'wire') continue;
    wireCount += 1;
    bendCount += Math.max(0, pointsOfPath(element.path).length - 2);
  }
  return { wires: wireCount, ...countByKind, bendsPerWire: wireCount === 0 ? 0 : Math.round((bendCount / wireCount) * 100) / 100 };
}

function routeQualityMetrics(quality: RouteQuality): WhiteboardMetric[] {
  return [
    metricOf('route-wires', 'Wires laid out', 'count', quality.wires),
    metricOf('route-unrouted', 'Wires with no clear route', 'count', quality.unrouted),
    metricOf('route-overlaps', 'Wire pairs overlapping on a shared line', 'count', quality.overlaps),
    metricOf('route-crossings', 'Wire pairs crossing', 'count', quality.crossings),
    metricOf('route-runs-through', 'Wires running through a box or note', 'count', quality.runsThrough),
    metricOf('route-bends-per-wire', 'Mean bends per wire', 'count', quality.bendsPerWire),
    metricOf('route-labels-without-spot', 'Wire labels with no clear spot', 'count', quality.labelsWithoutSpot),
  ];
}

function mcpGetReplyBody(board: Board, layout: PlacedLayout): Record<string, unknown> {
  if (fitsOnePage(board)) return { ok: true, board, changes: [], readingVersion: board.version, ...boardReading(board, layout.warnings) };
  const index = tileIndexOf(layout, board.version, board);
  const focus = defaultFocusOf(index);
  const summary = { id: board.id, title: board.title, version: board.version, updatedAt: board.updatedAt, connectedSessionIds: [], queuedBySessionId: {} };
  return { ok: true, board: summary, outline: boardOutlineOf(board, index, focus), focus, elements: elementPageOf(board, elementIdsTouching(index, focus), 0).elements, nextCursor: null, changes: [] };
}

function measureMcpChars(board: Board, layout: PlacedLayout): number {
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
    logStep(`puts: ${PUT_ROUNDS} puts of ${batchSize} op(s)`);
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
    logStep('browser: board drawn');
    await sleep(500);
    const pan = await sampleFrames(page, 'pan', 'Pan', () => wheelEveryFrame(page, PAN_FRAMES, { deltaX: 14, deltaY: 9, ctrlKey: false }));
    logStep('browser: pan sampled');
    const zoom = await sampleFrames(page, 'zoom', 'Zoom sweep', async () => {
      await wheelEveryFrame(page, ZOOM_FRAMES, { deltaX: 0, deltaY: 1, ctrlKey: true });
      await wheelEveryFrame(page, ZOOM_FRAMES, { deltaX: 0, deltaY: -1, ctrlKey: true });
    });
    logStep('browser: zoom sampled');
    const boxCenter = await boxBodyPoint(page);
    if (!boxCenter) throw new Error('no box body is in view to drag');
    const drag = await sampleFrames(page, 'drag', 'Drag a box', () => dragOneBox(page, boxCenter));
    logStep('browser: drag sampled');
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
  logStep('seed: board generated');
  await createBoardStore(boardsRoot).saveMany([record]);
  logStep('seed: store saved');
  const storeFilenames = (await fs.promises.readdir(boardsRoot)).filter((filename) => filename.startsWith(BOARD_STORE_FILENAME));
  const storeFileSizes = await Promise.all(storeFilenames.map(async (filename) => (await fs.promises.stat(path.join(boardsRoot, filename))).size));
  const fileBytes = storeFileSizes.reduce((total, size) => total + size, 0);
  const metrics: WhiteboardMetric[] = [
    metricOf('media-count', 'Boxes carrying media', 'count', mediaCount),
    metricOf('file-bytes', 'Stored board size', 'bytes', fileBytes),
  ];
  return { boxIds: boxIdsOf(record.board), version: record.board.version, metrics };
}

async function layoutAndMcpSizeOf(elementCount: number, hasMedia: boolean, wantsMcp: boolean): Promise<{ layoutMs: number; mcpChars: number | null; routeQuality: RouteQuality }> {
  const scratchDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-whiteboard-layout-'));
  try {
    const { record: { board } } = await benchBoardRecordOf(elementCount, scratchDirectory, hasMedia);
    logStep('layout: board generated');
    const { layoutMs, layout, world } = measureLayout(board);
    logStep('layout: board laid out');
    const routeQuality = routeQualityOf(board.elements.size >= world.minIncrementalElements ? world : createLayoutWorld(board, null, 0), layout);
    logStep(`layout: route quality counted ${JSON.stringify(routeQuality)}`);
    const mcpChars = wantsMcp ? measureMcpChars(board, layout) : null;
    logStep('layout: MCP reply sized');
    return { layoutMs, mcpChars, routeQuality };
  } finally {
    removeHarnessTempDirectory(scratchDirectory);
  }
}

const LayoutLineSchema = z.object({ layoutMs: z.number(), mcpChars: z.number().nullable(), routeQuality: RouteQualitySchema });

function elementCountAfter(argv: string[], flag: string): number {
  const elementCount = Number(argv[argv.indexOf(flag) + 1]);
  if (!Number.isInteger(elementCount) || elementCount <= 0) throw new Error(`${flag} needs a positive element count`);
  return elementCount;
}

async function runWhiteboardLayout(argv: string[]): Promise<number> {
  return printChildResult(await layoutAndMcpSizeOf(elementCountAfter(argv, '--whiteboard-layout'), argv.includes('--media'), argv.includes('--mcp')));
}

async function measureInProcessLayout(harnessPath: string, elementCount: number, options: WhiteboardBenchOptions): Promise<WhiteboardMetric[]> {
  const wantsMcp = options.sections.includes('mcp');
  const childArguments = ['--whiteboard-layout', String(elementCount), ...(options.hasMedia ? ['--media'] : []), ...(wantsMcp ? ['--mcp'] : [])];
  const measured = await childResultOf(harnessPath, childArguments, LayoutLineSchema);
  const metrics = [metricOf('layout', 'Whole-board layout', 'ms', measured.layoutMs), ...routeQualityMetrics(measured.routeQuality)];
  if (measured.mcpChars !== null) metrics.push(metricOf('mcp-get-chars', 'MCP whiteboard get tool result, text plus structured copy', 'chars', measured.mcpChars));
  return metrics;
}

function collectGarbage(): () => void {
  v8.setFlagsFromString('--expose-gc');
  const gc: unknown = vm.runInNewContext('gc');
  if (typeof gc !== 'function') throw new Error('the bench could not reach the garbage collector');
  return () => { gc(); };
}

async function retainedBytes(runGc: () => void): Promise<number> {
  for (let pass = 0; pass < GC_SETTLE_PASSES; pass += 1) {
    runGc();
    await sleep(20);
  }
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

async function retainedBytesPerElement(elementCount: number): Promise<{ mainBytes: number; workerBytes: number }> {
  const runGc = collectGarbage();
  const boardOf = () => generateBoardRecord({ boardId: BOARD_ID, title: BOARD_TITLE, elementCount, seed: elementCount, createdAt: 0 }).board;
  boardOf();
  const atStart = await retainedBytes(runGc);
  logStep('retained: warmed up');
  const board = boardOf();
  boardIndexOf(board.elements);
  const withBoard = await retainedBytes(runGc);
  logStep('retained: board and index built');
  const world = createLayoutWorld(board);
  logStep('retained: layout world built');
  const tiles = tileIndexOf(layoutOf(world), board.version, board);
  const withLayout = await retainedBytes(runGc);
  logStep('retained: tiles built');
  if (tiles.painted.length === 0 || world.version !== board.version) throw new Error('the retained-memory board was not laid out');
  return { mainBytes: Math.round((withBoard - atStart) / elementCount), workerBytes: Math.round((withLayout - atStart) / elementCount) };
}

function printChildResult(childResult: unknown): number {
  console.log(`${CHILD_RESULT_PREFIX}${JSON.stringify(childResult)}`);
  return 0;
}

function relayChildSteps(output: string): void {
  for (const line of output.split('\n')) {
    if (line.startsWith(STEP_LINE_PREFIX) || line.startsWith(SERVER_OPEN_LINE_PREFIX)) console.error(line);
  }
}

function stderrOf(error: unknown): string {
  return error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
}

function stdoutOf(error: unknown): string {
  return error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '';
}

async function childResultOf<Shape extends z.ZodType>(harnessPath: string, childArguments: string[], schema: Shape): Promise<z.infer<Shape>> {
  const { stdout, stderr } = await runCommand(process.execPath, [harnessPath, ...childArguments], { timeout: CHILD_TIMEOUT_MS, maxBuffer: CHILD_OUTPUT_BYTES }).catch((error: unknown) => {
    relayChildSteps(stdoutOf(error));
    relayChildSteps(stderrOf(error));
    throw error;
  });
  relayChildSteps(stdout);
  relayChildSteps(stderr);
  logStep(`${childArguments[0]} child process done`);
  const line = stdout.split('\n').find((text) => text.startsWith(CHILD_RESULT_PREFIX));
  if (!line) throw new Error(`the ${childArguments[0]} process printed no result`);
  return schema.parse(JSON.parse(line.slice(CHILD_RESULT_PREFIX.length)));
}

const RetainedLineSchema = z.object({ mainBytes: z.number(), workerBytes: z.number() });

async function runWhiteboardRetained(argv: string[]): Promise<number> {
  return printChildResult(await retainedBytesPerElement(elementCountAfter(argv, '--whiteboard-retained')));
}

async function measureRetainedPerThread(harnessPath: string, elementCount: number): Promise<WhiteboardMetric[]> {
  const retained = await childResultOf(harnessPath, ['--whiteboard-retained', String(elementCount)], RetainedLineSchema);
  return [
    metricOf('heap-main', 'Main thread heap and buffers per element, board and index, after a forced GC', 'bytes', retained.mainBytes),
    metricOf('heap-worker', 'Layout worker heap and buffers per element, board, index, layout and tiles, after a forced GC', 'bytes', retained.workerBytes),
  ];
}

interface RunningBackend {
  backend: ReturnType<typeof createBackend>;
  httpServer: http.Server;
}

async function bootBackend(port: number): Promise<RunningBackend> {
  const httpServer = http.createServer();
  const backend = createBackend(httpServer, { staticDir: 'auto' });
  httpServer.on('request', backend.app);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });
  return { backend, httpServer };
}

interface OpenedView {
  view: Awaited<ReturnType<typeof viewRequest>>;
  longestStallMs: number;
}

async function openWatchingTheLoop(port: number, boot: (port: number) => Promise<RunningBackend>, stepPrefix: string): Promise<{ running: RunningBackend; socket: WebSocket; opened: OpenedView }> {
  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
  loopDelay.enable();
  logStep(`${stepPrefix}: starting`);
  const running = await boot(port);
  logStep(`${stepPrefix}: server booted`);
  const socket = await connectControl(port);
  logStep(`${stepPrefix}: control socket connected`);
  const view = await viewRequest(socket, OPEN_VIEW, null);
  logStep(`${stepPrefix}: open view answered`);
  loopDelay.disable();
  if (view.tileCount === 0) throw new Error('the seeded board sent no tiles for the open view');
  return { running, socket, opened: { view, longestStallMs: Math.max(0, loopDelay.max / NANOSECONDS_PER_MS - LOOP_DELAY_RESOLUTION_MS) } };
}

const ReopenLineSchema = z.object({ elapsedMs: z.number(), longestStallMs: z.number() });

async function runWhiteboardReopen(): Promise<number> {
  const port = Number(process.env.GLIMMERVOID_PORT);
  const { running, socket, opened } = await openWatchingTheLoop(port, bootBackend, 'reopen');
  socket.terminate();
  await stopBackend(running.backend, running.httpServer);
  logStep('reopen: server stopped');
  return printChildResult({ elapsedMs: opened.view.elapsedMs, longestStallMs: opened.longestStallMs });
}

async function measureReopen(harnessPath: string): Promise<WhiteboardMetric[]> {
  const reopened = await childResultOf(harnessPath, ['--whiteboard-reopen'], ReopenLineSchema);
  return [
    metricOf('view-reopen', 'First open view after a server restart in a fresh process, saved layout included', 'ms', reopened.elapsedMs),
    metricOf('stall-reopen', 'Longest event loop stall while the restarted server opens the board', 'ms', reopened.longestStallMs),
  ];
}

async function measureSize(elementCount: number, options: WhiteboardBenchOptions, browser: Browser | null, harnessPath: string): Promise<WhiteboardMetric[]> {
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-whiteboard-bench-'));
  const restoreEnvironment = snapshotEnvironment();
  let running: RunningBackend | null = null;
  let controlSocket: WebSocket | undefined;
  let seeded: SeededBoard | undefined;
  try {
    isolateTranscriptHomes(tempDirectory);
    const { port, configPath } = await prepareIsolatedEnvironment({ tempDirectory, repoRoots: [], recordSessions: false });
    seeded = await seedAndMeasureStore(configPath, elementCount, options);
    const { metrics } = seeded;
    const rssBeforeBoot = process.memoryUsage().rss;
    const firstOpen = await openWatchingTheLoop(port, bootBackend, 'first open');
    running = firstOpen.running;
    controlSocket = firstOpen.socket;
    const firstView = firstOpen.opened.view;
    const pannedView = await viewRequest(controlSocket, PANNED_VIEW, firstView.version);
    logStep('first open: panned view answered');
    metrics.push(
      metricOf('view-first', 'First open view over the control socket, board load and layout included', 'ms', firstView.elapsedMs),
      metricOf('stall-first', 'Longest event loop stall while the server first opens the board', 'ms', firstOpen.opened.longestStallMs),
      metricOf('view-pan', 'Panned view over the control socket, warm', 'ms', pannedView.elapsedMs),
      metricOf('view-bytes', 'Open view reply size, head and tiles in view', 'bytes', firstView.replyBytes),
      metricOf('rss-growth', 'Server RSS growth after boot and open', 'mb', megabytes(process.memoryUsage().rss - rssBeforeBoot)),
      ...await measurePuts(controlSocket, seeded),
    );
    if (browser && options.sections.includes('browser')) metrics.push(...await measureBrowser(browser, port));
    controlSocket.terminate();
    await stopBackend(running.backend, running.httpServer);
    running = null;
    logStep('first open: server stopped');
    metrics.push(...await measureReopen(harnessPath));
  } finally {
    controlSocket?.terminate();
    if (running) await stopBackend(running.backend, running.httpServer);
    removeHarnessTempDirectory(tempDirectory);
    restoreEnvironment();
  }
  return [...seeded.metrics, ...await measureInProcessLayout(harnessPath, elementCount, options), ...await measureRetainedPerThread(harnessPath, elementCount)];
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
      sizes.push({ elementCount, metrics: await measureSize(elementCount, options, browser, path.join(environment.repoRoot, 'harness', 'load-cost', 'harness.ts')) });
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

export { runWhiteboardBench, runWhiteboardLayout, runWhiteboardReopen, runWhiteboardRetained };
