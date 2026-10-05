import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { ReviewDraft, TeamReviewStatus } from '../../shared/contracts/team-review.ts';
import type { Layout } from './cases-core.ts';

const REVIEWED_HEAD = 'a'.repeat(40);
const PREVIOUS_HEAD = 'b'.repeat(40);

interface TeamReviewPanelModule {
  applyTeamReviewStatus(message: unknown): void;
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
    verdict: button.querySelector('.pr-queue-verdict')?.textContent,
    tone: button.querySelector('.pr-queue-verdict')?.getAttribute('data-tone'),
    bottom: button.querySelector('.pr-queue-bottom')?.textContent,
    count: button.querySelector('.pr-queue-comment-count')?.textContent,
    authorAvatars: button.querySelectorAll('.pr-queue-author .avatar').length,
    reviewerAvatars: button.querySelectorAll('.pr-queue-reviewers .avatar').length,
    title: button.getAttribute('title'),
    accessibleName: button.getAttribute('aria-label'),
    children: button.children.length,
    removedParts: button.querySelectorAll('.pr-queue-glyph, .pr-verdict-seal, .pr-severity-meter, .pr-rereview-tag').length,
  })));
  assert.equal(rows.length, 10);
  for (const row of rows) {
    assert.equal(row.removedParts, 0);
    assert.equal(row.children, 2);
    assert.equal(row.authorAvatars, 1);
    assert.equal(row.accessibleName, row.title);
    assert.equal(row.ref, row.key?.replace('Acme/app', ''));
  }
  assert.deepEqual(rows.slice(0, 4).map((row) => [row.verdict, row.tone]), [
    ['Approve', 'ok'], ['Nits', 'info'], ['Changes', 'warn'], ['Blocked', 'crit'],
  ]);
  const nits = rows.find((row) => row.key === 'Acme/app#2');
  assert.ok(nits);
  assert.equal(nits.count, `${String.fromCharCode(0x00b7)} 2`);
  assert.match(nits.bottom ?? '', /since approval/);
  assert.match(nits.title ?? '', /Acme\/app#2:.*\nReady\n/s);
  assert.match(nits.accessibleName ?? '', /Nits, 2 comments/);
  assert.equal(nits.reviewerAvatars, 2);
  assert.equal(rows[0]?.count, undefined);
  assert.equal(rows.find((row) => row.key === 'Acme/app#8')?.verdict, 'Approve');
}

async function verifyLayout(page: Page): Promise<void> {
  const layout = await page.locator('.pr-queue-row[data-review-key="Acme/app#2"]').evaluate((row) => {
    const top = row.querySelector('.pr-queue-top');
    const bottom = row.querySelector('.pr-queue-bottom');
    const title = row.querySelector('.pr-queue-title');
    const age = row.querySelector('.pr-queue-elapsed');
    const verdict = row.querySelector('.pr-queue-verdict');
    if (!top || !bottom || !title || !age || !verdict) throw new Error('The row is missing its two lines, verdict or age');
    const toneToken = { ok: '--state-complete', info: '--accent', warn: '--state-waiting', crit: '--state-failed' }[verdict.getAttribute('data-tone') ?? ''];
    const expectedColor = document.createElement('span');
    expectedColor.style.color = `var(${toneToken})`;
    row.append(expectedColor);
    const verdictColor = getComputedStyle(verdict).color;
    const expectedVerdictColor = getComputedStyle(expectedColor).color;
    expectedColor.remove();
    return {
      top: top.getBoundingClientRect().toJSON(), bottom: bottom.getBoundingClientRect().toJSON(),
      row: row.getBoundingClientRect().toJSON(), age: age.getBoundingClientRect().toJSON(),
      titleOverflow: getComputedStyle(title).textOverflow,
      titleIsTruncated: title.scrollWidth > title.clientWidth,
      verdictColor, expectedVerdictColor,
      bottomOverflows: bottom.scrollWidth > bottom.clientWidth,
    };
  });
  assert.equal(layout.titleOverflow, 'ellipsis');
  assert.equal(layout.titleIsTruncated, true);
  assert.equal(layout.verdictColor, layout.expectedVerdictColor);
  assert.equal(layout.bottomOverflows, false);
  assert.ok(layout.bottom.y >= layout.top.bottom);
  assert.ok(layout.bottom.right <= layout.row.right);
  assert.ok(layout.age.right <= layout.row.right);
}

async function verifyCollapsedRailShowsNumbers(page: Page): Promise<void> {
  const nitsRow = page.locator('.pr-queue-row[data-review-key="Acme/app#2"]');
  await page.locator('.pr-mode-root:not([hidden]) .pr-queue-toggle').click();
  const compactRef = nitsRow.locator('.pr-queue-ref-compact');
  assert.ok(await compactRef.isVisible());
  assert.equal(await compactRef.textContent(), '#2');
  await page.waitForFunction(() => {
    const ref = document.querySelector('.pr-queue-row[data-review-key="Acme/app#2"] .pr-queue-ref-compact');
    return ref !== null && ref.scrollWidth <= ref.clientWidth && ref.getBoundingClientRect().width > 8;
  }, undefined, { timeout: 2_000 });
  assert.equal(await nitsRow.locator('.pr-queue-ref').isVisible(), false);
  assert.equal(await nitsRow.locator('.pr-queue-title').isVisible(), false);
  await page.locator('.pr-mode-root:not([hidden]) .pr-queue-toggle').click();
  await nitsRow.locator('.pr-queue-title').waitFor({ state: 'visible' });
  assert.equal(await compactRef.isVisible(), false);
  await verifyLayout(page);
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
  assert.equal(await page.locator('.pr-detail .pr-verdict-seal').textContent(), 'approve with nits');
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
}
