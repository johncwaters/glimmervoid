import { createReviewsPollingControls } from './my-prs-panel.ts';
import { TeamReviewStatus } from '#shared/contracts/team-review.ts';
import type { DraftComment, FindingSeverity, InFlightReview, QueuedReview, ReviewComment, ReviewDraft, TeamReviewAction, TeamReviewStatus as TeamReviewStatusType } from '#shared/contracts/team-review.ts';
import { withoutAutomatedNote } from '#shared/team-review-markdown.ts';
import { createAttentionAck } from './attention-ack-core.ts';
import { sendControlMsg } from './control-ws.ts';
import { createAvatar, createReviewerStack, el, externalLink, isPanelHidden } from './dom-helpers.ts';
import { createPollAgoTicker, formatAgo } from './poll-ago.ts';
import { createPrQueueColumns, createPrQueueHead } from './pr-queue-columns.ts';
import { createSvgIcon as svgIcon, createSvgShape as svgShape } from './state-glyph.ts';
import { formatTrailOffset } from './radar-core.ts';
import { createSettingsLink } from './settings-link.ts';
import {
  TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID, REVIEW_PRIORITY_REASON_TEXT, REVIEW_PRIORITY_TONES, classifyReviewPriority,
  answeredNonNitThreads, detailThreadItems, aboutPrParagraphs, actionLabel, actionOutcomeText, actionProgressText, attentionDetail, attentionStatusLabel, buildActionRequest, chooseSelectedReviewKey,
  commentLocation, detailActionLayout, isIncludedByDefault, emptyStateText, laneNotice, githubReviewItems, githubReviewTitle, groupDrafts, parseInlineSegments, hasAnyRow, LEGACY_SUMMARY_HINT, hasRequeueFooter, inFlightElapsedText, inFlightProgressText, isInFlightProgressOnlyChange,
  parseReviewComment, reviewCommentPreview, shortCommentLocation, phaseLabel, pullRequestLabel, queuedDetailText, queueRowTitle, queueRowRefLabel, queueRowVerdictLabel, hasMultipleQueueRepos, readyAttentionSignature, readyRowSignature, detailHeadingSignature,
  reviewProgressSteps, commentSeverity, detailMetaText, reviewScopeTitle, coverageDisclosureHeading, severityPresentation, postedOutcome, verdictLabel, verdictSealKind, verdictTone, viewerApprovalContext, viewerApprovalNotice, withReviewerNote,
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
  origin: DetailOrigin;
  timer: number;
  settle?: (isDone: boolean, text: string) => void;
}

type DetailOrigin = 'ready' | 'other';

let _latest: TeamReviewStatusType | null = null;
let _root: HTMLDivElement | null = null;
let _scopeTabs: HTMLElement | null = null;
let pollingControls: ReturnType<typeof createReviewsPollingControls> | null = null;
let _queue: HTMLElement | null = null;
let _detail: HTMLElement | null = null;
let _inReviewSection: HTMLElement | null = null;
let _selectedKey: string | null = null;
let _renderedDetailSignature: string | null = null;
let _activityCallback: ((isActive: boolean) => void) | null = null;
const _progressTicker = createPollAgoTicker(() => _root);
const _ageTicker = createPollAgoTicker(() => _root);
const _queueRowTitles = new WeakMap<HTMLElement, () => string>();
const _readyDetails = new Map<string, ActionDetailHandle>();
const _otherDetails = new Map<string, ActionDetailHandle>();
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
  for (const row of root.querySelectorAll<HTMLElement>('.pr-queue-row')) {
    const title = _queueRowTitles.get(row);
    if (!title) continue;
    const paintTitle = () => {
      row.title = title();
      row.setAttribute('aria-label', row.title);
    };
    paintTitle();
    _ageTicker.onTick(paintTitle);
  }
  for (const notice of root.querySelectorAll<HTMLElement>('.pr-rereview-notice')) {
    const draft = _latest?.drafts.find((review) => review.key === notice.dataset.reviewKey);
    const context = draft ? viewerApprovalContext(draft) : null;
    if (!context) continue;
    const paintNotice = () => { notice.textContent = viewerApprovalNotice(context, formatTimestampAge(context.submittedAt)); };
    paintNotice();
    _ageTicker.onTick(paintNotice);
  }
  for (const readout of root.querySelectorAll<HTMLElement>('[data-age-at]')) {
    const at = Number(readout.dataset.ageAt);
    const reviewTitle = readout.dataset.reviewTitle;
    if (reviewTitle !== undefined) {
      const paintTitle = () => {
        const title = githubReviewTitle(reviewTitle, formatAgo(at));
        readout.title = title;
        readout.setAttribute('aria-label', title);
      };
      paintTitle();
      _ageTicker.onTick(paintTitle);
      continue;
    }
    const label = readout.dataset.ageLabel ?? '';
    _ageTicker.track(readout, at, () => `${label}${label ? ' ' : ''}${formatAgo(at)}`);
  }
}

