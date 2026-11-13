import assert from 'node:assert/strict';
import type { CDPSession, Page } from 'playwright-core';
import { SECRET_ROW_VALUE, WIDE_ROW_LEAD, WIDE_ROW_NUMBER, WIDE_ROW_TARGET } from './frame-core.ts';

const CONTEXT_TIMEOUT_MS = 10_000;

const keyStrip = '.phone-key-strip';
const ARROW_RIGHT_BYTES = '\x1b[C';
const ARROW_UP_BYTES = '\x1b[A';
const HOLD_LONG_ENOUGH_TO_REPEAT_MS = 700;
const QUIET_AFTER_RELEASE_MS = 1000;
const AGENT_ALTERNATE_SCREEN_GRACE_MS = 1000;

declare global {
  interface Window { sentTerminalInputs?: string[]; terminalDataSocket?: WebSocket }
}

const terminalTextarea = '.phone-card-slot .xterm-helper-textarea';

async function recordTerminalInputs(page: Page) {
  await page.evaluate(() => {
    const isAlreadyRecording = window.sentTerminalInputs !== undefined;
    window.sentTerminalInputs = [];
    if (isAlreadyRecording) return;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function recordInput(this: WebSocket, frame) {
      if (typeof frame === 'string' && frame.includes('"type":"input"')) {
        window.terminalDataSocket = this;
        window.sentTerminalInputs?.push(JSON.parse(frame).data);
      }
      return originalSend.call(this, frame);
    };
  });
}

async function sentInputs(page: Page) {
  return page.evaluate(() => window.sentTerminalInputs ?? []);
}

async function centerOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} is on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function waitForContext(page: Page, context: string) {
  await page.locator(`${keyStrip}[data-context="${context}"]`).waitFor({ timeout: CONTEXT_TIMEOUT_MS });
}

async function rowKeyIds(page: Page) {
  return page.locator(`${keyStrip} > [data-key]`).evaluateAll((keys) => keys.map((key) => (key as HTMLElement).dataset.key));
}

async function assertRowFitsWithoutScroll(page: Page) {
  const overflowPx = await page.locator(keyStrip).evaluate((row) => row.scrollWidth - row.clientWidth);
  assert.equal(overflowPx, 0, 'the key strip fits its row without scrolling');
}

async function modifierState(page: Page, slotId: string) {
  const modifier = page.locator(`[data-key="${slotId}"]`).first();
  return { isPressed: await modifier.getAttribute('aria-pressed') === 'true', isLocked: await modifier.getAttribute('data-locked') !== null };
}

