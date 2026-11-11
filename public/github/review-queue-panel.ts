import './review-queue-panel.css';
import { createPressable } from '../ui/pressable.ts';
import { button } from '../ui/button.ts';
import { createAvatar, el, isPanelHidden, isRealInputOwningKey } from '../dom-helpers.ts';
import { pullRequestLabel } from './github-store-core.ts';
import { EASE_OUT_EXPO, canAnimate, eased, prefersReducedMotion } from '../attention-banner.ts';
import { isModalOpen } from '../session-card/modal.ts';
import { buildNextAttentionKeys } from '../shortcuts.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { createGithubPollingControls, createMyPrQueueRow, mountMyPrsDetail, repaintSessionPills, showMyPr } from './my-prs-panel.ts';
import { myPrsSnapshot } from './my-prs-store.ts';
import type { LinkedLiveSession } from './my-prs-view-core.ts';
import { emptyStateText as myPrsEmptyStateText, queueNotices as myPrsQueueNotices } from './my-prs-view-core.ts';
import { createPrQueueColumns } from './pr-queue-columns.ts';
import { createReviewBoard } from './review-queue-board.ts';
import { onLayoutChange } from '../form-factor.ts';
import { getReviewsBoardDetailWidth, getReviewsCardOrder, getReviewsLayout, getReviewsPulledKeys, getReviewsTurnLimit, setReviewsBoardDetailWidth, setReviewsCardOrder, setReviewsLayout, setReviewsPulledKeys } from '../ui-prefs.ts';
import type { ReviewsLayout } from '../ui-prefs.ts';
import { createReviewSetupCard } from './review-setup-card.ts';
import { createReviewSkillNotice } from './review-skill-notice.ts';
import { subscribeSettings } from '../settings/settings-store.ts';
import {
  COLLAPSED_GROUP_IDS, ageToneOf, boardDropLaneIds, boardDropOf, caughtUpText, chooseQueueSelection, combinedPollingStatus, nextTurnKey,
  isOverTurnLimit, orderDisplayGroups, placeCardBefore, shownTurnKeys, queueItemActivityEntry, queueItemByKey, queueItemWaitStartMs, reviewKeyActionOf, reviewingNowCountText, spansMultipleRepos, splitReviewingNow, steppedColumnKey, steppedRowKey,
  togglePulledKey, turnItems, turnPositionText,
} from './review-queue-core.ts';
import type { DisplayGroup, DisplayGroupId, QueueGroup, QueueItem, ReviewKeyAction } from './review-queue-core.ts';
import {
  attachReviewQueueView, hasBothLanes, isQueueEntryUnseen, markQueueEntrySeen, rebuildReviewQueue, returnToReviewQueue, reviewQueueNavigation, reviewQueueUnseenSignature, setReviewDetailScreenOpen,
  subscribeReviewQueue, takePendingReveal,
} from './review-queue-store.ts';
import type { ReviewQueueChange } from './review-queue-store.ts';
import { createCaughtUpBanner, createTeamQueueRow, paintQueueRowTitle } from './team-review-queue-row.ts';
import {
  mountTeamReviewDetail, refreshTeamReviewAges, releaseTeamReviewSelection, resetTeamQueueTickers, runTeamReviewKey, showTeamReview, takePostedReceipt, teamReviewEmptyState,
  teamReviewLaneNotices,
} from './team-review-panel.ts';
import { teamReviewSections, teamReviewStatusView } from './team-review-store.ts';

let root: HTMLElement | null = null;
let queueElement: HTMLElement | null = null;
let detailHost: HTMLElement | null = null;
let turnPosition: HTMLElement | null = null;
let teamDetail: HTMLElement | null = null;
let mineDetail: HTMLElement | null = null;
let pollingControls: ReturnType<typeof createGithubPollingControls> | null = null;
let setupCard: ReturnType<typeof createReviewSetupCard> | null = null;
let skillNotice: ReturnType<typeof createReviewSkillNotice> | null = null;
let currentGroups: QueueGroup[] = [];
let displayGroups: DisplayGroup[] = [];
let selectedKey: string | null = null;
let shownKey: string | null | undefined;
let isCaughtUp = false;
const openCollapsedGroupIds = new Set<string>();
let renderedSignature: string | null = null;
let isRenderQueued = false;
let caughtUpReceipt: string | null = null;
let justActedKey: string | null = null;
let justActedTimer = 0;
const JUST_ACTED_MS = 2000;
const rowsByKey = new Map<string, HTMLButtonElement>();
const REVIEWS_LAYOUT_LABELS: Readonly<Record<ReviewsLayout, string>> = { list: 'List', board: 'Board' };

