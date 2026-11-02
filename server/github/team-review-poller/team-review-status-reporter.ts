import * as core from '../core/team-review-core.ts';
import type { ReviewProgressEvent } from '../core/team-review-core.ts';
import type { InFlightReview } from '../../../shared/contracts/team-review.ts';
import type { TeamReviewPollerContext } from './team-review-poller-context.ts';

function createTeamReviewStatusReporter(context: TeamReviewPollerContext) {
  const { onTickComplete, now, setTimeoutFn, clearTimeoutFn, runtime, progressByKey, loop } = context;
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let pendingProgressEmit: NodeJS.Timeout | null = null;

  function inFlightKeys(): string[] {
    return Object.keys(runtime.state).filter((key) => runtime.state[key]?.inFlight);
  }

  function inFlightReviews(): InFlightReview[] {
    return inFlightKeys().flatMap((key) => {
      const progress = progressByKey.get(key);
      return progress ? [progress] : [];
    });
  }

  function cancelPendingProgressEmit(): void {
    if (pendingProgressEmit === null) return;
    clearTimeoutFn(pendingProgressEmit);
    pendingProgressEmit = null;
  }

  function emitStatus(): void {
    cancelPendingProgressEmit();
    lastEmitAt = now();
    onTickComplete({ ...core.teamReviewStatus({
      ts: now(), configured: true, team: runtime.teamProfile, drafts: core.draftsNewestFirst(runtime.state), inFlight: inFlightReviews(),
      queued: runtime.waitingForSlot.filter((candidate) => !runtime.state[candidate.key]?.inFlight),
    }), error: runtime.pollingError, ...loop.scheduleStatus() });
  }

  function progressReporter(key: string): (event: ReviewProgressEvent) => void {
    return (event) => {
      const progress = progressByKey.get(key);
      if (!progress) return;
      progressByKey.set(key, core.applyReviewProgress(progress, event, now()));
      emitProgressCoalesced();
    };
  }

  function emitProgressCoalesced(): void {
    if (pendingProgressEmit !== null || loop.isStopped()) return;
    const waitMs = lastEmitAt + core.PROGRESS_EMIT_INTERVAL_MS - now();
    if (waitMs <= 0) {
      emitStatus();
      return;
    }
    pendingProgressEmit = setTimeoutFn(() => {
      pendingProgressEmit = null;
      if (loop.isStopped()) return;
      emitStatus();
    }, waitMs);
  }

  return { inFlightKeys, cancelPendingProgressEmit, emitStatus, progressReporter };
}

type TeamReviewStatusReporter = ReturnType<typeof createTeamReviewStatusReporter>;

export { createTeamReviewStatusReporter };
export type { TeamReviewStatusReporter };