export async function verifyKeyStripContexts(page: Page, typeCommand: (command: string) => Promise<void>): Promise<string> {
  await waitForContext(page, 'working');
  assert.deepEqual(await rowKeyIds(page), ['esc', 'ctrl', 'shift-tab', 'left', 'up', 'down', 'right', 'enter'], 'a working agent leads with Esc, Ctrl and Shift+Tab');
  await assertRowFitsWithoutScroll(page);

  await typeCommand('stop');
  await waitForContext(page, 'ready');
  assert.deepEqual(await rowKeyIds(page), ['esc', 'ctrl', 'shift-tab', 'left', 'up', 'down', 'right', 'enter'], 'a ready agent leaves / and @ to the keyboard');
  await assertRowFitsWithoutScroll(page);

  await typeCommand('fullscreen');
  await page.waitForTimeout(AGENT_ALTERNATE_SCREEN_GRACE_MS);
  await waitForContext(page, 'ready');
  await typeCommand('leave-fullscreen');

  await recordTerminalInputs(page);
  await typeCommand('');
  const touch = await page.context().newCDPSession(page);
  const rightArrow = await centerOf(page, `${keyStrip} [data-key="right"]`);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [rightArrow] });
  for (let step = 1; step <= 10; step += 1) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: rightArrow.x - step * 20, y: rightArrow.y }] });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal((await sentInputs(page)).filter((input) => input === ARROW_RIGHT_BYTES).length, 0, 'a swipe that starts on an arrow types no arrow');

  const upArrow = await centerOf(page, `${keyStrip} [data-key="up"]`);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [upArrow] });
  await page.waitForTimeout(HOLD_LONG_ENOUGH_TO_REPEAT_MS);
  await page.evaluate(() => window.terminalDataSocket?.send(JSON.stringify({ type: 'input', data: '\rwork\r' })));
  await waitForContext(page, 'working');
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const upArrowsAtRelease = (await sentInputs(page)).filter((input) => input === ARROW_UP_BYTES).length;
  assert.ok(upArrowsAtRelease > 1, 'holding an arrow repeats it');
  await page.waitForTimeout(QUIET_AFTER_RELEASE_MS);
  const upArrowsAfterRelease = (await sentInputs(page)).filter((input) => input === ARROW_UP_BYTES).length;
  assert.ok(upArrowsAfterRelease <= upArrowsAtRelease, `the repeat stops when the row rebuilds under a held arrow (${upArrowsAtRelease} at release, ${upArrowsAfterRelease} a second later)`);
  await typeCommand('');
  await typeCommand('stop');
  await waitForContext(page, 'ready');

  const control = page.locator(`${keyStrip} [data-key="ctrl"]`);
  await control.click();
  assert.deepEqual(await modifierState(page, 'ctrl'), { isPressed: true, isLocked: false }, 'one tap holds Ctrl for the next key');
  await page.locator(`${keyStrip} [data-key="esc"]`).click();
  assert.deepEqual(await modifierState(page, 'ctrl'), { isPressed: false, isLocked: false }, 'sending a key releases a once-held Ctrl');
  await control.click();
  await control.click();
  assert.deepEqual(await modifierState(page, 'ctrl'), { isPressed: true, isLocked: true }, 'a double tap locks Ctrl');
  await page.locator(`${keyStrip} [data-key="esc"]`).click();
  assert.deepEqual(await modifierState(page, 'ctrl'), { isPressed: true, isLocked: true }, 'a locked Ctrl survives a sent key');
  await control.click();
  assert.deepEqual(await modifierState(page, 'ctrl'), { isPressed: false, isLocked: false }, 'a tap unlocks Ctrl');

  const moreSheet = page.locator('.phone-key-more-sheet');
  await page.locator('.phone-key-more').click();
  await moreSheet.waitFor();
  await moreSheet.locator('[data-key="alt"]').click();
  assert.equal(await moreSheet.isVisible(), true, 'tapping Alt keeps the More sheet open');
  await moreSheet.locator('[data-key="pipe"]').click();
  await moreSheet.waitFor({ state: 'hidden' });
  assert.deepEqual(await modifierState(page, 'alt'), { isPressed: false, isLocked: false }, 'a sheet key consumes Alt and closes the sheet');

  return 'working and ready rows; an agent drawing its own alternate screen keeps the ready row; a swipe types no arrow; a held arrow repeats and stops after a rebuild; Ctrl once, locked and released; the More sheet keeps Alt and closes on a key';
}

async function focusTerminalTextarea(page: Page) {
  await page.locator('.phone-card-slot .terminal-wrap').click();
  await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), terminalTextarea);
}

async function keyboardHintsOf(page: Page) {
  return page.locator(terminalTextarea).evaluate((textarea) => ({
    autocorrect: textarea.getAttribute('autocorrect'),
    autocapitalize: textarea.getAttribute('autocapitalize'),
    spellcheck: (textarea as HTMLTextAreaElement).spellcheck,
  }));
}

async function replaceTypedTextAsAutocorrect(page: Page, correctedText: string) {
  await page.locator(terminalTextarea).evaluate((textarea, nextText) => {
    (textarea as HTMLTextAreaElement).value = nextText;
    textarea.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText', bubbles: true }));
  }, correctedText);
}

