import type { PlanReviewState } from '#shared/contracts/plan-review.ts';

export function latestPendingReview(state: PlanReviewState) {
  return state.reviews.filter((review) => review.state === 'open' && review.openRevision !== null)
    .sort((first, second) => (second.openRevision?.since ?? 0) - (first.openRevision?.since ?? 0))[0] ?? null;
}
