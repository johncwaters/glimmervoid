import { watcherProblemNotice } from '../lane-placeholder-core.ts';
import '../github/review-queue-panel.css';
import './community-panel.css';
import type { CommunityAction, CommunityStateEntry } from '#shared/contracts/community.ts';
import { createActionStatus, requestWithStatus } from '../action-status.ts';
import type { ActionStatus } from '../action-status.ts';
import { el, externalLink, isPanelHidden, isRealInputOwningKey } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { copyButton } from '../ui/copy-button.ts';
import { sectionHeading } from '../ui/section-heading.ts';
import { createPressable } from '../ui/pressable.ts';
import { select } from '../ui/select.ts';
import { isExternalHttpUrl } from '../external-link-core.ts';
import { openExternalUrl } from '../external-link.ts';
import { createPrQueueColumns } from '../github/pr-queue-columns.ts';
import { chooseQueueSelection, communityActivityEntry, queueItemByKey, reviewKeyActionOf, steppedRowKey, turnItems } from '../github/review-queue-core.ts';
import type { CommunityQueueGroup, CommunityQueueItem } from '../github/review-queue-core.ts';
import { createCaughtUpBanner, createPrEmptyState } from '../github/team-review-queue-row.ts';
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
import { createCommunitySetupCard } from './community-setup-card.ts';

const CONFIDENCE_PIP_COUNT = 3;

let root: HTMLElement | null = null;
let queueElement: HTMLElement | null = null;
let detailHost: HTMLElement | null = null;
let currentGroups: CommunityQueueGroup[] = [];
let selectedKey: string | null = null;
let isSetAsideOpen = false;
let renderedSignature: string | null = null;
let shownDetailSignature: string | null = null;
let chosenSessionId = '';
const rowsByKey = new Map<string, HTMLButtonElement>();
let setupCard: ReturnType<typeof createCommunitySetupCard> | null = null;

function startSessionCandidates() {
  return startSessionChoices([...sessionUIs].map(([id, ui]) => ({
    id,
    name: ui.nameEl.textContent ?? id,
    isWorkspace: ui.card.dataset.workspace !== undefined,
    isEphemeral: ui.card.dataset.ephemeral !== undefined,
  })));
}

function createTextList(className: string, label: string, lines: readonly string[]): HTMLElement {
  const list = el('ul', className);
  list.setAttribute('aria-label', label);
  for (const line of lines) list.append(el('li', null, line));
  return list;
}

function createConfidenceMark(entry: CommunityStateEntry, className: string): HTMLElement {
  const badge = communityBadge(entry);
  const mark = el('span', `community-badge ${className}`);
  mark.dataset.tone = badge.tone;
  if (badge.filledPips !== null) {
    const meter = el('span', 'community-confidence-meter');
    meter.setAttribute('aria-hidden', 'true');
    for (let pipIndex = 0; pipIndex < CONFIDENCE_PIP_COUNT; pipIndex += 1) {
      const pip = el('span', 'community-confidence-pip');
      pip.dataset.filled = String(pipIndex < badge.filledPips);
      meter.append(pip);
    }
    mark.append(meter);
  }
  mark.append(el('span', null, badge.text));
  return mark;
}

function createHeading(entry: CommunityStateEntry): HTMLElement {
  const heading = el('div', 'pr-detail-heading');
  const title = el('div', 'pr-detail-title');
  title.append(el('h2', null, entry.item.title || 'Untitled question'));
  const metadata = el('div', 'pr-detail-meta');
  const askedAtMs = Date.parse(entry.item.createdAt);
  metadata.append(el('span', null, entry.item.author), el('span', null, communitySourceText(entry)));
  if (!Number.isNaN(askedAtMs)) metadata.append(el('span', null, `Asked ${formatAgo(askedAtMs)}`));
  for (const tag of entry.item.tags) metadata.append(el('span', 'author-org-tag', tag));
  heading.append(title, metadata);
  return heading;
}

function createQuestionBlock(entry: CommunityStateEntry): HTMLElement {
  const question = el('section', 'community-question');
  question.setAttribute('aria-label', 'Question as asked');
  const openThread = button({ variant: 'quiet', size: 'small', label: 'Open thread', action: 'open-thread', disabled: !isExternalHttpUrl(entry.item.url), onClick: () => openExternalUrl(entry.item.url) });
  question.append(sectionHeading({ title: 'Question as asked', level: 3, actions: [openThread] }).element, el('p', 'community-question-body', entry.item.body));
  return question;
}

