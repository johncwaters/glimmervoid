import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { IssuesStatus } from '../../shared/contracts/issues.ts';
import type { IssueRow } from '../../shared/contracts/issues.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import { STATE_GLYPHS } from '../../shared/states.ts';
import type { Layout } from './cases-core.ts';

type CapturedRequest = { type: string; requestId: string; repo: string; issueNumber: number };

async function applyStatus(page: Page, status: IssuesStatus): Promise<void> {
  await page.evaluate(async (snapshot) => {
    const panelUrl = '/issues-panel.ts';
    const panel: { applyIssuesStatus(message: IssuesStatus): void } = await import(panelUrl);
    panel.applyIssuesStatus(snapshot);
  }, status);
}

async function capturedRequests(page: Page): Promise<CapturedRequest[]> {
  return page.evaluate(() => JSON.parse(document.documentElement.dataset.issuesRequests ?? '[]'));
}

async function replyToDetail(page: Page, request: CapturedRequest, body: string | null, error: string | null = null): Promise<void> {
  await page.evaluate(async (reply) => {
    const panelUrl = '/issues-panel.ts';
    const panel: { applyIssueDetailResult(message: ServerMessageOf<'issue-detail-result'>): void } = await import(panelUrl);
    panel.applyIssueDetailResult(reply);
  }, { type: 'issue-detail-result' as const, requestId: request.requestId, ok: body !== null, body, error });
}

async function emitStateChange(page: Page, sessionId: string, state: string): Promise<void> {
  await page.evaluate(async ({ id, to }) => {
    const controlUrl = '/control-ws.ts';
    const control: { sendControlMsg(message: Record<string, unknown>): boolean } = await import(controlUrl);
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(message) {
      if (typeof message === 'string' && JSON.parse(message).requestId === 'issues-state-probe') {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'state-change', id, session: 'issues-linked-session', from: 'DORMANT', to, event: 'test', timestamp: Date.now() }) }));
        return;
      }
      originalSend.call(this, message);
    };
    try {
      if (!control.sendControlMsg({ type: 'ping', requestId: 'issues-state-probe' })) throw new Error('Control socket is not connected');
    } finally {
      WebSocket.prototype.send = originalSend;
    }
  }, { id: sessionId, to: state });
}

