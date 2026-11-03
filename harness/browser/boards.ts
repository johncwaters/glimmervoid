import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright-core';
import type { Layout } from './cases-core.ts';
import { git } from '../site-capture/isolated-glimmervoid.ts';
import { commitFile, findSessionWorktree, pollFor, readOriginFile } from './review-merge.ts';

const UNCOVERED_FILE_NAME = 'board-uncovered.txt';
const MERGE_SETTLE_MS = 1500;
const WORKTREE_TIMEOUT_MS = 15000;
const REVIEW_TIMEOUT_MS = 20000;
const RESIZE_TIMEOUT_MS = 5000;

async function addPlanStep(panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: 'more', exact: true }).click();
  await panel.page().getByRole('menuitem', { name: 'plan step', exact: true }).click();
}

async function placeBoxWithTool(page: Page, panel: Locator, offset: { x: number; y: number }, title: string): Promise<void> {
  const canvasBox = await panel.locator('.wb-canvas').boundingBox();
  assert.ok(canvasBox);
  await page.mouse.click(canvasBox.x + offset.x, canvasBox.y + offset.y);
  const titleInput = page.getByRole('textbox', { name: 'Box title', exact: true });
  await titleInput.fill(title);
  await page.keyboard.press('Enter');
  await panel.locator('.wb-box-title', { hasText: title }).waitFor();
}

async function verifyResizedBox(page: Page, panel: Locator, title: string): Promise<void> {
  const box = panel.locator('.wb-box', { has: page.locator('.wb-box-title', { hasText: title }) });
  const outline = box.locator('.wb-box-outline');
  const widthBefore = Number(await outline.getAttribute('width'));
  await box.hover();
  const handle = await box.locator('.wb-resize-handle').boundingBox();
  assert.ok(handle);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 120, handle.y + handle.height / 2, { steps: 6 });
  await page.mouse.up();
  await pollFor('dragging the corner handle widens the box', RESIZE_TIMEOUT_MS, async () => (Number(await outline.getAttribute('width')) > widthBefore ? true : null));
  await panel.getByRole('button', { name: 'undo', exact: true }).click();
  await pollFor('undo puts the box back to its width', RESIZE_TIMEOUT_MS, async () => (Number(await outline.getAttribute('width')) === widthBefore ? true : null));
}

async function verifyDroppedPicture(panel: Locator): Promise<void> {
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
  const picture = panel.locator('image.wb-image');
  await picture.waitFor();
  await panel.locator('.wb-box-title', { hasText: 'dropped-shot' }).waitFor();
  const previewWidth = await picture.evaluate(async (node) => {
    const preview = new Image();
    preview.src = node.getAttribute('href') ?? '';
    await preview.decode();
    return preview.naturalWidth;
  });
  assert.equal(previewWidth, 1024, 'a dropped picture draws from the capped preview');
  await picture.click();
  const viewer = panel.page().locator('.wb-image-viewer');
  const enlarged = viewer.locator('img.wb-image-viewer-picture');
  await enlarged.waitFor();
  const naturalWidth = await enlarged.evaluate(async (node) => (node instanceof HTMLImageElement ? node.decode().then(() => node.naturalWidth) : 0));
  assert.equal(naturalWidth, 2400, 'a clicked picture opens the original at its own size');
  assert.ok(await enlarged.evaluate((node) => node.getBoundingClientRect().width > window.innerWidth * 0.8), 'the viewer scales a picture up to fill the screen');
  await panel.page().keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });
  await panel.getByRole('button', { name: 'undo', exact: true }).click();
  await picture.waitFor({ state: 'detached' });
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

