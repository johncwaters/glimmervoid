import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { git } from '../site-capture/isolated-glimmervoid.ts';
import type { UpstreamVariant } from './cases-core.ts';

const MERGED_FILE_NAME = 'review-merge.txt';
const MERGED_FILE_CONTENT = 'landed through the Review tab Merge button\n';
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

async function readOriginFile(originPath: string, fileName: string): Promise<string | null> {
  const entry = await git(originPath, ['ls-tree', 'main', '--', fileName]);
  if (entry.trim() === '') return null;
  return git(originPath, ['show', `main:${fileName}`]);
}

async function waitForReviewHeadline(page: Page, headline: string): Promise<void> {
  await page.locator('#review-sidebar .review-status-text', { hasText: headline }).waitFor({ timeout: OUTCOME_TIMEOUT_MS });
}

async function waitForBranchSync(page: Page, label: string): Promise<void> {
  await page.locator('#review-sidebar .review-branch-sync-label', { hasText: label }).waitFor({ timeout: OUTCOME_TIMEOUT_MS });
}

async function verifyOutcome(page: Page, upstream: UpstreamVariant, originPath: string, originHeadBeforeClick: string): Promise<void> {
  const sidebar = page.locator('#review-sidebar');
  if (upstream === 'none') {
    assert.equal(await pollFor('the commit on origin main', OUTCOME_TIMEOUT_MS, () => readOriginFile(originPath, MERGED_FILE_NAME)), MERGED_FILE_CONTENT);
    await sidebar.locator('.review-empty-title', { hasText: 'No changes yet' }).waitFor({ timeout: OUTCOME_TIMEOUT_MS });
    await waitForBranchSync(page, 'main: in sync with origin/main');
    return;
  }
  if (upstream === 'conflict') {
    await waitForReviewHeadline(page, 'Parked: merge conflict');
    await sidebar.getByRole('button', { name: 'Resolve', exact: true }).waitFor({ timeout: OUTCOME_TIMEOUT_MS });
  }
  if (upstream === 'diverged') await waitForReviewHeadline(page, 'Parked: base branch diverged');
  if (upstream === 'push-rejected') {
    await page.getByText(PUSH_REFUSED_WARNING).waitFor({ timeout: OUTCOME_TIMEOUT_MS });
    await waitForBranchSync(page, 'main: 1 ahead of origin/main');
  }
  assert.equal((await git(originPath, ['rev-parse', 'main'])).trim(), originHeadBeforeClick, 'origin main is unchanged');
}

export async function verifyReviewMerge(page: Page, projectDirectory: string, upstream: UpstreamVariant): Promise<void> {
  const worktreePath = await pollFor('the session worktree', WORKTREE_TIMEOUT_MS, () => findSessionWorktree(projectDirectory));
  const originPath = (await git(projectDirectory, ['remote', 'get-url', 'origin'])).trim();
  assert.equal(await readOriginFile(originPath, MERGED_FILE_NAME), null, 'origin main starts without the merged file');
  await commitFile(worktreePath, MERGED_FILE_NAME, MERGED_FILE_CONTENT, 'test: land a file through the Review tab');
  await prepareUpstream(upstream, projectDirectory, originPath);
  const originHeadBeforeClick = (await git(originPath, ['rev-parse', 'main'])).trim();

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
  await verifyOutcome(page, upstream, originPath, originHeadBeforeClick);
}
