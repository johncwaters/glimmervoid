import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page } from 'playwright-core';
import { BOARD_ASK_QUESTION, DIRECTOR_DIGEST_TEXT, DIRECTOR_MISFIT_TEXT, RESUMED_AFTER_QUESTION_TEXT, SHOWN_PAGE_REPLY, SHOWN_PAGE_TICKED_TEXT, SHOW_CARD_BELOW_COMMAND, STUDIO_PROGRESS_ANSWER } from './cases-core.ts';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readableFloorScale } from '../../public/board-session/board-session-core.ts';
import { boardElementsOf, boxBoardRectsOf, boxScreenRectsOf, clickBoardBoxWhere, controlReplyOf, createBoardOverControl, hoverBoardBoxWhere, showBoardInFocus } from './boards.ts';
import { DRAFT_PR_STATE, FAKE_PR_NUMBER, FAKE_PR_STATE_ENV, FAKE_PR_URL, READY_PR_STATE } from './fake-pr.ts';
import type { Element as BoardElement } from '../../shared/contracts/whiteboard.ts';
import { pollFor } from './review-changes.ts';

const BOARD_SESSION_TIMEOUT_MS = 20000;
const ADDRESS_SETTLE_MS = 1500;
const MESSAGE_BAR_SELECTOR = '.bs-pill textarea.chat-composer-input';
const LAYOUT_TOLERANCE_PX = 0.5;
const MERGE_POLL_MS = 250;
const DIRECTOR_TIMEOUT_MS = 60000;
const RAIL_REPAINT_WAIT_MS = 35000;
const DIRECTOR_AWAY_MS = 15000;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAP_PAN_STEPS = 10;
const STEADY_PAN_STEPS = 6;
const STEADY_PAN_STEP_PX = 50;
const STEADY_PAN_SETTLE_MS = 1500;
const MAP_PAN_STEP_PX = 1500;
const MAP_GLIDE_SETTLE_MS = 800;
const FIRST_VIEW_CENTER_TOLERANCE_PX = 2;

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} is laid out`);
  return box;
}

function assertSameBox(before: Box, after: Box, what: string): void {
  for (const edge of ['x', 'y', 'width', 'height'] as const) {
    assert.ok(Math.abs(before[edge] - after[edge]) <= LAYOUT_TOLERANCE_PX, `${what} keeps its ${edge} (${before[edge]} then ${after[edge]})`);
  }
}

const StudioMapBoxes = z.object({
  boardId: z.string().nullable().default(null),
  areas: z.array(z.object({ anchorBoxId: z.string(), repoKey: z.string(), repoName: z.string(), repoDir: z.string() })).default([]),
  boxRectById: z.record(z.string(), z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })).default({}),
});

async function studioMapBoardIdOf(page: Page, root: Locator): Promise<string | null> {
  return (await studioMapBoxesOf(page, root)).boardId;
}

async function studioMapBoxesOf(page: Page, root: Locator): Promise<z.infer<typeof StudioMapBoxes>> {
  const mapSessionId = await root.locator('.bs-card[data-main]').first().getAttribute('data-session-id');
  assert.ok(mapSessionId, 'the main card names its session');
  const cardSessionIds = await root.locator('.bs-card[data-session-id]').evaluateAll((cards) => cards.flatMap((card) => card.getAttribute('data-session-id') ?? []));
  return StudioMapBoxes.parse(await page.evaluate(async ({ sessionId, watchedIds }) => {
    const tokenReply: unknown = await fetch('/control-token', { credentials: 'same-origin', cache: 'no-store' }).then((response) => response.json());
    const token = typeof tokenReply === 'object' && tokenReply !== null && 'token' in tokenReply && typeof tokenReply.token === 'string' ? tokenReply.token : '';
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/control?token=${encodeURIComponent(token)}`);
    const requestId = `harness-boxes-${Date.now()}`;
    return new Promise<unknown>((resolve) => {
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'codemap-boxes-of', requestId, id: sessionId, pathsBySessionId: Object.fromEntries(watchedIds.map((watchedId) => [watchedId, []])) })));
      socket.addEventListener('message', (event) => {
        const reply: unknown = JSON.parse(String(event.data));
        if (typeof reply !== 'object' || reply === null || Reflect.get(reply, 'requestId') !== requestId) return;
        socket.close();
        resolve(reply);
      });
    });
  }, { sessionId: mapSessionId, watchedIds: cardSessionIds }));
}

async function shownPageBoundsOf(page: Page): Promise<Box> {
  const deadline = Date.now() + BOARD_SESSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const hasTick = await frame.locator('#tick').count().then((count) => count > 0, () => false);
      const bounds = hasTick ? await (await frame.frameElement()).boundingBox() : null;
      if (bounds) return bounds;
    }
    await delay(MERGE_POLL_MS);
  }
  assert.fail('the shown page renders on the Studio map');
}

async function mapScaleOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const world = document.querySelector<HTMLElement>('.board-session-view .wb-world');
    return world ? new DOMMatrixReadOnly(getComputedStyle(world).transform).a : Number.NaN;
  });
}

async function shownPageInViewBoundsOf(page: Page): Promise<Box> {
  const notice = page.locator('.board-session-view .wb-island-agent-change');
  const deadline = Date.now() + BOARD_SESSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assert.equal(await notice.isVisible(), false, 'a card a Studio agent shows needs no Go to card notice');
    const shownPageBounds = await shownPageBoundsOf(page);
    const viewBounds = await boxOf(page, '.board-session-view .wb-viewport');
    const isInView = shownPageBounds.x >= viewBounds.x && shownPageBounds.y >= viewBounds.y && shownPageBounds.x + shownPageBounds.width <= viewBounds.x + viewBounds.width && shownPageBounds.y + shownPageBounds.height <= viewBounds.y + viewBounds.height;
    if (isInView) return shownPageBounds;
    await delay(MERGE_POLL_MS);
  }
  assert.fail('a card a Studio agent shows comes into the Studio view');
}

function clearMapPointIn(page: Page, bounds: Box): Promise<{ x: number; y: number } | null> {
  return page.evaluate((rect) => {
    for (let row = 1; row < 10; row += 1) {
      for (let column = 1; column < 10; column += 1) {
        const point = { x: rect.x + (rect.width * column) / 10, y: rect.y + (rect.height * row) / 10 };
        const hit = document.elementFromPoint(point.x, point.y);
        if (hit?.closest('.wb-viewport')) return point;
      }
    }
    return null;
  }, bounds);
}

async function studioCameraOf(page: Page): Promise<{ x: number; y: number; scale: number }> {
  return page.evaluate(() => {
    const world = document.querySelector<HTMLElement>('.board-session-view .wb-world');
    const transform = world ? new DOMMatrixReadOnly(getComputedStyle(world).transform) : null;
    return transform ? { x: -transform.e / transform.a, y: -transform.f / transform.a, scale: transform.a } : { x: Number.NaN, y: Number.NaN, scale: Number.NaN };
  });
}

