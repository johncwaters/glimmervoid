import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { ReviewDraft, TeamReviewStatus } from '../../shared/contracts/team-review.ts';
import type { TeamReviewAction } from '../../shared/contracts/team-review.ts';
import type { Layout } from './cases-core.ts';
import { verifyMyPrKeepMergeable } from './my-prs.ts';

const REVIEWED_HEAD = 'a'.repeat(40);
const PREVIOUS_HEAD = 'b'.repeat(40);

interface TeamReviewPanelModule {
  applyTeamReviewStatus(message: unknown): void;
  applyTeamReviewActionResult(message: unknown): void;
}

function createDraft(number: number, overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return ReviewDraft.parse({
    key: `Acme/app#${number}`, repo: 'Acme/app', number, title: `PR ${number}: ${'A long title '.repeat(12)}`,
    url: `https://github.com/Acme/app/pull/${number}`, author: 'teammate', tier: 'full', reasons: [],
    reviewedHead: REVIEWED_HEAD, verdict: 'APPROVE', summary: 'Fine', body: 'Fine', comments: [], status: 'ready',
    reviewedAt: Date.now() - 3_600_000, prCreatedAt: new Date(Date.now() - 86_400_000).toISOString(), ...overrides,
  });
}

function createStatus(): TeamReviewStatus {
  return TeamReviewStatus.parse({
    type: 'team-review-status', ts: Date.now(), configured: true, reason: null,
    drafts: [
      createDraft(1),
      createDraft(2, {
        verdict: 'APPROVE WITH NITS', body: '**[logic] HIGH**\n\nA body finding.',
        comments: [
          { path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'An inline finding.', severity: 'LOW' },
          { path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'A second inline finding.' },
        ],
        githubReviews: [
          { login: 'me', state: 'APPROVED', commit: PREVIOUS_HEAD, isViewer: true },
          { login: 'sarah', state: 'COMMENTED', commit: REVIEWED_HEAD, isViewer: false },
        ],
      }),
      createDraft(3, { verdict: 'REQUEST CHANGES' }),
      createDraft(4, { verdict: 'BLOCKED' }),
      createDraft(5, { status: 'error', error: 'Review timed out' }),
      createDraft(6, { status: 'discarded' }),
      createDraft(7, { status: 'posted', postedAt: Date.now() - 600_000 }),
      createDraft(8, { githubReviews: [{ login: 'me', state: 'APPROVED', commit: REVIEWED_HEAD, isViewer: true }] }),
    ],
    inFlight: [{
      key: 'Acme/app#9', repo: 'Acme/app', number: 9, title: 'In progress', url: 'https://github.com/Acme/app/pull/9',
      author: 'teammate', tier: 'full', reasons: [], head: REVIEWED_HEAD, phase: 'reviewing',
      startedAt: Date.now() - 60_000, deadlineAt: null, toolCalls: 1, recentSteps: [],
    }],
    queued: [{ key: 'Acme/app#10', repo: 'Acme/app', number: 10, title: 'Queued PR', url: 'https://github.com/Acme/app/pull/10', author: 'teammate' }],
  });
}

async function applyStatus(page: Page, status: TeamReviewStatus): Promise<void> {
  await page.evaluate(async (snapshot) => {
    const panelUrl = '/team-review-panel.ts';
    const panel: TeamReviewPanelModule = await import(panelUrl);
    panel.applyTeamReviewStatus(snapshot);
  }, status);
}

