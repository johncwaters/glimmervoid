import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { findSessionWorktree, pollFor } from './review-changes.ts';
import { AGENT_DONE_LINE, DONE_CHILD_LINES, DONE_CHILD_NAME } from './cases-core.ts';

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
    tallReply.className = 'chat-turn chat-test-filler';
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
    const tops: number[] = [];
    Object.assign(window, { sentPromptCounts: counts, sentPromptTops: tops });
    const countFrame = () => {
      const prompts = document.querySelectorAll('.session-chat .chat-scroll-content .chat-prompt');
      const sentPrompts = [...prompts].filter((prompt) => prompt.textContent === text);
      counts.push(sentPrompts.length);
      const shownTop = sentPrompts[0]?.getBoundingClientRect().top;
      if (shownTop !== undefined) tops.push(Math.round(shownTop));
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
  await page.waitForFunction(() => document.querySelector('.session-chat [data-part-id^="sent-"]') === null, undefined, { timeout: CARD_TIMEOUT_MS });
  const tops = await page.evaluate(() => Reflect.get(window, 'sentPromptTops') as number[]);
  assert.deepEqual([...new Set(tops)], [tops[0]], 'the sent message never moves from send until the conversation has it');
  const isPromptAboveCard = await page.locator('.session-chat .chat-log').evaluate((log) => {
    const sentPrompt = [...log.querySelectorAll('.chat-prompt')].find((prompt) => prompt.textContent === 'ask-chat');
    const card = log.querySelector('.chat-card[data-card-type="permission"]');
    if (!sentPrompt || !card) return false;
    return (sentPrompt.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  assert.ok(isPromptAboveCard, 'the question asked after a send shows below the sent message');
}

async function verifyOpenCardStaysLastAcrossRemount(page: Page): Promise<void> {
  await page.locator('.session-page-bar').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('.session-chat').waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await openChat(page);
  const openCard = page.locator('.session-chat .chat-card[data-card-type="permission"][data-resolved="false"]');
  await openCard.waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.locator('.session-chat .chat-log .chat-prompt').first().waitFor({ timeout: CARD_TIMEOUT_MS });
  const isOpenCardLast = await page.locator('.session-chat .chat-log').evaluate((log) => log.lastElementChild?.matches('.chat-card[data-card-type="permission"][data-resolved="false"]') === true);
  assert.ok(isOpenCardLast, 'a card already open when Chat opens sits below the history it loads');
  const isOpenCardInView = await openCard.evaluate((card) => {
    const scroller = card.closest('.chat-scroller');
    if (!scroller) return false;
    const cardBox = card.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    return cardBox.bottom > scrollerBox.top && cardBox.top < scrollerBox.bottom;
  });
  assert.ok(isOpenCardInView, 'the open card is in view without scrolling');
}

export async function verifyChatApprovals(page: Page): Promise<void> {
  await openChat(page);
  assert.equal(await page.locator('.session-chat .chat-done').isHidden(), true, 'a session with no checks and no done lines shows no Checked at turn end panel');
  await verifyChatModelSwitch(page);
  await verifyComposerKeepsFollowing(page);
  await startCountingSentPrompts(page, 'ask-chat');
  await sendFromComposer(page, 'ask-chat');
  await verifySendFollowsLatest(page);
  const openCard = page.locator('.session-chat .chat-card[data-card-type="permission"][data-resolved="false"]');
  await openCard.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await openCard.innerText(), /Bash/, 'the permission card names the tool');
  await verifySentPromptNeverBlinks(page);
  await verifyOpenCardStaysLastAcrossRemount(page);
  await answerOpenCardFromComposer(page, openCard);
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
  await verifyQuestionTakesRecommendedOnEnter(page);
  await verifyComposerAttachesImage(page);
}

async function verifyQuestionTakesRecommendedOnEnter(page: Page): Promise<void> {
  const composer = page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' });
  await composer.fill('');
  await sendFromComposer(page, 'ask-question-chat');
  const firstQuestion = page.locator('.session-chat .chat-card[data-card-type="question"][data-resolved="false"]');
  await firstQuestion.waitFor({ timeout: CARD_TIMEOUT_MS });
  await firstQuestion.getByRole('button', { name: /^Move now/ }).focus();
  await page.keyboard.press('Enter');
  const answeredByFocus = page.locator('.session-chat .chat-card[data-card-type="question"][data-resolved="true"]');
  await answeredByFocus.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await answeredByFocus.innerText(), /Answered: Move now$/m, 'Enter on a focused option answers with that option');
  await page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true }).click();
  await waitForTurnRunning(page, false);
  await composer.fill('');
  await sendFromComposer(page, 'ask-question-chat');
  const openQuestion = page.locator('.session-chat .chat-card[data-card-type="question"][data-resolved="false"]');
  await openQuestion.waitFor({ timeout: CARD_TIMEOUT_MS });
  await composer.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.session-chat .chat-card[data-card-type="question"][data-resolved="true"]').count(), 1, 'a key pressed as the card appears answers nothing');
  await openQuestion.and(page.locator('[data-keys-ready]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  const optionTexts = await openQuestion.locator('.chat-card-option .ui-button').allInnerTexts();
  assert.match(optionTexts[0] ?? '', /^Run both for a week\s*Recommended\s*Enter$/, 'the recommended option comes first with its tag and the Enter key cap');
  assert.match(optionTexts[1] ?? '', /^Move now\s*2$/, 'the other option keeps its position key');
  await composer.focus();
  await page.keyboard.press('Enter');
  const answeredQuestion = page.locator('.session-chat .chat-card[data-card-type="question"][data-resolved="true"]').last();
  await page.waitForFunction(() => document.querySelectorAll('.session-chat .chat-card[data-card-type="question"][data-resolved="true"]').length === 2, undefined, { timeout: CARD_TIMEOUT_MS });
  assert.match(await answeredQuestion.innerText(), /Answered: Run both for a week$/m, 'Enter answers with the recommended option');
}

async function answerOpenCardFromComposer(page: Page, openCard: Locator): Promise<void> {
  const keyCaps = await openCard.locator('.ui-button-shortcut').allInnerTexts();
  assert.deepEqual(keyCaps, ['1', '2', '3'], 'Allow, Deny and Deny with message carry their key caps');
  const composer = page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' });
  await composer.focus();
  await composer.fill('2');
  await page.keyboard.press('1');
  assert.equal(await composer.inputValue(), '21', 'a digit typed into a composer holding text stays text');
  assert.equal(await answeredPermissionCount(page), 0, 'typing into the composer answers no card');
  await composer.fill('');
  await page.keyboard.press('Enter');
  assert.equal(await answeredPermissionCount(page), 0, 'Enter never allows a permission');
  await openCard.and(page.locator('[data-keys-ready]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.keyboard.press('1');
}

function answeredPermissionCount(page: Page): Promise<number> {
  return page.locator('.session-chat .chat-card[data-card-type="permission"][data-resolved="true"]').count();
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

async function verifyBoardCardKeepsPlace(page: Page): Promise<void> {
  const logOrder = () => page.locator('.session-chat .chat-log > [data-part-id]').evaluateAll((parts) => parts.map((part) => (part instanceof HTMLElement ? (part.dataset.cardType ?? part.className) : '')).join(','));
  await sendFromComposer(page, 'ask-chat');
  await page.waitForFunction(() => [...document.querySelectorAll('.session-chat .chat-log > [data-part-id]')].some((part) => part.textContent?.includes('ask-chat')), undefined, { timeout: CARD_TIMEOUT_MS });
  const orderBeforeReopen = await logOrder();
  const chatPageButton = page.locator('.session-page-bar').getByRole('button', { name: 'Chat', exact: true });
  await chatPageButton.click();
  await chatPageButton.click();
  await page.locator('.session-chat .chat-card[data-card-type="board-change"]').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await logOrder(), orderBeforeReopen, 'closing and reopening Chat keeps the card where it was in the history');
}

async function verifyBoardChangeCard(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const sessionId = document.querySelector('.session-card[data-id]')?.getAttribute('data-id') ?? '';
    const tileStoreUrl = '/whiteboard/board-tile-store.ts';
    const { applyAgentChange } = await import(tileStoreUrl);
    const changeOf = (title: string) => ({ type: 'whiteboard-agent-change', boardId: 'harness-board', version: 1, at: Date.now(), change: { author: { id: sessionId, name: 'Claude' }, boxes: [{ id: title, title, rect: { x: 0, y: 0, width: 200, height: 100 } }] } });
    applyAgentChange(changeOf('Parse feed'));
    applyAgentChange(changeOf('Store rows'));
  });
  await page.locator('.session-chat .chat-card[data-card-type="board-change"]').waitFor({ timeout: CARD_TIMEOUT_MS });
  const cardTitles = await page.locator('.session-chat .chat-log .chat-card[data-card-type="board-change"]').allTextContents();
  assert.equal(cardTitles.length, 1, 'two agent changes in one turn share one card in the chat history');
  assert.match(cardTitles[0] ?? '', /Claude changed Store rows/, 'the card names the latest change');
  assert.equal(await page.locator('.session-chat .chat-dock .chat-card').count(), 0, 'nothing about the change floats over the chat');
  await page.locator('.session-chat .chat-card[data-card-type="board-change"]').getByRole('button', { name: 'Focus this', exact: true }).click();
  const focusedBoxIds = await page.evaluate(async () => {
    const boardStoreUrl = '/whiteboard/board-store.ts';
    const { takeBoardFocusFor } = await import(boardStoreUrl);
    return takeBoardFocusFor('harness-board')?.boxes.map((box: { id: string }) => box.id) ?? null;
  });
  assert.ok(focusedBoxIds === null || focusedBoxIds.join() === 'Store rows', 'Focus this asks the board to frame the changed card');
  assert.equal(await page.locator('.session-chat .chat-card[data-card-type="board-change"]').count(), 1, 'the card stays in the history after Focus this');
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
  await verifyBoardChangeCard(page);
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
  await verifyBoardCardKeepsPlace(page);
}

export async function verifyChatSignIn(page: Page): Promise<void> {
  await openChat(page);
  await sendFromComposer(page, 'login-expired');
  const signInCard = page.locator('.session-chat .chat-card[data-card-type="sign-in"]');
  await page.locator('.session-chat .chat-card[data-card-type="sign-in"][data-keys-ready]').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await signInCard.locator('.chat-card-heading').textContent(), 'Claude Code needs you to sign in');
  assert.equal(await page.locator('.session-chat .chat-card[data-card-type="live-terminal"]').count(), 0, 'a failed login offers sign-in instead of the bare terminal');
  assert.equal(await page.locator('.session-chat .terminal-wrap').count(), 0, 'the terminal stays home until Sign in is pressed');
  const cardTopBefore = (await signInCard.boundingBox())?.y ?? -1;
  await page.keyboard.press('1');
  await signInCard.locator('.chat-terminal-slot .terminal-wrap').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal((await signInCard.boundingBox())?.y ?? -2, cardTopBefore, 'opening the terminal grows the card downward and leaves its top in place');
  await page.locator('.session-chat .chat-card[data-card-type="sign-in"][data-resolved="true"]').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await signInCard.locator('.chat-card-heading').textContent(), 'Signed in to Claude Code');
  assert.equal(await page.locator('.session-chat .terminal-wrap').count(), 0, 'the terminal returns to its session card once the agent reports the sign-in');
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

