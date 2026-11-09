import { comparablePrKey } from '../../../shared/contracts/github-prs.ts';
import type { GithubStoreRead } from '../github-store-poller.ts';
import * as core from '../core/team-review-core.ts';
import type { TeamReviewCandidate } from '../core/team-review-core.ts';
import { firstLine } from '../../lanes/ephemeral-session.ts';
import type { PrDetail, TeamReviewStateEntry } from '../../../shared/contracts/team-review.ts';
import { errorMessage } from '../../../shared/text.ts';
import type { NotMineOutcome, ReviewOutcome, SpawnReviewArgs, TeamReviewPollerContext } from './team-review-poller-context.ts';
import type { TeamReviewStatusReporter } from './team-review-status-reporter.ts';
import type { TeamReviewHeadPlanning } from './team-review-head-planning.ts';
import type { TeamReviewCandidateSearch } from './team-review-candidate-search.ts';

function createTeamReviewRuns(
  context: TeamReviewPollerContext,
  statusReporter: TeamReviewStatusReporter,
  headPlanning: TeamReviewHeadPlanning,
  candidateSearch: TeamReviewCandidateSearch,
) {
  const { store, spawnReview, discardResumable, log, telemetry, now, maxConcurrentReviews, runtime, progressByKey, reviewCancellersByKey, notMineWhileReviewingKeys, loop, persist } = context;
  const { emitStatus, inFlightKeys, progressReporter } = statusReporter;
  const { entryFor } = headPlanning;
  const { watchAskedFor } = candidateSearch;

  async function runReview(args: SpawnReviewArgs): Promise<void> {
    const outcome = await spawnReview(args).catch((error: unknown) => core.errorDraft({
      candidate: args.candidate, tier: args.tier, reasons: args.reasons,
      reviewedHead: args.detail.headRefOid, error: firstLine(errorMessage(error)) || 'review crashed',
    }));
    const entry = entryFor(args.candidate.key);
    entry.inFlight = false;
    runtime.hasSlotFreedSinceSlotCount = true;
    progressByKey.delete(args.candidate.key);
    reviewCancellersByKey.delete(args.candidate.key);
    if (notMineWhileReviewingKeys.delete(args.candidate.key)) {
      await settleNotMineReview(entry, args, outcome);
      return;
    }
    if ('kind' in outcome) {
      if (outcome.resumable) entry.resumable = outcome.resumable;
      await persist();
      emitStatus();
      return;
    }
    const draft = outcome;
    const wasRequeuedAtReviewedHead = entry.requeuedHead === draft.reviewedHead;
    entry.resumable = null;
    if (draft.status !== 'error') {
      delete entry.requeuedHead;
      delete entry.discardedReviewHead;
    }
    entry.reviewAttempts = core.reviewAttemptsAfter(entry, draft.reviewedHead);
    entry.draft = {
      ...draft,
      ...(args.candidate.prCreatedAt ? { prCreatedAt: args.candidate.prCreatedAt } : {}),
      ...(args.priorReview ? { priorReviewedHead: args.priorReview.head } : {}),
      ...(wasRequeuedAtReviewedHead ? { requeuedHead: draft.reviewedHead } : {}),
    };
    entry.reviewedHead = draft.reviewedHead;
    entry.updatedAt = now();
    entry.reviewedAt = entry.updatedAt;
    entry.draft.reviewedAt = entry.reviewedAt;
    await persist();
    emitStatus();
    if (draft.status === 'ready') telemetry?.capture('team_review_drafted', { inline_comment_count: draft.comments.length });
    if (runtime.waitingForSlot.length > 0 && !loop.isStopped()) void loop.tick();
  }

  async function settleNotMineReview(entry: TeamReviewStateEntry, args: SpawnReviewArgs, outcome: ReviewOutcome): Promise<void> {
    if ('kind' in outcome && outcome.resumable) await discardResumable(outcome.resumable);
    entry.resumable = null;
    const discardedReview = 'kind' in outcome || outcome.status === 'error' ? null : core.draftAfter(outcome, 'not_mine');
    entry.draft = discardedReview ?? core.notMineDraft(args.candidate, args.detail.headRefOid);
    entry.reviewedHead = entry.draft.reviewedHead;
    await settleNotMine(args.candidate.key, entry);
    if (runtime.waitingForSlot.length > 0 && !loop.isStopped()) void loop.tick();
  }

  function leaveSlotQueue(key: string): void {
    runtime.waitingForSlot = runtime.waitingForSlot.filter((queued) => queued.key !== key);
  }

  async function readCandidateDetail(candidate: TeamReviewCandidate): Promise<GithubStoreRead<PrDetail | null>> {
    const snapshotHead = store.getSnapshot().prs[comparablePrKey(candidate)]?.headRefOid;
    const headRead = snapshotHead ? { isRateLimited: false as const, value: snapshotHead } : await store.requestPrHead(candidate.repo, candidate.number, 'no-wait');
    if (headRead.isRateLimited) return headRead;
    if (headRead.value === null) return { isRateLimited: false, value: null };
    return store.requestPrView(candidate.repo, candidate.number, headRead.value, 'no-wait');
  }

  async function startReviews(queue: TeamReviewCandidate[]): Promise<boolean> {
    runtime.hasSlotFreedSinceSlotCount = false;
    let freeSlots = maxConcurrentReviews - inFlightKeys().length;
    let isDirty = false;
    runtime.waitingForSlot = queue.filter((queued) => runtime.state[queued.key]?.draft?.status !== 'discarded');
    for (const candidate of queue) {
      if (loop.isStopped()) {
        runtime.waitingForSlot = [];
        break;
      }
      if (freeSlots <= 0) break;
      const detailRead = await readCandidateDetail(candidate);
      if (detailRead.isRateLimited) {
        runtime.tickRateLimitWaitMs = detailRead.waitMs;
        break;
      }
      const detail = detailRead.value;
      if (!detail) {
        leaveSlotQueue(candidate.key);
        continue;
      }
      const triage = core.triagePr(detail);
      const entry = entryFor(candidate.key);
      const resumeAction = core.resumeDecision(entry, detail.headRefOid, now());
      const resume = resumeAction === 'resume' ? entry.resumable ?? undefined : undefined;
      if (resumeAction === 'discard' && entry.resumable) await discardResumable(entry.resumable);
      if (resumeAction !== 'none') {
        entry.resumable = null;
        await persist();
      }
      leaveSlotQueue(candidate.key);
      if (entry.draft?.status === 'discarded') {
        if (resume) await discardResumable(resume);
        continue;
      }
      entry.updatedAt = now();
      isDirty = true;
      const priorReview = core.priorReviewFor(entry, detail.headRefOid) ?? undefined;
      const earlierReviewKept = core.earlierReviewToKeep(entry, detail.headRefOid);
      const sameHeadReview = !priorReview && earlierReviewKept?.head === detail.headRefOid ? earlierReviewKept : undefined;
      delete entry.priorReview;
      if (earlierReviewKept) entry.priorReview = earlierReviewKept;
      entry.inFlight = true;
      freeSlots -= 1;
      const reviewCanceller = new AbortController();
      reviewCancellersByKey.set(candidate.key, reviewCanceller);
      progressByKey.set(candidate.key, core.startReviewProgress({
        candidate, tier: triage.tier, reasons: triage.reasons, head: detail.headRefOid, at: now(), priorReviewedHead: priorReview?.head,
      }));
      const args: SpawnReviewArgs = {
        candidate, detail, tier: triage.tier, reasons: triage.reasons, resume, priorReview, sameHeadReview, reportProgress: progressReporter(candidate.key), signal: reviewCanceller.signal,
      };
      loop.track(runReview(args).catch((error: unknown) => {
        log.warn(`[${core.TEAM_REVIEW_LANE_ID}] review crashed for ${candidate.key}: ${errorMessage(error)}`);
      }));
    }
    return isDirty;
  }

  async function settleNotMine(key: string, entry: TeamReviewStateEntry): Promise<NotMineOutcome> {
    delete entry.requeuedHead;
    delete entry.requestedAt;
    watchAskedFor();
    entry.updatedAt = now();
    runtime.waitingForSlot = runtime.waitingForSlot.filter((queued) => queued.key !== key);
    const abandonedResumable = entry.resumable;
    if (abandonedResumable) {
      entry.resumable = null;
      await discardResumable(abandonedResumable);
    }
    await persist();
    emitStatus();
    return { ok: true };
  }

  return { startReviews, settleNotMine };
}

type TeamReviewRuns = ReturnType<typeof createTeamReviewRuns>;

export { createTeamReviewRuns };
export type { TeamReviewRuns };
