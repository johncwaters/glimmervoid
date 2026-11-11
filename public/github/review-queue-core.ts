import type { z } from 'zod';
import type { ReviewQueueAction, ReviewQueueGroupId, ReviewQueueItem } from '#shared/contracts/reviews.ts';
import type { CommunityStateEntry } from '#shared/contracts/community.ts';
import type { MyPr, MyPrStage } from '#shared/contracts/my-prs.ts';
import type { InFlightReview, QueuedReview, ReviewDraft, TeamReviewAction } from '#shared/contracts/team-review.ts';
import { attentionSignature } from '../attention-ack-core.ts';
import type { AttentionKind, AttentionTile } from '../focus-view/attention-core.ts';
import type { GithubPollingStatus } from './github-polling-retry-core.ts';
import { comparablePrKey } from '#shared/contracts/github-prs.ts';
import { PRIORITY_BAND_ORDER, answeredNonNitThreads, classifyReviewPriority, draftPriorityBand, hasFailedKeepMergeableRepair, pullRequestLabel, sectionStackedMyPrs } from './github-store-core.ts';
import type { QueueRowKind, TeamReviewSections } from './github-store-core.ts';
import { areAllThreadsWithReviewers } from './my-prs-view-core.ts';
import { detailActionLayout } from './team-review-view-core.ts';

type QueueGroupId = z.infer<typeof ReviewQueueGroupId>;
export type DisplayGroupId = QueueGroupId | 'now';
type QueueAction = z.infer<typeof ReviewQueueAction>;

export type QueueItem = z.infer<typeof ReviewQueueItem>;

export type CommunityQueueItem = { source: 'community'; key: string; entry: CommunityStateEntry; attention: AttentionKind | null };

interface KeyedQueueItem { key: string; attention: AttentionKind | null }

export interface QueueGroup<Item extends KeyedQueueItem = QueueItem, GroupId extends string = QueueGroupId> { id: GroupId; title: string; items: Item[] }

type CommunityGroupId = 'turn' | 'working' | 'aside';

export type CommunityQueueGroup = QueueGroup<CommunityQueueItem, CommunityGroupId>;

interface QueueStateRow { state: string; group: QueueGroupId; kind: AttentionKind | null; action: QueueAction | null }

const QUEUE_STATE_ORDER = [
  { state: 'mine-repair-failed', group: 'turn', kind: 'failed', action: 'fix' },
  { state: 'review-failed', group: 'turn', kind: 'failed', action: 'fix' },
  { state: 'review-direct-ask', group: 'turn', kind: 'waiting', action: 'review' },
  { state: 'review-ready', group: 'turn', kind: 'waiting', action: 'review' },
  { state: 'review-stale', group: 'turn', kind: 'waiting', action: 'review' },
  { state: 'review-follow-up', group: 'turn', kind: 'waiting', action: 'reply' },
  { state: 'mine-changes-requested', group: 'turn', kind: 'waiting', action: 'reply' },
  { state: 'mine-unresolved-threads', group: 'turn', kind: 'waiting', action: 'reply' },
  { state: 'mine-behind', group: 'turn', kind: 'waiting', action: 'update' },
  { state: 'mine-checks-failing', group: 'turn', kind: 'waiting', action: 'update' },
  { state: 'mine-conflicts', group: 'turn', kind: 'waiting', action: 'update' },
  { state: 'mine-ready', group: 'turn', kind: 'finished', action: 'merge' },
  { state: 'mine-repairing', group: 'working', kind: null, action: null },
  { state: 'mine-agent-fixing', group: 'working', kind: null, action: null },
  { state: 'review-in-flight', group: 'working', kind: null, action: null },
  { state: 'review-posted', group: 'waiting', kind: null, action: null },
  { state: 'mine-threads-with-reviewers', group: 'waiting', kind: null, action: null },
  { state: 'mine-checks-pending', group: 'waiting', kind: null, action: null },
  { state: 'mine-needs-approval', group: 'waiting', kind: null, action: null },
  { state: 'mine-unknown', group: 'waiting', kind: null, action: null },
  { state: 'review-queued', group: 'queued', kind: null, action: null },
  { state: 'mine-merged', group: 'merged', kind: null, action: null },
  { state: 'review-discarded', group: 'parked', kind: null, action: null },
  { state: 'mine-draft', group: 'parked', kind: null, action: null },
] as const satisfies readonly QueueStateRow[];

