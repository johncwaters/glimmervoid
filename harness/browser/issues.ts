import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { IssuesStatus } from '../../shared/contracts/issues.ts';
import type { IssueRow } from '../../shared/contracts/issues.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import { STATE_ICONS } from '../../shared/state-icons.ts';
import type { Layout } from './cases-core.ts';

type CapturedRequest = { type: string; requestId: string; repo: string; issueNumber: number; state?: string };

async function applyStatus(page: Page, status: IssuesStatus): Promise<void> {
  await page.evaluate(async (snapshot) => {
    const panelUrl = '/github/issues-store.ts';
    const panel: { applyIssuesStatus(message: IssuesStatus): void } = await import(panelUrl);
    panel.applyIssuesStatus(snapshot);
  }, status);
}

async function capturedRequests(page: Page): Promise<CapturedRequest[]> {
  return page.evaluate(() => JSON.parse(document.documentElement.dataset.issuesRequests ?? '[]'));
}

async function replyToDetail(page: Page, request: CapturedRequest, body: string | null, error: string | null = null): Promise<void> {
  await page.evaluate(async (reply) => {
    const panelUrl = '/github/issues-store.ts';
    const panel: { applyIssueDetailResult(message: ServerMessageOf<'issue-detail-result'>): void } = await import(panelUrl);
    panel.applyIssueDetailResult(reply);
  }, { type: 'issue-detail-result' as const, requestId: request.requestId, ok: body !== null, body, error });
}

async function replyToStateChange(page: Page, request: CapturedRequest, error: string | null = null): Promise<void> {
  await page.evaluate(async (reply) => {
    const panelUrl = '/github/issues-store.ts';
    const panel: { applySetIssueStateResult(message: ServerMessageOf<'set-issue-state-result'>): void } = await import(panelUrl);
    panel.applySetIssueStateResult(reply);
  }, { type: 'set-issue-state-result' as const, requestId: request.requestId, ok: error === null, error });
}

