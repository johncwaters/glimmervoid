import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { GithubPr, GithubPrsFrame } from '../../shared/contracts/github-prs.ts';
import type { ServerMessage } from '../../shared/contracts/control-messages.ts';
import { MyPrsStatus } from '../../shared/contracts/my-prs.ts';
import { ReviewDraft, TeamReviewStatus } from '../../shared/contracts/team-review.ts';
import type { TeamReviewAction, TeamReviewThread } from '../../shared/contracts/team-review.ts';
import type { Layout } from './cases-core.ts';
import { verifyMyPrKeepMergeable } from './my-prs.ts';

const REVIEWED_HEAD = 'a'.repeat(40);
const PREVIOUS_HEAD = 'b'.repeat(40);

interface TeamReviewPanelModule {
  applyTeamReviewStatus(message: unknown): void;
  applyTeamReviewActionResult(message: unknown): void;
  applyOpenTeamReviewSessionResult(message: unknown): void;
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
    const panelUrl = '/github/team-review-panel.ts';
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
    glyphTone: button.querySelector('.pr-queue-glyph .pr-status-icon')?.getAttribute('data-tone'),
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

async function emitTeamReviewFrames(page: Page, messages: ServerMessage[]): Promise<void> {
  await page.evaluate(async (frames) => {
    const controlUrl = '/control-ws.ts';
    const control: { sendControlMsg(message: Record<string, unknown>): boolean } = await import(controlUrl);
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(message) {
      if (typeof message === 'string' && JSON.parse(message).requestId === 'team-review-frame-probe') {
        for (const frame of frames) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
        return;
      }
      originalSend.call(this, message);
    };
    try {
      if (!control.sendControlMsg({ type: 'ping', requestId: 'team-review-frame-probe' })) throw new Error('Control socket is not connected');
    } finally {
      WebSocket.prototype.send = originalSend;
    }
  }, messages);
}

async function verifyCanonicalTeamPrFields(page: Page, layout: Layout, snapshot: TeamReviewStatus, sessionId: string): Promise<void> {
  const timestamp = Date.now();
  const canonicalPr = GithubPr.parse({
    key: 'acme/app#1', id: 'PR_team_browser', repo: 'Acme/app', number: 1, title: 'Canonical team PR', url: 'https://github.com/Acme/app/pull/1',
    author: 'teammate', isAuthorBot: false, labels: [], commentCount: 0,
    isDraft: false, state: 'OPEN', createdAt: new Date(timestamp - 86400000).toISOString(), mergedAt: null, updatedAt: new Date(timestamp).toISOString(),
    baseRefName: 'main', baseRefOid: PREVIOUS_HEAD, headRefName: 'feature', headRefOid: REVIEWED_HEAD, isCrossRepository: false,
    isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    checks: { state: 'SUCCESS', failing: [], pendingCount: 0 }, rollupState: 'SUCCESS', unresolvedThreads: 0, threads: [], behindBy: 0,
    reviewRequests: [], approvals: 0, reviews: [], opinionatedWriterReviewStates: [],
  });
  const frameFor = (pr?: GithubPr): GithubPrsFrame => GithubPrsFrame.parse({
    type: 'github-prs', ts: timestamp, prs: pr ? { [pr.key]: pr } : {}, freshness: { lastRefreshedAt: timestamp, error: null },
  });
  const laneSnapshot = {
    ...snapshot,
    drafts: [createDraft(1, { requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED', checksState: 'SUCCESS', liveHead: REVIEWED_HEAD }), createDraft(2)],
    inFlight: [], queued: [], handReview: [],
  };
  await applyStatus(page, laneSnapshot);
  await emitTeamReviewFrames(page, [MyPrsStatus.parse({
    type: 'my-prs-status', ts: timestamp, configured: true, viewer: 'me', prs: [{ key: 'Acme/app#1' }],
  }), {
    type: 'session-prs', id: sessionId, linkedPrs: [{ repo: 'ACME/app', number: 1, url: canonicalPr.url, source: 'manual', linkedAt: timestamp }],
  }]);
  const teamRow = page.locator('.pr-queue-row[data-review-key="Acme/app#1"]');
  const fallbackRow = page.locator('.pr-queue-row[data-review-key="Acme/app#2"]');
  const mineRow = page.locator('.pr-queue-row[data-pr-key="Acme/app#1"]');
  const root = page.locator('.pr-mode-root:not([hidden])');
  assert.equal(await teamRow.locator('.pr-queue-state').textContent(), 'Waits on you');
  const updates: { pr: GithubPr; stage: string; firstKey: string }[] = [
    { pr: { ...canonicalPr, rollupState: 'PENDING', checks: { state: 'PENDING', failing: [], pendingCount: 1 } }, stage: 'Checks running', firstKey: 'Acme/app#2' },
    { pr: { ...canonicalPr, rollupState: 'FAILURE', checks: { state: 'FAILURE', failing: ['build'], pendingCount: 0 }, reviewDecision: 'CHANGES_REQUESTED' }, stage: 'Checks failing', firstKey: 'Acme/app#2' },
    { pr: { ...canonicalPr, isDraft: true }, stage: 'Draft', firstKey: 'Acme/app#2' },
    { pr: { ...canonicalPr, opinionatedWriterReviewStates: ['CHANGES_REQUESTED'] }, stage: 'Ready to merge', firstKey: 'Acme/app#2' },
    { pr: canonicalPr, stage: 'Ready to merge', firstKey: 'Acme/app#1' },
  ];
  for (const { pr, stage, firstKey } of updates) {
    await emitTeamReviewFrames(page, [frameFor(pr)]);
    assert.equal(await teamRow.locator('.pr-queue-state').textContent(), stage);
    assert.equal(await root.locator('.pr-queue-row').first().getAttribute('data-review-key'), firstKey);
    assert.equal(await fallbackRow.locator('.pr-queue-state').textContent(), 'Waits on you');
    const teamGlyph = await teamRow.locator('.pr-queue-glyph').innerHTML();
    const unchangedTeamRow = await teamRow.elementHandle();
    assert.ok(unchangedTeamRow);
    await emitTeamReviewFrames(page, [frameFor({ ...pr, commentCount: pr.commentCount + 1 })]);
    assert.equal(await unchangedTeamRow.evaluate((row) => row.isConnected), true);
    await root.getByRole('tab', { name: 'Mine', exact: true }).click();
    assert.equal(await mineRow.locator('.my-pr-stage').first().textContent(), stage);
    assert.equal(await mineRow.locator('.pr-queue-glyph').innerHTML(), teamGlyph);
    if (layout === 'phone') await page.getByRole('button', { name: 'Board', exact: true }).click();
    if (layout === 'desktop') {
      await root.locator(`.my-pr-session-pill[data-session-id="${sessionId}"]`).click();
      await page.waitForFunction(() => document.body.dataset.activeView === 'focus');
    }
    const sessionRows = layout === 'phone' ? 'section.phone-screen[data-screen="board"]' : '#focus-rail';
    const chip = page.locator(`${sessionRows} .session-row[data-id="${sessionId}"] .session-pr-chip`).filter({ hasText: '#1' });
    await chip.waitFor({ state: 'visible' });
    assert.equal(await chip.getAttribute('title'), `ACME/app: ${canonicalPr.title} (${stage}). Show in Reviews; Cmd/Ctrl-click opens GitHub`);
    assert.equal(await chip.locator('.pr-status-icon').evaluate((icon) => icon.outerHTML), await teamRow.locator('.pr-status-icon').evaluate((icon) => icon.outerHTML));
    await openReviewsView(page, layout);
    await root.getByRole('tab', { name: 'Team', exact: true }).click();
  }
  await teamRow.click();
  await applyStatus(page, { ...laneSnapshot, drafts: [createDraft(1, { status: 'stale', liveHead: REVIEWED_HEAD }), createDraft(2)] });
  const movedHead = 'c'.repeat(40);
  await emitTeamReviewFrames(page, [frameFor({ ...canonicalPr, headRefOid: movedHead })]);
  assert.equal(await page.locator('.pr-detail .pr-changed-since-link').getAttribute('href'), `https://github.com/Acme/app/compare/${REVIEWED_HEAD}...${movedHead}`);
  await emitTeamReviewFrames(page, [frameFor()]);
  assert.equal(await page.locator('.pr-detail .pr-changed-since').count(), 0);
  assert.equal(await teamRow.locator('.pr-queue-state').textContent(), 'Out of date');
  await applyStatus(page, snapshot);
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

async function verifyAnsweredThreadConversation(page: Page, snapshot: TeamReviewStatus): Promise<void> {
  const viewerComment = 'Please preserve empty input.\n<script>untrusted comment</script>\n' + 'Original concern.\n'.repeat(8);
  const replyBody = 'Added an empty input guard.\n<img src=x onerror=alert(1)>\n' + 'Reply evidence.\n'.repeat(12);
  const thread = {
    id: 'PRRT_acme_1', path: 'src/app.ts', line: 2, isResolved: false, viewerCanResolve: true,
    isNit: false, url: 'https://github.com/Acme/app/pull/1#discussion_r1',
    lastReplyAuthor: 'teammate', lastReplyAt: new Date(Date.now() - 2_400_000).toISOString(),
    viewerComment, lastReplyBody: replyBody,
    unjudgeable: { head: REVIEWED_HEAD, lastReplyAt: new Date(Date.now() - 2_400_000).toISOString(), reason: 'Too many changed files to judge' },
  };
  thread.unjudgeable.lastReplyAt = thread.lastReplyAt;
  const showThread = async (bodies: Partial<TeamReviewThread>) => {
    await applyStatus(page, { ...snapshot, drafts: [createDraft(1, { threads: [{ ...thread, ...bodies }] })], inFlight: [], queued: [] });
    await page.locator('.pr-queue-row[data-review-key="Acme/app#1"]').click();
  };
  await showThread({});
  const card = page.locator('.pr-thread-card');
  const replyPreview = card.locator('.pr-thread-message:not(.pr-thread-message-muted) > .pr-thread-preview');
  assert.equal(await replyPreview.textContent(), replyBody);
  assert.equal(await replyPreview.isVisible(), true);
  assert.equal(await card.locator('.pr-thread-message-muted > .pr-thread-preview').textContent(), viewerComment);
  assert.equal(await card.locator('.pr-thread-chip').textContent(), 'Auto-check skipped');
  assert.match(await card.textContent() ?? '', /Too many changed files to judge/);
  assert.match(await card.locator('.pr-thread-reply-meta').textContent() ?? '', /teammate replied/);
  assert.equal(await card.locator('script, img').count(), 0);
  const button = card.getByRole('button', { name: 'Resolve', exact: true });
  const geometry = await button.evaluate((control) => ({
    width: control.getBoundingClientRect().width,
    cardWidth: control.closest('.pr-thread-card')?.getBoundingClientRect().width ?? 0,
    footerRight: control.parentElement?.getBoundingClientRect().right ?? 0,
    right: control.getBoundingClientRect().right,
    statusIsSibling: control.previousElementSibling?.classList.contains('pr-action-status'),
  }));
  assert.ok(geometry.width < geometry.cardWidth / 2);
  assert.ok(Math.abs(geometry.right - geometry.footerRight) < 1);
  assert.equal(geometry.statusIsSibling, true);
  assert.equal(await card.locator('.pr-thread-continues').count(), 0);
  await card.getByText('Expand reply', { exact: true }).click();
  assert.equal(await card.locator('.pr-thread-message:not(.pr-thread-message-muted) details').getAttribute('open'), '');
  assert.equal(await replyPreview.isVisible(), false);
  assert.equal(await card.locator('.pr-thread-message:not(.pr-thread-message-muted) details > .pr-thread-body').textContent(), replyBody);
  await card.getByText('Expand comment', { exact: true }).click();
  assert.equal(await card.locator('.pr-thread-message-muted details > .pr-thread-body').isVisible(), true);
  await showThread({ viewerComment: undefined, lastReplyBody: undefined });
  assert.equal(await card.locator('.pr-thread-message').count(), 0);
  assert.equal(await button.isVisible(), true);
  await showThread({ viewerComment: 'Short comment', lastReplyBody: 'Short reply' });
  assert.equal(await card.locator('.pr-thread-disclosure').count(), 0);
  assert.equal(await replyPreview.textContent(), 'Short reply');
  await showThread({ lastReplyTruncated: true });
  const continuation = card.locator('.pr-thread-message:not(.pr-thread-message-muted) .pr-thread-continues');
  await card.getByText('Expand reply', { exact: true }).click();
  assert.equal(await continuation.textContent(), 'Reply continues on GitHub');
  assert.equal(await continuation.getAttribute('href'), thread.url);
  assert.equal(await continuation.isVisible(), true);
  assert.equal(await card.locator('.pr-thread-message-muted .pr-thread-continues').count(), 0);
  await verifyThreadDisclosureAfterHiddenRebuild(page, snapshot, thread);
  await applyStatus(page, snapshot);
}

async function verifyThreadDisclosureAfterHiddenRebuild(page: Page, snapshot: TeamReviewStatus, thread: TeamReviewThread): Promise<void> {
  const setTeamRootHidden = (isHidden: boolean) => page.locator('.pr-queue-row[data-review-key="Acme/app#1"]').evaluate((row, hidden) => {
    const teamRoot = row.closest('.pr-mode-root');
    if (teamRoot instanceof HTMLElement) teamRoot.hidden = hidden;
  }, isHidden);
  const longReply = 'Rebuilt while hidden.\n' + 'Hidden reply evidence.\n'.repeat(12);
  await setTeamRootHidden(true);
  await applyStatus(page, { ...snapshot, drafts: [createDraft(1, { threads: [{ ...thread, lastReplyBody: longReply, lastReplyTruncated: undefined }] })], inFlight: [], queued: [] });
  assert.equal(await page.locator('.pr-thread-card').isVisible(), false);
  await setTeamRootHidden(false);
  const replyMessage = page.locator('.pr-thread-card .pr-thread-message:not(.pr-thread-message-muted)');
  const expand = replyMessage.getByText('Expand reply', { exact: true });
  assert.equal(await expand.isVisible(), true);
  await expand.click();
  assert.equal(await replyMessage.locator('details > .pr-thread-body').isVisible(), true);
  assert.equal(await replyMessage.locator('details > .pr-thread-body').textContent(), longReply);
}

interface ActionCaptureWindow extends Window {
  teamReviewOriginalSend?: WebSocket['send'];
}

async function replyToCapturedAction(page: Page, ok: boolean, warning?: string): Promise<void> {
  await page.evaluate(async ({ isOk, warning }) => {
    const requestText = document.documentElement.dataset.teamReviewAction;
    if (!requestText) throw new Error('No review action was sent');
    const request = JSON.parse(requestText) as { key: string; requestId: string };
    const panelUrl = '/github/team-review-panel.ts';
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
    for (const unreviewed of [9, 10]) {
      await applyStatus(page, { ...withDrafts([createDraft(1), createDraft(2)]), inFlight: snapshot.inFlight, queued: snapshot.queued });
      await reviewRow(unreviewed).click();
      assert.equal(await page.locator('.pr-detail button[data-action="discard"]').textContent(), 'Not mine');
      await clickReviewAction(page, 'discard');
      const sentRequest = JSON.parse(await page.evaluate(() => document.documentElement.dataset.teamReviewAction ?? '{}')) as { key?: string; action?: string; head?: string };
      assert.deepEqual([sentRequest.key, sentRequest.action, sentRequest.head], [`Acme/app#${unreviewed}`, 'discard', undefined]);
      await applyStatus(page, withDrafts([createDraft(1), createDraft(2), createDraft(unreviewed, { status: 'discarded' })]));
      await replyToCapturedAction(page, true);
      assert.equal(await reviewRow(1).getAttribute('aria-current'), 'true');
      assert.equal(await actionNotice.isVisible(), false);
      assert.equal(await page.locator('.pr-queue-section', { has: reviewRow(unreviewed) }).locator('.pr-section-heading').textContent(), 'Not mine 1');
    }
    for (const action of ['approve', 'approve-only', 'comment', 'discard', 'requeue'] as const) {
      await applyStatus(page, withDrafts([createDraft(1), createDraft(2), createDraft(3)]));
      await reviewRow(1).click();
      await clickReviewAction(page, action);
      await applyStatus(page, { ...withDrafts([createDraft(3, { requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED' }), createDraft(2), createDraft(1, { status: action === 'discard' ? 'discarded' : 'posted' })]), queued: action === 'requeue' ? [createDraft(1)] : [] });
      assert.equal(await reviewRow(1).getAttribute('aria-current'), 'true');
      await replyToCapturedAction(page, true);
      assert.equal(await reviewRow(2).getAttribute('aria-current'), 'true');
      assert.equal(await actionNotice.isVisible(), false);
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
    assert.equal(await page.locator('.pr-detail .pr-footer > .pr-action-status').textContent(), 'Action rejected');
    await clickReviewAction(page, 'approve');
    await applyStatus(page, withDrafts([createDraft(1, { status: 'posted' }), createDraft(2, { status: 'discarded' })]));
    await replyToCapturedAction(page, true);
    assert.equal(await page.locator('.pr-queue-row[aria-current="true"]').count(), 0);
    assert.equal(await caughtUpTitle.textContent(), 'All caught up');
    assert.equal(await actionNotice.isVisible(), false);
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

async function openReviewsView(page: Page, layout: Layout): Promise<void> {
  if (layout === 'phone') {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  }
  if (layout === 'desktop') await page.locator('#tab-prs').click();
}

async function replyToSessionOpen(page: Page, reply: { ok: boolean; sessionId?: string; sessionName?: string; error?: string }): Promise<{ key: string; type: string }> {
  return page.evaluate(async (outcome) => {
    const requestText = document.documentElement.dataset.teamReviewSessionOpen;
    if (!requestText) throw new Error('No open-team-review-session request was sent');
    const request = JSON.parse(requestText) as { key: string; requestId: string; type: string };
    delete document.documentElement.dataset.teamReviewSessionOpen;
    const panelUrl = '/github/team-review-panel.ts';
    const panel: TeamReviewPanelModule = await import(panelUrl);
    panel.applyOpenTeamReviewSessionResult({ type: 'open-team-review-session-result', requestId: request.requestId, key: request.key, ...outcome });
    return { key: request.key, type: request.type };
  }, reply);
}

async function verifyOpenInSession(page: Page, layout: Layout, snapshot: TeamReviewStatus, sessionId: string): Promise<void> {
  await page.evaluate(() => {
    const captureWindow = window as ActionCaptureWindow;
    const originalSend = WebSocket.prototype.send;
    captureWindow.teamReviewOriginalSend = originalSend;
    WebSocket.prototype.send = function(message) {
      if (typeof message === 'string' && (JSON.parse(message) as { type?: string }).type === 'open-team-review-session') {
        document.documentElement.dataset.teamReviewSessionOpen = message;
        return;
      }
      originalSend.call(this, message);
    };
  });
  try {
    for (const number of [1, 10]) {
      await applyStatus(page, snapshot);
      await page.locator(`.pr-queue-row[data-review-key="Acme/app#${number}"]`).click();
      const openButton = page.locator('.pr-detail .pr-session-open-button');
      const openStatus = page.locator('.pr-detail .pr-session-open-status');
      assert.equal(await openButton.textContent(), 'Open in session');
      await openButton.click();
      assert.equal(await openButton.textContent(), 'Open in session');
      assert.equal(await openButton.isDisabled(), true);
      assert.equal(await openStatus.textContent(), 'Preparing the branch and session.');
      assert.deepEqual(await replyToSessionOpen(page, { ok: false, error: 'Could not fetch branch feature' }), { key: `Acme/app#${number}`, type: 'open-team-review-session' });
      assert.equal(await openStatus.textContent(), 'Could not fetch branch feature');
      assert.equal(await openButton.isDisabled(), false);
      await openButton.click();
      await replyToSessionOpen(page, { ok: true, sessionId, sessionName: 'pr-app-1' });
      if (layout === 'phone') await page.locator('section.phone-screen[data-screen="terminal"]').waitFor({ state: 'visible' });
      if (layout === 'desktop') await page.waitForFunction(() => document.body.dataset.activeView === 'focus');
      await openReviewsView(page, layout);
    }
  } finally {
    await page.evaluate(() => {
      const captureWindow = window as ActionCaptureWindow;
      if (captureWindow.teamReviewOriginalSend) WebSocket.prototype.send = captureWindow.teamReviewOriginalSend;
      delete captureWindow.teamReviewOriginalSend;
    });
  }
}

export async function verifyTeamReviewRows(page: Page, layout: Layout, sessionId: string): Promise<void> {
  await page.locator('#loading-screen').waitFor({ state: 'hidden' });
  await page.route('https://avatars.githubusercontent.com/**', (route) => route.fulfill({ status: 204 }));
  await openReviewsView(page, layout);
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
  await verifyAnsweredThreadConversation(page, status);
  await verifyOpenInSession(page, layout, status, sessionId);
  await verifyCanonicalTeamPrFields(page, layout, status, sessionId);
  await verifyActionAdvancement(page, status);
  await verifyMyPrKeepMergeable(page);
}
