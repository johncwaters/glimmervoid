import { paintActionStatus } from '../action-status.ts';
import { button } from '../ui/button.ts';
import type { DiffExcerptLine, DraftComment, EarlierReview, FindingSeverity, HandCheck, InFlightReview, QueuedReview, ReviewDraft, TeamReviewAction, TeamReviewActionRequest } from '#shared/contracts/team-review.ts';
import { nextRequestId, sendControlMsg } from '../control-ws.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import { el, externalLink } from '../dom-helpers.ts';
import { changedSinceReviewText, reviewTierReason, changedSinceReviewUrl, earlierReviewPreview, aboutPrParagraphs, actionLabel, actionOutcomeText, actionProgressText, buildNotMineRequest, checksText, commentLocation, detailActionLayout, groupHandCheckPaths, HAND_CHECK_INLINE_PATH_LIMIT, handCheckPathSummary, parseInlineSegments, LEGACY_SUMMARY_HINT, parseReviewComment, reviewCommentPreview, shortCommentLocation, pullRequestLabel, detailHeadingSignature, commentSeverity, detailMetaText, viewerThreadsText, hasAllViewerThreadsResolved, viewerApprovalContext, viewerApprovalNotice, alreadyFlaggedText } from './team-review-view-core.ts';
import type { GeneralFinding } from './team-review-view-core.ts';
import { _pendingActions, _queueHooks, _sessionOpenByKey, _view, setPostedReceipt } from './team-review-panel-state.ts';
import type { DetailOrigin, SettleAction } from './team-review-panel-state.ts';
import { createAgeReadout, createAuthor, createGithubReviewSummary, createQuestionGlyph, createSeverityMeter, createVerdictSeal, formatTimestampAge, pullRequestLink } from './team-review-queue-row.ts';

const ACTION_REPLY_TIMEOUT_MS = 120000;

const ACTION_NO_REPLY_TEXT = `The server did not answer within ${ACTION_REPLY_TIMEOUT_MS / 1000} s. Check GitHub before trying again.`;

let _inReviewEarlierDetails: { key: string; head: string; element: HTMLElement } | null = null;

const OPEN_SESSION_LABEL = 'Open in session';

const SESSION_OPEN_BUSY_TEXT = 'Preparing the branch and session.';

