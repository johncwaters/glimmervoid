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
  await panel.locator('.wb-board-title', { hasText: boardTitle }).waitFor();
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