type QueueState = typeof QUEUE_STATE_ORDER[number]['state'];

const QUEUE_STATE_ROWS: ReadonlyMap<QueueState, QueueStateRow & { rank: number }> = new Map(QUEUE_STATE_ORDER.map((row, rank) => [row.state, { ...row, rank }]));

const GROUP_TITLES: Readonly<Record<QueueGroupId | CommunityGroupId, string>> = {
  turn: 'Your turn', working: 'Agent working', queued: 'Queued', waiting: 'Waiting on others', merged: 'Merged', parked: 'Parked', aside: 'Set aside',
};

const GROUP_ORDER: readonly QueueGroupId[] = ['turn', 'working', 'queued', 'waiting', 'merged', 'parked'];

export const COLLAPSED_GROUP_IDS: ReadonlySet<string> = new Set<QueueGroupId>(['merged', 'parked']);

const BOARD_COLUMN_ORDER: readonly DisplayGroupId[] = ['queued', 'working', 'turn', 'now', 'waiting', 'merged', 'parked'];

const DISPLAY_GROUP_TITLES: Readonly<Record<DisplayGroupId, string>> = { ...GROUP_TITLES, turn: 'Ready', now: 'Reviewing now' };

export type DisplayGroup = QueueGroup<QueueItem, DisplayGroupId>;

export function boardColumns(groups: readonly DisplayGroup[]): DisplayGroup[] {
  return BOARD_COLUMN_ORDER.map((id) => groups.find((group) => group.id === id) ?? { id, title: DISPLAY_GROUP_TITLES[id], items: [] });
}

export function splitReviewingNow(groups: readonly QueueGroup[], pulledKeys: readonly string[]): { groups: DisplayGroup[]; pulledKeys: string[] } {
  const turnKeys = new Set(turnItems(groups).map((item) => item.key));
  const keptPulledKeys = pulledKeys.filter((key) => turnKeys.has(key));
  const pulledKeySet = new Set(keptPulledKeys);
  const displayGroups = groups.flatMap((group): DisplayGroup[] => {
    if (group.id !== 'turn') return [group];
    return [
      { id: 'now', title: DISPLAY_GROUP_TITLES.now, items: group.items.filter((item) => pulledKeySet.has(item.key)) },
      { id: 'turn', title: DISPLAY_GROUP_TITLES.turn, items: group.items.filter((item) => !pulledKeySet.has(item.key)) },
    ];
  });
  return { groups: displayGroups, pulledKeys: keptPulledKeys };
}

export function splitMovedToWaiting(groups: readonly QueueGroup[], movedEntries: readonly string[]): { groups: QueueGroup[]; movedEntries: string[] } {
  const movedEntrySet = new Set(movedEntries);
  const movedItems = turnItems(groups).filter((item) => movedEntrySet.has(queueItemActivityEntry(item)));
  const liveMovedEntries = new Set(movedItems.map(queueItemActivityEntry));
  const shownCardIds = new Set(groups.flatMap((group) => group.items.map((item) => activityEntryCardId(queueItemActivityEntry(item)))));
  const isEntryKept = (entry: string) => liveMovedEntries.has(entry) || !shownCardIds.has(activityEntryCardId(entry));
  const movedKeys = new Set(movedItems.map((item) => item.key));
  const splitGroups = groups.map((group): QueueGroup => {
    if (group.id === 'turn') return { ...group, items: group.items.filter((item) => !movedKeys.has(item.key)) };
    if (group.id === 'waiting') return { ...group, items: [...movedItems, ...group.items] };
    return group;
  });
  return { groups: splitGroups, movedEntries: movedEntries.filter(isEntryKept) };
}

function activityEntryCardId(entry: string): string {
  return entry.slice(0, entry.indexOf('@'));
}

export const SLIM_GROUP_IDS: ReadonlySet<DisplayGroupId> = new Set(['queued', 'working', 'parked']);

