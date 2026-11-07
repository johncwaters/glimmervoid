import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright-core';
import { GithubPr, GithubPrsFrame } from '../../shared/contracts/github-prs.ts';
import type { ServerMessage } from '../../shared/contracts/control-messages.ts';
import { MyPrsStatus } from '../../shared/contracts/my-prs.ts';
import { ReviewDraft, TeamReviewStatus } from '../../shared/contracts/team-review.ts';
import type { TeamReviewAction, TeamReviewThread } from '../../shared/contracts/team-review.ts';
import type { Layout } from './cases-core.ts';
import { shortcutPlatformFor } from '../../public/shortcuts-core.ts';
import { showQueue, verifyMyPrKeepMergeable } from './my-prs.ts';

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
    reviewedHead: REVIEWED_HEAD, verdict: 'APPROVE', summary: 'Fine', body: '- **[logic] MEDIUM** Fine', comments: [], status: 'ready',
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
      createDraft(3, {
        verdict: 'REQUEST CHANGES',
        assessment: { goal: 'Fix the header.', change: 'Moves the header.', checked: [], gaps: [], handChecks: [{ text: 'Look at what these changed UI files render', paths: ['public/header.css'], isFallback: true }] },
        earlierReview: { head: PREVIOUS_HEAD, verdict: 'APPROVE', summary: 'Earlier pass', wasPosted: true, comments: [] },
      }),
      createDraft(4, { verdict: 'BLOCKED' }),
      createDraft(5, { status: 'error', error: 'Review timed out' }),
      createDraft(6, { status: 'discarded' }),
      createDraft(7, { status: 'posted', postedAt: Date.now() - 600_000, isAuthorOrgMember: true }),
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

async function readRowMeaning(row: Locator): Promise<string | undefined> {
  const [, meaningWithoutGoal] = (await row.getAttribute('aria-label') ?? '').split('\n');
  return meaningWithoutGoal;
}

