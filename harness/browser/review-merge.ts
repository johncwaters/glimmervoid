import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { git } from '../site-capture/isolated-glimmervoid.ts';
import type { UpstreamVariant } from './cases-core.ts';

const MERGED_FILE_NAME = 'review-merge.txt';
const MERGED_FILE_CONTENT = 'landed through the change reader Merge button\n';
const UPSTREAM_CONFLICTING_CONTENT = 'written on origin while the session worked\n';
const UPSTREAM_FILE_NAME = 'upstream.txt';
const LOCAL_ONLY_FILE_NAME = 'local-only.txt';
const POLL_INTERVAL_MS = 100;
const WORKTREE_TIMEOUT_MS = 15000;
const MERGE_ENABLED_TIMEOUT_MS = 20000;
const OUTCOME_TIMEOUT_MS = 30000;
const PUSH_REFUSED_WARNING = 'Merged into main, but origin refused the push, so origin/main does not have it yet. Resync the base branch to push it.';

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

async function pushUpstreamCommit(projectDirectory: string, fileName: string, content: string): Promise<void> {
  const writerPath = `${projectDirectory}-upstream-writer`;
  await git(projectDirectory, ['worktree', 'add', '--detach', writerPath, 'main']);
  await commitFile(writerPath, fileName, content, 'test: move origin main while the session works');
  await git(writerPath, ['push', 'origin', 'HEAD:refs/heads/main']);
  await git(projectDirectory, ['worktree', 'remove', '--force', writerPath]);
}

async function refusePushesTo(originPath: string): Promise<void> {
  const hookPath = path.join(originPath, 'hooks', 'pre-receive');
  await fs.writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
  await fs.chmod(hookPath, 0o755);
}

async function prepareUpstream(upstream: UpstreamVariant, projectDirectory: string, originPath: string): Promise<void> {
  if (upstream === 'conflict') {
    await pushUpstreamCommit(projectDirectory, MERGED_FILE_NAME, UPSTREAM_CONFLICTING_CONTENT);
    return;
  }
  if (upstream === 'diverged') {
    await pushUpstreamCommit(projectDirectory, UPSTREAM_FILE_NAME, 'upstream\n');
    await commitFile(projectDirectory, LOCAL_ONLY_FILE_NAME, 'local\n', 'test: commit on local main only');
    return;
  }
  if (upstream === 'push-rejected') await refusePushesTo(originPath);
}

export async function readOriginFile(originPath: string, fileName: string): Promise<string | null> {
  const entry = await git(originPath, ['ls-tree', 'main', '--', fileName]);
  if (entry.trim() === '') return null;
  return git(originPath, ['show', `main:${fileName}`]);
}

async function readReviewBarPlaces(page: Page): Promise<number[]> {
  await page.locator('.session-page-button[data-page="changes"]:not([data-slot-held])').waitFor();
  return page.evaluate(() => ['.pane-tab[data-tab="terminal"]', '.session-page-bar [data-action="open-changes"]'].map((selector) => document.querySelector(selector)?.getBoundingClientRect().left ?? -1));
}

async function waitForReaderStatus(page: Page, sentence: string): Promise<void> {
  await page.locator('.review-reader .review-reader-status', { hasText: sentence }).waitFor({ timeout: OUTCOME_TIMEOUT_MS });
}

async function verifyOutcome(page: Page, upstream: UpstreamVariant, originPath: string, originHeadBeforeClick: string): Promise<void> {
  const reader = page.locator('.review-reader');
  if (upstream === 'none') {
    assert.equal(await pollFor('the commit on origin main', OUTCOME_TIMEOUT_MS, () => readOriginFile(originPath, MERGED_FILE_NAME)), MERGED_FILE_CONTENT);
    await reader.locator('.review-empty-title', { hasText: 'No changes yet' }).waitFor({ timeout: OUTCOME_TIMEOUT_MS });
    return;
  }
  if (upstream === 'conflict') {
    await waitForReaderStatus(page, 'Parked: merge conflict');
    assert.equal(await reader.getByRole('button', { name: 'Merge', exact: true }).isVisible(), false, 'a merge conflict offers no Merge');
  }
  if (upstream === 'diverged') await waitForReaderStatus(page, 'Parked: base branch diverged');
  if (upstream === 'push-rejected') {
    await page.getByText(PUSH_REFUSED_WARNING).waitFor({ timeout: OUTCOME_TIMEOUT_MS });
    await page.locator('#header-status-dismiss').click();
  }
  assert.equal((await git(originPath, ['rev-parse', 'main'])).trim(), originHeadBeforeClick, 'origin main is unchanged');
}

