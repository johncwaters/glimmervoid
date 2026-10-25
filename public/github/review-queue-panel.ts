import { attentionSignature } from '../attention-ack-core.ts';
import { buildAttentionBanner, paintAttentionBanner } from '../attention-banner.ts';
import { createAvatar, el, isPanelHidden } from '../dom-helpers.ts';
import { buildNextAttentionKeys } from '../shortcuts.ts';
import { getPrsAttentionAck, getPrsUnseenRows, setPrsAttentionAck, setPrsUnseenRows } from '../ui-prefs.ts';
import { createGithubPollingControls, createMyPrQueueRow, mountMyPrsDetail, myPrsSnapshot, showMyPr } from './my-prs-panel.ts';
import type { LinkedLiveSession } from './my-prs-view-core.ts';
import { emptyStateText as myPrsEmptyStateText, queueNotices as myPrsQueueNotices } from './my-prs-view-core.ts';
import { createPrQueueColumns } from './pr-queue-columns.ts';
import { createPrScopeTabs } from './pr-scope-tabs.ts';
import {
  QUEUE_FILTERS, attentionCountsOf, attentionTilesOf, bannerTilesOf, buildReviewQueue, caughtUpText, chooseQueueSelection, combinedPollingStatus, decideTurnAttention, filterQueue, nextTurnKey,
  queueItemActivityEntry, queueItemByKey, spansMultipleRepos, turnActivityEntries, turnItems,
} from './review-queue-core.ts';
import type { QueueFilter, QueueGroup, QueueItem } from './review-queue-core.ts';
import {
  clearTeamReviewSelection, createCaughtUpBanner, createTeamQueueRow, mountTeamReviewDetail, paintQueueRowTitle, refreshTeamReviewAges, resetTeamQueueTickers, showTeamReview, teamReviewEmptyState,
  teamReviewLaneNotices, teamReviewSections, teamReviewStatusView,
} from './team-review-panel.ts';

interface ReviewQueueNavigation {
  openTerminal: (sessionId: string) => void;
  openReviews: () => boolean;
}

let root: HTMLElement | null = null;
let queueElement: HTMLElement | null = null;
let detailHost: HTMLElement | null = null;
let banner: HTMLElement | null = null;
let teamChipSlot: HTMLElement | null = null;
let teamDetail: HTMLElement | null = null;
let mineDetail: HTMLElement | null = null;
let filterTabs: ReturnType<typeof createPrScopeTabs<QueueFilter>> | null = null;
let pollingControls: ReturnType<typeof createGithubPollingControls> | null = null;
let navigation: ReviewQueueNavigation | null = null;
let currentGroups: QueueGroup[] = [];
let filter: QueueFilter = 'all';
let selectedKey: string | null = null;
let shownKey: string | null | undefined;
let isCaughtUp = false;
let isSetAsideOpen = false;
let renderedSignature: string | null = null;
let isRenderQueued = false;
let activityCallback: ((isActive: boolean) => void) | null = null;
let acknowledged = getPrsAttentionAck();
let unseenSignature = getPrsUnseenRows();
let unseenEntries = new Set(unseenSignature.split('|').filter(Boolean));
const rowsByKey = new Map<string, HTMLButtonElement>();

function storeAcknowledged(signature: string): void {
  if (signature === acknowledged) return;
  acknowledged = signature;
  setPrsAttentionAck(signature);
}

function storeUnseen(signature: string): void {
  if (signature === unseenSignature) return;
  unseenSignature = signature;
  unseenEntries = new Set(signature.split('|').filter(Boolean));
  setPrsUnseenRows(signature);
}

function hasBothLanes(): boolean {
  return teamReviewStatusView() !== null && myPrsSnapshot().status !== null;
}

function refreshActivity(): void {
  if (!hasBothLanes()) return;
  const decision = decideTurnAttention({ turnEntries: turnActivityEntries(currentGroups), acknowledged, unseen: unseenSignature, isLooking: !isPanelHidden(root) });
  storeAcknowledged(decision.acknowledged);
  storeUnseen(decision.unseen);
  activityCallback?.(decision.isShown);
}

export function acknowledgeReviewQueueAttention(): void {
  if (!hasBothLanes()) return;
  storeAcknowledged(attentionSignature(turnActivityEntries(currentGroups)));
  refreshActivity();
}

export function setReviewQueueActivityCallback(callback: (isActive: boolean) => void): void {
  activityCallback = callback;
  refreshActivity();
}

function markSeen(item: QueueItem, row: HTMLButtonElement): void {
  const entry = queueItemActivityEntry(item);
  if (!unseenEntries.has(entry)) return;
  storeUnseen(attentionSignature([...unseenEntries].filter((unseenEntry) => unseenEntry !== entry)));
  row.querySelector('.pr-queue-unseen')?.remove();
  delete row.dataset.unseen;
  if (item.source === 'team') paintQueueRowTitle(row);
}

function swapDetail(element: HTMLElement): void {
  if (!detailHost || (detailHost.childElementCount === 1 && detailHost.firstElementChild === element)) return;
  detailHost.replaceChildren(element);
}

