import type { MyPr, MyPrSearchNode, MyPrsStatus, MyPrStage } from '../../shared/contracts/my-prs.ts';
import type { TeamReviewSettings } from './team-review-core.ts';

export const MY_PRS_LANE_ID = 'my-prs';
export const POLL_INTERVAL_MINUTES = 5;
export const MERGED_RETENTION_MS = 24 * 60 * 60 * 1000;

const STAGE_ORDER: MyPrStage[] = ['conflicts', 'behind', 'checks-failing', 'changes-requested', 'unresolved-threads', 'checks-pending', 'needs-approval', 'unknown', 'ready', 'draft', 'merged'];
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

export function toMyPr(node: MyPrSearchNode, behindBy: number | null): MyPr {
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
    if (requestedReviewer.__typename === 'User') return [requestedReviewer.login];
    if (requestedReviewer.__typename === 'Team') return [`${requestedReviewer.organization.login}/${requestedReviewer.slug}`];
    return [];
  });
  const pr: MyPr = {
    key: `${node.repository.nameWithOwner}#${node.number}`, repo: node.repository.nameWithOwner, number: node.number,
    title: node.title, url: node.url, isDraft: node.isDraft, state: node.state, mergedAt: node.mergedAt,
    updatedAt: node.updatedAt, baseRefName: node.baseRefName, mergeable: node.mergeable,
    mergeStateStatus: node.mergeStateStatus, reviewDecision: node.reviewDecision,
    checks: { state: node.commits.nodes.at(-1)?.commit.statusCheckRollup?.state ?? null, failing, pendingCount },
    unresolvedThreads: node.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    behindBy, reviewRequests, approvals: node.latestOpinionatedReviews.nodes.filter((review) => review.state === 'APPROVED').length,
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

export function myPrsShouldStart(settings: Pick<TeamReviewSettings, 'enabled' | 'org'>): { start: boolean; reason?: string } {
  if (!settings.enabled) return { start: false, reason: 'Team review is disabled' };
  if (!settings.org) return { start: false, reason: 'Team review needs an organization' };
  return { start: true };
}
