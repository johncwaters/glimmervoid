import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { MyPrsStatus } from '../../shared/contracts/my-prs.ts';

async function applyStatus(page: Page, status: MyPrsStatus): Promise<void> {
  await page.evaluate(async (snapshot) => {
    const panelUrl = '/my-prs-panel.ts';
    const panel: { applyMyPrsStatus(message: unknown): void } = await import(panelUrl);
    panel.applyMyPrsStatus(snapshot);
  }, status);
}

export async function verifyMyPrKeepMergeable(page: Page): Promise<void> {
  await page.locator('.pr-mode-root:not([hidden])').getByRole('tab', { name: 'Mine', exact: true }).click();
  const timestamp = Date.now();
  const status = MyPrsStatus.parse({
    type: 'my-prs-status', ts: timestamp, configured: true, viewer: 'me',
    prs: [{
      key: 'Acme/app#1322', repo: 'Acme/app', number: 1322, title: 'Repair merge conflicts', url: 'https://github.com/Acme/app/pull/1322',
      isDraft: false, state: 'OPEN', createdAt: new Date(timestamp - 86400000).toISOString(), mergedAt: null, updatedAt: new Date(timestamp).toISOString(),
      baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefName: 'fix/conflicts', headRefOid: 'a'.repeat(40), isCrossRepository: false,
      isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: null,
      checks: { state: 'SUCCESS', failing: [], pendingCount: 0 }, unresolvedThreads: 0, threads: [], behindBy: 22,
      reviewRequests: [], approvals: 0, reviews: [], stage: 'conflicts', keepMergeable: true,
      keepMergeableAttempt: { outcome: 'failed', reason: 'not started: could not fetch the base <blocked>', at: timestamp - 120000 },
    }],
  });
  const panel = page.locator('.pr-mode-root:not([hidden])');
  const control = panel.getByRole('button', { name: 'Keep mergeable', exact: true });
  const detailStatus = panel.locator('.pr-detail .my-pr-merge').first().locator('.pr-action-status');
  const rowChip = panel.locator('.pr-queue-row .my-pr-stage[title]');
  await applyStatus(page, status);
  assert.ok(await control.isVisible());
  assert.equal(await control.getAttribute('aria-pressed'), 'true');
  assert.equal(await control.textContent(), 'Keep mergeable');
  assert.equal(await detailStatus.textContent(), 'Keep mergeable failed: not started: could not fetch the base <blocked> (2m ago)');
  assert.equal(await rowChip.textContent(), 'Repair failed');
  assert.equal(await rowChip.getAttribute('title'), await detailStatus.textContent());
  assert.equal(await control.locator('.pr-action-status, svg').count(), 0);
  for (const outcome of ['no-change', 'timed-out'] as const) {
    await applyStatus(page, { ...status, prs: status.prs.map((pr) => ({ ...pr, keepMergeableAttempt: { outcome, reason: 'No repair was pushed', at: timestamp - 120000 } })) });
    assert.equal(await detailStatus.textContent(), 'Keep mergeable failed: No repair was pushed (2m ago)');
    assert.equal(await control.textContent(), 'Keep mergeable');
  }
  const longReason = 'not pushed: the remote refused the repair '.repeat(20);
  await applyStatus(page, { ...status, prs: status.prs.map((pr) => ({ ...pr, keepMergeableAttempt: { outcome: 'failed', reason: longReason, at: timestamp - 120000 } })) });
  for (const readout of [detailStatus]) {
    assert.ok(await readout.evaluate((element) => element.scrollWidth <= element.clientWidth));
  }
  await applyStatus(page, { ...status, prs: status.prs.map((pr) => ({ ...pr, isKeepMergeableFixInFlight: true })) });
  assert.equal(await detailStatus.textContent(), 'Keep mergeable is running');
  assert.equal(await rowChip.textContent(), 'Repairing');
  assert.equal(await control.textContent(), 'Keep mergeable');
  assert.ok(await control.isEnabled());
  await applyStatus(page, { ...status, prs: status.prs.map((pr) => ({ ...pr, keepMergeable: false })) });
  assert.equal(await detailStatus.textContent(), 'Off');
  assert.equal(await control.getAttribute('aria-pressed'), 'false');
  assert.equal(await control.textContent(), 'Keep mergeable');
  await applyStatus(page, status);
  await verifyRefreshStatusKeepsLayout(page, status);
}

async function verifyRefreshStatusKeepsLayout(page: Page, status: MyPrsStatus): Promise<void> {
  const panel = page.locator('.pr-mode-root:not([hidden])');
  const head = panel.locator('.pr-queue-head');
  const refreshStatus = panel.locator('.reviews-refresh-status');
  assert.equal(await panel.locator('.pr-queue-foot .reviews-refresh-button').count(), 1);
  const queueTop = () => panel.locator('.pr-queue-row').first().evaluate((element) => element.getBoundingClientRect().top);
  const idleHeight = await head.evaluate((element) => element.getBoundingClientRect().height);
  const idleQueueTop = await queueTop();
  await applyStatus(page, { ...status, isRefreshing: true, refreshNotice: 'Refreshing your pull requests and their review threads from GitHub' });
  assert.match(await refreshStatus.textContent() ?? '', /Refreshing/);
  assert.equal(await head.evaluate((element) => element.getBoundingClientRect().height), idleHeight);
  assert.equal(await queueTop(), idleQueueTop);
  assert.ok(await refreshStatus.evaluate((element) => element.scrollWidth >= element.clientWidth));
  await applyStatus(page, status);
}