async function emitStateChange(page: Page, sessionId: string, state: string): Promise<void> {
  await page.evaluate(async ({ id, to }) => {
    const controlUrl = '/control-ws.ts';
    const control: { sendControlMsg(message: Record<string, unknown>): boolean } = await import(controlUrl);
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(message) {
      if (typeof message === 'string' && JSON.parse(message).requestId === 'issues-state-probe') {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session-status', id, session: 'issues-linked-session', transition: { from: 'DORMANT', to, event: 'test' }, timestamp: Date.now() }) }));
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
    labels: ['bug', 'long-label-'.repeat(12)], assignees: ['me'], author: 'alice', isAuthorOrgMember: false, comments: 4,
    createdAt: new Date(timestamp - 172800000).toISOString(), updatedAt: new Date(timestamp - 360000).toISOString(),
    sources: ['project', 'me', 'team'], teams: ['Acme/platform'], projectId: 'project-1', sessionId,
    pullRequests: [{ number: 44, url: 'https://github.com/Acme/app/pull/44', title: 'Fix reconnect', state: 'draft' }, { number: 45, url: 'https://github.com/Acme/app/pull/45', title: 'Earlier fix', state: 'merged' }],
  };
  const unassigned: IssueRow = { ...issue, key: 'Acme/app#43', number: 43, title: 'Unassigned issue', assignees: [], labels: ['enhancement'], sources: ['project'], teams: [], sessionId: 'missing', pullRequests: [], comments: 0 };
  const viewOnly: IssueRow = { ...issue, key: 'Other/repo#9', repo: 'Other/repo', number: 9, title: 'External issue', labels: [], sources: ['team'], teams: ['Other/help'], projectId: null, sessionId: null, pullRequests: [], url: 'https://github.com/Other/repo/issues/9' };
  const status = IssuesStatus.parse({ type: 'issues-status', ts: timestamp, configured: true, reason: null, lastSyncAt: timestamp, issues: [issue, unassigned, viewOnly] });
  await page.evaluate(async () => {
    const panelUrl = '/github/issues-store.ts';
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
  const listPane = panel.locator('.issues-list-pane');
  const pageHost = panel.locator('.issues-page-host');
  const rows = panel.locator('.issues-row');
  const rowGroups = () => rows.evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.group));
  assert.match(await panel.locator('.issues-sync').textContent() ?? '', /^Synced /);
  const linkedRow = panel.locator('[data-issue-key="Acme/app#42"]');
  const unassignedRow = panel.locator('[data-issue-key="Acme/app#43"]');
  assert.equal(await rows.count(), 3);
  assert.equal((await capturedRequests(page)).length, 0);
  assert.match(await panel.locator('.issues-list-heading').textContent() ?? '', /^Needs you3$/);
  assert.deepEqual(await rowGroups(), ['review', 'triage', 'triage']);
  assert.equal(await linkedRow.locator('.issues-row-status').textContent(), 'PR #44 is a draft');
  assert.equal(await linkedRow.locator('.issues-row-ref').textContent(), 'app#42');
  assert.equal(await unassignedRow.locator('.issues-row-status').textContent(), 'New to you');
  assert.equal(await unassignedRow.locator('.issues-status-icon').getAttribute('data-icon'), STATE_ICONS.DORMANT);
  assert.equal(await linkedRow.locator('button, a').count(), 0);
  const search = panel.getByRole('searchbox', { name: 'Search issues' });
  for (const [query, expectedCount] of [['reconnect #42 BUG', 1], ['is:mine', 1], ['is:team', 2], ['is:project', 2], ['is:triage', 2], ['is:review', 1], ['has:session', 1], ['has:pr', 1], ['is:unassigned', 1], ['repo:other', 1], ['label:enhancement', 1]] as const) {
    await search.fill(query);
    assert.equal(await rows.count(), expectedCount, query);
  }
  await search.fill('');
  const withoutPullRequests = { ...status, issues: [{ ...issue, pullRequests: [] }, unassigned, viewOnly] };
  await applyStatus(page, withoutPullRequests);
  await emitStateChange(page, sessionId, 'RUNNING');
  await linkedRow.waitFor({ state: 'detached' });
  assert.equal(await panel.locator('.issues-other-list-count').textContent(), '1 issue');
  await panel.getByRole('button', { name: 'Everything else', exact: true }).click();
  assert.deepEqual(await rowGroups(), ['running']);
  assert.equal(await linkedRow.locator('.issues-row-status').textContent(), 'Working');
  await linkedRow.locator(`.issues-status-icon[data-icon="${STATE_ICONS.RUNNING}"]`).waitFor();
  await panel.getByRole('button', { name: 'Needs you', exact: true }).click();
  await emitStateChange(page, sessionId, 'WAITING');
  await linkedRow.waitFor();
  assert.deepEqual(await rowGroups(), ['waiting', 'triage', 'triage']);
  assert.equal(await linkedRow.locator('.issues-row-status').textContent(), 'Waiting on you');
  await applyStatus(page, { ...status, issues: [{ ...issue, pullRequests: [issue.pullRequests[1]] }, unassigned, viewOnly] });
  assert.deepEqual(await rowGroups(), ['close', 'triage', 'triage']);
  assert.equal(await linkedRow.locator('.issues-row-status').textContent(), 'PR merged, issue open');
  const sizes = await panel.locator('.issues-table').evaluate((element) => [...new Set([...element.querySelectorAll('*')].filter((node) => [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())).map((node) => getComputedStyle(node).fontSize))].sort());
  assert.deepEqual(sizes.filter((size) => size !== '11px' && size !== '12px'), []);
  await applyStatus(page, status);
  await emitStateChange(page, sessionId, 'RUNNING');
  await linkedRow.click();
  assert.equal(await listPane.isVisible(), false);
  assert.equal(await pageHost.isVisible(), true);
  assert.equal(await panel.locator('.issue-body').textContent(), 'Loading description.');
  let requests = await capturedRequests(page);
  const firstDetail = requests.find((request) => request.type === 'issue-detail');
  assert.ok(firstDetail);
  const bodyText = '<script>window.issueInjected = true</script>\n\nSee https://example.com/a_b_c and `order_by`.';
  await replyToDetail(page, firstDetail, bodyText);
  assert.match(await panel.locator('.issue-body').textContent() ?? '', /<script>window\.issueInjected = true<\/script>/);
  assert.equal(await panel.locator('.issue-body script').count(), 0);
  assert.equal(await panel.locator('.issue-body a').getAttribute('href'), 'https://example.com/a_b_c');
  assert.equal(await panel.locator('.issue-body code').textContent(), 'order_by');
  assert.equal(await page.evaluate(() => 'issueInjected' in window), false);
  assert.match(await panel.locator('.issues-ref-line').textContent() ?? '', /Acme\/app#42 by alice/);
  assert.equal(await panel.getByRole('button', { name: 'Open session', exact: true }).count(), 1);
  assert.equal(await panel.getByRole('button', { name: 'Review PR', exact: true }).count(), 1);
  assert.equal(await panel.getByRole('button', { name: 'Start session', exact: true }).count(), 0);
  assert.equal(await panel.locator('.issues-step[aria-current="step"]').textContent(), 'Review');
  assert.match(await panel.locator('.issues-status-box').textContent() ?? '', /PR #44 is a draft/);
  const githubLink = panel.getByRole('link', { name: 'View on GitHub', exact: true });
  await githubLink.focus();
  await emitStateChange(page, sessionId, 'WAITING');
  assert.equal(await githubLink.evaluate((element) => element === document.activeElement), true);
  for (const selector of ['.issues-page-title', '.issue-body', '.issues-ref-line']) {
    assert.ok(await panel.locator(selector).first().evaluate((element) => element.scrollWidth <= element.clientWidth), selector);
  }
  async function backToQueue(): Promise<void> {
    await panel.getByRole('button', { name: 'Back to issues', exact: true }).click();
    assert.equal(await pageHost.isVisible(), false);
    assert.equal(await listPane.isVisible(), true);
  }
  await backToQueue();
  await linkedRow.click();
  assert.equal((await capturedRequests(page)).filter((request) => request.type === 'issue-detail').length, 1);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.press('j');
  assert.equal(await panel.locator('.issues-page-title').textContent(), 'Unassigned issue');
  await page.keyboard.press('k');
  assert.equal(await panel.locator('.issues-page-title').textContent(), issue.title);
  await page.keyboard.press('Escape');
  assert.equal(await pageHost.isVisible(), false);
  await linkedRow.click();
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
  const startButton = panel.getByRole('button', { name: 'Start session', exact: true });
  await startButton.click();
  assert.equal(await startButton.textContent(), 'Start session');
  assert.equal(await startButton.isDisabled(), true);
  assert.equal(await startButton.locator('*').count(), 0);
  assert.match(await panel.locator('.issue-open-status').textContent() ?? '', /Opening session/);
  const openRequest = (await capturedRequests(page)).find((request) => request.type === 'open-issue-session');
  assert.ok(openRequest);
  await page.evaluate(async ({ requestId, id }) => {
    const panelUrl = '/github/issues-store.ts';
    const panel: { applyOpenIssueSessionResult(message: Record<string, unknown>): void } = await import(panelUrl);
    panel.applyOpenIssueSessionResult({ requestId, ok: true, sessionId: id, sessionName: 'existing-issue-session', existing: true, pending: true });
  }, { requestId: openRequest.requestId, id: sessionId });
  assert.match(await panel.locator('.issue-open-status').textContent() ?? '', /already open\. Prompt queued\./);
  assert.equal(await panel.getByRole('button', { name: 'Open session', exact: true }).count(), 1);
  await replyToDetail(page, updatedDetail, 'stale response');
  assert.notEqual(await panel.locator('.issue-body').textContent(), 'stale response');
  await backToQueue();
  await panel.locator('[data-issue-key="Other/repo#9"]').click();
  assert.equal(await startButton.count(), 0);
  assert.equal(await panel.getByRole('button', { name: 'Open session', exact: true }).count(), 0);
  assert.match(await panel.locator('.issue-open-status').textContent() ?? '', /Add a project for Other\/repo/);
  assert.equal(await githubLink.getAttribute('href'), viewOnly.url);
  await backToQueue();
  await linkedRow.click();
  await panel.getByRole('button', { name: 'Open session', exact: true }).click();
  assert.equal(await page.evaluate(async () => {
    const selectionUrl = '/sidebar/selection.ts';
    const selection: { getSelectedId(): string | null } = await import(selectionUrl);
    return selection.getSelectedId();
  }), sessionId);
  if (layout === 'phone') {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Issues', exact: true }).click();
  }
  if (layout === 'desktop') await page.locator('#tab-issues').click();
  await backToQueue();
  const foot = panel.locator('.pr-queue-foot');
  assert.equal(await foot.getByRole('button', { name: 'Refresh', exact: true }).count(), 1);
  await applyStatus(page, { ...updatedStatus, isRefreshing: true, refreshNotice: 'Polling GitHub.' });
  assert.equal(await foot.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), true);
  assert.equal(await foot.getByRole('button', { name: 'Refresh', exact: true }).textContent(), 'Refresh');
  await applyStatus(page, updatedStatus);
  if (layout === 'desktop') {
    const originalViewport = page.viewportSize();
    assert.ok(originalViewport);
    await page.setViewportSize({ width: 760, height: originalViewport.height });
    assert.equal(await linkedRow.locator('.issues-row-ref').isVisible(), false);
    await page.setViewportSize(originalViewport);
    assert.equal(await linkedRow.locator('.issues-row-ref').isVisible(), true);
  }
  const mergedOnly = { ...updatedStatus, issues: [{ ...updatedStatus.issues[0], pullRequests: [issue.pullRequests[1]] }, unassigned, viewOnly] };
  await applyStatus(page, mergedOnly);
  await linkedRow.click();
  for (const request of (await capturedRequests(page)).filter((request) => request.type === 'issue-detail')) await replyToDetail(page, request, bodyText);
  const stateRequests = async () => (await capturedRequests(page)).filter((request) => request.type === 'set-issue-state');
  const closeButton = panel.getByRole('button', { name: 'Close issue', exact: true });
  await closeButton.click();
  assert.equal(await closeButton.isDisabled(), true);
  assert.match(await panel.locator('.issue-open-status').textContent() ?? '', /Closing issue/);
  const closeRequest = (await stateRequests()).at(-1);
  assert.ok(closeRequest);
  assert.deepEqual([closeRequest.repo, closeRequest.issueNumber, closeRequest.state], ['Acme/app', 42, 'closed']);
  await replyToStateChange(page, closeRequest, 'HTTP 403: Resource not accessible');
  assert.match(await panel.locator('.issue-open-status').textContent() ?? '', /HTTP 403/);
  await closeButton.click();
  const retriedClose = (await stateRequests()).at(-1);
  assert.ok(retriedClose);
  await replyToStateChange(page, retriedClose);
  await applyStatus(page, { ...mergedOnly, issues: [unassigned, viewOnly] });
  assert.equal(await panel.locator('.issues-page-title').textContent(), issue.title);
  assert.match(await panel.locator('.issue-open-status').textContent() ?? '', /Closed as completed/);
  assert.equal(await closeButton.count(), 0);
  await panel.getByRole('button', { name: 'Reopen issue', exact: true }).click();
  const reopenRequest = (await stateRequests()).at(-1);
  assert.ok(reopenRequest);
  assert.equal(reopenRequest.state, 'open');
  await replyToStateChange(page, reopenRequest);
  await applyStatus(page, mergedOnly);
  assert.equal(await closeButton.count(), 1);
  assert.equal(await panel.getByRole('button', { name: 'Open session', exact: true }).count(), 1);
  await page.evaluate(async (id) => {
    const registryUrl = '/session-card/card-registry.ts';
    const storeUrl = '/github/issues-store.ts';
    const registry: { sessionUIs: Map<string, unknown> } = await import(registryUrl);
    const store: { refreshIssuesSessionState(): void } = await import(storeUrl);
    registry.sessionUIs.delete(id);
    store.refreshIssuesSessionState();
  }, sessionId);
  assert.equal(await panel.getByRole('button', { name: 'Open session', exact: true }).count(), 0);
  await backToQueue();
  assert.equal(await linkedRow.count(), 1);
}