async function applyStatus(page: Page, status: TeamReviewStatus): Promise<void> {
  await page.evaluate(async (snapshot) => {
    const panelUrl = '/github/team-review-store.ts';
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
    findings: button.querySelector('.pr-queue-findings')?.textContent,
    actionWords: button.querySelectorAll('.review-queue-action').length,
    glyphTone: button.querySelector('.pr-queue-glyph .pr-status-icon')?.getAttribute('data-tone'),
    authorAvatars: button.querySelectorAll('.pr-queue-author .avatar').length,
    reviewerAvatars: button.querySelectorAll('.pr-queue-reviewers .avatar').length,
    title: button.getAttribute('title'),
    accessibleName: button.getAttribute('aria-label'),
    children: button.querySelectorAll(':scope > :not(.pr-queue-unseen)').length,
    removedParts: button.querySelectorAll('.pr-verdict-seal, .pr-severity-meter, .pr-rereview-tag').length,
  })));
  assert.equal(rows.length, 10);
  const skillHint = await page.locator('.review-skill-notice-hint').evaluate((hint) => ({ text: hint.textContent, href: hint.querySelector('a')?.getAttribute('href') }));
  assert.equal(skillHint.text, 'The instructions the reviewing agent follows. Reviews run without one. Review skill setting');
  assert.match(skillHint.href ?? '', /#settings\/lanes-team-review\/team-review-skill$/);
  for (const row of rows) {
    assert.equal(row.removedParts, 0);
    assert.equal(row.actionWords, 0);
    const isDiscardedRow = row.key === 'Acme/app#6';
    assert.equal(row.children, isDiscardedRow ? 1 : 3);
    assert.equal(row.authorAvatars, isDiscardedRow ? 0 : 1);
    assert.equal(row.title, null);
    assert.equal(row.ref, row.key?.replace('Acme/app', ''));
    assert.equal(row.stateTone, row.glyphTone);
    assert.equal(Boolean(row.stateWord), !isDiscardedRow);
  }
  const nits = rows.find((row) => row.key === 'Acme/app#2');
  assert.ok(nits);
  assert.equal(nits.stateWord, 'Approve');
  assert.equal(nits.findings, `${String.fromCharCode(0xb7)} 1 finding`);
  assert.doesNotMatch(nits.bottom ?? '', /since approval|drafted|resolved|Nits|Changes|Blocked/);
  assert.match(nits.accessibleName ?? '', /Acme\/app#2:.*\nWaits on you\n/s);
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
    author: 'teammate', isAuthorBot: false, isAuthorOrgMember: false, labels: [], commentCount: 0,
    isDraft: false, state: 'OPEN', createdAt: new Date(timestamp - 86400000).toISOString(), mergedAt: null, updatedAt: new Date(timestamp).toISOString(),
    baseRefName: 'main', baseRefOid: PREVIOUS_HEAD, headRefName: 'feature', headRefOid: REVIEWED_HEAD, isCrossRepository: false,
    isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    checks: { state: 'SUCCESS', failing: [], pendingCount: 0 }, rollupState: 'SUCCESS', unresolvedThreads: 0, threads: [], behindBy: 0,
    reviewRequests: [], approvals: 0, reviews: [], opinionatedWriterReviewStates: [], reviewItems: [],
  });
  const frameFor = (pr?: GithubPr): GithubPrsFrame => GithubPrsFrame.parse({
    type: 'github-prs', ts: timestamp, prs: pr ? { [pr.key]: pr } : {}, freshness: { lastRefreshedAt: timestamp, error: null },
  });
  const laneSnapshot = {
    ...snapshot,
    drafts: [createDraft(1, { requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED', checksState: 'SUCCESS', liveHead: REVIEWED_HEAD }), createDraft(2)],
    inFlight: [], queued: [],
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
  const root = page.locator('.review-queue');
  assert.equal(await readRowMeaning(teamRow), 'Waits on you');
  const updates: { pr: GithubPr; stage: string; firstKey: string }[] = [
    { pr: { ...canonicalPr, rollupState: 'PENDING', checks: { state: 'PENDING', failing: [], pendingCount: 1 } }, stage: 'Checks running', firstKey: 'Acme/app#2' },
    { pr: { ...canonicalPr, rollupState: 'FAILURE', checks: { state: 'FAILURE', failing: ['build'], pendingCount: 0 }, reviewDecision: 'CHANGES_REQUESTED' }, stage: 'Checks failing', firstKey: 'Acme/app#2' },
    { pr: { ...canonicalPr, isDraft: true }, stage: 'Draft', firstKey: 'Acme/app#2' },
    { pr: { ...canonicalPr, opinionatedWriterReviewStates: ['CHANGES_REQUESTED'] }, stage: 'Ready to merge', firstKey: 'Acme/app#2' },
    { pr: canonicalPr, stage: 'Ready to merge', firstKey: 'Acme/app#1' },
  ];
  for (const { pr, stage, firstKey } of updates) {
    await emitTeamReviewFrames(page, [frameFor(pr)]);
    assert.equal(await readRowMeaning(teamRow), stage);
    assert.equal(await root.locator('.pr-queue-row').first().getAttribute('data-review-key'), firstKey);
    assert.equal(await readRowMeaning(fallbackRow), 'Waits on you');
    assert.equal(await teamRow.locator('.author-org-tag').textContent(), 'external');
    assert.equal(await fallbackRow.locator('.author-org-tag').count(), 0);
    await emitTeamReviewFrames(page, [frameFor({ ...pr, isAuthorOrgMember: true })]);
    assert.equal(await teamRow.locator('.author-org-tag').textContent(), 'Acme');
    assert.notEqual(await teamRow.locator('.author-org-tag').evaluate((tag) => getComputedStyle(tag).display), 'none');
    await emitTeamReviewFrames(page, [frameFor(pr)]);
    const teamGlyph = await teamRow.locator('.pr-queue-glyph').innerHTML();
    const teamIcon = await teamRow.locator('.pr-status-icon').evaluate((icon) => icon.outerHTML);
    const unchangedTeamRow = await teamRow.elementHandle();
    assert.ok(unchangedTeamRow);
    await emitTeamReviewFrames(page, [frameFor({ ...pr, commentCount: pr.commentCount + 1 })]);
    assert.equal(await unchangedTeamRow.evaluate((row) => row.isConnected), true);
    await showQueue(page);
    assert.equal(await mineRow.locator('.my-pr-stage').first().textContent(), stage);
    assert.equal(await mineRow.locator('.pr-queue-glyph').innerHTML(), teamGlyph);
    if (layout === 'phone') await page.getByRole('button', { name: 'Focus', exact: true }).click();
    if (layout === 'desktop') {
      await root.locator(`.my-pr-session-pill[data-session-id="${sessionId}"]`).click();
      await page.waitForFunction(() => document.body.dataset.activeView === 'focus');
    }
    const sessionRows = layout === 'phone' ? 'section.phone-screen[data-screen="board"]' : '#focus-rail';
    const chip = page.locator(`${sessionRows} .session-row[data-id="${sessionId}"] .session-pr-chip`).filter({ hasText: '#1' });
    await chip.waitFor({ state: 'visible' });
    assert.equal(await chip.getAttribute('title'), null);
    assert.equal(await chip.locator('.pr-status-icon').evaluate((icon) => icon.outerHTML), teamIcon);
    await openReviewsView(page, layout);
    await showQueue(page);
  }
  await showQueue(page);
  await teamRow.click();
  await applyStatus(page, { ...laneSnapshot, drafts: [createDraft(1, { status: 'stale', liveHead: REVIEWED_HEAD }), createDraft(2)] });
  const movedHead = 'c'.repeat(40);
  await emitTeamReviewFrames(page, [frameFor({ ...canonicalPr, headRefOid: movedHead })]);
  assert.equal(await page.locator('.pr-detail .pr-changed-since-link').getAttribute('href'), `https://github.com/Acme/app/compare/${REVIEWED_HEAD}...${movedHead}`);
  assert.match(await page.locator('.pr-detail .pr-changed-since').first().textContent() ?? '', /^The pull request has new commits since this review\. Compare changes/);
  await emitTeamReviewFrames(page, [frameFor()]);
  assert.equal(await page.locator('.pr-detail .pr-changed-since').count(), 0);
  assert.equal(await readRowMeaning(teamRow), 'Out of date');
  await applyStatus(page, snapshot);
}

async function verifyPhoneDetailScreen(page: Page, status: TeamReviewStatus): Promise<void> {
  await applyStatus(page, status);
  await showQueue(page);
  const root = page.locator('.review-queue');
  const pane = root.locator('.pr-queue-pane');
  await page.locator('.pr-queue-row[data-review-key="Acme/app#1"]').click();
  assert.equal(await root.getAttribute('data-detail-open'), 'true');
  assert.equal(await pane.isVisible(), false);
  assert.match(await root.locator('.review-queue-position').textContent() ?? '', /^2 of \d+ in Ready$/);
  const barBox = await root.locator('.pr-decision-bar').boundingBox();
  const navBox = await page.locator('.phone-nav').boundingBox();
  assert.ok(barBox && navBox && barBox.y + barBox.height <= navBox.y + 1);
  const buttonRows = await root.locator('.pr-decision-bar > button').evaluateAll((buttons) => new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size);
  assert.equal(buttonRows, 3);
  await page.goBack();
  await pane.waitFor({ state: 'visible' });
  assert.equal(await root.getAttribute('data-detail-open'), 'false');
  assert.ok(await root.isVisible());
  await page.locator('.pr-queue-row[data-review-key="Acme/app#1"]').click();
  await root.locator('[data-action="back-to-queue"]').click();
  await pane.waitFor({ state: 'visible' });
}

async function verifyDecisionBarPinned(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  assert.ok(viewport);
  await page.setViewportSize({ width: viewport.width, height: 2400 });
  const hostBox = await page.locator('.review-queue .pr-detail-host').boundingBox();
  const barBox = await page.locator('.pr-detail .pr-decision-bar').boundingBox();
  await page.setViewportSize(viewport);
  assert.ok(hostBox && barBox && Math.abs(hostBox.y + hostBox.height - (barBox.y + barBox.height)) <= 1);
}

async function readInReviewElapsedTexts(page: Page): Promise<{ row: string | null; detail: string | null }> {
  return page.evaluate(() => ({
    row: document.querySelector('.pr-queue-row[data-review-key="Acme/app#9"] .pr-queue-elapsed')?.textContent ?? null,
    detail: document.querySelector('.pr-detail .pr-progress-text')?.textContent ?? null,
  }));
}

async function verifyUnchangedQueueKeepsRowNodes(page: Page, status: TeamReviewStatus): Promise<void> {
  await showQueue(page);
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
  const threadsFact = () => page.locator('.pr-detail .pr-desk-facts .pr-fact').filter({ has: page.locator('dt', { hasText: 'Threads' }) }).locator('dd').or(page.locator('.pr-detail-heading .pr-viewer-threads'));
  const review = createDraft(1, {
    viewerThreads: { total: 5, resolved: 2 },
    comments: [{ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'Drafted finding.' }],
    githubReviews: [{ login: 'me', state: 'COMMENTED', commit: REVIEWED_HEAD, isViewer: true }],
  });
  const withDraft = (draft: ReviewDraft) => ({ ...snapshot, drafts: [draft], inFlight: [], queued: [] });
  await applyStatus(page, withDraft(review));
  const row = page.locator('.pr-queue-row[data-review-key="Acme/app#1"]');
  assert.doesNotMatch(await row.locator('.pr-queue-bottom').textContent() ?? '', /drafted|resolved/);
  assert.match(await row.getAttribute('aria-label') ?? '', /2 of 5 of your comments resolved/);
  const sectionHeading = () => row.evaluate((element) => element.closest('.pr-queue-section')?.querySelector('.pr-section-heading')?.textContent);
  assert.match(await sectionHeading() ?? '', /Done/);
  await showQueue(page);
  await row.click();
  assert.equal(await threadsFact().textContent(), '2 of 5 of your comments resolved');
  const resolved = { ...review, viewerThreads: { total: 5, resolved: 5 } };
  await applyStatus(page, withDraft(resolved));
  assert.doesNotMatch(await sectionHeading() ?? '', /Done/);
  assert.equal(await readRowMeaning(row), 'Comments resolved');
  assert.equal(await threadsFact().textContent(), 'All 5 of your comments resolved');
  assert.match(await row.getAttribute('aria-label') ?? '', /All 5 of your comments resolved/);
  await applyStatus(page, withDraft({ ...resolved, viewerThreads: { total: 5, resolved: 3 } }));
  assert.equal(await threadsFact().textContent(), '3 of 5 of your comments resolved');
  await applyStatus(page, withDraft({ ...resolved, reviewDecision: 'APPROVED', githubReviews: [{ login: 'me', state: 'APPROVED', commit: REVIEWED_HEAD, isViewer: true }] }));
  assert.match(await sectionHeading() ?? '', /Done/);
  await applyStatus(page, withDraft({ ...resolved, status: 'posted', postedEvent: 'COMMENT', postedAt: Date.now() }));
  assert.match(await sectionHeading() ?? '', /Ready/);
  assert.equal(await readRowMeaning(row), 'Comments resolved');
  await showQueue(page);
  await row.click();
  assert.equal(await threadsFact().textContent(), 'All 5 of your comments resolved');
  await applyStatus(page, withDraft({ ...review, status: 'posted', postedEvent: 'COMMENT', postedAt: Date.now() }));
  assert.match(await sectionHeading() ?? '', /Waiting on others/);
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
    await showQueue(page);
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
    const teamRoot = row.closest('.review-queue');
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
    const panelUrl = '/github/team-review-store.ts';
    const panel: TeamReviewPanelModule = await import(panelUrl);
    panel.applyTeamReviewActionResult({ type: 'team-review-action-result', key: request.key, requestId: request.requestId, ok: isOk, error: isOk ? undefined : 'Action rejected', warning });
    delete document.documentElement.dataset.teamReviewAction;
  }, { isOk: ok, warning });
}

async function clickReviewAction(page: Page, action: TeamReviewAction): Promise<void> {
  const control = page.locator(`.pr-detail button[data-action="${action}"]`);
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
  const barStatus = page.locator('.pr-detail .pr-decision-bar > .pr-action-status');
  const willPostDetail = page.locator('.pr-detail .pr-will-post-detail');
  const postCheckbox = page.locator('.pr-detail').getByRole('checkbox', { name: 'Post', exact: true });
  const caughtUpTitle = page.locator('.pr-detail-host .pr-caught-up-title');
  const caughtUpDetailText = page.locator('.pr-detail-host .pr-caught-up-detail');
  try {
    const sentActionName = async () => (JSON.parse(await page.evaluate(() => document.documentElement.dataset.teamReviewAction ?? '{}')) as { action?: string }).action;
    const pickedActions = () => page.locator('.pr-detail .pr-decision-bar > button[aria-pressed="true"]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-action')));
    await applyStatus(page, withDrafts([createDraft(1, { summary: 'Keyed' }), createDraft(2), createDraft(3)]));
    await showQueue(page);
    await reviewRow(1).click();
    await page.keyboard.press('j');
    assert.equal(await reviewRow(2).getAttribute('aria-current'), 'true');
    await page.keyboard.press('k');
    assert.equal(await reviewRow(1).getAttribute('aria-current'), 'true');
    await page.keyboard.press('n');
    const currentFinding = page.locator('.pr-detail .pr-comment-card[data-current="true"]');
    assert.equal(await currentFinding.count(), 1);
    const currentFindingBody = currentFinding.locator('details.pr-comment-content');
    await page.keyboard.press('Enter');
    assert.equal(await currentFindingBody.evaluate((details) => (details as HTMLDetailsElement).open), true);
    await page.keyboard.press(' ');
    assert.equal(await currentFindingBody.evaluate((details) => (details as HTMLDetailsElement).open), false);
    await page.keyboard.press('x');
    assert.equal(await currentFinding.getAttribute('data-included'), 'false');
    assert.match(await willPostDetail.textContent() ?? '', /^At [0-9a-f]+\.$/);
    await page.keyboard.press('x');
    assert.equal(await currentFinding.getAttribute('data-included'), 'true');
    await page.keyboard.press('c');
    assert.deepEqual(await pickedActions(), ['comment']);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('pr-note-input')), true);
    assert.equal(await barStatus.textContent(), '');
    assert.match(await page.locator('.pr-detail .pr-note [role="status"]').textContent() ?? '', /^Comment selected\. (Cmd|Ctrl)\+Enter posts, Esc cancels\.$/);
    assert.match(await page.locator('.pr-detail .pr-note .pr-finding-keys').textContent() ?? '', /^(Cmd|Ctrl)\+Enter posts/);
    await page.keyboard.type('a');
    assert.deepEqual(await pickedActions(), ['comment']);
    assert.equal(await sentActionName(), undefined);
    await page.keyboard.press('Escape');
    assert.deepEqual(await pickedActions(), []);
    assert.equal(await barStatus.textContent(), '');
    await page.keyboard.press('ControlOrMeta+Enter');
    assert.equal(await sentActionName(), 'approve');
    await replyToCapturedAction(page, false);
    await showQueue(page);
    await reviewRow(1).click();
    await page.keyboard.press('r');
    assert.deepEqual(await pickedActions(), ['request-changes']);
    assert.equal(await sentActionName(), undefined);
    await page.keyboard.press('ControlOrMeta+Enter');
    assert.equal(await sentActionName(), 'request-changes');
    await replyToCapturedAction(page, false);
    for (const unreviewed of [9, 10]) {
      await applyStatus(page, { ...withDrafts([createDraft(1), createDraft(2)]), inFlight: snapshot.inFlight, queued: snapshot.queued });
      await showQueue(page);
      await reviewRow(unreviewed).click();
      assert.equal(await page.locator('.pr-detail button[data-action="discard"]').textContent(), 'Not mine');
      await clickReviewAction(page, 'discard');
      const sentRequest = JSON.parse(await page.evaluate(() => document.documentElement.dataset.teamReviewAction ?? '{}')) as { key?: string; action?: string; head?: string };
      assert.deepEqual([sentRequest.key, sentRequest.action, sentRequest.head], [`Acme/app#${unreviewed}`, 'discard', undefined]);
      await applyStatus(page, withDrafts([createDraft(1), createDraft(2), createDraft(unreviewed, { status: 'discarded' })]));
      await replyToCapturedAction(page, true);
      assert.equal(await reviewRow(1).getAttribute('aria-current'), 'true');
      assert.equal(await barStatus.textContent(), '');
      assert.match(await page.locator('.pr-queue-section', { has: reviewRow(unreviewed) }).locator('.pr-section-heading').textContent() ?? '', /Parked/);
    }
    const postReceipts: Partial<Record<TeamReviewAction, string>> = { approve: 'Posted to Acme/app#1: Approved on GitHub with 1 finding.', comment: 'Posted to Acme/app#1: Commented on GitHub with 1 finding.', 'request-changes': 'Posted to Acme/app#1: Requested changes on GitHub with 1 finding.' };
    for (const action of ['approve', 'comment', 'request-changes', 'discard', 'requeue'] as const) {
      await applyStatus(page, withDrafts([createDraft(1), createDraft(2), createDraft(3)]));
      await showQueue(page);
      await reviewRow(1).click();
      await clickReviewAction(page, action);
      const sentAction = (JSON.parse(await page.evaluate(() => document.documentElement.dataset.teamReviewAction ?? '{}')) as { action?: string }).action;
      assert.equal(sentAction, action);
      await applyStatus(page, { ...withDrafts([createDraft(3, { requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED' }), createDraft(2), createDraft(1, { status: action === 'discard' ? 'discarded' : 'posted' })]), queued: action === 'requeue' ? [createDraft(1)] : [] });
      assert.equal(await reviewRow(1).getAttribute('aria-current'), 'true');
      await replyToCapturedAction(page, true);
      assert.equal(await reviewRow(2).getAttribute('aria-current'), 'true');
      assert.equal(await page.locator('.pr-detail-host .pr-action-notice').count(), 0);
      assert.equal(await barStatus.textContent(), postReceipts[action] ?? '');
      assert.equal(await reviewRow(1).getAttribute('data-just-acted'), 'true');
    }
    await applyStatus(page, withDrafts([createDraft(1), createDraft(2), createDraft(3)]));
    await showQueue(page);
    await reviewRow(1).click();
    assert.match(await willPostDetail.textContent() ?? '', /^1 in the review body, at /);
    await postCheckbox.click();
    assert.equal(await postCheckbox.isChecked(), false);
    await page.keyboard.press('x');
    assert.equal(await postCheckbox.isChecked(), true);
    await page.keyboard.press('x');
    assert.equal(await postCheckbox.isChecked(), false);
    assert.match(await willPostDetail.textContent() ?? '', /^At [0-9a-f]+\.$/);
    assert.equal(await page.locator('.pr-detail button[data-action="comment"]').isDisabled(), true);
    await clickReviewAction(page, 'approve');
    assert.equal((JSON.parse(await page.evaluate(() => document.documentElement.dataset.teamReviewAction ?? '{}')) as { action?: string }).action, 'approve-only');
    await replyToCapturedAction(page, false);
    await postCheckbox.click();
    await showQueue(page);
    await reviewRow(3).click();
    assert.equal(await barStatus.textContent(), '');
    await applyStatus(page, withDrafts([createDraft(1), createDraft(2), createDraft(3)]));
    await showQueue(page);
    await reviewRow(1).click();
    await clickReviewAction(page, 'approve');
    await applyStatus(page, withDrafts([createDraft(1, { status: 'posted' }), createDraft(2), createDraft(3)]));
    await replyToCapturedAction(page, true, 'Could not confirm the pull request head after approving. Check the approval on GitHub');
    assert.equal(await reviewRow(1).getAttribute('aria-current'), 'true');
    assert.equal(await barStatus.textContent(), 'Approved on GitHub with 1 finding. Could not confirm the pull request head after approving. Check the approval on GitHub.');
    assert.equal(await barStatus.getAttribute('data-tone'), 'error');
    const warning = 'Could not confirm the pull request head after approving. Check the approval on GitHub';
    await applyStatus(page, withDrafts([createDraft(1, { summary: 'Warned while away' }), createDraft(2), createDraft(3)]));
    await showQueue(page);
    await reviewRow(2).click();
    await showQueue(page);
    await reviewRow(1).click();
    await clickReviewAction(page, 'approve');
    await showQueue(page);
    await reviewRow(2).click();
    await applyStatus(page, withDrafts([createDraft(1, { status: 'posted' }), createDraft(2), createDraft(3)]));
    await replyToCapturedAction(page, true, warning);
    assert.equal(await barStatus.textContent(), `Acme/app#1: Approved on GitHub with 1 finding. ${warning}.`);
    await showQueue(page);
    await reviewRow(1).click();
    assert.equal(await barStatus.textContent(), `Approved on GitHub with 1 finding. ${warning}.`);
    await applyStatus(page, withDrafts([createDraft(1, { verdict: 'BLOCKED', summary: 'Re-reviewed' }), createDraft(2), createDraft(3)]));
    assert.equal(await page.locator('.pr-detail .pr-verdict-recommendation').count(), 0);
    const decisionButtons = await page.locator('.pr-detail .pr-decision-bar > button').evaluateAll((buttons) => buttons.map((button) => [button.getAttribute('data-action'), button.getAttribute('data-variant')]));
    assert.deepEqual(decisionButtons, [['approve', 'secondary'], ['comment', 'secondary'], ['request-changes', 'primary'], ['requeue', 'quiet'], ['discard', 'quiet']]);
    assert.equal(await page.locator('.pr-detail [data-action="open-session"]').getAttribute('data-variant'), 'secondary');
    assert.equal(await page.locator('.pr-detail button[data-action="approve"]').isDisabled(), false);
    await applyStatus(page, withDrafts([createDraft(4, { status: 'posted', threads: [{
      id: 'PRRT_acme_4', path: 'src/app.ts', line: 2, isResolved: false, viewerCanResolve: true,
      isNit: false, url: 'https://github.com/Acme/app/pull/4#discussion_r4',
      lastReplyAuthor: 'teammate', lastReplyAt: '2026-10-01T12:00:00Z',
    }] }), createDraft(2)]));
    await showQueue(page);
    await reviewRow(4).click();
    await page.locator('.pr-detail').getByRole('button', { name: 'Resolve', exact: true }).click();
    await replyToCapturedAction(page, true);
    assert.equal(await reviewRow(4).getAttribute('aria-current'), 'true');
    await applyStatus(page, withDrafts([createDraft(1), createDraft(2), createDraft(3)]));
    await showQueue(page);
    await reviewRow(1).click();
    await clickReviewAction(page, 'approve');
    await showQueue(page);
    await reviewRow(3).click();
    await replyToCapturedAction(page, true);
    assert.equal(await reviewRow(3).getAttribute('aria-current'), 'true');
    await applyStatus(page, withDrafts([createDraft(1, { summary: 'A fresh draft' }), createDraft(2)]));
    await showQueue(page);
    await reviewRow(1).click();
    await clickReviewAction(page, 'approve');
    await replyToCapturedAction(page, false);
    assert.equal(await reviewRow(1).getAttribute('aria-current'), 'true');
    assert.equal(await barStatus.textContent(), 'Action rejected');
    await clickReviewAction(page, 'approve');
    await applyStatus(page, withDrafts([createDraft(1, { status: 'posted' }), createDraft(2, { status: 'discarded' })]));
    await replyToCapturedAction(page, true);
    assert.equal(await page.locator('.pr-queue-row[aria-current="true"]').count(), 0);
    assert.equal(await caughtUpTitle.textContent(), 'All caught up');
    assert.match(await caughtUpDetailText.textContent() ?? '', /^Posted to Acme\/app#1: Approved on GitHub with 1 finding\. /);
    await applyStatus(page, withDrafts([createDraft(1, { status: 'posted' }), createDraft(2, { status: 'discarded' }), createDraft(12)]));
    assert.equal(await caughtUpTitle.textContent(), 'New pull requests need you');
    await applyStatus(page, withDrafts([createDraft(1, { status: 'posted' }), createDraft(2)]));
    assert.equal(await page.locator('.pr-queue-row[aria-current="true"]').count(), 0);
    assert.equal(await caughtUpTitle.textContent(), 'New pull requests need you');
    assert.match(await caughtUpDetailText.textContent() ?? '', /^Posted to Acme\/app#1: .* Pick one from the queue\.$/);
    await showQueue(page);
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
    await showQueue(page);
    await reviewRow(1).click();
  }
}

async function storedReviewsLayout(page: Page): Promise<unknown> {
  return page.evaluate(() => (JSON.parse(localStorage.getItem('glimmervoid-ui-prefs') ?? '{}') as { reviewsLayout?: unknown }).reviewsLayout);
}

async function verifyClosedBoardDetailIgnoresActionKeys(page: Page): Promise<void> {
  await page.evaluate(() => {
    const captureWindow = window as ActionCaptureWindow;
    const originalSend = WebSocket.prototype.send;
    captureWindow.teamReviewOriginalSend = originalSend;
    WebSocket.prototype.send = function(message) {
      if (typeof message === 'string' && (JSON.parse(message) as { type?: string }).type === 'team-review-action') {
        document.documentElement.dataset.teamReviewAction = message;
        return;
      }
      originalSend.call(this, message);
    };
  });
  try {
    await page.keyboard.press('a');
    await page.keyboard.press('Control+Enter');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.teamReviewAction), undefined);
    assert.equal(await page.locator('.review-queue').getAttribute('data-detail-open'), 'false');
  } finally {
    await page.evaluate(() => {
      const captureWindow = window as ActionCaptureWindow;
      if (captureWindow.teamReviewOriginalSend) WebSocket.prototype.send = captureWindow.teamReviewOriginalSend;
      delete captureWindow.teamReviewOriginalSend;
      delete document.documentElement.dataset.teamReviewAction;
    });
  }
}

async function verifyAgeTones(page: Page): Promise<void> {
  const tones = await page.locator('.review-board-column').evaluateAll((columns) => columns.map((column) => ({
    group: column.getAttribute('data-group'),
    tones: [...column.querySelectorAll('.pr-queue-row')].map((row) => ({ tone: row.getAttribute('data-age-tone'), hasAge: /\d/.test(row.querySelector('.pr-queue-elapsed')?.textContent ?? '') })),
  })));
  for (const { group, tones: rowTones } of tones) {
    if (group === 'done' || group === 'parked') {
      assert.ok(rowTones.every(({ tone }) => tone === null), `${group} cards carry no age tone`);
      continue;
    }
    assert.ok(rowTones.every(({ tone, hasAge }) => !hasAge || tone === 'fresh' || tone === 'aging' || tone === 'old'), `${group} cards with an age each carry a tone: ${JSON.stringify(rowTones)}`);
  }
  assert.ok(tones.some(({ tones: rowTones }) => rowTones.some(({ tone }) => tone !== null)), JSON.stringify(tones));
}

async function verifyBoardCardBottomRowsFit(page: Page): Promise<void> {
  const overflowingCardKeys = await page.locator('.review-board-cards .pr-queue-row').evaluateAll((cards) => cards.flatMap((card) => {
    const cardRight = card.getBoundingClientRect().right;
    const shownBottomRowItems = [...card.querySelector('.pr-queue-bottom')?.children ?? []].map((child) => child.getBoundingClientRect()).filter((box) => box.width > 0);
    const itemCenters = shownBottomRowItems.map((box) => box.top + box.height / 2);
    const isOneLine = itemCenters.length === 0 || Math.max(...itemCenters) - Math.min(...itemCenters) < 4;
    const isInsideCard = shownBottomRowItems.every((box) => box.right <= cardRight);
    return isOneLine && isInsideCard ? [] : [card.getAttribute('data-review-key')];
  }));
  assert.deepEqual(overflowingCardKeys, []);
  const orgDot = page.locator('.review-board-cards .pr-queue-row[data-review-key="Acme/app#7"] .pr-queue-author > .author-org-tag');
  assert.equal(await orgDot.isVisible(), true);
  assert.deepEqual(await orgDot.evaluate((dot) => [dot.getBoundingClientRect().width, dot.getBoundingClientRect().height]), [8, 8]);
}

async function showPhoneScreen(page: Page, screen: string): Promise<void> {
  const navItem = page.locator(`.phone-nav > .phone-nav-item[data-screen="${screen}"]`);
  if (await navItem.isVisible()) {
    await navItem.click();
    return;
  }
  await page.locator('.phone-nav > .phone-nav-item', { hasText: 'More' }).click();
  await page.locator(`.phone-nav-more-menu [data-screen="${screen}"]`).click();
}

async function writeUiPrefs(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((prefsPatch) => {
    const prefs = JSON.parse(localStorage.getItem('glimmervoid-ui-prefs') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('glimmervoid-ui-prefs', JSON.stringify({ ...prefs, ...prefsPatch }));
  }, patch);
}

const REVIEWING_NOW_COUNT = '.pr-queue-section[data-group="now"] .review-group-count';

async function waitForText(page: Page, selector: string, text: string | null): Promise<void> {
  await page.waitForFunction(({ target, expected }) => (document.querySelector(target)?.textContent?.trim() ?? null) === expected, { target: selector, expected: text });
}

async function verifyPhoneReviewingNowAfterReturn(page: Page): Promise<void> {
  assert.equal(await page.locator('.pr-queue-section[data-group="now"]').count(), 0);
  assert.equal((await page.locator('.pr-queue-section[data-group="turn"] .review-group-heading > span').first().textContent())?.trim(), 'Ready');
  await showPhoneScreen(page, 'board');
  await writeUiPrefs(page, { reviewsTurnLimit: 1, reviewsPulledKeys: ['team:Acme/app#1', 'team:Acme/app#2'] });
  await showPhoneScreen(page, 'prs');
  await waitForText(page, REVIEWING_NOW_COUNT, '2 / 1');
  assert.equal(await page.locator(REVIEWING_NOW_COUNT).getAttribute('data-over'), 'true');
  await writeUiPrefs(page, { reviewsTurnLimit: 5, reviewsPulledKeys: [] });
  await showPhoneScreen(page, 'board');
  await showPhoneScreen(page, 'prs');
  await waitForText(page, REVIEWING_NOW_COUNT, null);
}

async function dragCardBetweenColumns(page: Page, reviewKey: string, targetGroupId: string): Promise<void> {
  await page.evaluate(({ cardKey, groupId }) => {
    const card = document.querySelector(`.review-board .pr-queue-row[data-review-key="${cardKey}"]`);
    const column = document.querySelector(`.review-board-column[data-group="${groupId}"]`);
    if (!card || !column) throw new Error('Missing drag card or target column');
    const dataTransfer = new DataTransfer();
    const fire = (target: Element, type: string) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    fire(card, 'dragstart');
    if (fire(column, 'dragover')) throw new Error('Target column refused the drag');
    fire(column, 'drop');
  }, { cardKey: reviewKey, groupId: targetGroupId });
}

async function selectedBoardKey(page: Page): Promise<string | null> {
  return page.locator('.review-board [data-queue-key][aria-current="true"]').getAttribute('data-queue-key');
}

async function firstBoardKeyIn(page: Page, groupId: string, rowIndex: number): Promise<string | null> {
  return page.locator(`.review-board-column[data-group="${groupId}"] [data-queue-key]`).nth(rowIndex).getAttribute('data-queue-key');
}

async function verifyColumnSteps(page: Page): Promise<void> {
  await page.locator('.review-board .pr-queue-row[data-review-key="Acme/app#1"]').click();
  await page.locator('.review-board .pr-queue-row[data-review-key="Acme/app#1"]').focus();
  const readyRowIndex = await page.locator('.review-board-column[data-group="turn"] .pr-queue-row').evaluateAll((rows) => rows.findIndex((row) => row.getAttribute('data-review-key') === 'Acme/app#1'));
  assert.ok(readyRowIndex > 0);
  await page.keyboard.press('h');
  assert.equal(await selectedBoardKey(page), await firstBoardKeyIn(page, 'working', 0));
  await page.keyboard.press('l');
  assert.equal(await selectedBoardKey(page), await firstBoardKeyIn(page, 'turn', 0));
  await page.keyboard.press('ArrowRight');
  assert.equal(await selectedBoardKey(page), await firstBoardKeyIn(page, 'waiting', 0));
  await page.keyboard.press('ArrowLeft');
  assert.equal(await selectedBoardKey(page), await firstBoardKeyIn(page, 'turn', 0));
  await page.locator('.review-queue select').first().focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await selectedBoardKey(page), await firstBoardKeyIn(page, 'turn', 0));
  await page.locator('.review-board .pr-queue-row[data-review-key="Acme/app#1"]').click();
}

async function verifyReviewingNowPull(page: Page): Promise<void> {
  const nowColumn = page.locator('.review-board-column[data-group="now"]');
  assert.equal((await nowColumn.locator('.review-board-drop-hint').textContent())?.trim(), 'Drag a Ready card here, or select one and press M.');
  await dragCardBetweenColumns(page, 'Acme/app#1', 'now');
  await nowColumn.locator('.pr-queue-row[data-review-key="Acme/app#1"]').waitFor({ state: 'visible' });
  assert.equal((await nowColumn.locator('.review-group-count').textContent())?.trim(), '1 / 5');
  assert.deepEqual(await page.evaluate(() => (JSON.parse(localStorage.getItem('glimmervoid-ui-prefs') ?? '{}') as { reviewsPulledKeys?: unknown }).reviewsPulledKeys), ['team:Acme/app#1']);
  await writeUiPrefs(page, { reviewsTurnLimit: 1 });
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await waitForText(page, REVIEWING_NOW_COUNT, '1 / 1');
  const otherReadyRow = page.locator('.pr-queue-section[data-group="turn"] .pr-queue-row').first();
  const otherReadyKey = await otherReadyRow.getAttribute('data-queue-key');
  await otherReadyRow.click();
  await page.keyboard.press('m');
  assert.equal((await page.locator(REVIEWING_NOW_COUNT).textContent())?.trim(), '1 / 1');
  assert.equal(await page.locator(`.pr-queue-section[data-group="turn"] .pr-queue-row[data-queue-key="${otherReadyKey}"]`).count(), 1);
  await page.locator('.pr-queue-section[data-group="now"] .pr-queue-row[data-review-key="Acme/app#1"]').click();
  await page.keyboard.press('m');
  await waitForText(page, REVIEWING_NOW_COUNT, null);
  await writeUiPrefs(page, { reviewsTurnLimit: 5 });
}

const BOARD_RESERVE_PX = 320;

async function boardDetailGeometry(page: Page) {
  return page.locator('.review-queue').evaluate((queue) => {
    const board = queue.querySelector('.review-board');
    const boardPane = queue.querySelector('.pr-queue-pane');
    const detail = queue.querySelector('.pr-detail-host');
    const separator = queue.querySelector('.pr-detail-resizer');
    const close = queue.querySelector('[data-action="close-review-detail"]');
    if (!board || !boardPane || !detail || !separator || !close) throw new Error('Missing board detail parts');
    return {
      boardWidth: boardPane.getBoundingClientRect().width,
      boardScrolls: board.scrollWidth > board.clientWidth,
      detailWidth: Math.round(detail.getBoundingClientRect().width),
      closeRight: close.getBoundingClientRect().right,
      viewportWidth: window.innerWidth,
      valueNow: separator.getAttribute('aria-valuenow'),
      storedWidth: (JSON.parse(localStorage.getItem('glimmervoid-ui-prefs') ?? '{}') as { reviewsBoardDetailWidth?: unknown }).reviewsBoardDetailWidth,
    };
  });
}

async function waitForDetailWidthSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const detailWidth = document.querySelector('.review-queue .pr-detail-host')?.getBoundingClientRect().width ?? 0;
    const valueNow = Number(document.querySelector('.review-queue .pr-detail-resizer')?.getAttribute('aria-valuenow'));
    return Math.abs(detailWidth - valueNow) <= 1;
  });
}

async function verifyHeldDragMovesDetail(page: Page): Promise<void> {
  const separatorBox = await page.locator('.pr-detail-resizer').boundingBox();
  if (!separatorBox) throw new Error('Missing detail separator');
  const widthBeforeDrag = await page.locator('.pr-detail-host').evaluate((detail) => Math.round(detail.getBoundingClientRect().width));
  const separatorCenterY = separatorBox.y + separatorBox.height / 2;
  await page.mouse.move(separatorBox.x + separatorBox.width / 2, separatorCenterY);
  await page.mouse.down();
  await page.mouse.move(separatorBox.x + separatorBox.width / 2 + 40, separatorCenterY, { steps: 5 });
  await page.waitForFunction((startWidth) => Math.round(document.querySelector('.review-queue .pr-detail-host')?.getBoundingClientRect().width ?? 0) <= startWidth - 39, widthBeforeDrag);
  await page.mouse.up();
}

async function verifyWideDetailKeepsBoard(page: Page): Promise<void> {
  await page.locator('.pr-detail-host').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.pr-detail-resizer')?.hasAttribute('aria-valuenow') === true);
  const separator = page.locator('.pr-detail-resizer');
  await separator.focus();
  for (let press = 0; press < 50; press += 1) await page.keyboard.press('ArrowLeft');
  await waitForDetailWidthSettled(page);
  const widest = await boardDetailGeometry(page);
  assert.ok(widest.boardWidth >= BOARD_RESERVE_PX - 1, JSON.stringify(widest));
  assert.ok(widest.closeRight <= widest.viewportWidth, JSON.stringify(widest));
  assert.equal(Number(widest.valueNow), widest.detailWidth, JSON.stringify(widest));
  assert.ok(widest.boardScrolls, JSON.stringify(widest));
  const originalViewport = page.viewportSize();
  if (!originalViewport) throw new Error('Missing viewport');
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('glimmervoid-ui-prefs') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('glimmervoid-ui-prefs', JSON.stringify({ ...prefs, reviewsBoardDetailWidth: 960 }));
  });
  await page.setViewportSize({ width: 1600, height: originalViewport.height });
  await page.waitForFunction(() => Math.round(document.querySelector('.pr-detail-host')?.getBoundingClientRect().width ?? 0) === 960);
  await page.setViewportSize(originalViewport);
  await page.waitForFunction((reservePx) => {
    const boardPane = document.querySelector('.review-queue .pr-queue-pane');
    return boardPane !== null && boardPane.getBoundingClientRect().width >= reservePx - 1;
  }, BOARD_RESERVE_PX);
  await waitForDetailWidthSettled(page);
  const narrowed = await boardDetailGeometry(page);
  assert.equal(narrowed.storedWidth, 960, JSON.stringify(narrowed));
  assert.ok(narrowed.closeRight <= narrowed.viewportWidth, JSON.stringify(narrowed));
  await verifyHeldDragMovesDetail(page);
  await separator.dblclick();
}

