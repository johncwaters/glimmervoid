import { watcherProblemNotice } from '../lane-placeholder-core.ts';
import '../github/review-queue-panel.css';
import './community-panel.css';
import type { CommunityAction, CommunitySource, CommunitySourceView, CommunityStateEntry } from '#shared/contracts/community.ts';
import { packApprovalHashOf } from '#shared/pack-approval.ts';
import { PACKS_TAB_HASH } from '../packs/packs-store.ts';
import { clock } from '#shared/clock.ts';
import { createActionStatus, requestWithStatus } from '../action-status.ts';
import type { ActionStatus } from '../action-status.ts';
import { el, externalLink, isPanelHidden, isRealInputOwningKey } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { copyButton } from '../ui/copy-button.ts';
import { sectionHeading } from '../ui/section-heading.ts';
import { disclosure } from '../ui/disclosure.ts';
import { emptyState } from '../ui/empty-state.ts';
import { buildMenuItem, popupMenu } from '../ui/popup-menu.ts';
import { monogramFor } from '../avatar-core.ts';
import { getCommunityFilter, getCommunitySort, setCommunityFilter, setCommunitySort } from '../ui-prefs.ts';
import { createPressable } from '../ui/pressable.ts';
import { select } from '../ui/select.ts';
import { isExternalHttpUrl } from '../external-link-core.ts';
import { openExternalUrl } from '../external-link.ts';
import { createPrQueueColumns } from '../github/pr-queue-columns.ts';
import { chooseQueueSelection, communityActivityEntry, queueItemByKey, reviewKeyActionOf, steppedRowKey, turnItems } from '../github/review-queue-core.ts';
import type { CommunityQueueGroup, CommunityQueueItem } from '../github/review-queue-core.ts';
import { createCaughtUpBanner, createPrEmptyState } from '../github/team-review-queue-row.ts';
import { reviewQueueNavigation } from '../github/review-queue-store.ts';
import { createPollAgoTicker, formatAgo, formatDuration } from '../poll-ago.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { isModalOpen } from '../session-card/modal.ts';
import type { ViewModule } from '../view-registry-core.ts';
import {
  attachCommunityView, communityQueue, communityStatusView, communityUnseenSignature, isCommunityEntryUnseen, markCommunityEntrySeen, subscribeCommunity,
} from './community-store.ts';
import {
  arrangeCommunityGroups, canRerunCommunityEntry, canSetAsideCommunityEntry, COMMUNITY_SORT_CHOICES, communityBadge, communityCaughtUpText, communityEmptyText, communityFilterCounts,
  communityItemLabel, communitySetupState, communityStatusText, parseCommunityFilter, startSessionChoices, VERDICT_FILTER_CHOICES,
} from './community-view-core.ts';
import type { CommunityFilterPrefs, CommunitySort } from './community-view-core.ts';
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
let chosenSort: CommunitySort = getCommunitySort();
let filterPrefs: CommunityFilterPrefs = getCommunityFilter();
let toolbarStatus: HTMLElement | null = null;
const sortItems = new Map<CommunitySort, HTMLButtonElement>();

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

function createConfidencePips(filledPips: number): HTMLElement {
  const meter = el('span', 'community-confidence-meter');
  meter.setAttribute('aria-hidden', 'true');
  for (let pipIndex = 0; pipIndex < CONFIDENCE_PIP_COUNT; pipIndex += 1) {
    const pip = el('span', 'community-confidence-pip');
    pip.dataset.filled = String(pipIndex < filledPips);
    meter.append(pip);
  }
  return meter;
}

function createConfidenceMark(entry: CommunityStateEntry, className: string, isWordShown = true): HTMLElement {
  const badge = communityBadge(entry);
  const mark = el('span', `community-badge ${className}`);
  mark.dataset.tone = badge.tone;
  if (badge.filledPips !== null) mark.append(createConfidencePips(badge.filledPips));
  if (isWordShown || badge.filledPips === null) mark.append(el('span', null, badge.text));
  if (!isWordShown && badge.filledPips !== null) mark.setAttribute('aria-label', badge.text);
  return mark;
}

function sourceViewOf(source: CommunitySource): CommunitySourceView | null {
  return communityStatusView()?.sources.find((view) => view.id === source) ?? null;
}

function sourceLabel(source: CommunitySource): string {
  return sourceViewOf(source)?.label ?? source.split(':').at(-1) ?? source;
}

