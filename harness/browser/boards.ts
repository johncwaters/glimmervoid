import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright-core';
import { z } from 'zod';
import type { Layout } from './cases-core.ts';
import { git } from '../site-capture/isolated-glimmervoid.ts';
import { commitFile, findSessionWorktree, pollFor, readOriginFile } from './review-merge.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync } from '../../server/child-process-safe.ts';
import { resolveFfmpegPath } from '../../server/runtime-paths.ts';
import { Board, BoardReview, WHITEBOARD_ASSET_ROUTE, boardMediaDrawnFilename } from '../../shared/contracts/whiteboard.ts';
import { layoutBoard } from '../../shared/whiteboard-layout-core.ts';

const UNCOVERED_FILE_NAME = 'board-uncovered.txt';
const MERGE_SETTLE_MS = 1500;
const WORKTREE_TIMEOUT_MS = 15000;
const REVIEW_TIMEOUT_MS = 20000;
const RESIZE_TIMEOUT_MS = 5000;
const BOARD_TIMEOUT_MS = 5000;

interface OpenBoard {
  page: Page;
  panel: Locator;
  boardId: string;
}

interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type BoardElement = Board['elements'][string];

const BoardReply = z.object({ board: Board });
const ReviewReply = z.object({ review: BoardReview });
const CreatedReply = z.object({ summary: z.object({ id: z.string() }) });
const CAMERA_TRANSFORM_PATTERN = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/;

function titled(title: string): (element: BoardElement) => boolean {
  return (element) => 'title' in element && element.title === title;
}

async function boardOf(open: OpenBoard): Promise<Board> {
  return BoardReply.parse(await controlReplyOf(open.page, 'whiteboard-get', { boardId: open.boardId })).board;
}

async function reviewOf(open: OpenBoard): Promise<BoardReview> {
  return ReviewReply.parse(await controlReplyOf(open.page, 'whiteboard-review', { boardId: open.boardId })).review;
}

async function shownBoardOf(open: OpenBoard): Promise<Board> {
  const board = await boardOf(open);
  await open.panel.locator('.wb-board-meta', { hasText: `v${board.version}` }).waitFor();
  return board;
}

async function elementWhere(open: OpenBoard, label: string, isMatch: (element: BoardElement) => boolean): Promise<BoardElement> {
  const found = await pollFor(label, BOARD_TIMEOUT_MS, async () => Object.values((await boardOf(open)).elements).find(isMatch) ?? null);
  await shownBoardOf(open);
  return found;
}

async function boardWithout(open: OpenBoard, label: string, isMatch: (element: BoardElement) => boolean): Promise<void> {
  await pollFor(label, BOARD_TIMEOUT_MS, async () => (Object.values((await boardOf(open)).elements).some(isMatch) ? null : true));
  await shownBoardOf(open);
}

async function laidOutOf(open: OpenBoard, elementId: string) {
  const laidOut = layoutBoard(await shownBoardOf(open)).elements.find((element) => element.id === elementId);
  assert.ok(laidOut, `the board lays out ${elementId}`);
  return laidOut;
}

async function wirePathOf(open: OpenBoard, wireId: string): Promise<string> {
  const laidOut = await laidOutOf(open, wireId);
  assert.ok(laidOut.kind === 'wire');
  return laidOut.path;
}

async function screenRectOf(open: OpenBoard, elementId: string): Promise<ScreenRect> {
  const laidOut = await laidOutOf(open, elementId);
  assert.ok(laidOut.kind !== 'wire', `${elementId} is drawn as a rect`);
  const placement = await open.panel.locator('.wb-viewport').evaluate((viewport) => {
    const viewportRect = viewport.getBoundingClientRect();
    const world = viewport.querySelector('.wb-world');
    return { left: viewportRect.left + viewport.clientLeft, top: viewportRect.top + viewport.clientTop, transform: world instanceof HTMLElement ? world.style.transform : '' };
  });
  const camera = CAMERA_TRANSFORM_PATTERN.exec(placement.transform);
  assert.ok(camera, `the board camera is readable from ${placement.transform}`);
  const [translateX, translateY, scale] = [Number(camera[1]), Number(camera[2]), Number(camera[3])];
  return { x: placement.left + translateX + laidOut.x * scale, y: placement.top + translateY + laidOut.y * scale, width: laidOut.width * scale, height: laidOut.height * scale };
}

function centerOf(rect: ScreenRect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function clickElement(open: OpenBoard, elementId: string): Promise<void> {
  const center = centerOf(await screenRectOf(open, elementId));
  await open.page.mouse.click(center.x, center.y);
}

async function cursorAt(open: OpenBoard, point: { x: number; y: number }): Promise<string> {
  await open.page.mouse.move(point.x, point.y);
  return open.panel.locator('.wb-viewport').evaluate((viewport) => (viewport instanceof HTMLElement ? viewport.style.cursor : ''));
}

async function addPlanStep(panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: 'more', exact: true }).click();
  await panel.page().getByRole('menuitem', { name: 'plan step', exact: true }).click();
}

async function placeBoxWithTool(open: OpenBoard, offset: { x: number; y: number }, title: string): Promise<BoardElement> {
  const canvasBox = await open.panel.locator('.wb-canvas').boundingBox();
  assert.ok(canvasBox);
  await open.page.mouse.click(canvasBox.x + offset.x, canvasBox.y + offset.y);
  const titleInput = open.page.getByRole('textbox', { name: 'Box title', exact: true });
  await titleInput.fill(title);
  await open.page.keyboard.press('Enter');
  return elementWhere(open, `a box titled ${title}`, titled(title));
}

async function verifyResizedBox(open: OpenBoard, boxId: string): Promise<void> {
  const widthOf = async () => {
    const laidOut = await laidOutOf(open, boxId);
    return laidOut.kind === 'wire' ? 0 : laidOut.width;
  };
  const widthBefore = await widthOf();
  const rect = await screenRectOf(open, boxId);
  await open.page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  const handle = { x: rect.x + rect.width - 4, y: rect.y + rect.height - 4 };
  assert.equal(await cursorAt(open, handle), 'ew-resize', 'the bottom right corner of a hovered box is its resize handle');
  await open.page.mouse.down();
  await open.page.mouse.move(handle.x + 120, handle.y, { steps: 6 });
  await open.page.mouse.up();
  await pollFor('dragging the corner handle widens the box', RESIZE_TIMEOUT_MS, async () => ((await widthOf()) > widthBefore ? true : null));
  await open.panel.getByRole('button', { name: 'undo', exact: true }).click();
  await pollFor('undo puts the box back to its width', RESIZE_TIMEOUT_MS, async () => ((await widthOf()) === widthBefore ? true : null));
}

