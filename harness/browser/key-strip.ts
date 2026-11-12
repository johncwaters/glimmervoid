import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';

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

const composeBar = '.phone-compose';
const composeField = '.phone-compose-field';

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

async function modifierState(page: Page, slotId: string) {
  const modifier = page.locator(`[data-key="${slotId}"]`).first();
  return { isPressed: await modifier.getAttribute('aria-pressed') === 'true', isLocked: await modifier.getAttribute('data-locked') !== null };
}

export async function verifyKeyStripContexts(page: Page, typeCommand: (command: string) => Promise<void>): Promise<string> {
  await waitForContext(page, 'working');
  assert.deepEqual(await rowKeyIds(page), ['esc', 'ctrl', 'shift-tab', 'left', 'up', 'down', 'right', 'enter'], 'a working agent leads with Esc, Ctrl and Shift+Tab');

  await typeCommand('stop');
  await waitForContext(page, 'ready');
  assert.deepEqual(await rowKeyIds(page), ['esc', 'ctrl', 'shift-tab', 'slash', 'at', 'left', 'up', 'down', 'right', 'enter'], 'a ready agent offers slash commands and file mentions');

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
  assert.equal((await sentInputs(page)).filter((input) => input === ARROW_RIGHT_BYTES).length, 0, 'a swipe that starts on an arrow scrolls the row without typing an arrow');
  await page.locator(keyStrip).evaluate((row) => { row.scrollLeft = 0; });

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
  await page.locator(`${keyStrip} [data-key="slash"]`).click();
  assert.deepEqual(await modifierState(page, 'ctrl'), { isPressed: false, isLocked: false }, 'sending a key releases a once-held Ctrl');
  await control.click();
  await control.click();
  assert.deepEqual(await modifierState(page, 'ctrl'), { isPressed: true, isLocked: true }, 'a double tap locks Ctrl');
  await page.locator(`${keyStrip} [data-key="slash"]`).click();
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

async function waitForComposeBar(page: Page, state: 'visible' | 'hidden') {
  await page.locator(composeBar).waitFor({ state, timeout: CONTEXT_TIMEOUT_MS });
}

export async function verifyComposeSubmit(page: Page, typeCommand: (command: string) => Promise<void>): Promise<string> {
  await waitForComposeBar(page, 'visible');
  await typeCommand('stop');
  await waitForContext(page, 'ready');
  await recordTerminalInputs(page);

  const field = page.locator(composeField);
  await field.click();
  await page.locator(`${keyStrip} [data-key="slash"]`).click();
  await page.keyboard.type('help me');
  assert.equal(await field.inputValue(), '/help me', 'a strip key types its character into the compose field');
  assert.deepEqual(await sentInputs(page), [], 'nothing reaches the agent before Send');

  await page.locator(`${composeBar} [data-action="compose-send"]`).click();
  assert.deepEqual(await sentInputs(page), ['/help me', '\r'], 'Send pastes the text, then presses Enter');
  assert.equal(await field.inputValue(), '', 'Send clears the field');
  assert.equal(await field.evaluate((element) => element === document.activeElement), true, 'the field keeps focus so the keyboard stays up');

  await recordTerminalInputs(page);
  await page.locator(`${keyStrip} [data-key="ctrl"]`).click();
  await page.keyboard.type('c');
  assert.deepEqual(await sentInputs(page), ['\x03'], 'a held Ctrl turns a typed character into its control byte');
  assert.equal(await field.inputValue(), '', 'the chord character stays out of the field');

  await recordTerminalInputs(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('line one\r\n\tindented\r\n'));
  await page.locator('.phone-key-more').click();
  await page.locator('.phone-key-more-sheet [data-key="paste"]').click();
  await page.waitForFunction((selector) => (document.querySelector(selector) as HTMLTextAreaElement | null)?.value !== '', composeField);
  assert.equal(await field.inputValue(), 'line one\n\tindented\n', 'Paste types clipboard text with tabs and CRLF into the field');
  assert.deepEqual(await sentInputs(page), [], 'pasted text waits for Send');
  await field.fill('');

  await typeCommand('fullscreen');
  await page.waitForTimeout(AGENT_ALTERNATE_SCREEN_GRACE_MS);
  await waitForComposeBar(page, 'visible');
  await typeCommand('leave-fullscreen');
  return 'strip keys type into the field; Send pastes then presses Enter and keeps focus; a held Ctrl sends its chord; Paste types tabs and CRLF into the field; an agent drawing its own alternate screen keeps the compose bar';
}

export async function verifyRawTypingInFullScreenApp(page: Page, typeCommand: (command: string) => Promise<void>): Promise<string> {
  await waitForContext(page, 'ready');
  await waitForComposeBar(page, 'visible');
  await typeCommand("printf '\\033[?1049h'");
  await waitForContext(page, 'fullscreen');
  await waitForComposeBar(page, 'hidden');
  assert.deepEqual(await rowKeyIds(page), ['esc', 'ctrl', 'tab', 'left', 'up', 'down', 'right', 'q', 'enter'], 'a full-screen app gets Tab and q');
  await typeCommand("printf '\\033[?1049l'");
  await waitForContext(page, 'ready');
  await waitForComposeBar(page, 'visible');
  assert.equal(await page.locator(composeField).evaluate((element) => element === document.activeElement), true, 'typing moves to the compose field when the full-screen app exits');

  const rawTyping = page.locator('.phone-key-more-sheet [data-key="raw"]');
  await page.locator('.phone-key-more').click();
  await rawTyping.click();
  await waitForComposeBar(page, 'hidden');
  assert.equal(await rawTyping.getAttribute('aria-pressed'), 'true', 'Raw shows it is chosen');
  await page.locator('.phone-key-more').click();
  await rawTyping.click();
  await waitForComposeBar(page, 'visible');
  return 'a full-screen app hides the compose bar and gets Tab and q; leaving it brings both back with typing in the field; Raw hides and restores the compose bar';
}
