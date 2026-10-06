import { hasReviewsCountdown, reviewsErrorNotice, reviewsRefreshText } from './reviews-retry-core.ts';
import type { ReviewsPollingStatus } from './reviews-retry-core.ts';
import type { ReviewsRefreshRequest } from '#shared/contracts/reviews.ts';
import type { MyPr, MyPrsStatus } from '#shared/contracts/my-prs.ts';
import { createAvatar, createReviewerStack, el, externalLink, isPanelHidden } from './dom-helpers.ts';
import { formatAgo } from './poll-ago.ts';
import { createPrQueueColumns } from './pr-queue-columns.ts';
import { createStateGlyph } from './state-glyph.ts';
import { sendControlMsg, sendControlRequest } from './control-ws.ts';
import { openConfirmDialog } from './session-card/modal.ts';
import { chooseSelectedKey, emptyStateText, isKeepMergeableFeatureEnabled, isMergeQueueFeatureEnabled, keepMergeableControlState, keepMergeableRowLabel, mergeConfirmMessage, mergeControlState, mergeWhenReadyControlState, parseMyPrMergeResult, parseMyPrsStatus, queueNotices, readinessRows, reviewRows, sectionStackedMyPrs, stageLabel, stageTone, threadRows } from './my-prs-view-core.ts';
import type { MergeAttempt, ToggleControlState } from './my-prs-view-core.ts';

let root: HTMLDivElement | null = null;
let scopeTabs: HTMLElement | null = null;
let queue: HTMLElement | null = null;
let detail: HTMLElement | null = null;
let latest: MyPrsStatus | null = null;
let selectedKey: string | null = null;
let pollingControls: ReturnType<typeof createReviewsPollingControls> | null = null;
const mergeAttempts = new Map<string, MergeAttempt>();
const pendingMergeRequests = new Map<string, { requestId: string; head: string; timer: number }>();
interface PrToggle {
  label: string;
  pendingKeys: Set<string>;
  errorsByKey: Map<string, string>;
  controlState: (pr: MyPr, isPending: boolean, errorText: string | undefined, isFeatureEnabled: boolean) => ToggleControlState;
  isFeatureEnabled: (status: MyPrsStatus | null) => boolean;
  save: (pr: MyPr, isTurningOn: boolean) => Promise<string | null>;
}

const keepMergeableToggle: PrToggle = {
  label: 'Keep mergeable', pendingKeys: new Set(), errorsByKey: new Map(), controlState: (pr, isPending, errorText, isFeatureEnabled) => keepMergeableControlState(pr, isPending, errorText, isFeatureEnabled, formatAgo(pr.keepMergeableAttempt?.at)), isFeatureEnabled: isKeepMergeableFeatureEnabled,
  save: async (pr, isTurningOn) => {
    const response = await sendControlRequest('my-pr-keep-mergeable', { repo: pr.repo, number: pr.number, keepMergeable: isTurningOn });
    if (response.type !== 'my-pr-keep-mergeable-result' || response.key !== pr.key) throw new Error('Unexpected keep mergeable reply.');
    return response.ok ? null : response.error ?? 'Could not save Keep mergeable.';
  },
};

const mergeWhenReadyToggle: PrToggle = {
  label: 'Merge when ready', pendingKeys: new Set(), errorsByKey: new Map(), controlState: mergeWhenReadyControlState, isFeatureEnabled: isMergeQueueFeatureEnabled,
  save: async (pr, isTurningOn) => {
    const response = await sendControlRequest('my-pr-merge-when-ready', { repo: pr.repo, number: pr.number, mergeWhenReady: isTurningOn });
    if (response.type !== 'my-pr-merge-when-ready-result' || response.key !== pr.key) throw new Error('Unexpected merge when ready reply.');
    return response.ok ? null : response.error ?? 'Could not save Merge when ready.';
  },
};
const MERGE_REPLY_TIMEOUT_MS = 60000;
const MERGE_NO_REPLY_TEXT = 'No reply from the server. Check GitHub before trying again.';

