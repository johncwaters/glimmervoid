import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { DIRECTOR_DIGEST_TEXT, RESUMED_AFTER_QUESTION_TEXT, STUDIO_PROGRESS_ANSWER } from './cases-core.ts';
import { clickBoardBoxWhere, hoverBoardBoxWhere } from './boards.ts';

const BOARD_SESSION_TIMEOUT_MS = 20000;
const LAYOUT_TOLERANCE_PX = 0.5;
const MERGE_POLL_MS = 250;
const DIRECTOR_TIMEOUT_MS = 60000;
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
  await waitForRefundsInParent(projectDirectory);
  const branchFace = root.locator('.bs-card-shrunk:not([hidden]) .bs-card-shrunk-face').first();
  await branchFace.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-card[data-branch]:not([hidden])').count(), 0, 'an idle branch shows only its face');
  await branchFace.click();
  await root.locator('.bs-card[data-branch]:not([hidden])').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });

  await root.locator('.bs-pill-address-clear').click();
  await addressText.waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  await branchReply.locator('.bs-face').click();
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
  assert.equal(await root.locator('.bs-chip-name').textContent(), 'No repo', 'Studio lists no Focus session repo');
  await chip.click();
  await root.locator('[data-action="board-session-open-repo"]').click();
  const picker = page.locator('.add-session-dialog');
  await picker.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await picker.locator('.add-session-row', { hasText: 'Claude Code' }).click();
  await picker.locator('.add-session-row', { hasText: 'Any folder' }).click();
  await picker.locator('#add-session-path').fill(projectDirectory);
  await picker.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.waitForFunction(() => {
    const name = document.querySelector('.board-session-view .bs-chip-name')?.textContent ?? '';
    return name.length > 0 && name !== 'No repo';
  }, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.waitForFunction(() => {
    const notice = document.querySelector<HTMLElement>('.board-session-view .bs-notice');
    const canvas = document.querySelector<HTMLCanvasElement>('.board-session-view canvas.wb-gl');
    return (notice !== null && !notice.hidden && (notice.textContent ?? '').length > 0) || (canvas !== null && canvas.width > 0 && notice?.hidden === true);
  }, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-log').isVisible(), false, 'the chat log stays folded on open');
  assert.equal(await root.locator('.bs-top-left > :not(.bs-chip, .bs-menu)').count(), 0, 'the top left holds only the repo chip');
  await page.locator('.session-name', { hasText: / main$/ }).first().waitFor({ state: 'attached', timeout: BOARD_SESSION_TIMEOUT_MS });

  await root.getByRole('textbox').click();
  await root.locator('.bs-log').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await chip.click();
  await root.locator('.bs-log').waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  const menu = root.getByRole('menu');
  await menu.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.ok((await menu.getByRole('menuitemradio', { checked: true }).count()) === 1, 'the repo menu marks the shown repo');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });

  const pillBefore = await boxOf(page, '.board-session-view .bs-pill');
  assert.equal(await root.locator('.bs-pill.chat-composer textarea.chat-composer-input').count(), 1, 'the message bar is Chat\'s composer');
  const chipBefore = await boxOf(page, '.board-session-view .bs-chip');
  const pillInput = root.getByRole('textbox');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.board-session-view .bs-notice')?.hidden === true, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  await pillInput.fill('edit-shop');
  await pillInput.press('Enter');
  await root.locator('.bs-row-agent[hidden]').first().waitFor({ state: 'attached', timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-presence-glow[data-tier="edited"]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  const faceOnBox = root.locator('.bs-card[data-main] .bs-face-main').first();
  await faceOnBox.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await root.locator('.bs-presence-glow').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.locator('#tab-focus').click();
  await page.locator('#tab-board-session').click();
  await faceOnBox.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
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

  await pillInput.fill('ask-question-resume');
  await pillInput.press('Enter');
  const askingMainCard = root.locator('.bs-card[data-main][data-asking]');
  const heldQuestion = askingMainCard.locator('.chat-card[data-card-type="question"][data-resolved="false"]');
  await heldQuestion.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await heldQuestion.getByRole('button', { name: /^Run both for a week/ }).click();
  await root.locator('.bs-row-agent', { hasText: RESUMED_AFTER_QUESTION_TEXT }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await askingMainCard.waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });

  await pillInput.fill('long-shop');
  await pillInput.press('Enter');
  const directedLine = root.locator('.bs-row-agent .bs-digest', { hasText: DIRECTOR_DIGEST_TEXT }).first();
  await directedLine.waitFor({ timeout: DIRECTOR_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-log', { hasText: 'The tax table is read once' }).count(), 0, 'a directed turn shows only its chat line');
  assert.equal(await root.locator('.bs-row-agent:not([hidden])', { hasText: 'The charge goes through' }).count(), 0, 'a turn the director leaves out never reaches chat');
  const directedBubble = root.locator('.bs-row-agent', { has: page.locator('.bs-digest', { hasText: DIRECTOR_DIGEST_TEXT }) }).first().locator('.bs-bubble-agent');
  const logBefore = await boxOf(page, '.board-session-view .bs-pill');
  await directedBubble.click();
  await root.locator('.bs-full-reply', { hasText: 'The tax table is read once' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await directedBubble.getAttribute('aria-expanded'), 'true', 'clicking a chat line opens the whole reply');
  await directedBubble.locator('.bs-digest').click();
  await root.locator('.bs-full-reply').first().waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
  assertSameBox(logBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill after a reply opens and closes');

  await pillInput.fill('How is it going?');
  await pillInput.press('Enter');
  const progressRow = root.locator('.bs-row-glimmervoid', { hasText: STUDIO_PROGRESS_ANSWER });
  await progressRow.waitFor({ timeout: DIRECTOR_TIMEOUT_MS });
  assert.equal(await progressRow.locator('.bs-bubble-who').textContent(), 'Glimmervoid', 'Glimmervoid answers how it is going');
  assert.equal(await root.locator('.bs-row-you[data-part-id]', { hasText: 'How is it going?' }).count(), 0, 'a progress question never reaches the main agent');
  await pillInput.fill('Where does tax get added?');
  await pillInput.press('Enter');
  await root.locator('.bs-row-you[data-part-id]', { hasText: 'Where does tax get added?' }).first().waitFor({ timeout: DIRECTOR_TIMEOUT_MS });

  await verifyBranch(page, projectDirectory, pillBefore);

  await pillInput.fill('narrate');
  const sendButton = root.locator('.bs-pill .chat-composer-send');
  assert.equal(await sendButton.isEnabled(), true, 'Send turns on once the pill holds text');
  await pillInput.press('Enter');
  await root.locator('.bs-row-you', { hasText: 'narrate' }).first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-row-agent:not([hidden]) .bs-face').count() > 0, true, 'an agent chat line carries the agent face');
  await root.locator('.bs-card[data-main][data-phase="working"] .chat-activity[data-phase="working"]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.locator('.bs-card[data-main]').count(), 1, 'the main agent has exactly one card');
  assert.equal(await root.locator('.bs-log', { hasText: 'npm test -- run-1' }).count(), 0, 'the Studio log shows replies, not tool calls');
  assert.equal(await sendButton.getAttribute('aria-label'), 'Send', 'Send keeps its label after a send');
  assertSameBox(pillBefore, await boxOf(page, '.board-session-view .bs-pill'), 'the pill');
  assertSameBox(chipBefore, await boxOf(page, '.board-session-view .bs-chip'), 'the repo chip');
  assert.equal(await root.locator('.wb-island-board').isVisible(), false, 'Studio hides the board title island; the repo chip names the map');
  await root.locator('.wb-island-board .wb-status').evaluate((status: HTMLElement) => { status.hidden = false; status.textContent = 'Could not undo that change.'; });
  assert.equal(await root.locator('.wb-island-board .wb-status').isVisible(), true, 'a board error still shows in Studio');
  assert.equal(await root.locator('.wb-island-board .wb-board-title').isVisible(), false, 'the board title stays hidden while an error shows');
  await root.locator('.wb-island-board .wb-status').evaluate((status: HTMLElement) => { status.hidden = true; status.textContent = ''; });
  assert.equal(await root.locator('.wb-island-agent').isVisible(), false, 'Studio shows no pairing notice for its main agent');
  assert.equal(await root.locator('.bs-activity').count(), 0, 'the working status shows on the face only');


  const mapSessionId = await root.locator('.bs-card[data-main]').first().getAttribute('data-session-id');
  assert.ok(mapSessionId, 'the main card names its session');
  const mapReply = await page.evaluate(async (sessionId) => {
    const tokenReply: unknown = await fetch('/control-token', { credentials: 'same-origin', cache: 'no-store' }).then((response) => response.json());
    const token = typeof tokenReply === 'object' && tokenReply !== null && 'token' in tokenReply && typeof tokenReply.token === 'string' ? tokenReply.token : '';
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/control?token=${encodeURIComponent(token)}`);
    const requestId = `harness-boxes-${Date.now()}`;
    return new Promise<string | null>((resolve) => {
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'codemap-boxes-of', requestId, id: sessionId, paths: [] })));
      socket.addEventListener('message', (event) => {
        const reply: unknown = JSON.parse(String(event.data));
        if (typeof reply !== 'object' || reply === null || Reflect.get(reply, 'requestId') !== requestId) return;
        socket.close();
        const boardId = Reflect.get(reply, 'boardId');
        resolve(typeof boardId === 'string' ? boardId : null);
      });
    });
  }, mapSessionId);
  assert.ok(mapReply, 'the Studio map has a board');
  await clickBoardBoxWhere(page, root, mapReply, (element) => element.kind === 'box' && element.title === 'repo root' && element.lines.some((line) => line.text.includes('crossed wires')));
  await hoverBoardBoxWhere(page, root, mapReply, (element) => element.kind === 'box' && element.title === 'repo root' && element.lines.some((line) => line.text.includes('imported by')));
  const changedFile = root.locator('.bs-changes:not([hidden]) .bs-changes-row', { has: page.locator('.bs-changes-path', { hasText: 'src/payments/refund-policy.js' }) });
  await changedFile.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.match(String(await changedFile.locator('.bs-changes-counts').innerText()), /^\+\d+\s+-\d+$/, 'hovering a changed box lists each file with lines added and removed');
  await changedFile.locator('.bs-changes-path').click();
  const diffPanel = root.locator('.bs-diff-panel:not([hidden])');
  await diffPanel.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await diffPanel.locator('.bs-diff-title').textContent(), 'src/payments/refund-policy.js', 'clicking a changed file opens its diff in the side panel');
  await page.waitForFunction(() => (document.querySelector('.board-session-view .bs-diff-host')?.childElementCount ?? 0) > 0, undefined, { timeout: BOARD_SESSION_TIMEOUT_MS });
  await diffPanel.locator('.bs-diff-body').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Escape');
  await diffPanel.waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });

  await clickBoardBoxWhere(page, root, mapReply, (element) => element.kind === 'box' && element.title.startsWith('Map at'));
  assert.equal(await root.locator('.bs-pill-address').isHidden(), true, 'a box that is not a folder or file on the map takes no address');
  const barInput = root.locator('.bs-pill textarea.chat-composer-input');
  const barAddress = root.locator('.bs-pill-address-text');
  const addressRepoRoot = async () => {
    for (let clickCount = 0; clickCount < 3; clickCount += 1) {
      await clickBoardBoxWhere(page, root, mapReply, (element) => element.kind === 'box' && element.title === 'repo root');
      if ((await root.locator('.bs-pill-address').isVisible()) && (await barAddress.textContent()) === 'New branch on repo root') return;
    }
    assert.fail('clicking the repo root box, after its stack opens, puts its address in the message bar');
  };
  await addressRepoRoot();
  assert.equal(await barInput.evaluate((input) => input === document.activeElement), true, 'clicking a box focuses the message bar');
  await barInput.press('Escape');
  await root.locator('.bs-pill-address').waitFor({ state: 'hidden', timeout: BOARD_SESSION_TIMEOUT_MS });
  await addressRepoRoot();
  assert.match(String(await barAddress.textContent()), /^New branch on /, 'a box address starts a new agent on it');
  await barInput.fill('work');
  await barInput.press('Enter');
  await root.locator('.bs-failure:not([hidden])', { hasText: 'already works on repo root' }).waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await barAddress.textContent(), 'New branch on repo root', 'a refused box address stays in the bar to retarget');

  const mainCard = root.locator('.bs-card[data-main]').first();
  const studioMainId = await mainCard.getAttribute('data-session-id');
  assert.ok(studioMainId, 'the Studio main shows as a card');
  await chip.click();
  assert.equal(await root.locator('.bs-menu [data-action="board-session-restart-main"]').count(), 0, 'the repo menu holds repos and Open a repo only');
  await chip.click();
  await mainCard.locator('[data-action="board-session-agent-menu"]').click();
  await mainCard.locator('[data-action="board-session-agent-restart"]').click();
  const restartDialog = page.locator('.resume-dialog');
  await restartDialog.waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  await restartDialog.getByText('Fresh conversation', { exact: true }).click();
  await restartDialog.getByRole('button', { name: 'Restart', exact: true }).click();
  await restartDialog.waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.getByRole('button', { name: 'Restart fresh', exact: true }).click();
  await page.getByRole('button', { name: 'Restart fresh', exact: true }).waitFor({ state: 'detached', timeout: BOARD_SESSION_TIMEOUT_MS });
  await page.locator('#tab-focus').click();
  await page.locator('.focus-view').waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await root.isHidden(), true, 'the Studio tab hides when Focus opens');
  await page.locator('.focus-view button.session-row[data-id]').first().waitFor({ timeout: BOARD_SESSION_TIMEOUT_MS });
  assert.equal(await page.locator(`.focus-view button.session-row[data-id="${studioMainId}"]`).count(), 0, 'the Studio main stays out of Focus session rows');
}