function createGithubReviewSummary(draft: ReviewDraft, className: string, avatarCssPx: number, isViewerShown = true): HTMLElement | null {
  const reviews = githubReviewItems(draft, { isViewerShown });
  if (reviews.length === 0) return null;
  const summary = el('span', className);
  const items = reviews.map((review) => ({
    login: review.login, tone: review.tone,
    title: githubReviewTitle(review.text, formatTimestampAge(review.submittedAt)),
  }));
  const stack = createReviewerStack(items, avatarCssPx);
  for (const [index, review] of reviews.entries()) {
    const avatar = stack.children[index];
    if (!(avatar instanceof HTMLElement) || !review.submittedAt) continue;
    const at = ageTimestamp(review.submittedAt);
    if (at === null) continue;
    avatar.dataset.ageAt = String(at);
    avatar.dataset.reviewTitle = review.text;
  }
  summary.append(stack);
  return summary;
}

function formatTimestampAge(timestampValue: number | string | null | undefined): string | null {
  const timestamp = ageTimestamp(timestampValue);
  return timestamp === null ? null : formatAgo(timestamp);
}

function createAuthor(login: string, cssPx: number, className: string): HTMLElement {
  const author = el('span', className);
  author.append(createAvatar({ login, cssPx }), el('span', null, login));
  return author;
}

function createQueueRow(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind, hasMultipleRepos: boolean): HTMLButtonElement {
  const row = el('button', 'pr-queue-row pr-queue-row-quiet');
  row.type = 'button';
  row.dataset.reviewKey = review.key;
  row.setAttribute('aria-current', String(review.key === _selectedKey));
  const approvalContext = 'reviewedHead' in review ? viewerApprovalContext(review) : null;
  const title = () => queueRowTitle(review, kind, {
    opened: formatTimestampAge(review.prCreatedAt),
    reviewed: 'reviewedHead' in review ? formatTimestampAge(review.reviewedAt) : null,
    posted: 'reviewedHead' in review ? formatTimestampAge(review.postedAt) : null,
    viewerApproval: formatTimestampAge(approvalContext?.submittedAt),
    githubReviews: 'reviewedHead' in review ? githubReviewItems(review, { isViewerShown: kind !== 'posted' }).map((item) => formatTimestampAge(item.submittedAt)) : [],
  });
  row.title = title();
  row.setAttribute('aria-label', row.title);
  _queueRowTitles.set(row, title);
  const top = createQueueRowTop(review, hasMultipleRepos);
  if (kind === 'inReview') {
    const inFlight = review as InFlightReview;
    const elapsed = el('span', 'pr-queue-elapsed');
    _progressTicker.track(elapsed, inFlight.startedAt, () => inFlightElapsedText(inFlight, Date.now()));
    top.append(elapsed);
  }
  if (kind === 'queued') {
    const openedAge = createAgeReadout('', review.prCreatedAt);
    if (openedAge) {
      openedAge.classList.add('pr-queue-elapsed');
      top.append(openedAge);
    }
  }
  if (kind !== 'inReview' && kind !== 'queued') {
    const draft = review as ReviewDraft;
    const visibleAge = createAgeReadout('', draft.reviewedAt) ?? createAgeReadout('', draft.prCreatedAt);
    if (visibleAge) {
      visibleAge.classList.add('pr-queue-elapsed');
      top.append(visibleAge);
    }
  }
  if (kind === 'discarded') {
    row.classList.add('pr-queue-row-compact');
    row.append(top);
    selectReviewOnClick(row, review.key);
    return row;
  }
  const bottom = el('span', 'pr-queue-bottom');
  const priority = classifyReviewPriority(review);
  const requestChip = el('span', 'my-pr-stage', review.requestSource === 'direct' ? 'Direct' : 'Team');
  requestChip.dataset.tone = 'muted';
  const reasonChip = el('span', 'my-pr-stage');
  reasonChip.dataset.tone = REVIEW_PRIORITY_TONES[priority.band];
  reasonChip.append(REVIEW_PRIORITY_REASON_TEXT[priority.reason]);
  bottom.append(requestChip, reasonChip);
  if (kind === 'inReview') {
    const inFlight = review as InFlightReview;
    bottom.append(el('span', 'pr-phase-label', phaseLabel(inFlight.phase)));
  }
  if (kind === 'queued') bottom.append(el('span', 'pr-phase-label', 'waiting for a slot'));
  if ((kind === 'ready' || kind === 'settled') && 'status' in review && review.status !== 'error') {
    const draft = review as ReviewDraft;
    const verdict = el('span', 'pr-queue-verdict', queueRowVerdictLabel(draft.verdict));
    verdict.dataset.tone = verdictTone(draft.verdict);
    bottom.append(verdict);
  }
  if (kind === 'attention') {
    const draft = review as ReviewDraft;
    bottom.append(el('span', `pr-attention-label pr-attention-label-${draft.status}`, attentionStatusLabel(draft.status)));
  }
  const outcome = kind === 'posted' ? postedOutcome(review as ReviewDraft) : null;
  if (outcome) {
    const outcomeLabel = el('span', 'pr-queue-verdict', outcome.label);
    outcomeLabel.dataset.tone = outcome.tone;
    bottom.append(outcomeLabel);
  }
  if (kind === 'posted' && !outcome) bottom.append(el('span', 'pr-attention-label pr-attention-label-posted', 'posted'));
  if ('reviewedHead' in review && review.comments.length > 0) bottom.append(el('span', 'pr-queue-comment-count', `\u00b7 ${review.comments.length}`));
  const replyCount = 'reviewedHead' in review ? answeredNonNitThreads(review).length : 0;
  if (replyCount > 0) bottom.append(el('span', 'pr-queue-comment-count', `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`));
  if (approvalContext) bottom.append(el('span', 'pr-queue-approval-context', 'since approval'));
  bottom.append(createAuthor(review.author, 16, 'pr-queue-author'));
  if (kind === 'posted' && !outcome) bottom.append(el('span', 'pr-queue-posted-detail', verdictLabel((review as ReviewDraft).verdict)));
  row.append(top, bottom);
  const githubSummary = kind === 'inReview' || kind === 'queued' ? null : createGithubReviewSummary(review as ReviewDraft, 'pr-queue-reviewers', 16, kind !== 'posted');
  if (githubSummary) bottom.append(githubSummary);
  selectReviewOnClick(row, review.key);
  return row;
}

