import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { findSessionWorktree, pollFor } from './review-changes.ts';
import { AGENT_DONE_LINE, AWAY_REPLY_TEXT, DONE_CHILD_NAME } from './cases-core.ts';
import { PANEL_MIN_CHANGED_LINES } from '../../shared/contracts/verification.ts';

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
  const railModelButton = page.locator('.session-chat .chat-rail').getByRole('button', { name: 'Change model' });
  await railModelButton.waitFor({ timeout: CARD_TIMEOUT_MS });
  const [railBottom, composerInnerBottom] = await page.locator('.session-chat .chat-composer').evaluate((composer) => {
    const rail = composer.querySelector('.chat-rail');
    return [rail?.getBoundingClientRect().bottom ?? 0, composer.getBoundingClientRect().bottom - composer.clientTop];
  });
  assert.ok(Math.abs(railBottom - composerInnerBottom) < 1, `the status row runs to the composer's bottom edge, so its text centers under the divider (row ${railBottom}, edge ${composerInnerBottom})`);
  await railModelButton.click();
  const modelPanel = page.locator('.session-chat .chat-model-pick');
  await modelPanel.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await page.getByRole('dialog', { name: 'Change model' }).count(), 0, 'the status row opens a panel above the message box, not a dialog');
  assert.equal(await modelPanel.locator('.add-session-row[aria-selected="true"]').getAttribute('data-key'), `native:${otherModel}`, 'the panel marks the model the session switched to');
  await page.keyboard.press('Escape');
  await modelPanel.waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  assert.equal(await railModelButton.evaluate((modelName) => modelName === document.activeElement), true, 'Escape closes the panel and returns focus to the model name');
  await railModelButton.click();
  const nextModelRow = modelPanel.locator('.add-session-row[aria-selected="false"][data-key^="native:"]').first();
  const nextModelKey = await nextModelRow.getAttribute('data-key');
  await nextModelRow.click();
  const defaultEffortRow = modelPanel.locator('.add-session-row[data-key="default"]');
  if ((await defaultEffortRow.count()) > 0) await defaultEffortRow.click();
  await modelPanel.waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await railModelButton.waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.waitForFunction((expectedKey) => {
    const railButton = document.querySelector<HTMLButtonElement>('.session-chat .chat-rail-model');
    if (railButton === null || railButton.hidden) return false;
    if (document.querySelector('.session-chat .chat-model-pick') !== null) railButton.click();
    railButton.click();
    const pickedRow = document.querySelector('.session-chat .chat-model-pick .add-session-row[aria-selected="true"]');
    return pickedRow?.getAttribute('data-key') === expectedKey;
  }, nextModelKey, { timeout: CARD_TIMEOUT_MS, polling: 500 });
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
      const shownPrompt = sentPrompts[0];
      const contentTop = shownPrompt?.closest('.chat-scroll-content')?.getBoundingClientRect().top;
      if (shownPrompt && contentTop !== undefined) tops.push(Math.round(shownPrompt.getBoundingClientRect().top - contentTop));
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
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('chat-composer-input') ?? false), true, 'opening Chat on a desktop layout leaves the caret in the message input');
  assert.equal(await page.locator('.session-chat .chat-done-pill').count(), 0, 'a session with no checks and no done lines shows no check result');
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
  await verifyInterimRepliesRideActivityLine(page);
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
  const optionTexts = await openQuestion.locator('.chat-card-option').allInnerTexts();
  assert.match(optionTexts[0] ?? '', /^Run both for a week\s*Recommended\s*Enter/, 'the recommended option comes first with its tag and the Enter key cap');
  assert.match(optionTexts[1] ?? '', /^Move now\s*2/, 'the other option keeps its position key');
  await composer.focus();
  await page.keyboard.press('Enter');
  const answeredQuestion = page.locator('.session-chat .chat-card[data-card-type="question"][data-resolved="true"]').last();
  await page.waitForFunction(() => document.querySelectorAll('.session-chat .chat-card[data-card-type="question"][data-resolved="true"]').length === 2, undefined, { timeout: CARD_TIMEOUT_MS });
  assert.match(await answeredQuestion.innerText(), /Answered: Run both for a week$/m, 'Enter answers with the recommended option');
  await page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true }).click();
  await waitForTurnRunning(page, false);
  await sendFromComposer(page, 'ask-question-chat');
  await openQuestion.and(page.locator('[data-keys-ready]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await openQuestion.innerText(), /Dismiss\s*Esc\s*Stops the agent/, 'an open question carries the Dismiss control and what it does');
  await composer.focus();
  await page.keyboard.down('Escape');
  await page.keyboard.down('Escape');
  await page.keyboard.up('Escape');
  const dismissedQuestion = page.locator('.session-chat .chat-card[data-card-type="question"][data-resolved="true"]').last();
  await page.waitForFunction(() => document.querySelectorAll('.session-chat .chat-card[data-card-type="question"][data-resolved="true"]').length === 3, undefined, { timeout: CARD_TIMEOUT_MS });
  assert.match(await dismissedQuestion.innerText(), /Dismissed$/m, 'Escape in the composer dismisses the open question');
  assert.equal(await page.locator('.session-chat .chat-composer').isVisible(), true, 'Escape with a question open does not leave Chat');
  assert.equal(await openQuestion.count(), 0, 'the dismissed question leaves no open card');
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

async function startWatchingArrivingText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.documentElement;
    delete root.dataset.sawArrivingText;
    new MutationObserver(() => {
      if (document.querySelector('.session-chat .chat-turn-text[data-arriving]')) root.dataset.sawArrivingText = 'true';
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-arriving'] });
  });
}

async function waitForAwayReplyCount(page: Page, expectedCount: number): Promise<void> {
  await page.waitForFunction(({ expected, replyText }) => {
    const texts = [...document.querySelectorAll('.session-chat .chat-log .chat-turn-text')].filter((text) => text.textContent?.trim() === replyText);
    return texts.length === expected;
  }, { expected: expectedCount, replyText: AWAY_REPLY_TEXT }, { timeout: CARD_TIMEOUT_MS });
}

export async function verifyChatAwayReply(page: Page): Promise<void> {
  await openChat(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const sawArrivingText = () => page.evaluate(() => document.documentElement.dataset.sawArrivingText === 'true');
  await startWatchingArrivingText(page);
  await sendFromComposer(page, 'away-reply');
  await waitForAwayReplyCount(page, 1);
  assert.equal(await sawArrivingText(), true, 'a reply that comes in while Chat is watched animates in');
  await page.waitForFunction(() => document.querySelector('.session-chat :is(.chat-turn-text[data-arriving], [data-reveal-last])') === null, undefined, { timeout: CARD_TIMEOUT_MS });
  await waitForTurnRunning(page, false);
  await page.locator('.session-chat .chat-log').evaluate((chatLog) => {
    const tallFiller = document.createElement('div');
    tallFiller.className = 'chat-test-filler';
    tallFiller.style.height = '1600px';
    chatLog.prepend(tallFiller);
  });
  const scrollerBox = await page.locator('.session-chat .chat-scroller').boundingBox();
  assert.ok(scrollerBox, 'the chat scroller has a box');
  await page.mouse.move(scrollerBox.x + scrollerBox.width / 2, scrollerBox.y + scrollerBox.height / 2);
  await page.mouse.wheel(0, -600);
  await page.locator('.session-chat').getByRole('button', { name: 'Jump to latest' }).waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.locator('.session-page-bar').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('.session-chat').waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await page.evaluate(() => { delete document.documentElement.dataset.sawArrivingText; });
  await page.evaluate(async ({ replyText, timeoutMs }) => {
    const sessionId = document.querySelector('.session-card[data-id]')?.getAttribute('data-id') ?? '';
    const controlWsUrl = '/control-ws.ts';
    const { sendControlRequest } = await import(controlWsUrl);
    const traceRecordsWithReply = async () => {
      const reply = await sendControlRequest('session-trace', { id: sessionId, endingAt: 'tail' });
      const records: unknown[] = Array.isArray(reply?.records) ? reply.records : [];
      return records.filter((record) => JSON.stringify(record).includes(replyText)).length;
    };
    const repliesBefore = await traceRecordsWithReply();
    await sendControlRequest('chat-send', { id: sessionId, text: 'away-reply', attachments: [] });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && await traceRecordsWithReply() <= repliesBefore) await new Promise((resolve) => setTimeout(resolve, 250));
  }, { replyText: AWAY_REPLY_TEXT, timeoutMs: CARD_TIMEOUT_MS });
  await openChat(page);
  await waitForAwayReplyCount(page, 2);
  assert.equal(await sawArrivingText(), false, 'a reply written while Chat was closed shows at once when Chat opens');
  await page.emulateMedia({ reducedMotion: 'reduce' });
}

async function verifyInterimRepliesRideActivityLine(page: Page): Promise<void> {
  const shownTurnTextsOf = () => page.evaluate(() => {
    const latestTurn = [...document.querySelectorAll('.session-chat .chat-log .chat-turn')].at(-1);
    return [...(latestTurn?.querySelectorAll<HTMLElement>('.chat-turn-body > .chat-turn-text') ?? [])].filter((text) => text.offsetParent !== null).map((text) => text.innerText.trim());
  });
  await sendFromComposer(page, 'narrate');
  await page.waitForFunction(() => document.querySelector('.session-chat .chat-activity-verb')?.textContent === 'Checking the board.', undefined, { timeout: CARD_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('.session-chat .chat-activity-detail')?.textContent?.includes('npm run board') === true, undefined, { timeout: CARD_TIMEOUT_MS });
  const runningTexts = await shownTurnTextsOf();
  assert.equal(runningTexts.length, 1, `a running turn shows only its long reply, not the short ones (${runningTexts.join(' | ')})`);
  assert.match(runningTexts[0] ?? '', /^Build passed/, 'the long reply stays in the turn');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true }).click();
  await waitForTurnRunning(page, false);
  await page.waitForFunction(() => document.querySelector('.session-chat .chat-activity:not([data-idle]) .chat-activity-verb')?.textContent === 'Ready', undefined, { timeout: CARD_TIMEOUT_MS, polling: 'raf' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => [...document.querySelectorAll('.session-chat .chat-log .chat-turn[data-over] .chat-turn-text')].some((text) => text.textContent?.trim() === 'All green.'), undefined, { timeout: CARD_TIMEOUT_MS });
  assert.deepEqual(await shownTurnTextsOf(), ['All green.'], 'the ended turn shows its short final reply');
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
  await page.waitForFunction(() => {
    const logParts = [...document.querySelectorAll<HTMLElement>('.session-chat .chat-log > [data-part-id]')];
    const hasRecordedPrompt = logParts.some((part) => part.dataset.partId?.startsWith('prompt-') && part.textContent?.includes('ask-chat'));
    const hasStandIn = logParts.some((part) => part.dataset.partId?.startsWith('sent-'));
    const hasLiveTerminal = logParts.some((part) => part.dataset.cardType === 'live-terminal');
    return hasRecordedPrompt && !hasStandIn && hasLiveTerminal;
  }, undefined, { timeout: CARD_TIMEOUT_MS });
  const orderBeforeReopen = await logOrder();
  const chatPageButton = page.locator('.session-page-bar').getByRole('button', { name: 'Chat', exact: true });
  await chatPageButton.click();
  await chatPageButton.click();
  await page.locator('.session-chat .chat-board-change[data-card-type="board-change"]').waitFor({ timeout: CARD_TIMEOUT_MS });
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
  await page.locator('.session-chat .chat-board-change[data-card-type="board-change"]').waitFor({ timeout: CARD_TIMEOUT_MS });
  const cardTitles = await page.locator('.session-chat .chat-log .chat-board-change[data-card-type="board-change"]').allTextContents();
  assert.equal(cardTitles.length, 1, 'two agent changes in one turn share one card in the chat history');
  assert.match(cardTitles[0] ?? '', /^Changed Store rows/, 'the row names the latest change without the agent name');
  assert.equal(await page.locator('.session-chat .chat-dock .chat-card').count(), 0, 'nothing about the change floats over the chat');
  const showOnBoard = page.locator('.session-chat .chat-board-change .ui-button');
  assert.match(await showOnBoard.innerText(), process.platform === 'darwin' ? /B$/ : /Alt\+B$/, 'Show on board carries the board shortcut');
  const unshownBoardId = await page.evaluate(async () => {
    const sessionId = document.querySelector('.session-card[data-id]')?.getAttribute('data-id') ?? '';
    const tileStoreUrl = '/whiteboard/board-tile-store.ts';
    const { unshownAgentChangeOf } = await import(tileStoreUrl);
    return unshownAgentChangeOf(sessionId)?.boardId ?? null;
  });
  assert.equal(unshownBoardId, 'harness-board', 'the board shortcut has the newest change to frame');
  await showOnBoard.click();
  const focusedBoxIds = await page.evaluate(async () => {
    const boardStoreUrl = '/whiteboard/board-store.ts';
    const { takeBoardFocusFor } = await import(boardStoreUrl);
    return takeBoardFocusFor('harness-board')?.boxes.map((box: { id: string }) => box.id) ?? null;
  });
  const unshownAfterClick = await page.evaluate(async () => {
    const sessionId = document.querySelector('.session-card[data-id]')?.getAttribute('data-id') ?? '';
    const tileStoreUrl = '/whiteboard/board-tile-store.ts';
    const { unshownAgentChangeOf } = await import(tileStoreUrl);
    return unshownAgentChangeOf(sessionId)?.boardId ?? null;
  });
  assert.equal(unshownAfterClick, null, 'Show on board leaves nothing for the board shortcut to frame again');
  assert.ok(focusedBoxIds === null || focusedBoxIds.join() === 'Store rows', 'Show on board asks the board to frame the changed card');
  assert.equal(await page.locator('.session-chat .chat-board-change[data-card-type="board-change"]').count(), 1, 'the row stays in the history after Show on board');
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
  const terminalCard = page.locator('.session-chat .chat-card[data-card-type="live-terminal"]');
  assert.match(await terminalCard.locator('.chat-card-heading').innerText(), /is waiting in its terminal$/, 'the terminal card names the agent');
  assert.equal(await terminalCard.locator('.chat-card-actions button').count(), 1, 'the terminal card offers only Open Terminal');
  await page.locator('.session-chat .chat-activity[data-idle]').waitFor({ state: 'attached', timeout: CARD_TIMEOUT_MS });
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

export async function verifyChatUsageLimit(page: Page): Promise<void> {
  await openChat(page);
  await sendFromComposer(page, 'limit');
  const limitCard = page.locator('.session-chat .chat-card[data-card-type="usage-limit"]');
  await page.locator('.session-chat .chat-card[data-card-type="usage-limit"][data-keys-ready]').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await limitCard.locator('.chat-card-heading').textContent(), 'Weekly limit reached');
  assert.match(await limitCard.locator('.chat-card-text').innerText(), /^This turn stopped\. It resets at \d{1,2}(:\d\d)?(am|pm), in 9h 1[12]m\.$/, 'the card names the reset time and the time left');
  const rowLabel = page.locator('button.session-row[data-prompt="rate-limit"] .session-row-label').first();
  await rowLabel.waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('button.session-row[data-prompt="rate-limit"] .session-row-label')?.textContent?.startsWith('Limit until ') === true, undefined, { timeout: CARD_TIMEOUT_MS });
  await page.keyboard.press('1');
  const switchAccountDialog = page.locator('.dialog', { has: page.locator('.dialog-title', { hasText: 'Switch account' }) });
  await switchAccountDialog.waitFor({ timeout: CARD_TIMEOUT_MS });
  await switchAccountDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await switchAccountDialog.waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' }).focus();
  await page.locator('.session-chat .chat-card[data-card-type="usage-limit"][data-keys-ready]').waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.keyboard.press('2');
  await page.locator('.session-chat .chat-card[data-card-type="usage-limit"][data-resolved="true"]').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await limitCard.locator('.chat-card-receipt').innerText(), /^Continues at \d{1,2}(:\d\d)?(am|pm)\.$/, 'Continue at reset sets the wake and the card says when it continues');
  await page.locator('.session-wake-chip').first().waitFor({ timeout: CARD_TIMEOUT_MS });
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
  await page.waitForFunction(() => document.activeElement?.classList.contains('chat-composer-input') === true, undefined, { timeout: CARD_TIMEOUT_MS });
  await page.locator('.session-page-bar').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('.session-chat').waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await page.reload();
  await page.locator('#focus-pane-terminal .session-card .terminal-wrap').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await page.locator('.session-chat').count(), 0, 'closing Chat makes the terminal the first view again');
}

