import '../github/review-queue-panel.css';
import './community-panel.css';
import type { CommunityAction, CommunityStateEntry } from '#shared/contracts/community.ts';
import { createActionStatus, requestWithStatus } from '../action-status.ts';
import type { ActionStatus } from '../action-status.ts';
import { buildAttentionBanner, paintAttentionBanner } from '../attention-banner.ts';
import { el, isPanelHidden, isRealInputOwningKey, writeClipboardText } from '../dom-helpers.ts';
import { isExternalHttpUrl } from '../external-link-core.ts';
import { openExternalUrl } from '../external-link.ts';
import { createPrQueueColumns } from '../github/pr-queue-columns.ts';
import { attentionCountsOf, chooseQueueSelection, communityActivityEntry, labeledAttentionTiles, queueItemByKey, reviewKeyActionOf, steppedRowKey, turnItems } from '../github/review-queue-core.ts';
import type { CommunityQueueItem, QueueGroup } from '../github/review-queue-core.ts';
import { createCaughtUpBanner } from '../github/team-review-panel.ts';
import { reviewQueueNavigation } from '../github/review-queue-store.ts';
import { formatAgo } from '../poll-ago.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { isModalOpen } from '../session-card/modal.ts';
import type { ViewModule } from '../view-registry-core.ts';
import {
  attachCommunityView, communityQueue, communityStatusView, communityUnseenSignature, isCommunityEntryUnseen, markCommunityEntrySeen, subscribeCommunity,
} from './community-store.ts';
import {
  canRerunCommunityEntry, canSetAsideCommunityEntry, communityBadge, communityCaughtUpText, communityEmptyText, communityItemLabel, communitySourceText, startSessionChoices,
} from './community-view-core.ts';

let root: HTMLElement | null = null;
let queueElement: HTMLElement | null = null;
let detailHost: HTMLElement | null = null;
let banner: HTMLElement | null = null;
let currentGroups: QueueGroup<CommunityQueueItem>[] = [];
let selectedKey: string | null = null;
let isSetAsideOpen = false;
let renderedSignature: string | null = null;
let shownDetailSignature: string | null = null;
let chosenSessionId = '';
const rowsByKey = new Map<string, HTMLButtonElement>();

function startSessionCandidates() {
  return startSessionChoices([...sessionUIs].map(([id, ui]) => ({
    id,
    name: ui.nameEl.textContent ?? id,
    isWorkspace: ui.card.dataset.workspace !== undefined,
    isEphemeral: ui.card.dataset.ephemeral !== undefined,
  })));
}

function createLinkButton(label: string, url: string): HTMLButtonElement {
  const button = el('button', 'pr-action pr-action-ghost', label);
  button.type = 'button';
  button.disabled = !isExternalHttpUrl(url);
  button.addEventListener('click', () => openExternalUrl(url));
  return button;
}

function createActionButton(label: string, isEnabled: boolean, onClick: () => void): HTMLButtonElement {
  const button = el('button', 'pr-action', label);
  button.type = 'button';
  button.disabled = !isEnabled;
  button.addEventListener('click', onClick);
  return button;
}

function createTextList(className: string, label: string, lines: readonly string[]): HTMLElement {
  const list = el('ul', className);
  list.setAttribute('aria-label', label);
  for (const line of lines) list.append(el('li', null, line));
  return list;
}

function createHeading(entry: CommunityStateEntry): HTMLElement {
  const heading = el('div', 'pr-detail-heading');
  const title = el('div', 'pr-detail-title');
  title.append(el('h2', null, entry.item.title || 'Untitled question'));
  const metadata = el('div', 'pr-detail-meta');
  const askedAtMs = Date.parse(entry.item.createdAt);
  metadata.append(el('span', null, entry.item.author), el('span', null, communitySourceText(entry)));
  if (!Number.isNaN(askedAtMs)) metadata.append(el('span', null, `Asked ${formatAgo(askedAtMs)}`));
  heading.append(title, metadata);
  return heading;
}

function createQuestionBlock(entry: CommunityStateEntry): HTMLElement {
  const question = el('section', 'community-question');
  question.setAttribute('aria-label', 'Question as asked');
  question.append(el('h3', 'pr-section-heading', 'Question as asked'), el('p', 'community-question-body', entry.item.body));
  return question;
}

