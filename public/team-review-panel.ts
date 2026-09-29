import { TeamReviewStatus } from '#shared/contracts/team-review.ts';
import type { FindingSeverity, InFlightReview, ReviewComment, ReviewDraft, TeamReviewAction, TeamReviewStatus as TeamReviewStatusType } from '#shared/contracts/team-review.ts';
import { createAttentionAck } from './attention-ack-core.ts';
import { sendControlMsg } from './control-ws.ts';
import { el, externalLink, isPanelHidden } from './dom-helpers.ts';
import { createPollAgoTicker, formatAgo } from './poll-ago.ts';
import { createPrQueueColumns, createPrQueueHead } from './pr-queue-columns.ts';
import { createStateGlyph, createSvgIcon as svgIcon, createSvgShape as svgShape } from './state-glyph.ts';
import { formatTrailOffset } from './radar-core.ts';
import { createSettingsLink } from './settings-link.ts';
import {
  TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID,
  actionOutcomeText, actionProgressText, attentionDetail, attentionStatusLabel, buildActionRequest, chooseSelectedReviewKey,
  commentLocation, emptyStateText, githubReviewItems, groupDrafts, parseInlineSegments, hasAnyRow, LEGACY_SUMMARY_HINT, hasRequeueFooter, inFlightElapsedText, inFlightProgressText, isInFlightProgressOnlyChange,
  parseReviewComment, phaseLabel, pullRequestLabel, queueRowStateLabel, queueRowTone, readyAttentionSignature, readyRowSignature, detailHeadingSignature, reviewFooterText,
  reviewProgressSteps, severityCounts, severityPresentation, tierLabel, verdictLabel, verdictSealKind, verdictSealText, verdictTone, withReviewerNote,
} from './team-review-view-core.ts';
import type { QueueRowKind, TeamReviewSections } from './team-review-view-core.ts';
import { getPrsAttentionAck, setPrsAttentionAck } from './ui-prefs.ts';

const ACTION_REPLY_TIMEOUT_MS = 120000;
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
let _scopeTabs: HTMLElement | null = null;
let _queue: HTMLElement | null = null;
let _detail: HTMLElement | null = null;
let _inReviewSection: HTMLElement | null = null;
let _selectedKey: string | null = null;
let _renderedDetailSignature: string | null = null;
let _activityCallback: ((isActive: boolean) => void) | null = null;
const _progressTicker = createPollAgoTicker(() => _root);
const _ageTicker = createPollAgoTicker(() => _root);
const _readyDetails = new Map<string, ActionDetailHandle>();
const _requeueDetails = new Map<string, ActionDetailHandle>();
const _pendingActions = new Map<string, PendingAction>();
const _attention = createAttentionAck({
  getAck: getPrsAttentionAck,
  setAck: setPrsAttentionAck,
  signature: () => readyAttentionSignature(_latest),
  isLooking: () => !isPanelHidden(_root),
});

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

