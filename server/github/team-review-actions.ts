import type { GithubLaneStore } from './github-store-wiring.ts';
import type { GithubStoreRead } from './github-store-poller.ts';
import { githubStoreRateLimitedError } from './github-store-poller.ts';
import { comparablePrKey } from '../../shared/contracts/github-prs.ts';
import * as core from './core/team-review-core.ts';
import { firstLine } from '../lanes/ephemeral-session.ts';
import { isThreadPlaceholderDraft } from './core/team-review-threads-core.ts';
import { TeamReviewActionRequest as ActionRequestSchema } from '../../shared/contracts/team-review.ts';
import type { TeamReviewPostRefusalReason, TeamReviewSettledOutcome } from '../../shared/contracts/telemetry.ts';
import type { Telemetry } from '../telemetry.ts';
import type { PrGh } from './pr-gh.ts';
import type { DraftExpectation, DraftPatch, NotMineOutcome } from './team-review-poller.ts';
import type { ReviewComment, ReviewDraft, TeamReviewActionRequest, TeamReviewActionResult } from '../../shared/contracts/team-review.ts';
import { errorMessage } from '../../shared/text.ts';
import { withAutomatedNote } from '../../shared/team-review-markdown.ts';
import { shortSha } from '../../shared/git-text.ts';
import { clock } from '../../shared/clock.ts';

const REPLACED_DRAFT_ERROR = 'The draft was replaced after it was shown. Read the new draft before acting on it';

const STALE_APPROVAL_DISMISSAL = 'The pull request moved while this approval was posting, so it no longer covers the current head.';

const UNMARKED_POST_WARNING = 'The review was posted on GitHub, but its draft could not be marked posted. Do not post it again';

type TeamReviewActionOutcome = Omit<TeamReviewActionResult, 'key'>;

interface TeamReviewDraftStore {
  getDraft(key: string): ReviewDraft | null;
  updateDraft(key: string, expected: DraftExpectation, patch: DraftPatch): Promise<ReviewDraft | null>;
  requeue(key: string, head: string): Promise<boolean>;
  restore(key: string, head: string): Promise<boolean>;
  markNotMine(key: string): Promise<NotMineOutcome>;
  updateThread?: (key: string, threadId: string, patch: { isResolved?: boolean; resolveError?: string }) => Promise<boolean>;
}

type TeamReviewActionGithub = Pick<PrGh, 'postReview' | 'dismissReview'> & Partial<Pick<PrGh, 'resolveReviewThread'>>;

interface TeamReviewActionOptions {
  now?: () => number;
  drafts: TeamReviewDraftStore;
  github: TeamReviewActionGithub;
  store: Pick<GithubLaneStore, 'requestPrHead' | 'requestPrDiff' | 'requestTeamReviewThreads'>;
  log?: Pick<Console, 'warn'>;
  telemetry?: Pick<Telemetry, 'capture'> | null;
  requestPrRefresh?: (key: string) => void;
}

const SETTLED_OUTCOME_BY_ACTION: Partial<Record<TeamReviewActionRequest['action'], TeamReviewSettledOutcome>> = {
  approve: 'approve', 'approve-only': 'approve-only', comment: 'comment', 'request-changes': 'request-changes',
};

interface PostRefusal {
  reason: TeamReviewPostRefusalReason;
  error: string;
}

function describeInvalidComments(comments: readonly ReviewComment[]): string {
  const locations = comments.map((comment) => `${comment.path}:${comment.line} (${comment.side})`).join(', ');
  return `These inline comments are not on lines in the diff, remove them and retry: ${locations}`;
}

const DRAFTED_REVIEW_STATUSES: ReadonlySet<ReviewDraft['status']> = new Set(['ready', 'error', 'stale']);

function isDraftedReview(draft: ReviewDraft | null): draft is ReviewDraft {
  return draft !== null && DRAFTED_REVIEW_STATUSES.has(draft.status) && !isThreadPlaceholderDraft(draft);
}