async function runBoardControl(page: Page, type: string, payload: Record<string, string>): Promise<string | null> {
  return page.evaluate(async ({ type, payload }) => {
    const tokenReply: unknown = await fetch('/control-token', { credentials: 'same-origin', cache: 'no-store' }).then((response) => response.json());
    const token = typeof tokenReply === 'object' && tokenReply !== null && 'token' in tokenReply && typeof tokenReply.token === 'string' ? tokenReply.token : '';
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/control?token=${encodeURIComponent(token)}`);
    const requestId = `harness-${type}-${Date.now()}`;
    return new Promise<string | null>((resolve, reject) => {
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type, requestId, ...payload })));
      socket.addEventListener('error', () => reject(new Error(`${type} could not reach the control socket`)));
      socket.addEventListener('message', (event) => {
        const reply: unknown = JSON.parse(String(event.data));
        if (typeof reply !== 'object' || reply === null || !('requestId' in reply) || reply.requestId !== requestId) return;
        socket.close();
        if ('ok' in reply && reply.ok === true) {
          const summary = 'summary' in reply && typeof reply.summary === 'object' && reply.summary !== null ? reply.summary : null;
          resolve(summary && 'id' in summary && typeof summary.id === 'string' ? summary.id : null);
          return;
        }
        reject(new Error(`${type} was refused: ${JSON.stringify(reply)}`));
      });
    });
  }, { type, payload });
}

async function createBoardOverControl(page: Page, boardTitle: string): Promise<string> {
  const boardId = await runBoardControl(page, 'whiteboard-create', { title: boardTitle });
  assert.ok(boardId, 'the server created the board');
  return boardId;
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
  const panel = layout === 'desktop' ? await openDesktopBoard(page, sessionId, boardTitle) : page.locator('.boards-view');
  await panel.waitFor({ state: 'visible' });
  if (layout === 'phone') await createBoardFromView(page, panel, boardTitle);
  await panel.locator('.wb-svg').waitFor({ state: 'visible' });
  if (layout === 'phone') {
    await panel.getByRole('button', { name: 'board menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'new board', exact: true }).waitFor();
    assert.equal(await page.getByRole('menuitem', { name: 'board settings', exact: true }).isVisible(), false, 'phone hides the properties panel, so the menu offers no board settings');
    await page.keyboard.press('Escape');
  }
  if (layout === 'desktop') {
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
    await boxTool.hover();
    const hoverTip = page.locator('#hover-tip');
    await hoverTip.waitFor();
    assert.equal(await hoverTip.locator('.hover-tip-label').textContent(), 'box', 'a board tool names itself in the styled tip');
    assert.equal(await hoverTip.locator('.hover-tip-detail').textContent(), 'R', 'a board tool shows its shortcut in the styled tip');
    assert.equal(await boxTool.getAttribute('title'), null, 'a board tool has no native tooltip beside the styled one');
    await boxTool.click();
    assert.equal(await boxTool.getAttribute('aria-pressed'), 'true');
    const toolHint = panel.locator('.wb-tool-hint');
    await toolHint.filter({ hasText: 'Click the board to place a box' }).waitFor();
    await placeBoxWithTool(page, panel, { x: 60, y: 60 }, 'Parse feed');
    assert.equal(await panel.getByRole('button', { name: 'select', exact: true }).getAttribute('aria-pressed'), 'true', 'the tool returns to select after one placement');
    assert.equal(await toolHint.isVisible(), false, 'the hint line hides once the select tool is back');
    await verifyResizedBox(page, panel, 'Parse feed');
    await verifyDroppedPicture(panel);
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
    await page.waitForFunction((before) => document.querySelector('.wb-board-meta')?.textContent !== before, versionBeforeDrop);
    assert.equal(await wireLine.getAttribute('d'), draggingPath, 'the wire lands where the drag preview routed it');
    await panel.locator('.wb-svg').focus();
    const versionBeforeUndo = await panel.locator('.wb-board-meta').textContent();
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction((before) => document.querySelector('.wb-board-meta')?.textContent !== before, versionBeforeUndo);
    assert.equal(await wireLine.getAttribute('d'), restingPath, 'undo puts the dragged box back');
    const versionBeforeRedo = await panel.locator('.wb-board-meta').textContent();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await page.waitForFunction((before) => document.querySelector('.wb-board-meta')?.textContent !== before, versionBeforeRedo);
    assert.equal(await wireLine.getAttribute('d'), draggingPath, 'redo moves it again');
    const versionBeforeUndoButton = await panel.locator('.wb-board-meta').textContent();
    await panel.getByRole('button', { name: 'undo', exact: true }).click();
    await page.waitForFunction((before) => document.querySelector('.wb-board-meta')?.textContent !== before, versionBeforeUndoButton);
    assert.equal(await wireLine.getAttribute('d'), restingPath, 'the undo button steps back like Ctrl+Z');
    const versionBeforeRedoButton = await panel.locator('.wb-board-meta').textContent();
    await panel.getByRole('button', { name: 'redo', exact: true }).click();
    await page.waitForFunction((before) => document.querySelector('.wb-board-meta')?.textContent !== before, versionBeforeRedoButton);
    assert.equal(await wireLine.getAttribute('d'), draggingPath, 'the redo button steps forward again');
    await panel.locator('.wb-svg').focus();
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
    await targetBox.locator('.wb-box-outline').click();
    await inspect.getByRole('heading', { name: 'Box', exact: true }).waitFor();
    await inspect.getByRole('combobox', { name: 'Shape', exact: true }).selectOption('decision');
    await panel.locator('.wb-box', { hasText: 'Index rows' }).locator('.wb-output-label').first().waitFor();
    await inspect.getByRole('heading', { name: 'Decision', exact: true }).waitFor();
    const versionBeforePanelUndo = await panel.locator('.wb-board-meta').textContent();
    await inspect.getByRole('combobox', { name: 'Shape', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction((before) => document.querySelector('.wb-board-meta')?.textContent !== before, versionBeforePanelUndo);
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
    await inspect.getByRole('combobox', { name: 'Change', exact: true }).selectOption('relabeled');
    await panel.locator('.wb-box-was', { hasText: 'Index second' }).waitFor();
    await titleField.fill('Index rows by day');
    await page.keyboard.press('Enter');
    await panel.locator('.wb-change-relabeled .wb-box-title', { hasText: 'Index rows by day' }).waitFor();
    await panel.locator('.wb-legend-text', { hasText: 'renamed, old title struck through' }).waitFor();
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
    await inspect.getByRole('textbox', { name: 'Line 1 text', exact: true }).fill('first edited');
    await page.keyboard.press('Enter');
    await panel.locator('.wb-box', { hasText: 'first edited' }).waitFor();
    await inspect.getByRole('textbox', { name: 'Line 2 text', exact: true }).fill('second edited');
    await page.keyboard.press('Enter');
    await panel.locator('.wb-box', { hasText: 'second edited' }).waitFor();
    assert.equal(await panel.locator('.wb-box', { hasText: 'first edited' }).count(), 1, 'a second line edit keeps the first one');
    await addPlanStep(panel);
    await submitTextDialog(page, 'Unit title', 'Index the diffs', 'Add unit');
    const unitOnBoard = panel.locator('.wb-unit', { hasText: 'Index the diffs' });
    await unitOnBoard.locator('.wb-unit-status', { hasText: 'planned' }).waitFor();
    await unitOnBoard.locator('.wb-box-title').click();
    await inspect.getByRole('combobox', { name: 'Status', exact: true }).selectOption('landed');
    await unitOnBoard.locator('.wb-unit-status.wb-unit-landed', { hasText: 'landed' }).waitFor();
    await openBoardMenuItem(page, panel, 'board settings');
    await inspect.getByRole('heading', { name: 'Board', exact: true }).waitFor({ timeout: 3000 });
  }
  assert.equal(await panel.getByRole('button', { name: 'fit', exact: true }).isVisible(), true);
  assert.equal(await panel.getByRole('button', { name: boardTitle, exact: true }).count(), 1);
}

async function openDesktopBoard(page: Page, sessionId: string, boardTitle: string): Promise<Locator> {
  assert.equal(await page.locator('#tab-boards').isVisible(), false, 'Boards has no desktop header tab; boards live in Focus');
  const boardId = await createBoardOverControl(page, boardTitle);
  await runBoardControl(page, 'whiteboard-connect', { boardId, sessionId });
  return showBoardInFocus(page, sessionId, boardTitle);
}

export async function verifyBoardPane(page: Page, sessionId: string, projectDirectory: string): Promise<void> {
  const boardTitle = `Pane plan ${sessionId.slice(0, 8)}`;
  await createBoardOverControl(page, boardTitle);
  await page.locator(`.focus-rail .session-row[data-id="${sessionId}"] .session-row-glyph`).first().click();
  const card = page.locator(`.session-card[data-id="${sessionId}"]`).first();
  await card.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.pane-tab[data-tab="board"]').count(), 0, 'a session with no board shows Terminal only');
  await verifyPaneTerminalTabOwnsTheFace(page, card);
  const terminalPane = page.locator('#focus-pane-terminal');
  const terminalBoundsBeforeBoard = await terminalPane.boundingBox();
  await card.getByRole('button', { name: 'Session actions', exact: true }).click();
  await card.locator('.overflow-connect-board').click();
  await page.getByRole('combobox', { name: 'Board to connect', exact: true }).selectOption({ label: boardTitle });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.pane-tab[data-tab="board"]').waitFor();
  assert.equal(await page.locator('.pane-tab[data-tab="terminal"]').getAttribute('aria-selected'), 'true', 'a board arriving for the centered session joins as a tab and leaves Terminal showing');
  assert.deepEqual(await terminalPane.boundingBox(), terminalBoundsBeforeBoard, 'a board arriving for the centered session leaves the terminal its size');
  const boardChip = page.locator(`.focus-rail .session-row[data-id="${sessionId}"]`).locator(`.session-board-chip[aria-label="Open board ${boardTitle}"]`);
  await boardChip.waitFor();
  const worktreePath = await pollFor('the session worktree', WORKTREE_TIMEOUT_MS, () => findSessionWorktree(projectDirectory));
  await commitFile(worktreePath, UNCOVERED_FILE_NAME, 'changed outside any board ref\n', 'test: a change no board ref covers');
  assert.equal((await boardChip.textContent())?.trim(), boardTitle);
  assert.equal(await boardChip.locator('.pr-status-icon').count(), 1, 'the board chip carries an icon like a PR chip');
  await boardChip.click();
  const panel = page.locator('#focus-center');
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
  const unitOnBoard = panel.locator('.wb-unit', { hasText: 'Uncovered change' });
  await agentIsland.locator('.wb-session-queued', { hasText: 'queued for' }).waitFor();
  const agentBox = await agentIsland.boundingBox();
  assert.ok(agentBox);
  assert.ok(Math.abs(agentBox.y + agentBox.height - (canvasBox.y + canvasBox.height - 10)) < 2 && Math.abs(agentBox.x - (canvasBox.x + 10)) < 2, 'the session island sits bottom left on the board');
  await agentIsland.getByRole('button', { name: 'send to agent', exact: true }).click();
  await agentIsland.locator('.action-status', { hasText: 'sent' }).waitFor();
  await unitOnBoard.locator('.wb-box-title').click();
  const inspect = panel.locator('.wb-inspect');
  await inspect.getByRole('button', { name: 'Add a ref to this unit', exact: true }).click();
  await inspect.getByRole('textbox', { name: 'Ref 1', exact: true }).fill(UNCOVERED_FILE_NAME);
  await page.keyboard.press('Enter');
  await panel.locator('.wb-unit.is-flagged', { hasText: 'Uncovered change' }).waitFor({ timeout: REVIEW_TIMEOUT_MS });
  await panel.getByRole('button', { name: 'fit', exact: true }).click();
  const fittedUnitBox = await unitOnBoard.boundingBox();
  const islandBox = await agentIsland.boundingBox();
  assert.ok(fittedUnitBox && islandBox);
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
  await openBoardTitle(panel, railTitle).waitFor();
  await page.locator('.focus-board-list .session-row.focused', { hasText: railTitle }).waitFor();
  await page.locator(`.focus-rail .session-row[data-id="${sessionId}"] .session-row-glyph`).first().click();
  await page.locator('.pane-tab[data-tab="terminal"]').waitFor();
  assert.equal(await page.locator('.focus-board-list .session-row.focused').count(), 0, 'picking a session leaves the board row');
}

async function verifyBoardPaneFallsBackToSessionBoard(page: Page, panel: Locator, sessionId: string, shownBoardTitle: string): Promise<void> {
  const secondTitle = `Second plan ${sessionId.slice(0, 8)}`;
  const secondBoardId = await createBoardOverControl(page, secondTitle);
  await runBoardControl(page, 'whiteboard-connect', { boardId: secondBoardId, sessionId });
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
