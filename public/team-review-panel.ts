import { TeamReviewStatus } from '#shared/contracts/team-review.ts';
import type {
  InFlightReview, ReviewComment, ReviewDraft, TeamReviewAction, TeamReviewStatus as TeamReviewStatusType,
} from '#shared/contracts/team-review.ts';
import { createAttentionAck } from './attention-ack-core.ts';
import { sendControlMsg } from './control-ws.ts';
import { el, externalLink, isPanelHidden } from './dom-helpers.ts';
import { createPollAgoTicker } from './poll-ago.ts';
import { formatTrailOffset } from './radar-core.ts';
import { createSettingsLink } from './settings-link.ts';
import {
  TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID,
  actionOutcomeText, actionProgressText, attentionDetail, attentionStatusLabel, buildActionRequest, commentLocation,
  emptyStateText, groupDrafts, hasAnyRow, inFlightProgressText, isInFlightProgressOnlyChange, phaseLabel, pullRequestLabel, readyAttentionSignature, readyRowSignature, tierLabel,
  verdictLabel, verdictTone, withoutComment,
} from './team-review-view-core.ts';
import { getPrsAttentionAck, setPrsAttentionAck } from './ui-prefs.ts';

const ACTION_REPLY_TIMEOUT_MS = 120000;

interface ReadyRowHandle {
  signature: string;
  element: HTMLElement;
  settle: (ok: boolean, text: string) => void;
}

interface PendingAction {
  requestId: string;
  action: TeamReviewAction;
  timer: number;
}

let _latest: TeamReviewStatusType | null = null;
let _root: HTMLDivElement | null = null;
let _inReviewSection: HTMLElement | null = null;
let _activityCallback: ((isActive: boolean) => void) | null = null;
const _progressTicker = createPollAgoTicker(() => _root);
const _readyRows = new Map<string, ReadyRowHandle>();
const _pendingActions = new Map<string, PendingAction>();
const _attention = createAttentionAck({
  getAck: getPrsAttentionAck,
  setAck: setPrsAttentionAck,
  signature: () => readyAttentionSignature(_latest),
  isLooking: () => !isPanelHidden(_root),
});

function pullRequestLink(draft: Pick<ReviewDraft, 'repo' | 'number' | 'url'>) {
  return externalLink('pr-link', pullRequestLabel(draft.repo, draft.number), draft.url);
}

function chip(text: string, tone: string | null = null) {
  const chipElement = el('span', 'pr-chip', text);
  if (tone) chipElement.dataset.tone = tone;
  return chipElement;
}

function buildRowHead(draft: ReviewDraft) {
  const head = el('div', 'pr-draft-head');
  head.append(pullRequestLink(draft), el('span', 'pr-draft-title', draft.title), el('span', 'pr-draft-author', draft.author));
  return head;
}

function buildTriageLine(draft: Pick<ReviewDraft, 'tier' | 'reasons'>) {
  const line = el('div', 'pr-draft-triage');
  line.append(chip(tierLabel(draft.tier), draft.tier === 'full' ? 'info' : 'dim'));
  const reasons = draft.reasons.join(', ');
  if (reasons) line.append(el('span', 'pr-draft-reasons', reasons));
  return line;
}

function buildVerdictLine(draft: ReviewDraft) {
  const line = el('div', 'pr-draft-verdict');
  line.append(chip(verdictLabel(draft.verdict), verdictTone(draft.verdict)));
  if (draft.summary) line.append(el('span', 'pr-draft-summary', draft.summary));
  return line;
}

function buildCommentList(draft: ReviewDraft, getComments: () => ReviewComment[], setComments: (next: ReviewComment[]) => void) {
  const list = el('ol', 'pr-draft-comments');
  list.setAttribute('aria-label', `Inline comments for ${pullRequestLabel(draft.repo, draft.number)}`);
  const renderComments = () => {
    list.textContent = '';
    const comments = getComments();
    list.hidden = comments.length === 0;
    comments.forEach((comment, index) => {
      const item = el('li', 'pr-draft-comment');
      const removeButton = el('button', 'pr-draft-comment-remove', 'Remove');
      removeButton.type = 'button';
      removeButton.title = `Remove the comment on ${commentLocation(comment)}`;
      removeButton.addEventListener('click', () => {
        setComments(withoutComment(getComments(), index));
        renderComments();
      });
      item.append(el('span', 'pr-draft-comment-location', commentLocation(comment)), el('span', 'pr-draft-comment-body', comment.body), removeButton);
      list.append(item);
    });
  };
  renderComments();
  return { list, renderComments };
}