function createTeamReviewActions({ drafts, github, store, log = console, telemetry = null, requestPrRefresh, now = clock.nowMs }: TeamReviewActionOptions) {
  const actionsInFlight = new Set<string>();

  interface ActionTiming {
    steps: string[];
    refusalReason?: TeamReviewPostRefusalReason;
    settled?: { outcome: TeamReviewSettledOutcome; draft: ReviewDraft | null; postedCommentCount: number };
  }

  async function timeStep<Value>(timing: ActionTiming, name: string, work: () => Promise<Value>): Promise<Value> {
    const startedAt = now();
    try {
      return await work();
    } finally {
      timing.steps.push(`${name} wait 0 run ${Math.max(0, Math.round(now() - startedAt))}`);
    }
  }

  async function readStep<Value>(timing: ActionTiming, name: string, work: () => Promise<GithubStoreRead<Value>>): Promise<GithubStoreRead<Value>> {
    const startedAt = now();
    let read: GithubStoreRead<Value> | undefined;
    try {
      read = await work();
      return read;
    } finally {
      const queueWaitMs = Math.max(0, Math.round(read?.queueWaitMs ?? 0));
      const runMs = Math.max(0, Math.round(read?.readMs ?? (now() - startedAt - queueWaitMs)));
      timing.steps.push(`${name} wait ${queueWaitMs} run ${runMs}`);
    }
  }

  function refusePost(timing: ActionTiming, { reason, error }: PostRefusal): TeamReviewActionOutcome {
    timing.refusalReason = reason;
    return { ok: false, error };
  }

  function captureSettled(outcome: TeamReviewSettledOutcome, draft: ReviewDraft | null, postedCommentCount: number, durationMs: number): void {
    telemetry?.capture('team_review_settled', {
      outcome,
      duration_ms: durationMs,
      drafted_comment_count: draft?.comments.length ?? 0,
      posted_comment_count: postedCommentCount,
    });
  }

  async function markDraft(timing: ActionTiming, key: string, draft: ReviewDraft, event: 'head_moved' | 'posted', fields: DraftPatch = {}): Promise<ReviewDraft | null> {
    const nextStatus = core.nextDraftStatus(draft.status, event);
    if (!nextStatus) {
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] could not mark ${key} on ${event}, a ${draft.status} draft cannot move that way`);
      return null;
    }
    const updated = await timeStep(timing, 'mark', () => drafts.updateDraft(key, { reviewedHead: draft.reviewedHead, status: draft.status }, { ...fields, status: nextStatus }));
    if (!updated) log.warn(`[${core.TEAM_REVIEW_LANE_ID}] could not mark ${key} ${nextStatus}, the draft changed underneath the action`);
    return updated;
  }

  async function markNotMine(timing: ActionTiming, request: TeamReviewActionRequest): Promise<TeamReviewActionOutcome> {
    const draft = drafts.getDraft(request.key);
    if (request.head !== undefined && draft?.reviewedHead !== request.head) return { ok: false, error: REPLACED_DRAFT_ERROR };
    const outcome = await drafts.markNotMine(request.key);
    if (outcome.ok && isDraftedReview(draft)) timing.settled = { outcome: 'discarded', draft, postedCommentCount: 0 };
    return outcome;
  }

  async function restoreNotMine(timing: ActionTiming, key: string, draft: ReviewDraft): Promise<TeamReviewActionOutcome> {
    if (draft.status !== 'discarded') return { ok: false, error: 'Only a parked pull request can be restored' };
    if (!await drafts.restore(key, draft.reviewedHead)) return { ok: false, error: REPLACED_DRAFT_ERROR };
    if (!core.isUnreviewedDraft(draft) && !isThreadPlaceholderDraft(draft)) timing.settled = { outcome: 'restored', draft, postedCommentCount: 0 };
    return { ok: true };
  }

  async function misplacedCommentsRefusal(timing: ActionTiming, draft: ReviewDraft, comments: readonly ReviewComment[]): Promise<PostRefusal | null> {
    if (comments.length === 0) return null;
    const diffRead = await readStep(timing, 'diff', () => store.requestPrDiff(draft.repo, draft.number, draft.reviewedHead, 'priority'));
    if (diffRead.isRateLimited) return { reason: 'rate-limited', error: githubStoreRateLimitedError(diffRead.waitMs) };
    const diff = diffRead.value;
    if (diff === null) return { reason: 'diff-unreadable', error: 'Could not fetch the diff to check the inline comments. Remove them to post without them' };
    const misplaced = core.invalidComments(comments, core.commentableLines(diff));
    return misplaced.length > 0 ? { reason: 'misplaced-comments', error: describeInvalidComments(misplaced) } : null;
  }

  async function retractApproval(timing: ActionTiming, key: string, draft: ReviewDraft, movedHead: string, reviewId: number | null): Promise<TeamReviewActionOutcome> {
    if (draft.status !== 'posted') await markDraft(timing, key, draft, 'head_moved');
    const moved = `The pull request moved to ${shortSha(movedHead)} while the approval was posting`;
    if (reviewId === null) return { ok: false, error: `${moved}, and GitHub did not return the review id, so the approval still stands. Dismiss it on GitHub` };
    const dismissal = await timeStep(timing, 'dismiss', () => github.dismissReview({ repo: draft.repo, number: draft.number, reviewId, message: STALE_APPROVAL_DISMISSAL }));
    if (!dismissal.ok) return { ok: false, error: `${moved}, and dismissing the approval failed (${firstLine(dismissal.err)}), so it still stands. Dismiss it on GitHub` };
    requestPrRefresh?.(comparablePrKey(draft));
    const nextStep = draft.status === 'posted' ? 'Queue a review to look at the new commits' : 'It will be reviewed again';
    return { ok: false, error: `${moved}, so the approval was dismissed. ${nextStep}` };
  }

  async function post(timing: ActionTiming, key: string, draft: ReviewDraft, request: TeamReviewActionRequest): Promise<TeamReviewActionOutcome> {
    const event = core.eventForAction(request.action);
    if (!event) return refusePost(timing, { reason: 'unknown-action', error: 'Unknown review action' });
    if (!core.isPostableStatus(draft, event)) return refusePost(timing, { reason: 'not-postable', error: `The draft is ${draft.status}, so it cannot be posted` });
    const isFollowUpApproval = draft.status === 'posted';
    const body = request.action === 'approve-only' ? '' : request.body;
    const comments = request.action === 'approve-only' ? [] : request.comments;
    if (isFollowUpApproval && comments.length > 0) return refusePost(timing, { reason: 'comments-already-posted', error: 'The inline comments were already posted, so the approval cannot carry them again' });
    if (event !== 'APPROVE' && !body.trim() && comments.length === 0) {
      return refusePost(timing, { reason: 'empty-comment', error: 'A comment or change request needs a body or an inline comment' });
    }
    const liveHeadRead = await readStep(timing, 'head-before-post', () => store.requestPrHead(draft.repo, draft.number, 'priority'));
    if (liveHeadRead.isRateLimited) return refusePost(timing, { reason: 'rate-limited', error: githubStoreRateLimitedError(liveHeadRead.waitMs) });
    const liveHead = liveHeadRead.value;
    if (!liveHead) return refusePost(timing, { reason: 'head-unreadable', error: 'Could not read the pull request head from GitHub' });
    if (!core.canPost(draft, draft.reviewedHead, liveHead, event)) {
      if (isFollowUpApproval) return refusePost(timing, { reason: 'head-moved', error: `The pull request moved to ${shortSha(liveHead)} after the comments were posted, so nothing was approved. Queue a review to look at the new commits` });
      await markDraft(timing, key, draft, 'head_moved');
      return refusePost(timing, { reason: 'head-moved', error: `The pull request moved to ${shortSha(liveHead)} after this review, so nothing was posted. It will be reviewed again` });
    }
    const commentsRefusal = await misplacedCommentsRefusal(timing, draft, comments);
    if (commentsRefusal) return refusePost(timing, commentsRefusal);
    const postedBody = core.postedReviewBody(event, body);
    const posted = await timeStep(timing, 'post', () => github.postReview({
      repo: draft.repo, number: draft.number, commitId: draft.reviewedHead, event, body: postedBody, comments: comments.map((comment) => ({ ...comment, body: withAutomatedNote(comment.body) })),
    }));
    if (!posted.ok) return refusePost(timing, { reason: 'github-refused', error: posted.err || 'GitHub refused the review' });
    requestPrRefresh?.(comparablePrKey(draft));
    const settledOutcome = SETTLED_OUTCOME_BY_ACTION[request.action];
    if (!isFollowUpApproval && settledOutcome) timing.settled = { outcome: settledOutcome, draft, postedCommentCount: comments.length };
    const headAfterPostRead = event === 'APPROVE' ? await readStep(timing, 'head-after-post', () => store.requestPrHead(draft.repo, draft.number, 'priority')) : { isRateLimited: false as const, value: draft.reviewedHead };
    const headAfterPost = headAfterPostRead.isRateLimited ? null : headAfterPostRead.value;
    if (headAfterPost !== null && headAfterPost !== draft.reviewedHead) return retractApproval(timing, key, draft, headAfterPost, posted.reviewId);
    const postedFields: DraftPatch = isFollowUpApproval ? { postedEvent: event } : { postedEvent: event, body: postedBody, comments, drafted: { body: draft.body, comments: draft.comments } };
    const marked = await markDraft(timing, key, draft, 'posted', postedFields);
    const warnings = [
      headAfterPost === null ? 'Could not confirm the pull request head after approving. Check the approval on GitHub' : '',
      marked ? '' : UNMARKED_POST_WARNING,
    ].filter(Boolean);
    return warnings.length > 0 ? { ok: true, warning: warnings.join('. ') } : { ok: true };
  }

  async function resolveThread(timing: ActionTiming, draft: ReviewDraft, request: TeamReviewActionRequest): Promise<TeamReviewActionOutcome> {
    const resolveReviewThread = github.resolveReviewThread?.bind(github);
    const updateThread = drafts.updateThread?.bind(drafts);
    if (!request.threadId || !resolveReviewThread || !updateThread) return { ok: false, error: 'Thread resolution is unavailable' };
    const stored = draft.threads?.find((thread) => thread.id === request.threadId);
    if (!stored) return { ok: false, error: 'That answered thread no longer exists' };
    if (stored.isResolved) return { ok: false, error: 'That thread is already resolved' };
    if (stored.isNit && stored.resolveError === undefined) return { ok: false, error: 'That nit is resolved automatically' };
    const fetchedRead = await readStep(timing, 'threads', () => store.requestTeamReviewThreads([{ repo: draft.repo, number: draft.number }], 'priority'));
    if (fetchedRead.isRateLimited) return { ok: false, error: githubStoreRateLimitedError(fetchedRead.waitMs) };
    const fetched = fetchedRead.value;
    const thread = fetched.get(draft.key)?.find((thread) => thread.id === request.threadId);
    if (!thread) return { ok: false, error: 'That thread is no longer on the pull request' };
    if (thread.isResolved) return { ok: false, error: 'That thread is already resolved on GitHub' };
    if (!thread.viewerCanResolve) return { ok: false, error: 'You do not have permission to resolve that thread' };
    const first = thread.comments.nodes.at(0);
    const last = thread.comments.nodes.at(-1);
    if (thread.comments.pageInfo.hasNextPage || !first?.viewerDidAuthor || !last || last.viewerDidAuthor || first === last) return { ok: false, error: 'That thread no longer has an unanswered reply for you' };
    if (stored.lastReplyAt !== last.createdAt) return { ok: false, error: 'A new reply arrived. Read it before resolving' };
    const resolved = await timeStep(timing, 'resolve', () => resolveReviewThread(thread.id));
    await timeStep(timing, 'mark', () => updateThread(request.key, thread.id, resolved.ok ? { isResolved: true } : { resolveError: resolved.err || 'GitHub refused to resolve the thread' }));
    return resolved.ok ? { ok: true } : { ok: false, error: resolved.err || 'GitHub refused to resolve the thread' };
  }

  async function runAction(timing: ActionTiming, request: TeamReviewActionRequest): Promise<TeamReviewActionOutcome> {
    if (request.action === 'discard') return markNotMine(timing, request);
    const draft = drafts.getDraft(request.key);
    if (!draft) return { ok: false, error: 'That review draft no longer exists' };
    if (draft.reviewedHead !== request.head) return { ok: false, error: REPLACED_DRAFT_ERROR };
    if (request.action === 'resolve-thread') return resolveThread(timing, draft, request);
    if (request.action === 'restore') return restoreNotMine(timing, request.key, draft);
    if (request.action === 'requeue') {
      const isQueued = await drafts.requeue(request.key, draft.reviewedHead);
      return isQueued ? { ok: true } : { ok: false, error: 'only a failed, ready, stale, discarded or posted review can be queued again' };
    }
    return post(timing, request.key, draft, request);
  }

  async function submitAction(request: TeamReviewActionRequest): Promise<TeamReviewActionOutcome> {
    const startedAt = now();
    const timing: ActionTiming = { steps: [] };
    const shouldLogTiming = request.action === 'resolve-thread' || SETTLED_OUTCOME_BY_ACTION[request.action] !== undefined;
    let hasActionLock = false;
    let loggedOutcome = 'error';
    try {
      const parsed = ActionRequestSchema.safeParse(request);
      if (!parsed.success) {
        loggedOutcome = 'refused:invalid-request';
        return { ok: false, error: 'Invalid review action or thread id' };
      }
      if (actionsInFlight.has(request.key)) {
        loggedOutcome = 'refused:action-in-flight';
        return { ok: false, error: 'An action for this pull request is already running' };
      }
      actionsInFlight.add(request.key);
      hasActionLock = true;
      const outcome = await runAction(timing, request);
      loggedOutcome = outcome.ok ? 'posted' : `refused:${timing.refusalReason ?? 'action-refused'}`;
      return outcome;
    } catch (error) {
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] action failed for ${request.key}: ${errorMessage(error)}`);
      return { ok: false, error: errorMessage(error) };
    } finally {
      if (hasActionLock) actionsInFlight.delete(request.key);
      const durationMs = Math.max(0, Math.round(now() - startedAt));
      if (shouldLogTiming) log.warn(`[${core.TEAM_REVIEW_LANE_ID}] ${request.action} ${request.key} ${loggedOutcome} in ${durationMs}ms: ${timing.steps.join(', ') || 'no steps'}`.replace(/[\r\n]+/g, ' '));
      if (timing.refusalReason && !timing.settled) telemetry?.capture('team_review_post_refused', { reason: timing.refusalReason, duration_ms: durationMs });
      if (timing.settled) captureSettled(timing.settled.outcome, timing.settled.draft, timing.settled.postedCommentCount, durationMs);
    }
  }

  return { submitAction };
}

export { createTeamReviewActions };
