import { comparablePrKey } from '../../../shared/contracts/github-prs.ts';
import { pullRequestKeyFromReference } from '../../../shared/contracts/control-messages.ts';
import { githubStoreRateLimitedError } from '../github-store-poller.ts';
import { hasPresentableThreads, isThreadPlaceholderDraft } from '../core/team-review-threads-core.ts';
import * as core from '../core/team-review-core.ts';
import { ReviewDraft } from '../../../shared/contracts/team-review.ts';
import type { ReviewDraft as ReviewDraftType, TeamReviewStateEntry } from '../../../shared/contracts/team-review.ts';
import { REQUEUEABLE_STATUSES, REQUEUE_REFUSAL } from './team-review-poller-context.ts';
import type { DraftExpectation, DraftPatch, NotMineOutcome, ReviewRequestOutcome, TeamReviewPollerContext } from './team-review-poller-context.ts';
import type { TeamReviewStatusReporter } from './team-review-status-reporter.ts';
import type { TeamReviewHeadPlanning } from './team-review-head-planning.ts';
import type { TeamReviewCandidateSearch } from './team-review-candidate-search.ts';
import type { TeamReviewRuns } from './team-review-runs.ts';

function createTeamReviewOperatorActions(
  context: TeamReviewPollerContext,
  statusReporter: TeamReviewStatusReporter,
  headPlanning: TeamReviewHeadPlanning,
  candidateSearch: TeamReviewCandidateSearch,
  reviewRuns: TeamReviewRuns,
) {
  const { store, now, runtime, reviewCancellersByKey, notMineWhileReviewingKeys, loop, persist } = context;
  const { emitStatus } = statusReporter;
  const { entryFor } = headPlanning;
  const { isTeamCandidate, askedForSlotsInUse, watchAskedFor } = candidateSearch;
  const { settleNotMine } = reviewRuns;

  function getDraft(key: string): ReviewDraftType | null {
    const entry = runtime.state[key];
    if (!entry?.draft) return null;
    return { ...entry.draft, threads: entry.threads, viewerThreads: entry.viewerThreads, liveHead: entry.liveHead ?? entry.draft.liveHead };
  }

  async function updateDraft(key: string, expected: DraftExpectation, patch: DraftPatch): Promise<ReviewDraftType | null> {
    const entry = runtime.state[key];
    if (!entry?.draft) return null;
    if (entry.draft.reviewedHead !== expected.reviewedHead || entry.draft.status !== expected.status) return null;
    const postedAt = patch.status === 'posted' ? { postedAt: now() } : {};
    const parsed = ReviewDraft.safeParse({ ...entry.draft, ...patch, ...postedAt, key: entry.draft.key, repo: entry.draft.repo, number: entry.draft.number });
    if (!parsed.success) return null;
    entry.draft = parsed.data;
    entry.updatedAt = now();
    await persist();
    emitStatus();
    return parsed.data;
  }

  async function updateThread(key: string, threadId: string, patch: { isResolved?: boolean; resolveError?: string }): Promise<boolean> {
    const entry = runtime.state[key];
    const thread = entry?.threads?.find((thread) => thread.id === threadId);
    if (!entry || !thread) return false;
    Object.assign(thread, patch);
    if (patch.isResolved) delete thread.resolveError;
    if (!hasPresentableThreads(entry.threads ?? []) && isThreadPlaceholderDraft(entry.draft)) entry.draft = null;
    await persist();
    emitStatus();
    return true;
  }

  async function requeue(key: string, head: string): Promise<boolean> {
    const entry = runtime.state[key];
    if (!entry?.draft || entry.inFlight || entry.draft.reviewedHead !== head) return false;
    if (!REQUEUEABLE_STATUSES.has(entry.draft.status)) return false;
    entry.reviewAttempts = 0;
    entry.reviewedHead = null;
    entry.requeuedHead = entry.liveHead ?? head;
    if (core.isUnreviewedDraft(entry.draft)) entry.draft = null;
    const requeuedDraft = entry.draft ? core.draftAfter(entry.draft, 'requeued') : null;
    if (entry.draft && requeuedDraft) {
      entry.discardedReviewHead = entry.draft.reviewedHead;
      entry.draft = requeuedDraft;
    }
    core.markDraftStale(entry, now());
    entry.updatedAt = now();
    await persist();
    emitStatus();
    loop.tickSoon();
    return true;
  }

  async function restore(key: string, head: string): Promise<boolean> {
    const entry = runtime.state[key];
    const draft = entry?.draft;
    if (!entry || !draft || entry.inFlight || draft.status !== 'discarded' || draft.reviewedHead !== head) return false;
    const isFinishedReviewAtEntryHead = !core.isUnreviewedDraft(draft) && draft.error === undefined && entry.reviewedHead === draft.reviewedHead;
    if (!isFinishedReviewAtEntryHead) return requeue(key, head);
    const hasHeadMoved = entry.liveHead !== undefined && entry.liveHead !== draft.reviewedHead;
    const restoredDraft = core.draftAfter(draft, hasHeadMoved ? 'restored_moved' : 'restored_current');
    if (!restoredDraft) return false;
    entry.draft = restoredDraft;
    entry.updatedAt = now();
    await persist();
    emitStatus();
    return true;
  }

  function cancelReviewAsNotMine(key: string): NotMineOutcome {
    notMineWhileReviewingKeys.add(key);
    reviewCancellersByKey.get(key)?.abort();
    return { ok: true };
  }

  async function markNotMine(key: string): Promise<NotMineOutcome> {
    const entry = runtime.state[key];
    if (entry?.inFlight) return cancelReviewAsNotMine(key);
    if (entry?.draft?.status === 'posted') return { ok: false, error: 'That review was already posted' };
    if (entry?.draft && !isThreadPlaceholderDraft(entry.draft)) {
      const discardedDraft = core.draftAfter(entry.draft, 'not_mine');
      if (!discardedDraft) return { ok: false, error: 'That review was already posted' };
      entry.draft = discardedDraft;
      return settleNotMine(key, entry);
    }
    const candidate = runtime.waitingForSlot.find((queued) => queued.key === key) ?? entry?.draft ?? undefined;
    if (!candidate) return { ok: false, error: 'That pull request is no longer in the review queue' };
    const knownHead = entry?.liveHead ?? store.getSnapshot().prs[comparablePrKey(candidate)]?.headRefOid;
    const headRead = knownHead ? { isRateLimited: false as const, value: knownHead } : await store.requestPrHead(candidate.repo, candidate.number, 'no-wait');
    if (headRead.isRateLimited) return { ok: false, error: githubStoreRateLimitedError(headRead.waitMs) };
    const head = headRead.value;
    if (!head) return { ok: false, error: 'Could not read the pull request head from GitHub' };
    if (runtime.state[key]?.inFlight) return cancelReviewAsNotMine(key);
    const notMineEntry = entryFor(key);
    notMineEntry.draft = core.notMineDraft(candidate, head);
    notMineEntry.reviewedHead = head;
    return settleNotMine(key, notMineEntry);
  }

  async function markAskedFor(key: string, entry: TeamReviewStateEntry): Promise<void> {
    if (!isTeamCandidate(key)) entry.requestedAt ??= now();
    entry.updatedAt = now();
    watchAskedFor();
    await persist();
    emitStatus();
    loop.tickSoon();
  }

  async function requestKnownReview(key: string, entry: TeamReviewStateEntry): Promise<ReviewRequestOutcome> {
    if (entry.inFlight) return { ok: true, key, status: 'running' };
    if (entry.draft && !isThreadPlaceholderDraft(entry.draft)) {
      if (!await requeue(key, entry.draft.reviewedHead)) return { ok: false, error: REQUEUE_REFUSAL };
      await markAskedFor(key, entry);
      return { ok: true, key, status: 'queued' };
    }
    if (entry.reviewedHead !== null) {
      entry.reviewedHead = null;
      entry.reviewAttempts = 0;
      if (entry.liveHead) entry.requeuedHead = entry.liveHead;
    }
    await markAskedFor(key, entry);
    return { ok: true, key, status: 'queued' };
  }

  async function requestReview(reference: { repo: string; number: number }): Promise<ReviewRequestOutcome> {
    if (loop.isStopped() || !runtime.hasLoadedState) return { ok: false, error: 'Team review is not running' };
    const findKnownKey = () => Object.keys(runtime.state).find((key) => key.toLowerCase() === comparablePrKey(reference));
    const knownKey = findKnownKey();
    const knownEntry = knownKey === undefined ? undefined : runtime.state[knownKey];
    if (knownKey !== undefined && knownEntry) return requestKnownReview(knownKey, knownEntry);
    if (!isTeamCandidate(comparablePrKey(reference)) && askedForSlotsInUse() >= core.MAX_ASKED_FOR_REVIEWS) {
      return { ok: false, error: `at most ${core.MAX_ASKED_FOR_REVIEWS} pull requests outside your teams can wait for a review at once, and one frees when its review is posted or the operator marks it Not mine in the Reviews tab` };
    }
    const label = core.prKey(reference.repo, reference.number);
    const headRead = await store.requestPrHead(reference.repo, reference.number, 'no-wait');
    if (headRead.isRateLimited) return { ok: false, error: githubStoreRateLimitedError(headRead.waitMs) };
    if (headRead.value === null) return { ok: false, error: `could not read ${label} from GitHub` };
    const detailRead = await store.requestPrView(reference.repo, reference.number, headRead.value, 'no-wait');
    if (detailRead.isRateLimited) return { ok: false, error: githubStoreRateLimitedError(detailRead.waitMs) };
    const detail = detailRead.value;
    if (!detail) return { ok: false, error: `could not read ${label} from GitHub` };
    const refusal = core.askedForRefusal(detail, runtime.self);
    if (refusal) return { ok: false, error: `${label} cannot be reviewed: ${refusal}` };
    const raceKey = findKnownKey();
    const raceEntry = raceKey === undefined ? undefined : runtime.state[raceKey];
    if (raceKey !== undefined && raceEntry) return requestKnownReview(raceKey, raceEntry);
    const key = pullRequestKeyFromReference(detail.url) ?? label;
    const entry = entryFor(key);
    entry.liveHead = detail.headRefOid;
    entry.requeuedHead = detail.headRefOid;
    await markAskedFor(key, entry);
    return { ok: true, key, status: 'queued' };
  }

  return { getDraft, updateDraft, updateThread, requeue, restore, requestReview, markNotMine };
}

export { createTeamReviewOperatorActions };