const ACTION_BUTTONS: readonly { label: string; action: TeamReviewAction }[] = Object.freeze([
  { label: 'Approve', action: 'approve' },
  { label: 'Comment', action: 'comment' },
  { label: 'Discard', action: 'discard' },
]);

function sendAction(draft: ReviewDraft, action: TeamReviewAction, body: string, comments: ReviewComment[], settle: (ok: boolean, text: string) => void): boolean {
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

function buildReadyRow(draft: ReviewDraft): ReadyRowHandle {
  const row = el('article', 'pr-draft');
  row.dataset.key = draft.key;
  row.append(buildRowHead(draft), buildTriageLine(draft), buildVerdictLine(draft));

  const bodyLabel = el('label', 'pr-draft-body-label', 'Review body');
  const bodyInput = el('textarea', 'pr-draft-body');
  bodyInput.value = draft.body;
  bodyInput.rows = Math.min(10, Math.max(3, draft.body.split('\n').length + 1));
  bodyInput.spellcheck = true;
  bodyLabel.append(bodyInput);
  row.append(bodyLabel);

  let remainingComments: ReviewComment[] = [...draft.comments];
  const { list } = buildCommentList(draft, () => remainingComments, (next) => { remainingComments = next; });
  row.append(list);

  const actions = el('div', 'pr-draft-actions');
  const buttons: HTMLButtonElement[] = [];
  const status = el('span', 'pr-draft-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  row.append(actions);

  const setBusy = (isBusy: boolean) => {
    for (const button of buttons) button.disabled = isBusy;
    row.dataset.busy = isBusy ? 'true' : 'false';
  };
  const settle = (isDone: boolean, text: string) => {
    setBusy(isDone);
    status.dataset.tone = isDone ? 'ok' : 'error';
    status.textContent = text;
  };
  for (const { label, action } of ACTION_BUTTONS) {
    const button = el('button', 'pr-draft-action', label);
    button.type = 'button';
    button.dataset.action = action;
    button.addEventListener('click', () => {
      if (_pendingActions.has(draft.key)) return;
      setBusy(true);
      status.dataset.tone = 'busy';
      status.textContent = actionProgressText(action);
      if (sendAction(draft, action, bodyInput.value, remainingComments, settle)) return;
      settle(false, 'Not connected to the server.');
    });
    buttons.push(button);
  }
  actions.append(...buttons, status);
  return { signature: readyRowSignature(draft), element: row, settle };
}

function readyRowFor(draft: ReviewDraft): HTMLElement {
  const cached = _readyRows.get(draft.key);
  if (cached && cached.signature === readyRowSignature(draft)) return cached.element;
  const handle = buildReadyRow(draft);
  _readyRows.set(draft.key, handle);
  return handle.element;
}

function buildProgressSteps(review: InFlightReview) {
  const list = el('ol', 'pr-progress-steps');
  list.setAttribute('aria-label', `Latest tool calls for ${pullRequestLabel(review.repo, review.number)}`);
  for (const step of review.recentSteps) {
    const item = el('li', 'pr-progress-step');
    const detail = el('span', 'pr-progress-detail', step.detail);
    detail.title = step.detail;
    item.append(el('span', 'pr-progress-at', formatTrailOffset(review.startedAt, step.at)), el('span', 'pr-progress-tool', step.tool), detail);
    list.append(item);
  }
  return list;
}

function buildInReviewRow(review: InFlightReview) {
  const row = el('div', 'pr-in-review');
  const head = el('div', 'pr-draft-head');
  head.append(pullRequestLink(review), el('span', 'pr-draft-title', review.title), el('span', 'pr-draft-author', review.author));
  const progress = el('div', 'pr-line');
  const progressText = el('span', 'pr-progress-text');
  progressText.setAttribute('role', 'status');
  _progressTicker.track(progressText, review.startedAt, () => inFlightProgressText(review, Date.now()));
  progress.append(chip(phaseLabel(review.phase), 'info'), progressText);
  row.append(head, buildTriageLine(review), progress);
  if (review.recentSteps.length > 0) row.append(buildProgressSteps(review));
  return row;
}

function buildAttentionRow(draft: ReviewDraft) {
  const row = el('div', 'pr-line');
  row.dataset.tone = draft.status === 'error' ? 'crit' : 'warn';
  row.append(chip(attentionStatusLabel(draft.status), draft.status === 'error' ? 'crit' : 'warn'), pullRequestLink(draft), el('span', 'pr-draft-title', draft.title));
  row.append(el('div', 'pr-line-detail', attentionDetail(draft)));
  return row;
}

function buildPostedRow(draft: ReviewDraft) {
  const row = el('div', 'pr-line');
  row.append(chip(verdictLabel(draft.verdict), 'dim'), pullRequestLink(draft), el('span', 'pr-draft-title', draft.title));
  return row;
}

function buildSection<Item>(title: string, items: Item[], buildRow: (item: Item) => HTMLElement) {
  const section = el('section', 'pr-section');
  const heading = el('h3', 'pr-section-title', title);
  heading.append(el('span', 'pr-section-count', String(items.length)));
  section.append(heading);
  const rows = el('div', 'pr-section-rows');
  for (const item of items) rows.append(buildRow(item));
  section.append(rows);
  return section;
}

function buildEmptyState() {
  const empty = el('p', 'pr-empty', emptyStateText(_latest));
  if (_latest && !_latest.configured) {
    empty.append(' ', createSettingsLink(TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID, 'Open Team review settings'));
  }
  return empty;
}

function forgetDepartedRows(readyKeys: Set<string>) {
  for (const key of [..._readyRows.keys()]) {
    if (readyKeys.has(key) || _pendingActions.has(key)) continue;
    _readyRows.delete(key);
  }
}

function render() {
  if (!_root) return;
  const focused = document.activeElement instanceof HTMLElement && _root.contains(document.activeElement) ? document.activeElement : null;
  const sections = groupDrafts(_latest);
  forgetDepartedRows(new Set(sections.ready.map((draft) => draft.key)));
  _root.textContent = '';
  _inReviewSection = null;
  _progressTicker.reset();
  if (!_latest || !_latest.configured || !hasAnyRow(sections)) {
    _root.append(buildEmptyState());
    return;
  }
  if (sections.ready.length > 0) _root.append(buildSection('Ready', sections.ready, readyRowFor));
  if (sections.inReview.length > 0) {
    _inReviewSection = buildSection('In review', sections.inReview, buildInReviewRow);
    _root.append(_inReviewSection);
  }
  if (sections.attention.length > 0) _root.append(buildSection('Needs attention', sections.attention, buildAttentionRow));
  if (sections.posted.length > 0) _root.append(buildSection('Recently posted', sections.posted, buildPostedRow));
  if (focused?.isConnected) focused.focus({ preventScroll: true });
}

function refreshActivity() {
  if (!_activityCallback) return;
  _activityCallback(_attention.refresh());
}

export function acknowledgeTeamReviewAttention() {
  _attention.acknowledge();
  refreshActivity();
}

export function setTeamReviewActivityCallback(callback: (isActive: boolean) => void) {
  _activityCallback = callback;
  refreshActivity();
}

export function mountTeamReviewView(parent: HTMLElement) {
  if (_root) return _root;
  const root = el('div', 'pr-content');
  parent.appendChild(root);
  _root = root;
  _progressTicker.ensure();
  render();
  return root;
}

export function applyTeamReviewStatus(msg: unknown) {
  const parsed = TeamReviewStatus.safeParse(msg);
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
  const replacement = buildSection('In review', groupDrafts(_latest).inReview, buildInReviewRow);
  _inReviewSection.replaceWith(replacement);
  _inReviewSection = replacement;
  return true;
}

export function applyTeamReviewActionResult(msg: unknown) {
  if (!msg || typeof msg !== 'object') return;
  const result = msg as { key?: unknown; requestId?: unknown; ok?: unknown; error?: unknown; warning?: unknown };
  if (typeof result.key !== 'string') return;
  const pending = _pendingActions.get(result.key);
  if (!pending || pending.requestId !== result.requestId) return;
  window.clearTimeout(pending.timer);
  _pendingActions.delete(result.key);
  const handle = _readyRows.get(result.key);
  if (!handle) return;
  if (result.ok === true) {
    handle.settle(true, typeof result.warning === 'string' && result.warning ? `${actionOutcomeText(pending.action)}. ${result.warning}` : actionOutcomeText(pending.action));
    return;
  }
  handle.settle(false, typeof result.error === 'string' && result.error ? result.error : 'The action failed.');
}
