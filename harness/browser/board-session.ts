import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page } from 'playwright-core';
import { BOARD_ASK_QUESTION, DIRECTOR_DIGEST_TEXT, RESUMED_AFTER_QUESTION_TEXT, SHOWN_PAGE_TICKED_TEXT, STUDIO_PROGRESS_ANSWER } from './cases-core.ts';
import fs from 'node:fs';
import { boardElementsOf, boxBoardRectsOf, boxScreenRectsOf, clickBoardBoxWhere, hoverBoardBoxWhere } from './boards.ts';
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
const REFUNDS_COMMIT_SUBJECT = 'Add refunds beside the card module';

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

function branchesHoldingRefunds(projectDirectory: string): number {
  const sha = execFileSync('git', ['-C', projectDirectory, 'log', '--all', '--format=%H', `--grep=${REFUNDS_COMMIT_SUBJECT}`], { encoding: 'utf8' }).trim().split('\n')[0] ?? '';
  if (sha.length === 0) return 0;
  return execFileSync('git', ['-C', projectDirectory, 'branch', '--contains', sha], { encoding: 'utf8' }).split('\n').filter((line) => line.trim().length > 0).length;
}

async function waitForRefundsInParent(projectDirectory: string): Promise<void> {
  const deadline = Date.now() + BOARD_SESSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (branchesHoldingRefunds(projectDirectory) >= 2) return;
    await delay(MERGE_POLL_MS);
  }
  assert.fail(`the branch commit reached ${branchesHoldingRefunds(projectDirectory)} branch, not the branch and its parent`);
}