function queueKeySource(key: string): string {
  return key.slice(0, key.indexOf(':') + 1);
}

export function orderDisplayGroups(groups: readonly DisplayGroup[], cardOrder: readonly string[]): { groups: DisplayGroup[]; cardOrder: string[] } {
  const positionByKey = new Map(cardOrder.map((key, position) => [key, position]));
  const liveKeys = new Set(groups.flatMap((group) => group.items.map((item) => item.key)));
  const liveSources = new Set([...liveKeys].map(queueKeySource));
  const orderedGroups = groups.map((group) => {
    if (SLIM_GROUP_IDS.has(group.id)) return group;
    const neverPlacedItems = group.items.filter((item) => !positionByKey.has(item.key));
    const placedItems = group.items
      .filter((item) => positionByKey.has(item.key))
      .sort((first, second) => (positionByKey.get(first.key) ?? 0) - (positionByKey.get(second.key) ?? 0));
    return { ...group, items: [...neverPlacedItems, ...placedItems] };
  });
  return { groups: orderedGroups, cardOrder: cardOrder.filter((key) => liveKeys.has(key) || !liveSources.has(queueKeySource(key))) };
}

export function placeCardBefore({ cardOrder, columnKeys, key, beforeKey }: { cardOrder: readonly string[]; columnKeys: readonly string[]; key: string; beforeKey: string | null }): string[] {
  if (key === beforeKey || !columnKeys.includes(key)) return [...cardOrder];
  const otherColumnKeys = columnKeys.filter((columnKey) => columnKey !== key);
  const insertAt = beforeKey === null ? otherColumnKeys.length : otherColumnKeys.indexOf(beforeKey);
  if (insertAt < 0) return [...cardOrder];
  const columnKeySet = new Set(columnKeys);
  return [
    ...cardOrder.filter((orderedKey) => !columnKeySet.has(orderedKey)),
    ...otherColumnKeys.slice(0, insertAt),
    key,
    ...otherColumnKeys.slice(insertAt),
  ];
}

export function togglePulledKey({ pulledKeys, key, turnKeys, limit }: { pulledKeys: readonly string[]; key: string; turnKeys: readonly string[]; limit: number }): string[] {
  if (pulledKeys.includes(key)) return pulledKeys.filter((pulledKey) => pulledKey !== key);
  const isFull = limit > 0 && pulledKeys.length >= limit;
  if (isFull || !turnKeys.includes(key)) return [...pulledKeys];
  return [...pulledKeys, key];
}

export function reviewingNowCountText(pulledCount: number, limit: number): string {
  return limit > 0 ? `${pulledCount} / ${limit}` : String(pulledCount);
}

const MINE_STATE_BY_STAGE: Readonly<Record<MyPrStage, QueueState>> = {
  conflicts: 'mine-conflicts', behind: 'mine-behind', 'checks-failing': 'mine-checks-failing', 'changes-requested': 'mine-changes-requested',
  'unresolved-threads': 'mine-unresolved-threads', ready: 'mine-ready',
  'checks-pending': 'mine-checks-pending', 'needs-approval': 'mine-needs-approval', unknown: 'mine-unknown',
  draft: 'mine-draft', merged: 'mine-merged',
};

const TEAM_STATE_BY_KIND: Readonly<Record<Exclude<QueueRowKind, 'ready' | 'attention'>, QueueState>> = {
  inReview: 'review-in-flight', queued: 'review-queued', posted: 'review-posted', discarded: 'review-discarded',
};

interface StatedItem { item: QueueItem; row: QueueStateRow & { rank: number }; priorityBandRank: number; waitStartMs: number }

const BLOCKED_PRIORITY_BAND_RANK = PRIORITY_BAND_ORDER.indexOf('waiting-on-author');

function readyReviewState(draft: ReviewDraft): QueueState {
  if (draft.status !== 'ready') return 'review-follow-up';
  if (classifyReviewPriority(draft).band === 'blocking-others') return 'review-direct-ask';
  return 'review-ready';
}

