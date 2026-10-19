import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { GithubPr, GithubPrsFrame } from '../../shared/contracts/github-prs.ts';
import type { ServerMessage } from '../../shared/contracts/control-messages.ts';
import { MyPrsStatus } from '../../shared/contracts/my-prs.ts';

async function applyStatus(page: Page, status: MyPrsStatus): Promise<void> {
  await page.evaluate(async (snapshot) => {
    const panelUrl = '/github/my-prs-panel.ts';
    const panel: { applyMyPrsStatus(message: unknown): void } = await import(panelUrl);
    panel.applyMyPrsStatus(snapshot);
  }, status);
}

export async function verifyMyPrKeepMergeable(page: Page): Promise<void> {
  await page.locator('.pr-mode-root:not([hidden])').getByRole('tab', { name: 'Mine', exact: true }).click();
  const timestamp = Date.now();
  const canonicalPr = GithubPr.parse({
    key: 'acme/app#1322', id: 'PR_browser', repo: 'Acme/app', number: 1322, title: 'Repair merge conflicts', url: 'https://github.com/Acme/app/pull/1322',
    author: 'me', labels: [], commentCount: 0, rollupState: 'SUCCESS',
    isDraft: false, state: 'OPEN', createdAt: new Date(timestamp - 86400000).toISOString(), mergedAt: null, updatedAt: new Date(timestamp).toISOString(),
    baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefName: 'fix/conflicts', headRefOid: 'a'.repeat(40), isCrossRepository: false,
    isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: null,
    checks: { state: 'SUCCESS', failing: [], pendingCount: 0 }, unresolvedThreads: 0, threads: [], behindBy: 22,
    reviewRequests: [], approvals: 0, reviews: [],
  });
  const status = MyPrsStatus.parse({
    type: 'my-prs-status', ts: timestamp, configured: true, viewer: 'me',
    prs: [{
      key: 'Acme/app#1322', keepMergeable: true,
      keepMergeableAttempt: { outcome: 'failed', reason: 'not started: could not fetch the base <blocked>', at: timestamp - 120000 },
    }],
  });
  await emitControlMessages(page, [{ type: 'github-prs', ts: timestamp, prs: { [canonicalPr.key]: canonicalPr }, freshness: { lastRefreshedAt: timestamp, error: null } }]);
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
  await verifyCanonicalPrStages(page, status, canonicalPr);
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

async function emitControlMessages(page: Page, messages: ServerMessage[]): Promise<void> {
  await page.evaluate(async (frames) => {
    const controlUrl = '/control-ws.ts';
    const control: { sendControlMsg(message: Record<string, unknown>): boolean } = await import(controlUrl);
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(message) {
      if (typeof message === 'string' && JSON.parse(message).requestId === 'my-prs-frame-probe') {
        for (const frame of frames) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
        return;
      }
      originalSend.call(this, message);
    };
    try {
      if (!control.sendControlMsg({ type: 'ping', requestId: 'my-prs-frame-probe' })) throw new Error('Control socket is not connected');
    } finally {
      WebSocket.prototype.send = originalSend;
    }
  }, messages);
}

async function verifyCanonicalPrStages(page: Page, status: MyPrsStatus, initialPr: GithubPr): Promise<void> {
  const sessionId = await page.evaluate(async () => {
    const registryUrl = '/session-card/card-registry.ts';
    const registry: { sessionUIs: Map<string, { name: string }> } = await import(registryUrl);
    const id = registry.sessionUIs.keys().next().value;
    if (!id) throw new Error('No session is available for linked PR chips');
    return id;
  });
  const canonicalPr = GithubPr.parse({
    ...initialPr, key: 'acme/app#1322', id: 'PR_browser', author: 'me', labels: [], commentCount: 0, rollupState: 'PENDING',
    title: 'Canonical PR title', headRefOid: 'c'.repeat(40), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', behindBy: 0,
    checks: { state: 'PENDING', failing: [], pendingCount: 1 },
  });
  const teammatePr = GithubPr.parse({
    ...canonicalPr, key: 'acme/app#1323', id: 'PR_teammate', number: 1323, author: 'teammate',
    title: 'Teammate PR', url: 'https://github.com/Acme/app/pull/1323', isDraft: true,
  });
  await emitControlMessages(page, [{
    type: 'session-prs', id: sessionId,
    linkedPrs: [canonicalPr, teammatePr].map((pr) => ({ repo: 'ACME/app', number: pr.number, url: pr.url, source: 'manual', linkedAt: status.ts })),
  }]);
  const panel = page.locator('.pr-mode-root:not([hidden])');
  const row = panel.locator('.pr-queue-row[data-pr-key="Acme/app#1322"]');
  const sessionPill = panel.locator(`.my-pr-session-pill[data-session-id="${sessionId}"]`);
  for (const checksState of ['PENDING', 'FAILURE', 'SUCCESS'] as const) {
    const updatedPr = { ...canonicalPr, rollupState: checksState, checks: { state: checksState, failing: checksState === 'FAILURE' ? ['build'] : [], pendingCount: checksState === 'PENDING' ? 1 : 0 } };
    const frame = GithubPrsFrame.parse({
      type: 'github-prs', ts: status.ts, prs: { [updatedPr.key]: updatedPr, [teammatePr.key]: teammatePr },
      freshness: { lastRefreshedAt: status.ts, error: null },
    });
    await emitControlMessages(page, [frame]);
    const expectedStage = { PENDING: 'Checks running', FAILURE: 'Checks failing', SUCCESS: 'Ready to merge' }[checksState];
    await row.locator('.my-pr-stage').first().filter({ hasText: expectedStage }).waitFor();
    assert.equal(await row.locator('.pr-queue-title').textContent(), canonicalPr.title);
    assert.equal(await row.getAttribute('title'), `Acme/app#1322: ${expectedStage}`);
    assert.equal(await panel.locator('.pr-queue-row').count(), 1);
    assert.equal(await panel.getByRole('button', { name: 'Keep mergeable', exact: true }).getAttribute('aria-pressed'), 'true');
    const isPhone = await page.locator('html').getAttribute('data-layout') === 'phone';
    if (isPhone) await page.getByRole('button', { name: 'Board', exact: true }).click();
    if (!isPhone) {
      await sessionPill.click();
      await page.waitForFunction(() => document.body.dataset.activeView === 'focus');
    }
    const sessionRows = isPhone ? 'section.phone-screen[data-screen="board"]' : '#focus-rail';
    const chips = page.locator(`${sessionRows} .session-row[data-id="${sessionId}"] .session-pr-chip`);
    const ownChip = chips.filter({ hasText: '#1322' });
    await ownChip.waitFor({ state: 'visible' });
    assert.equal(await ownChip.getAttribute('title'), `ACME/app: ${canonicalPr.title} (${expectedStage})`);
    const teammateChip = chips.filter({ hasText: '#1323' });
    await teammateChip.waitFor({ state: 'visible' });
    assert.equal(await teammateChip.getAttribute('title'), 'ACME/app: Teammate PR (Draft)');
    if (isPhone) {
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Reviews', exact: true }).click();
    }
    if (!isPhone) await page.locator('#tab-prs').click();
  }
  await emitControlMessages(page, [{ type: 'github-prs', ts: status.ts, prs: {}, freshness: { lastRefreshedAt: status.ts, error: null } }]);
  await row.waitFor({ state: 'detached' });
  await emitControlMessages(page, [{ type: 'github-prs', ts: status.ts, prs: { [initialPr.key]: initialPr }, freshness: { lastRefreshedAt: status.ts, error: null } }]);
  await row.locator('.my-pr-stage').first().filter({ hasText: 'Merge conflicts' }).waitFor();
  assert.equal(await row.locator('.pr-queue-title').textContent(), initialPr.title);
}