export async function verifyIssues(page: Page, layout: Layout, sessionId: string): Promise<void> {
  await page.locator('#loading-screen').waitFor({ state: 'hidden' });
  const timestamp = Date.now();
  const issue: IssueRow = {
    key: 'Acme/app#42', repo: 'Acme/app', number: 42, title: 'Reconnect queued writes '.repeat(12), url: 'https://github.com/Acme/app/issues/42',
    labels: ['bug', 'long-label-'.repeat(12)], assignees: ['me'], author: 'alice', comments: 4,
    createdAt: new Date(timestamp - 172800000).toISOString(), updatedAt: new Date(timestamp - 360000).toISOString(),
    sources: ['project', 'me', 'team'], teams: ['Acme/platform'], projectId: 'project-1', sessionId,
    pullRequests: [{ number: 44, url: 'https://github.com/Acme/app/pull/44', title: 'Fix reconnect', state: 'draft' }, { number: 45, url: 'https://github.com/Acme/app/pull/45', title: 'Earlier fix', state: 'merged' }],
  };
  const unassigned: IssueRow = { ...issue, key: 'Acme/app#43', number: 43, title: 'Unassigned issue', assignees: [], labels: ['enhancement'], sources: ['project'], teams: [], sessionId: 'missing', pullRequests: [], comments: 0 };
  const viewOnly: IssueRow = { ...issue, key: 'Other/repo#9', repo: 'Other/repo', number: 9, title: 'External issue', labels: [], sources: ['team'], teams: ['Other/help'], projectId: null, sessionId: null, pullRequests: [], url: 'https://github.com/Other/repo/issues/9' };
  const status = IssuesStatus.parse({ type: 'issues-status', ts: timestamp, configured: true, reason: null, lastSyncAt: timestamp, issues: [issue, unassigned, viewOnly] });
  await page.evaluate(async () => {
    const panelUrl = '/issues-panel.ts';
    const panel: { setIssuesRequestSender(sender: (message: Record<string, unknown>) => boolean): void } = await import(panelUrl);
    document.documentElement.dataset.issuesRequests = '[]';
    panel.setIssuesRequestSender((message) => {
      const requests = JSON.parse(document.documentElement.dataset.issuesRequests ?? '[]');
      requests.push(message);
      document.documentElement.dataset.issuesRequests = JSON.stringify(requests);
      return true;
    });
  });
  await applyStatus(page, status);
  if (layout === 'phone') {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Issues', exact: true }).click();
  }
  if (layout === 'desktop') await page.locator('#tab-issues').click();
  const panel = page.locator('.issues-content');
  assert.match(await panel.locator('.issues-sync').textContent() ?? '', /^Synced /);
  const linkedRow = panel.locator('[data-issue-key="Acme/app#42"]');
  const unassignedRow = panel.locator('[data-issue-key="Acme/app#43"]');
  assert.equal(await panel.locator('.issue-row').count(), 3);
  assert.equal((await capturedRequests(page)).length, 0);
  assert.equal(await panel.getByRole('tab', { name: 'All', exact: true }).textContent(), 'All');
  assert.equal(await panel.locator('[data-scope-count="all"]').textContent(), '3');
  assert.equal(await unassignedRow.locator('.issues-state').getAttribute('title'), 'No session yet');
  assert.equal(await unassignedRow.locator('.issues-state').textContent(), STATE_GLYPHS.DORMANT);
  await emitStateChange(page, sessionId, 'RUNNING');
  assert.equal(await linkedRow.locator('.issues-state').textContent(), STATE_GLYPHS.RUNNING);
  await panel.getByRole('tab', { name: 'Mine', exact: true }).click();
  assert.equal(await panel.locator('.issue-row').count(), 1);
  await panel.getByRole('tab', { name: 'Team', exact: true }).click();
  assert.equal(await panel.locator('.issue-row').count(), 2);
  await panel.getByRole('tab', { name: 'Projects', exact: true }).click();
  assert.equal(await panel.locator('.issue-row').count(), 2);
  await panel.getByRole('tab', { name: 'All', exact: true }).click();
  const search = panel.getByRole('searchbox', { name: 'Search issues' });
  await search.fill('reconnect #42 BUG');
  assert.equal(await panel.locator('.issue-row').count(), 1);
  await search.fill('');
  await panel.getByRole('button', { name: 'Filters', exact: true }).click();
  await panel.getByLabel('Has session', { exact: true }).check();
  assert.equal(await panel.locator('.issue-row').count(), 1);
  await panel.getByLabel('Has session', { exact: true }).uncheck();
  await panel.getByLabel('Has PR', { exact: true }).check();
  assert.equal(await panel.locator('.issue-row').count(), 1);
  await panel.getByLabel('Has PR', { exact: true }).uncheck();
  await panel.getByLabel('Unassigned', { exact: true }).check();
  assert.equal(await panel.locator('.issue-row').count(), 1);
  await panel.getByLabel('Unassigned', { exact: true }).uncheck();
  await panel.getByLabel('Repository', { exact: true }).selectOption('Other/repo');
  assert.equal(await panel.locator('.issue-row').count(), 1);
  await panel.getByLabel('Repository', { exact: true }).selectOption('');
  await panel.getByLabel('Label', { exact: true }).selectOption('enhancement');
  assert.equal(await panel.locator('.issue-row').count(), 1);
  await panel.getByLabel('Label', { exact: true }).selectOption('');
  await panel.getByLabel('Sort', { exact: true }).selectOption('comments');
  await panel.getByRole('button', { name: 'Filters', exact: true }).click();
  await linkedRow.click();
  assert.equal(await panel.locator('.issue-body').textContent(), 'Loading description.');
  let requests = await capturedRequests(page);
  const firstDetail = requests.find((request) => request.type === 'issue-detail');
  assert.ok(firstDetail);
  const bodyText = '<script>window.issueInjected = true</script>\n\nPlain text description.';
  await replyToDetail(page, firstDetail, bodyText);
  assert.equal(await panel.locator('.issue-body').textContent(), bodyText);
  assert.equal(await panel.locator('.issue-body script').count(), 0);
  assert.match(await panel.locator('.pr-detail-meta').textContent() ?? '', /assigned to you.*mentions Acme\/platform/);
  assert.equal(await panel.getByRole('button', { name: 'Go to session', exact: true }).count(), 1);
  assert.equal(await panel.getByRole('button', { name: 'Open session', exact: true }).count(), 0);
  const githubLink = panel.getByRole('link', { name: 'View on GitHub', exact: true });
  await githubLink.focus();
  await emitStateChange(page, sessionId, 'WAITING');
  assert.equal(await githubLink.evaluate((element) => element === document.activeElement), true);
  assert.equal(await linkedRow.locator('.issues-state').textContent(), STATE_GLYPHS.WAITING);
  assert.match(await panel.locator('.issues-facts .issues-state').textContent() ?? '', /NEEDS INPUT/);
  for (const selector of ['.pr-queue-title', '.issues-row-labels', '.issue-body', '.pr-detail-title h2']) {
    assert.ok(await panel.locator(selector).first().evaluate((element) => element.scrollWidth <= element.clientWidth), selector);
  }
  const sizes = await panel.evaluate((element) => [...new Set([...element.querySelectorAll('*')].filter((node) => [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())).map((node) => getComputedStyle(node).fontSize))].sort());
  assert.deepEqual(sizes, ['11px', '12px']);
  const isSinglePane = layout === 'phone' || (page.viewportSize()?.width ?? 0) <= 760;
  async function backToQueue(): Promise<void> {
    if (!isSinglePane) return;
    assert.equal(await panel.locator('.pr-queue-pane').isVisible(), false);
    await panel.getByRole('button', { name: 'Back to issues', exact: true }).click();
    assert.equal(await panel.locator('.pr-detail-host').isVisible(), false);
  }
  await backToQueue();
  await linkedRow.click();
  assert.equal((await capturedRequests(page)).filter((request) => request.type === 'issue-detail').length, 1);
  const updatedStatus = { ...status, issues: [{ ...issue, updatedAt: new Date(timestamp + 1000).toISOString() }, unassigned, viewOnly] };
  await applyStatus(page, updatedStatus);
  requests = await capturedRequests(page);
  const updatedDetail = requests.at(-1);
  assert.ok(updatedDetail);
  assert.equal(updatedDetail.type, 'issue-detail');
  await replyToDetail(page, updatedDetail, null, 'GitHub rate limited.');
  assert.equal(await panel.locator('.issue-body').textContent(), 'GitHub rate limited.');
  await backToQueue();
  await unassignedRow.click();
  const openingButton = panel.getByRole('button', { name: 'Open session', exact: true });
  await openingButton.click();
  assert.equal(await openingButton.textContent(), 'Open session');
  assert.equal(await openingButton.isDisabled(), true);
  assert.equal(await openingButton.locator('.issues-spinner').count(), 0);
  assert.match(await panel.locator('.issue-open-status').textContent() ?? '', /Opening session/);
  const openRequest = (await capturedRequests(page)).find((request) => request.type === 'open-issue-session');
  assert.ok(openRequest);
  await page.evaluate(async ({ requestId, id }) => {
    const panelUrl = '/issues-panel.ts';
    const panel: { applyOpenIssueSessionResult(message: Record<string, unknown>): void } = await import(panelUrl);
    panel.applyOpenIssueSessionResult({ requestId, ok: true, sessionId: id, sessionName: 'existing-issue-session', existing: true, pending: true });
  }, { requestId: openRequest.requestId, id: sessionId });
  assert.match(await panel.locator('.issue-open-status').textContent() ?? '', /already open\. Prompt queued\./);
  assert.equal(await panel.getByRole('button', { name: 'Go to session', exact: true }).count(), 1);
  await replyToDetail(page, updatedDetail, 'stale response');
  assert.notEqual(await panel.locator('.issue-body').textContent(), 'stale response');
  await backToQueue();
  await panel.locator('[data-issue-key="Other/repo#9"]').click();
  assert.equal(await openingButton.count(), 0);
  assert.equal(await panel.getByRole('button', { name: 'Go to session', exact: true }).count(), 0);
  assert.match(await panel.locator('.pr-detail-meta').textContent() ?? '', /mentions Other\/help/);
  assert.equal(await panel.getByRole('link', { name: 'View on GitHub', exact: true }).getAttribute('href'), viewOnly.url);
  await backToQueue();
  await linkedRow.click();
  await panel.getByRole('button', { name: 'Go to session', exact: true }).click();
  assert.equal(await page.evaluate(async () => {
    const selectionUrl = '/sidebar/selection.ts';
    const selection: { getSelectedId(): string | null } = await import(selectionUrl);
    return selection.getSelectedId();
  }), sessionId);
  await backToQueue();
  const queuePane = panel.locator('.pr-queue-pane');
  const foot = panel.locator('.pr-queue-foot');
  assert.equal(await foot.getByRole('button', { name: 'Refresh', exact: true }).count(), 1);
  const footBottom = await foot.evaluate((element) => element.getBoundingClientRect().bottom);
  const paneBottom = await queuePane.evaluate((element) => element.getBoundingClientRect().bottom);
  assert.equal(footBottom, paneBottom);
  await applyStatus(page, { ...updatedStatus, isRefreshing: true, refreshNotice: 'Polling GitHub.' });
  assert.equal(await foot.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), true);
  assert.equal(await foot.getByRole('button', { name: 'Refresh', exact: true }).textContent(), 'Refresh');
  await applyStatus(page, updatedStatus);
  if (layout === 'desktop') {
    const originalViewport = page.viewportSize();
    assert.ok(originalViewport);
    await page.setViewportSize({ width: 760, height: originalViewport.height });
    assert.equal(await panel.locator('.pr-queue-pane').isVisible(), false);
    assert.equal(await panel.locator('.pr-detail-host').isVisible(), true);
    await panel.getByRole('button', { name: 'Back to issues', exact: true }).click();
    assert.equal(await panel.locator('.pr-detail-host').isVisible(), false);
    await linkedRow.click();
    assert.equal(await panel.locator('.pr-queue-pane').isVisible(), false);
    await panel.getByRole('button', { name: 'Back to issues', exact: true }).click();
    await page.setViewportSize(originalViewport);
    assert.equal(await panel.locator('.pr-detail-host').isVisible(), true);
  }
  for (const request of (await capturedRequests(page)).filter((request) => request.type === 'issue-detail')) await replyToDetail(page, request, bodyText);
  assert.equal(await panel.locator('.issue-body').textContent(), bodyText);
}
