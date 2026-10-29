import { CommunityStatus } from '#shared/contracts/community.ts';
import type { CommunityStatus as CommunityStatusType } from '#shared/contracts/community.ts';
import { attentionSignature } from '../attention-ack-core.ts';
import { describeSchemaIssues } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';
import { buildCommunityQueue, communityActivityEntry, decideTurnAttention, turnItems } from '../github/review-queue-core.ts';
import type { CommunityQueueItem, QueueGroup } from '../github/review-queue-core.ts';
import { getCommunityAttentionAck, getCommunityUnseenRows, setCommunityAttentionAck, setCommunityUnseenRows } from '../ui-prefs.ts';

type CommunityChange =
  | { kind: 'status' }
  | { kind: 'connection'; isConnected: boolean };

let latest: CommunityStatusType | null = null;
let groups: QueueGroup<CommunityQueueItem>[] = [];
let isLooking: () => boolean = () => false;
let activityCallback: ((isActive: boolean) => void) | null = null;
let acknowledged = getCommunityAttentionAck();
let unseenSignature = getCommunityUnseenRows();
let unseenEntries = new Set(unseenSignature.split('|').filter(Boolean));
const listeners = new Set<(change: CommunityChange) => void>();

function notify(change: CommunityChange): void {
  for (const listener of listeners) listener(change);
}

function turnEntries(): string[] {
  return turnItems(groups).map(communityActivityEntry);
}

function storeAcknowledged(signature: string): void {
  if (signature === acknowledged) return;
  acknowledged = signature;
  setCommunityAttentionAck(signature);
}

function storeUnseen(signature: string): void {
  if (signature === unseenSignature) return;
  unseenSignature = signature;
  unseenEntries = new Set(signature.split('|').filter(Boolean));
  setCommunityUnseenRows(signature);
}

function refreshActivity(): void {
  if (!latest) return;
  const decision = decideTurnAttention({ turnEntries: turnEntries(), acknowledged, unseen: unseenSignature, isLooking: isLooking() });
  storeAcknowledged(decision.acknowledged);
  storeUnseen(decision.unseen);
  activityCallback?.(decision.isShown);
}

export function subscribeCommunity(listener: (change: CommunityChange) => void): void {
  listeners.add(listener);
}

export function communityStatusView(): CommunityStatusType | null {
  return latest;
}

export function communityQueue(): QueueGroup<CommunityQueueItem>[] {
  return groups;
}

export function attachCommunityView(isViewLooking: () => boolean): void {
  isLooking = isViewLooking;
  refreshActivity();
}

export function setCommunityActivityCallback(callback: (isActive: boolean) => void): void {
  activityCallback = callback;
  refreshActivity();
}

export function acknowledgeCommunityAttention(): void {
  if (!latest) return;
  storeAcknowledged(attentionSignature(turnEntries()));
  refreshActivity();
}

export function communityUnseenSignature(): string {
  return unseenSignature;
}

export function isCommunityEntryUnseen(entry: string): boolean {
  return unseenEntries.has(entry);
}

export function markCommunityEntrySeen(entry: string): boolean {
  if (!unseenEntries.has(entry)) return false;
  storeUnseen(attentionSignature([...unseenEntries].filter((unseenEntry) => unseenEntry !== entry)));
  return true;
}

export function applyCommunityStatus(message: unknown): void {
  const parsed = CommunityStatus.safeParse(message);
  if (!parsed.success) {
    reportToServerLog('community', `dropped community-status: ${describeSchemaIssues(parsed.error.issues)}`);
    return;
  }
  latest = parsed.data;
  groups = buildCommunityQueue(parsed.data.entries);
  refreshActivity();
  notify({ kind: 'status' });
}

export function applyCommunityConnectionState(isConnected: boolean): void {
  notify({ kind: 'connection', isConnected });
}