function teamState(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind): QueueState {
  if (kind === 'ready') return readyReviewState(review as ReviewDraft);
  if (kind === 'attention') return 'status' in review && review.status === 'error' ? 'review-failed' : 'review-stale';
  return TEAM_STATE_BY_KIND[kind];
}

function mineState(pr: MyPr, sessionPrKeys: ReadonlySet<string>, isKeepMergeableEnabled: boolean, viewer: string | null): QueueState {
  const isOpen = pr.state === 'OPEN';
  if (isOpen && hasFailedKeepMergeableRepair(pr, isKeepMergeableEnabled)) return 'mine-repair-failed';
  if (isOpen && isKeepMergeableEnabled && pr.keepMergeable && pr.isKeepMergeableFixInFlight) return 'mine-repairing';
  const isReviewStillRequired = pr.reviewDecision === 'REVIEW_REQUIRED';
  if (pr.stage === 'unresolved-threads' && isReviewStillRequired && areAllThreadsWithReviewers(pr, viewer)) return 'mine-threads-with-reviewers';
  const stageState = MINE_STATE_BY_STAGE[pr.stage];
  const isSessionFixing = QUEUE_STATE_ROWS.get(stageState)?.group === 'turn' && pr.stage !== 'ready' && sessionPrKeys.has(comparablePrKey(pr));
  return isSessionFixing ? 'mine-agent-fixing' : stageState;
}

function teamPriorityBandRank(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind): number {
  if (kind === 'ready' || kind === 'attention') return PRIORITY_BAND_ORDER.indexOf(draftPriorityBand(review as ReviewDraft));
  if (kind === 'queued') return PRIORITY_BAND_ORDER.indexOf(classifyReviewPriority(review as QueuedReview).band);
  return 0;
}

export function validTimestampMs(timestamp: number | string | null | undefined): number | null {
  const timestampMs = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
  return typeof timestampMs === 'number' && Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : null;
}

function latestAnsweredReplyMs(draft: ReviewDraft): number | null {
  const replyTimesMs = answeredNonNitThreads(draft).flatMap((thread) => validTimestampMs(thread.lastReplyAt) ?? []);
  return replyTimesMs.length > 0 ? Math.max(...replyTimesMs) : null;
}

export function teamWaitStartMs(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind): number {
  if (kind === 'inReview') return validTimestampMs((review as InFlightReview).startedAt) ?? Number.POSITIVE_INFINITY;
  if (kind === 'queued') return validTimestampMs(review.prCreatedAt) ?? Number.POSITIVE_INFINITY;
  const draft = review as ReviewDraft;
  const postedAtMs = kind === 'posted' ? validTimestampMs(draft.postedAt) : null;
  return latestAnsweredReplyMs(draft) ?? postedAtMs ?? validTimestampMs(draft.reviewedAt) ?? validTimestampMs(draft.prCreatedAt) ?? Number.POSITIVE_INFINITY;
}

function mineWaitStartMs(pr: MyPr): number {
  const waitStartAt = pr.mergedAt ?? pr.stageSinceMs ?? pr.updatedAt;
  return validTimestampMs(waitStartAt) ?? Number.POSITIVE_INFINITY;
}

type AgeTone = 'fresh' | 'aging' | 'old';

const AGING_AFTER_MS = 24 * 60 * 60 * 1000;
const OLD_AFTER_MS = 3 * AGING_AFTER_MS;

export function queueItemWaitStartMs(item: QueueItem): number {
  if (item.source === 'team') return teamWaitStartMs(item.review, item.kind);
  return mineWaitStartMs(item.pr);
}

export function ageToneOf(groupId: DisplayGroupId, waitStartMs: number, nowMs: number): AgeTone | null {
  if (groupId === 'merged' || groupId === 'parked' || !Number.isFinite(waitStartMs)) return null;
  const waitedMs = nowMs - waitStartMs;
  if (waitedMs > OLD_AFTER_MS) return 'old';
  if (waitedMs >= AGING_AFTER_MS) return 'aging';
  return 'fresh';
}

export function isOverTurnLimit(turnCount: number, turnLimit: number): boolean {
  return turnLimit > 0 && turnCount > turnLimit;
}

