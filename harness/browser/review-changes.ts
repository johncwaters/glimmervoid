import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { git } from '../site-capture/isolated-glimmervoid.ts';

const REVIEWED_FILE_NAME = 'review-changes.txt';
const REVIEWED_FILE_CONTENT = 'read in the change reader\n';
const LOCKFILE_NAME = 'package-lock.json';
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

const ADDED_DIFF_LINE = '.review-reader-diff [data-line][data-line-type="change-addition"]';

const CONTEXT_FILE_NAME = 'review-context.txt';
const CONTEXT_LINE_COUNT = 40;
const EDITED_CONTEXT_LINE = 'line 20 edited in the worktree';

async function editPushedFile(worktreePath: string): Promise<void> {
  const lines = Array.from({ length: CONTEXT_LINE_COUNT }, (_, index) => `line ${index + 1}`);
  await commitFile(worktreePath, CONTEXT_FILE_NAME, `${lines.join('\n')}\n`, 'test: a file the base already has');
  await git(worktreePath, ['push', 'origin', 'HEAD:main']);
  lines[19] = EDITED_CONTEXT_LINE;
  await fs.writeFile(path.join(worktreePath, CONTEXT_FILE_NAME), `${lines.join('\n')}\n`, 'utf8');
}

async function verifyModifiedFileDiff(page: Page, worktreePath: string): Promise<void> {
  await editPushedFile(worktreePath);
  await page.locator('.session-page-bar').getByRole('button', { name: 'Changes', exact: true }).click();
  const reader = page.locator('.review-reader[data-placement="overlay"]');
  const contextRow = reader.locator(`.review-reader-file[data-path="${CONTEXT_FILE_NAME}"]`);
  await contextRow.waitFor({ timeout: READER_TIMEOUT_MS });
  assert.equal(await contextRow.locator('.review-file-status').textContent(), 'M', 'a file the base has reads as modified');
  await contextRow.click();
  await reader.locator(ADDED_DIFF_LINE, { hasText: EDITED_CONTEXT_LINE }).waitFor({ timeout: READER_TIMEOUT_MS });
  const layoutGroup = reader.getByRole('group', { name: 'Diff layout' });
  await layoutGroup.getByRole('button', { name: 'Split', exact: true }).click();
  await reader.locator('.review-reader-diff pre[data-diff-type="split"]').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('glimmervoid-review-diff-layout')), '"split"', 'the chosen layout is remembered');
  assert.equal(await layoutGroup.getByRole('button', { name: 'Split', exact: true }).getAttribute('aria-pressed'), 'true');
  await layoutGroup.getByRole('button', { name: 'Unified', exact: true }).click();
  await reader.locator('.review-reader-diff pre[data-diff-type="single"]').waitFor();
  const firstLine = reader.locator('.review-reader-diff [data-line]', { hasText: /^line 1$/ });
  assert.equal(await firstLine.count(), 0, 'unchanged lines far from the edit start collapsed');
  await reader.locator('.review-reader-diff [data-expand-button]').first().click();
  await firstLine.first().waitFor({ timeout: READER_TIMEOUT_MS });
}

async function openChangesReader(page: Page): Promise<void> {
  await page.locator('.session-page-bar').getByRole('button', { name: 'Changes', exact: true }).click();
  const reader = page.locator('.review-reader[data-placement="overlay"]');
  await reader.waitFor();
  await reader.locator(`.review-reader-file[data-path="${REVIEWED_FILE_NAME}"][aria-current="true"]`).waitFor({ timeout: READER_TIMEOUT_MS });
  await reader.locator(ADDED_DIFF_LINE, { hasText: REVIEWED_FILE_CONTENT.trim() }).waitFor({ timeout: READER_TIMEOUT_MS });
  assert.equal(await page.locator('#focus-rail').isVisible(), true, 'the rail stays beside the change reader');
}

async function verifyFileGroups(page: Page): Promise<void> {
  const reader = page.locator('.review-reader');
  const newGroup = reader.getByRole('list', { name: 'New', exact: true });
  const generatedGroup = reader.getByRole('list', { name: 'Generated', exact: true });
  assert.equal(await newGroup.locator(`.review-reader-file[data-path="${REVIEWED_FILE_NAME}"] .review-file-status`).textContent(), 'A', 'a new file sits in New with the letter A');
  assert.equal(await generatedGroup.locator(`.review-reader-file[data-path="${LOCKFILE_NAME}"] .review-file-status`).textContent(), 'A', 'a lockfile sits in Generated with the letter A');
  assert.equal(await newGroup.locator(`.review-reader-file[data-path="${LOCKFILE_NAME}"]`).count(), 0, 'a lockfile stays out of New');
  await page.keyboard.press('j');
  await generatedGroup.locator(`.review-reader-file[data-path="${LOCKFILE_NAME}"][aria-current="true"]`).waitFor();
  await page.keyboard.press('k');
  await newGroup.locator(`.review-reader-file[data-path="${REVIEWED_FILE_NAME}"][aria-current="true"]`).waitFor();
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
  await fs.writeFile(path.join(worktreePath, LOCKFILE_NAME), '{}\n', 'utf8');
  await git(worktreePath, ['add', LOCKFILE_NAME]);
  await commitFile(worktreePath, REVIEWED_FILE_NAME, REVIEWED_FILE_CONTENT, 'test: read a file in the change reader');
  const sessionId = await page.locator('#focus-pane-terminal .session-card').getAttribute('data-id');
  assert.ok(sessionId, 'a session is centered in Focus');

  await openChangesReader(page);
  const reader = page.locator('.review-reader');
  assert.equal(await reader.getByRole('button', { name: 'Merge', exact: true }).count(), 0, 'the change reader offers no Merge');
  assert.equal(await reader.getByRole('button', { name: 'Discard', exact: true }).count(), 0, 'the change reader offers no Discard');
  await verifyFileGroups(page);
  await verifyChangesButtonCloses(page);
  await openChangesReader(page);
  await closeChangesReader(page, sessionId);
  await verifyModifiedFileDiff(page, worktreePath);
  await page.locator('.session-page-bar').getByRole('button', { name: 'Changes', exact: true }).click();
  await page.locator('.review-reader').waitFor({ state: 'detached' });
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
  await reader.locator(ADDED_DIFF_LINE, { hasText: REVIEWED_FILE_CONTENT.trim() }).waitFor({ timeout: READER_TIMEOUT_MS });
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