async function verifyRows(page: Page): Promise<void> {
  const rows = await page.locator('.pr-queue-row').evaluateAll((buttons) => buttons.map((button) => ({
    key: button.getAttribute('data-review-key'),
    ref: button.querySelector('.pr-queue-ref')?.textContent,
    bottom: button.querySelector('.pr-queue-bottom')?.textContent,
    stateWord: button.querySelector('.pr-queue-state')?.textContent,
    stateTone: button.querySelector('.pr-queue-state')?.getAttribute('data-tone'),
    glyphTone: button.querySelector('.pr-queue-glyph .state-glyph')?.getAttribute('data-tone'),
    authorAvatars: button.querySelectorAll('.pr-queue-author .avatar').length,
    reviewerAvatars: button.querySelectorAll('.pr-queue-reviewers .avatar').length,
    title: button.getAttribute('title'),
    accessibleName: button.getAttribute('aria-label'),
    children: button.children.length,
    removedParts: button.querySelectorAll('.pr-verdict-seal, .pr-severity-meter, .pr-rereview-tag').length,
  })));
  assert.equal(rows.length, 10);
  for (const row of rows) {
    assert.equal(row.removedParts, 0);
    const isDiscardedRow = row.key === 'Acme/app#6';
    assert.equal(row.children, isDiscardedRow ? 1 : 3);
    assert.equal(row.authorAvatars, isDiscardedRow ? 0 : 1);
    assert.equal(row.accessibleName, row.title);
    assert.equal(row.ref, row.key?.replace('Acme/app', ''));
    assert.equal(row.stateTone, row.glyphTone);
    assert.equal(Boolean(row.stateWord), !isDiscardedRow);
  }
  const nits = rows.find((row) => row.key === 'Acme/app#2');
  assert.ok(nits);
  assert.equal(nits.stateWord, 'Waits on you');
  assert.doesNotMatch(nits.bottom ?? '', /since approval|drafted|resolved|Nits|Approve|Changes|Blocked/);
  assert.match(nits.title ?? '', /Acme\/app#2:.*\nWaits on you\n/s);
  assert.match(nits.accessibleName ?? '', /Nits, 2 comments/);
  assert.equal(nits.reviewerAvatars, 2);
}

async function verifyLayout(page: Page): Promise<void> {
  const layout = await page.locator('.pr-queue-row[data-review-key="Acme/app#2"]').evaluate((row) => {
    const top = row.querySelector('.pr-queue-top');
    const bottom = row.querySelector('.pr-queue-bottom');
    const title = row.querySelector('.pr-queue-title');
    const age = row.querySelector('.pr-queue-elapsed');
    if (!top || !bottom || !title || !age) throw new Error('The row is missing its two lines or age');
    return {
      top: top.getBoundingClientRect().toJSON(), bottom: bottom.getBoundingClientRect().toJSON(),
      row: row.getBoundingClientRect().toJSON(), age: age.getBoundingClientRect().toJSON(),
      titleOverflow: getComputedStyle(title).textOverflow,
      titleIsTruncated: title.scrollWidth > title.clientWidth,
      bottomOverflows: bottom.scrollWidth > bottom.clientWidth,
    };
  });
  assert.equal(layout.titleOverflow, 'ellipsis');
  assert.equal(layout.titleIsTruncated, true);
  assert.equal(layout.bottomOverflows, false);
  assert.ok(layout.bottom.y >= layout.top.bottom);
  assert.ok(layout.bottom.right <= layout.row.right);
  assert.ok(layout.age.right <= layout.row.right);
}

async function verifyCollapsedRailShowsNumbers(page: Page): Promise<void> {
  const discardedRow = page.locator('.pr-queue-row[data-review-key="Acme/app#6"]');
  await page.locator('.pr-mode-root:not([hidden]) .pr-queue-toggle').click();
  const compactRef = discardedRow.locator('.pr-queue-ref-compact');
  assert.ok(await compactRef.isVisible());
  assert.equal(await compactRef.textContent(), '#6');
  await page.waitForFunction(() => {
    const ref = document.querySelector('.pr-queue-row[data-review-key="Acme/app#6"] .pr-queue-ref-compact');
    return ref !== null && ref.scrollWidth <= ref.clientWidth && ref.getBoundingClientRect().width > 8;
  }, undefined, { timeout: 2_000 });
  assert.equal(await discardedRow.locator('.pr-queue-ref').isVisible(), false);
  assert.equal(await discardedRow.locator('.pr-queue-title').isVisible(), false);
  await page.locator('.pr-mode-root:not([hidden]) .pr-queue-toggle').click();
  await discardedRow.locator('.pr-queue-title').waitFor({ state: 'visible' });
  assert.equal(await compactRef.isVisible(), false);
  await verifyLayout(page);
}

async function readInReviewElapsedTexts(page: Page): Promise<{ row: string | null; detail: string | null }> {
  return page.evaluate(() => ({
    row: document.querySelector('.pr-queue-row[data-review-key="Acme/app#9"] .pr-queue-elapsed')?.textContent ?? null,
    detail: document.querySelector('.pr-detail .pr-progress-text')?.textContent ?? null,
  }));
}

async function verifyUnchangedQueueKeepsRowNodes(page: Page, status: TeamReviewStatus): Promise<void> {
  await page.locator('.pr-queue-row[data-review-key="Acme/app#9"]').click();
  await applyStatus(page, { ...status, isRefreshing: true });
  const firstRowBefore = await page.locator('.pr-queue-row').first().elementHandle();
  assert.ok(firstRowBefore);
  await applyStatus(page, { ...status, nextAttemptAt: Date.now() + 60_000 });
  const isSameConnectedRow = await page.evaluate((row) => row.isConnected && row === document.querySelector('.pr-queue-row'), firstRowBefore);
  assert.equal(isSameConnectedRow, true);
  const elapsedBeforeSkippedRender = await readInReviewElapsedTexts(page);
  assert.ok(elapsedBeforeSkippedRender.row);
  assert.ok(elapsedBeforeSkippedRender.detail);
  await applyStatus(page, { ...status, isRefreshing: false });
  assert.equal(await page.evaluate((row) => row === document.querySelector('.pr-queue-row'), firstRowBefore), true);
  await page.waitForFunction((before) => {
    const row = document.querySelector('.pr-queue-row[data-review-key="Acme/app#9"] .pr-queue-elapsed')?.textContent ?? null;
    const detail = document.querySelector('.pr-detail .pr-progress-text')?.textContent ?? null;
    return row !== null && detail !== null && row !== before.row && detail !== before.detail;
  }, elapsedBeforeSkippedRender, { timeout: 5_000 });
}

async function verifyQueueRebuildsAfterEmptyStatus(page: Page, status: TeamReviewStatus): Promise<void> {
  const firstRowBefore = await page.locator('.pr-queue-row').first().elementHandle();
  assert.ok(firstRowBefore);
  await applyStatus(page, { ...status, drafts: [], inFlight: [], queued: [] });
  assert.equal(await page.locator('.pr-queue-row').count(), 0);
  await applyStatus(page, status);
  assert.equal(await page.locator('.pr-queue-row').count(), 10);
  const isFirstRowRebuilt = await page.evaluate((row) => !row.isConnected && row !== document.querySelector('.pr-queue-row'), firstRowBefore);
  assert.equal(isFirstRowRebuilt, true);
}

async function verifyViewerThreadCounts(page: Page, snapshot: TeamReviewStatus): Promise<void> {
  const review = createDraft(1, {
    viewerThreads: { total: 5, resolved: 2 },
    comments: [{ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'Drafted finding.' }],
    githubReviews: [{ login: 'me', state: 'COMMENTED', commit: REVIEWED_HEAD, isViewer: true }],
  });
  const withDraft = (draft: ReviewDraft) => ({ ...snapshot, drafts: [draft], inFlight: [], queued: [] });
  await applyStatus(page, withDraft(review));
  const row = page.locator('.pr-queue-row[data-review-key="Acme/app#1"]');
  assert.doesNotMatch(await row.locator('.pr-queue-bottom').textContent() ?? '', /drafted|resolved/);
  assert.match(await row.getAttribute('title') ?? '', /2 of 5 of your comments resolved/);
  const sectionHeading = () => row.evaluate((element) => element.closest('.pr-queue-section')?.querySelector('.pr-section-heading')?.textContent);
  assert.match(await sectionHeading() ?? '', /Already reviewed/);
  await row.click();
  assert.equal(await page.locator('.pr-detail-heading .pr-viewer-threads').textContent(), '2 of 5 of your comments resolved');
  const resolved = { ...review, viewerThreads: { total: 5, resolved: 5 } };
  await applyStatus(page, withDraft(resolved));
  assert.doesNotMatch(await sectionHeading() ?? '', /Already reviewed/);
  assert.equal(await row.locator('.pr-queue-state').textContent(), 'Comments resolved');
  assert.equal(await page.locator('.pr-detail-heading .pr-viewer-threads').textContent(), 'All 5 of your comments resolved');
  assert.match(await row.getAttribute('title') ?? '', /All 5 of your comments resolved/);
  await applyStatus(page, withDraft({ ...resolved, viewerThreads: { total: 5, resolved: 3 } }));
  assert.equal(await page.locator('.pr-detail-heading .pr-viewer-threads').textContent(), '3 of 5 of your comments resolved');
  await applyStatus(page, withDraft({ ...resolved, reviewDecision: 'APPROVED', githubReviews: [{ login: 'me', state: 'APPROVED', commit: REVIEWED_HEAD, isViewer: true }] }));
  assert.match(await sectionHeading() ?? '', /Already reviewed/);
  await applyStatus(page, withDraft({ ...resolved, status: 'posted', postedEvent: 'COMMENT', postedAt: Date.now() }));
  assert.match(await sectionHeading() ?? '', /Ready/);
  assert.equal(await row.locator('.pr-queue-state').textContent(), 'Comments resolved');
  await row.click();
  assert.equal(await page.locator('.pr-detail-heading .pr-viewer-threads').textContent(), 'All 5 of your comments resolved');
  await applyStatus(page, withDraft({ ...review, status: 'posted', postedEvent: 'COMMENT', postedAt: Date.now() }));
  assert.match(await sectionHeading() ?? '', /Waiting on author/);
  await applyStatus(page, snapshot);
}

interface ActionCaptureWindow extends Window {
  teamReviewOriginalSend?: WebSocket['send'];
}

async function replyToCapturedAction(page: Page, ok: boolean, warning?: string): Promise<void> {
  await page.evaluate(async ({ isOk, warning }) => {
    const requestText = document.documentElement.dataset.teamReviewAction;
    if (!requestText) throw new Error('No review action was sent');
    const request = JSON.parse(requestText) as { key: string; requestId: string };
    const panelUrl = '/team-review-panel.ts';
    const panel: TeamReviewPanelModule = await import(panelUrl);
    panel.applyTeamReviewActionResult({ type: 'team-review-action-result', key: request.key, requestId: request.requestId, ok: isOk, error: isOk ? undefined : 'Action rejected', warning });
    delete document.documentElement.dataset.teamReviewAction;
  }, { isOk: ok, warning });
}

async function clickReviewAction(page: Page, action: TeamReviewAction): Promise<void> {
  const control = page.locator(`.pr-detail button[data-action="${action}"]`);
  if (!await control.isVisible()) await page.locator('.pr-detail .review-more-button').click();
  const labelBeforeAction = await control.textContent();
  await control.click();
  assert.equal(await control.textContent(), labelBeforeAction);
}

async function verifyActionAdvancement(page: Page, snapshot: TeamReviewStatus): Promise<void> {
  await page.evaluate(() => {
    const captureWindow = window as ActionCaptureWindow;
    const originalSend = WebSocket.prototype.send;
    captureWindow.teamReviewOriginalSend = originalSend;
    WebSocket.prototype.send = function(message) {
      if (typeof message === 'string') {
        const request = JSON.parse(message) as { type?: string };
        if (request.type === 'team-review-action') {
          document.documentElement.dataset.teamReviewAction = message;
          return;
        }
      }
      originalSend.call(this, message);
    };
  });
  const reviewRow = (number: number) => page.locator(`.pr-queue-row[data-review-key="Acme/app#${number}"]`);
  const withDrafts = (drafts: ReviewDraft[]) => ({ ...snapshot, drafts, inFlight: [], queued: [] });
  const actionNotice = page.locator('.pr-detail-host .pr-action-notice');
  const caughtUpTitle = page.locator('.pr-detail-host .pr-caught-up-title');
  const caughtUpDetailText = page.locator('.pr-detail-host .pr-caught-up-detail');
  try {
    for (const action of ['approve', 'approve-only', 'comment', 'discard', 'requeue'] as const) {
      await applyStatus(page, withDrafts([createDraft(1), createDraft(2), createDraft(3)]));
      await reviewRow(1).click();
      await clickReviewAction(page, action);
      await applyStatus(page, { ...withDrafts([createDraft(3, { requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED' }), createDraft(2), createDraft(1, { status: action === 'discard' ? 'discarded' : 'posted' })]), queued: action === 'requeue' ? [createDraft(1)] : [] });
      assert.equal(await reviewRow(1).getAttribute('aria-current'), 'true');
      await replyToCapturedAction(page, true);
      assert.equal(await reviewRow(2).getAttribute('aria-current'), 'true');
      assert.match(await actionNotice.textContent() ?? '', /^Acme\/app#1: /);
      assert.equal(await actionNotice.isVisible(), true);
    }
    await reviewRow(3).click();
    assert.equal(await actionNotice.isVisible(), false);
    await applyStatus(page, withDrafts([createDraft(1), createDraft(2), createDraft(3)]));
    await reviewRow(1).click();
    await clickReviewAction(page, 'approve');
    await applyStatus(page, withDrafts([createDraft(1, { status: 'posted' }), createDraft(2), createDraft(3)]));
    await replyToCapturedAction(page, true, 'Could not confirm the pull request head after approving. Check the approval on GitHub');
    assert.equal(await reviewRow(1).getAttribute('aria-current'), 'true');
    assert.equal(await actionNotice.textContent(), 'Acme/app#1: Approved on GitHub. Could not confirm the pull request head after approving. Check the approval on GitHub.');
    assert.equal(await actionNotice.getAttribute('data-tone'), 'error');
    await applyStatus(page, withDrafts([createDraft(4, { status: 'posted', threads: [{
      id: 'PRRT_acme_4', path: 'src/app.ts', line: 2, isResolved: false, viewerCanResolve: true,
      isNit: false, url: 'https://github.com/Acme/app/pull/4#discussion_r4',
      lastReplyAuthor: 'teammate', lastReplyAt: '2026-10-01T12:00:00Z',
    }] }), createDraft(2)]));
    await reviewRow(4).click();
    await page.locator('.pr-detail').getByRole('button', { name: 'Resolve', exact: true }).click();
    await replyToCapturedAction(page, true);
    assert.equal(await reviewRow(4).getAttribute('aria-current'), 'true');
    await applyStatus(page, withDrafts([createDraft(1), createDraft(2), createDraft(3)]));
    await reviewRow(1).click();
    await clickReviewAction(page, 'approve');
    await reviewRow(3).click();
    await replyToCapturedAction(page, true);
    assert.equal(await reviewRow(3).getAttribute('aria-current'), 'true');
    await applyStatus(page, withDrafts([createDraft(1, { summary: 'A fresh draft' }), createDraft(2)]));
    await reviewRow(1).click();
    await clickReviewAction(page, 'approve');
    await replyToCapturedAction(page, false);
    assert.equal(await reviewRow(1).getAttribute('aria-current'), 'true');
    assert.equal(await page.locator('.pr-detail .pr-action-status').textContent(), 'Action rejected');
    await clickReviewAction(page, 'approve');
    await applyStatus(page, withDrafts([createDraft(1, { status: 'posted' }), createDraft(2, { status: 'discarded' })]));
    await replyToCapturedAction(page, true);
    assert.equal(await page.locator('.pr-queue-row[aria-current="true"]').count(), 0);
    assert.equal(await caughtUpTitle.textContent(), 'All caught up');
    assert.equal(await actionNotice.textContent(), 'Acme/app#1: Approved on GitHub.');
    await applyStatus(page, { ...withDrafts([createDraft(1, { status: 'posted' }), createDraft(2, { status: 'discarded' })]), handReview: [createDraft(12)] });
    assert.equal(await caughtUpTitle.textContent(), 'Drafts all handled');
    assert.equal(await caughtUpDetailText.textContent(), '1 pull request needs review by hand.');
    await applyStatus(page, withDrafts([createDraft(1, { status: 'posted' }), createDraft(2)]));
    assert.equal(await page.locator('.pr-queue-row[aria-current="true"]').count(), 0);
    assert.equal(await caughtUpTitle.textContent(), 'New pull requests need you');
    assert.equal(await caughtUpDetailText.textContent(), 'Pick one from the queue.');
    await reviewRow(2).click();
    assert.equal(await reviewRow(2).getAttribute('aria-current'), 'true');
    assert.equal(await page.locator('.pr-detail-host .pr-caught-up').count(), 0);
    await clickReviewAction(page, 'approve');
    await replyToCapturedAction(page, true);
    await applyStatus(page, withDrafts([]));
    assert.equal(await caughtUpTitle.textContent(), 'All caught up');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await page.evaluate(() => {
      const captureWindow = window as ActionCaptureWindow;
      if (captureWindow.teamReviewOriginalSend) WebSocket.prototype.send = captureWindow.teamReviewOriginalSend;
      delete captureWindow.teamReviewOriginalSend;
      delete document.documentElement.dataset.teamReviewAction;
    });
    await applyStatus(page, snapshot);
    await reviewRow(1).click();
  }
}

export async function verifyTeamReviewRows(page: Page, layout: Layout): Promise<void> {
  await page.locator('#loading-screen').waitFor({ state: 'hidden' });
  await page.route('https://avatars.githubusercontent.com/**', (route) => route.fulfill({ status: 204 }));
  if (layout === 'phone') {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'PR reviews', exact: true }).click();
  }
  if (layout === 'desktop') await page.locator('#tab-prs').click();
  const status = createStatus();
  await applyStatus(page, status);
  await page.evaluate(async () => { await document.fonts.ready; });
  await verifyRows(page);
  await verifyLayout(page);
  if (layout === 'desktop') {
    await page.locator('.pr-mode-root:not([hidden]) .pr-columns').evaluate((columns) => {
      if (!(columns instanceof HTMLElement)) throw new Error('Missing queue columns');
      columns.style.setProperty('--pr-queue-width', '220px');
    });
    await verifyLayout(page);
    await page.locator('.pr-mode-root:not([hidden]) .pr-columns').evaluate((columns) => {
      if (!(columns instanceof HTMLElement)) throw new Error('Missing queue columns');
      columns.style.removeProperty('--pr-queue-width');
    });
  }
  const nitsRow = page.locator('.pr-queue-row[data-review-key="Acme/app#2"]');
  await nitsRow.focus();
  await page.keyboard.press('Enter');
  assert.equal(await nitsRow.getAttribute('aria-current'), 'true');
  assert.equal(await page.locator('.pr-detail .pr-verdict-seal').textContent(), 'Approve with nits');
  assert.equal(await page.locator('.pr-detail .pr-verdict-seal svg').count(), 1);
  assert.ok(await page.locator('.pr-detail .pr-severity-meter').count() > 0);
  const mixed = { ...status, drafts: [...status.drafts, createDraft(11, { key: 'Acme/docs#11', repo: 'Acme/docs' })] };
  await applyStatus(page, mixed);
  assert.equal(await nitsRow.locator('.pr-queue-ref').textContent(), 'Acme/app#2');
  if (layout === 'desktop') await verifyCollapsedRailShowsNumbers(page);
  const progress = { ...mixed, inFlight: mixed.inFlight.map((review) => ({ ...review, toolCalls: 2 })) };
  await applyStatus(page, progress);
  assert.equal(await page.locator('.pr-queue-row[data-review-key="Acme/app#9"] .pr-queue-ref').textContent(), 'Acme/app#9');
  await applyStatus(page, status);
  assert.equal(await nitsRow.locator('.pr-queue-ref').textContent(), '#2');
  if (layout === 'desktop') await verifyCollapsedRailShowsNumbers(page);
  await verifyUnchangedQueueKeepsRowNodes(page, status);
  await verifyQueueRebuildsAfterEmptyStatus(page, status);
  await verifyViewerThreadCounts(page, status);
  await verifyActionAdvancement(page, status);
  await verifyMyPrKeepMergeable(page);
}