function drawnMediaUrlOf(element: BoardElement): string {
  assert.ok(element.kind === 'box' && element.media, `${element.id} carries media`);
  const drawnFilename = boardMediaDrawnFilename(element.media);
  assert.ok(drawnFilename, `${element.id} has a drawn picture`);
  return `${WHITEBOARD_ASSET_ROUTE}/${drawnFilename}`;
}

async function verifyDroppedPicture(open: OpenBoard): Promise<void> {
  const { page, panel } = open;
  await panel.locator('.wb-canvas').evaluate(async (canvas) => {
    const painted = document.createElement('canvas');
    painted.width = 2400;
    painted.height = 1200;
    const pen = painted.getContext('2d');
    if (pen) pen.fillStyle = '#c084fc';
    pen?.fillRect(0, 0, 2400, 1200);
    const pngBlob = await new Promise<Blob | null>((resolve) => painted.toBlob(resolve, 'image/png'));
    if (!pngBlob) throw new Error('the browser painted no png');
    const transfer = new DataTransfer();
    transfer.items.add(new File([pngBlob], 'dropped-shot.png', { type: 'image/png' }));
    const canvasRect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: canvasRect.left + 420, clientY: canvasRect.top + 80 }));
  });
  const picture = await elementWhere(open, 'the dropped picture box', titled('dropped-shot'));
  const drawnUrl = drawnMediaUrlOf(picture);
  assert.match(drawnUrl, /\/[0-9a-f]{64}\.preview\.webp$/, 'a dropped png wider than 1024 draws from its preview');
  const served = await page.evaluate(async (url) => {
    const status = (await fetch(url)).status;
    const preview = new Image();
    preview.src = url;
    await preview.decode();
    return { status, width: preview.naturalWidth };
  }, drawnUrl);
  assert.deepEqual(served, { status: 200, width: 1024 }, 'a dropped picture draws from the served, capped preview');
  const pictureRect = await screenRectOf(open, picture.id);
  const pictureCenter = centerOf(pictureRect);
  assert.equal(await cursorAt(open, pictureCenter), 'zoom-in', 'a picture shows the zoom-in cursor');
  await page.mouse.click(pictureCenter.x, pictureCenter.y);
  const viewer = page.locator('.wb-image-viewer');
  const enlarged = viewer.locator('img.wb-image-viewer-picture');
  await enlarged.waitFor();
  const naturalWidth = await enlarged.evaluate(async (node) => (node instanceof HTMLImageElement ? node.decode().then(() => node.naturalWidth) : 0));
  assert.equal(naturalWidth, 2400, 'a clicked picture opens the original at its own size');
  assert.ok(await enlarged.evaluate((node) => node instanceof HTMLImageElement && node.src.endsWith('.png')), 'a clicked picture opens the original png');
  assert.ok(await enlarged.evaluate((node) => node.getBoundingClientRect().width > window.innerWidth * 0.8), 'the viewer scales a picture up to fill the screen');
  const viewerClose = viewer.locator('.wb-image-viewer-header').getByRole('button', { name: 'Close', exact: true });
  const closeBounds = await viewerClose.boundingBox();
  const enlargedBounds = await enlarged.boundingBox();
  assert.ok(closeBounds && enlargedBounds && closeBounds.y + closeBounds.height <= enlargedBounds.y, 'the viewer puts Close in its header above the picture');
  assert.equal(await viewer.locator('.dialog-actions').count(), 0, 'the viewer has no bottom actions row');
  await viewerClose.click();
  await viewer.waitFor({ state: 'detached' });
  await verifyGesturesOverMedia(open, picture.id);
  await panel.getByRole('button', { name: 'undo', exact: true }).click();
  await panel.getByRole('button', { name: 'undo', exact: true }).click();
  await boardWithout(open, 'undo removes the dropped picture', titled('dropped-shot'));
}

const PROBE_PAGE_HTML = `<!doctype html><html><body><input aria-label="probe field"><script>
const readings = {};
try { readings.dom = String(parent.document.body.childElementCount); } catch { readings.dom = 'blocked'; }
try { readings.storage = String(localStorage.length); } catch { readings.storage = 'blocked'; }
try { readings.cookie = document.cookie; } catch { readings.cookie = 'blocked'; }
parent.postMessage({ boardPageProbe: readings }, '*');
</script></body></html>`;

async function webmClipBase64(): Promise<string> {
  const ffmpegPath = resolveFfmpegPath();
  assert.ok(ffmpegPath, 'ffmpeg-static is installed');
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-clip-'));
  const clipPath = path.join(workDirectory, 'clip.webm');
  await execFileAsync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libvpx', '-c:a', 'libvorbis', '-shortest', '-y', clipPath]);
  const clipBase64 = fs.readFileSync(clipPath).toString('base64');
  fs.rmSync(workDirectory, { recursive: true, force: true });
  return clipBase64;
}

async function dropFileOnCanvas(panel: Locator, file: { name: string; type: string; base64: string }, offset: { x: number; y: number }): Promise<void> {
  await panel.locator('.wb-canvas').evaluate((canvas, { name, type, base64, offsetX, offsetY }) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type }));
    const canvasRect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: canvasRect.left + offsetX, clientY: canvasRect.top + offsetY }));
  }, { ...file, offsetX: offset.x, offsetY: offset.y });
}

async function panTowardTopOfCanvas(panel: Locator, target: Locator): Promise<void> {
  const page = panel.page();
  const canvasBounds = await panel.locator('.wb-canvas').boundingBox();
  const targetBounds = await target.boundingBox();
  assert.ok(canvasBounds && targetBounds);
  await page.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height - 20);
  await page.mouse.wheel(targetBounds.x - (canvasBounds.x + canvasBounds.width / 3), targetBounds.y - (canvasBounds.y + 60));
}

async function verifyBoxAbovePageCoversIt(open: OpenBoard, pageMedia: Locator): Promise<void> {
  const { page, panel } = open;
  const pageMaskOf = () => pageMedia.evaluate((node) => getComputedStyle(node).maskImage || getComputedStyle(node).getPropertyValue('-webkit-mask-image'));
  assert.equal(await pageMaskOf(), 'none', 'a page box with nothing drawn above it is shown whole');
  const canvasBounds = await panel.locator('.wb-canvas').boundingBox();
  const pageBounds = await pageMedia.boundingBox();
  assert.ok(canvasBounds && pageBounds);
  await panel.locator('.wb-viewport').focus();
  await page.keyboard.press('r');
  const boxAbove = await placeBoxWithTool(open, { x: pageBounds.x - canvasBounds.x + pageBounds.width * 0.7, y: pageBounds.y - canvasBounds.y + pageBounds.height * 0.6 }, 'Above the page');
  await page.waitForFunction(() => /data:image\/svg\+xml/.test(getComputedStyle(document.querySelector('.wb-media[data-media-kind="page"]') ?? document.body).maskImage));
  while ((await boardOf(open)).elements[boxAbove.id]) {
    const versionBeforeUndo = (await boardOf(open)).version;
    await panel.getByRole('button', { name: 'undo', exact: true }).click();
    await pollFor('undo takes back one edit', BOARD_TIMEOUT_MS, async () => ((await boardOf(open)).version !== versionBeforeUndo ? true : null));
  }
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.wb-media[data-media-kind="page"]') ?? document.body).maskImage === 'none');
}

