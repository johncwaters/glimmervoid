import { paintActionStatus } from '../action-status.ts';
import { button } from '../ui/button.ts';
import type { InFlightReview, QueuedReview, ReviewDraft, TeamReviewAction } from '#shared/contracts/team-review.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import { el, externalLink } from '../dom-helpers.ts';
import { formatTrailOffset } from '../radar/radar-core.ts';
import { THREAD_COMMENT_PREVIEW_LINES, THREAD_REPLY_PREVIEW_LINES, threadBodyOverflowsPreview, detailThreadItems, actionProgressText, attentionDetail, attentionNextStep, buildActionRequest, buildReadyDecisionRequest, detailActionLayout, isIncludedByDefault, isSelectionRequired, isSeverityIncludedByDefault, generalFindingsOf, hasSelection, hasRequeueFooter, inFlightProgressText, leadingDecision, pickedDecisionText, postedOutcomeText, postingPreview, queuedDetailText, readyRowSignature, reviewProgressSteps, otherReviewRows, flaggedCommentsSignature } from './team-review-view-core.ts';
import type { ReadyDecisionControl, ReviewSelection } from './team-review-view-core.ts';
import { reviewPostChordText } from '../shortcuts-core.ts';
import { SHORTCUT_PLATFORM } from '../shortcuts.ts';
import type { ReviewDetailKeyAction } from './review-queue-core.ts';
import { _detailProgressTicker, _otherDetails, _pendingActions, _readyDetails } from './team-review-panel-state.ts';
import type { ActionDetailHandle, SettleAction } from './team-review-panel-state.ts';
import { createAgeReadout, createAuthor, pullRequestLink } from './team-review-queue-row.ts';
import { FOLLOW_UP_APPROVAL_HINT, commentFindingContent, createAboutPr, createChangedSinceReview, createDecisionBar, createDetailHeading, createDraftEarlierReviewDetails, createFindingKeysHint, createHandChecks, createNotMineFooter, createNoteField, createOpenSessionButton, createOpenSessionControl, createOpenSessionStatus, createTickableFinding, createVerdictBlock, generalFindingContent, inReviewEarlierDetails, otherDetailSignature, refreshDeskFacts, refreshDetailHeading, sendAction } from './team-review-detail-parts.ts';
import { clock } from '#shared/clock.ts';

const READY_DESK_SHORTCUTS: Partial<Readonly<Record<TeamReviewAction, string>>> = Object.freeze({
  approve: 'A', 'request-changes': 'R', comment: 'C',
});

const PICKED_CONTROL_BY_KEY: Partial<Readonly<Record<ReviewDetailKeyAction, ReadyDecisionControl>>> = Object.freeze({
  'pick-approve': 'approve', 'pick-request-changes': 'request-changes', 'pick-comment': 'comment',
});