function createResearchBlock(entry: CommunityStateEntry): HTMLElement {
  const research = el('section', 'pr-verdict-box');
  research.setAttribute('aria-label', 'Research');
  const badge = communityBadge(entry);
  const line = el('div', 'pr-verdict-line');
  const badgeText = el('strong', 'community-badge', badge.text);
  badgeText.dataset.tone = badge.tone;
  line.append(badgeText);
  research.append(line);
  if (entry.error) research.append(el('p', 'pr-attention-detail', entry.error));
  if (entry.summary) research.append(el('p', 'pr-verdict-summary', entry.summary));
  if (entry.goal) research.append(el('p', 'community-goal', `Goal: ${entry.goal}`));
  if (entry.gaps.length > 0) research.append(createTextList('pr-verdict-gaps', 'Not covered', entry.gaps));
  if (entry.checked.length === 0) return research;
  const checked = el('details', 'pr-verdict-checked');
  checked.append(el('summary', null, `What it checked (${entry.checked.length})`), createTextList('community-checked', 'What it checked', entry.checked));
  research.append(checked);
  return research;
}

function createDraftBlock(entry: CommunityStateEntry): HTMLElement | null {
  if (!entry.draft) return null;
  const draft = el('section', 'community-draft');
  draft.setAttribute('aria-label', 'Draft reply');
  draft.append(el('h3', 'pr-section-heading', 'Draft reply'), el('p', 'community-draft-body', entry.draft.body));
  const links = entry.draft.publicLinks.filter(isExternalHttpUrl);
  if (links.length === 0) return draft;
  const list = el('ul', 'community-links');
  for (const url of links) {
    const item = el('li');
    item.append(createLinkButton(url, url));
    list.append(item);
  }
  draft.append(list);
  return draft;
}

function copyDraft(entry: CommunityStateEntry, status: ActionStatus): void {
  const copied = entry.draft ? writeClipboardText(entry.draft.body) : null;
  if (!copied) {
    status.show('error', 'This browser does not allow copying here. Select the draft text instead.');
    return;
  }
  copied.then(() => status.show('ok', 'Draft copied. Post it yourself where the question was asked.'), () => status.show('error', 'Copying failed. Select the draft text instead.'));
}

async function startSession(entry: CommunityStateEntry, status: ActionStatus): Promise<void> {
  if (!chosenSessionId) {
    status.show('error', 'Pick a session to start from first.');
    return;
  }
  const reply = await requestWithStatus('open-community-session', { key: entry.item.key, projectId: chosenSessionId }, status, { busyText: 'Starting a session with the research.' });
  if (reply?.type !== 'open-community-session-result') return;
  if (!reply.ok) {
    status.show('error', reply.error ?? 'The session did not start.');
    return;
  }
  status.show('ok', `Started ${reply.sessionName ?? 'a session'}.`);
  if (reply.sessionId) reviewQueueNavigation()?.openTerminal(reply.sessionId);
}

async function runAction(entry: CommunityStateEntry, action: CommunityAction, status: ActionStatus): Promise<void> {
  const busyText = action === 'rerun' ? 'Queuing the research again.' : 'Setting the question aside.';
  const reply = await requestWithStatus('community-action', { key: entry.item.key, action }, status, { busyText });
  if (reply?.type !== 'community-action-result') return;
  if (!reply.ok) status.show('error', reply.error ?? 'The change did not apply.');
}

function createSessionPicker(): HTMLSelectElement {
  const picker = el('select', 'community-session-picker');
  picker.setAttribute('aria-label', 'Session to start from');
  const choices = startSessionCandidates();
  if (!choices.some((choice) => choice.id === chosenSessionId)) chosenSessionId = choices[0]?.id ?? '';
  for (const choice of choices) {
    const option = el('option', null, choice.name);
    option.value = choice.id;
    option.selected = choice.id === chosenSessionId;
    picker.append(option);
  }
  picker.disabled = choices.length === 0;
  picker.addEventListener('change', () => { chosenSessionId = picker.value; });
  return picker;
}

