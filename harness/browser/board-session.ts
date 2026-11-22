import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';

const BOARD_SESSION_TIMEOUT_MS = 20000;
const LAYOUT_TOLERANCE_PX = 0.5;
const MERGE_POLL_MS = 250;
const REFUNDS_COMMIT_SUBJECT = 'Add refunds beside the card module';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} is laid out`);
  return box;
}

function assertSameBox(before: Box, after: Box, what: string): void {
  for (const edge of ['x', 'y', 'width', 'height'] as const) {
    assert.ok(Math.abs(before[edge] - after[edge]) <= LAYOUT_TOLERANCE_PX, `${what} keeps its ${edge} (${before[edge]} then ${after[edge]})`);
  }
}

function branchesHoldingRefunds(projectDirectory: string): number {
  const sha = execFileSync('git', ['-C', projectDirectory, 'log', '--all', '--format=%H', `--grep=${REFUNDS_COMMIT_SUBJECT}`], { encoding: 'utf8' }).trim().split('\n')[0] ?? '';
  if (sha.length === 0) return 0;
  return execFileSync('git', ['-C', projectDirectory, 'branch', '--contains', sha], { encoding: 'utf8' }).split('\n').filter((line) => line.trim().length > 0).length;
}

async function waitForRefundsInParent(projectDirectory: string): Promise<void> {
  const deadline = Date.now() + BOARD_SESSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (branchesHoldingRefunds(projectDirectory) >= 2) return;
    await delay(MERGE_POLL_MS);
  }
  assert.fail(`the branch commit reached ${branchesHoldingRefunds(projectDirectory)} branch, not the branch and its parent`);
}

async function verifyBranch(page: Page, projectDirectory: string, pillBefore: Box): Promise<void> {
  const root = page.locator('.board-session-view');
  const pillInput = root.getByRole('textbox');
  const addressText = root.locator('.bs-pill-address-text');
  await pillInput.fill('@card');
  const mention = root.getByRole('option').first();
  await mention.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.match(await mention.textContent() ?? '', /card/, 'the box picker offers the card file');
  await pillInput.press('Enter');
  await page.waitForFunction(() => (document.querySelector('.board-session-view .bs-pill-address-text')?.textContent ?? '').startsWith('New branch on'), undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await pillInput.inputValue(), '', 'picking a box takes the @ mention out of the pill');
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill with a branch address');
  await pillInput.fill('Add refunds');
  await pillInput.press('Enter');
  const branchReply = root.locator('.bs-row-agent.bs-row-branch', { hasText: 'Committed refunds' }).first();
  await branchReply.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-row-you.bs-row-branch', { hasText: 'Add refunds' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-row-you.bs-row-branch', { hasText: 'You are a branch' }).count(), 0, 'the branch bubble shows only what the operator typed');
  await root.locator('.bs-presence-branch').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await waitForRefundsInParent(projectDirectory);

  await root.locator('.bs-pill-address-clear').click();
  await addressText.waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  await branchReply.click();
  await page.waitForFunction(() => (document.querySelector('.board-session-view .bs-pill-address-text')?.textContent ?? '').startsWith('To '), undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  await pillInput.fill('branch-follow-up');
  await pillInput.press('Enter');
  await root.locator('.bs-row-agent.bs-row-branch', { hasText: 'Refunds reuse' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-pill-address-clear').click();
  await addressText.waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill after the branch');
}

export async function verifyBoardSession(page: Page, projectDirectory: string): Promise<void> {
  const root = page.locator('.board-session-view');
  await page.locator('#tab-board-session').click();
  const chip = root.locator('button.bs-chip');
  await chip.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.waitForFunction(() => {
    const name = document.querySelector('.board-session-view .bs-chip-name')?.textContent ?? '';
    return name.length > 0 && name !== 'No session';
  }, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.waitForFunction(() => {
    const notice = document.querySelector<HTMLElement>('.board-session-view .bs-notice');
    const canvas = document.querySelector<HTMLCanvasElement>('.board-session-view canvas.wb-gl');
    return (notice !== null && !notice.hidden && (notice.textContent ?? '').length > 0) || (canvas !== null && canvas.width > 0 && notice?.hidden === true);
  }, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-log').isVisible(), false, 'the chat log stays folded on open');

  await chip.click();
  const menu = root.getByRole('menu');
  await menu.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.ok((await menu.getByRole('menuitemradio', { checked: true }).count()) === 1, 'the session menu marks the shown session');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });

  const pillBefore = await boxOf(page, '.board-session-view .bs-pill');
  const chipBefore = await boxOf(page, '.board-session-view .bs-chip');
  const pillInput = root.getByRole('textbox');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.board-session-view .bs-notice')?.hidden === true, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  await pillInput.fill('edit-shop');
  await pillInput.press('Enter');
  await root.locator('.bs-row-agent', { hasText: 'src/payments/card.js' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-presence-face:not([hidden])').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-presence-glow').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill after the agent edits');

  await pillInput.fill('ask-shop');
  await pillInput.press('Enter');
  const askCard = root.locator('.bs-ask', { has: page.getByRole('button', { name: 'Yes, reuse it', exact: true }) });
  await askCard.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await askCard.getByRole('button', { name: 'Send answer', exact: true }).isDisabled(), true, 'Send answer waits for typed text');
  await askCard.getByRole('button', { name: 'Yes, reuse it', exact: true }).click();
  await askCard.waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-row-you', { hasText: 'Yes, reuse it' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill after the ask resolves');

  await verifyBranch(page, projectDirectory, pillBefore);

  await pillInput.fill('narrate');
  const sendButton = root.getByRole('button', { name: 'Send', exact: true });
  assert.equal(await sendButton.isEnabled(), true, 'Send turns on once the pill holds text');
  await pillInput.press('Enter');
  await root.locator('.bs-row-you', { hasText: 'narrate' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-row-agent', { hasText: 'Build passed' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-row-agent .bs-face').count() > 0, true, 'an agent bubble carries the agent face');
  assert.equal(await sendButton.getAttribute('aria-label'), 'Send', 'Send keeps its label after a send');
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill');
  assertSameBox(chipBefore, await boxOf(page, '.board-session-view .bs-chip'), 'the session chip');

  await page.locator('#tab-focus').click();
  await page.locator('.focus-view').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.isHidden(), true, 'the Studio tab hides when Focus opens');
}