export const DONE_MEANS_UNTRACKED_FILE = 'done-means.txt';
export const DONE_MEANS_TEST_FILE = 'tests/keeps.test.ts';
const DONE_MEANS_REMOVED_ASSERTION = 'assert.equal(total, 2);';
export const DONE_MEANS_KEPT_TEST = `test('adds', () => {\n  ${DONE_MEANS_REMOVED_ASSERTION}\n});\n`;

async function pressInEmptyComposer(page: Page, key: string): Promise<void> {
  await page.locator('.session-chat .chat-done .chat-card[data-resolved="false"][data-keys-ready]').waitFor({ timeout: CARD_TIMEOUT_MS });
  const input = page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' });
  await input.focus();
  await input.press(key);
}

export async function verifyChatDoneMeans(page: Page, projectDirectory: string): Promise<void> {
  await openChat(page);
  const worktreePath = await pollFor('the session worktree', CARD_TIMEOUT_MS, () => findSessionWorktree(projectDirectory));
  await waitForTurnRunning(page, false);
  await sendFromComposer(page, 'declare-done');
  await waitForOutboxEmpty(page);
  await sendFromComposer(page, 'take-any-prompt');
  await waitForTurnRunning(page, true);
  await waitForOutboxEmpty(page);
  await stopTurnPastHints(page);
  await waitForTurnRunning(page, false);
  await sendFromComposer(page, 'work');
  await waitForTurnRunning(page, true);
  await waitForOutboxEmpty(page);
  await fs.writeFile(path.join(worktreePath, DONE_MEANS_UNTRACKED_FILE), 'written during the turn\n', 'utf8');
  await fs.writeFile(path.join(worktreePath, DONE_MEANS_TEST_FILE), DONE_MEANS_KEPT_TEST.replace(`  ${DONE_MEANS_REMOVED_ASSERTION}\n`, ''), 'utf8');
  await stopTurnPastHints(page);
  await waitForTurnRunning(page, false);
  const panel = page.locator('.session-chat .chat-done');
  const failedLine = panel.locator('.chat-done-line[data-status="failed"]', { hasText: 'committed' });
  await failedLine.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await failedLine.innerText(), /Glimmervoid ran/i, 'a failed check names who proved it');
  assert.match(await failedLine.locator('.chat-done-evidence').innerText(), new RegExp(DONE_MEANS_UNTRACKED_FILE), 'a failed check shows its output tail');
  assert.equal(await panel.locator('.chat-done-line[data-status="passed"]', { hasText: 'status' }).count(), 1, 'a passing check reads passed');
  const testKeepingLine = panel.locator('.chat-done-line[data-status="failed"]', { hasText: 'Keeps every test' });
  assert.equal(await testKeepingLine.locator('.chat-done-evidence').innerText(), `${DONE_MEANS_TEST_FILE}:2 removed: ${DONE_MEANS_REMOVED_ASSERTION}`, 'a removed assertion fails Keeps every test, naming file:line and the removed text');
  assert.equal(await panel.locator('.chat-card-heading').innerText(), 'Is the work done?', 'the finished turn asks whether the work is done');
  assert.equal(await panel.locator('.chat-card .chat-card-recommended').count(), 0, 'neither answer is marked Recommended');
  const agentLine = panel.locator('.chat-done-line', { hasText: AGENT_DONE_LINE.text });
  assert.match(await agentLine.innerText(), /Waiting for you/, 'an agent command does not run before the operator allows it');
  assert.equal(await agentLine.locator('.chat-done-command').innerText(), AGENT_DONE_LINE.command, 'the agent line shows the command it asks to run');
  await panel.getByRole('button', { name: 'Allow commands', exact: true }).click();
  await panel.locator('.chat-done-line[data-status="passed"]', { hasText: AGENT_DONE_LINE.text }).waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await panel.getByRole('button', { name: 'Allow commands', exact: true }).count(), 0, 'an allowed command asks no more');
  assert.equal(await panel.locator('.chat-done-line[data-status="failed"]').count(), 2, 'the allowed run keeps both failed lines');
  await pressInEmptyComposer(page, '2');
  await waitForTurnRunning(page, true);
  await waitForOutboxEmpty(page);
  assert.equal(await panel.locator('.chat-card[data-resolved="false"]').count(), 0, 'a Not done answer takes no second key');
  await stopTurnPastHints(page);
  await waitForTurnRunning(page, false);
  await pressInEmptyComposer(page, '1');
  await waitForTurnRunning(page, true);
  const composer = page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' });
  assert.equal(await composer.inputValue(), '', 'a 1 in the empty composer answers Done instead of typing');
  await waitForOutboxEmpty(page);
  await verifySpawnedChildDoneMeans(page);
}

