import { paintActionStatus } from '../action-status.ts';
import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { githubPrByKey, subscribeGithubPrs } from './github-prs-store.ts';
import { TeamReviewStatus } from '#shared/contracts/team-review.ts';
import type { DraftComment, EarlierReview, FindingSeverity, InFlightReview, QueuedReview, ReviewDraft, TeamReviewAction, TeamReviewActionRequest, TeamReviewStatus as TeamReviewStatusType } from '#shared/contracts/team-review.ts';
import { nextRequestId, sendControlMsg } from '../control-ws.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import { createAvatar, createReviewerStack, el, externalLink } from '../dom-helpers.ts';
import { createPollAgoTicker, formatAgo } from '../poll-ago.ts';
import { createPrStatusIcon } from './pr-status-icon.ts';
import { createSvgIcon as svgIcon, createSvgShape as svgShape } from '../svg-dom.ts';
import { formatTrailOffset } from '../radar/radar-core.ts';
import { createSettingsLink } from '../settings/settings-link.ts';
import {
  TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID, THREAD_COMMENT_PREVIEW_LINES, THREAD_REPLY_PREVIEW_LINES, threadBodyOverflowsPreview,
  answeredNonNitThreads, changedSinceReviewText, changedSinceReviewUrl, earlierReviewPreview, detailThreadItems, aboutPrParagraphs, actionLabel, actionOutcomeText, actionProgressText, attentionDetail, buildActionRequest, buildNotMineRequest,
  buildReadyDecisionRequest, commentLocation, detailActionLayout, isIncludedByDefault, isSeverityIncludedByDefault, emptyStateText, generalFindingsOf, laneNotice, githubReviewItems, githubReviewTitle, groupDrafts, hasSelection, joinTeamReviews, parseInlineSegments, LEGACY_SUMMARY_HINT, hasRequeueFooter, inFlightElapsedText, inFlightProgressText,
  parseReviewComment, postedOutcomeText, postingPreviewText, reviewCommentPreview, shortCommentLocation, phaseLabel, pullRequestLabel, queuedDetailText, queueRowTitle, queueRowRefLabel, readyRowSignature, detailHeadingSignature,
  reviewProgressSteps, commentSeverity, detailMetaText, reviewScopeTitle, severityPresentation, planActionReply, queueRowGlyph, viewerThreadsText, hasAllViewerThreadsResolved, isPostedAwaitingViewer, verdictHeading, verdictSealKind, verdictTone, viewerApprovalContext, viewerApprovalNotice,
} from './team-review-view-core.ts';
import type { ActionReplyNotice, GeneralFinding, QueueRowKind, ReviewSelection, TeamReviewSections } from './team-review-view-core.ts';
import { isStreamerMode, onStreamerModeChanged } from '../streamer-mode.ts';

const ACTION_REPLY_TIMEOUT_MS = 120000;
const ACTION_NO_REPLY_TEXT = `The server did not answer within ${ACTION_REPLY_TIMEOUT_MS / 1000} s. Check GitHub before trying again.`;
const ACTION_DISCONNECTED_TEXT = `${NOT_CONNECTED_TEXT} Check GitHub before trying again.`;
const SHARD_PATH = 'M4.5 0.5L8.5 5.5L4.5 10.5L0.5 5.5Z';
const STREAMER_GITHUB_REVIEW_TITLE = 'GitHub review';

interface ActionDetailHandle {
  signature: string;
  element: HTMLElement;
  settle: (isDone: boolean, text: string) => void;
}

interface PendingAction {
  requestId: string;
  action: TeamReviewAction;
  outcomeText: string;
  origin: DetailOrigin;
  capturedOrder: string[];
  pullRequest: string;
  timer: number;
  settle?: (isDone: boolean, text: string) => void;
}

type DetailOrigin = 'ready' | 'other';

let _latest: TeamReviewStatusType | null = null;
let _view: TeamReviewStatusType | null = null;
let _root: HTMLElement | null = null;
let _detailHost: HTMLElement | null = null;
let _detail: HTMLElement | null = null;
let _selectedKey: string | null = null;
let _actionNotice: ActionReplyNotice | null = null;
let _actionNoticeLine: HTMLElement | null = null;
let _renderedDetailSignature: string | null = null;
let _inReviewEarlierDetails: { key: string; head: string; element: HTMLElement } | null = null;
let _queueHooks: TeamReviewQueueHooks | null = null;
let _openTerminal: ((sessionId: string) => void) | null = null;
const _sessionOpenByKey = new Map<string, { requestId: string | null; timer: number; text: string; tone: 'busy' | 'error' }>();
const _progressTicker = createPollAgoTicker(() => _root);
const _detailProgressTicker = createPollAgoTicker(() => _root);
const _ageTicker = createPollAgoTicker(() => _root);
const _queueRowTitles = new WeakMap<HTMLElement, () => string>();
const _readyDetails = new Map<string, ActionDetailHandle>();
const _otherDetails = new Map<string, ActionDetailHandle>();
const _pendingActions = new Map<string, PendingAction>();

