import type { MyPr, MyPrAutoRebase, MyPrSearchNode, MyPrsStatus, MyPrStage, MyPrThread, MyPrThreadNode } from '../../shared/contracts/my-prs.ts';
import { prKey } from './team-review-core.ts';
import type { TeamReviewSettings } from './team-review-core.ts';

export const MY_PRS_LANE_ID = 'my-prs';
export const POLL_INTERVAL_MINUTES = 5;
export const MERGED_RETENTION_MS = 24 * 60 * 60 * 1000;

const STAGE_ORDER: MyPrStage[] = ['conflicts', 'behind', 'checks-failing', 'changes-requested', 'unresolved-threads', 'checks-pending', 'needs-approval', 'unknown', 'ready', 'draft', 'merged'];
const THREAD_EXCERPT_MAX_CHARACTERS = 200;
const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

export function mergedSinceDate(nowMs: number): string {
  return new Date(nowMs - MERGED_RETENTION_MS).toISOString().slice(0, 10);
}

export function deriveStage(pr: MyPr): MyPrStage {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.isDraft) return 'draft';
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return 'conflicts';
  if (pr.mergeStateStatus === 'BEHIND') return 'behind';
  if (pr.checks.state === 'FAILURE' || pr.checks.state === 'ERROR') return 'checks-failing';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested';
  if (pr.unresolvedThreads > 0) return 'unresolved-threads';
  if (pr.checks.state === 'PENDING' || pr.checks.state === 'EXPECTED') return 'checks-pending';
  if (pr.reviewDecision === 'REVIEW_REQUIRED' || pr.mergeStateStatus === 'BLOCKED') return 'needs-approval';
  if (pr.mergeable === 'MERGEABLE' && ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(pr.mergeStateStatus)) return 'ready';
  return 'unknown';
}

const CHECKS_STILL_RUNNING = new Set(['PENDING', 'EXPECTED']);

export function autoRebaseAttemptKey(node: Pick<MyPrSearchNode, 'repository' | 'number' | 'headRefOid'>): string {
  return `${node.repository.nameWithOwner}#${node.number}@${node.headRefOid}`;
}

export function shouldAutoRebase(node: MyPrSearchNode, behindBy: number | null, failedAttemptKeys: ReadonlySet<string>): boolean {
  if (node.state !== 'OPEN' || node.isDraft) return false;
  if (node.isInMergeQueue) return false;
  if (behindBy === null || behindBy === 0) return false;
  if (node.mergeable === 'CONFLICTING' || node.mergeStateStatus === 'DIRTY') return false;
  const checksState = node.commits.nodes.at(-1)?.commit.statusCheckRollup?.state ?? null;
  if (checksState !== null && CHECKS_STILL_RUNNING.has(checksState)) return false;
  return !failedAttemptKeys.has(autoRebaseAttemptKey(node));
}

export function autoRebaseRecord(rebase: { ok: boolean; err: string }, baseRefName: string, at: number): MyPrAutoRebase {
  if (rebase.ok) return { outcome: 'rebased', at, message: `Rebased onto ${baseRefName}` };
  const firstLine = rebase.err.split('\n').map((line) => line.trim()).find(Boolean) ?? 'GitHub refused the rebase';
  return { outcome: 'failed', at, message: firstLine };
}

export function hasUnresolvedThreads(node: MyPrSearchNode): boolean {
  return node.reviewThreads.pageInfo.hasNextPage || node.reviewThreads.nodes.some((thread) => !thread.isResolved);
}

export function threadExcerpt(bodyText: string): string {
  const characters = [...bodyText.replace(/\s+/g, ' ').trim()];
  if (characters.length <= THREAD_EXCERPT_MAX_CHARACTERS) return characters.join('');
  const truncated = characters.slice(0, THREAD_EXCERPT_MAX_CHARACTERS).join('');
  const lastSpace = truncated.lastIndexOf(' ');
  return `${(lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trimEnd()}...`;
}

export function toMyPrThreads(threadNodes: readonly MyPrThreadNode[], pullRequestUrl: string): MyPrThread[] {
  return threadNodes.flatMap((thread) => {
    if (thread.isResolved) return [];
    const firstComment = thread.firstComment.nodes[0];
    const lastComment = thread.lastComment.nodes[0] ?? firstComment;
    return [{
      path: thread.path, line: thread.line, isOutdated: thread.isOutdated, url: firstComment?.url ?? pullRequestUrl,
      author: firstComment?.author?.login ?? null, excerpt: threadExcerpt(firstComment?.bodyText ?? ''),
      commentCount: Math.max(1, thread.firstComment.totalCount),
      lastAuthor: lastComment?.author?.login ?? null, lastActivityAt: lastComment?.createdAt ?? '',
    }];
  });
}

