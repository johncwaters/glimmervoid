import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { subscribeTeamReview, teamReviewStatusView } from './team-review-store.ts';
import type { TeamReviewChange } from './team-review-store.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import { el } from '../dom-helpers.ts';
import { sendControlMsg } from '../control-ws.ts';
import { createSettingsLink } from '../settings/settings-link.ts';
import { TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID, answeredNonNitThreads, actionOutcomeText, emptyStateText, laneNotice, groupDrafts, hasRequeueFooter, readyRowSignature, planActionReply, settledLineText, isPostedAwaitingViewer } from './team-review-view-core.ts';
import type { TeamReviewSections } from './team-review-view-core.ts';
import type { ReviewDetailKeyAction } from './review-queue-core.ts';
import { _ageTicker, _detailProgressTicker, _otherDetails, _pendingActions, _postedReceipt, _progressTicker, _queueHooks, _readyDetails, _root, _sessionOpenByKey, _view, setPostedReceipt, setQueueHooks, setRoot, setView } from './team-review-panel-state.ts';
import type { TeamReviewQueueHooks } from './team-review-panel-state.ts';
import { trackAges } from './team-review-queue-row.ts';
import { otherDetailSignature, settleSessionOpen, showSettledSessionOpen } from './team-review-detail-parts.ts';
import { createInReviewDetail, createQueuedDetail, otherDetailFor, readyDetailFor } from './team-review-detail-views.ts';

const ACTION_DISCONNECTED_TEXT = `${NOT_CONNECTED_TEXT} Check GitHub before trying again.`;

let _detailHost: HTMLElement | null = null;

let _detail: HTMLElement | null = null;

let _selectedKey: string | null = null;

let _warnedReadyKey: string | null = null;

let _renderedDetailSignature: string | null = null;

let _openTerminal: ((sessionId: string) => void) | null = null;

function renderSelectedDetail(sections: TeamReviewSections): void {
  if (!_detail || !_selectedKey) return;
  const warnedDetail = _warnedReadyKey === _selectedKey ? _readyDetails.get(_selectedKey) : undefined;
  const freshReady = sections.ready.find((draft) => draft.key === _selectedKey && draft.status === 'ready');
  if (warnedDetail && freshReady && readyRowSignature(freshReady) !== warnedDetail.signature) _warnedReadyKey = null;
  if (warnedDetail && _warnedReadyKey) {
    if (_detail.firstElementChild !== warnedDetail.element) _detail.replaceChildren(warnedDetail.element);
    _renderedDetailSignature = null;
    return;
  }
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
    readyDetail.showSettled?.(sections.noReviewNeeded.includes(ready) ? settledLineText(ready) : null);
    if (_postedReceipt) readyDetail.showReceipt?.(_postedReceipt);
    setPostedReceipt(null);
    if (_renderedDetailSignature === signature) return;
    _detail.replaceChildren(readyDetail.element);
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
  const other = [...sections.noReviewNeeded, ...sections.attention, ...sections.posted, ...sections.discarded].find((draft) => draft.key === _selectedKey);
  if (!other) return;
  _detail.replaceChildren(otherDetailFor(other));
  _renderedDetailSignature = `${other.status}:${other.key}`;
}

function teamReviewEmptyState(): HTMLElement {
  const empty = el('p', 'pr-empty', emptyStateText(_view));
  if (_view && !_view.configured) empty.append(' ', createSettingsLink(TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID, 'Open Team review settings'));
  return empty;
}

function teamReviewLaneNotices(): HTMLElement[] {
  const text = laneNotice(_view);
  return text ? [el('p', 'my-pr-note', text)] : [];
}

function forgetDepartedDetails(readyKeys: Set<string>): void {
  for (const key of [..._readyDetails.keys()]) {
    if (readyKeys.has(key) || _pendingActions.has(key) || key === _warnedReadyKey) continue;
    _readyDetails.delete(key);
  }
  const requeueKeys = new Set(_view?.drafts.filter((draft) => hasRequeueFooter(draft.status)).map((draft) => draft.key) ?? []);
  for (const key of _otherDetails.keys()) {
    if (requeueKeys.has(key) || _pendingActions.has(key)) continue;
    _otherDetails.delete(key);
  }
}