function caughtUpElement(): HTMLElement {
  const hasNewTurn = turnItems(currentGroups).length > 0;
  if (hasNewTurn) return createCaughtUpBanner({ title: 'New pull requests need you', detail: 'Pick one from the queue.' });
  return createCaughtUpBanner({ title: 'All caught up', detail: caughtUpText(currentGroups) });
}

function showSelectedDetail(notice: 'keep' | 'clear'): void {
  const item = queueItemByKey(currentGroups, selectedKey);
  shownKey = item?.key ?? null;
  if (!item) {
    clearTeamReviewSelection();
    if (detailHost) detailHost.replaceChildren(isCaughtUp ? caughtUpElement() : el('p', 'pr-empty', 'Pick a pull request from the queue.'));
    return;
  }
  if (item.source === 'team' && teamDetail) {
    showTeamReview(item.review.key, notice);
    swapDetail(teamDetail);
    return;
  }
  if (item.source === 'mine' && mineDetail) {
    clearTeamReviewSelection();
    showMyPr(item.pr.key);
    swapDetail(mineDetail);
  }
}

function selectItem(key: string, { isFromQueue }: { isFromQueue: boolean }): void {
  selectedKey = key;
  isCaughtUp = false;
  for (const [rowKey, row] of rowsByKey) row.setAttribute('aria-current', String(rowKey === key));
  const item = queueItemByKey(currentGroups, key);
  const row = rowsByKey.get(key);
  if (item && row) markSeen(item, row);
  showSelectedDetail('clear');
  paintBanner();
  if (isFromQueue && document.documentElement.dataset.layout === 'phone') detailHost?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function paintBanner(): void {
  if (!banner) return;
  const tiles = bannerTilesOf(currentGroups, selectedKey);
  paintAttentionBanner(banner, attentionCountsOf(attentionTilesOf(currentGroups)), tiles);
}

export function jumpToNextReview(): boolean {
  const headKey = bannerTilesOf(currentGroups, selectedKey)[0]?.id ?? null;
  if (!headKey) return false;
  revealItem(headKey);
  return true;
}

function revealItem(key: string): void {
  const item = queueItemByKey(currentGroups, key);
  if (!item) return;
  if (!queueItemByKey(filterQueue(currentGroups, filter), key)) {
    filter = 'all';
    filterTabs?.select(filter);
  }
  if (currentGroups.find((group) => group.items.includes(item))?.id === 'aside') isSetAsideOpen = true;
  selectedKey = key;
  render();
  selectItem(key, { isFromQueue: false });
  const row = rowsByKey.get(key);
  row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: 'nearest' });
}

export function showPrInReviewQueue(prKey: string): boolean {
  const item = currentGroups.flatMap((group) => group.items).find((candidate) => candidate.prKey === prKey.toLowerCase());
  if (!item || !navigation?.openReviews()) return false;
  revealItem(item.key);
  acknowledgeReviewQueueAttention();
  return true;
}

function advanceAfterAction(actedReviewKey: string, capturedOrder: readonly string[]): void {
  const nextKey = nextTurnKey({ capturedOrder, actedKey: `team:${actedReviewKey}`, groups: currentGroups });
  selectedKey = nextKey;
  isCaughtUp = nextKey === null;
  renderedSignature = null;
  render();
  if (nextKey) for (const [rowKey, row] of rowsByKey) row.setAttribute('aria-current', String(rowKey === nextKey));
  showSelectedDetail('keep');
}

function rowFor(item: QueueItem, hasMultipleRepos: boolean, sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): { container: HTMLElement; row: HTMLButtonElement } {
  if (item.source === 'team') {
    const row = createTeamQueueRow(item.review, item.kind, hasMultipleRepos);
    return { container: row, row };
  }
  const mineRow = createMyPrQueueRow(item.pr, item.stackedOn, sessionsByPrKey.get(item.prKey));
  return { container: mineRow.group, row: mineRow.row };
}

function createItemRow(item: QueueItem, isTurn: boolean, hasMultipleRepos: boolean, sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): HTMLElement {
  const { container, row } = rowFor(item, hasMultipleRepos, sessionsByPrKey);
  row.dataset.queueKey = item.key;
  row.setAttribute('aria-current', String(item.key === selectedKey));
  const entry = queueItemActivityEntry(item);
  if (isTurn && unseenEntries.has(entry)) {
    const activity = el('span', 'tab-activity active pr-queue-unseen');
    activity.setAttribute('aria-hidden', 'true');
    row.dataset.unseen = entry;
    row.append(activity);
    if (item.source === 'team') paintQueueRowTitle(row);
  }
  row.addEventListener('click', () => selectItem(item.key, { isFromQueue: true }));
  rowsByKey.set(item.key, row);
  return container;
}