function statedItem(state: QueueState, priorityBandRank: number, waitStartMs: number, toItem: (row: QueueStateRow) => QueueItem): StatedItem[] {
  const row = QUEUE_STATE_ROWS.get(state);
  if (!row) return [];
  return [{ item: toItem(row), row, priorityBandRank, waitStartMs }];
}

function teamItems(sections: TeamReviewSections): StatedItem[] {
  const entries: [QueueRowKind, readonly (ReviewDraft | InFlightReview | QueuedReview)[]][] = [
    ['ready', sections.ready], ['attention', sections.attention], ['inReview', sections.inReview], ['queued', sections.queued],
    ['posted', sections.posted], ['discarded', sections.discarded],
  ];
  return entries.flatMap(([kind, reviews]) => reviews.flatMap((review) => statedItem(teamState(review, kind), teamPriorityBandRank(review, kind), teamWaitStartMs(review, kind), ({ action, kind: attention }) => (
    { source: 'team', key: `team:${review.key}`, prKey: comparablePrKey(review), kind, review, action, attention }
  ))));
}

function mineItems(prs: readonly MyPr[], sessionPrKeys: ReadonlySet<string>, isKeepMergeableEnabled: boolean, viewer: string | null): StatedItem[] {
  return sectionStackedMyPrs(prs).flatMap((section) => section.rows).flatMap((stackRow) => statedItem(mineState(stackRow.pr, sessionPrKeys, isKeepMergeableEnabled, viewer), 0, mineWaitStartMs(stackRow.pr), ({ action, kind: attention }) => (
    { source: 'mine', key: `mine:${stackRow.pr.key}`, prKey: comparablePrKey(stackRow.pr), pr: stackRow.pr, stackRow, action, attention }
  )));
}

function turnUrgencyRank(stated: StatedItem): number {
  if (stated.row.kind === 'failed') return 0;
  if (stated.row.state === 'review-direct-ask') return 1;
  if (stated.priorityBandRank >= BLOCKED_PRIORITY_BAND_RANK) return 3;
  return 2;
}

function compareStatedItems(first: StatedItem, second: StatedItem): number {
  const waitOrder = first.waitStartMs - second.waitStartMs;
  if (first.row.group === 'turn') return turnUrgencyRank(first) - turnUrgencyRank(second) || waitOrder || first.item.key.localeCompare(second.item.key);
  return first.row.rank - second.row.rank || first.priorityBandRank - second.priorityBandRank || waitOrder;
}

export function buildReviewQueue(sections: TeamReviewSections, myPrs: readonly MyPr[], sessionPrKeys: ReadonlySet<string>, isKeepMergeableEnabled: boolean, viewer: string | null = null): QueueGroup[] {
  const itemsByGroup = new Map<QueueGroupId, StatedItem[]>(GROUP_ORDER.map((id) => [id, []]));
  for (const stated of [...teamItems(sections), ...mineItems(myPrs, sessionPrKeys, isKeepMergeableEnabled, viewer)]) itemsByGroup.get(stated.row.group)?.push(stated);
  return GROUP_ORDER.map((id) => ({ id, title: GROUP_TITLES[id], items: (itemsByGroup.get(id) ?? []).toSorted(compareStatedItems).map((stated) => stated.item) }));
}

const COMMUNITY_GROUP_ORDER: readonly CommunityGroupId[] = ['turn', 'working', 'aside'];

interface CommunityStateRow { group: CommunityGroupId; kind: AttentionKind | null }

const COMMUNITY_STATE_ORDER = [
  { state: 'error', group: 'turn', kind: 'failed' },
  { state: 'ready-HIGH', group: 'turn', kind: 'finished' },
  { state: 'ready-MEDIUM', group: 'turn', kind: 'finished' },
  { state: 'ready-LOW', group: 'turn', kind: 'finished' },
  { state: 'ready', group: 'turn', kind: 'finished' },
  { state: 'running', group: 'working', kind: null },
  { state: 'queued', group: 'working', kind: null },
  { state: 'aside', group: 'aside', kind: null },
] as const satisfies readonly (CommunityStateRow & { state: string })[];