async function verifyLiveMedia(open: OpenBoard): Promise<void> {
  const { page, panel } = open;
  await page.evaluate(() => {
    window.addEventListener('message', (event) => {
      const readings: unknown = event.data?.boardPageProbe;
      if (readings && typeof readings === 'object') document.documentElement.dataset.boardPageProbe = JSON.stringify(readings);
    });
  });
  await dropFileOnCanvas(panel, { name: 'clip.webm', type: 'video/webm', base64: await webmClipBase64() }, { x: 420, y: 80 });
  const isClip = (element: BoardElement) => element.kind === 'box' && element.media?.kind === 'video' && element.media.alt === 'clip.webm';
  const clip = await elementWhere(open, 'the dropped video box', isClip);
  assert.equal(await panel.locator('.wb-media[data-media-kind="video"], video').count(), 0, 'a video box draws only its first frame on the board');
  const posterBounds = await screenRectOf(open, clip.id);
  await page.mouse.click(posterBounds.x + posterBounds.width / 3, posterBounds.y + posterBounds.height / 3);
  const viewer = page.locator('.wb-image-viewer');
  const viewerVideo = viewer.locator('video.wb-image-viewer-video');
  await viewerVideo.waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('video.wb-image-viewer-video');
    return Boolean(video && !video.paused && video.currentTime > 0);
  });
  assert.deepEqual(await viewerVideo.evaluate((video) => video instanceof HTMLVideoElement && [video.controls, video.muted]), [true, false], 'a click on a video box plays it full size with controls and sound');
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });
  const worldTransform = () => panel.locator('.wb-world').evaluate((world) => world instanceof HTMLElement ? world.style.transform : '');
  const transformBeforePan = await worldTransform();
  const videoBounds = await screenRectOf(open, clip.id);
  await page.mouse.move(videoBounds.x + 10, videoBounds.y + 10);
  await page.mouse.wheel(0, 40);
  assert.notEqual(await worldTransform(), transformBeforePan, 'a wheel over a video box pans the board');

  await dropFileOnCanvas(panel, { name: 'probe.html', type: 'text/html', base64: Buffer.from(PROBE_PAGE_HTML).toString('base64') }, { x: 420, y: 300 });
  const pageMedia = panel.locator('.wb-media[data-media-kind="page"]');
  await pageMedia.waitFor();
  await panTowardTopOfCanvas(panel, pageMedia);
  const pageFrame = pageMedia.locator('iframe.wb-media-page');
  assert.equal(await pageFrame.getAttribute('sandbox'), 'allow-scripts allow-forms', 'a page box renders in a sandbox without same-origin');
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.boardPageProbe));
  assert.deepEqual(JSON.parse(await page.evaluate(() => document.documentElement.dataset.boardPageProbe ?? '{}')), { dom: 'blocked', storage: 'blocked', cookie: 'blocked' }, 'a page box cannot read the dashboard DOM, storage or cookies');
  assert.equal(await pageFrame.evaluate((frame) => getComputedStyle(frame).pointerEvents), 'none', 'an idle page ignores the pointer');
  const idlePageBounds = await pageMedia.boundingBox();
  assert.ok(idlePageBounds);
  const cursorOverPage = await cursorAt(open, { x: idlePageBounds.x + idlePageBounds.width / 2, y: idlePageBounds.y + idlePageBounds.height / 2 });
  assert.equal(cursorOverPage, 'zoom-in', 'a page box shows the zoom-in cursor like a picture');
  await page.mouse.click(idlePageBounds.x + idlePageBounds.width / 2, idlePageBounds.y + idlePageBounds.height / 2);
  const viewerPage = viewer.locator('iframe.wb-image-viewer-page');
  await viewerPage.waitFor();
  assert.equal(await viewerPage.getAttribute('sandbox'), 'allow-scripts allow-forms', 'a click on a page box opens it full size in the same sandbox');
  assert.notEqual(await viewerPage.evaluate((frame) => getComputedStyle(frame).pointerEvents), 'none', 'the full size page takes the pointer');
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });
  assert.equal(await panel.locator('.wb-media button').count(), 0, 'a page box carries no overlay buttons');
  await verifyBoxAbovePageCoversIt(open, pageMedia);
  await pageFrame.evaluate((frame) => {
    frame.dataset.loadedOnce = '';
  });
  const pageBounds = await pageMedia.boundingBox();
  assert.ok(pageBounds);
  await page.mouse.move(pageBounds.x + pageBounds.width / 3, pageBounds.y + pageBounds.height / 3);
  await page.mouse.down();
  await page.mouse.move(pageBounds.x + pageBounds.width / 3 + 40, pageBounds.y + pageBounds.height / 3 + 20, { steps: 8 });
  await page.mouse.up();
  const movedBounds = await pageMedia.boundingBox();
  assert.ok(movedBounds);
  assert.ok(movedBounds.x - pageBounds.x > 10, `dragging a page box moves it, moved ${movedBounds.x - pageBounds.x}px`);
  assert.equal(await pageFrame.getAttribute('data-loaded-once'), '', 'moving a page box keeps its loaded page instead of reloading it');
  await panel.getByRole('button', { name: 'undo', exact: true }).click();
  await panel.getByRole('button', { name: 'undo', exact: true }).click();
  await pageMedia.waitFor({ state: 'detached' });
  await panel.getByRole('button', { name: 'undo', exact: true }).click();
  await boardWithout(open, 'undo removes the dropped video', isClip);
  await panel.getByRole('button', { name: 'fit', exact: true }).click();
}