function createGroupHeading(group: QueueGroup): HTMLElement {
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

function createGroupSection(group: QueueGroup, hasMultipleRepos: boolean, sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): HTMLElement {
  const section = el('section', 'pr-queue-section');
  section.dataset.group = group.id;
  section.append(createGroupHeading(group));
  if (group.id === 'aside' && !isSetAsideOpen) return section;
  for (const item of group.items) section.append(createItemRow(item, group.id === 'turn', hasMultipleRepos, sessionsByPrKey));
  return section;
}

function queueNoticeElements(): HTMLElement[] {
  const mineNotices = myPrsQueueNotices(myPrsSnapshot().status, Date.now()).filter((notice) => notice.tone !== 'error').map((notice) => el('p', 'my-pr-note', notice.text));
  return [...(pollingControls ? [pollingControls.notice] : []), ...teamReviewLaneNotices(), ...mineNotices];
}

function emptyQueueElements(): HTMLElement[] {
  const hasAnyItem = currentGroups.some((group) => group.items.length > 0);
  if (hasAnyItem) return [el('p', 'pr-empty', 'No pull requests match this filter.')];
  return [teamReviewEmptyState(), el('p', 'pr-empty', myPrsEmptyStateText(myPrsSnapshot().status))];
}

function syncTeamChip(): void {
  if (!teamChipSlot) return;
  const team = teamReviewStatusView()?.team;
  if (!team) {
    teamChipSlot.replaceChildren();
    return;
  }
  const chip = el('span', 'pr-team-chip');
  chip.append(createAvatar({ login: team.slug, url: team.avatarUrl, cssPx: 16 }), el('span', null, team.name));
  teamChipSlot.replaceChildren(chip);
}

function rowsSignature(visibleGroups: readonly QueueGroup[], sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): string {
  return JSON.stringify([visibleGroups, [...sessionsByPrKey], selectedKey, filter, isSetAsideOpen, unseenSignature, queueNoticeElements().map((notice) => notice.textContent)], (key, value) => (key === 'recentSteps' ? undefined : value));
}

function render(): void {
  if (!queueElement) return;
  const { prs, sessionsByPrKey, status: myPrsStatus } = myPrsSnapshot();
  currentGroups = buildReviewQueue(teamReviewSections(), prs, new Set(sessionsByPrKey.keys()));
  refreshActivity();
  syncTeamChip();
  pollingControls?.update(combinedPollingStatus([teamReviewStatusView(), myPrsStatus]));
  const visibleGroups = filterQueue(currentGroups, filter);
  if (!isCaughtUp) selectedKey = chooseQueueSelection(visibleGroups, selectedKey);
  paintBanner();
  const signature = rowsSignature(visibleGroups, sessionsByPrKey);
  if (signature !== renderedSignature) {
    renderedSignature = signature;
    const focusedKey = document.activeElement instanceof HTMLElement && queueElement.contains(document.activeElement) ? document.activeElement.dataset.queueKey : undefined;
    resetTeamQueueTickers();
    rowsByKey.clear();
    const hasMultipleRepos = spansMultipleRepos(currentGroups);
    const sections = visibleGroups.filter((group) => group.items.length > 0).map((group) => createGroupSection(group, hasMultipleRepos, sessionsByPrKey));
    queueElement.replaceChildren(...queueNoticeElements(), ...(sections.length > 0 ? sections : emptyQueueElements()));
    if (focusedKey) rowsByKey.get(focusedKey)?.focus({ preventScroll: true });
    refreshTeamReviewAges();
  }
  if (selectedKey !== shownKey || isCaughtUp) showSelectedDetail('keep');
}

function queueRender(): void {
  if (isRenderQueued) return;
  isRenderQueued = true;
  queueMicrotask(() => {
    isRenderQueued = false;
    render();
  });
}

export function mountReviewQueue(parent: HTMLElement, queueNavigation?: ReviewQueueNavigation): void {
  navigation = queueNavigation ?? null;
  if (root) return;
  root = el('div', 'pr-content review-queue');
  parent.append(root);
  filterTabs = createPrScopeTabs({
    label: 'Show reviews', scopes: QUEUE_FILTERS, selected: filter,
    onSelect: (scope) => {
      filter = scope;
      render();
    },
  });
  const shell = createPrQueueColumns({ queueLabel: 'Review queue', scopeTabs: filterTabs.element, resizerLabel: 'Resize review queue' });
  queueElement = shell.queue;
  detailHost = shell.detail;
  banner = buildAttentionBanner({
    onJump: () => {
      jumpToNextReview();
    },
    rowFor: (id) => rowsByKey.get(id),
  }, buildNextAttentionKeys());
  banner.classList.add('review-queue-banner');
  shell.queue.before(banner);
  pollingControls = createGithubPollingControls(['team-review', 'my-prs'], root);
  teamChipSlot = el('span', 'review-team-chip-slot');
  shell.foot.append(teamChipSlot, pollingControls.control);
  root.append(shell.columns);
  teamDetail = mountTeamReviewDetail(root, {
    onChange: queueRender,
    captureTurnOrder: () => turnItems(currentGroups).map((item) => item.key),
    onAdvance: advanceAfterAction,
  }, queueNavigation);
  mineDetail = mountMyPrsDetail({ onChange: queueRender }, queueNavigation);
  render();
}
