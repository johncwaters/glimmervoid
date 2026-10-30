import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { Layout } from './cases-core.ts';

async function submitTextDialog(page: Page, label: string, value: string, confirmLabel: string): Promise<void> {
  await page.getByRole('textbox', { name: label, exact: true }).fill(value);
  await page.getByRole('button', { name: confirmLabel, exact: true }).click();
}

export async function verifyBoards(page: Page, layout: Layout): Promise<void> {
  await page.locator('#loading-screen').waitFor({ state: 'hidden' });
  if (layout === 'phone') {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Boards', exact: true }).click();
  }
  if (layout === 'desktop') await page.locator('#tab-boards').click();
  const boardTitle = `Ingest plan ${layout}`;
  const panel = page.locator('.boards-view');
  await panel.waitFor({ state: 'visible' });
  await panel.getByRole('button', { name: 'new board', exact: true }).click();
  await submitTextDialog(page, 'Board title', boardTitle, 'Create board');
  await panel.locator('.wb-board-tab[aria-pressed="true"]', { hasText: boardTitle }).waitFor();
  await panel.locator('.wb-svg').waitFor({ state: 'visible' });
  if (layout === 'desktop') {
    await panel.getByRole('button', { name: 'box', exact: true }).click();
    await submitTextDialog(page, 'Box title', 'Parse feed', 'Add box');
    await panel.locator('.wb-box-title', { hasText: 'Parse feed' }).waitFor();
    const isComicMonoLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('700 16px ComicMono');
    });
    assert.equal(isComicMonoLoaded, true);
    const boxTitleFont = await panel.locator('.wb-box-title').first().evaluate((node) => getComputedStyle(node).fontFamily);
    assert.match(boxTitleFont, /ComicMono/);
    const canvasBox = await panel.locator('.wb-canvas').boundingBox();
    const boxOutline = await panel.locator('.wb-box-outline').first().boundingBox();
    assert.ok(canvasBox && boxOutline);
    assert.ok(boxOutline.x >= canvasBox.x && boxOutline.y >= canvasBox.y, 'the box starts inside the canvas');
    assert.ok(boxOutline.x + boxOutline.width <= canvasBox.x + canvasBox.width && boxOutline.y + boxOutline.height <= canvasBox.y + canvasBox.height, 'the box ends inside the canvas');
    await panel.locator('.wb-box-outline').first().dblclick();
    await page.getByRole('textbox', { name: 'Box title', exact: true }).fill('Parse and store');
    await page.keyboard.press('Enter');
    await panel.locator('.wb-box-title', { hasText: 'Parse and store' }).waitFor();
  }
  assert.equal(await panel.getByRole('button', { name: 'fit', exact: true }).isVisible(), true);
  assert.equal(await panel.getByRole('button', { name: boardTitle }).count(), 1);
}

export async function verifyBoardDock(page: Page, sessionId: string): Promise<void> {
  const boardTitle = `Dock plan ${sessionId.slice(0, 8)}`;
  await page.locator('#tab-boards').click();
  const panel = page.locator('.boards-view');
  await panel.getByRole('button', { name: 'new board', exact: true }).click();
  await submitTextDialog(page, 'Board title', boardTitle, 'Create board');
  await panel.locator('.wb-board-tab[aria-pressed="true"]', { hasText: boardTitle }).waitFor();
  await page.locator('#tab-focus').click();
  const card = page.locator(`.session-card[data-id="${sessionId}"]`).first();
  await card.getByRole('button', { name: 'Session actions', exact: true }).click();
  await card.locator('.overflow-connect-board').click();
  await page.getByRole('combobox', { name: 'Board to connect', exact: true }).selectOption({ label: boardTitle });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const boardChip = page.locator(`.focus-rail .session-row[data-id="${sessionId}"]`).locator(`.session-board-chip[aria-label="Open board ${boardTitle}"]`);
  await boardChip.waitFor();
  assert.equal((await boardChip.textContent())?.trim(), boardTitle);
  assert.equal(await boardChip.locator('.pr-status-icon').count(), 1, 'the board chip carries an icon like a PR chip');
  await boardChip.click();
  await panel.locator('.wb-board-tab[aria-pressed="true"]', { hasText: boardTitle }).waitFor();
  await panel.locator(`.wb-dock .session-card[data-id="${sessionId}"]`).waitFor({ state: 'visible' });
  const canvasBox = await panel.locator('.wb-canvas').boundingBox();
  const dockBox = await panel.locator('.wb-dock').boundingBox();
  assert.ok(canvasBox && dockBox);
  assert.ok(canvasBox.x >= dockBox.x + dockBox.width, 'the board sits to the right of the docked session');
  assert.ok(Math.abs(dockBox.y - canvasBox.y) < 2 && Math.abs(dockBox.height - canvasBox.height) < 2, 'the board and the docked session share the full height');
  await page.waitForFunction((id) => {
    const docked = document.querySelector(`.wb-dock .session-card[data-id="${id}"]`);
    return docked?.getAttribute('data-grid') === 'exact';
  }, sessionId);
  await panel.locator('.wb-dock-queued', { hasText: 'has read every change' }).waitFor();
  await panel.locator('.wb-dock-bar').getByRole('button', { name: 'send to agent', exact: true }).click();
  await panel.locator('.wb-dock-bar .action-status', { hasText: 'sent' }).waitFor();
  await page.locator('#tab-focus').click();
  assert.equal(await panel.locator('.wb-dock .session-card').count(), 0, 'leaving the board hands the card back');
}
