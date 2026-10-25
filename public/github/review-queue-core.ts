import type { MyPr, MyPrStage } from '#shared/contracts/my-prs.ts';
import type { InFlightReview, QueuedReview, ReviewDraft } from '#shared/contracts/team-review.ts';
import { attentionSignature } from '../attention-ack-core.ts';
import type { AttentionCounts, AttentionKind, AttentionTile } from '../focus-view/attention-core.ts';
import type { GithubPollingStatus } from './github-polling-retry-core.ts';
import { comparablePrKey, sectionStackedMyPrs } from './my-prs-view-core.ts';
import { classifyReviewPriority, pullRequestLabel } from './team-review-view-core.ts';
import type { QueueRowKind, TeamReviewSections } from './team-review-view-core.ts';

type QueueGroupId = 'turn' | 'working' | 'waiting' | 'aside';
export type QueueFilter = 'all' | 'reviewing' | 'mine';

export type QueueItem =
  | { source: 'team'; key: string; prKey: string; kind: QueueRowKind; review: ReviewDraft | InFlightReview | QueuedReview }
  | { source: 'mine'; key: string; prKey: string; pr: MyPr; stackedOn: string | null };

export interface QueueGroup { id: QueueGroupId; title: string; items: QueueItem[] }

export const QUEUE_FILTERS: readonly { id: QueueFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'reviewing', label: 'Reviewing' },
  { id: 'mine', label: 'Mine' },
];

const GROUP_TITLES: Readonly<Record<QueueGroupId, string>> = {
  turn: 'Your turn', working: 'Agent working', waiting: 'Waiting on others', aside: 'Set aside',
};

const GROUP_ORDER: readonly QueueGroupId[] = ['turn', 'working', 'waiting', 'aside'];

const MINE_GROUP_BY_STAGE: Readonly<Record<MyPrStage, QueueGroupId>> = {
  conflicts: 'turn', behind: 'turn', 'checks-failing': 'turn', 'changes-requested': 'turn', 'unresolved-threads': 'turn', ready: 'turn',
  'checks-pending': 'waiting', 'needs-approval': 'waiting', unknown: 'waiting',
  draft: 'aside', merged: 'aside',
};

const TURN_RANK = { directAsk: 0, followUp: 1, mineNeedsYou: 2, teamReady: 3, mineReady: 4, failedReview: 5, staleReview: 6, fork: 7 } as const;

interface RankedItem { item: QueueItem; group: QueueGroupId; turnRank: number }

function teamItem(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind): QueueItem {
  return { source: 'team', key: `team:${review.key}`, prKey: comparablePrKey(review), kind, review };
}

function readyTurnRank(draft: ReviewDraft): number {
  if (draft.status !== 'ready') return TURN_RANK.followUp;
  if (classifyReviewPriority(draft).band === 'blocking-others') return TURN_RANK.directAsk;
  return TURN_RANK.teamReady;
}

function teamItems(sections: TeamReviewSections): RankedItem[] {
  return [
    ...sections.ready.map((draft) => ({ item: teamItem(draft, 'ready'), group: 'turn' as const, turnRank: readyTurnRank(draft) })),
    ...sections.attention.map((draft) => ({ item: teamItem(draft, 'attention'), group: 'turn' as const, turnRank: draft.status === 'error' ? TURN_RANK.failedReview : TURN_RANK.staleReview })),
    ...sections.handReview.map((review) => ({ item: teamItem(review, 'handReview'), group: 'turn' as const, turnRank: TURN_RANK.fork })),
    ...sections.inReview.map((review) => ({ item: teamItem(review, 'inReview'), group: 'working' as const, turnRank: 0 })),
    ...sections.queued.map((review) => ({ item: teamItem(review, 'queued'), group: 'working' as const, turnRank: 0 })),
    ...sections.noReviewNeeded.map((draft) => ({ item: teamItem(draft, 'settled'), group: 'waiting' as const, turnRank: 0 })),
    ...sections.posted.map((draft) => ({ item: teamItem(draft, 'posted'), group: 'waiting' as const, turnRank: 0 })),
    ...sections.discarded.map((draft) => ({ item: teamItem(draft, 'discarded'), group: 'aside' as const, turnRank: 0 })),
  ];
}

function mineGroup(pr: MyPr, sessionPrKeys: ReadonlySet<string>): QueueGroupId {
  const group = MINE_GROUP_BY_STAGE[pr.stage];
  const isSessionFixing = group === 'turn' && pr.stage !== 'ready' && sessionPrKeys.has(comparablePrKey(pr));
  return isSessionFixing ? 'working' : group;
}

