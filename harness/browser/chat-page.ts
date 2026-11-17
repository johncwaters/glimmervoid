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

async function waitForModelCatalog(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    const controlWsUrl = '/control-ws.ts';
    const { sendControlRequest } = await import(controlWsUrl);
    const reply = await sendControlRequest('get-settings', {});
    const agents: unknown = reply?.settings?.agentModels?.agents;
    return Array.isArray(agents) && agents.some((entry) => entry?.agent === 'claude-code' && Array.isArray(entry.models) && entry.models.length > 1);
  }, undefined, { timeout: CARD_TIMEOUT_MS, polling: 500 });
  await page.reload();
  await page.locator('.session-chat .chat-composer').waitFor({ timeout: CARD_TIMEOUT_MS });
}

async function verifyChatModelSwitch(page: Page): Promise<void> {
  await waitForModelCatalog(page);
  const modelSelect = page.locator('.session-chat .chat-model-control select[aria-label="Model"]');
  await modelSelect.waitFor({ timeout: CARD_TIMEOUT_MS });
  const choices = await modelSelect.locator('option').evaluateAll((options) => options.map((option) => (option instanceof HTMLOptionElement ? option.value : '')));
  const shownModel = await modelSelect.inputValue();
  const otherModel = choices.find((choice) => choice !== shownModel);
  assert.ok(otherModel, `the Model control lists more than the shown model (${choices.join(', ')})`);
  await page.waitForFunction(() => document.querySelector<HTMLFieldSetElement>('.session-chat .chat-model-control')?.disabled === false, undefined, { timeout: CARD_TIMEOUT_MS });
  const composerInput = page.locator('.session-chat').getByRole('textbox', { name: 'Message the agent' });
  await composerInput.fill('draft kept across the switch');
  await modelSelect.selectOption(otherModel);
  await page.waitForFunction((model) => {
    const select = document.querySelector<HTMLSelectElement>('.session-chat .chat-model-control select[aria-label="Model"]');
    const status = document.querySelector('.session-chat .chat-model-status');
    return select?.value === model && status?.textContent === '';
  }, otherModel, { timeout: CARD_TIMEOUT_MS });
  const failureText = await page.locator('.session-chat .session-chat-failure').textContent();
  assert.equal(failureText ?? '', '', 'switching the model from Chat reports no failure');
  assert.equal(await composerInput.inputValue(), 'draft kept across the switch', 'an unsent draft survives the restart a model switch causes');
  await composerInput.fill('');
}

export async function verifyChatApprovals(page: Page): Promise<void> {
  await openChat(page);
  await verifyChatModelSwitch(page);
  await sendFromComposer(page, 'ask-chat');
  const openCard = page.locator('.session-chat .chat-card[data-card-type="permission"][data-resolved="false"]');
  await openCard.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await openCard.innerText(), /Bash/, 'the permission card names the tool');
  await openCard.getByRole('button', { name: 'Allow', exact: true }).click();
  const answeredCard = page.locator('.session-chat .chat-card[data-card-type="permission"][data-resolved="true"]');
  await answeredCard.waitFor({ timeout: CARD_TIMEOUT_MS });
  assert.match(await answeredCard.innerText(), /Allowed/, 'the answered card reads Allowed');
  await sendFromComposer(page, 'work');
  const stopButton = page.locator('.session-chat').getByRole('button', { name: 'Stop', exact: true });
  await page.waitForFunction(() => {
    const stop = [...document.querySelectorAll<HTMLButtonElement>('.session-chat .chat-composer button')].find((button) => button.textContent === 'Stop');
    return stop !== undefined && !stop.disabled;
  }, undefined, { timeout: CARD_TIMEOUT_MS });
  await page.locator('.session-chat .chat-activity .chat-activity-mark').waitFor({ timeout: CARD_TIMEOUT_MS });
  await stopButton.click();
}

export async function verifyChatTerminal(page: Page): Promise<void> {
  await openChat(page);
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

export async function verifyChatStaysDefault(page: Page): Promise<void> {
  await openChat(page);
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
