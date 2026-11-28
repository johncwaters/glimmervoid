import assert from 'node:assert/strict';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { findSessionWorktree, pollFor } from './review-changes.ts';
import { AGENT_DONE_LINE, AWAY_REPLY_TEXT, DONE_CHILD_NAME, ELICITATION_LINK_URL, ELICITATION_REPLY_PREFIX, PLAN_REPLY_PREFIX, PROPOSED_PLAN_HEADING, STACKED_ANSWERS_PREFIX } from './cases-core.ts';
import { PANEL_MIN_CHANGED_LINES } from '../../shared/contracts/verification.ts';
import { DataClientMessage } from '../../shared/contracts/data-messages.ts';
import { parseJsonOrNull } from '../../shared/coerce.ts';

const CARD_TIMEOUT_MS = 20000;
const MIN_INLINE_TERMINAL_HEIGHT_PX = 200;
const INLINE_TERMINAL_STEADY_WATCH_MS = 2000;
const MAX_GRID_CLAIMS_FOR_INLINE_TERMINAL = 2;

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
    const settingsCollectionUrl = '/state/collections/settings.ts';
    const { settingsPayloadSnapshot } = await import(settingsCollectionUrl);
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
  await verifyStackedAnswerChanges(page);
  await verifyMultiSelectAnswer(page);
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
  await page.evaluate(() => {
    const chat = document.querySelector('.session-chat');
    const composerInput = chat?.querySelector('.chat-composer-input');
    if (!chat || !composerInput) throw new Error('the chat composer is not shown');
    const pressEnterAsCardArrives = new MutationObserver(() => {
      if (!chat.querySelector('.chat-card[data-card-type="question"][data-resolved="false"]')) return;
      pressEnterAsCardArrives.disconnect();
      composerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    });
    pressEnterAsCardArrives.observe(chat, { childList: true, subtree: true });
  });
  await sendFromComposer(page, 'ask-question-chat');
  const openQuestion = page.locator('.session-chat .chat-card[data-card-type="question"][data-resolved="false"]');
  await page.waitForFunction(() => document.querySelectorAll('.session-chat .chat-card[data-card-type="question"]').length === 2, undefined, { timeout: CARD_TIMEOUT_MS });
  assert.equal(await page.locator('.session-chat .chat-card[data-card-type="question"][data-resolved="true"]').count(), 1, 'a key pressed as the card appears answers nothing');
  await openQuestion.and(page.locator('[data-keys-ready]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  const optionTexts = await openQuestion.locator('.chat-card-option').allInnerTexts();
  assert.match(optionTexts[0] ?? '', /^Run both for a week\s*Recommended\s*Enter/, 'the recommended option comes first with its tag and the Enter key cap');
  assert.match(optionTexts[1] ?? '', /^Move now\s*2/, 'the other option keeps its position key');
  assert.equal(await openQuestion.locator('.chat-card-option-preview').innerText(), 'old path: off\nnew path: live', 'an option shows the preview the agent gave it');
  await composer.focus();
  await page.keyboard.press('Enter');
  const answeredQuestion = page.locator('.session-chat .chat-card[data-card-type="question"][data-resolved="true"]').last();
  await page.waitForFunction(() => document.querySelectorAll('.session-chat .chat-card[data-card-type="question"][data-resolved="true"]').length === 2, undefined, { timeout: CARD_TIMEOUT_MS });
  assert.match(await answeredQuestion.innerText(), /Answered: Run both for a week$/m, 'Enter answers with the recommended option');
  await page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true }).click();
  await waitForTurnRunning(page, false);
  await sendFromComposer(page, 'ask-question-chat');
  await openQuestion.and(page.locator('[data-keys-ready]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await openQuestion.locator('.chat-card-foot').innerText(), /^Dismiss\s*Esc$/, 'an open question carries only the Dismiss control in its foot');
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

async function verifyStackedAnswerChanges(page: Page): Promise<void> {
  const composer = page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' });
  await composer.fill('');
  await sendFromComposer(page, 'ask-questions-stacked');
  const storeCard = page.locator('.session-chat .chat-card[data-card-type="question"]', { hasText: 'Which store?' });
  const cacheCard = page.locator('.session-chat .chat-card[data-card-type="question"]', { hasText: 'Which cache?' });
  await storeCard.and(page.locator('[data-keys-ready]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  await storeCard.getByRole('button', { name: /^Postgres/ }).click();
  const changeButton = storeCard.getByRole('button', { name: 'Change', exact: true });
  await changeButton.waitFor({ timeout: CARD_TIMEOUT_MS });
  await changeButton.click();
  await storeCard.and(page.locator('[data-resolved="false"]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await cacheCard.getAttribute('data-resolved'), 'false', 'changing the first answer leaves the second question open');
  await storeCard.getByRole('button', { name: /^SQLite/ }).click();
  await storeCard.getByRole('button', { name: 'Change', exact: true }).waitFor({ timeout: CARD_TIMEOUT_MS });
  await cacheCard.and(page.locator('[data-keys-ready]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  await cacheCard.getByRole('button', { name: /^Memory/ }).click();
  const answersLine = page.locator('.session-chat .chat-log', { hasText: STACKED_ANSWERS_PREFIX });
  await answersLine.waitFor({ timeout: CARD_TIMEOUT_MS });
  const answersText = await answersLine.innerText();
  assert.match(answersText, /"answers":\{"Which store\?":"SQLite \(Recommended\)","Which cache\?":"Memory"\}/, 'the changed answer is the one sent, beside the later answer');
  assert.equal(await page.locator('.session-chat .chat-card[data-card-type="question"]').getByRole('button', { name: 'Change', exact: true }).count(), 0, 'once the set is sent no answer offers Change');
}

async function verifyMultiSelectAnswer(page: Page): Promise<void> {
  await sendFromComposer(page, 'ask-questions-multi');
  const storesCard = page.locator('.session-chat .chat-card[data-card-type="question"]', { hasText: 'Which stores?' });
  await storesCard.and(page.locator('[data-keys-ready]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  await storesCard.getByRole('checkbox', { name: /Postgres/ }).click();
  await page.keyboard.press('3');
  assert.equal(await storesCard.getByRole('checkbox', { checked: true }).count(), 2, 'a click and a digit key each check an option of a multi-select question');
  await page.keyboard.press('Enter');
  const answersLine = page.locator('.session-chat .chat-log', { hasText: '"answers":{"Which stores?"' });
  await answersLine.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await answersLine.innerText(), /"answers":\{"Which stores\?":"Postgres, Redis"\}/, 'Enter sends every checked option, joined, even with a clicked option focused');
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
  const heldRow = chat.locator('.chat-queued-row').filter({ hasText: 'Queued' });
  await sendFromComposer(page, 'work');
  await heldRow.waitFor({ timeout: CARD_TIMEOUT_MS });
  const secondTab = await page.context().newPage();
  try {
    await secondTab.goto(page.url());
    const secondTabRow = secondTab.locator('.session-chat .chat-queued-row').filter({ hasText: 'Queued' });
    await secondTabRow.waitFor({ timeout: CARD_TIMEOUT_MS });
    await heldRow.getByRole('button', { name: 'Cancel', exact: true }).click();
    await secondTabRow.waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  } finally {
    await secondTab.close();
  }
  await heldRow.waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await waitForDraft(page, 'work', 'Cancel puts the held message back in the composer');
  await input.press('Enter');
  await heldRow.locator('button:not([disabled])', { hasText: 'Cancel' }).waitFor({ timeout: CARD_TIMEOUT_MS });
  await input.press('Escape');
  await heldRow.waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await waitForDraft(page, 'work', 'Esc puts the held message back in the composer');
  await waitForTurnRunning(page, true);
  await input.press('Enter');
  await heldRow.waitFor({ timeout: CARD_TIMEOUT_MS });
  await heldRow.getByRole('button', { name: 'Send now', exact: true }).click();
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
    const sessionId = document.querySelector('#focus-pane-terminal .session-card[data-id]')?.getAttribute('data-id')
      ?? document.querySelector('.session-card[data-id]')?.getAttribute('data-id')
      ?? '';
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
    const hasPermissionCard = logParts.some((part) => part.dataset.cardType === 'permission');
    return hasRecordedPrompt && !hasStandIn && hasPermissionCard;
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
    const sessionId = document.querySelector('#focus-pane-terminal .session-card[data-id]')?.getAttribute('data-id')
      ?? document.querySelector('.session-card[data-id]')?.getAttribute('data-id')
      ?? '';
    const tileStoreUrl = '/whiteboard/board-tile-store.ts';
    const { applyAgentChange } = await import(tileStoreUrl);
    const changeOf = (title: string) => ({ type: 'whiteboard-agent-change', boardId: 'harness-board', version: 1, at: Date.now(), change: { author: { id: sessionId, name: 'Claude' }, boxes: [{ id: title, title, rect: { x: 0, y: 0, width: 200, height: 100 } }] } });
    applyAgentChange(changeOf('Parse feed'));
    applyAgentChange(changeOf('Store rows'));
  });
  await page.locator('.session-chat .chat-board-change[data-card-type="board-change"]').waitFor({ timeout: CARD_TIMEOUT_MS });
  const cardTitles = await page.locator('.session-chat .chat-log .chat-board-change[data-card-type="board-change"]').allTextContents();
  assert.equal(cardTitles.length, 1, 'two agent changes in one turn share one card in the chat history');
  assert.match(cardTitles[0] ?? '', /^Board updatedChanged Store rows/, 'the row names the latest change without the agent name');
  assert.equal(await page.locator('.session-chat .chat-dock .chat-card').count(), 0, 'nothing about the change floats over the chat');
  const showOnBoard = page.locator('.session-chat .chat-board-change .ui-button');
  assert.match(await showOnBoard.innerText(), process.platform === 'darwin' ? /B$/ : /Alt\+B$/, 'Show on board carries the board shortcut');
  const unshownBoardId = await page.evaluate(async () => {
    const sessionId = document.querySelector('#focus-pane-terminal .session-card[data-id]')?.getAttribute('data-id')
      ?? document.querySelector('.session-card[data-id]')?.getAttribute('data-id')
      ?? '';
    const tileStoreUrl = '/whiteboard/board-tile-store.ts';
    const { unshownAgentChangeOf } = await import(tileStoreUrl);
    return unshownAgentChangeOf(sessionId)?.boardId ?? null;
  });
  assert.equal(unshownBoardId, 'harness-board', 'the board shortcut has the newest change to frame');
  await page.locator('.session-chat').evaluate((chat) => { chat.dataset.beforeShowOnBoard = 'true'; });
  await showOnBoard.click();
  assert.equal(await page.locator('.session-chat[data-before-show-on-board]').count(), 1, 'Show on board keeps the chat it was clicked in instead of rebuilding it');
  const focusedBoxIds = await page.evaluate(async () => {
    const boardStoreUrl = '/whiteboard/board-store.ts';
    const { takeBoardFocusFor } = await import(boardStoreUrl);
    return takeBoardFocusFor('harness-board')?.boxes.map((box: { id: string }) => box.id) ?? null;
  });
  const unshownAfterClick = await page.evaluate(async () => {
    const sessionId = document.querySelector('#focus-pane-terminal .session-card[data-id]')?.getAttribute('data-id')
      ?? document.querySelector('.session-card[data-id]')?.getAttribute('data-id')
      ?? '';
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
  await page.evaluate(() => {
    const sentTexts: string[] = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function recordingSend(this: WebSocket, payload: Parameters<WebSocket['send']>[0]) {
      if (typeof payload === 'string') {
        sentTexts.push(payload);
        document.body.dataset.harnessSentSocketTexts = JSON.stringify(sentTexts);
      }
      return originalSend.call(this, payload);
    };
  });
  await sendFromComposer(page, 'ask');
  const terminalInCard = page.locator('.session-chat .chat-card[data-card-type="live-terminal"] .terminal-wrap');
  await terminalInCard.waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.waitForTimeout(INLINE_TERMINAL_STEADY_WATCH_MS);
  const sentSocketTextsJson = await page.evaluate(() => document.body.dataset.harnessSentSocketTexts ?? '[]');
  const sentSocketTexts = z.array(z.string()).parse(parseJsonOrNull(sentSocketTextsJson));
  const gridClaims = sentSocketTexts.flatMap((text) => {
    const parsedMessage = DataClientMessage.safeParse(parseJsonOrNull(text));
    return parsedMessage.success && parsedMessage.data.type === 'claim' ? [parsedMessage.data] : [];
  });
  assert.ok(gridClaims.length >= 1, 'the inline terminal claims a grid that fits the card');
  assert.ok(gridClaims.length <= MAX_GRID_CLAIMS_FOR_INLINE_TERMINAL, `the inline terminal settles on one grid instead of resizing the agent over and over (${gridClaims.map((claim) => `${claim.cols}x${claim.rows}`).join(', ')})`);
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

const PLAN_FEEDBACK_TEXT = 'Measure on the phone too';

export async function verifyChatElicitation(page: Page): Promise<void> {
  await openChat(page);
  await sendFromComposer(page, 'ask-mcp-form');
  const formCard = page.locator('.session-chat .chat-card[data-card-type="elicitation"][data-resolved="false"]');
  await formCard.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await formCard.locator('.chat-card-heading').innerText(), /^linear needs a few details$/, 'the form card names the MCP server');
  await page.waitForTimeout(INLINE_TERMINAL_STEADY_WATCH_MS);
  assert.equal(await page.locator('.session-chat .chat-card[data-card-type="live-terminal"]').count(), 0, 'an MCP form never lends the terminal to Chat');
  await formCard.getByLabel('Title (required)').fill('Upload test flakes');
  await formCard.getByLabel('Priority (required)').selectOption('High');
  await formCard.getByLabel('Estimate').fill('3');
  await formCard.getByLabel('Blocking').check();
  await formCard.getByRole('button', { name: /Submit/ }).click();
  const formReply = page.locator('.session-chat').getByText(ELICITATION_REPLY_PREFIX, { exact: false }).first();
  await formReply.waitFor({ timeout: CARD_TIMEOUT_MS });
  const formReplyJson = JSON.parse(((await formReply.textContent()) ?? '').trim().slice(ELICITATION_REPLY_PREFIX.length));
  assert.deepEqual(formReplyJson.hookSpecificOutput, { hookEventName: 'Elicitation', action: 'accept', content: { title: 'Upload test flakes', priority: 'High', estimate: 3, isBlocking: true } }, 'Submit sends each value with its schema type');
  await sendFromComposer(page, 'ask-mcp-link');
  const linkCard = page.locator('.session-chat .chat-card[data-card-type="elicitation"][data-resolved="false"]');
  await linkCard.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await linkCard.locator('.chat-card-link').innerText(), ELICITATION_LINK_URL, 'the card shows the server link it opens');
  await linkCard.getByRole('button', { name: /Open link/ }).waitFor();
  await linkCard.getByRole('button', { name: /Done/ }).click();
  const replies = page.locator('.session-chat').getByText(ELICITATION_REPLY_PREFIX, { exact: false });
  await replies.nth(1).waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await replies.nth(1).innerText(), /"action":"accept"/, 'Done accepts the sign-in link');
  assert.deepEqual(await page.locator('.session-chat .chat-card[data-card-type="elicitation"] .chat-card-receipt').allInnerTexts(), ['Sent', 'Sent'], 'each settled card keeps its receipt');
}

export async function verifyChatPlan(page: Page): Promise<void> {
  await openChat(page);
  await sendFromComposer(page, 'propose-plan');
  const planCard = page.locator('.session-chat .chat-card[data-card-type="plan"]');
  await planCard.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await planCard.locator('.chat-card-heading').innerText(), /proposes a plan$/, 'the plan card names the agent');
  assert.match(await planCard.locator('.chat-card-plan').innerText(), new RegExp(PROPOSED_PLAN_HEADING), 'the plan card renders the proposed plan');
  await page.waitForTimeout(INLINE_TERMINAL_STEADY_WATCH_MS);
  assert.equal(await page.locator('.session-chat .chat-card[data-card-type="live-terminal"]').count(), 0, 'a pending plan never lends the terminal to Chat');
  assert.equal(await page.locator('.session-card > .plan-gate-panel').evaluateAll((panels) => panels.filter((panel) => panel.checkVisibility()).length), 0, 'Chat hides the session card plan panel so the plan shows once');
  const composer = page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' });
  await planCard.and(page.locator('[data-keys-ready]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  await composer.focus();
  await page.keyboard.press('2');
  const openPlanCard = page.locator('.session-chat .chat-card[data-card-type="plan"][data-resolved="false"]');
  await page.locator('.session-chat .chat-card[data-card-type="plan"][data-resolved="true"]').waitFor({ timeout: CARD_TIMEOUT_MS });
  await openPlanCard.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await page.locator('.session-chat .chat-card[data-card-type="plan"]').count(), 2, 'the same plan proposed again after Keep planning opens a new card');
  await openPlanCard.locator('.chat-card-feedback').fill(PLAN_FEEDBACK_TEXT);
  await openPlanCard.and(page.locator('[data-keys-ready]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  await composer.focus();
  await page.keyboard.press('1');
  const reply = page.locator('.session-chat').getByText(PLAN_REPLY_PREFIX, { exact: false });
  await reply.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await reply.innerText(), /"behavior":"allow"/, 'Approve releases the held plan with an allow');
  const receipts = page.locator('.session-chat .chat-card[data-card-type="plan"] .chat-card-receipt');
  await receipts.nth(1).waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.deepEqual(await receipts.allInnerTexts(), ['Kept planning', `Approved: ${PLAN_FEEDBACK_TEXT}`], 'each settled plan card keeps its own decision and feedback');
}

export async function verifyChatSignIn(page: Page): Promise<void> {
  await openChat(page);
  await sendFromComposer(page, 'login-expired');
  const signInCard = page.locator('.session-chat .chat-card[data-card-type="sign-in"]');
  await page.locator('.session-chat .chat-card[data-card-type="sign-in"][data-keys-ready]').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await signInCard.locator('.chat-card-heading').textContent(), 'Claude Code needs you to sign in');
  assert.equal(await page.locator('.session-chat .chat-card[data-card-type="live-terminal"]').count(), 0, 'a failed login offers sign-in instead of the bare terminal');
  assert.equal(await page.locator('.session-chat .terminal-wrap').count(), 0, 'the terminal stays home until Sign in is pressed');
  const signInPlacementOf = () => page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.session-chat .chat-scroller');
    const scrollContent = document.querySelector<HTMLElement>('.session-chat .chat-scroll-content');
    const card = document.querySelector<HTMLElement>('.session-chat .chat-card[data-card-type="sign-in"]');
    if (!scroller || !scrollContent || !card) return null;
    const scrollerRect = scroller.getBoundingClientRect();
    const contentRect = scrollContent.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      offsetInContent: cardRect.top - contentRect.top,
      cardTop: cardRect.top,
      scrollerTop: scrollerRect.top,
      scrollTop: scroller.scrollTop,
    };
  });
  const placementBefore = await signInPlacementOf();
  assert.ok(placementBefore !== null, 'the sign-in card is measured inside the chat scroller before opening the terminal');
  await page.keyboard.press('1');
  await signInCard.locator('.chat-terminal-slot .terminal-wrap').waitFor({ timeout: CARD_TIMEOUT_MS });
  const placementAfter = await signInPlacementOf();
  assert.ok(placementAfter !== null, 'the sign-in card stays inside the chat scroller after opening the terminal');
  assert.equal(placementAfter.offsetInContent, placementBefore.offsetInContent, 'opening the terminal keeps the card at the same offset inside the chat content');
  assert.equal(placementAfter.scrollTop, 0, 'opening the terminal keeps the scroller anchored without auto-scrolling past the card');
  assert.ok(placementAfter.cardTop >= placementAfter.scrollerTop, 'opening the terminal keeps the card heading inside the scroller');
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

const FOCUS_SETTLE_MS = 500;

async function verifyQuickSessionFocusesComposer(page: Page): Promise<void> {
  const shownSessionIdBeforeAdd = await page.evaluate(() => document.querySelector<HTMLElement>('#focus-pane-terminal .session-card')?.dataset.id ?? null);
  await page.locator('#tab-settings').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+Digit0' : 'Alt+Shift+Digit0');
  await page.waitForFunction((previousSessionId) => {
    const shownSessionId = document.querySelector<HTMLElement>('#focus-pane-terminal .session-card')?.dataset.id;
    return shownSessionId !== undefined && shownSessionId !== previousSessionId && document.querySelector('.session-chat .chat-composer-input') !== null;
  }, shownSessionIdBeforeAdd, { timeout: CARD_TIMEOUT_MS });
  await page.waitForTimeout(FOCUS_SETTLE_MS);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('chat-composer-input') ?? false), true, 'a session started from Settings opens with the chat message box focused');
}

async function verifyCloseConfirmStaysOpenInChat(page: Page): Promise<void> {
  const focusedSessionId = await page.evaluate(() => document.querySelector<HTMLElement>('#focus-pane-terminal .session-card')?.dataset.id ?? null);
  assert.ok(focusedSessionId, 'a session is focused in Chat before testing close confirmation');
  const otherSessionId = await page.evaluate((currentId) => {
    const rows = [...document.querySelectorAll<HTMLElement>('.focus-rail button.session-row[data-id]')];
    return rows.map((row) => row.dataset.id).find((id) => id !== undefined && id !== currentId) ?? null;
  }, focusedSessionId);
  assert.ok(otherSessionId, 'a second session is listed in the rail');

  await sendFromComposer(page, 'work');
  await waitForTurnRunning(page, true);

  const expectConfirmStaysOpen = async (sessionId: string, label: string) => {
    const item = page.locator(`.focus-rail .session-row-item:has(> button.session-row[data-id="${sessionId}"])`);
    await item.locator(':scope > [data-action="remove-session"]').click({ force: true });
    const confirm = item.locator(':scope > .session-row-confirm');
    await confirm.waitFor({ state: 'visible', timeout: CARD_TIMEOUT_MS });
    await page.waitForTimeout(FOCUS_SETTLE_MS);
    assert.equal(await confirm.isVisible(), true, `${label}: inline removal confirmation stays open while Chat is shown`);
    assert.equal(await item.evaluate((rowItem) => rowItem.contains(document.activeElement)), true, `${label}: focus stays inside the armed confirmation row`);
    return item;
  };

  const focusedItem = await expectConfirmStaysOpen(focusedSessionId, 'focused session');
  await focusedItem.locator('[data-action="keep-session"]').click();
  await focusedItem.locator(':scope > .session-row-confirm').waitFor({ state: 'hidden', timeout: CARD_TIMEOUT_MS });

  await page.locator(`.focus-rail button.session-row[data-id="${otherSessionId}"]`).click();
  await page.waitForFunction((id) => document.querySelector<HTMLElement>('#focus-pane-terminal .session-card')?.dataset.id === id, otherSessionId, { timeout: CARD_TIMEOUT_MS });
  const nonFocusedItem = await expectConfirmStaysOpen(focusedSessionId, 'non-focused session');
  await nonFocusedItem.locator('[data-action="confirm-remove-session"]').click();
  await page.waitForFunction((id) => {
    const item = document.querySelector(`.focus-rail .session-row-item:has(> button.session-row[data-id="${id}"])`);
    return item?.hasAttribute('data-closing') === true;
  }, focusedSessionId, { timeout: CARD_TIMEOUT_MS });
  await nonFocusedItem.locator(':scope > [data-action="undo-remove"]').click();
}

export async function verifyChatStaysDefault(page: Page): Promise<void> {
  await openChat(page);
  await verifyComposerPassesDashboardShortcuts(page);
  await verifyQuickSessionFocusesComposer(page);
  await verifyCloseConfirmStaysOpenInChat(page);
  await page.reload();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.waitForFunction(() => document.activeElement?.classList.contains('chat-composer-input') === true, undefined, { timeout: CARD_TIMEOUT_MS });
  await page.locator('.session-page-bar').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('.session-chat').waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  await page.reload();
  await page.locator('#focus-pane-terminal .session-card .terminal-wrap').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await page.locator('.session-chat').count(), 0, 'closing Chat makes the terminal the first view again');
}

export async function verifyChatStaysDefaultOnPhone(
  page: Page,
  controlFaults: { setPushDelayMs(delayMs: number): void },
): Promise<void> {
  await page.locator('button[data-action="show-chat"]:visible').first().click();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('chat-composer-input') ?? false), false, 'opening Chat on a phone focuses nothing, so the keyboard stays down');
  const chatBar = page.locator('.phone-page-chat').locator('xpath=..').locator('.phone-terminal-bar');
  assert.equal(await chatBar.locator('.phone-terminal-badge').isVisible(), true, 'Chat shows the session bar with its state badge');
  assert.equal(await chatBar.locator('button[data-action="show-chat"]').getAttribute('aria-pressed'), 'true', 'the Chat button reads pressed while Chat shows');
  await chatBar.locator('button[data-action="back-to-board"]').click();
  await page.locator('.phone-board-list button.session-row').first().click();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.goBack();
  await page.locator('.phone-board-list button.session-row').first().click();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.locator('.phone-nav > .phone-nav-item[data-screen="terminal"]').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.session-chat .chat-composer').isVisible(), true, 'the Session tab keeps the view the toggle chose');
  await verifyPhoneChatMarksRead(page, chatBar);
  const shellId = await page.evaluate(async () => {
    const controlWsUrl = '/control-ws.ts';
    const { sendControlRequest } = await import(controlWsUrl);
    const reply = await sendControlRequest('add-session', { name: 'phone-shell', path: '', agent: 'shell' });
    return typeof reply?.sessionId === 'string' ? reply.sessionId : null;
  });
  assert.ok(shellId, 'a shell session starts for the phone chat-availability check');
  await chatBar.locator('button[data-action="back-to-board"]').click();
  const shellRow = page.locator(`.phone-board-list button.session-row[data-id="${shellId}"]`);
  await shellRow.waitFor({ timeout: CARD_TIMEOUT_MS });
  await shellRow.click();
  await page.locator('.phone-terminal .terminal-wrap').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await page.locator('.session-chat').count(), 0, 'a shell session opens directly in the terminal even when Chat is the remembered view');
  assert.equal(await page.locator('.phone-terminal-bar button[data-action="show-chat"]').isVisible(), false, 'a shell session hides the Chat button in the phone session bar');
  await page.locator('.phone-nav > .phone-nav-item[data-screen="terminal"]').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.session-chat').count(), 0, 'tapping the Session tab on a shell session keeps it on the terminal');
  await page.locator('button[data-action="back-to-board"]:visible').click();
  await page.locator('.phone-board-list button.session-row:not([data-shell])').first().click();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
  await verifyPhoneChatRestoresAfterDelayedSnapshot(page, controlFaults);
  await page.locator('button[data-action="show-terminal"]:visible').click();
  await page.locator('.session-chat').waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
  assert.equal(await page.locator('button[data-action="show-terminal"]:visible').getAttribute('aria-pressed'), 'true', 'the Terminal button reads pressed while the terminal shows');
  await page.locator('button[data-action="back-to-board"]:visible').click();
  await page.locator('.phone-board-list button.session-row:not([data-shell])').first().click();
  await page.locator('.phone-terminal .terminal-wrap').waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.equal(await page.locator('.session-chat').count(), 0, 'after Terminal, the next session opens in the terminal');
}

