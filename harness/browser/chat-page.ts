import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';

const CARD_TIMEOUT_MS = 20000;
const MIN_INLINE_TERMINAL_HEIGHT_PX = 200;

async function openChat(page: Page): Promise<void> {
  const isChatOpen = (await page.locator('.session-chat').count()) > 0;
  if (!isChatOpen) await page.locator('.session-page-bar').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
}

async function sendFromComposer(page: Page, text: string): Promise<void> {
  const input = page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' });
  await input.fill(text);
  await input.press('Enter');
}

const CATALOG_POLL_MS = 250;

async function waitUntilPageReports(page: Page, isReady: () => Promise<boolean>, awaitedState: string): Promise<void> {
  const deadline = Date.now() + CARD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await page.evaluate(isReady)) return;
    await page.waitForTimeout(CATALOG_POLL_MS);
  }
  throw new Error(`timed out waiting for ${awaitedState}`);
}

async function waitForModelCatalog(page: Page): Promise<void> {
  await waitUntilPageReports(page, async () => {
    const controlWsUrl = '/control-ws.ts';
    const { sendControlRequest } = await import(controlWsUrl);
    const reply = await sendControlRequest('get-settings', {});
    const agents: unknown = reply?.settings?.agentModels?.agents;
    return Array.isArray(agents) && agents.some((entry) => entry?.agent === 'claude-code' && Array.isArray(entry.models) && entry.models.length > 1);
  }, 'the server model catalog');
  await page.reload();
  await waitUntilPageReports(page, async () => {
    const settingsStoreUrl = '/settings/settings-store.ts';
    const { settingsPayloadSnapshot } = await import(settingsStoreUrl);
    const agents: unknown = settingsPayloadSnapshot()?.agentModels?.agents;
    return Array.isArray(agents) && agents.some((entry) => entry?.agent === 'claude-code' && Array.isArray(entry.models) && entry.models.length > 1);
  }, 'the dashboard model catalog');
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
}

