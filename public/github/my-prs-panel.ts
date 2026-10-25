import { githubPrByKey, subscribeGithubPrs } from './github-prs-store.ts';
import { hasGithubPollingCountdown, githubPollingAgeText, githubPollingErrorNotice, githubPollingRefreshText } from './github-polling-retry-core.ts';
import type { GithubPollingStatus } from './github-polling-retry-core.ts';
import type { GithubPollingRefreshRequest } from '#shared/contracts/github-polling.ts';
import type { LinkedPr, MyPr, MyPrsStatus } from '#shared/contracts/my-prs.ts';
import { STATES } from '#shared/states.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, paintActionStatus, requestFailureText } from '../action-status.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import { createAvatar, createReviewerStack, el, externalLink, isPanelHidden, query } from '../dom-helpers.ts';
import { buildSessionRow, paintSessionRowStatus } from '../session-row.ts';
import { formatAgo } from '../poll-ago.ts';
import { createPrStatusIcon } from './pr-status-icon.ts';
import { nextRequestId, sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { queueMergeCelebration } from '../merge-celebration.ts';
import { sessionName, sessionUIs } from '../session-card/card-registry.ts';
import { joinMyPrs, emptyStateText, isKeepMergeableFeatureEnabled, isMergeQueueFeatureEnabled, keepMergeableControlState, keepMergeableRowLabel, liveSessionsByPrKey, mergeConfirmMessage, mergeControlState, mergeCelebrationText, mergeWhenReadyControlState, newlyMergedPrs, parseMyPrMergeResult, parseMyPrsStatus, readinessRows, reviewRows, stageIcon, stageLabel, stageTone, threadRows } from './my-prs-view-core.ts';
import type { LinkedLiveSession, LiveSessionLinks, MergeAttempt, ToggleControlState } from './my-prs-view-core.ts';

let detail: HTMLElement | null = null;
let queueHooks: { onChange: () => void } | null = null;
let latest: MyPrsStatus | null = null;
let previousJoinedPrs: MyPr[] | null = null;
let selectedKey: string | null = null;
const mergeAttempts = new Map<string, MergeAttempt>();
const celebratedMergeKeys = new Set<string>();
const pendingMergeRequests = new Map<string, { requestId: string; head: string; timer: number }>();
let sessionLinksById: ReadonlyMap<string, readonly LinkedPr[]> = new Map();
let isRenderQueued = false;
let openTerminal: ((sessionId: string) => void) | null = null;
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
    const response = await sendControlRequest('my-pr-keep-mergeable', { repo: pr.repo, number: pr.number, keepMergeable: isTurningOn }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (response.type !== 'my-pr-keep-mergeable-result' || response.key !== pr.key) throw new Error('Unexpected keep mergeable reply.');
    return response.ok ? null : response.error ?? 'Could not save Keep mergeable.';
  },
};