async function verifyStudioCameraKeptAcrossFocusBoard(page: Page): Promise<void> {
  const root = page.locator('.board-session-view');
  await page.locator('#tab-focus').click();
  const focusSessionId = await page.locator('.focus-rail .session-row[data-id]').first().getAttribute('data-id', { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.ok(focusSessionId, 'Focus lists a session to show a board beside');
  await page.locator('#tab-board-session').click();
  await root.locator('.wb-viewport').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  const viewport = await boxOf(page, '.board-session-view .wb-viewport');
  await page.mouse.move(viewport.x + 30, viewport.y + viewport.height / 2);
  for (let step = 0; step < STEADY_PAN_STEPS; step += 1) await page.mouse.wheel(STEADY_PAN_STEP_PX * 3, STEADY_PAN_STEP_PX * 2);
  const leftCamera = await studioCameraOf(page);
  const focusBoardTitle = `Focus board ${focusSessionId.slice(0, 8)}`;
  const focusBoardId = await createBoardOverControl(page, focusBoardTitle);
  await controlReplyOf(page, 'whiteboard-connect', { boardId: focusBoardId, sessionId: focusSessionId });
  await page.locator('#tab-focus').click();
  await showBoardInFocus(page, focusSessionId, focusBoardTitle);
  await page.locator('#tab-board-session').click();
  await root.locator('.wb-viewport').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  let backCamera = await studioCameraOf(page);
  const isLeftCamera = (camera: { x: number; y: number; scale: number }) => Math.abs(camera.x - leftCamera.x) < 1 && Math.abs(camera.y - leftCamera.y) < 1 && Math.abs(camera.scale - leftCamera.scale) < 0.001;
  await pollFor('the Studio map to paint again after Focus', BOARD_SESSION_TIMEOUT_MS, async () => {
    backCamera = await studioCameraOf(page);
    return isLeftCamera(backCamera) ? true : null;
  }).catch(() => undefined);
  assert.ok(isLeftCamera(backCamera), `the Studio map keeps the camera the operator left after Focus shows another board (left ${JSON.stringify(leftCamera)}, back ${JSON.stringify(backCamera)})`);
  await page.mouse.move(viewport.x + 30, viewport.y + viewport.height / 2);
  for (let step = 0; step < STEADY_PAN_STEPS; step += 1) await page.mouse.wheel(-STEADY_PAN_STEP_PX * 3, -STEADY_PAN_STEP_PX * 2);
}

async function verifyFirstViewClearOfBar(page: Page): Promise<void> {
  const root = page.locator('.board-session-view');
  const boardId = await studioMapBoardIdOf(page, root);
  assert.ok(boardId, 'the Studio map has a board on open');
  const barCoveredBoxIds = async () => {
    const bar = await boxOf(page, '.board-session-view .bs-pill');
    const boxRects = await boxScreenRectsOf(page, root, boardId);
    return [...boxRects].filter(([, rect]) => rectsOverlap(rect, bar)).map(([boxId]) => boxId);
  };
  await pollFor('the first map view to settle above the message bar', BOARD_SESSION_TIMEOUT_MS, async () => (await barCoveredBoxIds()).length === 0 ? true : null).catch(() => undefined);
  assert.deepEqual(await barCoveredBoxIds(), [], 'the first map view keeps every box clear of the folded message bar');
}

async function verifyShowOnBoard(page: Page): Promise<void> {
  const root = page.locator('.board-session-view');
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  await pillInput.click();
  const showOnBoard = root.locator('.bs-row-agent:not([hidden])', { hasText: SHOWN_PAGE_REPLY }).getByRole('button', { name: 'Show on board', exact: true }).last();
  await showOnBoard.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  const boardId = await studioMapBoardIdOf(page, root);
  assert.ok(boardId, 'the Studio map has a board for the shown page');
  const pageBounds = await shownPageBoundsOf(page);
  const pageCenter = { x: pageBounds.x + pageBounds.width / 2, y: pageBounds.y + pageBounds.height / 2 };
  const shownBoxId = [...await boxScreenRectsOf(page, root, boardId)].find(([, rect]) => pageCenter.x > rect.x && pageCenter.x < rect.x + rect.width && pageCenter.y > rect.y && pageCenter.y < rect.y + rect.height)?.[0];
  assert.ok(shownBoxId, 'the shown page sits in a map box');
  const viewport = await boxOf(page, '.board-session-view .wb-viewport');
  await page.mouse.move(viewport.x + 30, viewport.y + viewport.height / 2);
  for (let step = 0; step < MAP_PAN_STEPS; step += 1) await page.mouse.wheel(MAP_PAN_STEP_PX, MAP_PAN_STEP_PX);
  const isPageInView = async () => {
    const shownBoxRect = (await boxScreenRectsOf(page, root, boardId)).get(shownBoxId);
    return shownBoxRect !== undefined && rectsOverlap(shownBoxRect, viewport);
  };
  assert.equal(await isPageInView(), false, 'panning moves the shown page out of view');
  await pillInput.click();
  await showOnBoard.click();
  await pollFor('Show on board to bring the shown page back into view', BOARD_SESSION_TIMEOUT_MS, async () => await isPageInView() ? true : null);
}

function isRectWithin(inner: Box, outer: Box): boolean {
  const slackPx = 2;
  return inner.x >= outer.x - slackPx && inner.y >= outer.y - slackPx && inner.x + inner.width <= outer.x + outer.width + slackPx && inner.y + inner.height <= outer.y + outer.height + slackPx;
}

async function clearMapArea(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const viewport = document.querySelector('.board-session-view .wb-viewport')?.getBoundingClientRect();
    const dockSlot = document.querySelector('.board-session-view .bs-dock-slot')?.getBoundingClientRect();
    const guide = document.querySelector<HTMLElement>('.board-session-view .bs-guide');
    if (!viewport || !dockSlot) return { x: 0, y: 0, width: 0, height: 0 };
    const guideReservePx = guide && !guide.hidden ? Math.max(0, viewport.right - guide.getBoundingClientRect().left) : 0;
    return { x: viewport.x + 24, y: viewport.y + 64, width: viewport.width - 48 - guideReservePx, height: dockSlot.top - viewport.y - 64 };
  });
}

async function verifyShownCardKeepsMapInView(page: Page): Promise<void> {
  const root = page.locator('.board-session-view');
  const boardId = await studioMapBoardIdOf(page, root);
  assert.ok(boardId, 'the Studio map is known');
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  await pillInput.click();
  await root.locator('.bs-log').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  const pageReplyRow = root.locator('.bs-row-agent:not([hidden])', { hasText: SHOWN_PAGE_REPLY }).last();
  const pageReplyChangeAt = await pageReplyRow.getAttribute('data-board-change-at');
  const anchorBox = (await boardElementsOf(page, root, boardId)).find((element) => element.kind === 'box' && element.title.startsWith('Map at'));
  assert.ok(anchorBox, 'the map has its freshness box to show a card below');
  await root.getByRole('button', { name: 'Fit', exact: true }).click();
  const viewport = await boxOf(page, '.board-session-view .wb-viewport');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const anchorRect = (await boxScreenRectsOf(page, root, boardId)).get(anchorBox.id);
    const dockTop = (await boxOf(page, '.board-session-view .bs-dock-slot')).y;
    assert.ok(anchorRect, 'the freshness box is laid out');
    const shiftPx = dockTop - 16 - (anchorRect.y + anchorRect.height);
    if (Math.abs(shiftPx) < 4) break;
    await page.mouse.move(viewport.x + 30, viewport.y + viewport.height / 2);
    await page.mouse.wheel(0, -shiftPx);
    await delay(MAP_GLIDE_SETTLE_MS);
  }
  const shownBefore = await boxScreenRectsOf(page, root, boardId);
  const clearBefore = await clearMapArea(page);
  const visibleBefore = [...shownBefore].filter(([, rect]) => isRectWithin(rect, clearBefore)).map(([boxId]) => boxId);
  assert.ok(visibleBefore.includes(anchorBox.id), 'the freshness box sits just above the open log before the card is shown');
  await pillInput.fill(`${SHOW_CARD_BELOW_COMMAND}${anchorBox.id}`);
  await pillInput.press('Enter');
  const shownCardBoxId = await pollFor('the shown card to land on the map', BOARD_SESSION_TIMEOUT_MS, async () => [...(await boxScreenRectsOf(page, root, boardId)).keys()].find((boxId) => !shownBefore.has(boxId)) ?? null);
  const isCardRevealed = async () => {
    const shownCardRect = (await boxScreenRectsOf(page, root, boardId)).get(shownCardBoxId);
    return shownCardRect !== undefined && isRectWithin(shownCardRect, await clearMapArea(page));
  };
  await pollFor('the shown card to come inside the clear map area', BOARD_SESSION_TIMEOUT_MS, async () => await isCardRevealed() ? true : null);
  const shownAfter = await boxScreenRectsOf(page, root, boardId);
  const clearAfter = await clearMapArea(page);
  const stillVisible = visibleBefore.filter((boxId) => { const rect = shownAfter.get(boxId); return rect !== undefined && isRectWithin(rect, clearAfter); });
  assert.ok(stillVisible.length > 0, `revealing a card below the map keeps a box that was in view (before: ${visibleBefore.join(', ')})`);
  assert.equal(await pageReplyRow.getAttribute('data-board-change-at'), pageReplyChangeAt, 'a later turn\'s board change leaves an earlier reply\'s Show on board where it was');
}