function createVerdictSeal(draft: ReviewDraft): HTMLElement {
  const { verdict } = draft;
  const seal = el('span', 'pr-verdict-seal');
  seal.dataset.tone = verdictTone(verdict);
  const icon = svgIcon(20, 20);
  const kind = verdictSealKind(verdict);
  icon.append(svgShape('circle', { cx: '10', cy: '10', r: '8.5', fill: kind === 'cross' ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': '1.5' }));
  if (kind === 'check') icon.append(svgShape('path', { d: 'M6 10.5L8.7 13L14 7.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  if (kind === 'dot') icon.append(svgShape('circle', { cx: '10', cy: '10', r: '2.4', fill: 'currentColor' }));
  if (kind === 'bar') icon.append(svgShape('path', { d: 'M6 10H14', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }));
  if (kind === 'cross') icon.append(svgShape('path', { d: 'M7 7L13 13M13 7L7 13', stroke: 'var(--bg)', 'stroke-width': '1.8', 'stroke-linecap': 'round' }));
  seal.append(icon, el('span', null, verdictSealText(draft)));
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

function ageTimestamp(timestamp: number | string | null | undefined): number | null {
  const at = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  return at;
}

function createAgeReadout(label: string, timestamp: number | string | null | undefined): HTMLElement | null {
  const at = ageTimestamp(timestamp);
  if (at === null) return null;
  const readout = el('span', null, `${label}${label ? ' ' : ''}${formatAgo(at)}`);
  readout.dataset.ageAt = String(at);
  readout.dataset.ageLabel = label;
  return readout;
}

function trackAges(root: Element | null): void {
  if (!root) return;
  for (const readout of root.querySelectorAll<HTMLElement>('[data-age-at]')) {
    const at = Number(readout.dataset.ageAt);
    const label = readout.dataset.ageLabel ?? '';
    _ageTicker.track(readout, at, () => `${label}${label ? ' ' : ''}${formatAgo(at)}`);
  }
}

function createGithubReviewSummary(draft: ReviewDraft, className: string, isViewerShown = true): HTMLElement | null {
  const reviews = githubReviewItems(draft, { isViewerShown });
  if (reviews.length === 0) return null;
  const summary = el('span', className);
  summary.append('GitHub: ');
  for (const [index, review] of reviews.entries()) {
    if (index > 0) summary.append(', ');
    summary.append(review.text);
    const age = createAgeReadout('', review.submittedAt);
    if (age) summary.append(' (', age, ')');
  }
  return summary;
}

function createQueueRow(review: ReviewDraft | InFlightReview, kind: QueueRowKind): HTMLButtonElement {
  const row = el('button', 'pr-queue-row');
  row.type = 'button';
  row.dataset.reviewKey = review.key;
  row.setAttribute('aria-current', String(review.key === _selectedKey));
  const reviewStatus = 'status' in review ? review.status : null;
  row.title = `${pullRequestLabel(review.repo, review.number)}: ${queueRowStateLabel(kind, reviewStatus)}`;
  const glyph = el('span', 'pr-queue-glyph');
  glyph.append(createStateGlyph(queueRowTone(kind, reviewStatus)));
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
  if (kind === 'ready' || kind === 'settled') {
    const draft = review as ReviewDraft;
    bottom.append(createVerdictSeal(draft), el('span', 'pr-queue-author', draft.author), createSeverityCounts(draft, true));
  }
  if (kind === 'attention' || kind === 'discarded') {
    const draft = review as ReviewDraft;
    bottom.append(el('span', `pr-attention-label pr-attention-label-${draft.status}`, attentionStatusLabel(draft.status)), el('span', 'pr-queue-author', draft.author), el('span', 'pr-queue-reason', attentionDetail(draft)));
  }
  if (kind === 'posted') {
    const draft = review as ReviewDraft;
    bottom.append(el('span', 'pr-attention-label pr-attention-label-posted', 'posted'), el('span', 'pr-queue-author', draft.author));
    bottom.append(el('span', 'pr-queue-posted-detail', verdictLabel(draft.verdict)));
  }
  const ages = el('span', 'pr-queue-github');
  const openedAge = createAgeReadout('opened', review.prCreatedAt);
  if (openedAge) ages.append(openedAge);
  if ('reviewedHead' in review) {
    const reviewedAge = createAgeReadout('reviewed', review.reviewedAt);
    if (reviewedAge) ages.append(ages.childNodes.length ? ', ' : '', reviewedAge);
    const postedAge = createAgeReadout('posted', review.postedAt);
    if (postedAge) ages.append(ages.childNodes.length ? ', ' : '', postedAge);
  }
  row.append(glyph, top, bottom);
  const githubSummary = kind === 'inReview' ? null : createGithubReviewSummary(review as ReviewDraft, 'pr-queue-github', kind !== 'posted');
  if (githubSummary) ages.append(ages.childNodes.length ? ' | ' : '', ...githubSummary.childNodes);
  if (ages.childNodes.length) row.append(ages);
  row.addEventListener('click', () => {
    _selectedKey = review.key;
    for (const button of _queue?.querySelectorAll<HTMLButtonElement>('button[data-review-key]') ?? []) button.setAttribute('aria-current', String(button.dataset.reviewKey === _selectedKey));
    renderSelectedDetail(groupDrafts(_latest));
    _ageTicker.reset();
    trackAges(_root);
    if (document.documentElement.dataset.layout === 'phone') _detail?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  return row;
}

function createQueueSection(title: string, reviews: (ReviewDraft | InFlightReview)[], kind: QueueRowKind): HTMLElement {
  const section = el('section', 'pr-queue-section');
  section.append(el('h3', 'pr-section-heading', `${title} ${reviews.length}`));
  for (const review of reviews) section.append(createQueueRow(review, kind));
  return section;
}

function createDetailHeading(review: ReviewDraft | InFlightReview): HTMLElement {
  const heading = el('div', 'pr-detail-heading');
  heading.dataset.signature = detailHeadingSignature(review);
  const title = el('div', 'pr-detail-title');
  title.append(pullRequestLink(review), el('h2', null, review.title));
  const metadata = el('div', 'pr-detail-meta');
  metadata.append(el('span', null, review.author));
  const reasons = review.reasons.join(', ');
  metadata.append(el('span', null, reasons ? `${tierLabel(review.tier)} review: ${reasons}` : `${tierLabel(review.tier)} review`));
  const openedAge = createAgeReadout('Opened', review.prCreatedAt);
  if (openedAge) metadata.append(openedAge);
  if ('reviewedHead' in review) {
    const reviewedAge = createAgeReadout('Reviewed', review.reviewedAt);
    if (reviewedAge) metadata.append(reviewedAge);
    const postedAge = createAgeReadout('Posted', review.postedAt);
    if (postedAge) metadata.append(postedAge);
  }
  const githubSummary = 'reviewedHead' in review ? createGithubReviewSummary(review, 'pr-detail-github') : null;
  if (githubSummary) metadata.append(githubSummary);
  const head = 'reviewedHead' in review ? review.reviewedHead : review.head;
  metadata.append(el('span', null, `${'reviewedHead' in review ? 'reviewed at' : 'head'} ${head.slice(0, 7)}`));
  heading.append(title, metadata);
  return heading;
}

function refreshDetailHeading(detail: HTMLElement, draft: ReviewDraft): HTMLElement {
  const heading = detail.querySelector<HTMLElement>(':scope > .pr-detail-heading');
  if (!heading || heading.dataset.signature === detailHeadingSignature(draft)) return detail;
  heading.replaceWith(createDetailHeading(draft));
  return detail;
}

function requeueDetailSignature(draft: ReviewDraft): string {
  return `${draft.status}:${draft.reviewedHead}:${draft.error ?? ''}`;
}

function appendSegments(element: HTMLElement, segments: ReturnType<typeof parseInlineSegments>): HTMLElement {
  for (const segment of segments) element.append(segment.isCode ? el('code', null, segment.text) : document.createTextNode(segment.text));
  return element;
}

function appendInlineText(element: HTMLElement, text: string): HTMLElement {
  return appendSegments(element, parseInlineSegments(text));
}

function createAssessmentPart(title: string, content: HTMLElement, tone?: string): HTMLElement {
  const part = el('div', 'pr-assessment-part');
  if (tone) part.dataset.tone = tone;
  part.append(el('h4', 'pr-assessment-title', title), content);
  return part;
}

function createAssessmentList(items: readonly string[]): HTMLElement {
  const list = el('ul', 'pr-assessment-list');
  for (const item of items) list.append(appendInlineText(el('li', null), item));
  return list;
}

function createVerdictBox(draft: ReviewDraft, isWithCounts: boolean): HTMLElement {
  const verdict = el('section', 'pr-verdict-box');
  verdict.setAttribute('aria-label', 'Verdict');
  const verdictLine = el('div', 'pr-verdict-line');
  verdictLine.append(createVerdictSeal(draft));
  if (isWithCounts) verdictLine.append(createSeverityCounts(draft));
  verdict.append(verdictLine);
  const { assessment } = draft;
  if (!assessment) {
    const audit = el('details', 'pr-verdict-audit');
    audit.append(el('summary', null, 'Review audit'), el('p', 'pr-verdict-summary', draft.summary));
    verdict.append(el('p', 'pr-verdict-legacy', LEGACY_SUMMARY_HINT), audit);
    return verdict;
  }
  verdict.append(appendInlineText(el('p', 'pr-verdict-summary pr-verdict-reason'), draft.summary));
  if (assessment.change) verdict.append(createAssessmentPart('What the PR changes', appendInlineText(el('p', 'pr-verdict-summary'), assessment.change)));
  if (assessment.checked.length > 0) verdict.append(createAssessmentPart('What the review checked', createAssessmentList(assessment.checked)));
  if (assessment.gaps.length > 0) verdict.append(createAssessmentPart('Not covered', createAssessmentList(assessment.gaps), 'warning'));
  return verdict;
}

function createCommentParagraph(paragraph: ReturnType<typeof parseReviewComment>['paragraphs'][number]): HTMLElement {
  const element = el('p', 'pr-comment-paragraph');
  if (paragraph.lead) {
    const lead = el('strong', `pr-comment-lead pr-comment-lead-${paragraph.leadKind}`);
    if (paragraph.leadKind === 'question') lead.append(createQuestionGlyph());
    lead.append(paragraph.lead);
    element.append(lead, ' ');
  }
  return appendSegments(element, paragraph.segments);
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
  header.append(el('span', 'pr-comment-location', commentLocation(comment)));
  if (parsed.severity && parsed.tag) {
    const finding = el('span', 'pr-comment-finding');
    finding.style.color = `var(${severityPresentation(parsed.severity).colorToken})`;
    finding.append(createSeverityMeter(parsed.severity), el('strong', null, `[${parsed.tag}] ${parsed.severity}`));
    header.append(finding);
  }
  content.append(header);
  for (const paragraph of parsed.paragraphs) content.append(createCommentParagraph(paragraph));
  card.append(checkbox, content);
  return card;
}

const ACTION_BUTTONS: readonly { label: string; action: TeamReviewAction }[] = [
  { label: 'Approve', action: 'approve' },
  { label: 'Comment', action: 'comment' },
  { label: 'Discard', action: 'discard' },
  { label: 'Queue review', action: 'requeue' },
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
  detail.append(createVerdictBox(draft, true));

  const posts = el('section', 'pr-posts');
  posts.setAttribute('aria-label', 'What posts to GitHub');
  const heading = el('div', 'pr-posts-heading');
  heading.append(el('h3', null, 'Posts to GitHub'), el('span', null, 'Each inline comment opens with the automated-review note.'));
  posts.append(heading);
  const noteLabel = el('label', 'pr-body-label');
  const noteTitle = el('span', 'pr-body-title');
  noteTitle.append(createBodyGlyph(), 'Your note');
  const noteInput = el('textarea', 'pr-body-input pr-note-input');
  noteInput.rows = 2;
  noteInput.spellcheck = true;
  noteInput.placeholder = 'Posts above the automated-review note';
  noteLabel.append(noteTitle, noteInput);
  posts.append(noteLabel);
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
      if (sendAction(draft, action, withReviewerNote(noteInput.value, bodyInput.value), comments, settle)) return;
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
  if (cached?.signature === readyRowSignature(draft)) return refreshDetailHeading(cached.element, draft);
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
  detail.append(draft.status === 'posted' ? createVerdictBox(draft, false) : el('p', 'pr-attention-detail', attentionDetail(draft)));
  if (!hasRequeueFooter(draft.status)) return detail;
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
  _requeueDetails.set(draft.key, { signature: requeueDetailSignature(draft), element: detail, settle });
  return detail;
}

function otherDetailFor(draft: ReviewDraft): HTMLElement {
  if (!hasRequeueFooter(draft.status)) return createOtherDetail(draft);
  const cached = _requeueDetails.get(draft.key);
  if (cached && (_pendingActions.has(draft.key) || cached.signature === requeueDetailSignature(draft))) return refreshDetailHeading(cached.element, draft);
  return createOtherDetail(draft);
}

function renderSelectedDetail(sections: TeamReviewSections): void {
  if (!_detail) return;
  _selectedKey = chooseSelectedReviewKey(sections, _selectedKey);
  const ready = [...sections.ready, ...sections.noReviewNeeded].find((draft) => draft.key === _selectedKey && draft.status === 'ready');
  if (ready) {
    const signature = `ready:${readyRowSignature(ready)}`;
    const readyDetail = readyDetailFor(ready);
    if (_renderedDetailSignature === signature) return;
    _detail.replaceChildren(readyDetail);
    _renderedDetailSignature = signature;
    return;
  }
  const inReview = sections.inReview.find((review) => review.key === _selectedKey);
  if (inReview) {
    _detail.replaceChildren(createInReviewDetail(inReview));
    _renderedDetailSignature = `inReview:${inReview.key}`;
    return;
  }
  const other = [...sections.noReviewNeeded, ...sections.attention, ...sections.posted, ...sections.discarded].find((draft) => draft.key === _selectedKey);
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
  const requeueKeys = new Set(_latest?.drafts.filter((draft) => hasRequeueFooter(draft.status)).map((draft) => draft.key) ?? []);
  for (const key of _requeueDetails.keys()) {
    if (requeueKeys.has(key) || _pendingActions.has(key)) continue;
    _requeueDetails.delete(key);
  }
}

function ensureShell(): void {
  if (!_root || !_scopeTabs || _queue?.isConnected) return;
  const shell = createPrQueueColumns({
    queueLabel: 'Review queue',
    scopeTabs: _scopeTabs,
    resizerLabel: 'Resize review queue',
  });
  _queue = shell.queue;
  _detail = shell.detail;
  _root.replaceChildren(shell.columns);
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
  forgetDepartedDetails(new Set([...sections.ready, ...sections.noReviewNeeded].map((draft) => draft.key)));
  _progressTicker.reset();
  _ageTicker.reset();
  if (!_latest?.configured || !hasAnyRow(sections)) {
    _root.replaceChildren(createPrQueueHead(_scopeTabs), buildEmptyState());
    _queue = null;
    _detail = null;
    _inReviewSection = null;
    _renderedDetailSignature = null;
    return;
  }
  ensureShell();
  if (!_queue) return;
  _selectedKey = chooseSelectedReviewKey(sections, _selectedKey);
  const queueSections: HTMLElement[] = [];
  if (sections.ready.length) queueSections.push(createQueueSection('Ready', sections.ready, 'ready'));
  if (sections.noReviewNeeded.length) queueSections.push(createQueueSection('No review needed', sections.noReviewNeeded, 'settled'));
  if (sections.inReview.length) {
    _inReviewSection = createQueueSection('In review', sections.inReview, 'inReview');
    queueSections.push(_inReviewSection);
  }
  if (sections.attention.length) queueSections.push(createQueueSection('Needs attention', sections.attention, 'attention'));
  if (sections.posted.length) queueSections.push(createQueueSection('Recently posted', sections.posted, 'posted'));
  if (sections.discarded.length) queueSections.push(createQueueSection('Discarded', sections.discarded, 'discarded'));
  _queue.replaceChildren(...queueSections);
  restoreQueueFocus(focusedReviewKey);
  renderSelectedDetail(sections);
  trackAges(_root);
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

export function mountTeamReviewView(parent: HTMLElement, scopeTabs: HTMLElement): HTMLDivElement {
  if (_root) return _root;
  _scopeTabs = scopeTabs;
  _root = el('div', 'pr-content');
  parent.append(_root);
  _progressTicker.ensure();
  _ageTicker.ensure();
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
  _ageTicker.reset();
  const focusedReviewKey = focusedQueueReviewKey();
  const sections = groupDrafts(_latest);
  const replacement = createQueueSection('In review', sections.inReview, 'inReview');
  _inReviewSection.replaceWith(replacement);
  _inReviewSection = replacement;
  restoreQueueFocus(focusedReviewKey);
  if (sections.inReview.some((review) => review.key === _selectedKey)) renderSelectedDetail(sections);
  trackAges(_root);
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
  const handle = (pending.action === 'requeue' ? _requeueDetails.get(actionResult.key) : undefined) ?? _readyDetails.get(actionResult.key);
  if (!handle) return;
  if (actionResult.ok === true) {
    if (pending.action === 'requeue') _requeueDetails.delete(actionResult.key);
    handle.settle(true, typeof actionResult.warning === 'string' && actionResult.warning ? `${actionOutcomeText(pending.action)}. ${actionResult.warning}` : actionOutcomeText(pending.action));
    return;
  }
  handle.settle(false, typeof actionResult.error === 'string' && actionResult.error ? actionResult.error : 'The action failed.');
}
