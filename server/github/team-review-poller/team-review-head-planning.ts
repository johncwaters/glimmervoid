import { comparablePrKey } from '../../../shared/contracts/github-prs.ts';
import type { GithubPr } from '../../../shared/contracts/github-prs.ts';
import * as core from '../core/team-review-core.ts';
import type { TeamReviewCandidate } from '../core/team-review-core.ts';
import { hasStandingViewerApproval } from '../../../shared/contracts/team-review.ts';
import type { TeamReviewStateEntry } from '../../../shared/contracts/team-review.ts';
import type { TeamReviewPollerContext } from './team-review-poller-context.ts';

function createTeamReviewHeadPlanning(context: TeamReviewPollerContext) {
  const { now, reReviewAfterMs, runtime } = context;

  function entryFor(key: string): TeamReviewStateEntry {
    const existing = runtime.state[key];
    if (existing) return existing;
    const created: TeamReviewStateEntry = { draft: null, reviewedHead: null, inFlight: false, reviewAttempts: 0, updatedAt: now() };
    runtime.state[key] = created;
    return created;
  }

  function headsToReview(candidates: TeamReviewCandidate[], prsByKey: ReadonlyMap<string, GithubPr>): { queue: TeamReviewCandidate[]; isDirty: boolean } {
    const queue: TeamReviewCandidate[] = [];
    let isDirty = false;
    for (const candidate of candidates) {
      let entry = runtime.state[candidate.key];
      if (entry?.inFlight) continue;
      const pr = prsByKey.get(comparablePrKey(candidate));
      if (!pr) continue;
      const snapshot = core.reviewSnapshotFromGithubPr(pr);
      const head = snapshot.head;
      const githubReviews = core.githubReviewsFrom(snapshot.reviews, runtime.self ?? '');
      const githubReviewHistory = core.earlierGithubReviews(core.githubReviewsFrom(snapshot.reviewHistory, runtime.self ?? ''), githubReviews);
      const reviewDecision = snapshot.reviewDecision ?? null;
      candidate.reviewDecision = reviewDecision;
      candidate.isDraft = snapshot.isDraft;
      candidate.checksState = snapshot.checksState;
      const isReviewedByViewer = core.hasViewerReviewedAt(githubReviews, head) || hasStandingViewerApproval({ githubReviews, reviewDecision });
      if (!entry && !githubReviews.some((review) => review.isViewer)) {
        queue.push(candidate);
        continue;
      }
      if (!entry) {
        entry = entryFor(candidate.key);
        entry.reviewedHead = isReviewedByViewer ? head : null;
        isDirty = true;
      }
      if (entry.draft) {
        const priority = { requestSource: candidate.requestSource, isDraft: candidate.isDraft, checksState: candidate.checksState, reviewDecision };
        const previousPriority = { requestSource: entry.draft.requestSource, isDraft: entry.draft.isDraft, checksState: entry.draft.checksState, reviewDecision: entry.draft.reviewDecision ?? null };
        if (JSON.stringify(priority) !== JSON.stringify(previousPriority)) {
          entry.draft = { ...entry.draft, ...priority };
          isDirty = true;
        }
      }
      if (entry.draft && candidate.prCreatedAt && entry.draft.prCreatedAt !== candidate.prCreatedAt) {
        entry.draft.prCreatedAt = candidate.prCreatedAt;
        isDirty = true;
      }
      if (!core.isSameGithubReviews(entry.githubReviews, githubReviews)) {
        entry.githubReviews = githubReviews;
        isDirty = true;
      }
      if (!core.isSameGithubReviews(entry.githubReviewHistory, githubReviewHistory)) {
        entry.githubReviewHistory = githubReviewHistory;
        isDirty = true;
      }
      if ((entry.reviewDecision ?? null) !== reviewDecision) {
        entry.reviewDecision = reviewDecision;
        isDirty = true;
      }
      if (entry.liveHead !== head) {
        entry.liveHead = head;
        isDirty = true;
      }
      const isRequeuePending = entry.requeuedHead !== undefined && entry.reviewedHead === null;
      if (isRequeuePending && entry.requeuedHead !== head) {
        entry.requeuedHead = head;
        isDirty = true;
      }
      if (core.restoreDraftAtReviewedHead(entry, head, now())) isDirty = true;
      const canAutoReview = core.shouldAutoReview(entry, head, now(), reReviewAfterMs);
      if (entry.reviewedHead !== head && entry.draft?.status === 'ready') entry.reviewedAt ??= entry.updatedAt;
      if (entry.reviewedHead !== head && core.markDraftStale(entry, now())) isDirty = true;
      if (!canAutoReview || (isReviewedByViewer && entry.requeuedHead !== head)) continue;
      queue.push(candidate);
    }
    return { queue, isDirty };
  }

  return { entryFor, headsToReview };
}

type TeamReviewHeadPlanning = ReturnType<typeof createTeamReviewHeadPlanning>;

export { createTeamReviewHeadPlanning };
export type { TeamReviewHeadPlanning };
