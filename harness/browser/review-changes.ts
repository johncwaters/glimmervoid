import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { git } from '../site-capture/isolated-glimmervoid.ts';

const REVIEWED_FILE_NAME = 'review-changes.txt';
const REVIEWED_FILE_CONTENT = 'read in the change reader\n';
const POLL_INTERVAL_MS = 100;
const WORKTREE_TIMEOUT_MS = 15000;
const READER_TIMEOUT_MS = 20000;

export async function pollFor<T>(label: string, timeoutMs: number, read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

export async function findSessionWorktree(projectDirectory: string): Promise<string | null> {
  const projectRealPath = await fs.realpath(projectDirectory);
  const listing = await git(projectDirectory, ['worktree', 'list', '--porcelain']);
  const worktreePaths = listing.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
  for (const worktreePath of worktreePaths) {
    if (await fs.realpath(worktreePath) !== projectRealPath) return worktreePath;
  }
  return null;
}

export async function commitFile(repositoryPath: string, fileName: string, content: string, message: string): Promise<void> {
  await fs.writeFile(path.join(repositoryPath, fileName), content, 'utf8');
  await git(repositoryPath, ['add', fileName]);
  await git(repositoryPath, ['commit', '-m', message]);
}

async function openChangesReader(page: Page): Promise<void> {
  await page.locator('.session-page-bar').getByRole('button', { name: 'Changes', exact: true }).click();
  const reader = page.locator('.review-reader[data-placement="overlay"]');
  await reader.waitFor();
  await reader.locator(`.review-reader-file[data-path="${REVIEWED_FILE_NAME}"][aria-current="true"]`).waitFor({ timeout: READER_TIMEOUT_MS });
  await reader.locator('.review-reader-diff .review-line-add', { hasText: REVIEWED_FILE_CONTENT.trim() }).waitFor();
  assert.equal(await page.locator('#focus-rail').isVisible(), true, 'the rail stays beside the change reader');
  await page.keyboard.press('j');
  await reader.locator(`.review-reader-file[data-path="${REVIEWED_FILE_NAME}"][aria-current="true"]`).waitFor();
}

async function closeChangesReader(page: Page, sessionId: string): Promise<void> {
  await page.locator('.review-reader').focus();
  await page.keyboard.press('Escape');
  await page.locator('.review-reader').waitFor({ state: 'detached' });
  assert.equal(await page.locator(`#focus-pane-terminal .session-card[data-id="${sessionId}"]`).isVisible(), true, 'closing the reader leaves the terminal where it was');
}

async function verifyChangesButtonCloses(page: Page): Promise<void> {
  const changesButton = page.locator('.session-page-bar').getByRole('button', { name: 'Changes', exact: true });
  assert.equal(await changesButton.getAttribute('aria-pressed'), 'true', 'the Changes button reads pressed while Changes is open');
  await changesButton.click();
  await page.locator('.review-reader').waitFor({ state: 'detached' });
  assert.equal(await changesButton.getAttribute('aria-pressed'), 'false', 'the Changes button reads unpressed once Changes closes');
}

export async function verifyReviewChanges(page: Page, projectDirectory: string): Promise<void> {
  const worktreePath = await pollFor('the session worktree', WORKTREE_TIMEOUT_MS, () => findSessionWorktree(projectDirectory));
  await commitFile(worktreePath, REVIEWED_FILE_NAME, REVIEWED_FILE_CONTENT, 'test: read a file in the change reader');
  const sessionId = await page.locator('#focus-pane-terminal .session-card').getAttribute('data-id');
  assert.ok(sessionId, 'a session is centered in Focus');

  await openChangesReader(page);
  const reader = page.locator('.review-reader');
  assert.equal(await reader.getByRole('button', { name: 'Merge', exact: true }).count(), 0, 'the change reader offers no Merge');
  assert.equal(await reader.getByRole('button', { name: 'Discard', exact: true }).count(), 0, 'the change reader offers no Discard');
  await verifyChangesButtonCloses(page);
  await openChangesReader(page);
  await closeChangesReader(page, sessionId);
  await verifySwitchToFinishedSessionClosesChanges(page, sessionId);
}

async function verifySwitchToFinishedSessionClosesChanges(page: Page, sessionId: string): Promise<void> {
  const railSessionIds = await page.locator('.focus-rail button.session-row[data-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-id')));
  const otherSessionId = railSessionIds[railSessionIds.indexOf(sessionId) - 1];
  if (!otherSessionId) return;
  const otherRow = page.locator(`.focus-rail button.session-row[data-id="${otherSessionId}"]`);
  await page.locator('.session-page-bar').getByRole('button', { name: 'Changes', exact: true }).click();
  await page.locator('.review-reader[data-placement="overlay"]').waitFor();
  await otherRow.click();
  await page.locator('.review-reader').waitFor({ state: 'detached' });
  await page.waitForFunction((id) => document.activeElement?.closest('.session-card')?.getAttribute('data-id') === id, otherSessionId);
  await page.locator(`.focus-rail button.session-row[data-id="${sessionId}"]`).click();
  await page.locator(`#focus-pane-terminal .session-card[data-id="${sessionId}"]`).waitFor();
}

export async function verifyPhoneChanges(page: Page, projectDirectory: string): Promise<void> {
  const worktreePath = await pollFor('the session worktree', WORKTREE_TIMEOUT_MS, () => findSessionWorktree(projectDirectory));
  await commitFile(worktreePath, REVIEWED_FILE_NAME, REVIEWED_FILE_CONTENT, 'test: read a file on the phone Changes screen');
  const changesScreen = page.locator('.phone-screen[data-screen="changes"]');
  const terminalScreen = page.locator('.phone-screen[data-screen="terminal"]');
  const reader = changesScreen.locator('.review-reader');
  await page.locator('[data-action="show-changes"]').click();
  await reader.locator(`.review-reader-file[data-path="${REVIEWED_FILE_NAME}"]`).waitFor({ timeout: READER_TIMEOUT_MS });
  assert.equal(await reader.getAttribute('data-level'), 'list', 'Changes opens on the file list');
  await reader.locator(`.review-reader-file[data-path="${REVIEWED_FILE_NAME}"]`).click();
  await reader.locator('.review-reader-diff .review-line-add', { hasText: REVIEWED_FILE_CONTENT.trim() }).waitFor();
  assert.equal(await reader.getAttribute('data-level'), 'diff');
  assert.equal(await reader.locator('.review-reader-files').isVisible(), false, 'the file list hides while a diff is open');
  await page.evaluate(() => history.back());
  await reader.locator('.review-reader-files').waitFor();
  assert.equal(await reader.getAttribute('data-level'), 'list', 'back closes the diff');
  assert.equal(await changesScreen.isVisible(), true, 'back from a diff stays on Changes');
  await page.evaluate(() => history.back());
  await terminalScreen.waitFor();
  assert.equal(await changesScreen.isVisible(), false, 'back from the list returns to the terminal');
}