async function verifyPhoneChatRestoresAfterDelayedSnapshot(
  page: Page,
  controlFaults: { setPushDelayMs(delayMs: number): void },
): Promise<void> {
  const DELAYED_SNAPSHOT_MS = 1200;
  controlFaults.setPushDelayMs(DELAYED_SNAPSHOT_MS);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#phone-shell:not([hidden])').waitFor({ state: 'visible', timeout: CARD_TIMEOUT_MS });
    await page.waitForFunction(
      () => document.querySelectorAll('.session-card[data-id]').length > 0,
      undefined,
      { timeout: CARD_TIMEOUT_MS },
    );
    const restored = await page.evaluate(() => ({
      visibleScreen: document.querySelector('section.phone-screen:not([hidden])')?.getAttribute('data-screen') ?? null,
      historyScreen: (history.state as { glimmervoidScreen?: unknown } | null)?.glimmervoidScreen ?? null,
      hasComposer: document.querySelector('.session-chat .chat-composer') !== null,
    }));
    assert.equal(
      restored.visibleScreen,
      'chat',
      `reloading phone Chat with snapshot delayed ${DELAYED_SNAPSHOT_MS}ms must restore chat instead of ${String(restored.visibleScreen)} (historyScreen=${String(restored.historyScreen)})`,
    );
    assert.equal(
      restored.historyScreen,
      'chat',
      `reloading phone Chat with snapshot delayed ${DELAYED_SNAPSHOT_MS}ms must keep history.state.glimmervoidScreen as chat`,
    );
    assert.equal(restored.hasComposer, true, 'restored phone Chat must render the chat composer');
  } finally {
    controlFaults.setPushDelayMs(0);
  }
}