function mineItems(prs: readonly MyPr[], sessionPrKeys: ReadonlySet<string>): RankedItem[] {
  return sectionStackedMyPrs(prs).flatMap((section) => section.rows).map(({ pr, parentKey }) => ({
    item: { source: 'mine' as const, key: `mine:${pr.key}`, prKey: comparablePrKey(pr), pr, stackedOn: parentKey },
    group: mineGroup(pr, sessionPrKeys),
    turnRank: pr.stage === 'ready' ? TURN_RANK.mineReady : TURN_RANK.mineNeedsYou,
  }));
}

export function buildReviewQueue(sections: TeamReviewSections, myPrs: readonly MyPr[], sessionPrKeys: ReadonlySet<string>): QueueGroup[] {
  const rankedItems = [...teamItems(sections), ...mineItems(myPrs, sessionPrKeys)];
  return GROUP_ORDER.map((id) => {
    const groupItems = rankedItems.filter((ranked) => ranked.group === id);
    const orderedItems = id === 'turn' ? groupItems.toSorted((first, second) => first.turnRank - second.turnRank) : groupItems;
    return { id, title: GROUP_TITLES[id], items: orderedItems.map((ranked) => ranked.item) };
  });
}

export function filterQueue(groups: readonly QueueGroup[], filter: QueueFilter): QueueGroup[] {
  if (filter === 'all') return [...groups];
  const source = filter === 'reviewing' ? 'team' : 'mine';
  return groups.map((group) => ({ ...group, items: group.items.filter((item) => item.source === source) }));
}

export function turnItems(groups: readonly QueueGroup[]): QueueItem[] {
  return groups.find((group) => group.id === 'turn')?.items ?? [];
}

export function queueItemByKey(groups: readonly QueueGroup[], key: string | null): QueueItem | null {
  if (!key) return null;
  return groups.flatMap((group) => group.items).find((item) => item.key === key) ?? null;
}

export function chooseQueueSelection(visibleGroups: readonly QueueGroup[], selectedKey: string | null): string | null {
  if (queueItemByKey(visibleGroups, selectedKey)) return selectedKey;
  return visibleGroups.flatMap((group) => group.items)[0]?.key ?? null;
}

function itemLabel(item: QueueItem): string {
  if (item.source === 'mine') return pullRequestLabel(item.pr.repo, item.pr.number);
  return pullRequestLabel(item.review.repo, item.review.number);
}

function tileKind(item: QueueItem): AttentionKind {
  if (item.source === 'team') return item.kind === 'attention' && 'status' in item.review && item.review.status === 'error' ? 'failed' : 'waiting';
  if (item.pr.stage === 'ready') return 'finished';
  return item.pr.stage === 'checks-failing' || item.pr.stage === 'conflicts' ? 'failed' : 'waiting';
}

export function attentionTilesOf(groups: readonly QueueGroup[]): AttentionTile[] {
  return turnItems(groups).map((item) => ({ id: item.key, kind: tileKind(item), name: itemLabel(item) }));
}

export function attentionCountsOf(tiles: readonly AttentionTile[]): AttentionCounts {
  return {
    waitingCount: tiles.filter((tile) => tile.kind === 'waiting').length,
    finishedCount: tiles.filter((tile) => tile.kind === 'finished').length,
    failedCount: tiles.filter((tile) => tile.kind === 'failed').length,
  };
}

export function bannerTilesOf(groups: readonly QueueGroup[], selectedKey: string | null): AttentionTile[] {
  return attentionTilesOf(groups).filter((tile) => tile.id !== selectedKey);
}

export function nextTurnKey({ capturedOrder, actedKey, groups }: { capturedOrder: readonly string[]; actedKey: string; groups: readonly QueueGroup[] }): string | null {
  const remainingKeys = turnItems(groups).map((item) => item.key).filter((key) => key !== actedKey);
  const remainingKeySet = new Set(remainingKeys);
  const nextKey = capturedOrder.slice(capturedOrder.indexOf(actedKey) + 1).find((key) => remainingKeySet.has(key));
  return nextKey ?? capturedOrder.find((key) => remainingKeySet.has(key)) ?? remainingKeys[0] ?? null;
}

export function turnPositionText(groups: readonly QueueGroup[], key: string | null): string {
  const turnKeys = turnItems(groups).map((item) => item.key);
  const position = key ? turnKeys.indexOf(key) : -1;
  if (position === -1) return '';
  return `${position + 1} of ${turnKeys.length} in Your turn`;
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
  const representative = configuredStatuses.find((status) => status.error) ?? oldestFirst[0];
  return { ...representative, isRefreshing: configuredStatuses.some((status) => status.isRefreshing) };
}