export function toMyPr(node: MyPrSearchNode, behindBy: number | null, threadNodes: readonly MyPrThreadNode[] = []): MyPr {
  const contexts = node.commits.nodes.at(-1)?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const failing = contexts.flatMap((check) => {
    if (check.__typename === 'CheckRun' && check.conclusion && FAILING_CONCLUSIONS.has(check.conclusion)) return [check.name];
    if (check.__typename === 'StatusContext' && ['FAILURE', 'ERROR'].includes(check.state)) return [check.context];
    return [];
  });
  const pendingCount = contexts.filter((check) => {
    if (check.__typename === 'CheckRun') return check.status !== 'COMPLETED';
    return check.state === 'PENDING' || check.state === 'EXPECTED';
  }).length;
  const reviewRequests = node.reviewRequests.nodes.flatMap(({ requestedReviewer }) => {
    if (!requestedReviewer) return [];
    if (requestedReviewer.__typename === 'User') return [{ name: requestedReviewer.login, isTeam: false, avatarUrl: null }];
    if (requestedReviewer.__typename === 'Team') return [{ name: `${requestedReviewer.organization.login}/${requestedReviewer.slug}`, isTeam: true, avatarUrl: requestedReviewer.avatarUrl }];
    return [];
  });
  const threads = toMyPrThreads(threadNodes, node.url);
  const pr: MyPr = {
    key: prKey(node.repository.nameWithOwner, node.number), repo: node.repository.nameWithOwner, number: node.number,
    title: node.title, url: node.url, isDraft: node.isDraft, state: node.state, createdAt: node.createdAt, mergedAt: node.mergedAt,
    updatedAt: node.updatedAt, baseRefName: node.baseRefName, headRefName: node.headRefName, isCrossRepository: node.isCrossRepository, headRefOid: node.headRefOid, isInMergeQueue: node.isInMergeQueue,
    mergeMethod: node.repository.viewerDefaultMergeMethod, mergeable: node.mergeable,
    mergeStateStatus: node.mergeStateStatus, reviewDecision: node.reviewDecision,
    checks: { state: node.commits.nodes.at(-1)?.commit.statusCheckRollup?.state ?? null, failing, pendingCount },
    unresolvedThreads: Math.max(node.reviewThreads.nodes.filter((thread) => !thread.isResolved).length, threads.length),
    threads,
    behindBy, reviewRequests, approvals: node.latestOpinionatedReviews.nodes.filter((review) => review.state === 'APPROVED').length,
    reviews: node.latestReviews.nodes.map((review) => ({ reviewer: review.author?.login ?? null, state: review.state, submittedAt: review.submittedAt })),
    stage: 'unknown',
  };
  pr.stage = deriveStage(pr);
  return pr;
}

export function sortedMyPrs(prs: MyPr[], nowMs: number): MyPr[] {
  return prs.filter((pr) => {
    if (pr.state === 'CLOSED') return false;
    if (pr.state !== 'MERGED') return true;
    const mergedAtMs = Date.parse(pr.mergedAt ?? '');
    return Number.isFinite(mergedAtMs) && mergedAtMs >= nowMs - MERGED_RETENTION_MS;
  }).sort((left, right) => {
    const stageDifference = STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage);
    if (stageDifference !== 0) return stageDifference;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

export function truncatedSearchNote(returnedCount: number, totalCount: number): string | null {
  if (totalCount <= returnedCount) return null;
  return `Showing the ${returnedCount} most recently updated of ${totalCount} pull requests.`;
}

export function myPrsStatus({ ts, configured, reason = null, viewer = null, prs = [], error = null, truncatedNote = null }: {
  ts: number; configured: boolean; reason?: string | null; viewer?: string | null; prs?: MyPr[]; error?: string | null; truncatedNote?: string | null;
}): MyPrsStatus {
  return { type: 'my-prs-status', ts, configured, reason, viewer, prs, error, truncatedNote };
}

export function withAutoRebase(pr: MyPr, record: MyPrAutoRebase | undefined): MyPr {
  return record ? { ...pr, autoRebase: record } : pr;
}

export function myPrsShouldStart(settings: Pick<TeamReviewSettings, 'enabled' | 'org'>): { start: boolean; reason?: string } {
  if (!settings.enabled) return { start: false, reason: 'Team review is disabled' };
  if (!settings.org) return { start: false, reason: 'Team review needs an organization' };
  return { start: true };
}