async function verifyPhoneChatMarksRead(page: Page, chatBar: Locator): Promise<void> {
  const viewerCheck = await page.evaluate(async () => {
    const phoneGateUrl = '/phone/phone-shell-gate.ts';
    const registryUrl = '/session-card/card-registry.ts';
    const { getVisiblePhoneSessionId } = await import(phoneGateUrl);
    const { sessionUIs } = await import(registryUrl);
    const visibleId = getVisiblePhoneSessionId();
    const isTerminalActiveViewer = visibleId ? sessionUIs.get(visibleId)?._isActiveViewer?.() === true : null;
    return { visibleId, isTerminalActiveViewer };
  });
  assert.ok(viewerCheck.visibleId, 'phone Chat reports the shown session as visible');
  assert.equal(viewerCheck.isTerminalActiveViewer, false, 'phone Chat keeps the hidden terminal unviewed so it does not claim the PTY grid');

  await waitForTurnRunning(page, false);
  await sendFromComposer(page, 'take-any-prompt');
  await waitForTurnRunning(page, true);
  await waitForOutboxEmpty(page);
  await page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.phone-page-chat')?.parentElement?.querySelector('.phone-terminal-bar')?.getAttribute('data-state') === 'IDLE', undefined, { timeout: CARD_TIMEOUT_MS });

  await sendFromComposer(page, 'take-any-prompt');
  await waitForTurnRunning(page, true);
  await waitForOutboxEmpty(page);
  await chatBar.locator('button[data-action="back-to-board"]').click();
  const sessionRow = page.locator(`.phone-board-list button.session-row[data-id="${viewerCheck.visibleId}"]`);
  await sessionRow.waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.evaluate(async (sessionId) => {
    const controlWsUrl = '/control-ws.ts';
    const { sendControlMsg } = await import(controlWsUrl);
    sendControlMsg({ type: 'chat-stop', id: sessionId });
  }, viewerCheck.visibleId);
  await sessionRow.and(page.locator('[data-state="COMPLETE"]')).waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.locator('.phone-nav > .phone-nav-item[data-screen="terminal"]').click();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('.phone-page-chat')?.parentElement?.querySelector('.phone-terminal-bar')?.getAttribute('data-state') === 'IDLE', undefined, { timeout: CARD_TIMEOUT_MS });
}