const COMMUNITY_STATE_ROWS: ReadonlyMap<string, CommunityStateRow & { rank: number }> = new Map(COMMUNITY_STATE_ORDER.map((row, rank) => [row.state, { ...row, rank }]));

function communityState(entry: CommunityStateEntry): string {
  if (entry.status === 'ready' && entry.verdict) return `ready-${entry.verdict}`;
  return entry.status;
}

function askedAtMs(entry: CommunityStateEntry): number {
  const createdAtMs = Date.parse(entry.item.createdAt);
  return Number.isNaN(createdAtMs) ? Number.POSITIVE_INFINITY : createdAtMs;
}

export function buildCommunityQueue(entries: readonly CommunityStateEntry[]): CommunityQueueGroup[] {
  const stated = entries.flatMap((entry) => {
    const row = COMMUNITY_STATE_ROWS.get(communityState(entry));
    if (!row) return [];
    return [{ row, askedAtMs: askedAtMs(entry), item: { source: 'community', key: entry.item.key, entry, attention: row.kind } satisfies CommunityQueueItem }];
  }).toSorted((first, second) => first.row.rank - second.row.rank || first.askedAtMs - second.askedAtMs);
  return COMMUNITY_GROUP_ORDER.map((id) => ({ id, title: GROUP_TITLES[id], items: stated.filter((entry) => entry.row.group === id).map((entry) => entry.item) }));
}

export function communityActivityEntry(item: CommunityQueueItem): string {
  return `${item.key}@${item.entry.status}:${item.entry.finishedAt ?? ''}`;
}

export function turnItems<Item extends KeyedQueueItem>(groups: readonly QueueGroup<Item, string>[]): Item[] {
  return groups.find((group) => group.id === 'turn')?.items ?? [];
}

export function queueItemByKey<Item extends KeyedQueueItem>(groups: readonly QueueGroup<Item, string>[], key: string | null): Item | null {
  if (!key) return null;
  return groups.flatMap((group) => group.items).find((item) => item.key === key) ?? null;
}

export function chooseQueueSelection<Item extends KeyedQueueItem>(visibleGroups: readonly QueueGroup<Item, string>[], selectedKey: string | null, heldKeys: ReadonlySet<string> = new Set()): string | null {
  if (queueItemByKey(visibleGroups, selectedKey)) return selectedKey;
  if (selectedKey !== null && heldKeys.has(selectedKey)) return selectedKey;
  return visibleGroups.flatMap((group) => group.items)[0]?.key ?? null;
}

function itemLabel(item: QueueItem): string {
  if (item.source === 'mine') return pullRequestLabel(item.pr.repo, item.pr.number);
  return pullRequestLabel(item.review.repo, item.review.number);
}

function labeledAttentionTiles<Item extends KeyedQueueItem>(groups: readonly QueueGroup<Item, string>[], labelOf: (item: Item) => string): AttentionTile[] {
  return turnItems(groups).map((item) => ({ id: item.key, kind: item.attention ?? 'waiting', name: labelOf(item) }));
}

export function attentionTilesOf(groups: readonly QueueGroup[]): AttentionTile[] {
  return labeledAttentionTiles(groups, itemLabel);
}

export function bannerTilesOf(groups: readonly QueueGroup[], selectedKey: string | null): AttentionTile[] {
  return attentionTilesOf(groups).filter((tile) => tile.id !== selectedKey);
}

export function nextTurnKey<Item extends KeyedQueueItem>({ capturedOrder, actedKey, groups }: { capturedOrder: readonly string[]; actedKey: string; groups: readonly QueueGroup<Item, string>[] }): string | null {
  const remainingKeys = turnItems(groups).map((item) => item.key).filter((key) => key !== actedKey);
  const remainingKeySet = new Set(remainingKeys);
  const nextKey = capturedOrder.slice(capturedOrder.indexOf(actedKey) + 1).find((key) => remainingKeySet.has(key));
  return nextKey ?? capturedOrder.find((key) => remainingKeySet.has(key)) ?? remainingKeys[0] ?? null;
}

const POSITION_GROUP_IDS: ReadonlySet<string> = new Set<DisplayGroupId>(['turn', 'now']);