function selectReviewOnClick(row: HTMLButtonElement, reviewKey: string): void {
  row.addEventListener('click', () => {
    _selectedKey = reviewKey;
    for (const button of _queue?.querySelectorAll<HTMLButtonElement>('button[data-review-key]') ?? []) button.setAttribute('aria-current', String(button.dataset.reviewKey === _selectedKey));
    renderSelectedDetail(groupDrafts(_latest));
    _ageTicker.reset();
    trackAges(_root);
    if (document.documentElement.dataset.layout === 'phone') _detail?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

function createQueueRowTop(review: ReviewDraft | InFlightReview | QueuedReview, hasMultipleRepos: boolean): HTMLSpanElement {
  const top = el('span', 'pr-queue-top');
  top.append(
    el('strong', 'pr-queue-ref', queueRowRefLabel(review.repo, review.number, hasMultipleRepos)),
    el('strong', 'pr-queue-ref-compact', queueRowRefLabel(review.repo, review.number, false)),
    el('span', 'pr-queue-title', review.title),
  );
  return top;
}

function createHandReviewSection(reviews: QueuedReview[], hasMultipleRepos: boolean): HTMLElement {
  const section = el('section', 'pr-queue-section');
  section.append(el('h3', 'pr-section-heading', `Review by hand ${reviews.length}`));
  for (const review of reviews) {
    const row = externalLink('pr-queue-row pr-queue-row-quiet', '', review.url);
    row.title = queueRowTitle(review, 'handReview', { opened: formatTimestampAge(review.prCreatedAt) });
    const bottom = el('span', 'pr-queue-bottom');
    bottom.append(createAuthor(review.author, 16, 'pr-queue-author'), el('span', 'pr-queue-posted-detail', 'Review by hand'));
    row.append(createQueueRowTop(review, hasMultipleRepos), bottom);
    section.append(row);
  }
  return section;
}

function createQueueSection(title: string, reviews: (ReviewDraft | InFlightReview | QueuedReview)[], kind: QueueRowKind, hasMultipleRepos: boolean): HTMLElement {
  const section = el('section', 'pr-queue-section');
  section.append(el('h3', 'pr-section-heading', `${title} ${reviews.length}`));
  for (const review of reviews) section.append(createQueueRow(review, kind, hasMultipleRepos));
  return section;
}

function createDetailHeading(review: ReviewDraft | InFlightReview): HTMLElement {
  const heading = el('div', 'pr-detail-heading');
  heading.dataset.signature = detailHeadingSignature(review);
  const title = el('div', 'pr-detail-title');
  title.append(pullRequestLink(review), el('h2', null, review.title));
  const metadata = el('div', 'pr-detail-meta');
  metadata.append(createAuthor(review.author, 20, 'pr-detail-author'));
  const scope = el('span', null, detailMetaText(review));
  scope.title = reviewScopeTitle(review);
  metadata.append(scope);
  const openedAge = createAgeReadout('Opened', review.prCreatedAt);
  if (openedAge) metadata.append(openedAge);
  if ('reviewedHead' in review) {
    const reviewedAge = createAgeReadout('Reviewed', review.reviewedAt);
    if (reviewedAge) metadata.append(reviewedAge);
    const postedAge = createAgeReadout('Posted', review.postedAt);
    if (postedAge) metadata.append(postedAge);
  }
  const githubSummary = 'reviewedHead' in review ? createGithubReviewSummary(review, 'pr-detail-github', 20) : null;
  if (githubSummary) metadata.append(githubSummary);
  heading.append(title, metadata);
  const approvalContext = 'reviewedHead' in review ? viewerApprovalContext(review) : null;
  if (approvalContext) {
    const notice = el('p', 'pr-rereview-notice', viewerApprovalNotice(approvalContext, formatTimestampAge(approvalContext.submittedAt)));
    notice.dataset.reviewKey = review.key;
    heading.append(notice);
  }
  return heading;
}

function refreshDetailHeading(detail: HTMLElement, draft: ReviewDraft): HTMLElement {
  const heading = detail.querySelector<HTMLElement>(':scope > .pr-detail-heading');
  if (!heading || heading.dataset.signature === detailHeadingSignature(draft)) return detail;
  const freshHeading = createDetailHeading(draft);
  const more = heading.querySelector(':scope > .pr-detail-title > .pr-detail-more');
  if (more) freshHeading.querySelector(':scope > .pr-detail-title')?.append(more);
  heading.replaceWith(freshHeading);
  return detail;
}

function otherDetailSignature(draft: ReviewDraft): string {
  return `${JSON.stringify(draft.threads)}:${draft.liveHead}:${draft.status}:${draft.reviewedHead}:${draft.error ?? ''}:${draft.postedEvent ?? ''}`;
}

function appendSegments(element: HTMLElement, segments: ReturnType<typeof parseInlineSegments>): HTMLElement {
  for (const segment of segments) {
    if (segment.kind === 'text') {
      element.append(document.createTextNode(segment.text));
      continue;
    }
    if (segment.kind === 'code') {
      element.append(el('code', null, segment.text));
      continue;
    }
    const citation = el('span', 'pr-citation', segment.text);
    citation.title = segment.text;
    element.append(citation);
  }
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

function createAboutPr(draft: ReviewDraft): HTMLElement[] {
  const paragraphs = aboutPrParagraphs(draft.assessment);
  if (paragraphs.length === 0) return [];
  const section = el('section', 'pr-about-box');
  section.setAttribute('aria-label', 'About this PR');
  section.append(el('h3', 'pr-assessment-title', 'About this PR'));
  for (const paragraph of paragraphs) {
    const className = paragraph.kind === 'goal' ? 'pr-verdict-summary pr-about-goal' : 'pr-verdict-summary';
    section.append(appendInlineText(el('p', className), paragraph.text));
  }
  return [section];
}

function createSummaryStrip(draft: ReviewDraft): HTMLElement {
  const verdict = el('section', 'pr-verdict-box');
  verdict.setAttribute('aria-label', 'Verdict');
  const verdictLine = el('div', 'pr-verdict-line');
  verdictLine.append(createVerdictSeal(draft));
  verdict.append(verdictLine);
  if (!draft.assessment) {
    verdict.append(el('p', 'pr-verdict-legacy', LEGACY_SUMMARY_HINT));
    return verdict;
  }
  verdict.append(appendInlineText(el('p', 'pr-verdict-summary pr-verdict-reason'), draft.summary));
  return verdict;
}

function createCoverageDetails(draft: ReviewDraft): HTMLElement {
  const details = el('details', 'pr-disclosure pr-coverage');
  const summary = el('summary', 'pr-disclosure-summary');
  const heading = coverageDisclosureHeading(draft.assessment);
  summary.append(el('span', 'pr-disclosure-label', heading.label), el('span', 'pr-disclosure-preview', heading.preview));
  details.append(summary);
  const { assessment } = draft;
  if (!assessment) {
    details.append(appendInlineText(el('p', 'pr-verdict-summary'), draft.summary));
    return details;
  }
  if (assessment.checked.length > 0) details.append(createAssessmentPart('What the review checked', createAssessmentList(assessment.checked)));
  if (assessment.gaps.length > 0) details.append(createAssessmentPart('Not covered', createAssessmentList(assessment.gaps), 'warning'));
  return details;
}

function createCommentParagraph(paragraph: ReturnType<typeof parseReviewComment>['paragraphs'][number]): HTMLElement {
  if (paragraph.kind === 'code') {
    const codeBlock = el('pre', 'pr-comment-code');
    const code = el('code', null);
    code.textContent = paragraph.code;
    codeBlock.append(code);
    return codeBlock;
  }
  const element = el('p', 'pr-comment-paragraph');
  if (paragraph.lead) {
    const lead = el('strong', `pr-comment-lead pr-comment-lead-${paragraph.leadKind}`);
    if (paragraph.leadKind === 'question') lead.append(createQuestionGlyph());
    lead.append(paragraph.lead);
    element.append(lead, ' ');
  }
  return appendSegments(element, paragraph.segments);
}

function createInlineComment(comment: DraftComment, index: number, includedIndexes: Set<number>, updateFooter: () => void): HTMLElement {
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
  const content = el('details', 'pr-comment-content');
  const header = el('summary', 'pr-comment-header');
  const parsed = parseReviewComment(comment.body);
  const severity = commentSeverity(comment);
  if (severity) header.append(createSeverityMeter(severity));
  const location = el('span', 'pr-comment-location', shortCommentLocation(comment));
  location.title = commentLocation(comment);
  header.append(location);
  header.append(el('span', 'pr-comment-preview', reviewCommentPreview(parsed.paragraphs)));
  content.append(header);
  const paragraphs = el('div', 'pr-comment-paragraphs');
  for (const paragraph of parsed.paragraphs) paragraphs.append(createCommentParagraph(paragraph));
  content.append(paragraphs);
  content.open = severity === 'HIGH' || severity === 'CRITICAL';
  card.append(checkbox, content);
  return card;
}

const MORE_ACTIONS_LABEL = 'More review actions';
const MORE_ICON_PATH = 'M3 8h0.01M8 8h0.01M13 8h0.01';
const FOLLOW_UP_APPROVAL_HINT = 'Your comments are on GitHub. Approve adds an approval without posting them again.';

function sendAction(origin: DetailOrigin, draft: ReviewDraft, action: TeamReviewAction, body: string, comments: ReviewComment[], settle: (isDone: boolean, text: string) => void, threadId?: string): boolean {
  const requestId = `team-review-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const isSent = sendControlMsg({ type: 'team-review-action', requestId, ...buildActionRequest(draft, action, body, comments, threadId) });
  if (!isSent) return false;
  const timer = window.setTimeout(() => {
    _pendingActions.delete(draft.key);
    settle(false, 'No reply from the server. Check GitHub before trying again.');
  }, ACTION_REPLY_TIMEOUT_MS);
  _pendingActions.set(draft.key, { requestId, action, origin, timer, settle });
  return true;
}

let _moreMenuCount = 0;

function createMoreActions(actions: readonly TeamReviewAction[], runAction: (action: TeamReviewAction) => void): { element: HTMLElement; controls: HTMLButtonElement[] } {
  const container = el('div', 'pr-detail-more');
  const toggle = el('button', 'review-icon-button review-more-button');
  toggle.type = 'button';
  toggle.title = MORE_ACTIONS_LABEL;
  toggle.setAttribute('aria-label', MORE_ACTIONS_LABEL);
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  const icon = svgIcon(16, 16);
  icon.append(svgShape('path', { d: MORE_ICON_PATH, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  toggle.append(icon);
  _moreMenuCount += 1;
  const menu = el('div', 'review-more-menu');
  menu.id = `pr-more-menu-${_moreMenuCount}`;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', MORE_ACTIONS_LABEL);
  menu.hidden = true;
  toggle.setAttribute('aria-controls', menu.id);
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeMenu();
    toggle.focus();
  };
  const closeOnOutsidePointer = (event: PointerEvent) => {
    if (event.target instanceof Node && container.contains(event.target)) return;
    closeMenu();
  };
  function closeMenu(): void {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', closeOnEscape);
    document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }
  const openMenu = () => {
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };
  toggle.addEventListener('click', () => {
    if (menu.hidden) {
      openMenu();
      return;
    }
    closeMenu();
  });
  const controls: HTMLButtonElement[] = [toggle];
  for (const action of actions) {
    const item = el('button', action === 'discard' ? 'review-btn review-btn-danger' : 'review-btn', actionLabel(action));
    item.type = 'button';
    item.dataset.action = action;
    item.setAttribute('role', 'menuitem');
    item.addEventListener('click', () => {
      closeMenu();
      runAction(action);
    });
    controls.push(item);
    menu.append(item);
  }
  container.append(toggle, menu);
  return { element: container, controls };
}

function createFooterButton(action: TeamReviewAction, runAction: (action: TeamReviewAction) => void): HTMLButtonElement {
  const button = el('button', 'pr-action', actionLabel(action));
  button.type = 'button';
  button.dataset.action = action;
  button.addEventListener('click', () => runAction(action));
  return button;
}

function attachMoreActions(detail: HTMLElement, more: HTMLElement): void {
  detail.querySelector(':scope > .pr-detail-heading > .pr-detail-title')?.append(more);
}

function createReadyDetail(draft: ReviewDraft): ActionDetailHandle {
  const detail = el('article', 'pr-detail');
  const threads = el('div');
  threads.dataset.reviewThreads = '';
  detail.append(createDetailHeading(draft), ...createAboutPr(draft), threads, createSummaryStrip(draft));
  refreshThreadDetails(detail, draft);

  const posts = el('section', 'pr-posts');
  posts.setAttribute('aria-label', 'Inline comments');
  const heading = el('div', 'pr-posts-heading');
  heading.append(el('h3', null, 'Inline comments'), el('span', null, String(draft.comments.length)));
  posts.append(heading);
  const bodyDetails = el('details', 'pr-disclosure');
  const bodySummary = el('summary', 'pr-disclosure-summary');
  const bodyPreview = el('span', 'pr-disclosure-preview');
  bodySummary.append(el('span', 'pr-disclosure-label', 'Review body'), bodyPreview);
  bodyDetails.append(bodySummary);
  const bodyInput = el('textarea', 'pr-body-input');
  bodyInput.setAttribute('aria-label', 'Review body');
  bodyInput.value = draft.body;
  bodyInput.rows = Math.min(10, Math.max(3, draft.body.split('\n').length + 1));
  bodyInput.spellcheck = true;
  const updateBodyPreview = () => {
    bodyPreview.textContent = withoutAutomatedNote(bodyInput.value).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || 'No review body';
  };
  bodyInput.addEventListener('input', updateBodyPreview);
  updateBodyPreview();
  bodyDetails.append(bodyInput);
  const noteDetails = el('details', 'pr-disclosure');
  noteDetails.append(el('summary', 'pr-disclosure-summary', 'Add a note'));
  const noteInput = el('textarea', 'pr-body-input pr-note-input');
  noteInput.setAttribute('aria-label', 'Your note');
  noteInput.rows = 2;
  noteInput.spellcheck = true;
  noteInput.placeholder = 'Posts above the automated-review note';
  noteDetails.append(noteInput);

  const includedIndexes = new Set(draft.comments.flatMap((comment, index) => (isIncludedByDefault(comment) ? [index] : [])));
  const footer = el('footer', 'pr-footer');
  const status = el('span', 'pr-action-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const updateFooter = () => {
    if (_pendingActions.has(draft.key) || status.dataset.tone === 'ok') return;
    status.textContent = '';
    delete status.dataset.tone;
  };
  for (const [index, comment] of draft.comments.entries()) posts.append(createInlineComment(comment, index, includedIndexes, updateFooter));
  detail.append(posts, bodyDetails, noteDetails, createCoverageDetails(draft));
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
  const runAction = (action: TeamReviewAction) => {
    if (_pendingActions.has(draft.key)) return;
    setBusy(true);
    status.dataset.tone = 'busy';
    status.textContent = actionProgressText(action);
    const comments = draft.comments.filter((_comment, index) => includedIndexes.has(index));
    if (sendAction('ready', draft, action, withReviewerNote(noteInput.value, bodyInput.value), comments, settle)) return;
    settle(false, 'Not connected to the server.');
  };
  const layout = detailActionLayout(draft);
  const footerButtons = layout.footer.map((action) => createFooterButton(action, runAction));
  const more = createMoreActions(layout.more, runAction);
  buttons.push(...footerButtons, ...more.controls);
  attachMoreActions(detail, more.element);
  footer.append(...footerButtons, status);
  detail.append(footer);
  return { signature: readyRowSignature(draft), element: detail, settle };
}

function readyDetailFor(draft: ReviewDraft): HTMLElement {
  const cached = _readyDetails.get(draft.key);
  if (cached && (_pendingActions.has(draft.key) || cached.signature === readyRowSignature(draft))) {
    refreshThreadDetails(cached.element, draft);
    return refreshDetailHeading(cached.element, draft);
  }
  const handle = createReadyDetail(draft);
  _readyDetails.set(draft.key, handle);
  return handle.element;
}

function createQueuedDetail(review: QueuedReview, runningCount: number): HTMLElement {
  const detail = el('article', 'pr-detail');
  const heading = el('div', 'pr-detail-heading');
  const title = el('div', 'pr-detail-title');
  title.append(pullRequestLink(review), el('h2', null, review.title));
  const metadata = el('div', 'pr-detail-meta');
  metadata.append(createAuthor(review.author, 20, 'pr-detail-author'));
  const openedAge = createAgeReadout('Opened', review.prCreatedAt);
  if (openedAge) metadata.append(openedAge);
  heading.append(title, metadata);
  detail.append(heading, el('p', 'pr-attention-detail', queuedDetailText(runningCount)));
  return detail;
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

function refreshThreadDetails(detail: HTMLElement, draft: ReviewDraft): void {
  if (_pendingActions.has(draft.key)) return;
  const threads = detail.querySelector<HTMLElement>(':scope > [data-review-threads]');
  const signature = JSON.stringify([draft.liveHead, draft.threads]);
  if (!threads || threads.dataset.reviewThreads === signature) return;
  threads.replaceChildren(...createThreadDetails(draft));
  threads.dataset.reviewThreads = signature;
}

function createThreadDetails(draft: ReviewDraft): HTMLElement[] {
  const items = detailThreadItems(draft);
  if (items.length === 0) return [];
  const section = el('section', 'my-pr-threads-section');
  section.append(el('h3', 'pr-section-heading', 'Answered threads'));
  const list = el('div', 'my-pr-threads');
  for (const item of items) {
    const row = el('div', 'my-pr-thread');
    const reply = el('div', 'pr-detail-meta', `Reply by ${item.thread.lastReplyAuthor}`);
    const age = createAgeReadout('', item.thread.lastReplyAt);
    if (age) reply.append(age);
    const status = el('span', 'pr-action-status', item.judgementText);
    status.setAttribute('role', 'status');
    const button = el('button', 'pr-action', 'Resolve');
    button.type = 'button';
    button.disabled = !item.canResolve || _pendingActions.has(draft.key);
    const settle = (isDone: boolean, text: string) => {
      button.disabled = isDone || !item.canResolve;
      status.textContent = text;
      status.dataset.tone = isDone ? 'ok' : 'error';
    };
    button.addEventListener('click', () => {
      if (_pendingActions.has(draft.key)) return;
      button.disabled = true;
      status.textContent = actionProgressText('resolve-thread');
      if (sendAction('other', draft, 'resolve-thread', '', [], settle, item.thread.id)) return;
      settle(false, 'Not connected to the server.');
    });
    row.append(externalLink('pr-link', item.location, item.thread.url), reply, button, status);
    if (item.thread.resolveError) row.append(el('p', 'pr-attention-detail', item.thread.resolveError));
    list.append(row);
  }
  section.append(list);
  return [section];
}

function createOtherDetail(draft: ReviewDraft): HTMLElement {
  const detail = el('article', 'pr-detail');
  detail.append(createDetailHeading(draft), ...createAboutPr(draft), ...createThreadDetails(draft));
  if (draft.status === 'posted') detail.append(createSummaryStrip(draft), createCoverageDetails(draft));
  if (draft.status !== 'posted') detail.append(el('p', 'pr-attention-detail', attentionDetail(draft)));
  if (!hasRequeueFooter(draft.status)) {
    _otherDetails.set(draft.key, { signature: otherDetailSignature(draft), element: detail, settle: () => {} });
    return detail;
  }
  const footer = el('footer', 'pr-footer');
  const layout = detailActionLayout(draft);
  const status = el('span', 'pr-action-status', layout.footer.includes('approve-only') ? FOLLOW_UP_APPROVAL_HINT : '');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const buttons: HTMLButtonElement[] = [];
  const settle = (isDone: boolean, message: string) => {
    for (const button of buttons) button.disabled = isDone;
    status.dataset.tone = isDone ? 'ok' : 'error';
    status.textContent = message;
  };
  const runAction = (action: TeamReviewAction) => {
    if (_pendingActions.has(draft.key)) return;
    for (const button of buttons) button.disabled = true;
    status.dataset.tone = 'busy';
    status.textContent = actionProgressText(action);
    if (sendAction('other', draft, action, '', [], settle)) return;
    settle(false, 'Not connected to the server.');
  };
  const footerButtons = layout.footer.map((action) => createFooterButton(action, runAction));
  buttons.push(...footerButtons);
  if (layout.more.length > 0) {
    const more = createMoreActions(layout.more, runAction);
    buttons.push(...more.controls);
    attachMoreActions(detail, more.element);
  }
  footer.append(...footerButtons, status);
  detail.append(footer);
  _otherDetails.set(draft.key, { signature: otherDetailSignature(draft), element: detail, settle });
  return detail;
}

function otherDetailFor(draft: ReviewDraft): HTMLElement {
  if (!hasRequeueFooter(draft.status) && detailThreadItems(draft).length === 0) return createOtherDetail(draft);
  const cached = _otherDetails.get(draft.key);
  if (cached && (_pendingActions.has(draft.key) || cached.signature === otherDetailSignature(draft))) return refreshDetailHeading(cached.element, draft);
  return createOtherDetail(draft);
}

function renderSelectedDetail(sections: TeamReviewSections): void {
  if (!_detail) return;
  _selectedKey = chooseSelectedReviewKey(sections, _selectedKey);
  if (!_selectedKey) {
    _detail.replaceChildren();
    _renderedDetailSignature = null;
    return;
  }
  const threadDraft = sections.ready.find((draft) => draft.key === _selectedKey && answeredNonNitThreads(draft).length > 0);
  if (threadDraft && threadDraft.status !== 'ready') {
    const signature = `threads:${otherDetailSignature(threadDraft)}`;
    const threadDetail = otherDetailFor(threadDraft);
    if (_renderedDetailSignature === signature && _detail.firstElementChild === threadDetail) return;
    _detail.replaceChildren(threadDetail);
    _renderedDetailSignature = signature;
    return;
  }
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
  const queued = sections.queued.find((review) => review.key === _selectedKey);
  if (queued) {
    const signature = `queued:${queued.key}:${sections.inReview.length}`;
    if (_renderedDetailSignature === signature) return;
    _detail.replaceChildren(createQueuedDetail(queued, sections.inReview.length));
    _renderedDetailSignature = signature;
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

function laneNoticeElements(): HTMLElement[] {
  const text = laneNotice(_latest);
  return text ? [el('p', 'my-pr-note', text)] : [];
}

function forgetDepartedDetails(readyKeys: Set<string>): void {
  for (const key of [..._readyDetails.keys()]) {
    if (readyKeys.has(key) || _pendingActions.has(key)) continue;
    _readyDetails.delete(key);
  }
  const requeueKeys = new Set(_latest?.drafts.filter((draft) => hasRequeueFooter(draft.status)).map((draft) => draft.key) ?? []);
  for (const key of _otherDetails.keys()) {
    if (requeueKeys.has(key) || _pendingActions.has(key)) continue;
    _otherDetails.delete(key);
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

function syncTeamChip(head: HTMLElement | null): void {
  if (!head) return;
  if (pollingControls) {
    head.insertBefore(pollingControls.control, head.querySelector('.pr-queue-toggle'));
    pollingControls.update(_latest);
  }
  head.querySelector('.pr-team-chip')?.remove();
  const team = _latest?.team;
  if (!team) return;
  const chip = el('span', 'pr-team-chip');
  chip.append(createAvatar({ login: team.slug, url: team.avatarUrl, cssPx: 16 }), el('span', null, team.name));
  head.insertBefore(chip, head.querySelector('.pr-queue-toggle'));
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
    const head = createPrQueueHead(_scopeTabs);
    syncTeamChip(head);
    _root.replaceChildren(head, ...(pollingControls ? [pollingControls.notice] : []), ...laneNoticeElements(), buildEmptyState());
    pollingControls?.update(_latest);
    _queue = null;
    _detail = null;
    _inReviewSection = null;
    _renderedDetailSignature = null;
    return;
  }
  ensureShell();
  if (!_queue) return;
  syncTeamChip(_root.querySelector('.pr-queue-head'));
  _selectedKey = chooseSelectedReviewKey(sections, _selectedKey);
  const hasMultipleRepos = hasMultipleQueueRepos(sections);
  const queueSections: HTMLElement[] = [];
  if (sections.ready.length) queueSections.push(createQueueSection('Ready', sections.ready, 'ready', hasMultipleRepos));
  if (sections.inReview.length) {
    _inReviewSection = createQueueSection('In review', sections.inReview, 'inReview', hasMultipleRepos);
    queueSections.push(_inReviewSection);
  }
  if (sections.queued.length) queueSections.push(createQueueSection('Queued', sections.queued, 'queued', hasMultipleRepos));
  if (sections.noReviewNeeded.length) queueSections.push(createQueueSection('No review needed', sections.noReviewNeeded, 'settled', hasMultipleRepos));
  if (sections.handReview.length) queueSections.push(createHandReviewSection(sections.handReview, hasMultipleRepos));
  if (sections.attention.length) queueSections.push(createQueueSection('Needs attention', sections.attention, 'attention', hasMultipleRepos));
  if (sections.posted.length) queueSections.push(createQueueSection('Recently posted', sections.posted, 'posted', hasMultipleRepos));
  if (sections.discarded.length) queueSections.push(createQueueSection('Discarded', sections.discarded, 'discarded', hasMultipleRepos));
  _queue.replaceChildren(...(pollingControls ? [pollingControls.notice] : []), ...laneNoticeElements(), ...queueSections);
  pollingControls?.update(_latest);
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
  pollingControls = createReviewsPollingControls('team-review', _root);
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
  const replacement = createQueueSection('In review', sections.inReview, 'inReview', hasMultipleQueueRepos(sections));
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
  if (pending.action === 'resolve-thread') {
    pending.settle?.(actionResult.ok === true, typeof actionResult.error === 'string' ? actionResult.error : actionOutcomeText(pending.action));
    _otherDetails.delete(actionResult.key);
    _renderedDetailSignature = null;
    if (actionResult.ok === true) render();
    return;
  }
  const owningCache = pending.origin === 'ready' ? _readyDetails : _otherDetails;
  const handle = owningCache.get(actionResult.key);
  if (!handle) return;
  if (actionResult.ok === true) {
    if (pending.origin === 'other') _otherDetails.delete(actionResult.key);
    handle.settle(true, typeof actionResult.warning === 'string' && actionResult.warning ? `${actionOutcomeText(pending.action)}. ${actionResult.warning}` : actionOutcomeText(pending.action));
    return;
  }
  handle.settle(false, typeof actionResult.error === 'string' && actionResult.error ? actionResult.error : 'The action failed.');
}