async function verifyGesturesOverMedia(open: OpenBoard, pictureId: string): Promise<void> {
  const { page, panel } = open;
  const resting = await screenRectOf(open, pictureId);
  const anchor = { x: resting.x + resting.width / 4, y: resting.y + resting.height / 2 };
  await page.mouse.move(anchor.x, anchor.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  const zoomed = await screenRectOf(open, pictureId);
  assert.ok(Math.abs(zoomed.width / resting.width - 1.1) < 0.01, 'a ctrl wheel over a picture zooms the board one step');
  assert.ok(Math.abs(zoomed.x + (anchor.x - resting.x) * 1.1 - anchor.x) < 1.5, 'zooming keeps the point under the pointer still');
  await page.mouse.wheel(0, 60);
  const panned = await screenRectOf(open, pictureId);
  assert.ok(Math.abs(zoomed.y - panned.y - 60) < 1.5, 'a wheel over a picture pans the board');
  const versionBeforeDrag = (await boardOf(open)).version;
  await page.mouse.move(panned.x + panned.width / 2, panned.y + panned.height / 2);
  await page.mouse.down();
  await page.mouse.move(panned.x + panned.width / 2 + 120, panned.y + panned.height / 2, { steps: 6 });
  await page.mouse.up();
  await pollFor('dragging a picture box saves its move', BOARD_TIMEOUT_MS, async () => ((await boardOf(open)).version !== versionBeforeDrag ? true : null));
  const dragged = await screenRectOf(open, pictureId);
  assert.ok(Math.abs(dragged.x - panned.x - 120) < 2, 'dragging a picture box moves it with the pointer');
  assert.equal(await page.locator('.wb-image-viewer').count(), 0, 'dragging a picture does not open the viewer');
  await panel.getByRole('button', { name: 'fit', exact: true }).click();
}

async function renameOpenBoard(page: Page, panel: Locator, currentTitle: string, typedTitle: string, finishKey: 'Enter' | 'Escape'): Promise<void> {
  await panel.locator('.wb-board-title', { hasText: currentTitle }).click();
  await panel.getByRole('textbox', { name: 'Board title', exact: true }).fill(typedTitle);
  await page.keyboard.press(finishKey);
  const expectedTitle = finishKey === 'Enter' ? typedTitle : currentTitle;
  await panel.getByRole('button', { name: expectedTitle, exact: true }).waitFor();
  assert.equal(await panel.getByRole('textbox', { name: 'Board title', exact: true }).count(), 0);
}

async function openBoardMenuItem(page: Page, panel: Locator, itemName: string): Promise<void> {
  await panel.getByRole('button', { name: 'board menu', exact: true }).click();
  await page.getByRole('menuitem', { name: itemName, exact: true }).click();
}

async function createBoardFromView(page: Page, panel: Locator, boardTitle: string): Promise<void> {
  const emptyNewBoard = panel.locator('.wb-empty').getByRole('button', { name: 'new board', exact: true });
  if (await emptyNewBoard.isVisible()) await emptyNewBoard.click();
  if (!(await page.getByRole('textbox', { name: 'Board title', exact: true }).isVisible())) await openBoardMenuItem(page, panel, 'new board');
  await submitTextDialog(page, 'Board title', boardTitle, 'Create board');
  await openBoardTitle(panel, boardTitle).waitFor();
}

function openBoardTitle(panel: Locator, boardTitle: string): Locator {
  return panel.locator('.wb-board-title', { hasText: boardTitle });
}

async function controlReplyOf(page: Page, type: string, payload: Record<string, string>): Promise<unknown> {
  return page.evaluate(async ({ type, payload }) => {
    const tokenReply: unknown = await fetch('/control-token', { credentials: 'same-origin', cache: 'no-store' }).then((response) => response.json());
    const token = typeof tokenReply === 'object' && tokenReply !== null && 'token' in tokenReply && typeof tokenReply.token === 'string' ? tokenReply.token : '';
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/control?token=${encodeURIComponent(token)}`);
    const requestId = `harness-${type}-${Date.now()}-${Math.random()}`;
    return new Promise<unknown>((resolve, reject) => {
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type, requestId, ...payload })));
      socket.addEventListener('error', () => reject(new Error(`${type} could not reach the control socket`)));
      socket.addEventListener('message', (event) => {
        const reply: unknown = JSON.parse(String(event.data));
        if (typeof reply !== 'object' || reply === null || !('requestId' in reply) || reply.requestId !== requestId) return;
        socket.close();
        if ('ok' in reply && reply.ok === true) {
          resolve(reply);
          return;
        }
        reject(new Error(`${type} was refused: ${JSON.stringify(reply)}`));
      });
    });
  }, { type, payload });
}

async function createBoardOverControl(page: Page, boardTitle: string): Promise<string> {
  return CreatedReply.parse(await controlReplyOf(page, 'whiteboard-create', { title: boardTitle })).summary.id;
}

async function showBoardInFocus(page: Page, sessionId: string, boardTitle: string): Promise<Locator> {
  await page.locator(`.focus-rail .session-row[data-id="${sessionId}"] .session-row-glyph`).first().click();
  const boardTab = page.locator('.pane-tab[data-tab="board"]');
  await boardTab.click();
  await page.locator('.pane-tab[data-tab="board"][aria-selected="true"]').waitFor();
  const center = page.locator('#focus-center');
  await openBoardTitle(center, boardTitle).waitFor();
  return center;
}

async function submitTextDialog(page: Page, label: string, value: string, confirmLabel: string): Promise<void> {
  await page.getByRole('textbox', { name: label, exact: true }).fill(value);
  await page.getByRole('button', { name: confirmLabel, exact: true }).click();
}

export async function verifyBoards(page: Page, layout: Layout, sessionId: string): Promise<void> {
  await page.locator('#loading-screen').waitFor({ state: 'hidden' });
  if (layout === 'phone') {
    const navButtonLabels = await page.locator('.phone-nav > .phone-nav-item:not([hidden]) .phone-nav-label').allTextContents();
    assert.deepEqual(navButtonLabels, ['Focus', 'Terminal', 'Boards', 'More']);
    assert.equal(await page.locator('.phone-nav-more-menu [data-screen="boards"]').count(), 0);
    const boardsNavButton = page.locator('.phone-nav > .phone-nav-item[data-screen="boards"]');
    await boardsNavButton.click();
    assert.equal(await boardsNavButton.getAttribute('aria-current'), 'page');
  }
  const boardTitle = `Ingest plan ${layout}`;
  const desktopBoard = layout === 'desktop' ? await openDesktopBoard(page, sessionId, boardTitle) : null;
  const panel = desktopBoard?.panel ?? page.locator('.boards-view');
  await panel.waitFor({ state: 'visible' });
  if (layout === 'phone') await createBoardFromView(page, panel, boardTitle);
  await panel.locator('.wb-viewport').waitFor({ state: 'visible' });
  if (layout === 'phone') {
    await panel.getByRole('button', { name: 'board menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'new board', exact: true }).waitFor();
    assert.equal(await page.getByRole('menuitem', { name: 'board settings', exact: true }).isVisible(), false, 'phone hides the properties panel, so the menu offers no board settings');
    await page.keyboard.press('Escape');
  }
  if (desktopBoard) {
    const open = desktopBoard;
    assert.equal(await panel.locator('.wb-inspect').isVisible(), false, 'no properties panel covers the canvas with nothing selected');
    const canvasBounds = await panel.locator('.wb-canvas').boundingBox();
    const toolsIslandBounds = await panel.getByRole('toolbar', { name: 'Board tools', exact: true }).boundingBox();
    assert.ok(canvasBounds && toolsIslandBounds);
    const titleIslandBounds = await panel.getByRole('toolbar', { name: 'Board', exact: true }).boundingBox();
    const viewIslandBounds = await panel.getByRole('toolbar', { name: 'View', exact: true }).boundingBox();
    assert.ok(titleIslandBounds && viewIslandBounds);
    assert.ok(toolsIslandBounds.y >= canvasBounds.y && viewIslandBounds.y >= canvasBounds.y, 'the view controls and tools sit inside the Board pane, not in the tab strip');
    assert.ok(titleIslandBounds.y + titleIslandBounds.height <= canvasBounds.y, 'the board menu, name and version sit in the Board pane header, above the canvas');
    const renamedTitle = `${boardTitle} renamed`;
    await renameOpenBoard(page, panel, boardTitle, renamedTitle, 'Enter');
    await renameOpenBoard(page, panel, renamedTitle, 'discarded title', 'Escape');
    await renameOpenBoard(page, panel, renamedTitle, boardTitle, 'Enter');
    const boxTool = panel.getByRole('button', { name: 'box', exact: true });
    assert.equal(await boxTool.getAttribute('title'), null, 'a board tool has no native tooltip');
    await boxTool.click();
    assert.equal(await boxTool.getAttribute('aria-pressed'), 'true');
    const toolHint = panel.locator('.wb-tool-hint');
    await toolHint.filter({ hasText: 'Click the board to place a box' }).waitFor();
    const parseFeed = await placeBoxWithTool(open, { x: 60, y: 60 }, 'Parse feed');
    assert.equal(await panel.getByRole('button', { name: 'select', exact: true }).getAttribute('aria-pressed'), 'true', 'the tool returns to select after one placement');
    assert.equal(await toolHint.isVisible(), false, 'the hint line hides once the select tool is back');
    await verifyResizedBox(open, parseFeed.id);
    await verifyDroppedPicture(open);
    await verifyLiveMedia(open);
    await panel.getByRole('button', { name: 'more', exact: true }).click();
    const moreMenu = page.getByRole('menu', { name: 'More tools', exact: true });
    assert.deepEqual(await moreMenu.getByRole('menuitem').allTextContents(), ['note on box', 'frame selected boxes', 'plan step']);
    await page.keyboard.press('Escape');
    assert.equal(await moreMenu.isVisible(), false, 'Escape closes the More menu');
    const isComicMonoLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('700 16px ComicMono');
    });
    assert.equal(isComicMonoLoaded, true);
    const canvasBox = await panel.locator('.wb-canvas').boundingBox();
    const boxOutline = await screenRectOf(open, parseFeed.id);
    assert.ok(canvasBox);
    assert.ok(boxOutline.x >= canvasBox.x && boxOutline.y >= canvasBox.y, 'the box starts inside the canvas');
    assert.ok(boxOutline.x + boxOutline.width <= canvasBox.x + canvasBox.width && boxOutline.y + boxOutline.height <= canvasBox.y + canvasBox.height, 'the box ends inside the canvas');
    const outlineCenter = centerOf(boxOutline);
    await page.mouse.dblclick(outlineCenter.x, outlineCenter.y);
    await page.getByRole('textbox', { name: 'Box title', exact: true }).fill('Parse and store');
    await page.keyboard.press('Enter');
    const sourceBox = await elementWhere(open, 'the renamed box', titled('Parse and store'));
    await panel.locator('.wb-viewport').focus();
    await page.keyboard.press('r');
    const targetBox = await placeBoxWithTool(open, { x: 60, y: 260 }, 'Index rows');
    const sourceRect = await screenRectOf(open, sourceBox.id);
    await page.mouse.move(sourceRect.x + sourceRect.width / 2, sourceRect.y + sourceRect.height / 2);
    const bottomPort = { x: sourceRect.x + sourceRect.width / 2, y: sourceRect.y + sourceRect.height };
    assert.equal(await cursorAt(open, bottomPort), 'crosshair', 'the bottom edge middle of a hovered box is a wire port');
    const dropTarget = centerOf(await screenRectOf(open, targetBox.id));
    await page.mouse.down();
    await page.mouse.move(dropTarget.x, dropTarget.y, { steps: 6 });
    assert.equal(await panel.locator('.wb-wire-draft').count(), 1, 'a port drag draws a dashed line');
    await page.mouse.up();
    assert.equal(await panel.locator('.wb-wire-draft').count(), 0, 'releasing a port drag removes its dashed line');
    const wire = await elementWhere(open, 'the dragged wire', (element) => element.kind === 'wire' && element.from === sourceBox.id && element.to === targetBox.id);
    const restingPath = await wirePathOf(open, wire.id);
    const restingTarget = await screenRectOf(open, targetBox.id);
    const versionBeforeDrop = (await boardOf(open)).version;
    await page.mouse.move(restingTarget.x + restingTarget.width / 2, restingTarget.y + restingTarget.height / 2);
    await page.mouse.down();
    await page.mouse.move(restingTarget.x + restingTarget.width / 2 + 260, restingTarget.y + restingTarget.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    await pollFor('dropping the dragged box saves its move', BOARD_TIMEOUT_MS, async () => ((await boardOf(open)).version !== versionBeforeDrop ? true : null));
    const draggedPath = await wirePathOf(open, wire.id);
    assert.notEqual(draggedPath, restingPath, 'moving a box reroutes its wire');
    const stepHistory = async (label: string, press: () => Promise<void>, expectedPath: string) => {
      const versionBefore = (await boardOf(open)).version;
      await press();
      await pollFor(label, BOARD_TIMEOUT_MS, async () => ((await boardOf(open)).version !== versionBefore ? true : null));
      assert.equal(await wirePathOf(open, wire.id), expectedPath, label);
    };
    await panel.locator('.wb-viewport').focus();
    await stepHistory('undo puts the dragged box back', () => page.keyboard.press('ControlOrMeta+z'), restingPath);
    await stepHistory('redo moves it again', () => page.keyboard.press('ControlOrMeta+Shift+z'), draggedPath);
    await stepHistory('the undo button steps back like Ctrl+Z', () => panel.getByRole('button', { name: 'undo', exact: true }).click(), restingPath);
    await stepHistory('the redo button steps forward again', () => panel.getByRole('button', { name: 'redo', exact: true }).click(), draggedPath);
    await panel.locator('.wb-viewport').focus();
    const inspect = panel.locator('.wb-inspect');
    await page.keyboard.press('Escape');
    await inspect.waitFor({ state: 'hidden' });
    await openBoardMenuItem(page, panel, 'board settings');
    await inspect.getByRole('heading', { name: 'Board', exact: true }).waitFor();
    await inspect.getByRole('combobox', { name: 'Code session', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await inspect.waitFor({ state: 'hidden' });
    await panel.getByRole('button', { name: 'board menu', exact: true }).click();
    await page.getByRole('menuitemradio', { name: boardTitle }).waitFor();
    await page.getByRole('menuitem', { name: 'delete board', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await clickElement(open, targetBox.id);
    await inspect.getByRole('heading', { name: 'Box', exact: true }).waitFor();
    const isTargetWith = (isMatch: (box: Extract<BoardElement, { kind: 'box' }>) => boolean) => (element: BoardElement) => element.id === targetBox.id && element.kind === 'box' && isMatch(element);
    await inspect.getByRole('combobox', { name: 'Shape', exact: true }).selectOption('decision');
    await elementWhere(open, 'the box turned into a decision', isTargetWith((box) => box.shape === 'decision' && box.outputs.length > 0));
    await inspect.getByRole('heading', { name: 'Decision', exact: true }).waitFor();
    await inspect.getByRole('combobox', { name: 'Shape', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await elementWhere(open, 'undo right after a panel change takes the decision back', isTargetWith((box) => box.shape !== 'decision'));
    await inspect.getByRole('heading', { name: 'Box', exact: true }).waitFor();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await inspect.getByRole('heading', { name: 'Decision', exact: true }).waitFor();
    assert.equal(await inspect.getByRole('textbox', { name: 'Output yes label', exact: true }).inputValue(), 'yes');
    const titleField = inspect.getByRole('textbox', { name: 'Title', exact: true });
    await titleField.fill('Index first');
    await page.keyboard.press('Enter');
    await elementWhere(open, 'the panel title edit', titled('Index first'));
    await titleField.fill('Index second');
    await page.keyboard.press('Enter');
    await elementWhere(open, 'the second panel title edit', titled('Index second'));
    await inspect.getByRole('combobox', { name: 'Shape', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+z');
    await elementWhere(open, 'two undos take both title edits back', titled('Index rows'));
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await elementWhere(open, 'redo brings the first title back', titled('Index first'));
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await elementWhere(open, 'redo brings the second title back', titled('Index second'));
    await inspect.getByRole('combobox', { name: 'Change', exact: true }).selectOption('relabeled');
    await elementWhere(open, 'a relabeled box keeps its old title', isTargetWith((box) => box.change === 'relabeled' && box.was === 'Index second'));
    await titleField.fill('Index rows by day');
    await page.keyboard.press('Enter');
    await elementWhere(open, 'the relabeled box takes its new title', isTargetWith((box) => box.change === 'relabeled' && box.title === 'Index rows by day'));
    assert.ok(layoutBoard(await boardOf(open)).legend.some((row) => row.label === 'renamed, old title struck through'), 'the legend explains a relabeled box');
    await inspect.getByRole('button', { name: 'Add a ref to this box', exact: true }).click();
    const refField = inspect.getByRole('textbox', { name: 'Ref 1', exact: true });
    await refField.fill('src/feed.ts#L2');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('.boards-view .wb-inspect [data-field="ref-0"]')?.value === 'src/feed.ts#L2');
    await inspect.getByRole('combobox', { name: 'Change', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('.boards-view .wb-inspect [data-field="ref-0"]')?.value === 'README.md');
    await inspect.getByRole('button', { name: 'Add a line to this box', exact: true }).click();
    await inspect.getByRole('textbox', { name: 'Line 1 text', exact: true }).waitFor();
    await inspect.getByRole('button', { name: 'Add a line to this box', exact: true }).click();
    await inspect.getByRole('textbox', { name: 'Line 2 text', exact: true }).waitFor();
    const hasLine = (text: string) => isTargetWith((box) => box.lines.some((line) => line.text === text));
    await inspect.getByRole('textbox', { name: 'Line 1 text', exact: true }).fill('first edited');
    await page.keyboard.press('Enter');
    await elementWhere(open, 'the first line edit', hasLine('first edited'));
    await inspect.getByRole('textbox', { name: 'Line 2 text', exact: true }).fill('second edited');
    await page.keyboard.press('Enter');
    await elementWhere(open, 'a second line edit keeps the first one', (element) => hasLine('second edited')(element) && hasLine('first edited')(element));
    await addPlanStep(panel);
    await submitTextDialog(page, 'Unit title', 'Index the diffs', 'Add unit');
    const unit = await elementWhere(open, 'the planned unit', (element) => element.kind === 'unit' && element.title === 'Index the diffs' && element.status === 'planned');
    await clickElement(open, unit.id);
    await inspect.getByRole('combobox', { name: 'Status', exact: true }).selectOption('landed');
    await elementWhere(open, 'the landed unit', (element) => element.id === unit.id && element.kind === 'unit' && element.status === 'landed');
    await openBoardMenuItem(page, panel, 'board settings');
    await inspect.getByRole('heading', { name: 'Board', exact: true }).waitFor({ timeout: 3000 });
  }
  assert.equal(await panel.getByRole('button', { name: 'fit', exact: true }).isVisible(), true);
  assert.equal(await panel.getByRole('button', { name: boardTitle, exact: true }).count(), 1);
}

async function openDesktopBoard(page: Page, sessionId: string, boardTitle: string): Promise<OpenBoard> {
  assert.equal(await page.locator('#tab-boards').isVisible(), false, 'Boards has no desktop header tab; boards live in Focus');
  const boardId = await createBoardOverControl(page, boardTitle);
  await controlReplyOf(page, 'whiteboard-connect', { boardId, sessionId });
  return { page, panel: await showBoardInFocus(page, sessionId, boardTitle), boardId };
}

export async function verifyBoardPane(page: Page, sessionId: string, projectDirectory: string): Promise<void> {
  const boardTitle = `Pane plan ${sessionId.slice(0, 8)}`;
  const boardId = await createBoardOverControl(page, boardTitle);
  await page.locator(`.focus-rail .session-row[data-id="${sessionId}"] .session-row-glyph`).first().click();
  const card = page.locator(`.session-card[data-id="${sessionId}"]`).first();
  await card.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.pane-tab[data-tab="board"]').count(), 0, 'a session with no board shows Terminal only');
  await verifyPaneTerminalTabOwnsTheFace(page, card);
  await card.getByRole('button', { name: 'Session actions', exact: true }).click();
  await card.locator('.overflow-connect-board').click();
  await page.getByRole('combobox', { name: 'Board to connect', exact: true }).selectOption({ label: boardTitle });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.pane-tab[data-tab="board"]').waitFor();
  await page.locator('#focus-pane-board').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#focus-pane-terminal').isVisible(), true, 'a board arriving for the centered session splits the pane and keeps Terminal showing');
  assert.notEqual(await page.locator('.pane-layout').getAttribute('data-direction'), 'single', 'a board arriving for the centered session opens the stored split');
  const boardChip = page.locator(`.focus-rail .session-row[data-id="${sessionId}"]`).locator(`.session-board-chip[aria-label="Open board ${boardTitle}"]`);
  await boardChip.waitFor();
  const worktreePath = await pollFor('the session worktree', WORKTREE_TIMEOUT_MS, () => findSessionWorktree(projectDirectory));
  await commitFile(worktreePath, UNCOVERED_FILE_NAME, 'changed outside any board ref\n', 'test: a change no board ref covers');
  assert.equal((await boardChip.textContent())?.trim(), boardTitle);
  assert.equal(await boardChip.locator('.pr-status-icon').count(), 1, 'the board chip carries an icon like a PR chip');
  await boardChip.click();
  const panel = page.locator('#focus-center');
  const open: OpenBoard = { page, panel, boardId };
  await openBoardTitle(panel, boardTitle).waitFor();
  await page.locator('.pane-tab[data-tab="board"][aria-selected="true"]').waitFor();
  await verifyBoardToolsInBoardPane(panel, boardTitle);
  const canvasBox = await panel.locator('.wb-canvas').boundingBox();
  const cardBox = await card.boundingBox();
  assert.ok(canvasBox && cardBox);
  assert.ok(canvasBox.y + canvasBox.height <= cardBox.y, 'the default layout puts the board above the terminal');
  await page.waitForFunction((id) => document.querySelector(`#focus-pane-terminal .session-card[data-id="${id}"]`)?.getAttribute('data-grid') === 'exact', sessionId);
  const agentIsland = panel.getByRole('toolbar', { name: 'Session', exact: true });
  assert.equal(await agentIsland.isVisible(), false, 'the session island stays hidden while the session has read every change');
  const centeredSessionName = await card.getAttribute('data-session');
  assert.ok(centeredSessionName);
  assert.equal(await panel.locator('.wb-presence-pill', { hasText: centeredSessionName }).count(), 0, 'the strip does not repeat the centered session as a presence pill');
  await addPlanStep(panel);
  await submitTextDialog(page, 'Unit title', 'Uncovered change', 'Add unit');
  const unit = await elementWhere(open, 'the uncovered unit', (element) => element.kind === 'unit' && element.title === 'Uncovered change');
  await agentIsland.locator('.wb-session-queued', { hasText: 'queued for' }).waitFor();
  const agentBox = await agentIsland.boundingBox();
  assert.ok(agentBox);
  assert.ok(Math.abs(agentBox.y + agentBox.height - (canvasBox.y + canvasBox.height - 10)) < 2 && Math.abs(agentBox.x - (canvasBox.x + 10)) < 2, 'the session island sits bottom left on the board');
  await agentIsland.getByRole('button', { name: 'send to agent', exact: true }).click();
  await agentIsland.locator('.action-status', { hasText: 'sent' }).waitFor();
  await clickElement(open, unit.id);
  const inspect = panel.locator('.wb-inspect');
  await inspect.getByRole('button', { name: 'Add a ref to this unit', exact: true }).click();
  await inspect.getByRole('textbox', { name: 'Ref 1', exact: true }).fill(UNCOVERED_FILE_NAME);
  await page.keyboard.press('Enter');
  await pollFor('the review flags the uncovered unit', REVIEW_TIMEOUT_MS, async () => ((await reviewOf(open)).flaggedUnitIds.includes(unit.id) ? true : null));
  await panel.getByRole('button', { name: 'fit', exact: true }).click();
  const fittedUnitBox = await screenRectOf(open, unit.id);
  const islandBox = await agentIsland.boundingBox();
  assert.ok(islandBox);
  const spaceAboveUnitPx = fittedUnitBox.y - canvasBox.y;
  const spaceBelowUnitPx = islandBox.y - (fittedUnitBox.y + fittedUnitBox.height);
  assert.ok(spaceAboveUnitPx > 0 && spaceBelowUnitPx > 0, 'fit keeps the board clear of the session island');
  await inspect.getByRole('button', { name: `Open ${UNCOVERED_FILE_NAME} in review`, exact: true }).click();
  await page.locator('#tab-focus[aria-selected="true"]').waitFor();
  await page.locator(`.review-reader .review-reader-file[data-path="${UNCOVERED_FILE_NAME}"][aria-current="true"]`).waitFor({ timeout: REVIEW_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await page.locator('.review-reader').waitFor({ state: 'detached' });
  await verifyBoardPaneFallsBackToSessionBoard(page, panel, sessionId, boardTitle);
  await verifySessionlessBoardRows(page, panel, sessionId, projectDirectory);
}

async function verifySessionlessBoardRows(page: Page, panel: Locator, sessionId: string, projectDirectory: string): Promise<void> {
  const laterTitle = `Later plan ${sessionId.slice(0, 8)}`;
  const boardsSection = page.locator('.rail-boards-details');
  assert.equal(await boardsSection.getAttribute('open'), null, 'the rail Boards section starts closed');
  await boardsSection.locator('summary').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('glimmervoid-ui-prefs') ?? '{}').railBoardsOpen === true);
  const laterRow = page.locator('.focus-board-list .session-row', { hasText: laterTitle });
  await laterRow.waitFor();
  assert.equal(await laterRow.locator('.session-row-label').textContent(), 'BOARD', 'a board with no session shows a BOARD row');
  assert.equal(await page.locator('.focus-board-list .session-row', { hasText: `Second plan ${sessionId.slice(0, 8)}` }).count(), 0, 'a board connected to a session has no BOARD row');
  await laterRow.click();
  await openBoardTitle(panel, laterTitle).waitFor();
  await page.locator('.pane-tab[data-tab="terminal"]').waitFor({ state: 'hidden' });
  await verifyMergeShortcutIgnoredWhileBoardCentered(page, projectDirectory);
  await verifyRailArrowsReachBoardRows(page);
  await panel.getByRole('button', { name: 'board menu', exact: true }).click();
  await page.getByRole('menuitemradio', { name: `Second plan ${sessionId.slice(0, 8)}` }).click();
  await openBoardTitle(panel, `Second plan ${sessionId.slice(0, 8)}`).waitFor();
  await laterRow.click();
  await openBoardTitle(panel, laterTitle).waitFor();
  const railTitle = `Rail plan ${sessionId.slice(0, 8)}`;
  await page.getByRole('button', { name: 'New board', exact: true }).click();
  await submitTextDialog(page, 'Board title', railTitle, 'Create board');
  assert.notEqual(await boardsSection.getAttribute('open'), null, 'New board leaves the rail Boards section open');
  await openBoardTitle(panel, railTitle).waitFor();
  await page.locator('.focus-board-list .session-row.focused', { hasText: railTitle }).waitFor();
  await page.locator(`.focus-rail .session-row[data-id="${sessionId}"] .session-row-glyph`).first().click();
  await page.locator('.pane-tab[data-tab="terminal"]').waitFor();
  assert.equal(await page.locator('.focus-board-list .session-row.focused').count(), 0, 'picking a session leaves the board row');
}

async function verifyBoardPaneFallsBackToSessionBoard(page: Page, panel: Locator, sessionId: string, shownBoardTitle: string): Promise<void> {
  const secondTitle = `Second plan ${sessionId.slice(0, 8)}`;
  const secondBoardId = await createBoardOverControl(page, secondTitle);
  await controlReplyOf(page, 'whiteboard-connect', { boardId: secondBoardId, sessionId });
  const unrelatedTitle = `Unrelated plan ${sessionId.slice(0, 8)}`;
  await createBoardOverControl(page, unrelatedTitle);
  await panel.getByRole('button', { name: 'board menu', exact: true }).click();
  await page.getByRole('menuitemradio', { name: shownBoardTitle }).click();
  await openBoardTitle(panel, shownBoardTitle).waitFor();
  await openBoardMenuItem(page, panel, 'delete board');
  await page.getByRole('button', { name: 'Delete board', exact: true }).click();
  await openBoardTitle(panel, secondTitle).waitFor();
  assert.equal(await page.locator('.pane-tab[data-tab="board"]').count(), 1, 'the session keeps its Board tab while it has a board');
  await panel.getByRole('button', { name: 'board menu', exact: true }).click();
  await page.getByRole('menuitemradio', { name: unrelatedTitle }).click();
  await openBoardTitle(panel, unrelatedTitle).waitFor();
  const laterTitle = `Later plan ${sessionId.slice(0, 8)}`;
  await createBoardOverControl(page, laterTitle);
  await panel.getByRole('button', { name: 'board menu', exact: true }).click();
  await page.getByRole('menuitemradio', { name: laterTitle }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await openBoardTitle(panel, unrelatedTitle).count(), 1, 'a board the operator picked stays open when the board list changes');
  await openBoardMenuItem(page, panel, 'delete board');
  await page.getByRole('button', { name: 'Delete board', exact: true }).click();
  await openBoardTitle(panel, secondTitle).waitFor();
}

async function verifyMergeShortcutIgnoredWhileBoardCentered(page: Page, projectDirectory: string): Promise<void> {
  const originPath = (await git(projectDirectory, ['remote', 'get-url', 'origin'])).trim();
  await page.keyboard.press('Alt+KeyI');
  await page.waitForTimeout(MERGE_SETTLE_MS);
  assert.equal(await page.getByRole('dialog').count(), 0, 'the merge shortcut asks nothing while a board is centered');
  assert.equal(await readOriginFile(originPath, UNCOVERED_FILE_NAME), null, 'the merge shortcut merges nothing while a board is centered');
}

async function verifyRailArrowsReachBoardRows(page: Page): Promise<void> {
  const firstBoardRow = page.locator('.focus-board-list button.session-row[data-board-id]').first();
  const firstBoardId = await firstBoardRow.getAttribute('data-board-id');
  await firstBoardRow.focus();
  await page.keyboard.press('ArrowUp');
  assert.ok(await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.dataset.id !== undefined), 'ArrowUp from the first BOARD row reaches a session row');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement instanceof HTMLElement ? document.activeElement.dataset.boardId ?? null : null), firstBoardId, 'ArrowDown from the last session row reaches the first BOARD row');
  await page.keyboard.press('ArrowUp');
  await page.locator('.rail-boards-details').evaluate((details) => { if (details instanceof HTMLDetailsElement) details.open = false; });
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement instanceof HTMLElement ? document.activeElement.dataset.boardId ?? null : null), null, 'ArrowDown skips BOARD rows while the rail Boards section is closed');
  await page.locator('.rail-boards-details').evaluate((details) => { if (details instanceof HTMLDetailsElement) details.open = true; });
}