export async function verifyChatStaysDefaultOnPhone(page: Page): Promise<void> {
  await page.locator('button[data-action="show-chat"]:visible').first().click();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('chat-composer-input') ?? false), false, 'opening Chat on a phone focuses nothing, so the keyboard stays down');
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
  assert.equal(await page.locator('.session-chat .chat-done-pill').count(), 0, 'a turn below the panel line threshold shows no check result');
  await sendFromComposer(page, 'work');
  await waitForTurnRunning(page, true);
  await waitForOutboxEmpty(page);
  await fs.writeFile(path.join(worktreePath, DONE_MEANS_UNTRACKED_FILE), Array.from({ length: PANEL_MIN_CHANGED_LINES }, (_, lineIndex) => `written during the turn ${lineIndex}`).join('\n'), 'utf8');
  await stopTurnPastHints(page);
  await waitForTurnRunning(page, false);
  const pill = page.locator('.session-chat .chat-done-pill');
  await pill.and(page.locator('[data-tone="failed"]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await pill.innerText(), /^\d+ of \d+ checks failed$/, 'the pill reads how many checks failed');
  assert.equal(await pill.evaluate((pillElement) => pillElement.closest('.chat-turn') === null && pillElement.parentElement?.classList.contains('chat-turn-end-row') === true), true, 'with no turn read from the transcript, the pill sits in a row of its own below the log');
  const list = page.locator('.session-chat .chat-done-list');
  assert.equal(await list.isHidden(), true, 'the check list starts closed');
  assert.equal(await pill.getAttribute('aria-expanded'), 'false', 'the pill reports the list closed');
  await pill.click();
  await list.waitFor({ state: 'visible', timeout: CARD_TIMEOUT_MS });
  assert.equal(await pill.getAttribute('aria-expanded'), 'true', 'the pill reports the list open');
  const failedLine = list.locator('.chat-done-line[data-status="failed"]', { hasText: 'committed' });
  assert.match(await failedLine.locator('.chat-done-proof').innerText(), /Failed/, 'a failed check reads Failed');
  assert.match(await failedLine.locator('.chat-done-command').innerText(), /^git /, 'a failed repo check shows its command');
  assert.match(await failedLine.locator('.chat-done-evidence').innerText(), new RegExp(DONE_MEANS_UNTRACKED_FILE), 'a failed check shows its output tail');
  const passedRow = list.locator('.chat-done-passed');
  assert.match(await passedRow.innerText(), /^Also passed: /, 'the passing checks share one Also passed row');
  assert.match(await passedRow.innerText(), /status/, 'the Also passed row names the repo check that passed');
  assert.match(await passedRow.innerText(), new RegExp(AGENT_DONE_LINE.text), 'the agent command ran with no operator step and is named among the passes');
  assert.equal(await list.locator('.chat-done-line[data-status="passed"]').count(), 0, 'a passing check takes no line of its own');
  assert.equal(await list.locator('.chat-card').count(), 0, 'the check list reports and asks nothing');
  assert.equal(await page.locator('.session-chat').getByRole('button', { name: /Allow/ }).count(), 0, 'Chat has no Allow commands button');
  await pill.click();
  await list.waitFor({ state: 'hidden', timeout: CARD_TIMEOUT_MS });
  await verifySpawnedChildDoneMeans(page);
}

async function verifySpawnedChildDoneMeans(page: Page): Promise<void> {
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
  assert.equal(await page.locator('.session-chat .chat-done-pill').count(), 0, 'a spawned child whose turn changed nothing shows no check result, and its spawn done lines stay prompt text');
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