async function verifyShownPageOnMap(page: Page): Promise<void> {
  const root = page.locator('.board-session-view');
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  const scaleBefore = await mapScaleOf(page);
  await pillInput.fill('show-page');
  await pillInput.press('Enter');
  const shownPageBounds = await shownPageInViewBoundsOf(page);
  assert.equal(await mapScaleOf(page), scaleBefore, 'the map keeps its zoom while a shown card comes into view');
  const openPoint = await page.evaluate((bounds) => {
    for (let row = 1; row < 10; row += 1) {
      for (let column = 1; column < 10; column += 1) {
        const point = { x: bounds.x + (bounds.width * column) / 10, y: bounds.y + (bounds.height * row) / 10 };
        const hit = document.elementFromPoint(point.x, point.y);
        if (hit?.closest('.wb-viewport')) return point;
      }
    }
    return null;
  }, shownPageBounds);
  assert.ok(openPoint, 'part of the shown page is clear of the Studio cards and log');
  await page.mouse.click(openPoint.x, openPoint.y);
  const viewerPage = page.frameLocator('iframe.wb-image-viewer-page');
  await viewerPage.getByRole('button', { name: 'Tick', exact: true }).click({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await viewerPage.getByRole('button', { name: SHOWN_PAGE_TICKED_TEXT, exact: true }).waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  assert.equal(await root.locator('.bs-pill-address').isHidden(), true, 'a page an agent showed on the map takes no address');
  await verifyShowOnBoard(page);
  await verifyShownCardKeepsMapInView(page);
}

function prCardLinesOf(element: BoardElement | undefined): Record<string, string> | null {
  if (element?.kind !== 'box' || element.pullRequest?.url !== FAKE_PR_URL) return null;
  return Object.fromEntries(element.lines.map((line) => [line.key ?? '', line.text]));
}

async function prCardWith(page: Page, root: Locator, boardId: string, expectedLines: Record<string, string>): Promise<BoardElement> {
  return pollFor(`the pull request card showing ${JSON.stringify(expectedLines)}`, BOARD_SESSION_TIMEOUT_MS, async () => {
    const card = (await boardElementsOf(page, root, boardId)).find((element) => prCardLinesOf(element) !== null);
    const lines = prCardLinesOf(card);
    if (!card || !lines) return null;
    return Object.entries(expectedLines).every(([key, text]) => lines[key] === text) ? card : null;
  });
}

function rectsOverlap(first: Box, second: Box): boolean {
  return first.x < second.x + second.width && second.x < first.x + first.width && first.y < second.y + second.height && second.y < first.y + first.height;
}

const CLEAR_CANVAS_INSET_PX = 40;

async function bringBoxIntoView(page: Page, root: Locator, boardId: string, boxId: string): Promise<void> {
  const viewport = await root.locator('.wb-viewport').boundingBox();
  const cardOnScreen = (await boxScreenRectsOf(page, root, boardId)).get(boxId);
  assert.ok(viewport && cardOnScreen, 'the map and the card are laid out');
  const center = { x: cardOnScreen.x + cardOnScreen.width / 2, y: cardOnScreen.y + cardOnScreen.height / 2 };
  const isInView = center.x > viewport.x && center.x < viewport.x + viewport.width && center.y > viewport.y && center.y < viewport.y + viewport.height;
  if (isInView && (await clearMapPointIn(page, cardOnScreen)) !== null) return;
  if (isInView) {
    await page.mouse.move(viewport.x + viewport.width - CLEAR_CANVAS_INSET_PX, viewport.y + CLEAR_CANVAS_INSET_PX * 3);
    await page.mouse.wheel(0, cardOnScreen.y - (viewport.y + CLEAR_CANVAS_INSET_PX * 3));
    await delay(MAP_GLIDE_SETTLE_MS);
    return;
  }
  await page.locator('.wb-island-agent-change', { hasText: `#${FAKE_PR_NUMBER}` }).getByRole('button', { name: 'Go to card', exact: true }).click({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await delay(MAP_GLIDE_SETTLE_MS);
}

async function verifyPrCardOnMap(page: Page): Promise<void> {
  const root = page.locator('.board-session-view');
  const statePath = process.env[FAKE_PR_STATE_ENV] ?? '';
  assert.ok(statePath.length > 0, 'the harness serves a fake gh with a pull request state file');
  fs.writeFileSync(statePath, JSON.stringify(DRAFT_PR_STATE));
  const boardId = await studioMapBoardIdOf(page, root);
  assert.ok(boardId, 'the Studio map board is known');
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  await addressBranch(page);
  await pillInput.fill('open-pr');
  await pillInput.press('Enter');
  const draftCard = await prCardWith(page, root, boardId, { State: 'Draft', Checks: 'Running', Review: 'Needs review' });
  assert.ok(draftCard.kind === 'box' && draftCard.title === `#${FAKE_PR_NUMBER} Add refunds beside the card module`, 'the card names the pull request number and title');
  const rectsBefore = await boxBoardRectsOf(page, root, boardId);
  const cardBefore = rectsBefore.get(draftCard.id);
  assert.ok(cardBefore, 'the pull request card is laid out on the map');
  const coveredBoxIds = [...rectsBefore].filter(([boxId, rect]) => boxId !== draftCard.id && rectsOverlap(cardBefore, rect)).map(([boxId]) => boxId);
  assert.deepEqual(coveredBoxIds, [], 'the pull request card covers no map box');

  fs.writeFileSync(statePath, JSON.stringify(READY_PR_STATE));
  await pillInput.fill('mark-pr-ready');
  await pillInput.press('Enter');
  const readyCard = await prCardWith(page, root, boardId, { State: 'Open', Checks: 'Passing', Review: 'Approved', Merge: 'Ready' });
  assert.equal(readyCard.id, draftCard.id, 'the status changes on the same card');
  const cardAfter = (await boxBoardRectsOf(page, root, boardId)).get(readyCard.id);
  assert.ok(cardAfter, 'the updated card is still laid out');
  assertSameBox(cardBefore, cardAfter, 'the pull request card');

  await page.evaluate(() => {
    const openedUrls: string[] = [];
    Reflect.set(window, '__openedPrUrls', openedUrls);
    window.open = (url) => {
      openedUrls.push(String(url));
      return null;
    };
  });
  await page.route('**/open-external', async (route) => {
    const requested: unknown = JSON.parse(route.request().postData() ?? '{}');
    await page.evaluate((url) => (Reflect.get(window, '__openedPrUrls') as string[]).push(url), String(Reflect.get(requested as object, 'url')));
    await route.fulfill({ status: 200, body: '{}' });
  });
  await bringBoxIntoView(page, root, boardId, readyCard.id);
  const cardOnScreen = (await boxScreenRectsOf(page, root, boardId)).get(readyCard.id);
  assert.ok(cardOnScreen, 'the card is on screen');
  const clearPoint = await clearMapPointIn(page, cardOnScreen);
  assert.ok(clearPoint, 'part of the pull request card is clear of the Studio cards and log');
  await page.mouse.click(clearPoint.x, clearPoint.y);
  await page.waitForFunction((url) => (Reflect.get(window, '__openedPrUrls') as string[]).includes(url), FAKE_PR_URL, { timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.unroute('**/open-external');
  assert.match(String(await root.locator('.bs-pill-address-text').textContent()), /^To /, 'clicking the pull request card leaves the message bar addressed as it was');
  await clearAddress(page);
}

async function addressCardBox(page: Page, pillBefore: Box): Promise<void> {
  const root = page.locator('.board-session-view');
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  await pillInput.fill('@card');
  const mention = root.getByRole('option').first();
  await mention.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.match(await mention.textContent() ?? '', /card/, 'the box picker offers the card file');
  const [studioArea] = (await studioMapBoxesOf(page, root)).areas;
  assert.ok(studioArea, 'Studio has a repo area');
  assert.equal(await root.locator('.bs-mention-group').first().textContent(), studioArea.repoName, 'the box picker groups its boxes under the name of their repo');
  await pillInput.press('Enter');
  await page.waitForFunction((addressStart) => (document.querySelector('.board-session-view .bs-pill-address-text')?.textContent ?? '').startsWith(addressStart), `New branch on ${studioArea.repoName} `, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await pillInput.inputValue(), '', 'picking a box takes the @ mention out of the pill');
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill with a branch address');
}

async function addressBranch(page: Page): Promise<void> {
  const root = page.locator('.board-session-view');
  await root.locator(MESSAGE_BAR_SELECTOR).click();
  await root.locator('.bs-row-agent.bs-row-branch .bs-face').last().click();
  const [studioArea] = (await studioMapBoxesOf(page, root)).areas;
  assert.ok(studioArea, 'Studio has a repo area');
  await page.waitForFunction((addressStart) => (document.querySelector('.board-session-view .bs-pill-address-text')?.textContent ?? '').startsWith(addressStart), `To ${studioArea.repoName} `, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.match(await root.locator('.bs-row-you.bs-row-branch .bs-bubble-who').last().textContent() ?? '', new RegExp(`^To ${studioArea.repoName} `), 'a log row to a branch names its repo');
}

async function clearAddress(page: Page): Promise<void> {
  const root = page.locator('.board-session-view');
  await root.locator('.bs-pill-address-clear').click();
  await root.locator('.bs-pill-address-text').waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
}

async function verifyBranch(page: Page, pillBefore: Box): Promise<void> {
  const root = page.locator('.board-session-view');
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  await addressCardBox(page, pillBefore);
  await pillInput.fill('Add refunds');
  await pillInput.press('Enter');
  const branchReply = root.locator('.bs-row-agent.bs-row-branch', { hasText: 'Committed refunds' }).first();
  await branchReply.waitFor({ timeout: DIRECTOR_TIMEOUT_MS });
  await root.locator('.bs-row-you.bs-row-branch', { hasText: 'Add refunds' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-row-you.bs-row-branch', { hasText: 'You are a branch' }).count(), 0, 'the branch bubble shows only what the operator typed');
  const branchFace = root.locator('.bs-card-shrunk:not([hidden]) .bs-card-shrunk-face').first();
  await branchFace.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-card[data-branch]:not([hidden])').count(), 0, 'an idle branch shows only its face');
  await root.locator('.bs-card-shrunk[data-flagged]:not([hidden])').first().waitFor({ timeout: DIRECTOR_TIMEOUT_MS });
  await branchFace.click();
  const branchCard = root.locator('.bs-card[data-branch]:not([hidden])').first();
  await branchCard.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await branchCard.locator('.bs-card-misfit:not([hidden])').textContent(), DIRECTOR_MISFIT_TEXT, 'a branch turn the Director judges off its task flags the card with the reason');
  await branchCard.locator('[data-action="board-session-agent-menu"]').click();
  await branchCard.locator('[data-action="board-session-agent-close"]').click();
  const closeRefusal = branchCard.locator('.bs-card-refusal:not([hidden])');
  await closeRefusal.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.match(await closeRefusal.textContent() ?? '', /uncommitted changes or commits/, 'Close refuses a branch holding unlanded work and says why on its card');

  await clearAddress(page);
  await addressBranch(page);
  await pillInput.fill('branch-follow-up');
  await pillInput.press('Enter');
  await root.locator('.bs-row-agent.bs-row-branch', { hasText: 'Refunds reuse' }).first().waitFor({ timeout: DIRECTOR_TIMEOUT_MS });
  await root.locator('.bs-card[data-branch][data-flagged], .bs-card-shrunk[data-flagged]').first().waitFor({ state: 'detached', timeout: DIRECTOR_TIMEOUT_MS }).catch(() => undefined);
  assert.equal(await root.locator('.bs-card[data-branch][data-flagged], .bs-card-shrunk[data-flagged]').count(), 0, 'the flag leaves once a later turn fits the task');
  await pillInput.fill('edit-shop');
  await pillInput.press('Enter');
  await root.locator('.bs-presence-glow[data-tier="edited"]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill after the branch agent edits');
}

async function stopAgentTurn(page: Page, sessionId: string): Promise<void> {
  await controlReplyOf(page, 'chat-stop', { id: sessionId });
}

async function waitForLogAtNewest(page: Page, reason: string): Promise<void> {
  const isAtNewest = () => {
    const log = document.querySelector<HTMLElement>('.board-session-view .bs-log');
    return log !== null && log.clientHeight > 0 && log.scrollHeight > log.clientHeight && log.scrollHeight - log.clientHeight - log.scrollTop <= 1;
  };
  const reachedNewest = await page.waitForFunction(isAtNewest, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS }).then(() => true, () => false);
  assert.equal(reachedNewest, true, reason);
}

async function holdStudioMapBoxesReplies(page: Page): Promise<() => Promise<void>> {
  const heldReplies: (() => void)[] = [];
  let isHolding = true;
  await page.routeWebSocket((url) => url.pathname === '/control', (pageSide) => {
    const serverSide = pageSide.connectToServer();
    pageSide.onMessage((message) => serverSide.send(message));
    serverSide.onMessage((message) => {
      const text = typeof message === 'string' ? message : message.toString('utf8');
      const isStudioBoxesReply = text.includes('"codemap-boxes-of-response"') && !text.includes('harness-boxes-');
      if (isHolding && isStudioBoxesReply) {
        heldReplies.push(() => pageSide.send(message));
        return;
      }
      pageSide.send(message);
    });
    pageSide.onClose(() => serverSide.close());
    serverSide.onClose(() => pageSide.close());
  });
  return async () => {
    await pollFor('Studio to be sent its map boxes while the harness holds the replies', BOARD_SESSION_TIMEOUT_MS, async () => heldReplies.length > 0 ? true : null).catch(() => undefined);
    isHolding = false;
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const sendHeldReply of heldReplies) sendHeldReply();
    assert.ok(heldReplies.length > 0, 'Studio asked for its map boxes while the harness held the replies');
  };
}

async function verifyFirstViewFramesSessionBoxes(page: Page, root: Locator): Promise<void> {
  await root.locator('.bs-card[data-branch]').first().waitFor({ state: 'attached', timeout: BOARD_SESSION_TIMEOUT_MS });
  const { areas, boxRectById } = await studioMapBoxesOf(page, root);
  const areaAnchorBoxIds = new Set(areas.map((area) => area.anchorBoxId));
  const sessionBoxIds = Object.keys(boxRectById).filter((boxId) => !areaAnchorBoxIds.has(boxId));
  const floorScale = readableFloorScale(await root.evaluate((element) => Number.parseFloat(getComputedStyle(element).getPropertyValue('--type-title'))));
  const viewport = await boxOf(page, '.board-session-view .wb-viewport');
  const sessionRects = sessionBoxIds.flatMap((boxId) => boxRectById[boxId] ?? []);
  const sessionLeft = Math.min(...sessionRects.map((rect) => rect.x));
  const sessionRight = Math.max(...sessionRects.map((rect) => rect.x + rect.width));
  const isFirstViewRight = (camera: { x: number; y: number; scale: number }) => {
    if (camera.scale < floorScale - 0.001 || camera.scale > 1.001) return false;
    if (sessionRects.length === 0) return Math.abs(camera.scale - floorScale) < 0.001;
    const sessionCenterPx = viewport.x + ((sessionLeft + sessionRight) / 2 - camera.x) * camera.scale;
    return Math.abs(sessionCenterPx - (viewport.x + viewport.width / 2)) <= FIRST_VIEW_CENTER_TOLERANCE_PX;
  };
  let camera = await studioCameraOf(page);
  await pollFor('the Studio first view to frame the session boxes', BOARD_SESSION_TIMEOUT_MS, async () => {
    camera = await studioCameraOf(page);
    return isFirstViewRight(camera) ? true : null;
  }).catch(() => undefined);
  assert.ok(isFirstViewRight(camera), `after a reload, with the map boxes arriving while Focus shows, Studio frames the session boxes ${JSON.stringify(sessionRects)} between the readable floor ${floorScale} and natural size (camera ${JSON.stringify(camera)})`);
}

async function verifyStudioChatOpensAtNewest(page: Page): Promise<void> {
  const root = page.locator('.board-session-view');
  const releaseMapBoxesReplies = await holdStudioMapBoxesReplies(page);
  await page.reload();
  await page.locator('#tab-board-session').click();
  await root.locator('.bs-card[data-main][data-phase="working"]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-log').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-row-you', { hasText: 'delegate' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await waitForLogAtNewest(page, 'the Studio chat opens on its newest message');
  await page.locator('#tab-focus').click();
  await page.locator('.focus-view').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await releaseMapBoxesReplies();
  await page.locator('#tab-board-session').click();
  await root.locator('.bs-log').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await waitForLogAtNewest(page, 'the Studio chat reopens on its newest message after another tab');
  await verifyFirstViewFramesSessionBoxes(page, root);
}

async function verifyStudioRailShowsNoSubagents(page: Page, studioMainId: string): Promise<void> {
  const root = page.locator('.board-session-view');
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  await stopAgentTurn(page, studioMainId);
  await root.locator('.bs-card[data-main][data-phase="working"]').waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
  await pillInput.fill('');
  await pillInput.press('Escape');
  await root.locator('.bs-pill-address').waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  await pillInput.fill('delegate');
  await pillInput.press('Enter');
  await root.locator('.bs-log .chat-activity', { hasText: 'Using Task' }).waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-card[data-main] .chat-activity').isVisible(), false, 'the Orchestrator card shows no working line; the chat does');
  await root.locator('.bs-row-you', { hasText: 'delegate' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await waitForLogAtNewest(page, 'the Studio chat stays on its newest message as rows arrive');
  const namesSubagent = await page.waitForFunction(() => /subagent/i.test(document.querySelector<HTMLElement>('.board-session-view .bs-dock')?.innerText ?? ''), undefined, { timeout: RAIL_REPAINT_WAIT_MS }).then(() => true, () => false);
  assert.equal(namesSubagent, false, 'the Studio chat names no subagent the main agent runs');
}

async function verifyQueuedMessagesDeliveredOnceInOrder(page: Page, studioMainId: string): Promise<void> {
  const root = page.locator('.board-session-view');
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  const sentRowsOf = (text: string) => root.locator('.bs-row-you:not(.bs-row-queued)', { hasText: text });
  const queuedRowOf = (text: string) => root.locator('.bs-row-queued', { hasText: text });
  const editSentBefore = await sentRowsOf('edit-shop').count();
  const longSentBefore = await sentRowsOf('long-shop').count();
  await root.locator('.bs-log-queue').evaluate((queue, watchedTexts) => {
    if (!(queue instanceof HTMLElement)) return;
    const shownTexts = new Set<string>();
    const noteQueuedRows = () => {
      const queuedTexts = [...queue.querySelectorAll('.bs-row-queued')].map((row) => row.textContent ?? '');
      for (const text of watchedTexts) {
        const isShown = queuedTexts.some((queuedText) => queuedText.includes(text));
        if (isShown) shownTexts.add(text);
        if (!isShown && shownTexts.has(text)) queue.dataset.leftQueueEarly = text;
      }
    };
    new MutationObserver(noteQueuedRows).observe(queue, { childList: true, subtree: true });
  }, ['edit-shop', 'long-shop']);
  for (const queuedText of ['edit-shop', 'long-shop']) {
    await pillInput.fill(queuedText);
    await pillInput.press('Enter');
    await queuedRowOf(queuedText).waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  }
  await page.waitForFunction(() => {
    const queuedRows = [...document.querySelectorAll<HTMLElement>('.board-session-view .bs-row-queued')];
    const isHeld = (text: string) => queuedRows.some((row) => row.dataset.state === 'held' && (row.textContent ?? '').includes(text));
    return isHeld('edit-shop') && isHeld('long-shop') && queuedRows.every((row) => row.dataset.state !== 'pending');
  }, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-log-queue').getAttribute('data-left-queue-early'), null, 'a message sent mid-turn stays queued until the turn ends');
  assert.equal(await queuedRowOf('edit-shop').count(), 1, 'a message sent mid-turn shows once as queued');
  assert.equal(await sentRowsOf('edit-shop').count(), editSentBefore, 'a queued message shows no sent copy');
  await stopAgentTurn(page, studioMainId);
  await queuedRowOf('long-shop').waitFor({ state: 'detached', timeout: DIRECTOR_TIMEOUT_MS });
  await page.waitForFunction(({ editCount, longCount }) => {
    const sentTexts = [...document.querySelectorAll('.board-session-view .bs-row-you[data-part-id]:not(.bs-row-queued)')].map((row) => row.textContent ?? '');
    return sentTexts.filter((text) => text.includes('edit-shop')).length === editCount && sentTexts.filter((text) => text.includes('long-shop')).length === longCount;
  }, { editCount: editSentBefore + 1, longCount: longSentBefore + 1 }, { timeout: DIRECTOR_TIMEOUT_MS });
  await delay(1000);
  assert.equal(await sentRowsOf('edit-shop').count(), editSentBefore + 1, 'the queued message is delivered once');
  assert.equal(await sentRowsOf('long-shop').count(), longSentBefore + 1, 'the second queued message is delivered once');
  const sentOrder = await root.locator('.bs-row-you:not(.bs-row-queued)').evaluateAll((rows) => rows.map((row) => row.textContent ?? ''));
  assert.ok(sentOrder.findLastIndex((text) => text.includes('edit-shop')) < sentOrder.findLastIndex((text) => text.includes('long-shop')), 'queued messages are delivered in the order sent');
  await pillInput.fill('narrate');
  await pillInput.press('Enter');
  await root.locator('.bs-card[data-main][data-phase="working"]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
}

const SentControlFrame = z.object({ type: z.string(), endingAt: z.unknown().optional(), knownVersion: z.number().nullable().optional() }).passthrough();

async function verifyStudioReopenKeepsState(page: Page, orchestratorFace: Locator): Promise<void> {
  await page.evaluate(() => {
    const recorded: string[] = [];
    Reflect.set(window, '__sentControlFrames', recorded);
    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function recordAndSend(frame) {
      if (typeof frame === 'string') recorded.push(frame);
      nativeSend.call(this, frame);
    };
  });
  await page.locator('#tab-settings').click();
  await page.locator('#tab-board-session').click();
  await orchestratorFace.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await delay(ADDRESS_SETTLE_MS);
  const sentFrames = z.array(z.string()).parse(await page.evaluate(() => Reflect.get(window, '__sentControlFrames'))).map((frame) => SentControlFrame.parse(JSON.parse(frame)));
  const seedTraceReads = sentFrames.filter((frame) => frame.type === 'session-trace' && frame.endingAt === 'tail');
  assert.equal(seedTraceReads.length, 0, `reopening Studio reads only new trace records, never a session's tail again (${seedTraceReads.length} tail reads)`);
  const freshTileViews = sentFrames.filter((frame) => frame.type === 'whiteboard-view' && frame.knownVersion === null);
  assert.equal(freshTileViews.length, 0, `reopening Studio asks for the map with the tile version it holds, so only missing tiles come back (${freshTileViews.length} fresh views)`);
}

async function verifyStudioModelSwitch(page: Page, root: Locator): Promise<void> {
  const railModelButton = root.locator('.bs-pill .chat-rail').getByRole('button', { name: /^Change model/ });
  await railModelButton.waitFor({ timeout: RAIL_REPAINT_WAIT_MS });
  await railModelButton.click();
  const modelPanel = root.locator('.bs-pill .chat-model-pick');
  await modelPanel.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  const panelBox = await modelPanel.boundingBox();
  const pillBox = await boxOf(page, '.board-session-view .bs-pill');
  assert.ok(panelBox && panelBox.y + panelBox.height <= pillBox.y && panelBox.y >= 0, 'the model panel opens on screen above the Studio message bar');
  await page.keyboard.press('Escape');
  await modelPanel.waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
  await railModelButton.click();
  const nextModelRow = modelPanel.locator('.add-session-row[aria-selected="false"][data-key^="native:"]').first();
  const nextModelKey = await nextModelRow.getAttribute('data-key');
  await nextModelRow.click();
  const defaultEffortRow = modelPanel.locator('.add-session-row[data-key="default"]');
  if ((await defaultEffortRow.count()) > 0) await defaultEffortRow.click();
  await modelPanel.waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.waitForFunction((expectedKey) => {
    const railButton = document.querySelector<HTMLButtonElement>('.board-session-view .bs-pill .chat-rail-model');
    if (railButton === null || railButton.hidden) return false;
    if (document.querySelector('.board-session-view .bs-pill .chat-model-pick') !== null) railButton.click();
    railButton.click();
    const pickedRow = document.querySelector('.board-session-view .bs-pill .chat-model-pick .add-session-row[aria-selected="true"]');
    return pickedRow?.getAttribute('data-key') === expectedKey;
  }, nextModelKey, { timeout: RAIL_REPAINT_WAIT_MS, polling: 500 });
  await page.keyboard.press('Escape');
  await modelPanel.waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
}

export async function verifyBoardSession(page: Page, projectDirectory: string): Promise<void> {
  const openedTerminalSessionIds: string[] = [];
  const recordTerminalSocket = (socket: { url(): string }) => {
    const match = /\/terminals\/([^/?#]+)/.exec(socket.url());
    if (match?.[1]) openedTerminalSessionIds.push(decodeURIComponent(match[1]));
  };
  page.on('websocket', recordTerminalSocket);
  const studioSessionIds = new Set<string>();
  const collectStudioSessionIds = async (root: Locator) => {
    const cardIds = await root.locator('.bs-card[data-session-id]').evaluateAll((cards) => cards.flatMap((card) => card.getAttribute('data-session-id') ?? []));
    for (const cardId of cardIds) studioSessionIds.add(cardId);
  };
  const assertNoStudioTerminalAttach = (stage: string) => {
    const studioTerminalAttaches = openedTerminalSessionIds.filter((sessionId) => studioSessionIds.has(sessionId));
    assert.deepEqual(studioTerminalAttaches, [], `Studio ACP sessions never open a /terminals/ socket (${stage})`);
  };
  try {
    await verifyBoardSessionBody(page, projectDirectory, collectStudioSessionIds, assertNoStudioTerminalAttach);
  } finally {
    page.off('websocket', recordTerminalSocket);
  }
}

async function verifyBoardSessionBody(
  page: Page,
  projectDirectory: string,
  collectStudioSessionIds: (root: Locator) => Promise<void>,
  assertNoStudioTerminalAttach: (stage: string) => void,
): Promise<void> {
  const root = page.locator('.board-session-view');
  await page.locator('#tab-board-session').click();
  const chip = root.locator('button.bs-chip');
  await chip.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-chip-name').textContent(), 'No repo', 'Studio lists no Focus session repo');
  await chip.click();
  await root.locator('[data-action="board-session-open-repo"]').click();
  const picker = page.locator('.add-session-dialog');
  await picker.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await picker.locator('.add-session-row', { hasText: 'Claude Code' }).click();
  await picker.locator('.add-session-row', { hasText: 'Any folder' }).click();
  await picker.locator('#add-session-path').fill(projectDirectory);
  await picker.getByRole('button', { name: 'Start session', exact: true }).click();
  const repoButton = root.locator('.bs-card[data-main] .bs-card-repo');
  await page.waitForFunction(() => document.querySelector('.board-session-view .bs-card[data-main] .bs-card-repo-name')?.textContent === 'Orchestrator', undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  await collectStudioSessionIds(root);
  assertNoStudioTerminalAttach('after Orchestrator start');
  assert.equal(await chip.isHidden(), true, 'the Orchestrator card holds the menu, so the repo pill hides');
  await root.locator('.bs-guide:not([hidden])').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.waitForFunction(() => {
    const notice = document.querySelector<HTMLElement>('.board-session-view .bs-notice');
    const canvas = document.querySelector<HTMLCanvasElement>('.board-session-view canvas.wb-gl');
    return (notice !== null && !notice.hidden && (notice.textContent ?? '').length > 0) || (canvas !== null && canvas.width > 0 && notice?.hidden === true);
  }, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-log').isVisible(), false, 'the chat log stays folded on open');
  await verifyFirstViewClearOfBar(page);
  await verifyStudioCameraKeptAcrossFocusBoard(page);
  assert.equal(await root.locator('.bs-top-left > :not(.bs-chip, .bs-menu)').count(), 0, 'the top left holds only the repo chip');
  await page.locator('.session-name', { hasText: /^Orchestrator$/ }).first().waitFor({ state: 'attached', timeout: BOARD_SESSION_TIMEOUT_MS });

  await root.locator(MESSAGE_BAR_SELECTOR).click();
  await root.locator('.bs-log').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await repoButton.click();
  await root.locator('.bs-log').waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  const menu = root.getByRole('menu');
  await menu.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await menu.getByRole('menuitemradio').count(), 0, 'Studio shows every repo, so the menu has none to pick');
  assert.equal(await menu.locator('[data-action="board-session-agent-restart"]').textContent(), 'Restart Orchestrator', 'the one menu holds the Orchestrator actions');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });

  const pillBefore = await boxOf(page, '.board-session-view .bs-pill');
  assert.equal(await root.locator('.bs-pill.chat-composer textarea.chat-composer-input').count(), 1, 'the message bar is Chat\'s composer');
  const repoButtonBefore = await boxOf(page, '.board-session-view .bs-card[data-main] .bs-card-repo');
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.board-session-view .bs-notice')?.hidden === true, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-guide-step[data-done]').count(), 0, 'a new carbon unit starts with no guide step done');
  const repoName = path.basename(projectDirectory);
  const foldedBoardId = await studioMapBoardIdOf(page, root);
  assert.ok(foldedBoardId, 'the Studio map has a board');
  const isRepoAreaFolded = async () => {
    const areaFrame = (await boardElementsOf(page, root, foldedBoardId)).find((element) => element.kind === 'frame' && element.title === repoName);
    return areaFrame?.kind === 'frame' ? areaFrame.collapsed : null;
  };
  await pollFor('the repo with no working agent to show folded to one card', BOARD_SESSION_TIMEOUT_MS, async () => await isRepoAreaFolded() === true ? true : null);
  await clickBoardBoxWhere(page, root, foldedBoardId, (element) => element.kind === 'box' && element.title === repoName);
  await pollFor('the folded repo to open when its card is clicked', BOARD_SESSION_TIMEOUT_MS, async () => await isRepoAreaFolded() === false ? true : null);
  assert.equal(await root.getByRole('button', { name: 'Add note', exact: true }).count(), 0, 'clicking a map card never selects it for editing');
  await clickBoardBoxWhere(page, root, foldedBoardId, (element) => element.kind === 'box' && element.title === repoName);
  await pollFor('the open repo to fold when its card is clicked again', BOARD_SESSION_TIMEOUT_MS, async () => await isRepoAreaFolded() === true ? true : null);
  await clickBoardBoxWhere(page, root, foldedBoardId, (element) => element.kind === 'box' && element.title === repoName);
  await pollFor('the folded repo to open again on a third click', BOARD_SESSION_TIMEOUT_MS, async () => await isRepoAreaFolded() === false ? true : null);
  await root.getByRole('button', { name: 'Fit', exact: true }).click();
  await delay(MAP_GLIDE_SETTLE_MS);

  await pillInput.fill('edit-shop');
  await pillInput.press('Enter');
  await root.locator('.bs-guide-step[data-done]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-row-agent:not([hidden]) .bs-last-reply', { hasText: 'The charge goes through' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  const orchestratorFace = root.locator('.bs-card[data-main] .bs-face-main').first();
  await orchestratorFace.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.locator('#tab-focus').click();
  await page.locator('#tab-board-session').click();
  await orchestratorFace.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill after the Orchestrator replies');
  await verifyStudioReopenKeepsState(page, orchestratorFace);
  await verifyStudioModelSwitch(page, root);

  const mapViewport = root.locator('.wb-viewport');
  const panAwayFrom = await mapViewport.boundingBox();
  assert.ok(panAwayFrom, 'the Studio map is on screen');
  const steadyBoardId = foldedBoardId;
  const panMap = async (deltaY: number) => {
    await page.mouse.move(panAwayFrom.x + 30, panAwayFrom.y + panAwayFrom.height / 2);
    for (let step = 0; step < MAP_PAN_STEPS; step += 1) await page.mouse.wheel(0, deltaY);
  };

  await pillInput.fill('ask-question-resume');
  await pillInput.press('Enter');
  const askingMainCard = root.locator('.bs-card[data-main][data-asking]');
  const heldQuestion = askingMainCard.locator('.chat-card[data-card-type="question"][data-resolved="false"]');
  await heldQuestion.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await heldQuestion.getByRole('button', { name: /^Run both for a week/ }).click();
  await root.locator('.bs-row-agent', { hasText: RESUMED_AFTER_QUESTION_TEXT }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await askingMainCard.waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });

  await pillInput.fill('long-shop');
  await pillInput.press('Enter');
  await root.locator('.bs-row-you', { hasText: 'long-shop' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.locator('#tab-focus').click();
  await page.locator('.focus-view').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await delay(DIRECTOR_AWAY_MS);
  await page.locator('#tab-board-session').click();
  await pillInput.click();
  const directedLine = root.locator('.bs-row-agent .bs-digest', { hasText: DIRECTOR_DIGEST_TEXT }).first();
  await directedLine.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-log', { hasText: 'The tax table is read once' }).count(), 0, 'a chat line kept while Studio was away replaces the last reply');
  assert.equal(await root.locator('.bs-row-agent:not([hidden]) .bs-last-reply', { hasText: 'The charge goes through' }).count(), 1, 'a turn the director gives no chat line shows the agent\'s last reply');
  const directedBubble = root.locator('.bs-row-agent', { has: page.locator('.bs-digest', { hasText: DIRECTOR_DIGEST_TEXT }) }).first().locator('.bs-bubble-agent');
  const logBefore = await boxOf(page, '.board-session-view .bs-pill');
  await directedBubble.click();
  await root.locator('.bs-full-reply', { hasText: 'The tax table is read once' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await directedBubble.getAttribute('aria-expanded'), 'true', 'clicking a chat line opens the whole reply');
  await directedBubble.locator('.bs-digest').click();
  await root.locator('.bs-full-reply').first().waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
  assertSameBox(logBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill after a reply opens and closes');

  await pillInput.fill('How is it going?');
  await pillInput.press('Enter');
  const progressRow = root.locator('.bs-row-glimmervoid', { hasText: STUDIO_PROGRESS_ANSWER });
  await progressRow.waitFor({ timeout: DIRECTOR_TIMEOUT_MS });
  assert.equal(await progressRow.locator('.bs-bubble-who').textContent(), 'Glimmervoid', 'Glimmervoid answers how it is going');
  assert.equal(await root.locator('.bs-row-you[data-part-id]', { hasText: 'How is it going?' }).count(), 0, 'a progress question never reaches the main agent');
  await pillInput.fill('Where does tax get added?');
  await pillInput.press('Enter');
  await root.locator('.bs-row-you[data-part-id]', { hasText: 'Where does tax get added?' }).first().waitFor({ timeout: DIRECTOR_TIMEOUT_MS });

  await verifyBranch(page, pillBefore);

  const branchCardOffsetFromMap = async () => {
    const [firstBoxRect] = (await boxScreenRectsOf(page, root, steadyBoardId)).values();
    const branchCardRect = await root.locator('.bs-card[data-branch]:not([hidden]), .bs-card-shrunk:not([hidden])').first().boundingBox();
    assert.ok(firstBoxRect && branchCardRect, 'the branch card and a map box are laid out');
    return { x: Math.round(branchCardRect.x - firstBoxRect.x), y: Math.round(branchCardRect.y - firstBoxRect.y) };
  };
  const orchestratorCardBefore = await boxOf(page, '.board-session-view .bs-card[data-main]');
  const offsetBeforePan = await branchCardOffsetFromMap();
  await page.mouse.move(panAwayFrom.x + 30, panAwayFrom.y + panAwayFrom.height / 2);
  for (let step = 0; step < STEADY_PAN_STEPS; step += 1) {
    await page.mouse.wheel(STEADY_PAN_STEP_PX, 0);
    await pollFor(`the branch card to move with the map while it pans (step ${step + 1})`, STEADY_PAN_SETTLE_MS, async () => {
      const offset = await branchCardOffsetFromMap();
      return offset.x === offsetBeforePan.x && offset.y === offsetBeforePan.y ? offset : null;
    });
  }
  assertSameBox(orchestratorCardBefore, await boxOf(page, '.board-session-view .bs-card[data-main]'), 'the Orchestrator card, which belongs to no repo, while the map pans');
  for (let step = 0; step < STEADY_PAN_STEPS; step += 1) await page.mouse.wheel(-STEADY_PAN_STEP_PX, 0);
  await panMap(-MAP_PAN_STEP_PX);
  await pillInput.fill('ask-shop');
  await pillInput.press('Enter');
  const reuseOption = page.getByRole('button', { name: /^Yes, reuse it/ });
  const askCard = root.locator('.bs-ask', { has: reuseOption });
  await askCard.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await askCard.locator('.chat-card[data-card-type="question"] .chat-card-option').count(), 2, 'the board ask shows as Chat\'s question card with its options');
  assert.equal(await askCard.locator('.chat-card-heading').textContent(), BOARD_ASK_QUESTION, 'the card shows the whole question');
  assert.equal(await askCard.getByRole('button', { name: 'Send answer', exact: true }).isDisabled(), true, 'Send answer waits for typed text');
  const askBoxId = await askCard.getAttribute('data-ask-box-id');
  const askCardRect = await askCard.boundingBox();
  assert.ok(askBoxId && askCardRect, 'the ask card names its box and is on screen');
  const boxRects = await boxScreenRectsOf(page, root, steadyBoardId);
  const askBoxRect = boxRects.get(askBoxId);
  const ringCoverPx = 8;
  assert.ok(askBoxRect && Math.abs(askBoxRect.x - askCardRect.x) < ringCoverPx && Math.abs(askBoxRect.y - askCardRect.y) < ringCoverPx && Math.abs(askBoxRect.width - askCardRect.width) < ringCoverPx * 2 && Math.abs(askBoxRect.height - askCardRect.height) < ringCoverPx * 2, 'the ask card sits on its own box');
  const coveredBoxIds = [...boxRects].filter(([boxId, rect]) => boxId !== askBoxId && rect.x < askCardRect.x + askCardRect.width && askCardRect.x < rect.x + rect.width && rect.y < askCardRect.y + askCardRect.height && askCardRect.y < rect.y + rect.height).map(([boxId]) => boxId);
  assert.deepEqual(coveredBoxIds, [], 'the ask card covers no map box');
  await askCard.locator('.chat-card-option').first().click();
  await askCard.waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-row-you[hidden]', { hasText: 'Yes, reuse it' }).first().waitFor({ state: 'attached', timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-row-you:not([hidden])', { hasText: 'Yes, reuse it' }).count(), 0, 'a board answer adds no message to the Studio chat');
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill after the ask resolves');
  await delay(MAP_GLIDE_SETTLE_MS);
  await panMap(MAP_PAN_STEP_PX);
  await clearAddress(page);

  await pillInput.fill('narrate');
  const sendButton = root.locator('.bs-pill .chat-composer-send');
  assert.equal(await sendButton.isEnabled(), true, 'Send turns on once the pill holds text');
  await pillInput.press('Enter');
  await root.locator('.bs-row-you', { hasText: 'narrate' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-row-agent:not([hidden]) .bs-face').count() > 0, true, 'an agent chat line carries the agent face');
  await root.locator('.bs-card[data-main][data-phase="working"]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-log .chat-activity[data-phase="working"]').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-card[data-main]').count(), 1, 'the main agent has exactly one card');
  assert.equal(await root.locator('.bs-log', { hasText: 'npm test -- run-1' }).count(), 0, 'the Studio log shows replies, not tool calls');
  assert.equal(await sendButton.getAttribute('aria-label'), 'Send', 'Send keeps its label after a send');
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill');
  const fontSizeOf = (selector: string) => root.locator(selector).first().evaluate((element) => getComputedStyle(element).fontSize);
  assert.equal(await fontSizeOf('.bs-pill textarea.chat-composer-input'), await fontSizeOf('.bs-row-agent:not([hidden]) .bs-bubble'), 'the message bar types at the log bubbles\' size');
  const openLog = await boxOf(page, '.board-session-view .bs-log');
  assert.ok(Math.abs(openLog.x - pillBefore.x) <= LAYOUT_TOLERANCE_PX && Math.abs(openLog.width - pillBefore.width) <= LAYOUT_TOLERANCE_PX, `the message bar shares the open log's width and edges (bar ${pillBefore.x}+${pillBefore.width}, log ${openLog.x}+${openLog.width})`);
  assert.equal((await boxOf(page, '.board-session-view .bs-card[data-main] .bs-card-repo')).height, repoButtonBefore.height, 'the repo name keeps its height');
  assert.equal(await root.locator('.wb-island-board').isVisible(), false, 'Studio hides the board title island; the repo chip names the map');
  await root.locator('.wb-island-board .wb-status').evaluate((status: HTMLElement) => { status.hidden = false; status.textContent = 'Could not undo that change.'; });
  assert.equal(await root.locator('.wb-island-board .wb-status').isVisible(), true, 'a board error still shows in Studio');
  assert.equal(await root.locator('.wb-island-board .wb-board-title').isVisible(), false, 'the board title stays hidden while an error shows');
  await root.locator('.wb-island-board .wb-status').evaluate((status: HTMLElement) => { status.hidden = true; status.textContent = ''; });
  assert.equal(await root.locator('.wb-island-agent').isVisible(), false, 'Studio shows no pairing notice for its main agent');
  assert.equal(await root.locator('.bs-activity').count(), 0, 'the working status shows on the face only');


  const mapReply = await studioMapBoardIdOf(page, root);
  assert.ok(mapReply, 'the Studio map has a board');
  await clickBoardBoxWhere(page, root, mapReply, (element) => element.kind === 'box' && element.title === 'repo root' && element.lines.some((line) => line.text.includes('crossed wires')));
  await hoverBoardBoxWhere(page, root, mapReply, (element) => element.kind === 'box' && element.title === 'repo root' && element.lines.some((line) => line.text.includes('imported by')));
  const changedFile = root.locator('.bs-changes:not([hidden]) .bs-changes-row', { has: page.locator('.bs-changes-path', { hasText: 'src/payments/refund-policy.js' }) });
  await changedFile.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.match(String(await changedFile.locator('.bs-changes-counts').innerText()), /^\+\d+\s+-\d+$/, 'hovering a changed box lists each file with lines added and removed');
  await changedFile.locator('.bs-changes-path').click();
  const diffPanel = root.locator('.bs-diff-panel:not([hidden])');
  await diffPanel.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await diffPanel.locator('.bs-diff-title').textContent(), 'src/payments/refund-policy.js', 'clicking a changed file opens its diff in the side panel');
  await page.waitForFunction(() => (document.querySelector('.board-session-view .bs-diff-host')?.childElementCount ?? 0) > 0, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  await diffPanel.locator('.bs-diff-body').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Escape');
  await diffPanel.waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });

  await clickBoardBoxWhere(page, root, mapReply, (element) => element.kind === 'box' && element.title.startsWith('Map at'));
  assert.equal(await root.locator('.bs-pill-address').isHidden(), true, 'a box that is not a folder or file on the map takes no address');
  const barInput = root.locator(MESSAGE_BAR_SELECTOR);
  const barAddress = root.locator('.bs-pill-address-text');
  const repoRootAddress = root.locator('.bs-pill-address-text', { hasText: /^New branch on \S+ repo root$/ });
  const addressRepoRoot = async () => {
    const deadline = Date.now() + BOARD_SESSION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await clickBoardBoxWhere(page, root, mapReply, (element) => element.kind === 'box' && element.title === 'repo root');
      const isAddressed = await repoRootAddress.waitFor({ timeout: ADDRESS_SETTLE_MS }).then(() => true, () => false);
      if (isAddressed) return;
    }
    assert.fail('clicking the repo root box, after its stack opens, puts its address in the message bar');
  };
  await addressRepoRoot();
  assert.equal(await barInput.evaluate((input) => input === document.activeElement), true, 'clicking a box focuses the message bar');
  await barInput.press('Escape');
  await root.locator('.bs-pill-address').waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  await addressRepoRoot();
  assert.match(String(await barAddress.textContent()), /^New branch on /, 'a box address starts a new agent on it');
  await barInput.fill('work');
  await barInput.press('Enter');
  await root.locator('.bs-failure:not([hidden])', { hasText: 'already works on repo root' }).waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.match(String(await barAddress.textContent()), /^New branch on \S+ repo root$/, 'a refused box address stays in the bar to retarget');

  const [studioArea] = (await studioMapBoxesOf(page, root)).areas;
  assert.ok(studioArea, 'Studio has a repo area');
  const repoAgentMark = root.locator(`.bs-repo-agent[data-repo-key="${studioArea.repoKey}"]`);
  assert.equal(await repoAgentMark.getAttribute('aria-label'), `Branch agent of ${studioArea.repoName}`, 'the repo card carries the agent its branches run');
  await repoAgentMark.click();
  const repoDialog = page.locator('.add-session-dialog');
  await repoDialog.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await repoDialog.locator('#add-session-path').inputValue(), studioArea.repoDir, 'the agent mark of a repo opens the repo dialog on that repo, to change its branch agent');
  await repoDialog.getByRole('button', { name: 'Cancel' }).click();
  await repoDialog.waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });

  const mainCard = root.locator('.bs-card[data-main]').first();
  const studioMainId = await mainCard.getAttribute('data-session-id');
  assert.ok(studioMainId, 'the Studio main shows as a card');
  await verifyStudioRailShowsNoSubagents(page, studioMainId);
  await verifyStudioChatOpensAtNewest(page);
  await verifyQueuedMessagesDeliveredOnceInOrder(page, studioMainId);
  assert.equal(await mainCard.locator('[data-action="board-session-agent-menu"]').isHidden(), true, 'the Orchestrator card has no second menu button');
  await repoButton.click();
  await root.getByRole('menuitem', { name: 'Restart Orchestrator', exact: true }).click();
  const restartDialog = page.locator('.resume-dialog');
  await restartDialog.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await restartDialog.getByRole('option', { name: /^Fresh start/ }).click();
  await restartDialog.getByRole('button', { name: 'Restart', exact: true }).click();
  await restartDialog.waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
  await mainCard.evaluate((card) => {
    if (!(card instanceof HTMLElement)) return;
    card.dataset.seenPhases = '';
    new MutationObserver(() => { card.dataset.seenPhases += ` ${card.dataset.phase ?? ''}`; }).observe(card, { attributes: true, attributeFilter: ['data-phase'] });
  });
  await page.getByRole('button', { name: 'Restart fresh', exact: true }).click();
  await page.getByRole('button', { name: 'Restart fresh', exact: true }).waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
  await pollFor('the Orchestrator card to show Starting while it restarts', BOARD_SESSION_TIMEOUT_MS, async () => /\bstarting\b/.test(await mainCard.getAttribute('data-seen-phases') ?? '') ? true : null);
  await root.locator('.bs-pill-address').waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  await verifyShownPageOnMap(page);
  await verifyPrCardOnMap(page);
  await verifyStalledAgentShowsFailureWithoutTerminal(root);
  await collectStudioSessionIds(root);
  assertNoStudioTerminalAttach('across model switch, branch, reload, restart, and stall');
  await page.locator('#tab-focus').click();
  await page.locator('.focus-view').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.isHidden(), true, 'the Studio tab hides when Focus opens');
  await page.locator('.focus-view button.session-row[data-id]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await page.locator(`.focus-view button.session-row[data-id="${studioMainId}"]`).count(), 0, 'the Studio main stays out of Focus session rows');
}

async function verifyStalledAgentShowsFailureWithoutTerminal(root: Locator): Promise<void> {
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  await pillInput.fill('stall-fail');
  await pillInput.press('Enter');
  const failedCard = root.locator('.bs-card[data-main][data-failed]');
  await failedCard.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  const failureLine = failedCard.locator('.bs-card-failure:not([hidden])');
  await failureLine.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  const failureText = (await failureLine.textContent())?.trim() ?? '';
  assert.ok(failureText.length > 0, 'a stalled Studio agent shows its failure on its Studio card');
  assert.equal(/terminal/i.test(failureText), false, `Studio agent failure text never mentions a terminal (got ${JSON.stringify(failureText)})`);
  const failedQueueRow = root.locator('.bs-row-queued[data-state="failed"]').first();
  await failedQueueRow.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  const queueStatusText = (await failedQueueRow.locator('.bs-queued-status').textContent())?.trim() ?? '';
  assert.ok(queueStatusText.length > 0, 'the Studio dock shows the failed message status');
  assert.equal(/terminal/i.test(queueStatusText), false, `Studio dock failure status never mentions a terminal (got ${JSON.stringify(queueStatusText)})`);
  assert.equal(await root.getByRole('button', { name: /terminal/i }).count(), 0, 'Studio offers no Open Terminal button when an agent stalls');
  assert.equal(await root.locator('.chat-card[data-card-type="live-terminal"], .chat-terminal-slot').count(), 0, 'Studio renders no live-terminal card or terminal slot when an agent stalls');
}