export async function verifyTerminalTyping(page: Page, typeCommand: (command: string) => Promise<void>): Promise<string> {
  await typeCommand('stop');
  await waitForContext(page, 'ready');
  assert.equal(await page.locator('.phone-compose').count(), 0, 'the phone Terminal screen has no compose bar');
  await page.locator('.phone-key-more').click();
  assert.equal(await page.locator('.phone-key-more-sheet [data-key="raw"]').count(), 0, 'the More sheet has no Raw key');
  await page.locator('.phone-key-more').click();

  await focusTerminalTextarea(page);
  assert.deepEqual(await keyboardHintsOf(page), { autocorrect: 'on', autocapitalize: 'sentences', spellcheck: true }, 'an agent terminal asks the phone keyboard for autocorrect, suggestions and sentence capitals');

  await recordTerminalInputs(page);
  await page.keyboard.type('teh ');
  await replaceTypedTextAsAutocorrect(page, 'the ');
  assert.equal((await sentInputs(page)).join(''), 'teh \x7f\x7f\x7fhe ', 'an accepted correction erases the typed word in the prompt and types the corrected one');

  await recordTerminalInputs(page);
  await page.locator(`${keyStrip} [data-key="ctrl"]`).click();
  await page.keyboard.type('c');
  assert.deepEqual(await sentInputs(page), ['\x03'], 'a held Ctrl turns a typed character into its control byte');

  await recordTerminalInputs(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('pasted line'));
  await page.locator('.phone-key-more').click();
  await page.locator('.phone-key-more-sheet [data-key="paste"]').click();
  await page.waitForFunction(() => (window.sentTerminalInputs ?? []).join('').includes('pasted line'));
  return 'no compose bar and no Raw key; the terminal asks for autocorrect, suggestions and sentence capitals; an accepted correction rewrites the word in the prompt; a held Ctrl sends its chord; Paste types into the terminal';
}

export async function verifyFullScreenAppRow(page: Page, typeCommand: (command: string) => Promise<void>): Promise<string> {
  await waitForContext(page, 'ready');
  await focusTerminalTextarea(page);
  assert.deepEqual(await keyboardHintsOf(page), { autocorrect: 'on', autocapitalize: 'off', spellcheck: true }, 'a shell terminal keeps autocorrect and suggestions without sentence capitals');
  await typeCommand("printf '\\033[?1049h'");
  await waitForContext(page, 'fullscreen');
  assert.deepEqual(await rowKeyIds(page), ['esc', 'ctrl', 'tab', 'left', 'up', 'down', 'right', 'enter'], 'a full-screen app gets Tab');
  await assertRowFitsWithoutScroll(page);
  await typeCommand("printf '\\033[?1049l'");
  await waitForContext(page, 'ready');
  return 'a shell terminal gets autocorrect without sentence capitals; a full-screen app gets Tab on a row that fits';
}

const LONG_PRESS_HELD_MS = 800;
const SELECTION_DRAG_STEPS = 5;
const SELECTION_DRAG_STEP_PX = 20;
const selectionMirror = '.terminal-select-mirror';
const selectSheet = '.terminal-select-sheet';

interface ScreenPoint { x: number; y: number }

async function copyScreenText(page: Page) {
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.locator('.phone-key-more').click();
  await page.locator('.phone-key-more-sheet [data-key="copy-screen"]').click();
  await page.waitForFunction(() => navigator.clipboard.readText().then((text) => text !== ''));
  return page.evaluate(() => navigator.clipboard.readText());
}

async function waitForScreenText(page: Page, expectedText: string) {
  const deadline = Date.now() + CONTEXT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const screenText = await copyScreenText(page);
    if (screenText.includes(expectedText)) return screenText;
  }
  throw new Error(`the terminal never showed ${JSON.stringify(expectedText)}`);
}

async function cellCenter(page: Page, screenText: string, rowNumber: number, column: number): Promise<ScreenPoint> {
  const size = /cols=(\d+) rows=(\d+)/.exec(screenText);
  assert.ok(size, 'the fake agent prints its size');
  const screenBox = await page.locator('.phone-card-slot .xterm-screen').boundingBox();
  assert.ok(screenBox, 'the terminal screen is on screen');
  const cellWidth = screenBox.width / Number(size[1]);
  const cellHeight = screenBox.height / Number(size[2]);
  return { x: screenBox.x + (column + 0.5) * cellWidth, y: screenBox.y + (rowNumber - 0.5) * cellHeight };
}

async function pressAndHold(page: Page, touch: CDPSession, point: ScreenPoint) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(LONG_PRESS_HELD_MS);
  await page.locator(selectionMirror).waitFor({ timeout: CONTEXT_TIMEOUT_MS });
}