function createReadyDetail(draft: ReviewDraft): ActionDetailHandle {
  const detail = el('article', 'pr-detail pr-desk');
  const column = el('div', 'pr-desk-column');
  const rail = el('aside', 'pr-desk-rail');
  rail.setAttribute('aria-label', 'Decision');
  const threads = el('div');
  threads.dataset.reviewThreads = '';
  column.append(createDetailHeading(draft, { hasDeskFacts: true }), ...createAboutPr(draft));
  column.append(threads, createVerdictBlock(draft), ...createHandChecks(draft));

  let isTouched = false;
  const generalFindings = generalFindingsOf(draft.body);
  const includedComments = new Set(draft.comments.flatMap((comment, index) => (isIncludedByDefault(comment) ? [index] : [])));
  const includedGeneral = new Set(generalFindings.flatMap((finding, index) => (isSeverityIncludedByDefault(finding.severity) ? [index] : [])));
  const findingCount = draft.comments.length + generalFindings.length;
  const findings = el('section', 'pr-posts');
  findings.setAttribute('aria-label', 'Findings');
  const findingsHeading = el('div', 'pr-posts-heading');
  const findingsTally = el('span', null);
  findingsHeading.append(el('h3', null, 'Findings'), findingsTally);
  if (findingCount > 0) findingsHeading.append(createFindingKeysHint());
  findings.append(findingsHeading);
  const note = createNoteField(onEdit, reviewPostChordText(SHORTCUT_PLATFORM));
  const willPost = el('section', 'pr-will-post');
  willPost.setAttribute('aria-label', 'Will post to GitHub');
  const willPostEvent = el('strong', 'pr-will-post-event');
  const willPostDetail = el('p', 'pr-will-post-detail');
  willPostDetail.setAttribute('aria-live', 'polite');
  willPost.append(el('h3', 'pr-assessment-title', 'Will post to GitHub'), willPostEvent, willPostDetail, note.section);
  const settledLine = el('p', 'pr-settled-line');
  settledLine.hidden = true;
  const showSettled = (text: string | null): void => {
    settledLine.hidden = text === null;
    settledLine.textContent = text ?? '';
  };
  rail.append(settledLine, willPost);
  const selection = (): ReviewSelection => ({
    note: note.input.value,
    comments: draft.comments.filter((_comment, index) => includedComments.has(index)),
    generalFindings: generalFindings.filter((_finding, index) => includedGeneral.has(index)),
  });
  let isBusy = false;
  let isShowingReceipt = false;
  const findingCards: HTMLElement[] = [];
  let currentFindingIndex = -1;
  let pickedControl: ReadyDecisionControl | null = null;
  const runAction = (action: TeamReviewAction) => {
    if (_pendingActions.has(draft.key)) return;
    isShowingReceipt = false;
    pickedControl = null;
    paintPick();
    const chosen = selection();
    const request = action === 'approve' || action === 'comment' || action === 'request-changes' ? buildReadyDecisionRequest(draft, action, chosen) : buildActionRequest(draft, action, '', []);
    setBusy(true);
    paintActionStatus(bar.status, 'busy', actionProgressText(request.action));
    if (sendAction('ready', draft, request, settle, postedOutcomeText(request.action, chosen))) return;
    settle(false, NOT_CONNECTED_TEXT);
  };
  const bar = createDecisionBar(draft, runAction, '', READY_DESK_SHORTCUTS);
  const sessionOpenStatus = createOpenSessionStatus();
  bar.spacer.before(createOpenSessionButton(draft, sessionOpenStatus));
  bar.footer.append(sessionOpenStatus);
  const decisionButtons = bar.buttons.filter((barButton) => ['approve', 'comment', 'request-changes'].includes(barButton.dataset.action ?? ''));
  function paintControls(): void {
    const isCommentReady = hasSelection(selection());
    for (const button of bar.buttons) button.disabled = isBusy || (isSelectionRequired(button.dataset.action) && !isCommentReady);
    detail.dataset.busy = String(isBusy);
  }
  function setBusy(nextIsBusy: boolean): void {
    isBusy = nextIsBusy;
    paintControls();
  }
  function paintDecision(): void {
    const chosen = selection();
    findingsTally.textContent = `${chosen.comments.length + chosen.generalFindings.length} of ${findingCount} will post. Low severity starts unticked.`;
    const preview = postingPreview(draft, chosen, leadingDecision(draft.verdict));
    willPostEvent.textContent = preview.event;
    willPostDetail.textContent = preview.detail;
    paintControls();
  }
  function paintPick(): void {
    for (const decisionButton of decisionButtons) decisionButton.setAttribute('aria-pressed', String(decisionButton.dataset.action === pickedControl));
  }
  function focusCurrentFinding(): void {
    const card = findingCards[currentFindingIndex];
    for (const [index, findingCard] of findingCards.entries()) findingCard.dataset.current = String(index === currentFindingIndex);
    card.querySelector<HTMLElement>('.pr-comment-header')?.focus({ preventScroll: true });
    card.scrollIntoView({ block: 'nearest' });
  }
  function moveFinding(step: 1 | -1): boolean {
    if (findingCards.length === 0) return false;
    currentFindingIndex = Math.min(findingCards.length - 1, Math.max(0, currentFindingIndex + step));
    focusCurrentFinding();
    return true;
  }
  function toggleCurrentFinding(): boolean {
    if (currentFindingIndex === -1 && !moveFinding(1)) return false;
    findingCards[currentFindingIndex].querySelector<HTMLInputElement>('.pr-post-checkbox')?.click();
    focusCurrentFinding();
    return true;
  }
  function pickDecision(control: ReadyDecisionControl): boolean {
    if (isBusy) return false;
    isShowingReceipt = false;
    pickedControl = control;
    paintPick();
    note.input.focus();
    paintActionStatus(bar.status, null, '');
    note.pickAnnouncer.textContent = pickedDecisionText(control, reviewPostChordText(SHORTCUT_PLATFORM));
    return true;
  }
  function postDecision(): boolean {
    const control = pickedControl ?? (document.activeElement === note.input ? leadingDecision(draft.verdict) : null);
    const button = bar.buttons.find((candidate) => candidate.dataset.action === control);
    if (!control || !button) return false;
    if (isBusy || _pendingActions.has(draft.key)) return true;
    if (button.disabled) {
      paintActionStatus(bar.status, 'error', postingPreview(draft, selection(), control).detail);
      return true;
    }
    button.click();
    return true;
  }
  function cancelPick(): boolean {
    if (!pickedControl) return false;
    pickedControl = null;
    paintPick();
    paintActionStatus(bar.status, null, '');
    note.pickAnnouncer.textContent = '';
    return true;
  }
  function runKey(action: ReviewDetailKeyAction): boolean {
    isTouched = true;
    const pickedByKey = PICKED_CONTROL_BY_KEY[action];
    if (pickedByKey) return pickDecision(pickedByKey);
    if (action === 'next-finding') return moveFinding(1);
    if (action === 'previous-finding') return moveFinding(-1);
    if (action === 'toggle-finding') return toggleCurrentFinding();
    if (action === 'post') return postDecision();
    if (action === 'cancel') return cancelPick();
    return false;
  }
  function clearReceipt(): void {
    if (!isShowingReceipt) return;
    isShowingReceipt = false;
    paintActionStatus(bar.status, null, '');
  }
  function onEdit(): void {
    isTouched = true;
    clearReceipt();
    paintDecision();
  }
  const settle: SettleAction = (isDone, text, tone = isDone ? 'ok' : 'error') => {
    setBusy(isDone);
    paintActionStatus(bar.status, tone, text);
  };
  const showReceipt = (text: string, tone: 'ok' | 'error' = 'ok') => {
    if (_pendingActions.has(draft.key)) return;
    isShowingReceipt = true;
    paintActionStatus(bar.status, tone, text);
  };
  for (const [index, comment] of draft.comments.entries()) findingCards.push(createTickableFinding(commentFindingContent(comment), includedComments, index, onEdit));
  for (const [index, finding] of generalFindings.entries()) findingCards.push(createTickableFinding(generalFindingContent(finding), includedGeneral, index, onEdit));
  findings.append(...findingCards);
  if (findingCount > 0) column.append(findings);
  if (draft.earlierReview) column.append(createDraftEarlierReviewDetails(draft, draft.earlierReview, false));
  detail.append(column, rail, bar.footer);
  refreshThreadDetails(detail, draft);
  paintDecision();
  paintPick();
  return { signature: readyRowSignature(draft), flaggedSignature: flaggedCommentsSignature(draft), isTouched: () => isTouched, element: detail, settle, showReceipt, clearReceipt, showSettled, runKey };
}