function showSettledSessionOpen(key: string, text: string, tone: 'error' | null): void {
  for (const status of document.querySelectorAll<HTMLElement>('.pr-session-open-status')) {
    if (status.dataset.reviewKey !== key) continue;
    paintActionStatus(status, tone, text);
    const openButton = status.parentElement?.querySelector<HTMLButtonElement>('[data-action="open-session"]');
    if (openButton) openButton.disabled = false;
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
  const opening = _sessionOpenByKey.get(review.key);
  const openButton = button({ variant: 'secondary', label: OPEN_SESSION_LABEL, action: 'open-session', shortcutKey: 'O', disabled: Boolean(opening?.requestId) });
  const status = el('span', 'pr-action-status pr-session-open-status', opening?.text ?? '');
  status.dataset.reviewKey = review.key;
  if (opening) paintActionStatus(status, opening.tone, opening.text);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  openButton.addEventListener('click', () => openReviewSession(review.key, openButton, status));
  row.append(openButton, status);
  return row;
}

function createDetailHeading(review: ReviewDraft | InFlightReview, { hasFactsRail = false }: { hasFactsRail?: boolean } = {}): HTMLElement {
  const heading = el('div', 'pr-detail-heading');
  heading.dataset.signature = detailHeadingSignature(review);
  const title = el('div', 'pr-detail-title');
  title.append(pullRequestLink(review), el('h2', null, review.title));
  const metadata = el('div', 'pr-detail-meta');
  metadata.append(createAuthor(review, 20, 'pr-detail-author'));
  metadata.append(el('span', null, detailMetaText(review)));
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
  heading.append(title, metadata, el('p', 'pr-detail-tier-reason', reviewTierReason(review)));
  if (!hasFactsRail) heading.append(createOpenSessionControl(review));
  if ('reviewedHead' in review && !hasFactsRail) {
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

function refreshDetailHeading(detail: HTMLElement, draft: ReviewDraft, options: { hasFactsRail?: boolean } = {}): HTMLElement {
  const heading = detail.querySelector<HTMLElement>('.pr-detail-heading');
  if (!heading || heading.dataset.signature === detailHeadingSignature(draft)) return detail;
  heading.replaceWith(createDetailHeading(draft, options));
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
  const list = el('ul', 'pr-assessment-list');
  for (const check of handChecks) list.append(createHandCheckItem(check));
  section.append(list);
  return [section];
}

function asCode(text: string): string {
  return `\`${text}\``;
}

function createHandCheckItem(check: HandCheck): HTMLElement {
  const item = el('li', null);
  if (check.paths.length === 0) return appendInlineText(item, check.text);
  if (check.paths.length <= HAND_CHECK_INLINE_PATH_LIMIT) return appendInlineText(item, `${check.text}: ${check.paths.map(asCode).join(', ')}`);
  const folders = groupHandCheckPaths(check.paths);
  const disclosure = el('details', 'pr-verdict-checked');
  const folderList = el('ul', 'pr-assessment-list');
  for (const { folder, fileNames } of folders) {
    const folderItem = appendInlineText(el('li', null), asCode(folder));
    folderItem.append(createAssessmentList(fileNames.map(asCode)));
    folderList.append(folderItem);
  }
  disclosure.append(el('summary', null, handCheckPathSummary(check.paths.length, folders.length)), folderList);
  appendInlineText(item, check.text);
  item.append(disclosure);
  return item;
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
  excerpt?: readonly DiffExcerptLine[];
  citedLine?: number;
  alreadyFlagged?: string;
}

function withAlreadyFlagged(alreadyFlagged: string | null): Pick<FindingContent, 'alreadyFlagged'> {
  return alreadyFlagged === null ? {} : { alreadyFlagged };
}

function commentFindingContent(comment: DraftComment): FindingContent {
  return {
    body: comment.body, severity: commentSeverity(comment), location: shortCommentLocation(comment), locationTitle: commentLocation(comment),
    ...(comment.excerpt ? { excerpt: comment.excerpt, citedLine: comment.line } : {}),
    ...withAlreadyFlagged(alreadyFlaggedText(comment)),
  };
}

const EXCERPT_GUTTERS: Readonly<Record<DiffExcerptLine['kind'], string>> = Object.freeze({ add: '+', del: '-', context: ' ' });

function createDiffExcerpt(excerpt: readonly DiffExcerptLine[], citedLine: number | undefined): HTMLElement {
  const block = el('div', 'pr-diff-excerpt');
  for (const line of excerpt) {
    const row = el('div', `review-line review-line-${line.kind}`);
    if (line.line !== null && line.line === citedLine) row.dataset.cited = 'true';
    row.append(el('span', 'pr-diff-excerpt-number', line.line === null ? '' : String(line.line)), el('span', 'review-line-gutter', EXCERPT_GUTTERS[line.kind]), el('span', 'review-line-text', line.text));
    block.append(row);
  }
  return block;
}

function generalFindingContent(finding: GeneralFinding): FindingContent {
  const locationTitle = finding.location ?? 'Not on a changed line, posts in the review body';
  return { body: finding.body, severity: finding.severity, location: finding.location?.split('/').at(-1) ?? 'general', locationTitle };
}

function createCommentContent({ body, severity, location: locationText, locationTitle, excerpt, citedLine, alreadyFlagged }: FindingContent): HTMLDetailsElement {
  const content = el('details', 'pr-comment-content');
  const header = el('summary', 'pr-comment-header');
  const parsed = parseReviewComment(body);
  if (severity) header.append(createSeverityMeter(severity), el('span', 'pr-severity-word', severity.toLowerCase()));
  const location = el('span', 'pr-comment-location', locationText);
  header.append(location);
  if (alreadyFlagged) header.append(el('span', 'pr-comment-flagged', alreadyFlagged));
  header.append(el('span', 'pr-comment-preview', reviewCommentPreview(parsed.paragraphs)));
  content.append(header, el('p', 'pr-comment-where', locationTitle));
  const paragraphs = el('div', 'pr-comment-paragraphs');
  for (const paragraph of parsed.paragraphs) paragraphs.append(createCommentParagraph(paragraph));
  content.append(paragraphs);
  if (excerpt && excerpt.length > 0) content.append(createDiffExcerpt(excerpt, citedLine));
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
  const line = el('p', 'pr-changed-since');
  line.append(text, ' ', externalLink('pr-changed-since-link', 'Compare changes', changedSinceReviewUrl(draft)));
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
  const toggle = el('label', 'pr-post-toggle');
  const checkbox = el('input', 'pr-post-checkbox');
  checkbox.type = 'checkbox';
  checkbox.checked = included.has(index);
  card.dataset.included = String(checkbox.checked);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) included.add(index);
    if (!checkbox.checked) included.delete(index);
    card.dataset.included = String(checkbox.checked);
    card.querySelector<HTMLElement>('.pr-comment-header')?.focus({ preventScroll: true });
    onToggle();
  });
  toggle.append(checkbox, el('span', null, 'Post'));
  card.append(toggle, createCommentContent(content));
  return card;
}