const MIN_BOARD_COLUMN_PX = 200;
const MIN_CARD_TITLE_PX = 60;

async function verifyBoardReadable(page: Page): Promise<void> {
  await waitForDetailWidthSettled(page).catch(() => undefined);
  const readability = await page.locator('.review-board').evaluate((board) => {
    const openColumns = [...board.querySelectorAll('.review-board-column:not([data-collapsed="true"], [data-slim="true"])')];
    const turnTitle = board.querySelector('.review-board-column[data-group="turn"] .review-board-column-title');
    if (!(turnTitle instanceof HTMLElement)) throw new Error('Missing Ready title');
    const allColumns = [...board.querySelectorAll('.review-board-column')];
    const openHeadings = openColumns.map((column) => column.querySelector('.review-board-column-heading'));
    const turnKeys = board.querySelector('.review-board-column[data-group="turn"] .shortcut-keys');
    const turnKeysStyle = turnKeys ? getComputedStyle(turnKeys) : null;
    return {
      columnHeights: allColumns.map((column) => Math.round(column.getBoundingClientRect().height)),
      headingHeights: openHeadings.map((heading) => Math.round(heading?.getBoundingClientRect().height ?? 0)),
      turnKeysChrome: turnKeysStyle ? `${turnKeysStyle.borderTopWidth} ${turnKeysStyle.paddingLeft} ${turnKeysStyle.paddingTop}` : null,
      columnWidths: openColumns.map((column) => Math.round(column.getBoundingClientRect().width)),
      cardTitleWidths: [...board.querySelectorAll('.pr-queue-row .pr-queue-title')].map((title) => Math.round(title.getBoundingClientRect().width)),
      turnTitleClipped: turnTitle.scrollWidth > turnTitle.clientWidth,
      turnTitleText: turnTitle.textContent,
    };
  });
  const readabilityText = JSON.stringify(readability);
  assert.ok(readability.columnWidths.every((width) => width >= MIN_BOARD_COLUMN_PX - 1), readabilityText);
  assert.ok(readability.cardTitleWidths.length > 0, readabilityText);
  assert.ok(readability.cardTitleWidths.every((width) => width >= MIN_CARD_TITLE_PX), readabilityText);
  assert.equal(readability.turnTitleClipped, false, readabilityText);
  assert.equal(new Set(readability.columnHeights).size, 1, readabilityText);
  assert.ok(Math.max(...readability.headingHeights) - Math.min(...readability.headingHeights) <= 1, readabilityText);
  assert.ok(readability.turnKeysChrome === null || readability.turnKeysChrome === '0px 0px 0px', readabilityText);
}