export function createReviewsPollingControls(lane: ReviewsRefreshRequest['lane'], panel: HTMLElement) {
  const control = el('div', 'reviews-refresh-control');
  const button = el('button', 'pr-action reviews-refresh-button', 'Refresh');
  button.type = 'button';
  const progress = el('span', 'reviews-refresh-status');
  progress.setAttribute('role', 'status');
  const notice = el('p', 'my-pr-error reviews-retry-notice');
  control.append(button, progress);
  let currentStatus: ReviewsPollingStatus | null = null;
  let isPending = false;
  let outcomeText = '';
  let countdownTimer: number | null = null;

  function updateCountdown(): void {
    notice.textContent = reviewsErrorNotice(currentStatus, Date.now());
    if (notice.hidden !== !currentStatus?.error) notice.hidden = !currentStatus?.error;
    const shouldTick = notice.isConnected && !isPanelHidden(panel) && !document.hidden && notice.getClientRects().length > 0 && hasReviewsCountdown(currentStatus, Date.now());
    if (!shouldTick && countdownTimer !== null) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (shouldTick && countdownTimer === null) countdownTimer = window.setInterval(updateCountdown, 1000);
  }

  function update(status: ReviewsPollingStatus | null): void {
    if (status !== currentStatus) outcomeText = '';
    currentStatus = status;
    button.disabled = isPending || !!status?.isRefreshing || !status?.configured;
    progress.textContent = reviewsRefreshText(status, isPending, outcomeText);
    progress.hidden = !progress.textContent;
    updateCountdown();
  }

  button.addEventListener('click', async () => {
    if (isPending) return;
    isPending = true;
    outcomeText = '';
    update(currentStatus);
    try {
      const response = await sendControlRequest('reviews-refresh', { lane });
      if (response.type === 'reviews-refresh-result') outcomeText = response.ok ? 'Refreshed.' : response.error ?? 'Could not refresh from GitHub.';
    } catch (error: unknown) {
      outcomeText = error instanceof Error ? error.message : String(error);
    } finally {
      isPending = false;
      update(currentStatus);
    }
  });
  const visibilityObserver = new MutationObserver(updateCountdown);
  visibilityObserver.observe(panel, { attributes: true, subtree: true, attributeFilter: ['hidden', 'data-queue-collapsed'] });
  for (let ancestor: HTMLElement | null = panel.parentElement; ancestor; ancestor = ancestor.parentElement) visibilityObserver.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'data-queue-collapsed'] });
  document.addEventListener('visibilitychange', updateCountdown);
  return { control, notice, update };
}

function settleMerge(key: string, head: string, phase: MergeAttempt['phase'], text: string): void {
  mergeAttempts.set(key, { head, phase, text });
  render();
}