const mergeWhenReadyToggle: PrToggle = {
  label: 'Merge when ready', pendingKeys: new Set(), errorsByKey: new Map(), controlState: mergeWhenReadyControlState, isFeatureEnabled: isMergeQueueFeatureEnabled,
  save: async (pr, isTurningOn) => {
    const response = await sendControlRequest('my-pr-merge-when-ready', { repo: pr.repo, number: pr.number, mergeWhenReady: isTurningOn }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (response.type !== 'my-pr-merge-when-ready-result' || response.key !== pr.key) throw new Error('Unexpected merge when ready reply.');
    return response.ok ? null : response.error ?? 'Could not save Merge when ready.';
  },
};
const MERGE_REPLY_TIMEOUT_MS = 60000;
const GITHUB_REFRESH_REPLY_TIMEOUT_MS = 60000;
const MERGE_NO_REPLY_TEXT = `The server did not answer within ${MERGE_REPLY_TIMEOUT_MS / 1000} s. Check GitHub before trying again.`;
const MERGE_DISCONNECTED_TEXT = `${NOT_CONNECTED_TEXT} Check GitHub before trying again.`;

export function createGithubPollingControls(lane: GithubPollingRefreshRequest['lane'] | readonly GithubPollingRefreshRequest['lane'][], panel: HTMLElement) {
  const lanes = typeof lane === 'string' ? [lane] : lane;
  const control = el('div', 'reviews-refresh-control');
  const button = el('button', 'pr-action pr-action-ghost reviews-refresh-button', 'Refresh');
  button.type = 'button';
  const progress = el('span', 'reviews-refresh-status');
  progress.setAttribute('role', 'status');
  const notice = el('p', 'my-pr-error reviews-retry-notice');
  control.append(button, progress);
  let currentStatus: GithubPollingStatus | null = null;
  let isPending = false;
  let outcomeText = '';
  let countdownTimer: number | null = null;

  function updateCountdown(): void {
    const nowMs = Date.now();
    const errorNotice = githubPollingErrorNotice(currentStatus, nowMs);
    const ageText = githubPollingAgeText(currentStatus, nowMs);
    notice.textContent = errorNotice ? [errorNotice, ageText].filter(Boolean).join(' ') : '';
    if (notice.hidden !== !currentStatus?.error) notice.hidden = !currentStatus?.error;
    progress.textContent = githubPollingRefreshText(currentStatus, isPending, outcomeText) || (!currentStatus?.error ? ageText : '') || '';
    if (progress.hidden !== !progress.textContent) progress.hidden = !progress.textContent;
    const shouldTick = notice.isConnected && !isPanelHidden(panel) && !document.hidden && notice.getClientRects().length > 0 && hasGithubPollingCountdown(currentStatus, nowMs);
    if (!shouldTick && countdownTimer !== null) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (shouldTick && countdownTimer === null) countdownTimer = window.setInterval(updateCountdown, 1000);
  }

  function update(status: GithubPollingStatus | null): void {
    if (status !== currentStatus) outcomeText = '';
    currentStatus = status;
    button.disabled = isPending || !!status?.isRefreshing || !status?.configured;
    updateCountdown();
  }

  button.addEventListener('click', async () => {
    if (isPending) return;
    isPending = true;
    outcomeText = '';
    update(currentStatus);
    try {
      const responses = await Promise.all(lanes.map((refreshedLane) => sendControlRequest('github-polling-refresh', { lane: refreshedLane }, { timeoutMs: GITHUB_REFRESH_REPLY_TIMEOUT_MS })));
      const failedResponse = responses.find((response) => response.type === 'github-polling-refresh-result' && !response.ok);
      if (failedResponse?.type === 'github-polling-refresh-result') outcomeText = failedResponse.error ?? 'Could not refresh from GitHub.';
      if (!failedResponse && responses.some((response) => response.type === 'github-polling-refresh-result')) outcomeText = 'Refreshed.';
    } catch (error: unknown) {
      outcomeText = requestFailureText(error, GITHUB_REFRESH_REPLY_TIMEOUT_MS);
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
  const requestId = nextRequestId('my-pr-merge');
  const isSent = sendControlMsg({ type: 'my-pr-merge', requestId, repo: pr.repo, number: pr.number, headRefOid: pr.headRefOid });
  if (!isSent) {
    settleMerge(pr.key, pr.headRefOid, 'failed', NOT_CONNECTED_TEXT);
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
  const control = el('footer', 'pr-footer pr-decision-bar');
  const button = el('button', 'pr-action', 'Merge');
  button.type = 'button';
  button.disabled = state.isDisabled;
  const status = el('span', 'pr-action-status', state.statusText);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  paintActionStatus(status, state.tone, state.statusText);
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
  paintActionStatus(indicator, state.tone, state.statusText);
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
      toggle.errorsByKey.set(pr.key, requestFailureText(error, DEFAULT_REPLY_TIMEOUT_MS));
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
  if (hasGlyph) chip.append(createPrStatusIcon(stageIcon(pr.stage), stageTone(pr.stage)));
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

function createMineHeading(pr: MyPr): HTMLElement {
  const heading = el('div', 'pr-detail-heading');
  const title = el('div', 'pr-detail-title');
  title.append(externalLink('pr-link', pr.key, pr.url), el('h2', null, pr.title));
  const meta = el('p', 'pr-detail-meta');
  const mergedOrUpdated = pr.state === 'MERGED' ? `Merged ${formatAgo(Date.parse(pr.mergedAt ?? ''))}` : `Updated ${formatAgo(Date.parse(pr.updatedAt))}`;
  meta.append(el('span', 'pr-queue-owner', 'Yours'), stageChip(pr, { hasGlyph: true }), el('span', null, `Opened ${formatAgo(Date.parse(pr.createdAt))}`), el('span', null, mergedOrUpdated));
  heading.append(title, meta);
  return heading;
}

function createReadinessSection(pr: MyPr): HTMLElement | null {
  const readiness = readinessRows(pr, latest?.viewer ?? null);
  if (readiness.length === 0) return null;
  const section = el('section', 'pr-readiness-section');
  section.append(el('h3', 'pr-section-heading', 'Merge readiness'));
  const list = el('ul', 'pr-readiness');
  for (const readinessRow of readiness) {
    const item = el('li', 'pr-readiness-row');
    item.dataset.tone = readinessRow.tone;
    const value = el('span', 'pr-readiness-value');
    if (readinessRow.label === 'Review' && readinessRow.text.startsWith('Requested: ')) value.append(requestedReviewers(pr, readinessRow.text));
    if (value.childNodes.length === 0) value.textContent = readinessRow.text;
    if (readinessRow.items) {
      const items = el('ul', 'my-pr-facts');
      for (const name of readinessRow.items) items.append(el('li', null, name));
      value.append(items);
    }
    item.append(createPrStatusIcon(readinessRow.icon, readinessRow.tone), el('span', 'pr-readiness-label', readinessRow.label), value);
    list.append(item);
  }
  section.append(list);
  return section;
}

function createThreadsSection(headingText: string, threads: ReturnType<typeof threadRows>): HTMLElement | null {
  if (threads.length === 0) return null;
  const section = el('section', 'my-pr-threads-section');
  section.append(el('h3', 'pr-section-heading', headingText));
  const list = el('ul', 'my-pr-threads');
  for (const thread of threads) {
    const item = el('li', 'my-pr-thread');
    const heading = el('div', 'my-pr-thread-heading');
    heading.append(externalLink('my-pr-thread-location', thread.location, thread.url));
    if (thread.waiting) {
      const badge = el('span', 'my-pr-stage');
      badge.dataset.tone = thread.waiting.tone;
      badge.append(createPrStatusIcon(thread.waiting.icon, thread.waiting.tone), thread.waiting.text);
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
  return section;
}

function createReviewsSection(pr: MyPr): HTMLElement | null {
  const reviews = reviewRows(pr);
  if (reviews.length === 0) return null;
  const section = el('section', 'pr-readiness-section');
  section.append(el('h3', 'pr-section-heading', 'Reviews'));
  const list = el('ul', 'pr-readiness');
  for (const review of reviews) {
    const item = el('li', 'pr-readiness-row');
    const submittedAtMs = Date.parse(review.submittedAt ?? '');
    const when = Number.isFinite(submittedAtMs) ? `${review.text} ${formatAgo(submittedAtMs)}` : review.text;
    const reviewer = el('span', 'my-pr-reviewer');
    reviewer.append(createReviewerStack([{ login: review.reviewer, tone: review.tone, title: review.reviewer, url: review.reviewer === 'a deleted account' ? null : undefined }], 16), el('span', null, review.reviewer));
    item.append(createPrStatusIcon(review.icon, review.tone), reviewer, el('span', 'pr-readiness-value', when));
    list.append(item);
  }
  section.append(list);
  return section;
}

function createAutomationSection(pr: MyPr): HTMLElement | null {
  const toggleControls = [keepMergeableToggle, mergeWhenReadyToggle].map((toggle) => createToggleControl(pr, toggle)).filter((control) => control !== null);
  if (toggleControls.length === 0) return null;
  const section = el('section', 'my-pr-automation');
  section.append(el('h3', 'pr-section-heading', 'Automation'), ...toggleControls);
  return section;
}

function renderDetail(pr: MyPr | undefined): void {
  if (!detail) return;
  if (!pr) {
    detail.replaceChildren(el('p', 'pr-empty', emptyStateText(latest)));
    return;
  }
  const threads = threadRows(pr, latest?.viewer ?? null);
  const content = el('article', 'pr-detail');
  const sections = [
    createReadinessSection(pr),
    createThreadsSection('Threads waiting on you', threads.filter((thread) => thread.isWaitingOnYou)),
    createThreadsSection('Other open threads', threads.filter((thread) => !thread.isWaitingOnYou)),
    createReviewsSection(pr),
    createAutomationSection(pr),
    createMergeControl(pr),
  ];
  content.append(createMineHeading(pr), ...sections.filter((section) => section !== null));
  detail.replaceChildren(content);
}

function liveSessionLinks(): LiveSessionLinks[] {
  return [...sessionLinksById].flatMap(([id, links]) => {
    const ui = sessionUIs.get(id);
    if (!ui || links.length === 0) return [];
    return [{ id, title: sessionName(ui) || id, links }];
  });
}

function paintSessionPill(pill: HTMLElement): void {
  const sessionId = pill.dataset.sessionId ?? '';
  const ui = sessionUIs.get(sessionId);
  const nameElement = query(pill, '.session-row-name');
  if (ui) nameElement.textContent = sessionName(ui) || sessionId;
  const refs = { glyph: query(pill, '.session-row-glyph'), label: query(pill, '.session-row-label') };
  const stateLabel = paintSessionRowStatus(pill, refs, ui?.currentState || STATES.DORMANT, ui?.awaitingBackgroundTasks, ui?.pendingPromptKind);
  const accessibleLabel = `Focus session ${nameElement.textContent}, ${stateLabel}`;
  pill.title = accessibleLabel;
  pill.setAttribute('aria-label', accessibleLabel);
}

function createSessionPill(session: LinkedLiveSession): HTMLElement {
  const { row: pill, refs } = buildSessionRow('button', 'my-pr-session-pill');
  pill.type = 'button';
  pill.dataset.sessionId = session.id;
  refs.name.textContent = session.title;
  paintSessionPill(pill);
  pill.addEventListener('click', () => openTerminal?.(session.id));
  return pill;
}

function createSessionFocusControls(linkedSessions: readonly LinkedLiveSession[] | undefined): HTMLElement | null {
  if (!linkedSessions || linkedSessions.length === 0) return null;
  const controls = el('div', 'my-pr-session-focus');
  controls.append(...linkedSessions.map(createSessionPill));
  return controls;
}

export function refreshMyPrsSessionState(): void {
  for (const pill of document.querySelectorAll<HTMLElement>('.my-pr-session-pill')) paintSessionPill(pill);
}

function queueRender(): void {
  if (isRenderQueued) return;
  isRenderQueued = true;
  queueMicrotask(() => {
    isRenderQueued = false;
    render();
  });
}

export function setMyPrsSessionLinks(linksBySessionId: ReadonlyMap<string, readonly LinkedPr[]>): void {
  sessionLinksById = linksBySessionId;
  queueRender();
}

export function myPrsSnapshot(): { prs: MyPr[]; status: MyPrsStatus | null; sessionsByPrKey: Map<string, LinkedLiveSession[]> } {
  return { prs: joinMyPrs(latest?.prs ?? [], githubPrByKey), status: latest, sessionsByPrKey: liveSessionsByPrKey(liveSessionLinks()) };
}

export function createMyPrQueueRow(pr: MyPr, stackedOn: string | null, linkedSessions: readonly LinkedLiveSession[] | undefined): { group: HTMLElement; row: HTMLButtonElement } {
  const row = el('button', 'pr-queue-row');
  row.type = 'button';
  row.dataset.prKey = pr.key;
  row.title = `${pr.key}: ${stageLabel(pr.stage)}`;
  const glyph = el('span', 'pr-queue-glyph');
  glyph.append(createPrStatusIcon(stageIcon(pr.stage), stageTone(pr.stage)));
  const top = el('span', 'pr-queue-top');
  top.append(el('strong', 'pr-queue-ref', pr.key), el('span', 'pr-queue-title', pr.title));
  const bottom = el('span', 'pr-queue-bottom');
  bottom.append(el('span', 'pr-queue-owner', 'Yours'), stageChip(pr, { hasGlyph: false }));
  if (stackedOn) bottom.append(el('span', 'my-pr-stage', `Stacked on ${stackedOn}`));
  const mergedAt = pr.state === 'MERGED' ? pr.mergedAt : null;
  const ageText = mergedAt ? `merged ${formatAgo(Date.parse(mergedAt))}` : `opened ${formatAgo(Date.parse(pr.createdAt))}`;
  bottom.append(el('span', 'pr-queue-elapsed', ageText));
  const repairLabel = keepMergeableRowLabel(pr, keepMergeableToggle.isFeatureEnabled(latest), formatAgo(pr.keepMergeableAttempt?.at));
  if (repairLabel) {
    const repairChip = el('span', 'my-pr-stage', repairLabel.text);
    repairChip.dataset.tone = repairLabel.tone;
    repairChip.title = repairLabel.title;
    bottom.append(repairChip);
  }
  row.append(glyph, top, bottom);
  const group = el('div', 'my-pr-row-group');
  group.append(row);
  const sessionFocusControls = createSessionFocusControls(linkedSessions);
  if (sessionFocusControls) group.append(sessionFocusControls);
  return { group, row };
}

export function showMyPr(prKey: string): void {
  selectedKey = prKey;
  renderDetail(myPrsSnapshot().prs.find((pr) => pr.key === selectedKey));
}

function render(): void {
  const prs = joinMyPrs(latest?.prs ?? [], githubPrByKey);
  const mergedSinceLastRender = newlyMergedPrs(previousJoinedPrs, prs);
  previousJoinedPrs = prs;
  queueMergedPrCelebrations(mergedSinceLastRender);
  if (selectedKey) renderDetail(prs.find((pr) => pr.key === selectedKey));
  queueHooks?.onChange();
}

export function mountMyPrsDetail(hooks: { onChange: () => void }, navigation?: { openTerminal: (sessionId: string) => void }): HTMLElement {
  openTerminal = navigation?.openTerminal ?? null;
  queueHooks = hooks;
  if (detail) return detail;
  detail = el('div', 'pr-detail-mine');
  render();
  return detail;
}

export function applyMyPrsStatus(message: unknown): void {
  const parsed = parseMyPrsStatus(message);
  if (!parsed) return;
  latest = parsed;
  render();
}

function queueMergedPrCelebrations(mergedPrs: readonly MyPr[]): void {
  const uncelebratedPrs = mergedPrs.filter((pr) => !celebratedMergeKeys.has(pr.key));
  if (uncelebratedPrs.length === 0) return;
  for (const pr of uncelebratedPrs) celebratedMergeKeys.add(pr.key);
  queueMergeCelebration(mergeCelebrationText(uncelebratedPrs));
}

export function applyMyPrsConnectionState(isConnected: boolean): void {
  if (isConnected) return;
  for (const [key, pending] of pendingMergeRequests) {
    window.clearTimeout(pending.timer);
    mergeAttempts.set(key, { head: pending.head, phase: 'failed', text: MERGE_DISCONNECTED_TEXT });
  }
  if (pendingMergeRequests.size === 0) return;
  pendingMergeRequests.clear();
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
  if (mergeResult.kind !== 'merged') return;
  const mergedPr = joinMyPrs(latest?.prs ?? [], githubPrByKey).find((pr) => pr.key === mergeResult.key);
  if (mergedPr) queueMergedPrCelebrations([mergedPr]);
}

subscribeGithubPrs(queueRender);