function shownLayout(): ReviewsLayout {
  if (document.documentElement.dataset.layout === 'phone') return 'list';
  return getReviewsLayout();
}

function isBoardShown(): boolean {
  return root?.dataset.reviewsLayout === 'board';
}

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
  if (turnPosition) turnPosition.textContent = turnPositionText(displayGroups, selectedKey);
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

function settledTeamKeys(): Set<string> {
  return new Set(teamReviewSections().noReviewNeeded.map((draft) => `team:${draft.key}`));
}

function heldTeamReviewKey(): string | null {
  if (selectedKey === null || !settledTeamKeys().has(selectedKey)) return null;
  return selectedKey.slice('team:'.length);
}

function showSelectedDetail(receiptMode: 'keep' | 'clear'): void {
  const item = queueItemByKey(currentGroups, selectedKey);
  const heldReviewKey = item ? null : heldTeamReviewKey();
  if (heldReviewKey !== null && teamDetail) {
    shownKey = selectedKey;
    showTeamReview(heldReviewKey, receiptMode);
    swapDetail(teamDetail);
    return;
  }
  const isSwitchingReview = shownKey !== null && item !== null && item.key !== shownKey;
  shownKey = item?.key ?? null;
  if (isSwitchingReview) fadeInDetail();
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
  moveOutlineTo(key);
  for (const [rowKey, row] of rowsByKey) row.setAttribute('aria-current', String(rowKey === key));
  const item = queueItemByKey(currentGroups, key);
  const row = rowsByKey.get(key);
  if (item && row) markSeen(item, row);
  showSelectedDetail('clear');
  paintTurnPosition();
  setDetailScreenOpen(true);
  if (isFromQueue && document.documentElement.dataset.layout === 'phone') detailHost?.parentElement?.scrollIntoView({ block: 'start' });
}