async function studioMapBoardIdOf(page: Page, root: Locator): Promise<string | null> {
  const mapSessionId = await root.locator('.bs-card[data-main]').first().getAttribute('data-session-id');
  assert.ok(mapSessionId, 'the main card names its session');
  return page.evaluate(async (sessionId) => {
    const tokenReply: unknown = await fetch('/control-token', { credentials: 'same-origin', cache: 'no-store' }).then((response) => response.json());
    const token = typeof tokenReply === 'object' && tokenReply !== null && 'token' in tokenReply && typeof tokenReply.token === 'string' ? tokenReply.token : '';
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/control?token=${encodeURIComponent(token)}`);
    const requestId = `harness-boxes-${Date.now()}`;
    return new Promise<string | null>((resolve) => {
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'codemap-boxes-of', requestId, id: sessionId, paths: [] })));
      socket.addEventListener('message', (event) => {
        const reply: unknown = JSON.parse(String(event.data));
        if (typeof reply !== 'object' || reply === null || Reflect.get(reply, 'requestId') !== requestId) return;
        socket.close();
        const boardId = Reflect.get(reply, 'boardId');
        resolve(typeof boardId === 'string' ? boardId : null);
      });
    });
  }, mapSessionId);
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

async function bringBoxIntoView(page: Page, root: Locator, boardId: string, boxId: string): Promise<void> {
  const viewport = await root.locator('.wb-viewport').boundingBox();
  const cardOnScreen = (await boxScreenRectsOf(page, root, boardId)).get(boxId);
  assert.ok(viewport && cardOnScreen, 'the map and the card are laid out');
  const center = { x: cardOnScreen.x + cardOnScreen.width / 2, y: cardOnScreen.y + cardOnScreen.height / 2 };
  const isInView = center.x > viewport.x && center.x < viewport.x + viewport.width && center.y > viewport.y && center.y < viewport.y + viewport.height;
  if (isInView) return;
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
  assert.equal(await root.locator('.bs-pill-address').isHidden(), true, 'clicking the pull request card does not address the message bar');
}

async function verifyBranch(page: Page, projectDirectory: string, pillBefore: Box): Promise<void> {
  const root = page.locator('.board-session-view');
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  const addressText = root.locator('.bs-pill-address-text');
  await pillInput.fill('@card');
  const mention = root.getByRole('option').first();
  await mention.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.match(await mention.textContent() ?? '', /card/, 'the box picker offers the card file');
  await pillInput.press('Enter');
  await page.waitForFunction(() => (document.querySelector('.board-session-view .bs-pill-address-text')?.textContent ?? '').startsWith('New branch on'), undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await pillInput.inputValue(), '', 'picking a box takes the @ mention out of the pill');
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill with a branch address');
  await pillInput.fill('Add refunds');
  await pillInput.press('Enter');
  const branchReply = root.locator('.bs-row-agent.bs-row-branch', { hasText: 'Committed refunds' }).first();
  await branchReply.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-row-you.bs-row-branch', { hasText: 'Add refunds' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-row-you.bs-row-branch', { hasText: 'You are a branch' }).count(), 0, 'the branch bubble shows only what the operator typed');
  await waitForRefundsInParent(projectDirectory);
  const branchFace = root.locator('.bs-card-shrunk:not([hidden]) .bs-card-shrunk-face').first();
  await branchFace.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-card[data-branch]:not([hidden])').count(), 0, 'an idle branch shows only its face');
  await branchFace.click();
  await root.locator('.bs-card[data-branch]:not([hidden])').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });

  await root.locator('.bs-pill-address-clear').click();
  await addressText.waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  await branchReply.locator('.bs-face').click();
  await page.waitForFunction(() => (document.querySelector('.board-session-view .bs-pill-address-text')?.textContent ?? '').startsWith('To '), undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  await pillInput.fill('branch-follow-up');
  await pillInput.press('Enter');
  await root.locator('.bs-row-agent.bs-row-branch', { hasText: 'Refunds reuse' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-pill-address-clear').click();
  await addressText.waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill after the branch');
}

async function typeIntoAgent(page: Page, sessionId: string, command: string): Promise<void> {
  await page.evaluate(async ({ targetId, frame }) => {
    const tokenReply: unknown = await fetch('/control-token', { credentials: 'same-origin', cache: 'no-store' }).then((response) => response.json());
    const token = typeof tokenReply === 'object' && tokenReply !== null && 'token' in tokenReply && typeof tokenReply.token === 'string' ? tokenReply.token : '';
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/terminals/${encodeURIComponent(targetId)}?token=${encodeURIComponent(token)}`);
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    socket.send(JSON.stringify({ type: 'input', data: frame }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    socket.close();
  }, { targetId: sessionId, frame: `${String.fromCharCode(0x1b)}]7777;${command}${String.fromCharCode(0x07)}` });
}

async function waitForLogAtNewest(page: Page, reason: string): Promise<void> {
  const isAtNewest = () => {
    const log = document.querySelector<HTMLElement>('.board-session-view .bs-log');
    return log !== null && log.clientHeight > 0 && log.scrollHeight > log.clientHeight && log.scrollHeight - log.clientHeight - log.scrollTop <= 1;
  };
  await page.waitForFunction(isAtNewest, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS }).catch(() => undefined);
  assert.equal(await page.evaluate(isAtNewest), true, reason);
}

async function verifyStudioChatOpensAtNewest(page: Page): Promise<void> {
  const root = page.locator('.board-session-view');
  await page.reload();
  await page.locator('#tab-board-session').click();
  await root.locator('.bs-card[data-main][data-phase="working"]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-log').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-row-you', { hasText: 'delegate' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await waitForLogAtNewest(page, 'the Studio chat opens on its newest message');
  await page.locator('#tab-focus').click();
  await page.locator('.focus-view').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.locator('#tab-board-session').click();
  await root.locator('.bs-log').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await waitForLogAtNewest(page, 'the Studio chat reopens on its newest message after another tab');
}