export function shownTurnKeys(groups: readonly DisplayGroup[]): string[] {
  return groups.filter((group) => POSITION_GROUP_IDS.has(group.id)).flatMap((group) => group.items.map((item) => item.key));
}

export function turnPositionText(groups: readonly DisplayGroup[], key: string | null): string {
  const shownGroup = groups.find((group) => POSITION_GROUP_IDS.has(group.id) && group.items.some((item) => item.key === key));
  if (!shownGroup) return '';
  const position = shownGroup.items.findIndex((item) => item.key === key);
  return `${position + 1} of ${shownGroup.items.length} in ${shownGroup.title}`;
}

export function queueItemActivityEntry(item: QueueItem): string {
  if (item.source === 'mine') return `${item.key}@${item.pr.stage}`;
  if ('reviewedHead' in item.review) return `${item.review.key}@${item.review.reviewedHead}`;
  return `${item.review.key}@${item.kind}`;
}

export function turnActivityEntries(groups: readonly QueueGroup[]): string[] {
  return turnItems(groups).map(queueItemActivityEntry);
}

export function decideTurnAttention({ turnEntries, acknowledged, unseen, isLooking }: { turnEntries: readonly string[]; acknowledged: string; unseen: string; isLooking: boolean }): { isShown: boolean; acknowledged: string; unseen: string } {
  const turnSet = new Set(turnEntries);
  const acknowledgedSet = new Set(acknowledged.split('|').filter((entry) => turnSet.has(entry)));
  const unseenSet = new Set(unseen.split('|').filter((entry) => turnSet.has(entry)));
  const arrivals = [...turnSet].filter((entry) => !acknowledgedSet.has(entry));
  if (isLooking) return { isShown: false, acknowledged: attentionSignature([...turnSet]), unseen: attentionSignature([...unseenSet]) };
  for (const entry of arrivals) unseenSet.add(entry);
  return { isShown: arrivals.length > 0, acknowledged: attentionSignature([...acknowledgedSet]), unseen: attentionSignature([...unseenSet]) };
}

export function caughtUpText(groups: readonly QueueGroup[]): string {
  const workingCount = groups.find((group) => group.id === 'working')?.items.length ?? 0;
  if (workingCount === 0) return 'Nothing needs you right now.';
  return `Nothing needs you right now. ${workingCount} ${workingCount === 1 ? 'pull request is' : 'pull requests are'} with an agent.`;
}

export function spansMultipleRepos(groups: readonly QueueGroup[]): boolean {
  const repos = new Set(groups.flatMap((group) => group.items).map((item) => (item.source === 'mine' ? item.pr.repo : item.review.repo).toLowerCase()));
  return repos.size > 1;
}

export function combinedPollingStatus(statuses: readonly (GithubPollingStatus | null)[]): GithubPollingStatus | null {
  const configuredStatuses = statuses.filter((status): status is GithubPollingStatus => status?.configured === true);
  if (configuredStatuses.length === 0) return statuses.find((status) => status !== null) ?? null;
  const oldestFirst = configuredStatuses.toSorted((first, second) => (first.lastRefreshedAt ?? first.lastSyncAt ?? 0) - (second.lastRefreshedAt ?? second.lastSyncAt ?? 0));
  const representative = configuredStatuses.find((status) => status.error) ?? configuredStatuses.find((status) => status.watcherProblem) ?? oldestFirst[0];
  return { ...representative, isRefreshing: configuredStatuses.some((status) => status.isRefreshing) };
}

export type ReviewDetailKeyAction = 'next-finding' | 'previous-finding' | 'toggle-finding' | 'open-session' | 'pick-approve' | 'pick-request-changes' | 'pick-comment' | 'post' | 'cancel';
export type ReviewKeyAction = 'next-row' | 'previous-row' | 'next-column' | 'previous-column' | 'toggle-pulled' | ReviewDetailKeyAction;

const REVIEW_LETTER_ACTIONS: ReadonlyMap<string, ReviewKeyAction> = new Map([
  ['j', 'next-row'], ['k', 'previous-row'], ['n', 'next-finding'], ['p', 'previous-finding'], ['x', 'toggle-finding'], ['o', 'open-session'],
  ['a', 'pick-approve'], ['r', 'pick-request-changes'], ['c', 'pick-comment'], ['m', 'toggle-pulled'],
  ['h', 'previous-column'], ['l', 'next-column'], ['ArrowLeft', 'previous-column'], ['ArrowRight', 'next-column'],
]);