async function releaseTouch(touch: CDPSession) {
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function assertSelectionUnderFinger(page: Page, point: ScreenPoint, what: string) {
  const selectedBox = await page.evaluate(() => {
    const box = document.getSelection()?.getRangeAt(0).getBoundingClientRect();
    return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null;
  });
  const isUnderFinger = !!selectedBox && selectedBox.left <= point.x && selectedBox.right >= point.x && selectedBox.top <= point.y && selectedBox.bottom >= point.y;
  assert.ok(isUnderFinger, `${what} sits under the finger (${JSON.stringify(selectedBox)} around ${JSON.stringify(point)})`);
}

async function selectedText(page: Page) {
  return page.evaluate(() => document.getSelection()?.toString() ?? '');
}

async function clearSelection(page: Page) {
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await page.locator(selectionMirror).waitFor({ state: 'detached', timeout: CONTEXT_TIMEOUT_MS });
}

async function toggleStreamerMode(page: Page) {
  const isMacPlatform = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(isMacPlatform ? 'Meta+Alt+Backslash' : 'Alt+Backslash');
}

async function openSelectSheetText(page: Page) {
  await page.locator('.phone-key-more').click();
  await page.locator('.phone-key-more-sheet [data-key="select"]').click();
  await page.locator(selectSheet).waitFor({ timeout: CONTEXT_TIMEOUT_MS });
  return page.locator(`${selectSheet} pre`).textContent().then((text) => text ?? '');
}

export async function verifyTouchSelectCopy(page: Page, typeCommand: (command: string) => Promise<void>): Promise<string> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  assert.match(await copyScreenText(page), /^0\|0123456789/m, 'Copy screen copies the rows on screen');
  await typeCommand('wide-row');
  await typeCommand('secret-row');
  const screenText = await waitForScreenText(page, `${WIDE_ROW_LEAD} ${WIDE_ROW_TARGET}`);
  await waitForScreenText(page, SECRET_ROW_VALUE);
  const touch = await page.context().newCDPSession(page);

  const digitsPoint = await cellCenter(page, screenText, 2, 20);
  await pressAndHold(page, touch, digitsPoint);
  assert.match(await selectedText(page), /^\d+$/, `a long-press selects the word under the finger (${JSON.stringify(await selectedText(page))})`);
  await assertSelectionUnderFinger(page, digitsPoint, 'the selected word');
  await releaseTouch(touch);
  assert.equal(await page.locator(terminalTextarea).evaluate((element) => element === document.activeElement), false, 'a long-press does not open the keyboard');
  await clearSelection(page);

  const wideRowTargetColumn = WIDE_ROW_LEAD.length * 2 + WIDE_ROW_TARGET.length;
  const wideRowPoint = await cellCenter(page, screenText, WIDE_ROW_NUMBER, wideRowTargetColumn);
  await pressAndHold(page, touch, wideRowPoint);
  await releaseTouch(touch);
  assert.equal(await selectedText(page), WIDE_ROW_TARGET, 'after wide characters the long-press still selects the word under the finger');
  await assertSelectionUnderFinger(page, wideRowPoint, 'a word after wide characters');
  await clearSelection(page);

  await toggleStreamerMode(page);
  await page.locator('html[data-streamer]').waitFor({ state: 'attached', timeout: CONTEXT_TIMEOUT_MS });
  const streamerSheetText = await openSelectSheetText(page);
  assert.ok(streamerSheetText.includes('GITHUB_TOKEN=') && !streamerSheetText.includes(SECRET_ROW_VALUE), 'in streamer mode the select sheet masks secrets');
  await page.locator(`${selectSheet} [data-action="close-select"]`).click();
  await toggleStreamerMode(page);
  await page.locator('html[data-streamer]').waitFor({ state: 'detached', timeout: CONTEXT_TIMEOUT_MS });

  assert.match(await openSelectSheetText(page), /cols=\d+ rows=\d+/, 'Select opens the terminal text in a sheet');
  await page.locator(`${selectSheet} [data-action="close-select"]`).click();

  await typeCommand('history');
  await waitForScreenText(page, 'burst 199');
  const historyPoint = await cellCenter(page, screenText, 2, 1);
  await pressAndHold(page, touch, historyPoint);
  for (let step = 1; step <= SELECTION_DRAG_STEPS; step++) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: historyPoint.x, y: historyPoint.y + step * SELECTION_DRAG_STEP_PX }] });
  }
  await releaseTouch(touch);
  assert.equal(await page.locator(selectionMirror).count(), 1, 'dragging after a long-press keeps the selection instead of scrolling it away');
  await clearSelection(page);
  return 'Copy screen copies the rows; a long-press selects the word under the finger, also after wide characters, without opening the keyboard, and a drag over scrollback keeps it; the select sheet masks secrets in streamer mode';
}