function sendMerge(pr: MyPr): void {
  if (pendingMergeRequests.has(pr.key)) return;
  const requestId = `my-pr-merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const isSent = sendControlMsg({ type: 'my-pr-merge', requestId, repo: pr.repo, number: pr.number, headRefOid: pr.headRefOid });
  if (!isSent) {
    settleMerge(pr.key, pr.headRefOid, 'failed', 'Not connected to the server.');
    return;
  }
  const timer = window.setTimeout(() => {
    pendingMergeRequests.delete(pr.key);
    settleMerge(pr.key, pr.headRefOid, 'failed', MERGE_NO_REPLY_TEXT);
  }, MERGE_REPLY_TIMEOUT_MS);
  pendingMergeRequests.set(pr.key, { requestId, head: pr.headRefOid, timer });
  mergeAttempts.set(pr.key, { head: pr.headRefOid, phase: 'pending', text: '' });
  render();
}

function createMergeControl(pr: MyPr): HTMLElement | null {
  const state = mergeControlState(pr, mergeAttempts.get(pr.key));
  if (!state.isVisible) return null;
  const control = el('div', 'my-pr-merge');
  const button = el('button', 'pr-action', 'Merge');
  button.type = 'button';
  button.disabled = state.isDisabled;
  const status = el('span', 'pr-action-status', state.statusText);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  if (state.tone) status.dataset.tone = state.tone;
  button.addEventListener('click', () => {
    openConfirmDialog({ title: 'Merge pull request', message: mergeConfirmMessage(pr), confirmLabel: 'Merge', onConfirm: () => sendMerge(pr) });
  });
  control.append(button, status);
  return control;
}

function createToggleControl(pr: MyPr, toggle: PrToggle): HTMLElement | null {
  const state = toggle.controlState(pr, toggle.pendingKeys.has(pr.key), toggle.errorsByKey.get(pr.key), toggle.isFeatureEnabled(latest));
  if (!state.isVisible) return null;
  const control = el('div', 'my-pr-merge');
  const button = el('button', 'pr-action', toggle.label);
  button.type = 'button';
  button.disabled = state.isDisabled;
  button.setAttribute('aria-pressed', String(state.isPressed));
  const indicator = el('span', 'pr-action-status', state.statusText);
  indicator.setAttribute('role', 'status');
  indicator.setAttribute('aria-live', 'polite');
  button.addEventListener('click', async () => {
    if (toggle.pendingKeys.has(pr.key)) return;
    toggle.pendingKeys.add(pr.key);
    toggle.errorsByKey.delete(pr.key);
    render();
    try {
      const errorText = await toggle.save(pr, !state.isPressed);
      if (errorText) toggle.errorsByKey.set(pr.key, errorText);
    } catch (error: unknown) {
      toggle.errorsByKey.set(pr.key, error instanceof Error ? error.message : String(error));
    } finally {
      toggle.pendingKeys.delete(pr.key);
      render();
    }
  });
  control.append(button, indicator);
  return control;
}

function stageChip(pr: MyPr, { hasGlyph }: { hasGlyph: boolean }): HTMLElement {
  const chip = el('span', 'my-pr-stage');
  chip.dataset.tone = stageTone(pr.stage);
  if (hasGlyph) chip.append(createStateGlyph(stageTone(pr.stage)));
  chip.append(stageLabel(pr.stage));
  return chip;
}

function requestedReviewers(pr: MyPr, text: string): HTMLElement {
  const requested = el('span', 'my-pr-requested');
  requested.append(el('span', null, 'Requested'));
  const avatars = el('span', 'avatar-stack');
  for (const request of pr.reviewRequests) {
    const avatar = createAvatar({ login: request.name, url: request.isTeam ? request.avatarUrl : undefined, cssPx: 16 });
    avatar.title = request.name;
    avatar.setAttribute('role', 'img');
    avatar.setAttribute('aria-label', request.name);
    avatars.append(avatar);
  }
  requested.append(avatars, el('span', 'my-pr-requested-names', text.slice('Requested: '.length)));
  return requested;
}

function createShell(): void {
  if (!root || !scopeTabs || queue?.isConnected) return;
  const shell = createPrQueueColumns({
    queueLabel: 'My pull requests',
    scopeTabs,
    resizerLabel: 'Resize pull request list',
  });
  queue = shell.queue;
  detail = shell.detail;
  root.replaceChildren(shell.columns);
  const head = root.querySelector('.pr-queue-head');
  if (pollingControls && head) head.insertBefore(pollingControls.control, head.querySelector('.pr-queue-toggle'));
}

function renderDetail(pr: MyPr | undefined): void {
  if (!detail) return;
  if (!pr) {
    detail.replaceChildren(el('p', 'pr-empty', emptyStateText(latest)));
    return;
  }
  const content = el('article', 'pr-detail');
  const heading = el('div', 'pr-detail-heading');
  const title = el('div', 'pr-detail-title');
  title.append(externalLink('pr-link', pr.key, pr.url), el('h2', null, pr.title));
  heading.append(title, stageChip(pr, { hasGlyph: true }));
  content.append(heading);
  for (const toggle of [keepMergeableToggle, mergeWhenReadyToggle]) {
    const toggleControl = createToggleControl(pr, toggle);
    if (toggleControl) content.append(toggleControl);
  }
  const readiness = readinessRows(pr, latest?.viewer ?? null);
  if (readiness.length > 0) {
    const section = el('section', 'pr-readiness-section');
    section.append(el('h3', 'pr-section-heading', 'Merge readiness'));
    const list = el('ul', 'pr-readiness');
    for (const readinessRow of readiness) {
      const item = el('li', 'pr-readiness-row');
      const value = el('span', 'pr-readiness-value');
      if (readinessRow.label === 'Review' && readinessRow.text.startsWith('Requested: ')) value.append(requestedReviewers(pr, readinessRow.text));
      if (value.childNodes.length === 0) value.textContent = readinessRow.text;
      item.append(createStateGlyph(readinessRow.tone), el('span', 'pr-readiness-label', readinessRow.label), value);
      list.append(item);
    }
    section.append(list);
    const mergeControl = createMergeControl(pr);
    if (mergeControl) section.append(mergeControl);
    content.append(section);
  }
  if (pr.checks.failing.length > 0) {
    const failed = el('section', 'my-pr-failures');
    failed.append(el('h3', 'pr-section-heading', 'Failing checks'));
    const list = el('ul', 'my-pr-facts');
    for (const name of pr.checks.failing) list.append(el('li', null, name));
    failed.append(list);
    content.append(failed);
  }
  const reviews = reviewRows(pr);
  if (reviews.length > 0) {
    const section = el('section', 'pr-readiness-section');
    section.append(el('h3', 'pr-section-heading', 'Reviews'));
    const list = el('ul', 'pr-readiness');
    for (const review of reviews) {
      const item = el('li', 'pr-readiness-row');
      const submittedAtMs = Date.parse(review.submittedAt ?? '');
      const when = Number.isFinite(submittedAtMs) ? `${review.text} ${formatAgo(submittedAtMs)}` : review.text;
      const reviewer = el('span', 'my-pr-reviewer');
      reviewer.append(createReviewerStack([{ login: review.reviewer, tone: review.tone, title: review.reviewer, url: review.reviewer === 'a deleted account' ? null : undefined }], 16), el('span', null, review.reviewer));
      item.append(createStateGlyph(review.tone), reviewer, el('span', 'pr-readiness-value', when));
      list.append(item);
    }
    section.append(list);
    content.append(section);
  }
  const threads = threadRows(pr, latest?.viewer ?? null);
  if (threads.length > 0) {
    const section = el('section', 'my-pr-threads-section');
    section.append(el('h3', 'pr-section-heading', 'Unresolved threads'));
    const list = el('ul', 'my-pr-threads');
    for (const thread of threads) {
      const item = el('li', 'my-pr-thread');
      const heading = el('div', 'my-pr-thread-heading');
      heading.append(externalLink('my-pr-thread-location', thread.location, thread.url));
      if (thread.waiting) {
        const badge = el('span', 'my-pr-stage');
        badge.dataset.tone = thread.waiting.tone;
        badge.append(createStateGlyph(thread.waiting.tone), thread.waiting.text);
        heading.append(badge);
      }
      const excerpt = el('p', 'my-pr-thread-excerpt');
      excerpt.append(el('strong', null, thread.author), ` ${thread.excerpt}`);
      const activity = Date.parse(thread.lastActivityAt);
      const meta = el('p', 'my-pr-thread-meta', Number.isFinite(activity) ? `${thread.replySummary}, ${formatAgo(activity)}` : thread.replySummary);
      item.append(heading, excerpt, meta);
      list.append(item);
    }
    section.append(list);
    content.append(section);
  }
  const time = el('p', 'pr-detail-meta');
  time.append(el('span', null, `Opened ${formatAgo(Date.parse(pr.createdAt))}`), el('span', null, `${pr.state === 'MERGED' ? 'Merged' : 'Updated'} ${formatAgo(Date.parse(pr.state === 'MERGED' ? pr.mergedAt ?? '' : pr.updatedAt))}`));
  content.append(time);
  detail.replaceChildren(content);
}

function render(): void {
  createShell();
  if (!queue) return;
  const prs = latest?.prs ?? [];
  const sections = sectionStackedMyPrs(prs);
  selectedKey = chooseSelectedKey(sections, selectedKey);
  const focusedKey = document.activeElement instanceof HTMLElement && queue.contains(document.activeElement) ? document.activeElement.dataset.prKey : null;
  const sectionElements = sections.filter((section) => section.rows.length > 0).map((section) => {
    const sectionElement = el('section', 'pr-queue-section');
    sectionElement.append(el('h3', 'pr-section-heading', `${section.title} ${section.rows.length}`));
    for (const { pr, parentKey, depth } of section.rows) {
      const row = el('button', 'pr-queue-row');
      row.type = 'button';
      row.dataset.prKey = pr.key;
      if (parentKey) row.style.paddingInlineStart = `${12 + Math.min(depth, 6) * 16}px`;
      row.setAttribute('aria-current', String(pr.key === selectedKey));
      row.title = `${pr.key}: ${stageLabel(pr.stage)}`;
      const glyph = el('span', 'pr-queue-glyph');
      glyph.append(createStateGlyph(stageTone(pr.stage)));
      const top = el('span', 'pr-queue-top');
      top.append(el('strong', 'pr-queue-ref', pr.key), el('span', 'pr-queue-title', pr.title));
      const bottom = el('span', 'pr-queue-bottom');
      if (parentKey) bottom.append(el('span', 'my-pr-stage', `Stacked on ${parentKey}`));
      bottom.append(stageChip(pr, { hasGlyph: false }), el('span', 'pr-queue-elapsed', `opened ${formatAgo(Date.parse(pr.createdAt))}`));
      const repairLabel = keepMergeableRowLabel(pr, keepMergeableToggle.isFeatureEnabled(latest), formatAgo(pr.keepMergeableAttempt?.at));
      if (repairLabel) {
        const repairChip = el('span', 'my-pr-stage', repairLabel.text);
        repairChip.dataset.tone = repairLabel.tone;
        repairChip.title = repairLabel.title;
        bottom.append(repairChip);
      }
      row.append(glyph, top, bottom);
      row.addEventListener('click', () => {
        selectedKey = pr.key;
        for (const button of queue?.querySelectorAll<HTMLButtonElement>('button[data-pr-key]') ?? []) button.setAttribute('aria-current', String(button.dataset.prKey === selectedKey));
        renderDetail(pr);
        if (document.documentElement.dataset.layout === 'phone') detail?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
      sectionElement.append(row);
    }
    return sectionElement;
  });
  if (sectionElements.length === 0) queue.replaceChildren(el('p', 'pr-empty', emptyStateText(latest)));
  if (sectionElements.length > 0) {
    const noticeElements = queueNotices(latest, Date.now()).filter((notice) => notice.tone !== 'error').map((notice) => el('p', notice.tone === 'error' ? 'my-pr-error' : 'my-pr-note', notice.text));
    queue.replaceChildren(...noticeElements, ...sectionElements);
  }
  if (pollingControls) {
    queue.prepend(pollingControls.notice);
    pollingControls.update(latest);
  }
  if (focusedKey) [...queue.querySelectorAll<HTMLButtonElement>('button[data-pr-key]')].find((row) => row.dataset.prKey === focusedKey)?.focus({ preventScroll: true });
  renderDetail(prs.find((pr) => pr.key === selectedKey));
}

export function mountMyPrsView(parent: HTMLElement, tabs: HTMLElement): HTMLDivElement {
  if (root) return root;
  scopeTabs = tabs;
  root = el('div', 'pr-content');
  parent.append(root);
  pollingControls = createReviewsPollingControls('my-prs', root);
  render();
  return root;
}

export function applyMyPrsStatus(message: unknown): void {
  const parsed = parseMyPrsStatus(message);
  if (!parsed) return;
  latest = parsed;
  render();
}

export function applyMyPrMergeResult(message: unknown): void {
  const mergeResult = parseMyPrMergeResult(message);
  if (!mergeResult) return;
  const pending = pendingMergeRequests.get(mergeResult.key);
  if (!pending || pending.requestId !== mergeResult.requestId) return;
  window.clearTimeout(pending.timer);
  pendingMergeRequests.delete(mergeResult.key);
  if (!mergeResult.ok) {
    settleMerge(mergeResult.key, pending.head, 'failed', mergeResult.error || 'The merge failed.');
    return;
  }
  settleMerge(mergeResult.key, pending.head, mergeResult.kind ?? 'unconfirmed', '');
}