function createSourceMark(source: CommunitySource): HTMLElement {
  const view = sourceViewOf(source);
  const mark = el('span', 'community-source-mark');
  mark.setAttribute('aria-hidden', 'true');
  if (view === null || view.iconUrl === null) {
    mark.dataset.fallback = 'true';
    mark.textContent = monogramFor(view?.label ?? source);
    return mark;
  }
  mark.style.setProperty('--source-icon', `url("${view.iconUrl}")`);
  mark.style.setProperty('--source-brand-dark', view.color.dark);
  mark.style.setProperty('--source-brand-light', view.color.light);
  return mark;
}

const rowAgeTicker = createPollAgoTicker(() => root);
const detailAgeTicker = createPollAgoTicker(() => root);

function askedAtMsOf(entry: CommunityStateEntry): number | null {
  const askedAtMs = Date.parse(entry.item.createdAt);
  return Number.isNaN(askedAtMs) ? null : askedAtMs;
}

function shortAgeText(askedAtMs: number | null | undefined): string {
  return typeof askedAtMs === 'number' ? formatDuration(clock.nowMs() - askedAtMs) : '';
}

function askedText(askedAtMs: number | null | undefined): string {
  return `asked ${formatAgo(askedAtMs)}`;
}

function createHeading(entry: CommunityStateEntry): HTMLElement {
  const heading = el('div', 'pr-detail-heading');
  const title = el('div', 'pr-detail-title');
  title.append(el('h2', null, entry.item.title || 'Untitled question'));
  heading.append(title);
  if (entry.item.tags.length === 0) return heading;
  const metadata = el('div', 'pr-detail-meta');
  for (const tag of entry.item.tags) metadata.append(el('span', 'author-org-tag', tag));
  heading.append(metadata);
  return heading;
}

function createMessage(options: { label: string; avatarText: string; isOwn: boolean; head: readonly HTMLElement[]; action: HTMLElement; bubble: readonly HTMLElement[] }): HTMLElement {
  const message = el('section', 'community-message');
  message.setAttribute('aria-label', options.label);
  message.dataset.own = String(options.isOwn);
  const avatar = el('span', 'community-avatar', options.avatarText);
  avatar.setAttribute('aria-hidden', 'true');
  const head = el('div', 'community-message-head');
  head.append(...options.head, options.action);
  const bubble = el('div', 'community-bubble');
  bubble.append(...options.bubble);
  const body = el('div', 'community-message-body');
  body.append(head, bubble);
  message.append(avatar, body);
  return message;
}

function createQuestionBlock(entry: CommunityStateEntry): HTMLElement {
  const source = el('span', 'community-message-source');
  source.append(createSourceMark(entry.item.source), el('span', null, sourceLabel(entry.item.source)));
  const askedAtMs = askedAtMsOf(entry);
  const head = [el('strong', 'community-message-author', entry.item.author), source];
  if (entry.item.channel) head.push(el('span', 'community-message-place', `#${entry.item.channel}`));
  if (askedAtMs !== null) {
    const asked = el('span', 'community-message-time');
    detailAgeTicker.track(asked, askedAtMs, askedText);
    head.push(asked);
  }
  const questionBody = el('p', 'community-question-body', entry.item.body);
  questionBody.tabIndex = 0;
  return createMessage({
    label: 'Question as asked',
    avatarText: monogramFor(entry.item.author),
    isOwn: false,
    head,
    action: button({ variant: 'quiet', size: 'small', label: 'Open thread', action: 'open-thread', disabled: !isExternalHttpUrl(entry.item.url), onClick: () => openExternalUrl(entry.item.url) }),
    bubble: [questionBody],
  });
}