async function verifySpawnedChildDoneMeans(page: Page): Promise<void> {
  await stopTurnPastHints(page);
  await waitForTurnRunning(page, false);
  await sendFromComposer(page, 'spawn-done-child');
  const childRow = page.locator('button.session-row', { hasText: DONE_CHILD_NAME });
  await childRow.waitFor({ timeout: CARD_TIMEOUT_MS });
  await childRow.click();
  await openChat(page);
  await waitForTurnRunning(page, false);
  await sendFromComposer(page, 'take-any-prompt');
  await waitForTurnRunning(page, true);
  await waitForOutboxEmpty(page);
  await stopTurnPastHints(page);
  await waitForTurnRunning(page, false);
  const panel = page.locator('.session-chat .chat-done');
  for (const doneLine of DONE_CHILD_LINES) {
    await panel.locator('.chat-done-line[data-status="not-checked"]', { hasText: doneLine }).waitFor({ timeout: CARD_TIMEOUT_MS });
  }
  const statusCheckLine = panel.locator('.chat-done-line[data-status="passed"]').filter({ has: page.locator('.chat-done-text', { hasText: /^status$/ }) });
  await statusCheckLine.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await statusCheckLine.innerText(), /Glimmervoid ran/i, 'a spawned child with done lines runs the repo checks at turn end');
}

async function stopTurnPastHints(page: Page): Promise<void> {
  const hintCards = page.locator('aside.feature-hint');
  await page.addLocatorHandler(hintCards, (hintCard) => hintCard.getByRole('button', { name: 'Dismiss', exact: true }).click());
  try {
    await page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true }).click();
  } finally {
    await page.removeLocatorHandler(hintCards);
  }
}

async function waitForOutboxEmpty(page: Page): Promise<void> {
  await page.locator('.session-chat .chat-queued-row').first().waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
}