function createActions(entry: CommunityStateEntry): HTMLElement {
  const actions = el('div', 'community-actions');
  const status = createActionStatus('pr-action-status');
  const buttons = el('div', 'community-action-buttons');
  buttons.append(
    createActionButton('Copy draft', entry.draft !== null, () => copyDraft(entry, status)),
    createLinkButton('Open thread', entry.item.url),
    createSessionPicker(),
    createActionButton('Start session', true, () => void startSession(entry, status)),
    createActionButton('Re-run', canRerunCommunityEntry(entry), () => void runAction(entry, 'rerun', status)),
    createActionButton('Set aside', canSetAsideCommunityEntry(entry), () => void runAction(entry, 'set-aside', status)),
  );
  actions.append(buttons, status.element);
  return actions;
}

function createDetail(entry: CommunityStateEntry): HTMLElement {
  const detail = el('article', 'pr-detail community-detail');
  const draft = createDraftBlock(entry);
  detail.append(createHeading(entry), createActions(entry), ...(draft ? [draft] : []), createResearchBlock(entry), createQuestionBlock(entry));
  return detail;
}

function showSelectedDetail(): void {
  if (!detailHost) return;
  const item = queueItemByKey(currentGroups, selectedKey);
  const signature = item ? JSON.stringify(item.entry) : `empty:${turnItems(currentGroups).length}`;
  if (signature === shownDetailSignature) return;
  shownDetailSignature = signature;
  if (item) {
    detailHost.replaceChildren(createDetail(item.entry));
    return;
  }
  const hasAnyItem = currentGroups.some((group) => group.items.length > 0);
  detailHost.replaceChildren(hasAnyItem
    ? createCaughtUpBanner({ title: 'All caught up', detail: communityCaughtUpText(currentGroups) })
    : el('p', 'pr-empty', communityEmptyText(communityStatusView())));
}

function markSeen(item: CommunityQueueItem, row: HTMLButtonElement): void {
  if (!markCommunityEntrySeen(communityActivityEntry(item))) return;
  row.querySelector('.pr-queue-unseen')?.remove();
}

function paintBanner(): void {
  if (!banner) return;
  const tiles = labeledAttentionTiles(currentGroups, communityItemLabel);
  paintAttentionBanner(banner, attentionCountsOf(tiles), tiles.filter((tile) => tile.id !== selectedKey));
}

function selectItem(key: string): void {
  selectedKey = key;
  for (const [rowKey, row] of rowsByKey) row.setAttribute('aria-current', String(rowKey === key));
  const item = queueItemByKey(currentGroups, key);
  const row = rowsByKey.get(key);
  if (item && row) markSeen(item, row);
  showSelectedDetail();
  paintBanner();
  if (root) root.dataset.detailOpen = 'true';
}

function returnToQueue(): void {
  if (root) root.dataset.detailOpen = 'false';
  if (selectedKey) rowsByKey.get(selectedKey)?.focus({ preventScroll: true });
}

function revealItem(key: string): void {
  const item = queueItemByKey(currentGroups, key);
  if (!item) return;
  if (currentGroups.find((group) => group.items.includes(item))?.id === 'aside') isSetAsideOpen = true;
  selectedKey = key;
  render();
  selectItem(key);
  const row = rowsByKey.get(key);
  row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: 'nearest' });
}

function onCommunityKey(event: KeyboardEvent): void {
  if (event.repeat || event.defaultPrevented || !root || isPanelHidden(root) || isModalOpen() || isRealInputOwningKey(event)) return;
  if (document.activeElement?.classList.contains('xterm-helper-textarea')) return;
  const action = reviewKeyActionOf(event);
  if (action !== 'next-row' && action !== 'previous-row') return;
  const nextKey = steppedRowKey([...rowsByKey.keys()], selectedKey, action === 'next-row' ? 1 : -1);
  if (!nextKey) return;
  event.preventDefault();
  if (nextKey !== selectedKey) revealItem(nextKey);
}

