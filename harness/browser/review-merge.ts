import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { git } from '../site-capture/isolated-glimmervoid.ts';

const MERGED_FILE_NAME = 'review-merge.txt';
const MERGED_FILE_CONTENT = 'landed through the Review tab Merge button\n';
const POLL_INTERVAL_MS = 100;
const WORKTREE_TIMEOUT_MS = 15000;
const MERGE_ENABLED_TIMEOUT_MS = 20000;
const ORIGIN_TIMEOUT_MS = 30000;

async function pollFor<T>(label: string, timeoutMs: number, read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function findSessionWorktree(projectDirectory: string): Promise<string | null> {
  const projectRealPath = await fs.realpath(projectDirectory);
  const listing = await git(projectDirectory, ['worktree', 'list', '--porcelain']);
  const worktreePaths = listing.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
  for (const worktreePath of worktreePaths) {
    if (await fs.realpath(worktreePath) !== projectRealPath) return worktreePath;
  }
  return null;
}

async function commitInWorktree(worktreePath: string): Promise<void> {
  await fs.writeFile(path.join(worktreePath, MERGED_FILE_NAME), MERGED_FILE_CONTENT, 'utf8');
  await git(worktreePath, ['add', MERGED_FILE_NAME]);
  await git(worktreePath, ['commit', '-m', 'test: land a file through the Review tab']);
}

async function readOriginMergedFile(originPath: string): Promise<string | null> {
  const entry = await git(originPath, ['ls-tree', 'main', '--', MERGED_FILE_NAME]);
  if (entry.trim() === '') return null;
  return git(originPath, ['show', `main:${MERGED_FILE_NAME}`]);
}

export async function verifyReviewMerge(page: Page, projectDirectory: string): Promise<void> {
  const worktreePath = await pollFor('the session worktree', WORKTREE_TIMEOUT_MS, () => findSessionWorktree(projectDirectory));
  const originPath = (await git(projectDirectory, ['remote', 'get-url', 'origin'])).trim();
  assert.equal(await readOriginMergedFile(originPath), null, 'origin main starts without the merged file');
  await commitInWorktree(worktreePath);

  const sidebar = page.locator('#review-sidebar');
  if (await sidebar.getAttribute('data-collapsed') !== null) {
    await sidebar.getByRole('button', { name: 'Open review', exact: true }).click();
  }
  await page.locator('#review-merge-btn:enabled').waitFor({ timeout: MERGE_ENABLED_TIMEOUT_MS });

  const mergeButtonAfterClick = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('#review-merge-btn')?.click();
    const mergeButton = document.querySelector<HTMLButtonElement>('#review-merge-btn');
    return { isDisabled: mergeButton?.disabled ?? null, label: mergeButton?.firstChild?.textContent?.trim() ?? null };
  });
  assert.deepEqual(mergeButtonAfterClick, { isDisabled: true, label: 'Merge' });

  const originContent = await pollFor('the commit on origin main', ORIGIN_TIMEOUT_MS, () => readOriginMergedFile(originPath));
  assert.equal(originContent, MERGED_FILE_CONTENT);
  await sidebar.locator('.review-empty-title', { hasText: 'No changes yet' }).waitFor({ timeout: ORIGIN_TIMEOUT_MS });
}