async function verifyPaneTerminalTabOwnsTheFace(page: Page, card: Locator): Promise<void> {
  assert.equal(await page.locator('.card-face-tabs').count(), 0, 'Terminal shows once, on the pane tab, with no view tabs beside it');
  const sessionId = await card.getAttribute('data-id');
  const isPlanShown = await page.evaluate(async (id) => {
    const cardFacesUrl = '/session-card/card-faces.ts';
    const cardFaces: { setSessionHasPlan(id: unknown, hasPlan: unknown): void; showSessionPlanFace(id: unknown): boolean } = await import(cardFacesUrl);
    cardFaces.setSessionHasPlan(id, true);
    return cardFaces.showSessionPlanFace(id);
  }, sessionId);
  assert.equal(isPlanShown, true, 'the centered card switches to its Plan face');
  await page.locator('.pane-tab[data-tab="terminal"]').click();
  await page.waitForFunction(() => document.querySelector('#focus-pane-terminal .session-card')?.getAttribute('data-face') === 'terminal');
}

async function verifyBoardToolsInBoardPane(panel: Locator, boardTitle: string): Promise<void> {
  await openBoardTitle(panel, boardTitle).waitFor();
  const boardPane = panel.locator('#focus-pane-board');
  assert.equal(await boardPane.locator('.wb-top-left').isVisible(), true, 'the board tools sit inside the Board pane');
  assert.equal(await panel.locator('.pane-strip .wb-top-left').count(), 0, 'the tab row carries no board tools');
  assert.equal(await boardPane.locator('.wb-presence .wb-presence-pill:not(.wb-presence-count)').count(), 0, 'the board names no pill for the only connected session, the one centered beside it');
}
