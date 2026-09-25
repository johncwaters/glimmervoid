import { TeamReviewStatus } from '#shared/contracts/team-review.ts';
import type { FindingSeverity, InFlightReview, ReviewComment, ReviewDraft, TeamReviewAction, TeamReviewStatus as TeamReviewStatusType } from '#shared/contracts/team-review.ts';
import { createAttentionAck } from './attention-ack-core.ts';
import { sendControlMsg } from './control-ws.ts';
import { el, externalLink, isPanelHidden } from './dom-helpers.ts';
import { createPollAgoTicker } from './poll-ago.ts';
import { formatTrailOffset } from './radar-core.ts';
import { createSettingsLink } from './settings-link.ts';
import {
  TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID,
  actionOutcomeText, actionProgressText, attentionDetail, attentionStatusLabel, buildActionRequest, chooseSelectedReviewKey,
  commentLocation, emptyStateText, groupDrafts, hasAnyRow, inFlightElapsedText, inFlightProgressText, isInFlightProgressOnlyChange,
  parseReviewComment, phaseLabel, pullRequestLabel, readyAttentionSignature, readyRowSignature, reviewFooterText,
  reviewProgressSteps, severityCounts, severityPresentation, tierLabel, verdictLabel, verdictSealKind, verdictTone,
} from './team-review-view-core.ts';
import type { TeamReviewSections } from './team-review-view-core.ts';
import { getPrsAttentionAck, setPrsAttentionAck } from './ui-prefs.ts';

const ACTION_REPLY_TIMEOUT_MS = 120000;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SHARD_PATH = 'M4.5 0.5L8.5 5.5L4.5 10.5L0.5 5.5Z';

interface ActionDetailHandle {
  signature: string;
  element: HTMLElement;
  settle: (isDone: boolean, text: string) => void;
}

interface PendingAction {
  requestId: string;
  action: TeamReviewAction;
  timer: number;
}

let _latest: TeamReviewStatusType | null = null;
let _root: HTMLDivElement | null = null;
let _header: HTMLElement | null = null;
let _queue: HTMLElement | null = null;
let _detail: HTMLElement | null = null;
let _inReviewSection: HTMLElement | null = null;
let _selectedKey: string | null = null;
let _renderedDetailSignature: string | null = null;
let _activityCallback: ((isActive: boolean) => void) | null = null;
const _progressTicker = createPollAgoTicker(() => _root);
const _readyDetails = new Map<string, ActionDetailHandle>();
const _errorDetails = new Map<string, ActionDetailHandle>();
const _pendingActions = new Map<string, PendingAction>();
const _attention = createAttentionAck({
  getAck: getPrsAttentionAck,
  setAck: setPrsAttentionAck,
  signature: () => readyAttentionSignature(_latest),
  isLooking: () => !isPanelHidden(_root),
});

function svgShape(tag: string, attributes: Record<string, string>): SVGElement {
  const shape = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
  return shape;
}

function svgIcon(width: number, height: number): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('width', String(width));
  icon.setAttribute('height', String(height));
  icon.setAttribute('viewBox', `0 0 ${width} ${height}`);
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function createSeverityMeter(severity: FindingSeverity): HTMLElement {
  const presentation = severityPresentation(severity);
  const meter = el('span', 'pr-severity-meter');
  meter.setAttribute('role', 'img');
  meter.setAttribute('aria-label', `${severity.toLowerCase()} severity`);
  meter.style.color = `var(${presentation.colorToken})`;
  if (severity === 'CRITICAL') {
    const halo = svgIcon(14, 17);
    halo.classList.add('pr-severity-halo');
    halo.setAttribute('viewBox', '0 0 9 11');
    halo.append(svgShape('path', { d: SHARD_PATH, fill: 'currentColor' }));
    meter.append(halo);
  }
  for (let index = 0; index < 3; index += 1) {
    const pip = svgIcon(9, 11);
    const isFilled = index < presentation.filledCount;
    pip.append(svgShape('path', { d: SHARD_PATH, fill: isFilled ? 'currentColor' : 'none', stroke: isFilled ? 'currentColor' : 'var(--border-hover)', 'stroke-width': '1' }));
    meter.append(pip);
  }
  return meter;
}

