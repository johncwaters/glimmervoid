import type { MyPr, MyPrStage } from '#shared/contracts/my-prs.ts';
import type { InFlightReview, QueuedReview, ReviewDraft } from '#shared/contracts/team-review.ts';
import { attentionSignature } from '../attention-ack-core.ts';
import type { AttentionCounts, AttentionKind, AttentionTile } from '../focus-view/attention-core.ts';
import type { GithubPollingStatus } from './github-polling-retry-core.ts';
import type { StateTone } from '../state-tone-core.ts';
import { comparablePrKey } from '#shared/contracts/github-prs.ts';
import { classifyReviewPriority, hasFailedKeepMergeableRepair, pullRequestLabel, sectionStackedMyPrs } from './github-store-core.ts';
import type { MyPrStackRow, QueueRowKind, TeamReviewSections } from './github-store-core.ts';

type QueueGroupId = 'turn' | 'working' | 'waiting' | 'aside';
type QueueAction = 'fix' | 'review' | 'reply' | 'update' | 'merge';

export type QueueItem =
  | { source: 'team'; key: string; prKey: string; kind: QueueRowKind; review: ReviewDraft | InFlightReview | QueuedReview; action: QueueAction | null; attention: AttentionKind | null }
  | { source: 'mine'; key: string; prKey: string; pr: MyPr; stackRow: MyPrStackRow; action: QueueAction | null; attention: AttentionKind | null };

export interface QueueGroup { id: QueueGroupId; title: string; items: QueueItem[] }

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
  { state: 'review-queued', group: 'working', kind: null, action: null },
  { state: 'review-settled', group: 'waiting', kind: null, action: null },
  { state: 'review-posted', group: 'waiting', kind: null, action: null },
  { state: 'mine-checks-pending', group: 'waiting', kind: null, action: null },
  { state: 'mine-needs-approval', group: 'waiting', kind: null, action: null },
  { state: 'mine-unknown', group: 'waiting', kind: null, action: null },
  { state: 'review-discarded', group: 'aside', kind: null, action: null },
  { state: 'mine-draft', group: 'aside', kind: null, action: null },
  { state: 'mine-merged', group: 'aside', kind: null, action: null },
] as const satisfies readonly QueueStateRow[];

type QueueState = typeof QUEUE_STATE_ORDER[number]['state'];

const QUEUE_STATE_ROWS: ReadonlyMap<QueueState, QueueStateRow & { rank: number }> = new Map(QUEUE_STATE_ORDER.map((row, rank) => [row.state, { ...row, rank }]));

export const QUEUE_ACTION_LABELS: Readonly<Record<QueueAction, string>> = { fix: 'Fix', review: 'Review', reply: 'Reply', update: 'Update', merge: 'Merge' };

export const QUEUE_ACTION_TONES: Readonly<Record<QueueAction, StateTone>> = { fix: 'danger', review: 'wait', reply: 'warn', update: 'muted', merge: 'ok' };

const GROUP_TITLES: Readonly<Record<QueueGroupId, string>> = {
  turn: 'Your turn', working: 'Agent working', waiting: 'Waiting on others', aside: 'Set aside',
};

const GROUP_ORDER: readonly QueueGroupId[] = ['turn', 'working', 'waiting', 'aside'];

const MINE_STATE_BY_STAGE: Readonly<Record<MyPrStage, QueueState>> = {
  conflicts: 'mine-conflicts', behind: 'mine-behind', 'checks-failing': 'mine-checks-failing', 'changes-requested': 'mine-changes-requested',
  'unresolved-threads': 'mine-unresolved-threads', ready: 'mine-ready',
  'checks-pending': 'mine-checks-pending', 'needs-approval': 'mine-needs-approval', unknown: 'mine-unknown',
  draft: 'mine-draft', merged: 'mine-merged',
};

const TEAM_STATE_BY_KIND: Readonly<Record<Exclude<QueueRowKind, 'ready' | 'attention'>, QueueState>> = {
  settled: 'review-settled', inReview: 'review-in-flight', queued: 'review-queued', posted: 'review-posted', discarded: 'review-discarded',
};

interface StatedItem { item: QueueItem; row: QueueStateRow & { rank: number }; openedAtMs: number }

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

function mineState(pr: MyPr, sessionPrKeys: ReadonlySet<string>, isKeepMergeableEnabled: boolean): QueueState {
  const isOpen = pr.state === 'OPEN';
  if (isOpen && hasFailedKeepMergeableRepair(pr, isKeepMergeableEnabled)) return 'mine-repair-failed';
  if (isOpen && isKeepMergeableEnabled && pr.keepMergeable && pr.isKeepMergeableFixInFlight) return 'mine-repairing';
  const stageState = MINE_STATE_BY_STAGE[pr.stage];
  const isSessionFixing = QUEUE_STATE_ROWS.get(stageState)?.group === 'turn' && pr.stage !== 'ready' && sessionPrKeys.has(comparablePrKey(pr));
  return isSessionFixing ? 'mine-agent-fixing' : stageState;
}

