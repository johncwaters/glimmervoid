import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright-core';
import type { Layout } from './cases-core.ts';

async function placeBoxWithTool(page: Page, panel: Locator, offset: { x: number; y: number }, title: string): Promise<void> {
  const canvasBox = await panel.locator('.wb-canvas').boundingBox();
  assert.ok(canvasBox);
  await page.mouse.click(canvasBox.x + offset.x, canvasBox.y + offset.y);
  const titleInput = page.getByRole('textbox', { name: 'Box title', exact: true });
  await titleInput.fill(title);
  await page.keyboard.press('Enter');
  await panel.locator('.wb-box-title', { hasText: title }).waitFor();
}

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
    assert.equal(await panel.getByRole('button', { name: 'box', exact: true }).getAttribute('aria-pressed'), 'true');
    await placeBoxWithTool(page, panel, { x: 60, y: 60 }, 'Parse feed');
    assert.equal(await panel.getByRole('button', { name: 'select', exact: true }).getAttribute('aria-pressed'), 'true', 'the tool returns to select after one placement');
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
    await panel.locator('.wb-svg').focus();
    await page.keyboard.press('r');
    await placeBoxWithTool(page, panel, { x: 60, y: 260 }, 'Index rows');
    const sourceBox = panel.locator('.wb-box', { hasText: 'Parse and store' });
    const targetBox = panel.locator('.wb-box', { hasText: 'Index rows' });
    await targetBox.waitFor();
    await sourceBox.hover();
    const bottomPort = await sourceBox.locator('.wb-port').nth(2).boundingBox();
    const dropTarget = await targetBox.boundingBox();
    assert.ok(bottomPort && dropTarget);
    await page.mouse.move(bottomPort.x + bottomPort.width / 2, bottomPort.y + bottomPort.height / 2);
    await page.mouse.down();
    await page.mouse.move(dropTarget.x + dropTarget.width / 2, dropTarget.y + dropTarget.height / 2, { steps: 6 });
    await panel.locator('.wb-box.is-wire-target', { hasText: 'Index rows' }).waitFor({ state: 'attached' });
    await page.mouse.up();
    assert.equal(await panel.locator('.wb-wire-draft').count(), 0, 'releasing a port drag removes its dashed line');
    const wireLine = panel.locator('.wb-wire .wb-wire-line').first();
    await wireLine.waitFor({ state: 'attached' });
    const restingPath = await wireLine.getAttribute('d');
    const targetOutline = await targetBox.boundingBox();
    assert.ok(targetOutline);
    await page.mouse.move(targetOutline.x + targetOutline.width / 2, targetOutline.y + targetOutline.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetOutline.x + targetOutline.width / 2 + 260, targetOutline.y + targetOutline.height / 2 + 40, { steps: 8 });
    await page.waitForFunction((before) => document.querySelector('.boards-view .wb-wire .wb-wire-line')?.getAttribute('d') !== before, restingPath);
    const draggingPath = await wireLine.getAttribute('d');
    const versionBeforeDrop = await panel.locator('.wb-board-meta').textContent();
    await page.mouse.up();
    await page.waitForFunction((before) => document.querySelector('.boards-view .wb-board-meta')?.textContent !== before, versionBeforeDrop);
    assert.equal(await wireLine.getAttribute('d'), draggingPath, 'the wire lands where the drag preview routed it');
    await panel.locator('.wb-svg').focus();
    const versionBeforeUndo = await panel.locator('.wb-board-meta').textContent();
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction((before) => document.querySelector('.boards-view .wb-board-meta')?.textContent !== before, versionBeforeUndo);
    assert.equal(await wireLine.getAttribute('d'), restingPath, 'undo puts the dragged box back');
    const versionBeforeRedo = await panel.locator('.wb-board-meta').textContent();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await page.waitForFunction((before) => document.querySelector('.boards-view .wb-board-meta')?.textContent !== before, versionBeforeRedo);
    assert.equal(await wireLine.getAttribute('d'), draggingPath, 'redo moves it again');
    const inspect = panel.locator('.wb-inspect');
    await page.keyboard.press('Escape');
    await inspect.getByRole('heading', { name: 'Board', exact: true }).waitFor();
    await targetBox.locator('.wb-box-outline').click();
    await inspect.getByRole('heading', { name: 'Box', exact: true }).waitFor();
    await inspect.getByRole('combobox', { name: 'Shape', exact: true }).selectOption('decision');
    await panel.locator('.wb-box', { hasText: 'Index rows' }).locator('.wb-output-label').first().waitFor();
    await inspect.getByRole('heading', { name: 'Decision', exact: true }).waitFor();
    const versionBeforePanelUndo = await panel.locator('.wb-board-meta').textContent();
    await inspect.getByRole('combobox', { name: 'Shape', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction((before) => document.querySelector('.boards-view .wb-board-meta')?.textContent !== before, versionBeforePanelUndo);
    await inspect.getByRole('heading', { name: 'Box', exact: true }).waitFor();
    assert.equal(await panel.locator('.wb-box', { hasText: 'Index rows' }).locator('.wb-output-label').count(), 0, 'undo right after a panel change takes the decision back');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await inspect.getByRole('heading', { name: 'Decision', exact: true }).waitFor();
    assert.equal(await inspect.getByRole('textbox', { name: 'Output yes label', exact: true }).inputValue(), 'yes');
    const titleField = inspect.getByRole('textbox', { name: 'Title', exact: true });
    await titleField.fill('Index first');
    await page.keyboard.press('Enter');
    await panel.locator('.wb-box-title', { hasText: 'Index first' }).waitFor();
    await titleField.fill('Index second');
    await page.keyboard.press('Enter');
    await panel.locator('.wb-box-title', { hasText: 'Index second' }).waitFor();
    await inspect.getByRole('combobox', { name: 'Shape', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+z');
    await panel.locator('.wb-box-title', { hasText: 'Index rows' }).waitFor();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await panel.locator('.wb-box-title', { hasText: 'Index first' }).waitFor({ timeout: 3000 });
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await panel.locator('.wb-box-title', { hasText: 'Index second' }).waitFor({ timeout: 3000 });
    await inspect.getByRole('button', { name: 'Add a line to this box', exact: true }).click();
    await inspect.getByRole('textbox', { name: 'Line 1 text', exact: true }).waitFor();
    await inspect.getByRole('button', { name: 'Add a line to this box', exact: true }).click();
    await inspect.getByRole('textbox', { name: 'Line 2 text', exact: true }).waitFor();
    await inspect.getByRole('textbox', { name: 'Line 1 text', exact: true }).fill('first edited');
    await page.keyboard.press('Enter');
    await panel.locator('.wb-box', { hasText: 'first edited' }).waitFor();
    await inspect.getByRole('textbox', { name: 'Line 2 text', exact: true }).fill('second edited');
    await page.keyboard.press('Enter');
    await panel.locator('.wb-box', { hasText: 'second edited' }).waitFor();
    assert.equal(await panel.locator('.wb-box', { hasText: 'first edited' }).count(), 1, 'a second line edit keeps the first one');
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
