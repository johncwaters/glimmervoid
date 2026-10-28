import './review-queue-panel.css';
import { buildAttentionBanner, paintAttentionBanner } from '../attention-banner.ts';
import { createAvatar, el, isPanelHidden, isRealInputOwningKey } from '../dom-helpers.ts';
import { isModalOpen } from '../session-card/modal.ts';
import { buildNextAttentionKeys } from '../shortcuts.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { createGithubPollingControls, createMyPrQueueRow, mountMyPrsDetail, showMyPr } from './my-prs-panel.ts';
import { myPrsSnapshot } from './my-prs-store.ts';
import type { LinkedLiveSession } from './my-prs-view-core.ts';
import { emptyStateText as myPrsEmptyStateText, queueNotices as myPrsQueueNotices } from './my-prs-view-core.ts';
import { createPrQueueColumns } from './pr-queue-columns.ts';
import { createPrScopeTabs } from './pr-scope-tabs.ts';
import {
  QUEUE_FILTERS, attentionCountsOf, attentionTilesOf, bannerTilesOf, caughtUpText, chooseQueueSelection, combinedPollingStatus, filterQueue, nextTurnKey,
  queueItemActivityEntry, queueItemByKey, reviewKeyActionOf, spansMultipleRepos, steppedRowKey, turnItems, turnPositionText,
} from './review-queue-core.ts';
import type { QueueFilter, QueueGroup, QueueItem, ReviewKeyAction } from './review-queue-core.ts';
import {
  attachReviewQueueView, isQueueEntryUnseen, jumpToNextReview, markQueueEntrySeen, rebuildReviewQueue, returnToReviewQueue, reviewQueueNavigation, reviewQueueUnseenSignature, setReviewDetailScreenOpen,
  subscribeReviewQueue, takePendingReveal,
} from './review-queue-store.ts';
import type { ReviewQueueChange } from './review-queue-store.ts';
import {
  createCaughtUpBanner, createTeamQueueRow, mountTeamReviewDetail, paintQueueRowTitle, refreshTeamReviewAges, releaseTeamReviewSelection, resetTeamQueueTickers, runTeamReviewKey, showTeamReview, takePostedReceipt, teamReviewEmptyState,
  teamReviewLaneNotices,
} from './team-review-panel.ts';
import { teamReviewStatusView } from './team-review-store.ts';

let root: HTMLElement | null = null;
let queueElement: HTMLElement | null = null;
let detailHost: HTMLElement | null = null;
let banner: HTMLElement | null = null;
let turnPosition: HTMLElement | null = null;
let teamChipSlot: HTMLElement | null = null;
let teamDetail: HTMLElement | null = null;
let mineDetail: HTMLElement | null = null;
let filterTabs: ReturnType<typeof createPrScopeTabs<QueueFilter>> | null = null;
let pollingControls: ReturnType<typeof createGithubPollingControls> | null = null;
let currentGroups: QueueGroup[] = [];
let filter: QueueFilter = 'all';
let selectedKey: string | null = null;
let shownKey: string | null | undefined;
let isCaughtUp = false;
let isSetAsideOpen = false;
let renderedSignature: string | null = null;
let isRenderQueued = false;
let caughtUpReceipt: string | null = null;
let justActedKey: string | null = null;
let justActedTimer = 0;
const JUST_ACTED_MS = 2000;
const rowsByKey = new Map<string, HTMLButtonElement>();

function markSeen(item: QueueItem, row: HTMLButtonElement): void {
  if (!markQueueEntrySeen(queueItemActivityEntry(item))) return;
  row.querySelector('.pr-queue-unseen')?.remove();
  delete row.dataset.unseen;
  if (item.source === 'team') paintQueueRowTitle(row);
}

function setDetailScreenOpen(isOpen: boolean): void {
  if (root) root.dataset.detailOpen = String(isOpen);
  setReviewDetailScreenOpen(isOpen);
}

function returnToQueue(): void {
  setDetailScreenOpen(false);
  if (selectedKey) rowsByKey.get(selectedKey)?.focus({ preventScroll: true });
}

function paintTurnPosition(): void {
  if (turnPosition) turnPosition.textContent = turnPositionText(currentGroups, selectedKey);
}

function swapDetail(element: HTMLElement): void {
  if (!detailHost || (detailHost.childElementCount === 1 && detailHost.firstElementChild === element)) return;
  detailHost.replaceChildren(element);
}

function caughtUpElement(receipt: string | null): HTMLElement {
  const hasNewTurn = turnItems(currentGroups).length > 0;
  const receiptLead = receipt ? `${receipt} ` : '';
  if (hasNewTurn) return createCaughtUpBanner({ title: 'New pull requests need you', detail: `${receiptLead}Pick one from the queue.` });
  return createCaughtUpBanner({ title: 'All caught up', detail: `${receiptLead}${caughtUpText(currentGroups)}` });
}

function showSelectedDetail(receiptMode: 'keep' | 'clear'): void {
  const item = queueItemByKey(currentGroups, selectedKey);
  shownKey = item?.key ?? null;
  if (!item) {
    caughtUpReceipt = takePostedReceipt() ?? caughtUpReceipt;
    releaseTeamReviewSelection();
    if (detailHost) detailHost.replaceChildren(isCaughtUp ? caughtUpElement(caughtUpReceipt) : el('p', 'pr-empty', 'Pick a pull request from the queue.'));
    return;
  }
  if (item.source === 'team' && teamDetail) {
    showTeamReview(item.review.key, receiptMode);
    swapDetail(teamDetail);
    return;
  }
  if (item.source === 'mine' && mineDetail) {
    releaseTeamReviewSelection();
    showMyPr(item.pr.key);
    swapDetail(mineDetail);
  }
}