async function verifyChatModelSwitch(page: Page): Promise<void> {
  await waitForModelCatalog(page);
  const composerInput = page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' });
  await composerInput.fill('draft kept across the switch');
  await page.locator('button[data-action="session-menu"]:visible').click();
  await page.getByRole('menuitem', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change model' });
  const modelSelect = dialog.locator('select[aria-label="Model"]');
  await modelSelect.waitFor({ timeout: CARD_TIMEOUT_MS });
  const choices = await modelSelect.locator('option').evaluateAll((options) => options.map((option) => (option instanceof HTMLOptionElement ? option.value : '')));
  const shownModel = await modelSelect.inputValue();
  const otherModel = choices.find((choice) => choice !== shownModel);
  assert.ok(otherModel, `the Model control lists more than the shown model (${choices.join(', ')})`);
  await modelSelect.selectOption(otherModel);
  await page.waitForFunction(() => {
    const stop = document.querySelector<HTMLButtonElement>('.session-chat .chat-composer button[aria-label="Stop"]');
    return stop !== null && stop.disabled;
  }, undefined, { timeout: CARD_TIMEOUT_MS });
  await dialog.getByRole('button', { name: 'Switch', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.locator('button[data-action="session-menu"]:visible').click();
  await page.getByRole('menuitem', { name: 'Change model' }).click();
  assert.equal(await page.getByRole('dialog', { name: 'Change model' }).locator('select[aria-label="Model"]').inputValue(), otherModel, 'the dialog shows the model the session switched to');
  await page.keyboard.press('Escape');
  assert.equal(await composerInput.inputValue(), 'draft kept across the switch', 'an unsent draft survives the restart a model switch causes');
  await composerInput.fill('');
  await waitForTurnRunning(page, true);
  await page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true }).click();
  await waitForTurnRunning(page, false);
}

async function verifyComposerHeightSteady(page: Page): Promise<void> {
  const composerInput = page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' });
  const emptyComposerHeight = await composerInput.evaluate((input) => input.getBoundingClientRect().height);
  await composerInput.click();
  await page.keyboard.type('h');
  const typedComposerHeight = await composerInput.evaluate((input) => input.getBoundingClientRect().height);
  assert.equal(typedComposerHeight, emptyComposerHeight, 'typing the first character keeps the composer height');
  await composerInput.fill('');
}

async function verifyComposerKeepsFollowing(page: Page): Promise<void> {
  const composerInput = page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' });
  await page.locator('.session-chat .chat-log').evaluate((chatLog) => {
    const tallReply = document.createElement('div');
    tallReply.className = 'chat-reply chat-test-filler';
    tallReply.style.height = '1600px';
    chatLog.append(tallReply);
  });
  const scroller = page.locator('.session-chat .chat-scroller');
  const scrollerBoxOf = () => scroller.evaluate((element) => JSON.stringify(element.getBoundingClientRect()));
  const scrollerBoxBefore = await scrollerBoxOf();
  await composerInput.click();
  for (let line = 0; line < 8; line += 1) {
    await page.keyboard.type(`line ${line}`);
    await page.keyboard.press('Shift+Enter');
  }
  assert.equal(await scrollerBoxOf(), scrollerBoxBefore, 'growing the composer leaves the conversation where it is');
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.session-chat .chat-scroller');
    const lastEntry = document.querySelector('.session-chat .chat-log > :last-child');
    const dock = document.querySelector('.session-chat .chat-dock');
    if (!scroller || !lastEntry || !dock) return false;
    scroller.scrollTop = scroller.scrollHeight;
    return lastEntry.getBoundingClientRect().bottom <= dock.getBoundingClientRect().top;
  }, undefined, { timeout: CARD_TIMEOUT_MS });
  const jumpButton = page.locator('.session-chat').getByRole('button', { name: 'Jump to latest' });
  assert.equal(await jumpButton.isVisible(), false, 'growing the composer does not offer Jump to latest');
  await composerInput.fill('');
  assert.equal(await jumpButton.isVisible(), false, 'shrinking the composer does not offer Jump to latest');
  const scrollerCenter = await scroller.boundingBox();
  assert.ok(scrollerCenter, 'the chat scroller has a box');
  await page.mouse.move(scrollerCenter.x + scrollerCenter.width / 2, scrollerCenter.y + scrollerCenter.height / 2);
  await page.mouse.wheel(0, -20);
  await page.waitForTimeout(300);
  assert.equal(await jumpButton.isVisible(), false, 'a small scroll up near the bottom keeps Chat following');
  await page.mouse.wheel(0, -600);
  await jumpButton.waitFor({ timeout: CARD_TIMEOUT_MS });
  const readingTop = await scroller.evaluate((element) => element.scrollTop);
  const chatPageButton = page.locator('.session-page-bar').getByRole('button', { name: 'Chat', exact: true });
  await chatPageButton.click();
  await page.locator('.session-chat').waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await openChat(page);
  await jumpButton.waitFor({ timeout: CARD_TIMEOUT_MS });
  await scroller.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await scroller.evaluate((element) => element.scrollTop), readingTop, 'leaving Chat and coming back keeps the reading place');
  await jumpButton.click();
  await jumpButton.waitFor({ state: 'hidden', timeout: CARD_TIMEOUT_MS });
  await page.locator('.session-chat .chat-test-filler').evaluate((filler) => filler.remove());
  await page.locator('.session-chat .chat-scroller').evaluate((scroller) => {
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
  });
  assert.equal(await jumpButton.isVisible(), false, 'a wheel the chat cannot take does not offer Jump to latest');
}

async function verifySendFollowsLatest(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.session-chat .chat-scroller');
    return scroller !== null && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2;
  }, undefined, { timeout: CARD_TIMEOUT_MS });
}

async function startCountingSentPrompts(page: Page, sentText: string): Promise<void> {
  await page.evaluate((text) => {
    const counts: number[] = [];
    Object.assign(window, { sentPromptCounts: counts });
    const countFrame = () => {
      const prompts = document.querySelectorAll('.session-chat .chat-scroll-content .chat-prompt');
      counts.push([...prompts].filter((prompt) => prompt.textContent === text).length);
      if (counts.length < 600) requestAnimationFrame(countFrame);
    };
    requestAnimationFrame(countFrame);
  }, sentText);
}

async function verifySentPromptNeverBlinks(page: Page): Promise<void> {
  const counts = await page.evaluate(() => Reflect.get(window, 'sentPromptCounts') as number[]);
  const shownFrom = counts.findIndex((count) => count > 0);
  assert.ok(shownFrom >= 0, 'the sent message shows');
  assert.deepEqual([...new Set(counts.slice(shownFrom))], [1], 'the sent message shows once in every frame from send until the conversation has it');
}