function createRow(item: CommunityQueueItem, isTurn: boolean): HTMLButtonElement {
  const row = el('button', 'pr-queue-row pr-queue-row-quiet');
  row.type = 'button';
  row.dataset.queueKey = item.key;
  row.setAttribute('aria-current', String(item.key === selectedKey));
  const badge = communityBadge(item.entry);
  const badgeText = el('span', 'review-queue-action community-badge', badge.text);
  badgeText.dataset.tone = badge.tone;
  const top = el('span', 'pr-queue-top');
  top.append(badgeText, el('span', 'pr-queue-title', communityItemLabel(item)));
  row.append(top, el('span', 'pr-queue-elapsed', communitySourceText(item.entry)));
  row.title = communityItemLabel(item);
  if (isTurn && isCommunityEntryUnseen(communityActivityEntry(item))) {
    const activity = el('span', 'tab-activity active pr-queue-unseen');
    activity.setAttribute('aria-hidden', 'true');
    row.append(activity);
  }
  row.addEventListener('click', () => selectItem(item.key));
  rowsByKey.set(item.key, row);
  return row;
}

function createGroupHeading(group: QueueGroup<CommunityQueueItem>): HTMLElement {
  const heading = el('h3', 'pr-section-heading review-group-heading');
  const count = el('span', 'review-group-count', String(group.items.length));
  if (group.id !== 'aside') {
    heading.append(el('span', null, group.title), count);
    return heading;
  }
  const toggle = el('button', 'review-group-toggle');
  const chevron = el('span', 'review-group-chevron', String.fromCharCode(0x25b8));
  chevron.setAttribute('aria-hidden', 'true');
  toggle.append(chevron, group.title);
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(isSetAsideOpen));
  toggle.addEventListener('click', () => {
    isSetAsideOpen = !isSetAsideOpen;
    renderedSignature = null;
    render();
  });
  heading.append(toggle, count);
  return heading;
}

function createGroupSection(group: QueueGroup<CommunityQueueItem>): HTMLElement {
  const section = el('section', 'pr-queue-section');
  section.dataset.group = group.id;
  section.append(createGroupHeading(group));
  if (group.id === 'aside' && !isSetAsideOpen) return section;
  for (const item of group.items) section.append(createRow(item, group.id === 'turn'));
  return section;
}

function render(): void {
  if (!queueElement) return;
  currentGroups = communityQueue();
  selectedKey = chooseQueueSelection(currentGroups.filter((group) => group.id !== 'aside' || isSetAsideOpen), selectedKey);
  paintBanner();
  const signature = JSON.stringify([currentGroups, selectedKey, isSetAsideOpen, communityUnseenSignature(), communityStatusView()?.error ?? null]);
  if (signature !== renderedSignature) {
    renderedSignature = signature;
    rowsByKey.clear();
    const laneError = communityStatusView()?.error;
    const notices = laneError ? [el('p', 'my-pr-note', laneError)] : [];
    const sections = currentGroups.filter((group) => group.items.length > 0).map(createGroupSection);
    queueElement.replaceChildren(...notices, ...(sections.length > 0 ? sections : [el('p', 'pr-empty', communityEmptyText(communityStatusView()))]));
  }
  showSelectedDetail();
}

function mountCommunity(parent: HTMLElement): void {
  if (root) return;
  root = el('div', 'pr-content review-queue community-queue');
  parent.append(root);
  const shell = createPrQueueColumns({ queueLabel: 'Community questions', scopeTabs: null, resizerLabel: 'Resize community queue' });
  queueElement = shell.queue;
  detailHost = el('div', 'review-queue-detail');
  const phoneBar = el('div', 'review-queue-phone-bar');
  const back = el('button', 'pr-action pr-action-ghost review-queue-back', 'Back to queue');
  back.type = 'button';
  back.addEventListener('click', returnToQueue);
  phoneBar.append(back);
  shell.detail.append(phoneBar, detailHost);
  banner = buildAttentionBanner({
    onJump: () => {
      const headKey = labeledAttentionTiles(currentGroups, communityItemLabel).find((tile) => tile.id !== selectedKey)?.id;
      if (headKey) revealItem(headKey);
    },
    rowFor: (id) => rowsByKey.get(id),
  });
  banner.classList.add('review-queue-banner');
  shell.queue.before(banner);
  root.append(shell.columns);
  root.dataset.detailOpen = 'false';
  attachCommunityView(() => !isPanelHidden(root));
  subscribeCommunity((change) => {
    if (change.kind === 'status') render();
  });
  document.addEventListener('keydown', onCommunityKey);
  render();
}

export const view: ViewModule<HTMLElement> = {
  mount: mountCommunity,
  refresh: () => {
    shownDetailSignature = null;
    render();
  },
};