function resetTeamQueueTickers(): void {
  _progressTicker.reset();
}

function refreshTeamReviewAges(): void {
  _ageTicker.reset();
  trackAges(_root);
}

function clearReceipts(nextReviewKey: string | null = null): void {
  setPostedReceipt(null);
  if (_warnedReadyKey !== nextReviewKey) _warnedReadyKey = null;
  for (const handle of _readyDetails.values()) handle.clearReceipt?.();
}

function runTeamReviewKey(action: ReviewDetailKeyAction): boolean {
  if (!_detail || !_selectedKey) return false;
  if (action === 'open-session') {
    const openButton = _detail.querySelector<HTMLButtonElement>('[data-action="open-session"]');
    if (!openButton || openButton.disabled) return false;
    openButton.click();
    return true;
  }
  const shown = _readyDetails.get(_selectedKey);
  if (!shown || _detail.firstElementChild !== shown.element) return false;
  return shown.runKey?.(action) ?? false;
}

function takePostedReceipt(): string | null {
  const receipt = _postedReceipt;
  setPostedReceipt(null);
  return receipt;
}

function releaseTeamReviewSelection(): void {
  clearReceipts();
  _selectedKey = null;
}

function showTeamReview(reviewKey: string, receiptMode: 'keep' | 'clear'): void {
  if (receiptMode === 'clear') clearReceipts(reviewKey);
  if (_selectedKey !== reviewKey) sendControlMsg({ type: 'team-review-refresh-threads', key: reviewKey });
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

function applyTeamReviewChange(change: TeamReviewChange): void {
  switch (change.kind) {
    case 'status':
      setView(teamReviewStatusView());
      handleTeamReviewChange();
      return;
    case 'action-result':
      settleTeamReviewAction(change.message);
      return;
    case 'open-session-result':
      settleOpenTeamReviewSession(change.message);
      return;
    case 'connection':
      settlePendingOnDisconnect(change.isConnected);
  }
}

function mountTeamReviewDetail(root: HTMLElement, hooks: TeamReviewQueueHooks, navigation?: { openTerminal: (sessionId: string) => void }): HTMLElement {
  _openTerminal = navigation?.openTerminal ?? _openTerminal;
  setQueueHooks(hooks);
  setRoot(root);
  if (_detailHost) return _detailHost;
  _detailHost = el('div', 'pr-detail-team');
  _detail = el('div', 'pr-detail-body');
  _detailHost.append(_detail);
  _progressTicker.ensure();
  _detailProgressTicker.ensure();
  _ageTicker.ensure();
  setView(teamReviewStatusView());
  subscribeTeamReview(applyTeamReviewChange);
  return _detailHost;
}

function settleOpenTeamReviewSession(message: ServerMessageOf<'open-team-review-session-result'>): void {
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

function settlePendingOnDisconnect(isConnected: boolean): void {
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

function settleTeamReviewAction(message: unknown): void {
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
    (handle?.settle ?? pending.settle)?.(true, reply.statusText, reply.tone);
    if (reply.tone === 'error' && pending.origin === 'ready' && handle) {
      _warnedReadyKey = actionResult.key;
      if (_selectedKey && _selectedKey !== actionResult.key) _readyDetails.get(_selectedKey)?.showReceipt?.(`${pending.pullRequest}: ${reply.statusText}`, 'error');
      renderSelectedDetail(groupDrafts(_view));
    }
    if (!reply.shouldAdvance) return;
    setPostedReceipt(reply.receipt);
    forgetDetailsOutsideSections(groupDrafts(_view));
    _queueHooks?.onAdvance(actionResult.key, pending.capturedOrder);
    return;
  }
  (handle?.settle ?? pending.settle)?.(false, typeof actionResult.error === 'string' && actionResult.error ? actionResult.error : 'The action failed.');
}

export { mountTeamReviewDetail, refreshTeamReviewAges, releaseTeamReviewSelection, resetTeamQueueTickers, runTeamReviewKey, showTeamReview, takePostedReceipt, teamReviewEmptyState, teamReviewLaneNotices };
