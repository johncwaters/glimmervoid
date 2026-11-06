import './review-queue-panel.css';
import { createPressable } from '../ui/pressable.ts';
import { button } from '../ui/button.ts';
import { createAvatar, el, isPanelHidden, isRealInputOwningKey } from '../dom-helpers.ts';
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
import { getReviewsBoardDetailWidth, getReviewsLayout, getReviewsTurnLimit, setReviewsBoardDetailWidth, setReviewsLayout } from '../ui-prefs.ts';
import type { ReviewsLayout } from '../ui-prefs.ts';
import { createReviewSetupCard } from './review-setup-card.ts';
import { createReviewSkillNotice } from './review-skill-notice.ts';
import { subscribeSettings } from '../settings/settings-store.ts';
import {
  COLLAPSED_GROUP_IDS, ageToneOf, caughtUpText, chooseQueueSelection, combinedPollingStatus, nextTurnKey,
  isOverTurnLimit, queueItemActivityEntry, queueItemByKey, queueItemWaitStartMs, reviewKeyActionOf, spansMultipleRepos, steppedRowKey, turnItems, turnPositionText,
} from './review-queue-core.ts';
import type { QueueGroup, QueueGroupId, QueueItem, ReviewKeyAction } from './review-queue-core.ts';
import {
  attachReviewQueueView, isQueueEntryUnseen, markQueueEntrySeen, rebuildReviewQueue, returnToReviewQueue, reviewQueueNavigation, reviewQueueUnseenSignature, setReviewDetailScreenOpen,
  subscribeReviewQueue, takePendingReveal,
} from './review-queue-store.ts';
import type { ReviewQueueChange } from './review-queue-store.ts';
import { createCaughtUpBanner, createTeamQueueRow, paintQueueRowTitle } from './team-review-queue-row.ts';
import {
  mountTeamReviewDetail, refreshTeamReviewAges, releaseTeamReviewSelection, resetTeamQueueTickers, runTeamReviewKey, showTeamReview, takePostedReceipt, teamReviewEmptyState,
  teamReviewLaneNotices,
} from './team-review-panel.ts';
import { teamReviewStatusView } from './team-review-store.ts';

let root: HTMLElement | null = null;
let queueElement: HTMLElement | null = null;
let detailHost: HTMLElement | null = null;
let turnPosition: HTMLElement | null = null;
let teamChipSlot: HTMLElement | null = null;
let teamDetail: HTMLElement | null = null;
let mineDetail: HTMLElement | null = null;
let pollingControls: ReturnType<typeof createGithubPollingControls> | null = null;
let setupCard: ReturnType<typeof createReviewSetupCard> | null = null;
let skillNotice: ReturnType<typeof createReviewSkillNotice> | null = null;
let currentGroups: QueueGroup[] = [];
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

function isBoardDetailClosed(): boolean {
  return isBoardShown() && root?.dataset.detailOpen !== 'true';
}