function statedItem(state: QueueState, openedAt: string | undefined, toItem: (row: QueueStateRow) => QueueItem): StatedItem[] {
  const row = QUEUE_STATE_ROWS.get(state);
  if (!row) return [];
  const openedAtMs = openedAt ? Date.parse(openedAt) : Number.NaN;
  return [{ item: toItem(row), row, openedAtMs: Number.isNaN(openedAtMs) ? Number.POSITIVE_INFINITY : openedAtMs }];
}

function teamItems(sections: TeamReviewSections): StatedItem[] {
  const entries: [QueueRowKind, readonly (ReviewDraft | InFlightReview | QueuedReview)[]][] = [
    ['ready', sections.ready], ['attention', sections.attention], ['inReview', sections.inReview], ['queued', sections.queued],
    ['settled', sections.noReviewNeeded], ['posted', sections.posted], ['discarded', sections.discarded],
  ];
  return entries.flatMap(([kind, reviews]) => reviews.flatMap((review) => statedItem(teamState(review, kind), review.prCreatedAt, ({ action, kind: attention }) => (
    { source: 'team', key: `team:${review.key}`, prKey: comparablePrKey(review), kind, review, action, attention }
  ))));
}

function mineItems(prs: readonly MyPr[], sessionPrKeys: ReadonlySet<string>, isKeepMergeableEnabled: boolean): StatedItem[] {
  return sectionStackedMyPrs(prs).flatMap((section) => section.rows).flatMap((stackRow) => statedItem(mineState(stackRow.pr, sessionPrKeys, isKeepMergeableEnabled), stackRow.pr.createdAt, ({ action, kind: attention }) => (
    { source: 'mine', key: `mine:${stackRow.pr.key}`, prKey: comparablePrKey(stackRow.pr), pr: stackRow.pr, stackRow, action, attention }
  )));
}

function compareStatedItems(first: StatedItem, second: StatedItem): number {
  return first.row.rank - second.row.rank || first.openedAtMs - second.openedAtMs;
}

export function buildReviewQueue(sections: TeamReviewSections, myPrs: readonly MyPr[], sessionPrKeys: ReadonlySet<string>, isKeepMergeableEnabled: boolean): QueueGroup[] {
  const itemsByGroup = new Map<QueueGroupId, StatedItem[]>(GROUP_ORDER.map((id) => [id, []]));
  for (const stated of [...teamItems(sections), ...mineItems(myPrs, sessionPrKeys, isKeepMergeableEnabled)]) itemsByGroup.get(stated.row.group)?.push(stated);
  return GROUP_ORDER.map((id) => ({ id, title: GROUP_TITLES[id], items: (itemsByGroup.get(id) ?? []).toSorted(compareStatedItems).map((stated) => stated.item) }));
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

export function attentionTilesOf(groups: readonly QueueGroup[]): AttentionTile[] {
  return turnItems(groups).map((item) => ({ id: item.key, kind: item.attention ?? 'waiting', name: itemLabel(item) }));
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

export type ReviewDetailKeyAction = 'next-finding' | 'previous-finding' | 'toggle-finding' | 'open-session' | 'pick-approve' | 'pick-request-changes' | 'pick-comment' | 'post' | 'cancel';
export type ReviewKeyAction = 'next-row' | 'previous-row' | ReviewDetailKeyAction;

const REVIEW_LETTER_ACTIONS: ReadonlyMap<string, ReviewKeyAction> = new Map([
  ['j', 'next-row'], ['k', 'previous-row'], ['n', 'next-finding'], ['p', 'previous-finding'], ['x', 'toggle-finding'], ['o', 'open-session'],
  ['a', 'pick-approve'], ['r', 'pick-request-changes'], ['c', 'pick-comment'],
]);

interface ReviewKeyEvent { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

export function reviewKeyActionOf(event: ReviewKeyEvent): ReviewKeyAction | null {
  const isPostChord = event.key === 'Enter' && event.metaKey !== event.ctrlKey && !event.altKey && !event.shiftKey;
  if (isPostChord) return 'post';
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.key === 'Escape') return 'cancel';
  return REVIEW_LETTER_ACTIONS.get(event.key) ?? null;
}

export function steppedRowKey(rowKeys: readonly string[], selectedKey: string | null, step: 1 | -1): string | null {
  if (rowKeys.length === 0) return null;
  const index = selectedKey === null ? -1 : rowKeys.indexOf(selectedKey);
  if (index === -1) return step === 1 ? rowKeys[0] : rowKeys[rowKeys.length - 1];
  return rowKeys[Math.min(rowKeys.length - 1, Math.max(0, index + step))];
}