function revealItem(key: string): void {
  const item = queueItemByKey(currentGroups, key);
  if (!item) return;
  const revealedGroupId = currentGroups.find((group) => group.items.includes(item))?.id;
  if (revealedGroupId && COLLAPSED_GROUP_IDS.has(revealedGroupId)) openCollapsedGroupIds.add(revealedGroupId);
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

function boardColumnRowKeys(): string[][] {
  if (!queueElement) return [];
  return [...queueElement.querySelectorAll('.review-board-column')].map((column) =>
    [...column.querySelectorAll<HTMLElement>('[data-queue-key]')].map((row) => row.dataset.queueKey ?? ''));
}

function stepColumn(step: 1 | -1): boolean {
  if (!isBoardShown()) return false;
  const nextKey = steppedColumnKey(boardColumnRowKeys(), selectedKey, step);
  if (!nextKey) return false;
  if (nextKey !== selectedKey) revealItem(nextKey);
  return true;
}

function movePulled(queueKey: string, shouldBePulled: boolean): boolean {
  const turnKeys = turnItems(currentGroups).map((item) => item.key);
  if (!turnKeys.includes(queueKey)) return false;
  const pulledKeys = getReviewsPulledKeys();
  if (pulledKeys.includes(queueKey) === shouldBePulled) return true;
  const nextPulledKeys = togglePulledKey({ pulledKeys, key: queueKey, turnKeys, limit: getReviewsTurnLimit() });
  if (nextPulledKeys.length === pulledKeys.length) return true;
  setReviewsPulledKeys(nextPulledKeys);
  renderedSignature = null;
  render();
  rowsByKey.get(queueKey)?.focus({ preventScroll: true });
  return true;
}

function dropCardOnLane(queueKey: string, targetGroupId: DisplayGroupId): void {
  const sourceGroup = displayGroups.find((group) => group.items.some((item) => item.key === queueKey));
  const item = sourceGroup?.items.find((groupItem) => groupItem.key === queueKey);
  if (!sourceGroup || !item) return;
  const drop = boardDropOf(item, sourceGroup.id, targetGroupId);
  if (!drop) return;
  if (drop.kind === 'pull') {
    movePulled(queueKey, drop.shouldBePulled);
    return;
  }
  selectItem(queueKey, { isFromQueue: true });
  detailHost?.querySelector<HTMLButtonElement>(`button[data-action="${drop.action}"]:not(:disabled)`)?.click();
}

function reorderCard(queueKey: string, groupId: DisplayGroupId, beforeQueueKey: string | null): void {
  const columnKeys = displayGroups.find((group) => group.id === groupId)?.items.map((item) => item.key) ?? [];
  setReviewsCardOrder(placeCardBefore({ cardOrder: getReviewsCardOrder(), columnKeys, key: queueKey, beforeKey: beforeQueueKey }));
  renderedSignature = null;
  render();
  rowsByKey.get(queueKey)?.focus({ preventScroll: true });
}

function toggleSelectedPulled(): boolean {
  if (!selectedKey) return false;
  return movePulled(selectedKey, !getReviewsPulledKeys().includes(selectedKey));
}

function runReviewKey(action: ReviewKeyAction): boolean {
  if (action === 'next-row') return stepSelection(1);
  if (action === 'previous-row') return stepSelection(-1);
  if (action === 'toggle-pulled') return toggleSelectedPulled();
  if (action === 'next-column') return stepColumn(1);
  if (action === 'previous-column') return stepColumn(-1);
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
  const focused = document.activeElement;
  const isArrowOwnedByFocus = event.key.startsWith('Arrow') && (focused instanceof HTMLSelectElement || (focused instanceof Node && detailHost?.contains(focused) === true));
  if (isArrowOwnedByFocus) return;
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
  const mineRow = createMyPrQueueRow(item.pr, item.stackRow, sessionsByPrKey.get(item.prKey));
  return { container: mineRow.group, row: mineRow.row };
}

function itemAgeTone(item: QueueItem, groupId: DisplayGroupId) {
  return ageToneOf(groupId, queueItemWaitStartMs(item), Date.now());
}

function hideChipEchoingGroupTitle(row: HTMLElement, groupTitle: string): void {
  const stateChip = row.querySelector('.pr-queue-bottom > .my-pr-stage');
  if (stateChip?.textContent === groupTitle) stateChip.remove();
}

function createItemRow(item: QueueItem, group: DisplayGroup, hasMultipleRepos: boolean, sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): HTMLElement {
  const isTurn = group.id === 'turn' || group.id === 'now';
  const { container, row } = rowFor(item, hasMultipleRepos, sessionsByPrKey);
  hideChipEchoingGroupTitle(row, group.title);
  const ageTone = itemAgeTone(item, group.id);
  if (ageTone) row.dataset.ageTone = ageTone;
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

function tileIdentity(item: QueueItem): { label: string; author: string | null } {
  if (item.source === 'team') return { label: pullRequestLabel(item.review.repo, item.review.number), author: item.review.author };
  return { label: pullRequestLabel(item.pr.repo, item.pr.number), author: myPrsSnapshot().status?.viewer ?? null };
}

function createItemTile(item: QueueItem, groupId: DisplayGroupId): HTMLElement {
  const tile = createPressable('pr-queue-tile');
  const { label, author } = tileIdentity(item);
  tile.setAttribute('aria-label', author ? `${label} by ${author}` : label);
  if (author) tile.append(createAvatar({ login: author, cssPx: 24 }));
  tile.append(el('span', 'pr-queue-tile-number', `#${label.slice(label.lastIndexOf('#') + 1)}`));
  const ageTone = itemAgeTone(item, groupId);
  if (ageTone) tile.dataset.ageTone = ageTone;
  tile.dataset.queueKey = item.key;
  tile.setAttribute('aria-current', String(item.key === selectedKey));
  if (item.key === justActedKey) tile.dataset.justActed = 'true';
  tile.addEventListener('click', () => selectItem(item.key, { isFromQueue: true }));
  rowsByKey.set(item.key, tile);
  return tile;
}

const CARD_MOVE_MS = 480;
const CARD_ARRIVE_MS = 480;
const CARD_LEAVE_MS = 200;
const SELECTION_SLIDE_MS = 250;
const DETAIL_FADE_MS = 250;
const MIN_MOVE_PX = 1;

type RowSnapshot = { rect: DOMRect; element: HTMLElement };
const runningQueueAnimations = new Set<Animation>();
const leavingGhosts = new Set<HTMLElement>();
let outlinedKey: string | null = null;
let motionLayout: string | null = null;

function isQueueMotionOn(): boolean {
  return queueElement !== null && !prefersReducedMotion() && canAnimate(queueElement);
}

function trackAnimation(animation: Animation): void {
  runningQueueAnimations.add(animation);
  animation.addEventListener('finish', () => runningQueueAnimations.delete(animation));
  animation.addEventListener('cancel', () => runningQueueAnimations.delete(animation));
}

function finishQueueMotion(): void {
  for (const animation of [...runningQueueAnimations]) animation.finish();
  runningQueueAnimations.clear();
  for (const ghost of leavingGhosts) ghost.remove();
  leavingGhosts.clear();
}

function snapshotRows(): Map<string, RowSnapshot> {
  const snapshots = new Map<string, RowSnapshot>();
  if (!isQueueMotionOn() || motionLayout !== shownLayout()) return snapshots;
  for (const [key, row] of rowsByKey) {
    if (row.isConnected) snapshots.set(key, { rect: row.getBoundingClientRect(), element: row });
  }
  return snapshots;
}

function flyLeavingRow({ rect, element }: RowSnapshot): void {
  const ghostRow = element.cloneNode(true);
  const ghostHost = element.parentElement?.cloneNode(false);
  if (!queueElement || !(ghostRow instanceof HTMLElement) || !(ghostHost instanceof HTMLElement)) return;
  ghostHost.removeAttribute('id');
  ghostHost.classList.add('review-motion-ghost');
  Object.assign(ghostHost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
  ghostHost.append(ghostRow);
  queueElement.append(ghostHost);
  leavingGhosts.add(ghostHost);
  const leave = ghostHost.animate(eased([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.96)' }]), { duration: CARD_LEAVE_MS, fill: 'forwards' });
  trackAnimation(leave);
  leave.addEventListener('finish', () => {
    leavingGhosts.delete(ghostHost);
    ghostHost.remove();
  });
}

function slideSelectionOutline(fromRect: DOMRect, toRow: HTMLElement, toRect: DOMRect): void {
  const ghost = el('div', 'review-selection-ghost');
  Object.assign(ghost.style, { left: `${toRect.left}px`, top: `${toRect.top}px`, width: `${toRect.width}px`, height: `${toRect.height}px` });
  document.body.append(ghost);
  leavingGhosts.add(ghost);
  toRow.dataset.selectionArriving = 'true';
  const scaleX = fromRect.width / Math.max(toRect.width, 1);
  const scaleY = fromRect.height / Math.max(toRect.height, 1);
  const slide = ghost.animate(eased([
    { transform: `translate(${fromRect.left - toRect.left}px, ${fromRect.top - toRect.top}px) scale(${scaleX}, ${scaleY})` },
    { transform: 'none' },
  ]), { duration: SELECTION_SLIDE_MS });
  trackAnimation(slide);
  const land = () => {
    delete toRow.dataset.selectionArriving;
    leavingGhosts.delete(ghost);
    ghost.remove();
  };
  slide.addEventListener('finish', land);
  slide.addEventListener('cancel', land);
}

function playRowMotion(before: ReadonlyMap<string, RowSnapshot>): void {
  if (before.size === 0 || !isQueueMotionOn()) return;
  const afterRects = new Map([...rowsByKey].map(([key, row]) => [key, row.getBoundingClientRect()]));
  for (const [key, row] of rowsByKey) {
    const fromRect = before.get(key)?.rect;
    const toRect = afterRects.get(key);
    if (!toRect) continue;
    if (!fromRect) {
      trackAnimation(row.animate(eased([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }]), { duration: CARD_ARRIVE_MS }));
      continue;
    }
    const deltaX = fromRect.left - toRect.left;
    const deltaY = fromRect.top - toRect.top;
    if (Math.abs(deltaX) + Math.abs(deltaY) < MIN_MOVE_PX) continue;
    trackAnimation(row.animate(eased([{ transform: `translate(${deltaX}px, ${deltaY}px)` }, { transform: 'none' }]), { duration: CARD_MOVE_MS }));
  }
  for (const [key, snapshot] of before) {
    if (!rowsByKey.has(key)) flyLeavingRow(snapshot);
  }
  const fromSelectedRect = outlinedKey ? before.get(outlinedKey)?.rect : undefined;
  const toSelectedRow = selectedKey ? rowsByKey.get(selectedKey) : undefined;
  const toSelectedRect = selectedKey ? afterRects.get(selectedKey) : undefined;
  if (outlinedKey !== selectedKey && fromSelectedRect && toSelectedRow && toSelectedRect && rowsByKey.has(outlinedKey ?? '')) slideSelectionOutline(fromSelectedRect, toSelectedRow, toSelectedRect);
}

function moveOutlineTo(key: string): void {
  const fromRow = outlinedKey ? rowsByKey.get(outlinedKey) : undefined;
  const toRow = rowsByKey.get(key);
  const isMove = outlinedKey !== key && fromRow?.isConnected === true && toRow?.isConnected === true && isQueueMotionOn();
  if (isMove && fromRow && toRow) {
    finishQueueMotion();
    slideSelectionOutline(fromRow.getBoundingClientRect(), toRow, toRow.getBoundingClientRect());
  }
  outlinedKey = key;
}

function fadeInDetail(): void {
  if (!detailHost || prefersReducedMotion() || !canAnimate(detailHost)) return;
  detailHost.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DETAIL_FADE_MS, easing: EASE_OUT_EXPO });
}

function toggleCollapsedGroup(groupId: string): void {
  if (openCollapsedGroupIds.delete(groupId)) return;
  openCollapsedGroupIds.add(groupId);
}

function createGroupCount(group: DisplayGroup): HTMLElement {
  if (group.id !== 'now') return el('span', 'review-group-count', String(group.items.length));
  const turnLimit = getReviewsTurnLimit();
  const count = el('span', 'review-group-count', reviewingNowCountText(group.items.length, turnLimit));
  if (isOverTurnLimit(group.items.length, turnLimit)) count.dataset.over = 'true';
  return count;
}

function headingExtrasOf(group: DisplayGroup): HTMLElement[] {
  return group.id === 'turn' ? [buildNextAttentionKeys()] : [];
}

function createGroupHeading(group: DisplayGroup): HTMLElement {
  const heading = el('h3', 'pr-section-heading review-group-heading');
  const count = createGroupCount(group);
  if (group.id === 'turn' || group.id === 'now') {
    heading.append(el('span', null, group.title), count, ...headingExtrasOf(group));
    return heading;
  }
  if (!COLLAPSED_GROUP_IDS.has(group.id)) {
    heading.append(el('span', null, group.title), count);
    return heading;
  }
  const toggle = createPressable('review-group-toggle');
  const chevron = el('span', 'review-group-chevron', String.fromCharCode(0x25b8));
  chevron.setAttribute('aria-hidden', 'true');
  toggle.append(chevron, group.title);
  toggle.setAttribute('aria-expanded', String(openCollapsedGroupIds.has(group.id)));
  toggle.addEventListener('click', () => {
    toggleCollapsedGroup(group.id);
    renderedSignature = null;
    render();
  });
  heading.append(toggle, count);
  return heading;
}

function createGroupSection(group: DisplayGroup, hasMultipleRepos: boolean, sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): HTMLElement {
  const section = el('section', 'pr-queue-section');
  section.dataset.group = group.id;
  section.append(createGroupHeading(group));
  if (COLLAPSED_GROUP_IDS.has(group.id) && !openCollapsedGroupIds.has(group.id)) return section;
  if (group.id === 'parked') {
    const tiles = el('div', 'pr-queue-tiles');
    tiles.append(...group.items.map((item) => createItemTile(item, group.id)));
    section.append(tiles);
    return section;
  }
  for (const item of group.items) section.append(createItemRow(item, group, hasMultipleRepos, sessionsByPrKey));
  return section;
}

function queueNoticeElements(): HTMLElement[] {
  const mineNotices = myPrsQueueNotices(myPrsSnapshot().status, Date.now()).filter((notice) => notice.tone !== 'error').map((notice) => el('p', 'my-pr-note', notice.text));
  return [...(pollingControls ? [pollingControls.notice] : []), ...teamReviewLaneNotices(), ...mineNotices];
}

function emptyQueueElements(): HTMLElement[] {
  return [teamReviewEmptyState(), el('p', 'pr-empty', myPrsEmptyStateText(myPrsSnapshot().status))];
}

function rowsSignature(groups: readonly DisplayGroup[], sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): string {
  const ageTones = groups.flatMap((group) => group.items.map((item) => itemAgeTone(item, group.id)));
  return JSON.stringify([shownLayout(), getReviewsTurnLimit(), ageTones, groups, [...sessionsByPrKey], selectedKey, [...openCollapsedGroupIds], reviewQueueUnseenSignature(), queueNoticeElements().map((notice) => notice.textContent)], (key, value) => (key === 'recentSteps' ? undefined : value));
}

function createBoard(hasMultipleRepos: boolean, sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): HTMLElement {
  const hasReadyItems = turnItems(currentGroups).length > 0;
  return createReviewBoard(displayGroups, {
    createCard: (item, group) => createItemRow(item, group, hasMultipleRepos, sessionsByPrKey),
    createTile: (item, group) => createItemTile(item, group.id),
    createCount: createGroupCount,
    createHeadingExtras: headingExtrasOf,
    dropHintOf: (group) => (group.id === 'now' && hasReadyItems ? 'Drag a Ready card here, or select one and press M.' : null),
    isParkedOpen: openCollapsedGroupIds.has('parked'),
    onToggleParked: () => {
      toggleCollapsedGroup('parked');
      renderedSignature = null;
      render();
    },
    dropLaneIdsOf: (item, group) => boardDropLaneIds(item, group.id),
    onDropCard: dropCardOnLane,
    onReorderCard: reorderCard,
  });
}

function queueContent(hasMultipleRepos: boolean, sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): HTMLElement[] {
  const hasItems = currentGroups.some((group) => group.items.length > 0);
  if (isBoardShown()) return [...(hasItems ? [] : emptyQueueElements()), createBoard(hasMultipleRepos, sessionsByPrKey)];
  if (!hasItems) return emptyQueueElements();
  return displayGroups.filter((group) => group.items.length > 0).map((group) => createGroupSection(group, hasMultipleRepos, sessionsByPrKey));
}

function syncLayout(): void {
  if (!root) return;
  const layout = shownLayout();
  root.dataset.reviewsLayout = layout;
  for (const option of root.querySelectorAll<HTMLButtonElement>('.review-layout-option')) option.setAttribute('aria-pressed', String(option.dataset.reviewsLayout === layout));
}

function chooseLayout(layout: ReviewsLayout): void {
  if (getReviewsLayout() === layout) return;
  setReviewsLayout(layout);
  renderedSignature = null;
  render();
}

function createLayoutSwitch(): HTMLElement {
  const group = el('div', 'review-layout-switch');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Reviews layout');
  for (const layout of ['list', 'board'] as const) {
    const option = createPressable('review-layout-option', REVIEWS_LAYOUT_LABELS[layout]);
    option.dataset.reviewsLayout = layout;
    option.addEventListener('click', () => chooseLayout(layout));
    group.append(option);
  }
  return group;
}

function syncSetupCard(): boolean {
  const isSetupNeeded = teamReviewStatusView()?.configured === false && myPrsSnapshot().status?.configured !== true;
  if (!root || !setupCard) return isSetupNeeded;
  const wasSetupShown = root.dataset.setup === 'true';
  root.dataset.setup = String(isSetupNeeded);
  setupCard.element.hidden = !isSetupNeeded;
  if (isSetupNeeded && !wasSetupShown) void setupCard.load();
  return isSetupNeeded;
}

function splitDisplayGroups(): void {
  const storedPulledKeys = getReviewsPulledKeys();
  const split = splitReviewingNow(currentGroups, storedPulledKeys);
  const storedCardOrder = getReviewsCardOrder();
  const ordered = orderDisplayGroups(split.groups, storedCardOrder);
  displayGroups = ordered.groups;
  if (!hasBothLanes()) return;
  if (split.pulledKeys.length !== storedPulledKeys.length) setReviewsPulledKeys(split.pulledKeys);
  if (ordered.cardOrder.length !== storedCardOrder.length) setReviewsCardOrder(ordered.cardOrder);
}

function render(): void {
  if (!queueElement) return;
  skillNotice?.sync();
  if (syncSetupCard()) return;
  syncLayout();
  const { sessionsByPrKey, status: myPrsStatus } = myPrsSnapshot();
  currentGroups = rebuildReviewQueue();
  splitDisplayGroups();
  pollingControls?.update(combinedPollingStatus([teamReviewStatusView(), myPrsStatus]));
  if (!isCaughtUp) selectedKey = chooseQueueSelection(displayGroups, selectedKey, settledTeamKeys());
  paintTurnPosition();
  const signature = rowsSignature(displayGroups, sessionsByPrKey);
  if (signature !== renderedSignature) {
    renderedSignature = signature;
    const focusedKey = document.activeElement instanceof HTMLElement && queueElement.contains(document.activeElement) ? document.activeElement.dataset.queueKey : undefined;
    resetTeamQueueTickers();
    finishQueueMotion();
    const rowsBefore = snapshotRows();
    const boardScrollLeft = queueElement.querySelector('.review-board')?.scrollLeft ?? 0;
    rowsByKey.clear();
    const hasMultipleRepos = spansMultipleRepos(currentGroups);
    queueElement.replaceChildren(...queueNoticeElements(), ...queueContent(hasMultipleRepos, sessionsByPrKey));
    const rebuiltBoard = queueElement.querySelector('.review-board');
    if (rebuiltBoard) rebuiltBoard.scrollLeft = boardScrollLeft;
    if (focusedKey) rowsByKey.get(focusedKey)?.focus({ preventScroll: true });
    playRowMotion(rowsBefore);
    outlinedKey = selectedKey;
    motionLayout = shownLayout();
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
  const shell = createPrQueueColumns({
    queueLabel: 'Review queue',
    scopeTabs: null,
    resizerLabel: 'Resize review queue',
    detailResizer: { label: 'Resize review detail', getStoredWidth: getReviewsBoardDetailWidth, setStoredWidth: setReviewsBoardDetailWidth },
  });
  queueElement = shell.queue;
  detailHost = el('div', 'review-queue-detail');
  const phoneBar = el('div', 'review-queue-phone-bar');
  const back = button({ variant: 'secondary', label: 'Back to queue', action: 'back-to-queue', onClick: returnToReviewQueue });
  turnPosition = el('span', 'review-queue-position');
  phoneBar.append(back, turnPosition);
  shell.detail.append(phoneBar, detailHost);
  skillNotice = createReviewSkillNotice();
  shell.queue.before(skillNotice.element);
  pollingControls = createGithubPollingControls(['team-review', 'my-prs'], root);
  shell.foot.append(pollingControls.control, createLayoutSwitch());
  setupCard = createReviewSetupCard();
  setupCard.element.hidden = true;
  root.append(setupCard.element, shell.columns);
  root.dataset.detailOpen = 'false';
  teamDetail = mountTeamReviewDetail(root, {
    onChange: queueRender,
    captureTurnOrder: () => shownTurnKeys(displayGroups),
    onAdvance: advanceAfterAction,
  }, queueNavigation);
  mineDetail = mountMyPrsDetail({ onChange: queueRender }, queueNavigation);
  attachReviewQueueView({ isLooking: () => !isPanelHidden(root), selectedKey: () => selectedKey });
  subscribeReviewQueue(applyReviewQueueChange);
  subscribeSettings((change) => { if (change.kind === 'broadcast') skillNotice?.sync(); });
  document.addEventListener('keydown', onReviewKey);
  onLayoutChange(() => render());
  render();
  revealPendingItem();
}

function refreshReviewQueue(): void {
  repaintSessionPills();
  queueRender();
}

export const view: ViewModule<HTMLElement> = { mount: mountReviewQueue, refresh: refreshReviewQueue };