function readyDetailFor(draft: ReviewDraft): ActionDetailHandle {
  const cached = _readyDetails.get(draft.key);
  const isFlaggingCurrent = cached?.flaggedSignature === flaggedCommentsSignature(draft) || cached?.isTouched?.() === true;
  if (cached && (_pendingActions.has(draft.key) || (cached.signature === readyRowSignature(draft) && isFlaggingCurrent))) {
    refreshThreadDetails(cached.element, draft);
    refreshDeskFacts(cached.element, draft);
    refreshDetailHeading(cached.element, draft, { hasDeskFacts: true });
    return cached;
  }
  const handle = createReadyDetail(draft);
  _readyDetails.set(draft.key, handle);
  return handle;
}

function createQueuedDetail(review: QueuedReview, runningCount: number): HTMLElement {
  const detail = el('article', 'pr-detail');
  const heading = el('div', 'pr-detail-heading');
  const title = el('div', 'pr-detail-title');
  title.append(pullRequestLink(review), el('h2', null, review.title));
  const metadata = el('div', 'pr-detail-meta');
  metadata.append(createAuthor(review, 20, 'pr-detail-author'));
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
  _detailProgressTicker.track(progressText, review.startedAt, () => inFlightProgressText(review, clock.nowMs()));
  progress.append(tracker, progressText);
  detail.append(progress);
  const steps = el('section', 'pr-steps');
  steps.append(el('h3', null, 'Latest agent steps'));
  const list = el('ol', 'pr-step-list');
  for (const step of review.recentSteps) {
    const item = el('li', 'pr-step');
    const description = el('span', 'pr-step-detail', step.detail);
    item.append(el('span', 'pr-step-at', formatTrailOffset(review.startedAt, step.at)), el('span', 'pr-step-tool', step.tool), description);
    list.append(item);
  }
  steps.append(list);
  detail.append(steps, ...inReviewEarlierDetails(review), createNotMineFooter(review));
  return detail;
}