function createResearchBlock(entry: CommunityStateEntry): HTMLElement {
  const research = el('section', 'pr-verdict-box community-research');
  research.setAttribute('aria-label', 'Research');
  research.append(createConfidenceMark(entry, 'community-research-mark'));
  if (entry.error) research.append(el('p', 'pr-attention-detail', entry.error));
  if (entry.goal) research.append(el('p', 'community-goal', entry.goal));
  if (entry.summary) research.append(el('p', 'pr-verdict-summary', entry.summary));
  if (entry.gaps.length > 0) research.append(el('h4', 'ui-label community-research-label', 'Not covered'), createTextList('pr-verdict-gaps community-gaps', 'Not covered', entry.gaps));
  if (entry.checked.length === 0) return research;
  const checked = el('details', 'pr-verdict-checked');
  checked.append(el('summary', null, `What it checked (${entry.checked.length})`), createTextList('community-checked', 'What it checked', entry.checked));
  research.append(checked);
  return research;
}

function createPublicLinks(urls: readonly string[]): HTMLElement {
  const list = el('ul', 'community-links');
  list.setAttribute('aria-label', 'Links in the draft');
  for (const url of urls) {
    const item = el('li');
    item.append(externalLink('community-link', url, url));
    list.append(item);
  }
  return list;
}

function createDraftBlock(entry: CommunityStateEntry): HTMLElement | null {
  if (!entry.draft) return null;
  const draftBody = entry.draft.body;
  const draft = el('section', 'community-draft');
  draft.setAttribute('aria-label', 'Draft reply');
  const copyDraft = copyButton({ text: () => draftBody, label: 'Copy draft', action: 'copy-draft', size: 'small' });
  draft.append(sectionHeading({ title: 'Draft reply', level: 3, hint: 'Post it yourself in the thread', actions: [copyDraft.element] }).element, el('p', 'community-draft-body', draftBody));
  const links = entry.draft.publicLinks.filter(isExternalHttpUrl);
  if (links.length > 0) draft.append(createPublicLinks(links));
  return draft;
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
  const choices = startSessionCandidates();
  if (!choices.some((choice) => choice.id === chosenSessionId)) chosenSessionId = choices[0]?.id ?? '';
  const { element } = select({
    options: choices.map((choice) => ({ value: choice.id, label: choice.name })),
    value: chosenSessionId,
    label: 'Session to start from',
    disabled: choices.length === 0,
    onChange: (sessionId) => { chosenSessionId = sessionId; },
  });
  return element;
}

function createActions(entry: CommunityStateEntry): HTMLElement {
  const actions = el('section', 'community-actions');
  actions.setAttribute('aria-label', 'Actions');
  const status = createActionStatus('pr-action-status');
  const startRow = el('div', 'community-start-row');
  startRow.append(createSessionPicker(), button({ variant: 'primary', label: 'Start session', action: 'start-session', onClick: () => void startSession(entry, status) }));
  const laneButtons = el('div', 'community-lane-buttons');
  laneButtons.append(
    button({ variant: 'quiet', size: 'small', label: 'Re-run', action: 'rerun-community-research', disabled: !canRerunCommunityEntry(entry), onClick: () => void runAction(entry, 'rerun', status) }),
    button({ variant: 'quiet', size: 'small', label: 'Set aside', action: 'set-aside-community-question', disabled: !canSetAsideCommunityEntry(entry), onClick: () => void runAction(entry, 'set-aside', status) }),
  );
  actions.append(sectionHeading({ title: 'Start a session from', level: 3 }).element, startRow, laneButtons, status.element);
  return actions;
}

function createDetail(entry: CommunityStateEntry): HTMLElement {
  const detail = el('article', 'pr-detail pr-desk community-detail');
  const column = el('div', 'pr-desk-column');
  const rail = el('aside', 'pr-desk-rail');
  rail.setAttribute('aria-label', 'Research and actions');
  const draft = createDraftBlock(entry);
  column.append(createHeading(entry), ...(draft ? [draft] : []), createQuestionBlock(entry));
  rail.append(createActions(entry), createResearchBlock(entry));
  detail.append(column, rail);
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
    : createPrEmptyState(communityEmptyText(communityStatusView())));
}