async function verifyCloseBarStaysVisible(page: Page): Promise<void> {
  const closeBar = await page.locator('.review-queue .pr-detail-host').evaluate((detailHost) => {
    const bar = detailHost.querySelector('.review-board-detail-bar');
    if (!bar) throw new Error('Missing close bar');
    detailHost.scrollTop = detailHost.scrollHeight;
    return { scrolled: detailHost.scrollTop, barTop: bar.getBoundingClientRect().top, hostTop: detailHost.getBoundingClientRect().top };
  });
  assert.ok(closeBar.scrolled > 0, JSON.stringify(closeBar));
  assert.ok(Math.abs(closeBar.barTop - closeBar.hostTop) <= 1, JSON.stringify(closeBar));
  await page.locator('.review-queue .pr-detail-host').evaluate((detailHost) => {
    detailHost.scrollTop = 0;
  });
}

async function verifyParkedToggleControlsColumn(page: Page): Promise<void> {
  const controlledId = await page.locator('.review-board-parked-toggle').getAttribute('aria-controls');
  assert.ok(controlledId, 'Parked toggle names no controlled element');
  assert.equal(await page.locator(`#${controlledId}`).getAttribute('data-group'), 'parked');
}

async function verifyEscapeClosesBoardFromNote(page: Page, card: Locator): Promise<void> {
  const root = page.locator('.review-queue');
  const noteInput = page.locator('.pr-detail .pr-note-input');
  const pickedCount = () => page.locator('.pr-detail .pr-decision-bar > button[aria-pressed="true"]').count();
  await page.keyboard.press('c');
  assert.equal(await pickedCount(), 1);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('pr-note-input')), true);
  await page.keyboard.type('keep this note');
  await page.keyboard.press('Escape');
  assert.equal(await pickedCount(), 0);
  assert.equal(await root.getAttribute('data-detail-open'), 'true');
  await noteInput.focus();
  await page.keyboard.press('Escape');
  assert.equal(await root.getAttribute('data-detail-open'), 'false');
  await card.click();
  await noteInput.waitFor({ state: 'visible' });
  assert.equal(await noteInput.inputValue(), 'keep this note');
  await noteInput.fill('');
}