function refreshThreadDetails(detail: HTMLElement, draft: ReviewDraft): void {
  if (_pendingActions.has(draft.key)) return;
  const threads = detail.querySelector<HTMLElement>('[data-review-threads]');
  const signature = JSON.stringify([draft.liveHead, draft.threads, draft.otherReviewItems, draft.resolvedOtherReviewItems]);
  if (!threads || threads.dataset.reviewThreads === signature) return;
  const isOtherReviewersOpen = threads.querySelector<HTMLDetailsElement>('.pr-other-reviewers')?.open === true;
  threads.replaceChildren(...createThreadDetails(draft), ...createOtherReviewItems(draft, isOtherReviewersOpen));
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
    const resolveButton = button({ variant: 'primary', label: 'Resolve', action: 'resolve-thread', disabled: !item.canResolve || _pendingActions.has(draft.key) });
    const settle = (isDone: boolean, text: string) => {
      resolveButton.disabled = isDone || !item.canResolve;
      paintActionStatus(status, isDone ? 'ok' : 'error', text);
    };
    resolveButton.addEventListener('click', () => {
      if (_pendingActions.has(draft.key)) return;
      resolveButton.disabled = true;
      paintActionStatus(status, 'busy', actionProgressText('resolve-thread'));
      if (sendAction('other', draft, buildActionRequest(draft, 'resolve-thread', '', [], item.thread.id), settle)) return;
      settle(false, NOT_CONNECTED_TEXT);
    });
    row.append(reply);
    if (item.thread.lastReplyBody) row.append(createThreadBody(item.thread.lastReplyBody, false, item.thread.lastReplyTruncated === true, item.thread.url));
    const footer = el('footer', 'pr-thread-footer');
    footer.append(status, resolveButton);
    row.append(footer);
    if (item.thread.resolveError) row.append(el('p', 'pr-attention-detail', item.thread.resolveError));
    list.append(row);
  }
  section.append(list);
  return [section];
}

function createOtherReviewItems(draft: ReviewDraft, isOpen: boolean): HTMLElement[] {
  const rows = otherReviewRows(draft);
  if (rows.length === 0) return [];
  const section = el('details', 'pr-disclosure pr-other-reviewers');
  const summary = el('summary', 'pr-disclosure-summary');
  const reviewerNames = [...new Set([...(draft.otherReviewItems ?? []), ...(draft.resolvedOtherReviewItems ?? [])].flatMap((item) => item.sources.map((source) => source.name)))];
  const resolvedCount = rows.filter((row) => row.isResolved).length;
  const countText = resolvedCount === 0 ? `${rows.length}` : `${rows.length - resolvedCount} open, ${resolvedCount} resolved`;
  summary.append(el('span', 'pr-disclosure-label', `Other reviewers (${countText})`), el('span', 'pr-disclosure-preview', reviewerNames.join(', ')));
  section.append(summary);
  section.open = isOpen;
  const list = el('div', 'my-pr-threads');
  for (const row of rows) {
    const card = el('div', row.isResolved ? 'my-pr-thread pr-thread-card is-resolved' : 'my-pr-thread pr-thread-card');
    const heading = el('div', 'my-pr-thread-heading pr-thread-heading');
    heading.append(externalLink('pr-link my-pr-thread-location', row.location, row.url), el('span', 'pr-author-login', row.reviewers));
    if (row.isResolved) heading.append(el('span', 'pr-thread-resolved', 'Resolved'));
    card.append(heading, createThreadBody(row.excerpt, false, false, row.url));
    list.append(card);
  }
  section.append(list);
  return [section];
}

function createOtherDetail(draft: ReviewDraft): HTMLElement {
  const detail = el('article', 'pr-detail');
  detail.append(createDetailHeading(draft), ...createAboutPr(draft));
  if (draft.earlierReview) detail.append(createDraftEarlierReviewDetails(draft, draft.earlierReview, draft.status === 'stale'));
  detail.append(...createThreadDetails(draft));
  if (draft.status === 'posted') detail.append(createVerdictBlock(draft));
  if (draft.status !== 'posted') detail.append(el('p', 'pr-attention-detail', attentionDetail(draft)));
  const nextStep = attentionNextStep(draft);
  if (nextStep) detail.append(el('p', 'pr-attention-detail pr-attention-next', nextStep));
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
  const bar = createDecisionBar(draft, runAction, detailActionLayout(draft).leading.includes('approve-only') ? FOLLOW_UP_APPROVAL_HINT : '');
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

export { createInReviewDetail, createQueuedDetail, otherDetailFor, readyDetailFor };