function createResearchBlock(entry: CommunityStateEntry): HTMLElement {
  const research = el('section', 'pr-verdict-box community-research');
  research.setAttribute('aria-label', 'Research');
  research.append(createConfidenceMark(entry, 'community-research-mark'));
  if (entry.error) research.append(el('p', 'pr-attention-detail', entry.error));
  if (entry.goal) research.append(el('p', 'community-goal', entry.goal));
  const notes: HTMLElement[] = [];
  if (entry.summary) notes.push(el('p', 'pr-verdict-summary', entry.summary));
  if (entry.gaps.length > 0) notes.push(el('h4', 'ui-label community-research-label', 'Not covered'), createTextList('pr-verdict-gaps community-gaps', 'Not covered', entry.gaps));
  if (entry.checked.length > 0) notes.push(el('h4', 'ui-label community-research-label', 'What it checked'), createTextList('community-gaps community-checked', 'What it checked', entry.checked));
  if (notes.length === 0) return research;
  const notesBody = el('div', 'community-research-notes-body');
  notesBody.append(...notes);
  const researchNotes = disclosure({ summary: 'Research notes', body: notesBody });
  research.append(researchNotes.element);
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
  const copyDraft = copyButton({ text: () => draftBody, label: 'Copy draft', action: 'copy-draft', size: 'small' });
  const links = entry.draft.publicLinks.filter(isExternalHttpUrl);
  const draft = createMessage({
    label: 'Draft reply',
    avatarText: 'Y',
    isOwn: true,
    head: [el('strong', 'community-message-author', 'Your draft'), el('span', 'community-message-time', 'not posted, post it yourself in the thread')],
    action: copyDraft.element,
    bubble: [el('p', 'community-draft-body', draftBody), ...(links.length > 0 ? [createPublicLinks(links)] : [])],
  });
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
  column.append(createHeading(entry), createQuestionBlock(entry), ...(draft ? [draft] : []));
  rail.append(createActions(entry), createResearchBlock(entry));
  detail.append(column, rail);
  return detail;
}

function markShownItemSeen(item: CommunityQueueItem): void {
  const row = rowsByKey.get(item.key);
  if (!root || isPanelHidden(root) || !row) return;
  const isDetailOffScreen = document.documentElement.dataset.layout === 'phone' && root.dataset.detailOpen !== 'true';
  if (isDetailOffScreen) return;
  markSeen(item, row);
}