function closeBoardDetail(): boolean {
  if (!isBoardShown() || isBoardDetailClosed()) return false;
  returnToQueue();
  return true;
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

function runReviewKey(action: ReviewKeyAction): boolean {
  if (action === 'next-row') return stepSelection(1);
  if (action === 'previous-row') return stepSelection(-1);
  if (isBoardDetailClosed()) return false;
  if (runTeamReviewKey(action)) return true;
  return action === 'cancel' && !isReviewNoteFocused() && closeBoardDetail();
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
  const mineRow = createMyPrQueueRow(item.pr, item.stackRow, sessionsByPrKey.get(item.prKey));
  return { container: mineRow.group, row: mineRow.row };
}

function itemAgeTone(item: QueueItem, groupId: QueueGroupId) {
  return ageToneOf(groupId, queueItemWaitStartMs(item), Date.now());
}

function createItemRow(item: QueueItem, groupId: QueueGroupId, hasMultipleRepos: boolean, sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): HTMLElement {
  const isTurn = groupId === 'turn';
  const { container, row } = rowFor(item, hasMultipleRepos, sessionsByPrKey);
  const ageTone = itemAgeTone(item, groupId);
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

function toggleCollapsedGroup(groupId: string): void {
  if (openCollapsedGroupIds.delete(groupId)) return;
  openCollapsedGroupIds.add(groupId);
}

function turnLimitElements(group: QueueGroup): HTMLElement[] {
  const turnLimit = getReviewsTurnLimit();
  if (group.id !== 'turn' || turnLimit === 0) return [];
  const limit = el('span', 'review-turn-limit', `limit ${turnLimit}`);
  if (isOverTurnLimit(group.items.length, turnLimit)) limit.dataset.over = 'true';
  return [limit];
}

function createGroupHeading(group: QueueGroup): HTMLElement {
  const heading = el('h3', 'pr-section-heading review-group-heading');
  const count = el('span', 'review-group-count', String(group.items.length));
  if (group.id === 'turn') {
    heading.append(el('span', null, group.title), count, ...turnLimitElements(group), buildNextAttentionKeys());
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

function createGroupSection(group: QueueGroup, hasMultipleRepos: boolean, sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): HTMLElement {
  const section = el('section', 'pr-queue-section');
  section.dataset.group = group.id;
  section.append(createGroupHeading(group));
  if (COLLAPSED_GROUP_IDS.has(group.id) && !openCollapsedGroupIds.has(group.id)) return section;
  for (const item of group.items) section.append(createItemRow(item, group.id, hasMultipleRepos, sessionsByPrKey));
  return section;
}

function queueNoticeElements(): HTMLElement[] {
  const mineNotices = myPrsQueueNotices(myPrsSnapshot().status, Date.now()).filter((notice) => notice.tone !== 'error').map((notice) => el('p', 'my-pr-note', notice.text));
  return [...(pollingControls ? [pollingControls.notice] : []), ...teamReviewLaneNotices(), ...mineNotices];
}

function emptyQueueElements(): HTMLElement[] {
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

function rowsSignature(groups: readonly QueueGroup[], sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): string {
  const ageTones = groups.flatMap((group) => group.items.map((item) => itemAgeTone(item, group.id)));
  return JSON.stringify([shownLayout(), getReviewsTurnLimit(), ageTones, groups, [...sessionsByPrKey], selectedKey, [...openCollapsedGroupIds], reviewQueueUnseenSignature(), queueNoticeElements().map((notice) => notice.textContent)], (key, value) => (key === 'recentSteps' ? undefined : value));
}

function createBoard(hasMultipleRepos: boolean, sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): HTMLElement {
  return createReviewBoard(currentGroups, {
    createCard: (item, group) => createItemRow(item, group.id, hasMultipleRepos, sessionsByPrKey),
    createHeadingExtras: (group) => (group.id === 'turn' ? [...turnLimitElements(group), buildNextAttentionKeys()] : []),
    isParkedOpen: openCollapsedGroupIds.has('parked'),
    onToggleParked: () => {
      toggleCollapsedGroup('parked');
      renderedSignature = null;
      render();
    },
  });
}

function queueContent(hasMultipleRepos: boolean, sessionsByPrKey: ReadonlyMap<string, LinkedLiveSession[]>): HTMLElement[] {
  const hasItems = currentGroups.some((group) => group.items.length > 0);
  if (isBoardShown()) return [...(hasItems ? [] : emptyQueueElements()), createBoard(hasMultipleRepos, sessionsByPrKey)];
  if (!hasItems) return emptyQueueElements();
  return currentGroups.filter((group) => group.items.length > 0).map((group) => createGroupSection(group, hasMultipleRepos, sessionsByPrKey));
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

function render(): void {
  if (!queueElement) return;
  skillNotice?.sync();
  if (syncSetupCard()) return;
  syncLayout();
  const { sessionsByPrKey, status: myPrsStatus } = myPrsSnapshot();
  currentGroups = rebuildReviewQueue();
  syncTeamChip();
  pollingControls?.update(combinedPollingStatus([teamReviewStatusView(), myPrsStatus]));
  if (!isCaughtUp) selectedKey = chooseQueueSelection(currentGroups, selectedKey);
  paintTurnPosition();
  const signature = rowsSignature(currentGroups, sessionsByPrKey);
  if (signature !== renderedSignature) {
    renderedSignature = signature;
    const focusedKey = document.activeElement instanceof HTMLElement && queueElement.contains(document.activeElement) ? document.activeElement.dataset.queueKey : undefined;
    resetTeamQueueTickers();
    rowsByKey.clear();
    const hasMultipleRepos = spansMultipleRepos(currentGroups);
    queueElement.replaceChildren(...queueNoticeElements(), ...queueContent(hasMultipleRepos, sessionsByPrKey));
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
  const boardBar = el('div', 'review-board-detail-bar');
  boardBar.append(button({ variant: 'secondary', label: 'Close', action: 'close-review-detail', onClick: returnToQueue }));
  shell.detail.append(phoneBar, boardBar, detailHost);
  skillNotice = createReviewSkillNotice();
  shell.queue.before(skillNotice.element);
  pollingControls = createGithubPollingControls(['team-review', 'my-prs'], root);
  teamChipSlot = el('span', 'review-team-chip-slot');
  shell.foot.append(teamChipSlot, pollingControls.control);
  setupCard = createReviewSetupCard();
  setupCard.element.hidden = true;
  root.append(setupCard.element, createLayoutSwitch(), shell.columns);
  root.dataset.detailOpen = 'false';
  teamDetail = mountTeamReviewDetail(root, {
    onChange: queueRender,
    captureTurnOrder: () => turnItems(currentGroups).map((item) => item.key),
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