function markSeen(item: CommunityQueueItem, row: HTMLButtonElement): void {
  if (!markCommunityEntrySeen(communityActivityEntry(item))) return;
  row.querySelector('.pr-queue-unseen')?.remove();
}

function selectItem(key: string): void {
  selectedKey = key;
  for (const [rowKey, row] of rowsByKey) row.setAttribute('aria-current', String(rowKey === key));
  const item = queueItemByKey(currentGroups, key);
  const row = rowsByKey.get(key);
  if (item && row) markSeen(item, row);
  showSelectedDetail();
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
  const row = createPressable('pr-queue-row pr-queue-row-quiet community-queue-row');
  row.dataset.queueKey = item.key;
  row.setAttribute('aria-current', String(item.key === selectedKey));
  const top = el('span', 'pr-queue-top');
  top.append(el('span', 'pr-queue-title', communityItemLabel(item)));
  const bottom = el('span', 'pr-queue-bottom');
  bottom.append(createConfidenceMark(item.entry, 'community-row-mark'), el('span', 'community-row-source', communitySourceText(item.entry)));
  row.append(top, bottom);
  if (isTurn && isCommunityEntryUnseen(communityActivityEntry(item))) {
    const activity = el('span', 'tab-activity active pr-queue-unseen');
    activity.setAttribute('aria-hidden', 'true');
    row.append(activity);
  }
  row.addEventListener('click', () => selectItem(item.key));
  rowsByKey.set(item.key, row);
  return row;
}

function createGroupHeading(group: CommunityQueueGroup): HTMLElement {
  const heading = el('h3', 'pr-section-heading review-group-heading');
  const count = el('span', 'review-group-count', String(group.items.length));
  if (group.id !== 'aside') {
    heading.append(el('span', null, group.title), count);
    return heading;
  }
  const toggle = createPressable('review-group-toggle');
  const chevron = el('span', 'review-group-chevron', String.fromCharCode(0x25b8));
  chevron.setAttribute('aria-hidden', 'true');
  toggle.append(chevron, group.title);
  toggle.setAttribute('aria-expanded', String(isSetAsideOpen));
  toggle.addEventListener('click', () => {
    isSetAsideOpen = !isSetAsideOpen;
    renderedSignature = null;
    render();
  });
  heading.append(toggle, count);
  return heading;
}

function createGroupSection(group: CommunityQueueGroup): HTMLElement {
  const section = el('section', 'pr-queue-section');
  section.dataset.group = group.id;
  section.append(createGroupHeading(group));
  if (group.id === 'aside' && !isSetAsideOpen) return section;
  for (const item of group.items) section.append(createRow(item, group.id === 'turn'));
  return section;
}

function syncSetupCard(): boolean {
  if (!root || !setupCard) return false;
  if (communityStatusView()?.configured === false && setupCard.needsSetup() && !setupCard.isOpen()) setupCard.open();
  const isSetupShown = setupCard.isOpen();
  root.dataset.setup = String(isSetupShown);
  setupCard.element.hidden = !isSetupShown;
  return isSetupShown;
}

function render(): void {
  if (!queueElement) return;
  if (syncSetupCard()) return;
  currentGroups = communityQueue();
  selectedKey = chooseQueueSelection(currentGroups.filter((group) => group.id !== 'aside' || isSetAsideOpen), selectedKey);
  const signature = JSON.stringify([currentGroups, selectedKey, isSetAsideOpen, communityUnseenSignature(), communityStatusView()?.error ?? null, watcherProblemNotice(communityStatusView())]);
  if (signature !== renderedSignature) {
    renderedSignature = signature;
    rowsByKey.clear();
    const laneError = communityStatusView()?.error || watcherProblemNotice(communityStatusView());
    const notices = laneError ? [el('p', 'my-pr-note', laneError)] : [];
    const sections = currentGroups.filter((group) => group.items.length > 0).map(createGroupSection);
    queueElement.replaceChildren(...notices, ...(sections.length > 0 ? sections : [createPrEmptyState(communityEmptyText(communityStatusView()))]));
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
  phoneBar.append(button({ variant: 'secondary', label: 'Back to queue', action: 'back-to-queue', onClick: returnToQueue }));
  shell.detail.append(phoneBar, detailHost);
  setupCard = createCommunitySetupCard({ onFinish: render });
  setupCard.element.hidden = true;
  root.append(setupCard.element, shell.columns);
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