export async function verifyChatApprovals(page: Page): Promise<void> {
  await openChat(page);
  await verifyChatModelSwitch(page);
  await verifyComposerKeepsFollowing(page);
  await startCountingSentPrompts(page, 'ask-chat');
  await sendFromComposer(page, 'ask-chat');
  await verifySendFollowsLatest(page);
  const openCard = page.locator('.session-chat .chat-card[data-card-type="permission"][data-resolved="false"]');
  await openCard.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await openCard.innerText(), /Bash/, 'the permission card names the tool');
  await verifySentPromptNeverBlinks(page);
  await openCard.getByRole('button', { name: 'Allow', exact: true }).click();
  const answeredCard = page.locator('.session-chat .chat-card[data-card-type="permission"][data-resolved="true"]');
  await answeredCard.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await answeredCard.innerText(), /Allowed/, 'the answered card reads Allowed');
  await page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true }).click();
  await waitForTurnRunning(page, false);
  const dock = page.locator('.session-chat .chat-dock');
  const dockBoxOf = () => dock.evaluate((element) => JSON.stringify(element.getBoundingClientRect()));
  const idleDockBox = await dockBoxOf();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await sendFromComposer(page, 'work-glimmervoid');
  const stopButton = page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true });
  await page.waitForFunction(() => {
    const stop = document.querySelector<HTMLButtonElement>('.session-chat .chat-composer button[aria-label="Stop"]');
    return stop !== null && !stop.disabled;
  }, undefined, { timeout: CARD_TIMEOUT_MS });
  await page.locator('.session-chat .chat-activity .chat-activity-mark').waitFor({ timeout: CARD_TIMEOUT_MS });
  await verifyGlimmervoidCallSpinsMark(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await dockBoxOf(), idleDockBox, 'starting a turn swaps Send for Stop without moving the composer');
  await verifyHeldMessageWaitsForTurnEnd(page);
  await stopButton.click();
  await page.locator('.session-chat .chat-composer button[aria-label="Send"]:visible').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await dockBoxOf(), idleDockBox, 'ending a turn swaps Stop for Send without moving the composer');
  await verifyComposerAttachesImage(page);
}

async function waitForTurnRunning(page: Page, isTurnRunning: boolean): Promise<void> {
  await page.waitForFunction((expected) => {
    const stop = document.querySelector<HTMLButtonElement>('.session-chat .chat-composer button[aria-label="Stop"]');
    return stop !== null && stop.disabled === !expected;
  }, isTurnRunning, { timeout: CARD_TIMEOUT_MS });
}

async function waitForDraft(page: Page, expectedDraft: string, reason: string): Promise<void> {
  const input = page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' });
  await page.waitForFunction((expected) => {
    const textbox = document.querySelector<HTMLTextAreaElement>('.session-chat .chat-composer textarea');
    return textbox !== null && textbox.value === expected;
  }, expectedDraft, { timeout: CARD_TIMEOUT_MS }).catch(() => undefined);
  assert.equal(await input.inputValue(), expectedDraft, reason);
}

async function verifyHeldMessageWaitsForTurnEnd(page: Page): Promise<void> {
  const chat = page.locator('.session-chat');
  const input = chat.getByRole('textbox', { name: 'Message the agent' });
  const heldRow = chat.locator('.chat-queued-row').filter({ hasText: 'Queued until the turn ends' });
  await sendFromComposer(page, 'work');
  await heldRow.waitFor({ timeout: CARD_TIMEOUT_MS });
  const secondTab = await page.context().newPage();
  try {
    await secondTab.goto(page.url());
    const secondTabRow = secondTab.locator('.session-chat .chat-queued-row').filter({ hasText: 'Queued until the turn ends' });
    await secondTabRow.waitFor({ timeout: CARD_TIMEOUT_MS });
    await heldRow.getByRole('button', { name: 'Cancel', exact: true }).click();
    await secondTabRow.waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  } finally {
    await secondTab.close();
  }
  await heldRow.waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await waitForDraft(page, 'work', 'Cancel puts the held message back in the composer');
  await input.press('Enter');
  await heldRow.waitFor({ timeout: CARD_TIMEOUT_MS });
  await input.press('Escape');
  await heldRow.waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await waitForDraft(page, 'work', 'Esc puts the held message back in the composer');
  await waitForTurnRunning(page, true);
  await input.press('Enter');
  await heldRow.waitFor({ timeout: CARD_TIMEOUT_MS });
  await chat.getByRole('button', { name: 'Stop', exact: true }).click();
  await waitForTurnRunning(page, false);
  await waitForTurnRunning(page, true);
}