function createVerdictSeal(verdict: ReviewDraft['verdict']): HTMLElement {
  const seal = el('span', 'pr-verdict-seal');
  seal.dataset.tone = verdictTone(verdict);
  const icon = svgIcon(20, 20);
  const kind = verdictSealKind(verdict);
  icon.append(svgShape('circle', { cx: '10', cy: '10', r: '8.5', fill: kind === 'cross' ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': '1.5' }));
  if (kind === 'check') icon.append(svgShape('path', { d: 'M6 10.5L8.7 13L14 7.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  if (kind === 'dot') icon.append(svgShape('circle', { cx: '10', cy: '10', r: '2.4', fill: 'currentColor' }));
  if (kind === 'bar') icon.append(svgShape('path', { d: 'M6 10H14', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }));
  if (kind === 'cross') icon.append(svgShape('path', { d: 'M7 7L13 13M13 7L7 13', stroke: 'var(--bg)', 'stroke-width': '1.8', 'stroke-linecap': 'round' }));
  seal.append(icon, el('span', null, verdictLabel(verdict)));
  return seal;
}

function createQuestionGlyph(): SVGSVGElement {
  const icon = svgIcon(16, 16);
  icon.append(svgShape('rect', { x: '1', y: '1', width: '14', height: '14', rx: '2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' }));
  icon.append(svgShape('path', { d: 'M6 6.2C6 4.9 7 4.2 8 4.2C9.1 4.2 10 5 10 6C10 7.4 8 7.4 8 9.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round' }));
  icon.append(svgShape('circle', { cx: '8', cy: '11.6', r: '0.9', fill: 'currentColor' }));
  return icon;
}

function createBodyGlyph(): SVGSVGElement {
  const icon = svgIcon(14, 14);
  icon.append(svgShape('path', { d: 'M2 3.5H12M2 7H12M2 10.5H8', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' }));
  return icon;
}

function createSeverityCounts(draft: ReviewDraft, isCompact = false): HTMLElement {
  const counts = el('span', 'pr-severity-counts');
  for (const { severity, count } of severityCounts(draft)) {
    const item = el('span', 'pr-severity-count');
    item.append(createSeverityMeter(severity), el('span', null, isCompact ? String(count) : `${count} ${severity.toLowerCase()}`));
    counts.append(item);
  }
  return counts;
}

function pullRequestLink(review: Pick<ReviewDraft, 'repo' | 'number' | 'url'>): HTMLElement {
  return externalLink('pr-link', pullRequestLabel(review.repo, review.number), review.url);
}

function createQueueRow(review: ReviewDraft | InFlightReview, kind: 'ready' | 'inReview' | 'attention' | 'posted'): HTMLButtonElement {
  const row = el('button', 'pr-queue-row');
  row.type = 'button';
  row.dataset.reviewKey = review.key;
  row.setAttribute('aria-current', String(review.key === _selectedKey));
  const top = el('span', 'pr-queue-top');
  top.append(el('strong', 'pr-queue-ref', pullRequestLabel(review.repo, review.number)), el('span', 'pr-queue-title', review.title));
  const bottom = el('span', 'pr-queue-bottom');
  if (kind === 'inReview') {
    const inFlight = review as InFlightReview;
    bottom.append(el('span', 'pr-phase-label', phaseLabel(inFlight.phase)), el('span', 'pr-queue-author', inFlight.author));
    const elapsed = el('span', 'pr-queue-elapsed');
    _progressTicker.track(elapsed, inFlight.startedAt, () => inFlightElapsedText(inFlight, Date.now()));
    bottom.append(elapsed);
  }
  if (kind === 'ready') {
    const draft = review as ReviewDraft;
    bottom.append(createVerdictSeal(draft.verdict), el('span', 'pr-queue-author', draft.author), createSeverityCounts(draft, true));
  }
  if (kind === 'attention') {
    const draft = review as ReviewDraft;
    bottom.append(el('span', `pr-attention-label pr-attention-label-${draft.status}`, attentionStatusLabel(draft.status)), el('span', 'pr-queue-author', draft.author), el('span', 'pr-queue-reason', attentionDetail(draft)));
  }
  if (kind === 'posted') {
    const draft = review as ReviewDraft;
    bottom.append(createVerdictSeal(draft.verdict), el('span', 'pr-queue-author', draft.author));
  }
  row.append(top, bottom);
  row.addEventListener('click', () => {
    _selectedKey = review.key;
    for (const button of _queue?.querySelectorAll<HTMLButtonElement>('button[data-review-key]') ?? []) button.setAttribute('aria-current', String(button.dataset.reviewKey === _selectedKey));
    renderSelectedDetail(groupDrafts(_latest));
    if (document.documentElement.dataset.layout === 'phone') _detail?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  return row;
}

function createQueueSection(title: string, reviews: (ReviewDraft | InFlightReview)[], kind: 'ready' | 'inReview' | 'attention' | 'posted'): HTMLElement {
  const section = el('section', 'pr-queue-section');
  section.append(el('h3', 'pr-section-heading', `${title} ${reviews.length}`));
  for (const review of reviews) section.append(createQueueRow(review, kind));
  return section;
}

function createHeader(sections: TeamReviewSections): HTMLElement {
  const header = el('header', 'pr-header');
  header.append(el('h2', 'pr-header-title', 'PR reviews'));
  const counts = el('div', 'pr-header-counts');
  for (const [count, label, tone] of [
    [sections.ready.length, 'ready', 'ready'],
    [sections.inReview.length, 'in review', 'review'],
    [sections.attention.length, 'needs attention', 'attention'],
  ] as const) {
    const item = el('span', 'pr-header-count');
    const number = el('strong', null, String(count));
    number.dataset.tone = tone;
    item.append(number, ` ${label}`);
    counts.append(item);
  }
  header.append(counts);
  return header;
}

function createDetailHeading(review: ReviewDraft | InFlightReview): HTMLElement {
  const heading = el('div', 'pr-detail-heading');
  const title = el('div', 'pr-detail-title');
  title.append(pullRequestLink(review), el('h2', null, review.title));
  const metadata = el('div', 'pr-detail-meta');
  metadata.append(el('span', null, review.author));
  const reasons = review.reasons.join(', ');
  metadata.append(el('span', null, reasons ? `${tierLabel(review.tier)} review: ${reasons}` : `${tierLabel(review.tier)} review`));
  const head = 'reviewedHead' in review ? review.reviewedHead : review.head;
  metadata.append(el('span', null, `${'reviewedHead' in review ? 'reviewed at' : 'head'} ${head.slice(0, 7)}`));
  heading.append(title, metadata);
  return heading;
}

function createCommentParagraph(paragraph: ReturnType<typeof parseReviewComment>['paragraphs'][number]): HTMLElement {
  const element = el('p', 'pr-comment-paragraph');
  if (paragraph.lead) {
    const lead = el('strong', `pr-comment-lead pr-comment-lead-${paragraph.leadKind}`);
    if (paragraph.leadKind === 'question') lead.append(createQuestionGlyph());
    lead.append(paragraph.lead);
    element.append(lead, ' ');
  }
  for (const segment of paragraph.segments) element.append(segment.isCode ? el('code', null, segment.text) : document.createTextNode(segment.text));
  return element;
}

function createInlineComment(comment: ReviewComment, index: number, includedIndexes: Set<number>, updateFooter: () => void): HTMLElement {
  const card = el('article', 'pr-comment-card');
  const checkbox = el('input', 'pr-comment-checkbox');
  checkbox.type = 'checkbox';
  checkbox.checked = includedIndexes.has(index);
  checkbox.setAttribute('aria-label', `Include comment on ${commentLocation(comment)}`);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) includedIndexes.add(index);
    if (!checkbox.checked) includedIndexes.delete(index);
    card.dataset.included = String(checkbox.checked);
    updateFooter();
  });
  card.dataset.included = String(checkbox.checked);
  const content = el('div', 'pr-comment-content');
  const header = el('div', 'pr-comment-header');
  const parsed = parseReviewComment(comment.body);
  if (parsed.severity && parsed.tag) {
    const finding = el('span', 'pr-comment-finding');
    finding.style.color = `var(${severityPresentation(parsed.severity).colorToken})`;
    finding.append(createSeverityMeter(parsed.severity), el('strong', null, `[${parsed.tag}] ${parsed.severity}`));
    header.append(finding);
  }
  header.append(el('span', 'pr-comment-location', commentLocation(comment)));
  content.append(header);
  for (const paragraph of parsed.paragraphs) content.append(createCommentParagraph(paragraph));
  card.append(checkbox, content);
  return card;
}

const ACTION_BUTTONS: readonly { label: string; action: TeamReviewAction }[] = [
  { label: 'Approve', action: 'approve' },
  { label: 'Comment', action: 'comment' },
  { label: 'Discard', action: 'discard' },
];

function sendAction(draft: ReviewDraft, action: TeamReviewAction, body: string, comments: ReviewComment[], settle: (isDone: boolean, text: string) => void): boolean {
  const requestId = `team-review-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const isSent = sendControlMsg({ type: 'team-review-action', requestId, ...buildActionRequest(draft, action, body, comments) });
  if (!isSent) return false;
  const timer = window.setTimeout(() => {
    _pendingActions.delete(draft.key);
    settle(false, 'No reply from the server. Check GitHub before trying again.');
  }, ACTION_REPLY_TIMEOUT_MS);
  _pendingActions.set(draft.key, { requestId, action, timer });
  return true;
}

function createReadyDetail(draft: ReviewDraft): ActionDetailHandle {
  const detail = el('article', 'pr-detail');
  detail.append(createDetailHeading(draft));
  const verdict = el('section', 'pr-verdict-box');
  verdict.setAttribute('aria-label', 'Verdict');
  const verdictLine = el('div', 'pr-verdict-line');
  verdictLine.append(createVerdictSeal(draft.verdict), createSeverityCounts(draft));
  verdict.append(verdictLine, el('p', 'pr-verdict-summary', draft.summary));
  detail.append(verdict);

  const posts = el('section', 'pr-posts');
  posts.setAttribute('aria-label', 'What posts to GitHub');
  const heading = el('div', 'pr-posts-heading');
  heading.append(el('h3', null, 'Posts to GitHub'), el('span', null, 'Each inline comment opens with the automated-review note.'));
  posts.append(heading);
  const bodyLabel = el('label', 'pr-body-label');
  const bodyTitle = el('span', 'pr-body-title');
  bodyTitle.append(createBodyGlyph(), 'Review body');
  const bodyInput = el('textarea', 'pr-body-input');
  bodyInput.value = draft.body;
  bodyInput.rows = Math.min(10, Math.max(3, draft.body.split('\n').length + 1));
  bodyInput.spellcheck = true;
  bodyLabel.append(bodyTitle, bodyInput);
  posts.append(bodyLabel);

  const includedIndexes = new Set(draft.comments.map((_comment, index) => index));
  const footer = el('footer', 'pr-footer');
  const status = el('span', 'pr-action-status', reviewFooterText(draft.reviewedHead, includedIndexes.size));
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const updateFooter = () => {
    if (_pendingActions.has(draft.key) || status.dataset.tone === 'ok') return;
    status.textContent = reviewFooterText(draft.reviewedHead, includedIndexes.size);
    delete status.dataset.tone;
  };
  for (const [index, comment] of draft.comments.entries()) posts.append(createInlineComment(comment, index, includedIndexes, updateFooter));
  detail.append(posts);
  const buttons: HTMLButtonElement[] = [];
  const setBusy = (isBusy: boolean) => {
    for (const button of buttons) button.disabled = isBusy;
    detail.dataset.busy = String(isBusy);
  };
  const settle = (isDone: boolean, text: string) => {
    setBusy(isDone);
    status.dataset.tone = isDone ? 'ok' : 'error';
    status.textContent = text;
  };
  for (const { label, action } of ACTION_BUTTONS) {
    const button = el('button', 'pr-action', label);
    button.type = 'button';
    button.dataset.action = action;
    button.addEventListener('click', () => {
      if (_pendingActions.has(draft.key)) return;
      setBusy(true);
      status.dataset.tone = 'busy';
      status.textContent = actionProgressText(action);
      const comments = draft.comments.filter((_comment, index) => includedIndexes.has(index));
      if (sendAction(draft, action, bodyInput.value, comments, settle)) return;
      settle(false, 'Not connected to the server.');
    });
    buttons.push(button);
  }
  footer.append(...buttons, status);
  detail.append(footer);
  return { signature: readyRowSignature(draft), element: detail, settle };
}

function readyDetailFor(draft: ReviewDraft): HTMLElement {
  const cached = _readyDetails.get(draft.key);
  if (cached?.signature === readyRowSignature(draft)) return cached.element;
  const handle = createReadyDetail(draft);
  _readyDetails.set(draft.key, handle);
  return handle.element;
}

function createInReviewDetail(review: InFlightReview): HTMLElement {
  const detail = el('article', 'pr-detail');
  detail.append(createDetailHeading(review));
  const progress = el('section', 'pr-progress');
  progress.setAttribute('aria-label', 'Review progress');
  const tracker = el('ol', 'pr-progress-tracker');
  for (const step of reviewProgressSteps(review.phase)) {
    const item = el('li', 'pr-progress-stage');
    item.dataset.state = step.state;
    item.append(el('span', 'pr-progress-bar'), el('span', null, step.label));
    tracker.append(item);
  }
  const progressText = el('div', 'pr-progress-text');
  _progressTicker.track(progressText, review.startedAt, () => inFlightProgressText(review, Date.now()));
  progress.append(tracker, progressText);
  detail.append(progress);
  const steps = el('section', 'pr-steps');
  steps.append(el('h3', null, 'Latest agent steps'));
  const list = el('ol', 'pr-step-list');
  for (const step of review.recentSteps) {
    const item = el('li', 'pr-step');
    const description = el('span', 'pr-step-detail', step.detail);
    description.title = step.detail;
    item.append(el('span', 'pr-step-at', formatTrailOffset(review.startedAt, step.at)), el('span', 'pr-step-tool', step.tool), description);
    list.append(item);
  }
  steps.append(list);
  detail.append(steps);
  return detail;
}

function createOtherDetail(draft: ReviewDraft): HTMLElement {
  const detail = el('article', 'pr-detail');
  detail.append(createDetailHeading(draft));
  if (draft.status === 'posted') {
    const verdict = el('section', 'pr-verdict-box');
    verdict.append(createVerdictSeal(draft.verdict), el('p', 'pr-verdict-summary', draft.summary));
    detail.append(verdict);
    return detail;
  }
  detail.append(el('p', 'pr-attention-detail', attentionDetail(draft)));
  if (draft.status !== 'error') return detail;
  const footer = el('footer', 'pr-footer');
  const button = el('button', 'pr-action', 'Queue review');
  button.type = 'button';
  button.dataset.action = 'requeue';
  const status = el('span', 'pr-action-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const settle = (isDone: boolean, message: string) => {
    button.disabled = isDone;
    status.dataset.tone = isDone ? 'ok' : 'error';
    status.textContent = message;
  };
  button.addEventListener('click', () => {
    if (_pendingActions.has(draft.key)) return;
    button.disabled = true;
    status.dataset.tone = 'busy';
    status.textContent = actionProgressText('requeue');
    if (sendAction(draft, 'requeue', '', [], settle)) return;
    settle(false, 'Not connected to the server.');
  });
  footer.append(button, status);
  detail.append(footer);
  _errorDetails.set(draft.key, { signature: `${draft.status}:${draft.reviewedHead}:${draft.error ?? ''}`, element: detail, settle });
  return detail;
}

function otherDetailFor(draft: ReviewDraft): HTMLElement {
  if (draft.status !== 'error') return createOtherDetail(draft);
  const cached = _errorDetails.get(draft.key);
  if (cached && (_pendingActions.has(draft.key) || cached.signature === `${draft.status}:${draft.reviewedHead}:${draft.error ?? ''}`)) return cached.element;
  return createOtherDetail(draft);
}

function renderSelectedDetail(sections: TeamReviewSections): void {
  if (!_detail) return;
  _selectedKey = chooseSelectedReviewKey(sections, _selectedKey);
  const ready = sections.ready.find((draft) => draft.key === _selectedKey);
  if (ready) {
    const signature = `ready:${readyRowSignature(ready)}`;
    if (_renderedDetailSignature === signature) return;
    _detail.replaceChildren(readyDetailFor(ready));
    _renderedDetailSignature = signature;
    return;
  }
  const inReview = sections.inReview.find((review) => review.key === _selectedKey);
  if (inReview) {
    _detail.replaceChildren(createInReviewDetail(inReview));
    _renderedDetailSignature = `inReview:${inReview.key}`;
    return;
  }
  const other = [...sections.attention, ...sections.posted].find((draft) => draft.key === _selectedKey);
  if (!other) return;
  _detail.replaceChildren(otherDetailFor(other));
  _renderedDetailSignature = `${other.status}:${other.key}`;
}

function buildEmptyState(): HTMLElement {
  const empty = el('p', 'pr-empty', emptyStateText(_latest));
  if (_latest && !_latest.configured) empty.append(' ', createSettingsLink(TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID, 'Open Team review settings'));
  return empty;
}

function forgetDepartedDetails(readyKeys: Set<string>): void {
  for (const key of [..._readyDetails.keys()]) {
    if (readyKeys.has(key) || _pendingActions.has(key)) continue;
    _readyDetails.delete(key);
  }
  const errorKeys = new Set(_latest?.drafts.filter((draft) => draft.status === 'error').map((draft) => draft.key) ?? []);
  for (const key of _errorDetails.keys()) {
    if (errorKeys.has(key) || _pendingActions.has(key)) continue;
    _errorDetails.delete(key);
  }
}

function ensureShell(): void {
  if (!_root || _queue?.isConnected) return;
  _header = el('div', 'pr-header-host');
  _queue = el('nav', 'pr-queue');
  _queue.setAttribute('aria-label', 'Review queue');
  _detail = el('main', 'pr-detail-host');
  const columns = el('div', 'pr-columns');
  columns.append(_queue, _detail);
  _root.replaceChildren(_header, columns);
  _renderedDetailSignature = null;
}

function focusedQueueReviewKey(): string | null {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !_queue?.contains(focused)) return null;
  return focused.dataset.reviewKey ?? null;
}

function restoreQueueFocus(reviewKey: string | null): void {
  if (!reviewKey || !_queue) return;
  const rows = _queue.querySelectorAll<HTMLButtonElement>('button[data-review-key]');
  [...rows].find((row) => row.dataset.reviewKey === reviewKey)?.focus({ preventScroll: true });
}

function render(): void {
  if (!_root) return;
  const focusedReviewKey = focusedQueueReviewKey();
  const sections = groupDrafts(_latest);
  forgetDepartedDetails(new Set(sections.ready.map((draft) => draft.key)));
  _progressTicker.reset();
  if (!_latest?.configured || !hasAnyRow(sections)) {
    _root.replaceChildren(buildEmptyState());
    _header = null;
    _queue = null;
    _detail = null;
    _inReviewSection = null;
    _renderedDetailSignature = null;
    return;
  }
  ensureShell();
  if (!_header || !_queue) return;
  _selectedKey = chooseSelectedReviewKey(sections, _selectedKey);
  _header.replaceChildren(createHeader(sections));
  const queueSections: HTMLElement[] = [];
  if (sections.ready.length) queueSections.push(createQueueSection('Ready', sections.ready, 'ready'));
  if (sections.inReview.length) {
    _inReviewSection = createQueueSection('In review', sections.inReview, 'inReview');
    queueSections.push(_inReviewSection);
  }
  if (sections.attention.length) queueSections.push(createQueueSection('Needs attention', sections.attention, 'attention'));
  if (sections.posted.length) queueSections.push(createQueueSection('Recently posted', sections.posted, 'posted'));
  _queue.replaceChildren(...queueSections);
  restoreQueueFocus(focusedReviewKey);
  renderSelectedDetail(sections);
}

function refreshActivity(): void {
  if (_activityCallback) _activityCallback(_attention.refresh());
}

export function acknowledgeTeamReviewAttention(): void {
  _attention.acknowledge();
  refreshActivity();
}

export function setTeamReviewActivityCallback(callback: (isActive: boolean) => void): void {
  _activityCallback = callback;
  refreshActivity();
}

export function mountTeamReviewView(parent: HTMLElement): HTMLDivElement {
  if (_root) return _root;
  _root = el('div', 'pr-content');
  parent.append(_root);
  _progressTicker.ensure();
  render();
  return _root;
}

export function applyTeamReviewStatus(message: unknown): void {
  const parsed = TeamReviewStatus.safeParse(message);
  if (!parsed.success) return;
  const previous = _latest;
  _latest = parsed.data;
  if (isInFlightProgressOnlyChange(previous, parsed.data) && replaceInReviewSection()) return;
  render();
  refreshActivity();
}

function replaceInReviewSection(): boolean {
  if (!_latest || !_inReviewSection?.isConnected) return false;
  _progressTicker.reset();
  const focusedReviewKey = focusedQueueReviewKey();
  const sections = groupDrafts(_latest);
  const replacement = createQueueSection('In review', sections.inReview, 'inReview');
  _inReviewSection.replaceWith(replacement);
  _inReviewSection = replacement;
  restoreQueueFocus(focusedReviewKey);
  if (sections.inReview.some((review) => review.key === _selectedKey)) renderSelectedDetail(sections);
  return true;
}

export function applyTeamReviewActionResult(message: unknown): void {
  if (!message || typeof message !== 'object') return;
  const actionResult = message as { key?: unknown; requestId?: unknown; ok?: unknown; error?: unknown; warning?: unknown };
  if (typeof actionResult.key !== 'string') return;
  const pending = _pendingActions.get(actionResult.key);
  if (!pending || pending.requestId !== actionResult.requestId) return;
  window.clearTimeout(pending.timer);
  _pendingActions.delete(actionResult.key);
  const handle = pending.action === 'requeue' ? _errorDetails.get(actionResult.key) : _readyDetails.get(actionResult.key);
  if (!handle) return;
  if (actionResult.ok === true) {
    if (pending.action === 'requeue') _errorDetails.delete(actionResult.key);
    handle.settle(true, typeof actionResult.warning === 'string' && actionResult.warning ? `${actionOutcomeText(pending.action)}. ${actionResult.warning}` : actionOutcomeText(pending.action));
    return;
  }
  handle.settle(false, typeof actionResult.error === 'string' && actionResult.error ? actionResult.error : 'The action failed.');
}