interface ReviewKeyEvent { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

export function reviewKeyActionOf(event: ReviewKeyEvent): ReviewKeyAction | null {
  const isPostChord = event.key === 'Enter' && event.metaKey !== event.ctrlKey && !event.altKey && !event.shiftKey;
  if (isPostChord) return 'post';
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.key === 'Escape') return 'cancel';
  return REVIEW_LETTER_ACTIONS.get(event.key) ?? null;
}

export function steppedColumnKey(columnRowKeys: readonly (readonly string[])[], selectedKey: string | null, step: 1 | -1): string | null {
  const filledColumns = columnRowKeys.filter((rowKeys) => rowKeys.length > 0);
  if (filledColumns.length === 0) return null;
  const columnIndex = filledColumns.findIndex((rowKeys) => selectedKey !== null && rowKeys.includes(selectedKey));
  if (columnIndex === -1) return filledColumns[0][0];
  const rowIndex = filledColumns[columnIndex].indexOf(selectedKey ?? '');
  const targetColumn = filledColumns[Math.min(filledColumns.length - 1, Math.max(0, columnIndex + step))];
  return targetColumn[Math.min(rowIndex, targetColumn.length - 1)];
}

export function steppedRowKey(rowKeys: readonly string[], selectedKey: string | null, step: 1 | -1): string | null {
  if (rowKeys.length === 0) return null;
  const index = selectedKey === null ? -1 : rowKeys.indexOf(selectedKey);
  if (index === -1) return step === 1 ? rowKeys[0] : rowKeys[rowKeys.length - 1];
  return rowKeys[Math.min(rowKeys.length - 1, Math.max(0, index + step))];
}

export type BoardDrop = { kind: 'pull'; shouldBePulled: boolean } | { kind: 'team-action'; action: TeamReviewAction } | { kind: 'wait'; isMoved: boolean; shouldBePulled: boolean };

const TEAM_ACTION_BY_DROP_LANE: Readonly<Partial<Record<DisplayGroupId, TeamReviewAction>>> = { parked: 'discard', queued: 'requeue', turn: 'restore' };

const PULL_LANE_IDS: ReadonlySet<DisplayGroupId> = new Set(['turn', 'now']);

function offeredTeamActions(item: Extract<QueueItem, { source: 'team' }>): readonly TeamReviewAction[] {
  if (item.kind === 'queued' || item.kind === 'inReview') return ['discard'];
  const layout = detailActionLayout(item.review as ReviewDraft);
  return [...layout.leading, ...layout.trailing];
}

export function boardDropOf(item: QueueItem, sourceGroupId: DisplayGroupId, targetGroupId: DisplayGroupId, isMovedToWaiting = false): BoardDrop | null {
  if (sourceGroupId === targetGroupId) return null;
  if (PULL_LANE_IDS.has(sourceGroupId) && PULL_LANE_IDS.has(targetGroupId)) return { kind: 'pull', shouldBePulled: targetGroupId === 'now' };
  if (PULL_LANE_IDS.has(sourceGroupId) && targetGroupId === 'waiting') return { kind: 'wait', isMoved: true, shouldBePulled: false };
  if (isMovedToWaiting && PULL_LANE_IDS.has(targetGroupId)) return { kind: 'wait', isMoved: false, shouldBePulled: targetGroupId === 'now' };
  const action = TEAM_ACTION_BY_DROP_LANE[targetGroupId];
  if (item.source !== 'team' || !action || !offeredTeamActions(item).includes(action)) return null;
  return { kind: 'team-action', action };
}

export function boardDropLaneIds(item: QueueItem, sourceGroupId: DisplayGroupId, isMovedToWaiting = false): DisplayGroupId[] {
  return BOARD_COLUMN_ORDER.filter((targetGroupId) => boardDropOf(item, sourceGroupId, targetGroupId, isMovedToWaiting) !== null);
}