const FOLLOW_UP_APPROVAL_HINT = 'Your comments are on GitHub. Approve adds an approval without posting them again.';

function sendAction(origin: DetailOrigin, review: Pick<ReviewDraft, 'key' | 'repo' | 'number'>, request: TeamReviewActionRequest, settle: SettleAction, outcomeText = actionOutcomeText(request.action)): boolean {
  const capturedOrder = _queueHooks?.captureTurnOrder() ?? [];
  setPostedReceipt(null);
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
  const discardButton = createFooterButton('discard', () => {
    if (_pendingActions.has(review.key)) return;
    discardButton.disabled = true;
    paintActionStatus(status, 'busy', actionProgressText('discard'));
    if (sendAction('other', review, buildNotMineRequest(review.key), settle)) return;
    settle(false, NOT_CONNECTED_TEXT);
  });
  const isPending = _pendingActions.has(review.key);
  discardButton.disabled = isPending;
  const status = el('span', 'pr-action-status');
  if (isPending) paintActionStatus(status, 'busy', actionProgressText('discard'));
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const settle: SettleAction = (isDone, text, tone = isDone ? 'ok' : 'error') => {
    discardButton.disabled = isDone;
    paintActionStatus(status, tone, text);
  };
  footer.append(discardButton, status);
  return footer;
}

type FooterButtonVariant = 'primary' | 'secondary' | 'quiet';

function createFooterButton(action: TeamReviewAction, runAction: (action: TeamReviewAction) => void, variant: FooterButtonVariant = 'primary', shortcutKey?: string): HTMLButtonElement {
  return button({ variant, label: actionLabel(action), action, shortcutKey, onClick: () => runAction(action) });
}

interface DecisionBar {
  footer: HTMLElement;
  status: HTMLElement;
  buttons: HTMLButtonElement[];
}

function createDecisionBar(draft: Pick<ReviewDraft, 'status' | 'postedEvent' | 'verdict'>, runAction: (action: TeamReviewAction) => void, statusText = '', shortcutByAction: Partial<Readonly<Record<TeamReviewAction, string>>> = {}): DecisionBar {
  const layout = detailActionLayout(draft);
  const footer = el('footer', 'pr-footer pr-decision-bar');
  const status = el('span', 'pr-action-status', statusText);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const leading = layout.leading.map((action) => createFooterButton(action, runAction, action === layout.recommended ? 'primary' : 'secondary', shortcutByAction[action]));
  const trailing = layout.trailing.map((action) => createFooterButton(action, runAction, 'quiet', shortcutByAction[action]));
  footer.append(...leading, el('span', 'pr-decision-spacer'), ...trailing, status);
  return { footer, status, buttons: [...leading, ...trailing] };
}

