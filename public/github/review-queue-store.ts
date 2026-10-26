import { attentionSignature } from '../attention-ack-core.ts';
import { getPrsAttentionAck, getPrsUnseenRows, setPrsAttentionAck, setPrsUnseenRows } from '../ui-prefs.ts';
import { myPrsSnapshot, subscribeMyPrs } from './my-prs-store.ts';
import { bannerTilesOf, buildReviewQueue, decideTurnAttention, turnActivityEntries } from './review-queue-core.ts';
import type { QueueGroup } from './review-queue-core.ts';
import { subscribeTeamReview, teamReviewSections, teamReviewStatusView } from './team-review-store.ts';

interface ReviewQueueNavigation {
  openTerminal: (sessionId: string) => void;
  openReviews: () => boolean;
}

interface AttachedReviewQueueView {
  isLooking: () => boolean;
  selectedKey: () => string | null;
}

export type ReviewQueueChange = { kind: 'reveal' } | { kind: 'return-to-queue' };

let groups: QueueGroup[] = [];
let navigation: ReviewQueueNavigation | null = null;
let attachedView: AttachedReviewQueueView | null = null;
let pendingRevealKey: string | null = null;
let isDetailScreenOpen = false;
let activityCallback: ((isActive: boolean) => void) | null = null;
let acknowledged = getPrsAttentionAck();
let unseenSignature = getPrsUnseenRows();
let unseenEntries = new Set(unseenSignature.split('|').filter(Boolean));
const phoneScreenListeners = new Set<() => void>();
const listeners = new Set<(change: ReviewQueueChange) => void>();

function notify(change: ReviewQueueChange): void {
  for (const listener of listeners) listener(change);
}

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
  const decision = decideTurnAttention({ turnEntries: turnActivityEntries(groups), acknowledged, unseen: unseenSignature, isLooking: attachedView?.isLooking() ?? false });
  storeAcknowledged(decision.acknowledged);
  storeUnseen(decision.unseen);
  activityCallback?.(decision.isShown);
}

function requestReveal(key: string): void {
  pendingRevealKey = key;
  notify({ kind: 'reveal' });
}

export function subscribeReviewQueue(listener: (change: ReviewQueueChange) => void): void {
  listeners.add(listener);
}

export function attachReviewQueueView(view: AttachedReviewQueueView): void {
  attachedView = view;
  refreshActivity();
}

export function rebuildReviewQueue(): QueueGroup[] {
  const { prs, sessionsByPrKey } = myPrsSnapshot();
  groups = buildReviewQueue(teamReviewSections(), prs, new Set(sessionsByPrKey.keys()));
  refreshActivity();
  return groups;
}

export function acknowledgeReviewQueueAttention(): void {
  if (!hasBothLanes()) return;
  storeAcknowledged(attentionSignature(turnActivityEntries(groups)));
  refreshActivity();
}

export function setReviewQueueActivityCallback(callback: (isActive: boolean) => void): void {
  activityCallback = callback;
  refreshActivity();
}

export function reviewQueueUnseenSignature(): string {
  return unseenSignature;
}

export function isQueueEntryUnseen(entry: string): boolean {
  return unseenEntries.has(entry);
}

export function markQueueEntrySeen(entry: string): boolean {
  if (!unseenEntries.has(entry)) return false;
  storeUnseen(attentionSignature([...unseenEntries].filter((unseenEntry) => unseenEntry !== entry)));
  return true;
}

export function setReviewQueueNavigation(queueNavigation: ReviewQueueNavigation): void {
  navigation = queueNavigation;
}

export function reviewQueueNavigation(): ReviewQueueNavigation | null {
  return navigation;
}

export function takePendingReveal(): string | null {
  const key = pendingRevealKey;
  pendingRevealKey = null;
  return key;
}

export function setReviewDetailScreenOpen(isOpen: boolean): void {
  if (isOpen === isDetailScreenOpen) return;
  isDetailScreenOpen = isOpen;
  for (const listener of phoneScreenListeners) listener();
}

export function onPhoneReviewScreenChanged(listener: () => void): void {
  phoneScreenListeners.add(listener);
}

export function canReturnToReviewQueue(): boolean {
  return document.documentElement.dataset.layout === 'phone' && isDetailScreenOpen;
}

export function returnToReviewQueue(): void {
  if (!canReturnToReviewQueue()) return;
  notify({ kind: 'return-to-queue' });
}

export function jumpToNextReview(): boolean {
  const headKey = bannerTilesOf(groups, attachedView?.selectedKey() ?? null)[0]?.id ?? null;
  if (!headKey) return false;
  requestReveal(headKey);
  return true;
}

export function showPrInReviewQueue(prKey: string): boolean {
  const item = groups.flatMap((group) => group.items).find((candidate) => candidate.prKey === prKey.toLowerCase());
  if (!item || !navigation?.openReviews()) return false;
  requestReveal(item.key);
  acknowledgeReviewQueueAttention();
  return true;
}

subscribeTeamReview((change) => {
  if (change.kind === 'status') rebuildReviewQueue();
});
subscribeMyPrs((change) => {
  if (change.kind === 'prs') rebuildReviewQueue();
});