export const DONE_MEANS_UNTRACKED_FILE = 'done-means.txt';

export async function verifyChatDoneMeans(page: Page, projectDirectory: string): Promise<void> {
  await openChat(page);
  const worktreePath = await pollFor('the session worktree', CARD_TIMEOUT_MS, () => findSessionWorktree(projectDirectory));
  await waitForTurnRunning(page, false);
  await sendFromComposer(page, 'declare-done');
  await waitForTurnRunning(page, true);
  await waitForOutboxEmpty(page);
  await page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true }).click();
  await waitForTurnRunning(page, false);
  assert.equal(await page.locator('.session-chat .chat-done-pill').count(), 0, 'a turn below the panel line threshold shows no check result');
  await sendFromComposer(page, 'take-any-prompt');
  await waitForTurnRunning(page, true);
  await waitForOutboxEmpty(page);
  await fs.writeFile(path.join(worktreePath, DONE_MEANS_UNTRACKED_FILE), Array.from({ length: PANEL_MIN_CHANGED_LINES }, (_, lineIndex) => `written during the turn ${lineIndex}`).join('\n'), 'utf8');
  await page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true }).click();
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
  await page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true }).click();
  await waitForTurnRunning(page, false);
  assert.equal(await page.locator('.session-chat .chat-done-pill').count(), 0, 'a spawned child whose turn changed nothing shows no check result, and its spawn done lines stay prompt text');
}

async function waitForOutboxEmpty(page: Page): Promise<void> {
  await page.locator('.session-chat .chat-queued-row').first().waitFor({ state: 'detached', timeout: CARD_TIMEOUT_MS });
}