async function verifyGlimmervoidCallSpinsMark(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const mark = document.querySelector('.session-chat .chat-activity .chat-activity-mark');
    if (mark === null) return false;
    const rotationSine = Number(getComputedStyle(mark).transform.match(/^matrix\(([^,]+), ([^,]+)/)?.[2] ?? 0);
    return Math.abs(rotationSine) > 0.01;
  }, undefined, { timeout: CARD_TIMEOUT_MS, polling: 'raf' });
}

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function verifyComposerAttachesImage(page: Page): Promise<void> {
  const scroller = page.locator('.session-chat .chat-scroller');
  const scrollerBoxOf = () => scroller.evaluate((element) => JSON.stringify(element.getBoundingClientRect()));
  const scrollerBoxBefore = await scrollerBoxOf();
  await page.locator('.session-chat .chat-composer-file-picker').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG });
  await page.locator('.session-chat .chat-composer-attachment img.chat-prompt-thumbnail-image').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await scrollerBoxOf(), scrollerBoxBefore, 'an attachment leaves the conversation where it is');
}

export async function verifyChatTerminal(page: Page): Promise<void> {
  await openChat(page);
  await verifyComposerHeightSteady(page);
  await sendFromComposer(page, 'ask');
  const terminalInCard = page.locator('.session-chat .chat-card[data-card-type="live-terminal"] .terminal-wrap');
  await terminalInCard.waitFor({ timeout: CARD_TIMEOUT_MS });
  const terminalBox = await terminalInCard.boundingBox();
  assert.ok(terminalBox && terminalBox.height >= MIN_INLINE_TERMINAL_HEIGHT_PX, `the inline terminal is tall enough to answer a menu (${terminalBox?.height ?? 0}px)`);
  const focusedElementClass = await page.evaluate(() => document.activeElement?.className ?? '');
  assert.match(focusedElementClass, /chat-composer-input/, 'a terminal shown inline leaves the keyboard on the composer');
  const noteCounts = await page.evaluate(async () => {
    const card = document.querySelector('.session-card[data-id]');
    const sessionId = card?.getAttribute('data-id') ?? '';
    const cardProblemsUrl = '/session-card/card-problems.ts';
    const { setSessionAttentionNotes } = await import(cardProblemsUrl);
    setSessionAttentionNotes(sessionId, [{ origin: 'loop-guard', note: 'first note', at: 1 }]);
    await Promise.resolve();
    setSessionAttentionNotes(sessionId, [{ origin: 'loop-guard', note: 'second note', at: 2 }]);
    await Promise.resolve();
    return { inChat: document.querySelectorAll('.session-chat .session-attention-note').length, onCard: card?.querySelectorAll(':scope > .session-attention-note').length ?? 0 };
  });
  assert.deepEqual(noteCounts, { inChat: 0, onCard: 1 }, 'a note added while Chat holds the terminal stays one line on the session card');
  await terminalInCard.click();
  await page.keyboard.type('stop');
  await page.keyboard.press('Enter');
  await page.locator('.session-chat .chat-card[data-card-type="live-terminal"]').waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  const isTerminalHome = await page.evaluate(() => {
    const terminalWrap = document.querySelector('.session-card .terminal-wrap');
    return terminalWrap !== null && terminalWrap.closest('.session-chat') === null;
  });
  assert.ok(isTerminalHome, 'the terminal returns to its session card once the wait ends');
  assert.equal(await page.locator('.session-card > .session-attention-note').count(), 1, 'the note outlives the inline terminal');
}

async function verifyComposerPassesDashboardShortcuts(page: Page): Promise<void> {
  await page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' }).click();
  const isShortcutHandled = page.evaluate(() => new Promise<boolean>((resolve) => {
    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyJ') resolve(event.defaultPrevented);
    });
  }));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyJ' : 'Alt+KeyJ');
  assert.equal(await isShortcutHandled, true, 'the next-session shortcut runs while the Chat message box has focus');
}

export async function verifyChatStaysDefault(page: Page): Promise<void> {
  await openChat(page);
  await verifyComposerPassesDashboardShortcuts(page);
  await page.reload();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.locator('.session-page-bar').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('.session-chat').waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await page.reload();
  await page.locator('#focus-pane-terminal .session-card .terminal-wrap').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await page.locator('.session-chat').count(), 0, 'closing Chat makes the terminal the first view again');
}

export async function verifyChatStaysDefaultOnPhone(page: Page): Promise<void> {
  await page.locator('button[data-action="show-chat"]:visible').first().click();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.locator('button[data-action="back-to-terminal"]:visible').click();
  await page.locator('button[data-action="back-to-board"]:visible').click();
  await page.locator('.phone-board-list button.session-row').first().click();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.goBack();
  await page.goBack();
  await page.locator('.phone-board-list button.session-row').first().click();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
}