async function openChangesReader(page: Page): Promise<void> {
  await page.locator('.session-page-bar').getByRole('button', { name: 'Changes', exact: true }).click();
  const reader = page.locator('.review-reader[data-placement="overlay"]');
  await reader.waitFor();
  await reader.locator(`.review-reader-file[data-path="${MERGED_FILE_NAME}"][aria-current="true"]`).waitFor({ timeout: MERGE_ENABLED_TIMEOUT_MS });
  await reader.locator('.review-reader-diff .review-line-add', { hasText: MERGED_FILE_CONTENT.trim() }).waitFor();
  assert.equal(await page.locator('#focus-rail').isVisible(), true, 'the rail stays beside the change reader');
  await page.keyboard.press('j');
  await reader.locator(`.review-reader-file[data-path="${MERGED_FILE_NAME}"][aria-current="true"]`).waitFor();
}

async function closeChangesReader(page: Page, sessionId: string): Promise<void> {
  await page.locator('.review-reader').focus();
  await page.keyboard.press('Escape');
  await page.locator('.review-reader').waitFor({ state: 'detached' });
  assert.equal(await page.locator(`#focus-pane-terminal .session-card[data-id="${sessionId}"]`).isVisible(), true, 'closing the reader leaves the terminal where it was');
}

export async function verifyReviewMerge(page: Page, projectDirectory: string, upstream: UpstreamVariant): Promise<void> {
  const worktreePath = await pollFor('the session worktree', WORKTREE_TIMEOUT_MS, () => findSessionWorktree(projectDirectory));
  const originPath = (await git(projectDirectory, ['remote', 'get-url', 'origin'])).trim();
  assert.equal(await readOriginFile(originPath, MERGED_FILE_NAME), null, 'origin main starts without the merged file');
  const placesBeforeChanges = await readReviewBarPlaces(page);
  await commitFile(worktreePath, MERGED_FILE_NAME, MERGED_FILE_CONTENT, 'test: land a file through the change reader');
  await prepareUpstream(upstream, projectDirectory, originPath);
  const originHeadBeforeClick = (await git(originPath, ['rev-parse', 'main'])).trim();
  const sessionId = await page.locator('#focus-pane-terminal .session-card').getAttribute('data-id');
  assert.ok(sessionId, 'a session is centered in Focus');

  await openChangesReader(page);
  await page.locator('.review-reader [data-action="merge-session"]:enabled').waitFor({ timeout: MERGE_ENABLED_TIMEOUT_MS });
  assert.deepEqual(await readReviewBarPlaces(page), placesBeforeChanges, 'Terminal and Changes hold their place while the review status changes');
  assert.equal(await page.locator('.session-card-header [data-action="merge-session"]').count(), 0, 'Merge lives only in the Changes view');
  const mergeButtonAfterClick = await page.evaluate(() => {
    const mergeButton = document.querySelector<HTMLButtonElement>('.review-reader [data-action="merge-session"]');
    mergeButton?.click();
    return { isDisabled: mergeButton?.disabled ?? null, label: mergeButton?.textContent?.trim() ?? null };
  });
  assert.deepEqual(mergeButtonAfterClick, { isDisabled: true, label: 'Merge' });
  await verifyOutcome(page, upstream, originPath, originHeadBeforeClick);
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
  await commitFile(worktreePath, MERGED_FILE_NAME, MERGED_FILE_CONTENT, 'test: read a file on the phone Changes screen');
  const changesScreen = page.locator('.phone-screen[data-screen="changes"]');
  const terminalScreen = page.locator('.phone-screen[data-screen="terminal"]');
  const reader = changesScreen.locator('.review-reader');
  await page.locator('[data-action="show-changes"]').click();
  await reader.locator(`.review-reader-file[data-path="${MERGED_FILE_NAME}"]`).waitFor({ timeout: MERGE_ENABLED_TIMEOUT_MS });
  assert.equal(await reader.getAttribute('data-level'), 'list', 'Changes opens on the file list');
  await reader.locator(`.review-reader-file[data-path="${MERGED_FILE_NAME}"]`).click();
  await reader.locator('.review-reader-diff .review-line-add', { hasText: MERGED_FILE_CONTENT.trim() }).waitFor();
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