interface TeamReviewQueueHooks {
  onChange: () => void;
  captureTurnOrder: () => string[];
  onAdvance: (actedReviewKey: string, capturedOrder: readonly string[]) => void;
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

function createVerdictSeal({ verdict }: Pick<ReviewDraft, 'verdict'>): HTMLElement {
  const seal = el('span', 'pr-verdict-seal');
  seal.dataset.tone = verdictTone(verdict);
  const icon = svgIcon(20, 20);
  const kind = verdictSealKind(verdict);
  icon.append(svgShape('circle', { cx: '10', cy: '10', r: '8.5', fill: kind === 'cross' ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': '1.5' }));
  if (kind === 'check') icon.append(svgShape('path', { d: 'M6 10.5L8.7 13L14 7.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  if (kind === 'dot') icon.append(svgShape('circle', { cx: '10', cy: '10', r: '2.4', fill: 'currentColor' }));
  if (kind === 'bar') icon.append(svgShape('path', { d: 'M6 10H14', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }));
  if (kind === 'cross') icon.append(svgShape('path', { d: 'M7 7L13 13M13 7L7 13', stroke: 'var(--bg)', 'stroke-width': '1.8', 'stroke-linecap': 'round' }));
  seal.append(icon, el('span', null, verdictHeading(verdict)));
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

export function paintQueueRowTitle(row: HTMLElement): void {
  const title = _queueRowTitles.get(row);
  if (!title) return;
  row.title = `${title()}${row.dataset.unseen ? '\nNew ready review' : ''}`;
  row.setAttribute('aria-label', row.title);
}

function repaintStreamerSensitiveTitles(): void {
  _ageTicker.reset();
  trackAges(_root);
}

onStreamerModeChanged(repaintStreamerSensitiveTitles);

function trackAges(root: Element | null): void {
  if (!root) return;
  for (const row of root.querySelectorAll<HTMLElement>('.pr-queue-row')) {
    if (!_queueRowTitles.has(row)) continue;
    paintQueueRowTitle(row);
    _ageTicker.onTick(() => paintQueueRowTitle(row));
  }
  for (const notice of root.querySelectorAll<HTMLElement>('.pr-rereview-notice')) {
    const draft = _view?.drafts.find((review) => review.key === notice.dataset.reviewKey);
    const context = draft ? viewerApprovalContext(draft) : null;
    if (!context) continue;
    const paintNotice = () => { notice.textContent = viewerApprovalNotice(context, formatTimestampAge(context.submittedAt)); };
    paintNotice();
    _ageTicker.onTick(paintNotice);
  }
  for (const avatar of root.querySelectorAll<HTMLElement>('[data-review-title]')) {
    const reviewTitle = avatar.dataset.reviewTitle ?? '';
    const at = avatar.dataset.ageAt === undefined ? null : Number(avatar.dataset.ageAt);
    const paintTitle = () => {
      const age = at === null ? null : formatAgo(at);
      const title = isStreamerMode() ? githubReviewTitle(STREAMER_GITHUB_REVIEW_TITLE, age) : githubReviewTitle(reviewTitle, age);
      avatar.title = title;
      avatar.setAttribute('aria-label', title);
    };
    paintTitle();
    _ageTicker.onTick(paintTitle);
  }
  for (const readout of root.querySelectorAll<HTMLElement>('[data-age-at]')) {
    if (readout.dataset.reviewTitle !== undefined) continue;
    const at = Number(readout.dataset.ageAt);
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
    title: githubReviewTitle(isStreamerMode() ? STREAMER_GITHUB_REVIEW_TITLE : review.text, formatTimestampAge(review.submittedAt)),
  }));
  const stack = createReviewerStack(items, avatarCssPx);
  for (const [index, review] of reviews.entries()) {
    const avatar = stack.children[index];
    if (!(avatar instanceof HTMLElement)) continue;
    avatar.dataset.reviewTitle = review.text;
    const at = ageTimestamp(review.submittedAt);
    if (at !== null) avatar.dataset.ageAt = String(at);
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
  author.append(createAvatar({ login, cssPx }), el('span', 'pr-author-login', login));
  return author;
}

function streamerQueueRowTitle(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind): string {
  return `${pullRequestLabel(review.repo, review.number)}\n${queueRowGlyph(review, kind).meaning}`;
}

export function createTeamQueueRow(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind, hasMultipleRepos: boolean): HTMLButtonElement {
  const row = el('button', 'pr-queue-row pr-queue-row-quiet');
  row.type = 'button';
  row.dataset.reviewKey = review.key;
  const approvalContext = 'reviewedHead' in review ? viewerApprovalContext(review) : null;
  const title = () => isStreamerMode() ? streamerQueueRowTitle(review, kind) : queueRowTitle(review, kind, {
    opened: formatTimestampAge(review.prCreatedAt),
    reviewed: 'reviewedHead' in review ? formatTimestampAge(review.reviewedAt) : null,
    posted: 'reviewedHead' in review ? formatTimestampAge(review.postedAt) : null,
    viewerApproval: formatTimestampAge(approvalContext?.submittedAt),
    githubReviews: 'reviewedHead' in review ? githubReviewItems(review, { isViewerShown: kind !== 'posted' }).map((item) => formatTimestampAge(item.submittedAt)) : [],
  });
  _queueRowTitles.set(row, title);
  paintQueueRowTitle(row);
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
    return row;
  }
  row.classList.remove('pr-queue-row-quiet');
  const rowGlyph = queueRowGlyph(review, kind);
  const glyph = el('span', 'pr-queue-glyph');
  glyph.append(createPrStatusIcon(rowGlyph.icon, rowGlyph.tone));
  const bottom = el('span', 'pr-queue-bottom');
  bottom.append(createRowStateWord(rowGlyph), createAuthor(review.author, 16, 'pr-queue-author'));
  if (review.requestSource === 'direct') {
    const directMarker = el('span', 'pr-queue-direct', '@');
    directMarker.title = 'Requested from you directly';
    bottom.append(directMarker);
  }
  if (kind === 'inReview') bottom.append(el('span', 'pr-phase-label', phaseLabel((review as InFlightReview).phase)));
  row.append(glyph, top, bottom);
  const githubSummary = kind === 'inReview' || kind === 'queued' ? null : createGithubReviewSummary(review as ReviewDraft, 'pr-queue-reviewers', 16, kind !== 'posted');
  if (githubSummary) bottom.append(githubSummary);
  return row;
}

function createRowStateWord(rowGlyph: { tone: string; meaning: string }): HTMLSpanElement {
  const stateWord = el('span', 'my-pr-stage pr-queue-state', rowGlyph.meaning);
  stateWord.dataset.tone = rowGlyph.tone;
  return stateWord;
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

export function createCaughtUpBanner({ title, detail }: { title: string; detail: string }): HTMLElement {
  const banner = el('section', 'pr-caught-up');
  banner.setAttribute('role', 'status');
  const heading = el('strong', 'pr-caught-up-title');
  heading.append(createPrStatusIcon('ready', 'ok'), el('span', null, title));
  banner.append(heading, el('p', 'pr-caught-up-detail', detail));
  return banner;
}

function showActionNotice(notice: ActionReplyNotice | null): void {
  _actionNotice = notice;
  if (!_actionNoticeLine) return;
  _actionNoticeLine.hidden = notice === null;
  paintActionStatus(_actionNoticeLine, notice?.tone ?? null, notice?.text ?? '');
}

const OPEN_SESSION_LABEL = 'Open in session';

const SESSION_OPEN_BUSY_TEXT = 'Preparing the branch and session.';

function showSettledSessionOpen(key: string, text: string, tone: 'error' | null): void {
  for (const status of document.querySelectorAll<HTMLElement>('.pr-session-open-status')) {
    if (status.dataset.reviewKey !== key) continue;
    paintActionStatus(status, tone, text);
    const button = status.parentElement?.querySelector<HTMLButtonElement>('.pr-session-open-button');
    if (button) button.disabled = false;
  }
}

function settleSessionOpen(key: string, text: string): void {
  const opening = _sessionOpenByKey.get(key);
  if (opening) window.clearTimeout(opening.timer);
  _sessionOpenByKey.set(key, { requestId: null, timer: 0, text, tone: 'error' });
  showSettledSessionOpen(key, text, 'error');
}

function openReviewSession(key: string, button: HTMLButtonElement, status: HTMLElement): void {
  if (_sessionOpenByKey.get(key)?.requestId) return;
  const requestId = nextRequestId('open-team-review-session');
  if (!sendControlMsg({ type: 'open-team-review-session', requestId, key })) {
    paintActionStatus(status, 'error', NOT_CONNECTED_TEXT);
    return;
  }
  const timer = window.setTimeout(() => settleSessionOpen(key, `The server did not answer within ${ACTION_REPLY_TIMEOUT_MS / 1000} s.`), ACTION_REPLY_TIMEOUT_MS);
  _sessionOpenByKey.set(key, { requestId, timer, text: SESSION_OPEN_BUSY_TEXT, tone: 'busy' });
  button.disabled = true;
  paintActionStatus(status, 'busy', SESSION_OPEN_BUSY_TEXT);
}

function createOpenSessionControl(review: Pick<ReviewDraft, 'key'>): HTMLElement {
  const row = el('div', 'pr-session-open');
  const button = el('button', 'pr-action pr-session-open-button', OPEN_SESSION_LABEL);
  button.type = 'button';
  const opening = _sessionOpenByKey.get(review.key);
  button.disabled = Boolean(opening?.requestId);
  const status = el('span', 'pr-action-status pr-session-open-status', opening?.text ?? '');
  status.dataset.reviewKey = review.key;
  if (opening) paintActionStatus(status, opening.tone, opening.text);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  button.addEventListener('click', () => openReviewSession(review.key, button, status));
  row.append(button, status);
  return row;
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
  heading.append(title, metadata, createOpenSessionControl(review));
  if ('reviewedHead' in review) {
    const tallyText = viewerThreadsText(review.viewerThreads);
    if (tallyText) {
      const tally = el('p', 'pr-viewer-threads', tallyText);
      if (hasAllViewerThreadsResolved(review)) tally.dataset.state = 'all-resolved';
      heading.append(tally);
    }
  }
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
  heading.replaceWith(createDetailHeading(draft));
  return detail;
}

function otherDetailSignature(draft: ReviewDraft): string {
  return `${JSON.stringify(draft.threads)}:${draft.liveHead}:${draft.status}:${draft.reviewedHead}:${draft.error ?? ''}:${draft.postedEvent ?? ''}:${draft.earlierReview?.head ?? ''}`;
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

function createAssessmentList(items: readonly string[]): HTMLElement {
  const list = el('ul', 'pr-assessment-list');
  for (const item of items) list.append(appendInlineText(el('li', null), item));
  return list;
}

function createHandChecks(draft: ReviewDraft): HTMLElement[] {
  const handChecks = draft.assessment?.handChecks ?? [];
  if (handChecks.length === 0) return [];
  const section = el('section', 'pr-hand-checks');
  section.setAttribute('aria-label', 'Check by hand');
  section.append(el('h3', 'pr-assessment-title', 'Check by hand'));
  const items = handChecks.map((check) => (check.paths.length === 0 ? check.text : `${check.text}: ${check.paths.map((path) => `\`${path}\``).join(', ')}`));
  section.append(createAssessmentList(items));
  return [section];
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

function createVerdictBlock(draft: ReviewDraft): HTMLElement {
  const verdict = el('section', 'pr-verdict-box');
  verdict.setAttribute('aria-label', 'Verdict');
  const verdictLine = el('div', 'pr-verdict-line');
  verdictLine.append(createVerdictSeal(draft));
  verdict.append(verdictLine);
  const { assessment } = draft;
  if (!assessment) {
    verdict.append(el('p', 'pr-verdict-legacy', LEGACY_SUMMARY_HINT));
    if (draft.summary.trim()) verdict.append(appendInlineText(el('p', 'pr-verdict-summary pr-verdict-reason'), draft.summary));
    return verdict;
  }
  verdict.append(appendInlineText(el('p', 'pr-verdict-summary pr-verdict-reason'), draft.summary));
  if (assessment.gaps.length > 0) {
    const gaps = createAssessmentList(assessment.gaps);
    gaps.classList.add('pr-verdict-gaps');
    gaps.setAttribute('aria-label', 'Not covered');
    verdict.append(gaps);
  }
  if (assessment.checked.length === 0) return verdict;
  const checked = el('details', 'pr-verdict-checked');
  checked.append(el('summary', null, `What it checked (${assessment.checked.length})`), createAssessmentList(assessment.checked));
  verdict.append(checked);
  return verdict;
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

interface FindingContent {
  body: string;
  severity: FindingSeverity | null;
  location: string;
  locationTitle: string;
}

function commentFindingContent(comment: DraftComment): FindingContent {
  return { body: comment.body, severity: commentSeverity(comment), location: shortCommentLocation(comment), locationTitle: commentLocation(comment) };
}

function generalFindingContent(finding: GeneralFinding): FindingContent {
  const locationTitle = finding.location ?? 'Not on a changed line, posts in the review body';
  return { body: finding.body, severity: finding.severity, location: finding.location?.split('/').at(-1) ?? 'general', locationTitle };
}

function createCommentContent({ body, severity, location: locationText, locationTitle }: FindingContent): HTMLDetailsElement {
  const content = el('details', 'pr-comment-content');
  const header = el('summary', 'pr-comment-header');
  const parsed = parseReviewComment(body);
  if (severity) header.append(createSeverityMeter(severity));
  const location = el('span', 'pr-comment-location', locationText);
  location.title = locationTitle;
  header.append(location);
  header.append(el('span', 'pr-comment-preview', reviewCommentPreview(parsed.paragraphs)));
  content.append(header);
  const paragraphs = el('div', 'pr-comment-paragraphs');
  for (const paragraph of parsed.paragraphs) paragraphs.append(createCommentParagraph(paragraph));
  content.append(paragraphs);
  content.open = severity === 'HIGH' || severity === 'CRITICAL';
  return content;
}

function createEarlierReviewDetails(review: EarlierReview, isOpen: boolean): HTMLElement {
  const details = el('details', 'pr-disclosure pr-earlier-review');
  const summary = el('summary', 'pr-disclosure-summary');
  summary.append(el('span', 'pr-disclosure-label', 'Earlier review'), el('span', 'pr-disclosure-preview', earlierReviewPreview(review)));
  const body = el('div', 'pr-earlier-review-body');
  const verdictLine = el('div', 'pr-verdict-line');
  verdictLine.append(createVerdictSeal(review));
  body.append(verdictLine);
  if (review.summary.trim()) body.append(appendInlineText(el('p', 'pr-verdict-summary'), review.summary));
  for (const comment of review.comments) {
    const card = el('article', 'pr-comment-card pr-comment-card-readonly');
    card.append(createCommentContent(commentFindingContent(comment)));
    body.append(card);
  }
  details.append(summary, body);
  details.open = isOpen;
  return details;
}

function createChangedSinceReview(draft: ReviewDraft): HTMLElement[] {
  const text = changedSinceReviewText(draft);
  if (!text) return [];
  const line = el('p', 'pr-changed-since', text);
  line.append(' ', externalLink('pr-changed-since-link', 'Compare changes', changedSinceReviewUrl(draft), 'Open the commits since this review on GitHub'));
  return [line];
}

function inReviewEarlierDetails(review: InFlightReview): HTMLElement[] {
  const draft = _view?.drafts.find((candidate) => candidate.key === review.key);
  const earlier = draft?.earlierReview ?? null;
  if (!earlier) {
    _inReviewEarlierDetails = null;
    return [];
  }
  if (_inReviewEarlierDetails?.key === review.key && _inReviewEarlierDetails.head === earlier.head) return [_inReviewEarlierDetails.element];
  const element = createEarlierReviewDetails(earlier, false);
  _inReviewEarlierDetails = { key: review.key, head: earlier.head, element };
  return [element];
}

function createTickableFinding(content: FindingContent, included: Set<number>, index: number, onToggle: () => void): HTMLElement {
  const card = el('article', 'pr-comment-card');
  const checkbox = el('input', 'pr-comment-checkbox');
  checkbox.type = 'checkbox';
  checkbox.checked = included.has(index);
  checkbox.setAttribute('aria-label', `Post finding on ${content.locationTitle}`);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) included.add(index);
    if (!checkbox.checked) included.delete(index);
    card.dataset.included = String(checkbox.checked);
    onToggle();
  });
  card.dataset.included = String(checkbox.checked);
  card.append(checkbox, createCommentContent(content));
  return card;
}

const FOLLOW_UP_APPROVAL_HINT = 'Your comments are on GitHub. Approve adds an approval without posting them again.';

function sendAction(origin: DetailOrigin, review: Pick<ReviewDraft, 'key' | 'repo' | 'number'>, request: TeamReviewActionRequest, settle: (isDone: boolean, text: string) => void, outcomeText = actionOutcomeText(request.action)): boolean {
  const capturedOrder = _queueHooks?.captureTurnOrder() ?? [];
  showActionNotice(null);
  const requestId = nextRequestId('team-review-action');
  const isSent = sendControlMsg({ type: 'team-review-action', requestId, ...request });
  if (!isSent) return false;
  const timer = window.setTimeout(() => {
    _pendingActions.delete(review.key);
    settle(false, ACTION_NO_REPLY_TEXT);
  }, ACTION_REPLY_TIMEOUT_MS);
  _pendingActions.set(review.key, { requestId, action: request.action, outcomeText, origin, capturedOrder, pullRequest: pullRequestLabel(review.repo, review.number), timer, settle });
  return true;
}

function createNotMineFooter(review: QueuedReview | InFlightReview): HTMLElement {
  const footer = el('footer', 'pr-footer');
  const button = createFooterButton('discard', () => {
    if (_pendingActions.has(review.key)) return;
    button.disabled = true;
    paintActionStatus(status, 'busy', actionProgressText('discard'));
    if (sendAction('other', review, buildNotMineRequest(review.key), settle)) return;
    settle(false, NOT_CONNECTED_TEXT);
  });
  const isPending = _pendingActions.has(review.key);
  button.disabled = isPending;
  const status = el('span', 'pr-action-status');
  if (isPending) paintActionStatus(status, 'busy', actionProgressText('discard'));
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const settle = (isDone: boolean, text: string) => {
    button.disabled = isDone;
    paintActionStatus(status, isDone ? 'ok' : 'error', text);
    if (!isDone) showActionNotice({ text: `${pullRequestLabel(review.repo, review.number)}: ${text}`, tone: 'error' });
  };
  footer.append(button, status);
  return footer;
}

function createFooterButton(action: TeamReviewAction, runAction: (action: TeamReviewAction) => void, isSecondary = false): HTMLButtonElement {
  const button = el('button', isSecondary ? 'pr-action pr-action-ghost' : 'pr-action', actionLabel(action));
  button.type = 'button';
  button.dataset.action = action;
  button.addEventListener('click', () => runAction(action));
  return button;
}

interface DecisionBar {
  footer: HTMLElement;
  status: HTMLElement;
  buttons: HTMLButtonElement[];
}

function createDecisionBar(draft: Pick<ReviewDraft, 'status' | 'postedEvent'>, runAction: (action: TeamReviewAction) => void, statusText = ''): DecisionBar {
  const layout = detailActionLayout(draft);
  const footer = el('footer', 'pr-footer pr-decision-bar');
  const status = el('span', 'pr-action-status', statusText);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const primary = layout.primary.map((action) => createFooterButton(action, runAction));
  const secondary = layout.secondary.map((action) => createFooterButton(action, runAction, true));
  footer.append(...primary, el('span', 'pr-decision-spacer'), ...secondary, status);
  return { footer, status, buttons: [...primary, ...secondary] };
}

let _noteFieldCount = 0;

function createNoteField(onInput: () => void): { section: HTMLElement; input: HTMLTextAreaElement } {
  const section = el('section', 'pr-note');
  _noteFieldCount += 1;
  const input = el('textarea', 'pr-body-input pr-note-input');
  input.id = `pr-note-${_noteFieldCount}`;
  input.rows = 2;
  input.spellcheck = true;
  input.placeholder = 'Optional. Posts at the top of the review, above the automated-review label.';
  input.addEventListener('input', onInput);
  const label = el('label', 'pr-section-heading', 'Your note');
  label.htmlFor = input.id;
  section.append(label, input);
  return { section, input };
}

function createReadyDetail(draft: ReviewDraft): ActionDetailHandle {
  const detail = el('article', 'pr-detail');
  const threads = el('div');
  threads.dataset.reviewThreads = '';
  detail.append(createDetailHeading(draft), ...createAboutPr(draft));
  if (draft.earlierReview) detail.append(createEarlierReviewDetails(draft.earlierReview, false));
  detail.append(threads, createVerdictBlock(draft), ...createHandChecks(draft));
  refreshThreadDetails(detail, draft);

  const generalFindings = generalFindingsOf(draft.body);
  const includedComments = new Set(draft.comments.flatMap((comment, index) => (isIncludedByDefault(comment) ? [index] : [])));
  const includedGeneral = new Set(generalFindings.flatMap((finding, index) => (isSeverityIncludedByDefault(finding.severity) ? [index] : [])));
  const findingCount = draft.comments.length + generalFindings.length;
  const findings = el('section', 'pr-posts');
  findings.setAttribute('aria-label', 'Findings');
  const findingsHeading = el('div', 'pr-posts-heading');
  const findingsTally = el('span', null);
  findingsHeading.append(el('h3', null, 'Findings'), findingsTally);
  findings.append(findingsHeading);
  const note = createNoteField(() => paintDecision());
  const selection = (): ReviewSelection => ({
    note: note.input.value,
    comments: draft.comments.filter((_comment, index) => includedComments.has(index)),
    generalFindings: generalFindings.filter((_finding, index) => includedGeneral.has(index)),
  });
  let isBusy = false;
  const runAction = (action: TeamReviewAction) => {
    if (_pendingActions.has(draft.key)) return;
    const chosen = selection();
    const request = action === 'approve' || action === 'comment' ? buildReadyDecisionRequest(draft, action, chosen) : buildActionRequest(draft, action, '', []);
    setBusy(true);
    paintActionStatus(bar.status, 'busy', actionProgressText(request.action));
    if (sendAction('ready', draft, request, settle, postedOutcomeText(request.action, chosen))) return;
    settle(false, NOT_CONNECTED_TEXT);
  };
  const bar = createDecisionBar(draft, runAction);
  function paintControls(): void {
    const isCommentReady = hasSelection(selection());
    for (const button of bar.buttons) button.disabled = isBusy || (button.dataset.action === 'comment' && !isCommentReady);
    detail.dataset.busy = String(isBusy);
  }
  function setBusy(nextIsBusy: boolean): void {
    isBusy = nextIsBusy;
    paintControls();
  }
  function paintDecision(): void {
    const chosen = selection();
    findingsTally.textContent = `${chosen.comments.length + chosen.generalFindings.length} of ${findingCount} will post. Low severity starts unticked.`;
    paintControls();
    if (_pendingActions.has(draft.key) || bar.status.dataset.tone === 'ok') return;
    paintActionStatus(bar.status, null, postingPreviewText(draft, chosen));
  }
  const settle = (isDone: boolean, text: string) => {
    setBusy(isDone);
    paintActionStatus(bar.status, isDone ? 'ok' : 'error', text);
  };
  for (const [index, comment] of draft.comments.entries()) findings.append(createTickableFinding(commentFindingContent(comment), includedComments, index, paintDecision));
  for (const [index, finding] of generalFindings.entries()) findings.append(createTickableFinding(generalFindingContent(finding), includedGeneral, index, paintDecision));
  if (findingCount > 0) detail.append(findings);
  detail.append(note.section, bar.footer);
  paintDecision();
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
  heading.append(title, metadata, createOpenSessionControl(review));
  detail.append(heading, el('p', 'pr-attention-detail', queuedDetailText(runningCount)), createNotMineFooter(review));
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
  _detailProgressTicker.track(progressText, review.startedAt, () => inFlightProgressText(review, Date.now()));
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
  detail.append(steps, ...inReviewEarlierDetails(review), createNotMineFooter(review));
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

function createThreadBody(body: string, isViewerComment: boolean, isTruncated: boolean, threadUrl: string): HTMLElement {
  const content = el('div', isViewerComment ? 'pr-thread-message pr-thread-message-muted' : 'pr-thread-message');
  content.append(el('p', 'pr-thread-body pr-thread-preview', body));
  const previewLines = isViewerComment ? THREAD_COMMENT_PREVIEW_LINES : THREAD_REPLY_PREVIEW_LINES;
  if (!isTruncated && !threadBodyOverflowsPreview(body, previewLines)) return content;
  const disclosure = el('details', 'pr-thread-disclosure');
  disclosure.append(el('summary', 'pr-thread-expand', isViewerComment ? 'Expand comment' : 'Expand reply'), el('p', 'pr-thread-body', body));
  if (isTruncated) disclosure.append(externalLink('pr-link pr-thread-continues', isViewerComment ? 'Comment continues on GitHub' : 'Reply continues on GitHub', threadUrl));
  content.append(disclosure);
  return content;
}

function createThreadDetails(draft: ReviewDraft): HTMLElement[] {
  const items = detailThreadItems(draft);
  if (items.length === 0) return [];
  const section = el('section', 'my-pr-threads-section');
  section.append(el('h3', 'pr-section-heading', 'Answered threads'));
  const list = el('div', 'my-pr-threads');
  for (const item of items) {
    const row = el('div', 'my-pr-thread pr-thread-card');
    const heading = el('div', 'my-pr-thread-heading pr-thread-heading');
    const chip = el('span', 'pr-thread-chip', item.judgementLabel);
    chip.dataset.tone = item.judgementTone;
    heading.append(externalLink('pr-link my-pr-thread-location', item.location, item.thread.url), chip);
    row.append(heading);
    if (item.judgementReason) row.append(el('p', 'my-pr-thread-meta', item.judgementReason));
    if (item.thread.viewerComment) {
      row.append(el('div', 'my-pr-thread-meta', 'Your comment'), createThreadBody(item.thread.viewerComment, true, item.thread.viewerCommentTruncated === true, item.thread.url));
    }
    const reply = el('div', 'pr-detail-meta pr-thread-reply-meta');
    reply.append(el('span', 'pr-author-login', item.thread.lastReplyAuthor), ' replied');
    const age = createAgeReadout('', item.thread.lastReplyAt);
    if (age) reply.append(age);
    const status = el('span', 'pr-action-status');
    status.setAttribute('role', 'status');
    const button = el('button', 'pr-action', 'Resolve');
    button.type = 'button';
    button.disabled = !item.canResolve || _pendingActions.has(draft.key);
    const settle = (isDone: boolean, text: string) => {
      button.disabled = isDone || !item.canResolve;
      paintActionStatus(status, isDone ? 'ok' : 'error', text);
    };
    button.addEventListener('click', () => {
      if (_pendingActions.has(draft.key)) return;
      button.disabled = true;
      paintActionStatus(status, 'busy', actionProgressText('resolve-thread'));
      if (sendAction('other', draft, buildActionRequest(draft, 'resolve-thread', '', [], item.thread.id), settle)) return;
      settle(false, NOT_CONNECTED_TEXT);
    });
    row.append(reply);
    if (item.thread.lastReplyBody) row.append(createThreadBody(item.thread.lastReplyBody, false, item.thread.lastReplyTruncated === true, item.thread.url));
    const footer = el('footer', 'pr-thread-footer');
    footer.append(status, button);
    row.append(footer);
    if (item.thread.resolveError) row.append(el('p', 'pr-attention-detail', item.thread.resolveError));
    list.append(row);
  }
  section.append(list);
  return [section];
}

function createOtherDetail(draft: ReviewDraft): HTMLElement {
  const detail = el('article', 'pr-detail');
  detail.append(createDetailHeading(draft), ...createAboutPr(draft));
  if (draft.earlierReview) detail.append(createEarlierReviewDetails(draft.earlierReview, draft.status === 'stale'));
  detail.append(...createThreadDetails(draft));
  if (draft.status === 'posted') detail.append(createVerdictBlock(draft));
  if (draft.status !== 'posted') detail.append(el('p', 'pr-attention-detail', attentionDetail(draft)));
  if (draft.status === 'stale') detail.append(...createChangedSinceReview(draft));
  if (!hasRequeueFooter(draft.status)) {
    _otherDetails.set(draft.key, { signature: otherDetailSignature(draft), element: detail, settle: () => {} });
    return detail;
  }
  const runAction = (action: TeamReviewAction) => {
    if (_pendingActions.has(draft.key)) return;
    for (const button of bar.buttons) button.disabled = true;
    paintActionStatus(bar.status, 'busy', actionProgressText(action));
    if (sendAction('other', draft, buildActionRequest(draft, action, '', []), settle)) return;
    settle(false, NOT_CONNECTED_TEXT);
  };
  const bar = createDecisionBar(draft, runAction, detailActionLayout(draft).primary.includes('approve-only') ? FOLLOW_UP_APPROVAL_HINT : '');
  const settle = (isDone: boolean, message: string) => {
    for (const button of bar.buttons) button.disabled = isDone;
    paintActionStatus(bar.status, isDone ? 'ok' : 'error', message);
  };
  detail.append(bar.footer);
  _otherDetails.set(draft.key, { signature: otherDetailSignature(draft), element: detail, settle });
  return detail;
}

function otherDetailFor(draft: ReviewDraft): HTMLElement {
  if (!hasRequeueFooter(draft.status) && detailThreadItems(draft).length === 0) return createOtherDetail(draft);
  const cached = _otherDetails.get(draft.key);
  if (cached && (_pendingActions.has(draft.key) || cached.signature === otherDetailSignature(draft))) return refreshDetailHeading(cached.element, draft);
  return createOtherDetail(draft);
}

function createHandReviewDetail(review: QueuedReview): HTMLElement {
  const detail = el('article', 'pr-detail');
  const heading = el('div', 'pr-detail-heading');
  const title = el('div', 'pr-detail-title');
  title.append(pullRequestLink(review), el('h2', null, review.title));
  const metadata = el('div', 'pr-detail-meta');
  metadata.append(createAuthor(review.author, 20, 'pr-detail-author'));
  const openedAge = createAgeReadout('Opened', review.prCreatedAt);
  if (openedAge) metadata.append(openedAge);
  heading.append(title, metadata);
  const footer = el('footer', 'pr-footer');
  footer.append(externalLink('pr-action', 'Review on GitHub', review.url));
  detail.append(heading, el('p', 'pr-attention-detail', HAND_REVIEW_DETAIL), footer);
  return detail;
}

const HAND_REVIEW_DETAIL = 'From a fork, so the agent cannot check out its branch. Review it on GitHub.';

function renderSelectedDetail(sections: TeamReviewSections): void {
  if (!_detail || !_selectedKey) return;
  const threadDraft = sections.ready.find((draft) => draft.key === _selectedKey && (answeredNonNitThreads(draft).length > 0 || isPostedAwaitingViewer(draft)));
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
    _detailProgressTicker.reset();
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
  const handReview = sections.handReview.find((review) => review.key === _selectedKey);
  if (handReview) {
    const signature = `handReview:${handReview.key}`;
    if (_renderedDetailSignature === signature) return;
    _detail.replaceChildren(createHandReviewDetail(handReview));
    _renderedDetailSignature = signature;
    return;
  }
  const other = [...sections.noReviewNeeded, ...sections.attention, ...sections.posted, ...sections.discarded].find((draft) => draft.key === _selectedKey);
  if (!other) return;
  _detail.replaceChildren(otherDetailFor(other));
  _renderedDetailSignature = `${other.status}:${other.key}`;
}

export function teamReviewEmptyState(): HTMLElement {
  const empty = el('p', 'pr-empty', emptyStateText(_view));
  if (_view && !_view.configured) empty.append(' ', createSettingsLink(TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID, 'Open Team review settings'));
  return empty;
}

export function teamReviewLaneNotices(): HTMLElement[] {
  const text = laneNotice(_view);
  return text ? [el('p', 'my-pr-note', text)] : [];
}

function forgetDepartedDetails(readyKeys: Set<string>): void {
  for (const key of [..._readyDetails.keys()]) {
    if (readyKeys.has(key) || _pendingActions.has(key)) continue;
    _readyDetails.delete(key);
  }
  const requeueKeys = new Set(_view?.drafts.filter((draft) => hasRequeueFooter(draft.status)).map((draft) => draft.key) ?? []);
  for (const key of _otherDetails.keys()) {
    if (requeueKeys.has(key) || _pendingActions.has(key)) continue;
    _otherDetails.delete(key);
  }
}

export function teamReviewSections(): TeamReviewSections {
  return groupDrafts(_view);
}

export function teamReviewStatusView(): TeamReviewStatusType | null {
  return _view;
}

export function resetTeamQueueTickers(): void {
  _progressTicker.reset();
}

export function refreshTeamReviewAges(): void {
  _ageTicker.reset();
  trackAges(_root);
}

export function releaseTeamReviewSelection(notice: 'keep' | 'clear'): void {
  if (notice === 'clear') showActionNotice(null);
  _selectedKey = null;
}

export function teamReviewActionNotice(): HTMLElement {
  if (_actionNoticeLine) return _actionNoticeLine;
  _actionNoticeLine = el('p', 'pr-action-status pr-action-notice');
  _actionNoticeLine.setAttribute('role', 'status');
  _actionNoticeLine.setAttribute('aria-live', 'polite');
  showActionNotice(_actionNotice);
  return _actionNoticeLine;
}

export function showTeamReview(reviewKey: string, notice: 'keep' | 'clear'): void {
  if (notice === 'clear') showActionNotice(null);
  _selectedKey = reviewKey;
  renderSelectedDetail(groupDrafts(_view));
  refreshTeamReviewAges();
}

function forgetDetailsOutsideSections(sections: TeamReviewSections): void {
  forgetDepartedDetails(new Set([...sections.ready, ...sections.noReviewNeeded].map((draft) => draft.key)));
}

function handleTeamReviewChange(): void {
  const sections = groupDrafts(_view);
  forgetDetailsOutsideSections(sections);
  renderSelectedDetail(sections);
  _queueHooks?.onChange();
  refreshTeamReviewAges();
}

export function mountTeamReviewDetail(root: HTMLElement, hooks: TeamReviewQueueHooks, navigation?: { openTerminal: (sessionId: string) => void }): HTMLElement {
  _openTerminal = navigation?.openTerminal ?? _openTerminal;
  _queueHooks = hooks;
  _root = root;
  if (_detailHost) return _detailHost;
  _detailHost = el('div', 'pr-detail-team');
  _detail = el('div', 'pr-detail-body');
  _detailHost.append(_detail);
  _progressTicker.ensure();
  _detailProgressTicker.ensure();
  _ageTicker.ensure();
  return _detailHost;
}

export function applyTeamReviewStatus(message: unknown): void {
  const parsed = TeamReviewStatus.safeParse(message);
  if (!parsed.success) return;
  _latest = parsed.data;
  _view = joinTeamReviews(_latest, githubPrByKey);
  handleTeamReviewChange();
}
export function applyOpenTeamReviewSessionResult(message: ServerMessageOf<'open-team-review-session-result'>): void {
  const key = message.key;
  if (!key) return;
  const opening = _sessionOpenByKey.get(key);
  if (!opening || opening.requestId !== message.requestId) return;
  if (!message.ok || !message.sessionId) {
    settleSessionOpen(key, message.error || 'Could not open a session.');
    return;
  }
  window.clearTimeout(opening.timer);
  _sessionOpenByKey.delete(key);
  showSettledSessionOpen(key, '', null);
  _openTerminal?.(message.sessionId);
}

export function applyTeamReviewConnectionState(isConnected: boolean): void {
  if (isConnected) return;
  for (const [key, opening] of _sessionOpenByKey) {
    if (opening.requestId) settleSessionOpen(key, NOT_CONNECTED_TEXT);
  }
  const pendingActions = [..._pendingActions.values()];
  _pendingActions.clear();
  for (const pending of pendingActions) {
    window.clearTimeout(pending.timer);
    pending.settle?.(false, ACTION_DISCONNECTED_TEXT);
  }
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
    if (actionResult.ok === true) handleTeamReviewChange();
    return;
  }
  const owningCache = pending.origin === 'ready' ? _readyDetails : _otherDetails;
  const handle = owningCache.get(actionResult.key);
  if (actionResult.ok === true) {
    if (pending.origin === 'other') _otherDetails.delete(actionResult.key);
    const reply = planActionReply({
      action: pending.action,
      outcomeText: pending.outcomeText,
      pullRequest: pending.pullRequest,
      warning: typeof actionResult.warning === 'string' ? actionResult.warning : '',
      isActedSelected: _selectedKey === actionResult.key,
    });
    (handle?.settle ?? pending.settle)?.(true, reply.statusText);
    if (reply.notice || reply.shouldAdvance) showActionNotice(reply.notice);
    if (!reply.shouldAdvance) return;
    forgetDetailsOutsideSections(groupDrafts(_view));
    _queueHooks?.onAdvance(actionResult.key, pending.capturedOrder);
    return;
  }
  (handle?.settle ?? pending.settle)?.(false, typeof actionResult.error === 'string' && actionResult.error ? actionResult.error : 'The action failed.');
}

subscribeGithubPrs(() => {
  _view = joinTeamReviews(_latest, githubPrByKey);
  handleTeamReviewChange();
});