function showSelectedDetail(): void {
  if (!detailHost) return;
  const item = queueItemByKey(currentGroups, selectedKey);
  const signature = item ? JSON.stringify(item.entry) : `empty:${turnItems(currentGroups).length}:${hiddenByFilterCount()}:${JSON.stringify(communitySetupState(communityStatusView()))}`;
  if (signature === shownDetailSignature) return;
  shownDetailSignature = signature;
  detailAgeTicker.reset();
  if (item) {
    detailHost.replaceChildren(createDetail(item.entry));
    markShownItemSeen(item);
    return;
  }
  const hasAnyItem = currentGroups.some((group) => group.items.length > 0);
  detailHost.replaceChildren(hasAnyItem
    ? createCaughtUpBanner({ title: 'All caught up', detail: communityCaughtUpText(currentGroups) })
    : createQueueEmptyState({ withSetupAction: true }));
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
  const row = createPressable('pr-queue-row pr-queue-row-compact community-queue-row');
  row.dataset.queueKey = item.key;
  row.setAttribute('aria-current', String(item.key === selectedKey));
  const age = el('span', 'community-row-age');
  rowAgeTicker.track(age, askedAtMsOf(item.entry), shortAgeText);
  const sourceMark = createSourceMark(item.entry.item.source);
  sourceMark.setAttribute('aria-label', sourceLabel(item.entry.item.source));
  sourceMark.setAttribute('role', 'img');
  row.append(
    sourceMark,
    el('span', 'pr-queue-title', communityItemLabel(item)),
    createConfidenceMark(item.entry, 'community-row-mark', false),
    age,
  );
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

function createSourceHeading(source: CommunitySource, count: number): HTMLElement {
  const heading = el('div', 'community-source-heading');
  heading.append(createSourceMark(source), el('span', 'community-source-heading-name', sourceLabel(source)), el('span', 'review-group-count', String(count)));
  return heading;
}

function createMenuLabel(text: string): HTMLElement {
  const label = el('div', 'community-menu-label', text);
  label.setAttribute('role', 'presentation');
  return label;
}

function createMenuDivider(): HTMLElement {
  const divider = el('div', 'community-menu-divider');
  divider.setAttribute('role', 'separator');
  return divider;
}

function storeFilter(next: CommunityFilterPrefs): void {
  filterPrefs = next;
  setCommunityFilter(next);
  renderedSignature = null;
  render();
}

function toggledList(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

function createFilterItem(options: { label: string; count: number; isChecked: boolean; lead: HTMLElement | null; onToggle: () => void }): HTMLButtonElement {
  const item = buildMenuItem('', 'visible community-menu-item');
  item.setAttribute('role', 'menuitemcheckbox');
  item.setAttribute('aria-checked', String(options.isChecked));
  item.replaceChildren(...(options.lead ? [options.lead] : []), el('span', 'community-menu-item-label', options.label), el('span', 'community-menu-item-count', String(options.count)));
  item.addEventListener('click', (event) => {
    event.stopPropagation();
    item.setAttribute('aria-checked', String(item.getAttribute('aria-checked') !== 'true'));
    options.onToggle();
  });
  return item;
}

function fillFilterMenu(menu: HTMLElement): void {
  const counts = communityFilterCounts(communityQueue(), parseCommunityFilter(filterPrefs));
  const sourceItems = [...counts.sources].map(([source, count]) => createFilterItem({
    label: sourceLabel(source), count, isChecked: filterPrefs.sources.includes(source), lead: createSourceMark(source),
    onToggle: () => storeFilter({ ...filterPrefs, sources: toggledList(filterPrefs.sources, source) }),
  }));
  const verdictItems = VERDICT_FILTER_CHOICES.flatMap((choice) => {
    const count = counts.verdicts.get(choice.value);
    if (count === undefined) return [];
    const pips = el('span', 'community-badge');
    pips.dataset.tone = choice.tone;
    pips.append(createConfidencePips(choice.filledPips));
    return [createFilterItem({
      label: choice.label, count, isChecked: filterPrefs.verdicts.includes(choice.value), lead: pips,
      onToggle: () => storeFilter({ ...filterPrefs, verdicts: toggledList(filterPrefs.verdicts, choice.value) }),
    })];
  });
  const channelItems = [...counts.channels].map(([channel, count]) => createFilterItem({
    label: `#${channel}`, count, isChecked: filterPrefs.channels.includes(channel), lead: null,
    onToggle: () => storeFilter({ ...filterPrefs, channels: toggledList(filterPrefs.channels, channel) }),
  }));
  const sections = [['Source', sourceItems], ['Confidence', verdictItems], ['Channel', channelItems]] as const;
  const children = sections.filter(([, items]) => items.length > 0).flatMap(([title, items], index) => [...(index > 0 ? [createMenuDivider()] : []), createMenuLabel(title), ...items]);
  const clearItem = buildMenuItem('Clear filters', 'visible community-menu-item community-menu-clear');
  clearItem.addEventListener('click', () => storeFilter({ sources: [], verdicts: [], channels: [] }));
  menu.replaceChildren(...children, createMenuDivider(), clearItem);
}

function chooseSort(sort: CommunitySort): void {
  chosenSort = sort;
  setCommunitySort(sort);
  for (const [value, item] of sortItems) item.setAttribute('aria-checked', String(value === sort));
  renderedSignature = null;
  render();
}

function createMenuControl(options: { label: string; action: string; menuLabel: string; onOpen?: (menu: HTMLElement) => void; items?: readonly HTMLElement[] }): HTMLElement {
  const anchor = el('div', 'session-overflow community-menu-anchor');
  const trigger = button({ variant: 'secondary', size: 'small', label: options.label, action: options.action });
  const menu = el('div', 'session-overflow-menu community-menu');
  menu.setAttribute('aria-label', options.menuLabel);
  menu.append(...(options.items ?? []));
  anchor.append(trigger, menu);
  popupMenu({ trigger, menu, onOpen: () => options.onOpen?.(menu) });
  return anchor;
}

function createToolbar(): HTMLElement {
  const toolbar = el('div', 'community-toolbar');
  toolbarStatus = el('span', 'community-toolbar-status');
  toolbarStatus.setAttribute('role', 'status');
  const sortChoices = COMMUNITY_SORT_CHOICES.map((choice) => {
    const item = buildMenuItem('', 'visible community-menu-item');
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(choice.value === chosenSort));
    item.replaceChildren(el('span', 'community-menu-item-label', choice.label), el('span', 'community-menu-item-count', choice.hint));
    item.addEventListener('click', () => chooseSort(choice.value));
    sortItems.set(choice.value, item);
    return item;
  });
  const sort = createMenuControl({ label: 'Sort', action: 'open-community-sort', menuLabel: 'Sort questions', items: [createMenuLabel('Sort by'), ...sortChoices] });
  const filter = createMenuControl({ label: 'Filter', action: 'open-community-filter', menuLabel: 'Filter questions', onOpen: fillFilterMenu });
  const controls = el('div', 'community-toolbar-controls');
  controls.append(sort, filter);
  toolbar.append(controls, toolbarStatus);
  return toolbar;
}

function hiddenByFilterCount(): number {
  const countItems = (groups: readonly CommunityQueueGroup[]) => groups.reduce((total, group) => total + group.items.length, 0);
  return countItems(communityQueue()) - countItems(currentGroups);
}

function openPacksHash(hash: string): void {
  location.hash = hash;
}

function setupEmptyState(setup: NonNullable<ReturnType<typeof communitySetupState>>): HTMLElement {
  const hash = setup.packName === null ? PACKS_TAB_HASH : packApprovalHashOf(setup.packName);
  const open = button({ variant: 'primary', size: 'small', label: setup.packName === null ? 'Open Packs' : 'Open pack settings', action: 'open-community-source-pack', onClick: () => openPacksHash(hash) });
  return emptyState({ title: setup.title, text: setup.text, actions: [open] });
}

function createQueueEmptyState({ withSetupAction }: { withSetupAction: boolean }): HTMLElement {
  const hiddenCount = hiddenByFilterCount();
  const setup = hiddenCount === 0 ? communitySetupState(communityStatusView()) : null;
  if (setup !== null) return withSetupAction ? setupEmptyState(setup) : createPrEmptyState(setup.title);
  const text = communityEmptyText(communityStatusView(), hiddenCount);
  if (hiddenCount === 0) return createPrEmptyState(text);
  const clear = button({ variant: 'secondary', size: 'small', label: 'Clear filters', action: 'clear-community-filters', onClick: () => storeFilter({ sources: [], verdicts: [], channels: [] }) });
  return emptyState({ text, actions: [clear] });
}

function syncToolbar(): void {
  if (toolbarStatus) toolbarStatus.textContent = communityStatusText(chosenSort, parseCommunityFilter(filterPrefs), sourceLabel);
}

function createGroupSection(group: CommunityQueueGroup): HTMLElement {
  const section = el('section', 'pr-queue-section');
  section.dataset.group = group.id;
  section.append(createGroupHeading(group));
  if (group.id === 'aside' && !isSetAsideOpen) return section;
  let previousSource: CommunitySource | null = null;
  for (const item of group.items) {
    const source = item.entry.item.source;
    if (chosenSort === 'source' && source !== previousSource) section.append(createSourceHeading(source, group.items.filter((other) => other.entry.item.source === source).length));
    previousSource = source;
    section.append(createRow(item, group.id === 'turn'));
  }
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

function sourceProblems(): HTMLElement[] {
  return (communityStatusView()?.sources ?? []).filter((view) => view.error !== null).map((view) => {
    const problem = el('div', 'community-source-problem');
    problem.setAttribute('role', 'status');
    const head = el('div', 'community-source-problem-head');
    head.append(createSourceMark(view.id), el('span', 'community-source-problem-label', view.label), el('span', 'community-source-problem-state', 'Last poll failed'));
    problem.append(head, el('p', 'community-source-problem-text', view.error ?? ''));
    return problem;
  });
}

function render(): void {
  if (!queueElement) return;
  if (syncSetupCard()) return;
  currentGroups = arrangeCommunityGroups(communityQueue(), chosenSort, parseCommunityFilter(filterPrefs));
  syncToolbar();
  selectedKey = chooseQueueSelection(currentGroups.filter((group) => group.id !== 'aside' || isSetAsideOpen), selectedKey);
  const signature = JSON.stringify([currentGroups, hiddenByFilterCount(), chosenSort, selectedKey, isSetAsideOpen, communityUnseenSignature(), communityStatusView()?.error ?? null, communityStatusView()?.sources ?? [], watcherProblemNotice(communityStatusView())]);
  if (signature !== renderedSignature) {
    renderedSignature = signature;
    rowsByKey.clear();
    rowAgeTicker.reset();
    const laneError = communityStatusView()?.error || watcherProblemNotice(communityStatusView());
    const notices = [...(laneError ? [el('p', 'my-pr-note', laneError)] : []), ...sourceProblems()];
    const sections = currentGroups.filter((group) => group.items.length > 0).map(createGroupSection);
    queueElement.replaceChildren(...notices, ...(sections.length > 0 ? sections : [createQueueEmptyState({ withSetupAction: false })]));
  }
  showSelectedDetail();
}

function mountCommunity(parent: HTMLElement): void {
  if (root) return;
  root = el('div', 'pr-content review-queue community-queue');
  parent.append(root);
  const shell = createPrQueueColumns({ queueLabel: 'Community questions', scopeTabs: createToolbar(), resizerLabel: 'Resize community queue' });
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
  rowAgeTicker.ensure();
  detailAgeTicker.ensure();
  render();
}

export const view: ViewModule<HTMLElement> = {
  mount: mountCommunity,
  refresh: () => {
    shownDetailSignature = null;
    render();
  },
};