async function verifyStudioRailShowsNoSubagents(page: Page, studioMainId: string): Promise<void> {
  const root = page.locator('.board-session-view');
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  await typeIntoAgent(page, studioMainId, 'stop');
  await root.locator('.bs-card[data-main][data-phase="working"]').waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
  await pillInput.fill('');
  await pillInput.press('Escape');
  await root.locator('.bs-pill-address').waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  await pillInput.fill('delegate');
  await pillInput.press('Enter');
  await root.locator('.bs-card[data-main]', { hasText: 'Using Task' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
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
  for (const queuedText of ['edit-shop', 'long-shop']) {
    await pillInput.fill(queuedText);
    await pillInput.press('Enter');
    await queuedRowOf(queuedText).waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.board-session-view .bs-row-queued .bs-queued-status')].every((status) => status.textContent === 'Queued'), undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await queuedRowOf('edit-shop').count(), 1, 'a message sent mid-turn shows once as queued');
  assert.equal(await sentRowsOf('edit-shop').count(), editSentBefore, 'a queued message shows no sent copy');
  await typeIntoAgent(page, studioMainId, 'stop');
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

export async function verifyBoardSession(page: Page, projectDirectory: string): Promise<void> {
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
  await page.waitForFunction(() => {
    const name = document.querySelector('.board-session-view .bs-card[data-main] .bs-card-repo-name')?.textContent ?? '';
    return name.length > 0 && name !== 'No repo';
  }, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await chip.isHidden(), true, 'the Orchestrator card names the repo, so the repo pill hides');
  await root.locator('.bs-guide:not([hidden])').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.waitForFunction(() => {
    const notice = document.querySelector<HTMLElement>('.board-session-view .bs-notice');
    const canvas = document.querySelector<HTMLCanvasElement>('.board-session-view canvas.wb-gl');
    return (notice !== null && !notice.hidden && (notice.textContent ?? '').length > 0) || (canvas !== null && canvas.width > 0 && notice?.hidden === true);
  }, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-log').isVisible(), false, 'the chat log stays folded on open');
  assert.equal(await root.locator('.bs-top-left > :not(.bs-chip, .bs-menu)').count(), 0, 'the top left holds only the repo chip');
  await page.locator('.session-name', { hasText: / main$/ }).first().waitFor({ state: 'attached', timeout: BOARD_SESSION_TIMEOUT_MS });

  await root.locator(MESSAGE_BAR_SELECTOR).click();
  await root.locator('.bs-log').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await repoButton.click();
  await root.locator('.bs-log').waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  const menu = root.getByRole('menu');
  await menu.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.ok((await menu.getByRole('menuitemradio', { checked: true }).count()) === 1, 'the repo menu marks the shown repo');
  assert.equal(await menu.locator('[data-action="board-session-agent-restart"]').textContent(), 'Restart Orchestrator', 'the one menu holds the Orchestrator actions');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });

  const pillBefore = await boxOf(page, '.board-session-view .bs-pill');
  assert.equal(await root.locator('.bs-pill.chat-composer textarea.chat-composer-input').count(), 1, 'the message bar is Chat\'s composer');
  const repoButtonBefore = await boxOf(page, '.board-session-view .bs-card[data-main] .bs-card-repo');
  const pillInput = root.locator(MESSAGE_BAR_SELECTOR);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.board-session-view .bs-notice')?.hidden === true, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-guide-step[data-done]').count(), 0, 'a new carbon unit starts with no guide step done');
  await pillInput.fill('edit-shop');
  await pillInput.press('Enter');
  await root.locator('.bs-guide-step[data-done]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-row-agent:not([hidden]) .bs-last-reply', { hasText: 'The charge goes through' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-presence-glow[data-tier="edited"]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  const faceOnBox = root.locator('.bs-card[data-main] .bs-face-main').first();
  await faceOnBox.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-presence-glow').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.locator('#tab-focus').click();
  await page.locator('#tab-board-session').click();
  await faceOnBox.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill after the agent edits');

  const mapViewport = root.locator('.wb-viewport');
  const panAwayFrom = await mapViewport.boundingBox();
  assert.ok(panAwayFrom, 'the Studio map is on screen');
  const steadyBoardId = await studioMapBoardIdOf(page, root);
  assert.ok(steadyBoardId, 'the Studio map has a board');
  const mainCardOffsetFromMap = async () => {
    const [firstBoxRect] = (await boxScreenRectsOf(page, root, steadyBoardId)).values();
    const mainCardRect = await root.locator('.bs-card[data-main]').first().boundingBox();
    assert.ok(firstBoxRect && mainCardRect, 'the main card and a map box are laid out');
    return { x: Math.round(mainCardRect.x - firstBoxRect.x), y: Math.round(mainCardRect.y - firstBoxRect.y) };
  };
  const offsetBeforePan = await mainCardOffsetFromMap();
  await page.mouse.move(panAwayFrom.x + 30, panAwayFrom.y + panAwayFrom.height / 2);
  for (let step = 0; step < STEADY_PAN_STEPS; step += 1) {
    await page.mouse.wheel(STEADY_PAN_STEP_PX, STEADY_PAN_STEP_PX);
    await pollFor(`the main card to move with the map while it pans (step ${step + 1})`, STEADY_PAN_SETTLE_MS, async () => {
      const offset = await mainCardOffsetFromMap();
      return offset.x === offsetBeforePan.x && offset.y === offsetBeforePan.y ? offset : null;
    });
  }
  for (let step = 0; step < STEADY_PAN_STEPS; step += 1) await page.mouse.wheel(-STEADY_PAN_STEP_PX, -STEADY_PAN_STEP_PX);
  const panMap = async (deltaY: number) => {
    await page.mouse.move(panAwayFrom.x + 30, panAwayFrom.y + panAwayFrom.height / 2);
    for (let step = 0; step < MAP_PAN_STEPS; step += 1) await page.mouse.wheel(0, deltaY);
  };
  await panMap(-MAP_PAN_STEP_PX);
  await pillInput.fill('ask-shop');
  await pillInput.press('Enter');
  const reuseOption = page.getByRole('button', { name: /^Yes, reuse it/ });
  const askCard = root.locator('.bs-ask', { has: reuseOption });
  await askCard.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await askCard.locator('.chat-card[data-card-type="question"] .chat-card-option').count(), 2, 'the board ask shows as Chat\'s question card with its options');
  assert.equal(await askCard.locator('.chat-card-heading').textContent(), BOARD_ASK_QUESTION, 'the card shows the whole question');
  assert.equal(await askCard.getByRole('button', { name: 'Send answer', exact: true }).isDisabled(), true, 'Send answer waits for typed text');
  const askBoardId = await studioMapBoardIdOf(page, root);
  assert.ok(askBoardId, 'the Studio map has a board for the ask');
  const askBoxId = await askCard.getAttribute('data-ask-box-id');
  const askCardRect = await askCard.boundingBox();
  assert.ok(askBoxId && askCardRect, 'the ask card names its box and is on screen');
  const boxRects = await boxScreenRectsOf(page, root, askBoardId);
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

  await verifyBranch(page, projectDirectory, pillBefore);

  await pillInput.fill('narrate');
  const sendButton = root.locator('.bs-pill .chat-composer-send');
  assert.equal(await sendButton.isEnabled(), true, 'Send turns on once the pill holds text');
  await pillInput.press('Enter');
  await root.locator('.bs-row-you', { hasText: 'narrate' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-row-agent:not([hidden]) .bs-face').count() > 0, true, 'an agent chat line carries the agent face');
  await root.locator('.bs-card[data-main][data-phase="working"] .chat-activity[data-phase="working"]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-card[data-main]').count(), 1, 'the main agent has exactly one card');
  assert.equal(await root.locator('.bs-log', { hasText: 'npm test -- run-1' }).count(), 0, 'the Studio log shows replies, not tool calls');
  assert.equal(await sendButton.getAttribute('aria-label'), 'Send', 'Send keeps its label after a send');
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill');
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
  const repoRootAddress = root.locator('.bs-pill-address-text', { hasText: /^New branch on repo root$/ });
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
  assert.equal(await barAddress.textContent(), 'New branch on repo root', 'a refused box address stays in the bar to retarget');

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
  await page.locator('#tab-focus').click();
  await page.locator('.focus-view').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.isHidden(), true, 'the Studio tab hides when Focus opens');
  await page.locator('.focus-view button.session-row[data-id]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await page.locator(`.focus-view button.session-row[data-id="${studioMainId}"]`).count(), 0, 'the Studio main stays out of Focus session rows');
}