function selectItem(key: string, { isFromQueue }: { isFromQueue: boolean }): void {
  selectedKey = key;
  isCaughtUp = false;
  caughtUpReceipt = null;
  for (const [rowKey, row] of rowsByKey) row.setAttribute('aria-current', String(rowKey === key));
  const item = queueItemByKey(currentGroups, key);
  const row = rowsByKey.get(key);
  if (item && row) markSeen(item, row);
  showSelectedDetail('clear');
  paintBanner();
  setDetailScreenOpen(true);
  if (isFromQueue && document.documentElement.dataset.layout === 'phone') detailHost?.parentElement?.scrollIntoView({ block: 'start' });
}

function paintBanner(): void {
  paintTurnPosition();
  if (!banner) return;
  const tiles = bannerTilesOf(currentGroups, selectedKey);
  paintAttentionBanner(banner, attentionCountsOf(attentionTilesOf(currentGroups)), tiles);
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

function stepSelection(step: 1 | -1): boolean {
  const nextKey = steppedRowKey([...rowsByKey.keys()], selectedKey, step);
  if (!nextKey) return false;
  if (nextKey !== selectedKey) revealItem(nextKey);
  return true;
}

function runReviewKey(action: ReviewKeyAction): boolean {
  if (action === 'next-row') return stepSelection(1);
  if (action === 'previous-row') return stepSelection(-1);
  return runTeamReviewKey(action);
}

function isReviewNoteFocused(): boolean {
  return document.activeElement instanceof HTMLTextAreaElement && document.activeElement.classList.contains('pr-note-input');
}

function onReviewKey(event: KeyboardEvent): void {
  if (event.repeat || event.defaultPrevented || !root || isPanelHidden(root) || isModalOpen()) return;
  if (document.activeElement?.classList.contains('xterm-helper-textarea')) return;
  const action = reviewKeyActionOf(event);
  if (!action) return;
  const isNoteChord = (action === 'post' || action === 'cancel') && isReviewNoteFocused();
  if (isRealInputOwningKey(event) && !isNoteChord) return;
  if (runReviewKey(action)) event.preventDefault();
}

function markJustActed(queueKey: string): void {
  window.clearTimeout(justActedTimer);
  justActedKey = queueKey;
  justActedTimer = window.setTimeout(() => {
    justActedKey = null;
    rowsByKey.get(queueKey)?.removeAttribute('data-just-acted');
  }, JUST_ACTED_MS);
}

function advanceAfterAction(actedReviewKey: string, capturedOrder: readonly string[]): void {
  const actedKey = `team:${actedReviewKey}`;
  markJustActed(actedKey);
  const nextKey = nextTurnKey({ capturedOrder, actedKey, groups: currentGroups });
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
  if (item.key === justActedKey) row.dataset.justActed = 'true';
  const entry = queueItemActivityEntry(item);
  if (isTurn && isQueueEntryUnseen(entry)) {
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
  return JSON.stringify([visibleGroups, [...sessionsByPrKey], selectedKey, filter, isSetAsideOpen, reviewQueueUnseenSignature(), queueNoticeElements().map((notice) => notice.textContent)], (key, value) => (key === 'recentSteps' ? undefined : value));
}

function render(): void {
  if (!queueElement) return;
  const { sessionsByPrKey, status: myPrsStatus } = myPrsSnapshot();
  currentGroups = rebuildReviewQueue();
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

function revealPendingItem(): void {
  const key = takePendingReveal();
  if (key) revealItem(key);
}

function applyReviewQueueChange(change: ReviewQueueChange): void {
  if (change.kind === 'reveal') {
    revealPendingItem();
    return;
  }
  returnToQueue();
}

function mountReviewQueue(parent: HTMLElement): void {
  if (root) return;
  const queueNavigation = reviewQueueNavigation() ?? undefined;
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
  detailHost = el('div', 'review-queue-detail');
  const phoneBar = el('div', 'review-queue-phone-bar');
  const back = el('button', 'pr-action pr-action-ghost review-queue-back', 'Back to queue');
  back.type = 'button';
  back.addEventListener('click', returnToReviewQueue);
  turnPosition = el('span', 'review-queue-position');
  phoneBar.append(back, turnPosition);
  shell.detail.append(phoneBar, detailHost);
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
  root.dataset.detailOpen = 'false';
  teamDetail = mountTeamReviewDetail(root, {
    onChange: queueRender,
    captureTurnOrder: () => turnItems(currentGroups).map((item) => item.key),
    onAdvance: advanceAfterAction,
  }, queueNavigation);
  mineDetail = mountMyPrsDetail({ onChange: queueRender }, queueNavigation);
  attachReviewQueueView({ isLooking: () => !isPanelHidden(root), selectedKey: () => selectedKey });
  subscribeReviewQueue(applyReviewQueueChange);
  document.addEventListener('keydown', onReviewKey);
  render();
  revealPendingItem();
}

export const view: ViewModule<HTMLElement> = { mount: mountReviewQueue };