async function verifyBoard(page: Page): Promise<void> {
  const root = page.locator('.review-queue');
  const detail = root.locator('.pr-detail-host');
  const card = page.locator('.review-board .pr-queue-row[data-review-key="Acme/app#1"]');
  assert.equal(await root.getAttribute('data-reviews-layout'), 'board');
  assert.equal(await page.getByRole('button', { name: 'Board', exact: true }).getAttribute('aria-pressed'), 'true');
  const titles = await page.locator('.review-board-column .review-board-column-title').allTextContents();
  assert.deepEqual(titles, ['Queued', 'Agent working', 'Ready', 'Reviewing now', 'Waiting on others', 'Done', 'Parked']);
  assert.equal(await detail.isVisible(), false);
  await verifyBoardReadable(page);
  await verifyParkedToggleControlsColumn(page);
  await card.click();
  assert.equal(await root.getAttribute('data-detail-open'), 'true');
  await detail.waitFor({ state: 'visible' });
  await verifyBoardReadable(page);
  await verifyCloseBarStaysVisible(page);
  await verifyEscapeClosesBoardFromNote(page, card);
  await page.keyboard.press('Escape');
  await detail.waitFor({ state: 'hidden' });
  await page.keyboard.press('j');
  await detail.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Close review detail', exact: true }).click();
  await detail.waitFor({ state: 'hidden' });
  await verifyClosedBoardDetailIgnoresActionKeys(page);
  const parkedCard = page.locator('.review-board .pr-queue-tile[data-queue-key="team:Acme/app#6"]');
  assert.equal(await parkedCard.count(), 0);
  const parkedToggle = page.locator('.review-board-parked-toggle');
  await parkedToggle.click();
  await parkedCard.waitFor({ state: 'visible' });
  await parkedToggle.click();
  await parkedCard.waitFor({ state: 'detached' });
  await card.click();
  await verifyWideDetailKeepsBoard(page);
  await verifyAgeTones(page);
  await verifyBoardCardBottomRowsFit(page);
  await verifyColumnSteps(page);
  await verifyReviewingNowPull(page);
  assert.equal(await root.getAttribute('data-reviews-layout'), 'list');
  assert.equal(await storedReviewsLayout(page), 'list');
  await page.locator('.pr-queue-row[data-review-key="Acme/app#5"]').click();
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
    const panelUrl = '/github/team-review-store.ts';
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
      await showQueue(page);
      await page.locator(`.pr-queue-row[data-review-key="Acme/app#${number}"]`).click();
      const openButton = page.locator('.pr-detail [data-action="open-session"]').and(page.getByRole('button', { name: 'Open in session', exact: true }));
      assert.equal(await openButton.getAttribute('aria-keyshortcuts'), 'O');
      const openStatus = page.locator('.pr-detail .pr-session-open-status');
      assert.equal(await openButton.count(), 1);
      await openButton.click();
      assert.equal(await openButton.count(), 1);
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
  await showQueue(page);
  if (layout === 'desktop') await verifyBoard(page);
  if (layout === 'phone') {
    assert.equal(await page.locator('.review-queue').getAttribute('data-reviews-layout'), 'list');
    assert.equal(await page.locator('.review-layout-switch').isVisible(), false);
    await verifyPhoneReviewingNowAfterReturn(page);
  }
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  await page.evaluate(async () => { await document.fonts.ready; });
  await verifyRows(page);
  await verifyLayout(page);
  if (layout === 'desktop') {
    assert.equal(await page.locator('.pr-queue-row[data-review-key="Acme/app#5"]').getAttribute('aria-current'), 'true');
    assert.equal(await page.locator('.pr-detail .pr-attention-next').textContent(), 'Re-run review to try again, or Not mine to drop it.');
    const dashboardModifier = shortcutPlatformFor(await page.evaluate(() => navigator.userAgent)) === 'mac' ? 'Meta' : 'Alt';
    await page.keyboard.press(`${dashboardModifier}+KeyJ`);
    assert.equal(await page.locator('.pr-queue-row[data-review-key="Acme/app#1"]').getAttribute('aria-current'), 'true');
    assert.equal(await page.evaluate(() => document.body.dataset.activeView), 'prs');
  }
  if (layout === 'desktop') {
    await page.locator('.review-queue .pr-columns').evaluate((columns) => {
      if (!(columns instanceof HTMLElement)) throw new Error('Missing queue columns');
      columns.style.setProperty('--pr-queue-width', '220px');
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.review-queue .pr-queue-pane')?.offsetWidth === 220);
    await verifyLayout(page);
    await page.locator('.review-queue .pr-columns').evaluate((columns) => {
      if (!(columns instanceof HTMLElement)) throw new Error('Missing queue columns');
      columns.style.removeProperty('--pr-queue-width');
    });
  }
  const nitsRow = page.locator('.pr-queue-row[data-review-key="Acme/app#2"]');
  await showQueue(page);
  await nitsRow.focus();
  await page.keyboard.press('Enter');
  assert.equal(await nitsRow.getAttribute('aria-current'), 'true');
  assert.equal(await page.locator('.pr-detail .pr-verdict-seal').textContent(), 'Approve with nits');
  assert.equal(await page.locator('.pr-detail .pr-verdict-seal svg').count(), 1);
  assert.ok(await page.locator('.pr-detail .pr-severity-meter').count() > 0);
  const approvalNotice = page.locator('.pr-detail .pr-rereview-notice');
  assert.match(await approvalNotice.textContent() ?? '', /^You approved an earlier version( .+ ago)?\. It has new commits since/);
  assert.doesNotMatch(await approvalNotice.textContent() ?? '', /bbbbbbb/);
  assert.equal(await approvalNotice.getAttribute('title'), null);
  assert.match(await page.locator('.pr-detail .pr-detail-meta').textContent() ?? '', /full review/);
  assert.match(await page.locator('.pr-detail .pr-detail-tier-reason').textContent() ?? '', /^The agent reads every changed file\./);
  if (layout === 'desktop') await verifyDecisionBarPinned(page);
  await showQueue(page);
  await page.locator('.pr-queue-row[data-review-key="Acme/app#3"]').click();
  const earlierPreview = page.locator('.pr-detail .pr-earlier-review .pr-disclosure-preview');
  assert.equal(await earlierPreview.textContent(), '0 comments, posted');
  const handChecks = page.locator('.pr-detail .pr-hand-checks');
  assert.equal(await handChecks.locator('li').textContent(), 'Look at what these changed UI files render: public/header.css');
  assert.deepEqual(await page.locator('.pr-detail .pr-desk-column > :is(section, .pr-earlier-review)').evaluateAll((blocks) => blocks.map((block) => block.classList.contains('pr-earlier-review') ? 'Earlier review' : block.getAttribute('aria-label')).filter((label) => label === 'About this PR' || label === 'Verdict' || label === 'Check by hand' || label === 'Findings' || label === 'Earlier review')), ['About this PR', 'Verdict', 'Check by hand', 'Findings', 'Earlier review']);
  assert.deepEqual(await page.locator('.pr-detail .pr-desk-rail > *').evaluateAll((blocks) => blocks.map((block) => block.className)), ['pr-session-open', 'pr-will-post', 'pr-desk-facts']);
  assert.equal(await page.locator('.pr-detail .pr-detail-heading .pr-session-open').count(), 0);
  await showQueue(page);
  await nitsRow.click();
  const mixed = { ...status, drafts: [...status.drafts, createDraft(11, { key: 'Acme/docs#11', repo: 'Acme/docs' })] };
  await applyStatus(page, mixed);
  assert.equal(await nitsRow.locator('.pr-queue-ref').textContent(), 'Acme/app#2');
  const progress = { ...mixed, inFlight: mixed.inFlight.map((review) => ({ ...review, toolCalls: 2 })) };
  await applyStatus(page, progress);
  assert.equal(await page.locator('.pr-queue-row[data-review-key="Acme/app#9"] .pr-queue-ref').textContent(), 'Acme/app#9');
  await applyStatus(page, status);
  assert.equal(await nitsRow.locator('.pr-queue-ref').textContent(), '#2');
  await verifyUnchangedQueueKeepsRowNodes(page, status);
  await verifyQueueRebuildsAfterEmptyStatus(page, status);
  await verifyViewerThreadCounts(page, status);
  await verifyAnsweredThreadConversation(page, status);
  await verifyOpenInSession(page, layout, status, sessionId);
  await verifyCanonicalTeamPrFields(page, layout, status, sessionId);
  if (layout === 'phone') await verifyPhoneDetailScreen(page, status);
  await verifyActionAdvancement(page, status);
  await verifyMyPrKeepMergeable(page);
}