function createFindingKeysHint(): HTMLElement {
  const hint = el('span', 'pr-finding-keys');
  hint.setAttribute('aria-hidden', 'true');
  hint.append(el('kbd', 'review-shortcut', 'N'), el('kbd', 'review-shortcut', 'P'), ' move', el('kbd', 'review-shortcut', 'Enter'), ' open', el('kbd', 'review-shortcut', 'X'), ' post or drop');
  return hint;
}

let _noteFieldCount = 0;

function createNoteKeysHint(postChordText: string): HTMLElement {
  const hint = el('span', 'pr-finding-keys');
  hint.setAttribute('aria-hidden', 'true');
  hint.append(el('kbd', 'review-shortcut', postChordText), ' posts', el('kbd', 'review-shortcut', 'Esc'), ' cancels');
  return hint;
}

function createNoteField(onInput: () => void, postChordText: string): { section: HTMLElement; input: HTMLTextAreaElement; pickAnnouncer: HTMLElement } {
  const section = el('section', 'pr-note');
  _noteFieldCount += 1;
  const input = el('textarea', 'pr-body-input pr-note-input');
  input.id = `pr-note-${_noteFieldCount}`;
  input.rows = 2;
  input.spellcheck = true;
  input.placeholder = 'Optional';
  input.addEventListener('input', onInput);
  const label = el('label', 'pr-section-heading', 'Note');
  label.htmlFor = input.id;
  const heading = el('div', 'pr-posts-heading');
  heading.append(label, createNoteKeysHint(postChordText));
  const pickAnnouncer = el('span', 'sr-only');
  pickAnnouncer.setAttribute('role', 'status');
  pickAnnouncer.setAttribute('aria-live', 'polite');
  section.append(heading, input, pickAnnouncer);
  return { section, input, pickAnnouncer };
}

function createFactRow(label: string, ...value: (HTMLElement | string)[]): HTMLElement {
  const row = el('div', 'pr-fact');
  const valueCell = el('dd', null);
  valueCell.append(...value);
  row.append(el('dt', null, label), valueCell);
  return row;
}

function deskFactsSignature(draft: ReviewDraft): string {
  return JSON.stringify([draft.checksState, draft.viewerThreads, draft.liveHead]);
}

function createDeskFacts(draft: ReviewDraft): HTMLElement {
  const facts = el('section', 'pr-desk-facts');
  facts.setAttribute('aria-label', 'This PR');
  facts.dataset.signature = deskFactsSignature(draft);
  const list = el('dl', 'pr-fact-list');
  const compareUrl = changedSinceReviewUrl(draft);
  const sinceReview = compareUrl
    ? [changedSinceReviewText(draft) ?? '', ' ', externalLink('pr-changed-since-link', 'Compare changes', compareUrl)]
    : ['No new commits'];
  list.append(
    createFactRow('Checks', checksText(draft.checksState)),
    createFactRow('Threads', viewerThreadsText(draft.viewerThreads) ?? 'None of yours'),
    createFactRow('Since review', ...sinceReview),
  );
  facts.append(el('h3', 'pr-assessment-title', 'This PR'), list);
  return facts;
}

function refreshDeskFacts(detail: HTMLElement, draft: ReviewDraft): void {
  const facts = detail.querySelector<HTMLElement>('.pr-desk-facts');
  if (!facts || facts.dataset.signature === deskFactsSignature(draft)) return;
  facts.replaceWith(createDeskFacts(draft));
}

export { FOLLOW_UP_APPROVAL_HINT, commentFindingContent, createAboutPr, createChangedSinceReview, createDecisionBar, createDeskFacts, createDetailHeading, createEarlierReviewDetails, createFindingKeysHint, createHandChecks, createNotMineFooter, createNoteField, createOpenSessionControl, createTickableFinding, createVerdictBlock, generalFindingContent, inReviewEarlierDetails, otherDetailSignature, refreshDeskFacts, refreshDetailHeading, sendAction, settleSessionOpen, showSettledSessionOpen };
