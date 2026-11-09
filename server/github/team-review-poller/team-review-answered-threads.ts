import { comparablePrKey } from '../../../shared/contracts/github-prs.ts';
import { countViewerThreadResolved, viewerThreadTally, hasPresentableThreads, isThreadPlaceholderDraft, answeredViewerThreads, shouldAutoResolveThread, shouldJudgeThread, buildThreadJudgeRequest, parseThreadJudgeResult, threadJudgeEvidence, THREAD_JUDGE_BACKOFF_MS, THREAD_PLACEHOLDER_ERROR, THREAD_REFRESH_MIN_INTERVAL_MS } from '../core/team-review-threads-core.ts';
import * as core from '../core/team-review-core.ts';
import { githubStorePrReference } from '../core/github-store-core.ts';
import { teammateThreadItems } from '../core/pr-flows-core.ts';
import type { TeamReviewCandidate } from '../core/team-review-core.ts';
import type { TeamReviewStateEntry } from '../../../shared/contracts/team-review.ts';
import { errorMessage } from '../../../shared/text.ts';
import type { TeamReviewPollerContext } from './team-review-poller-context.ts';
import type { TeamReviewStatusReporter } from './team-review-status-reporter.ts';

function createTeamReviewAnsweredThreads(context: TeamReviewPollerContext, statusReporter: TeamReviewStatusReporter) {
  const { deps, github, store, now, runtime, loop, persist } = context;
  const { emitStatus } = statusReporter;
  const lastThreadRefreshAtByKey = new Map<string, number>();

  async function handleAnsweredThreads(candidates: TeamReviewCandidate[]): Promise<boolean> {
    const isViewerThreadEligible = ({ key }: TeamReviewCandidate) => {
      const entry = runtime.state[key];
      return Boolean(github.resolveReviewThread) && (entry?.githubReviews?.some((review) => review.isViewer) || entry?.draft?.status === 'posted');
    };
    const candidateKeys = new Set(candidates.map(({ key }) => key));
    const reviewedOutsideSearch = Object.entries(runtime.state).flatMap(([key, entry]) => (entry.draft && !candidateKeys.has(key) ? [{ ...entry.draft, key }] : []));
    const keysWithoutLiveHead = new Set<string>();
    let isDirty = false;
    for (const { key } of reviewedOutsideSearch) {
      const entry = runtime.state[key];
      const watchedPr = store.getSnapshot().prs[key.toLowerCase()];
      const watchedHead = watchedPr ? core.reviewSnapshotFromGithubPr(watchedPr).head : null;
      if (!entry || !watchedHead) {
        keysWithoutLiveHead.add(key);
        continue;
      }
      if (entry.liveHead === watchedHead) continue;
      entry.liveHead = watchedHead;
      isDirty = true;
    }
    const eligible = [...candidates, ...reviewedOutsideSearch].filter((candidate) => isViewerThreadEligible(candidate) || runtime.state[candidate.key]?.draft?.status === 'ready');
    if (eligible.length === 0) return isDirty;
    const fetchedRead = await store.requestTeamReviewThreads(eligible, 'no-wait');
    if (fetchedRead.isRateLimited) {
      runtime.tickRateLimitWaitMs = fetchedRead.waitMs;
      return isDirty;
    }
    const fetched = fetchedRead.value;
    for (const candidate of eligible) {
      if (loop.isStopped()) break;
      const entry = runtime.state[candidate.key];
      const nodes = fetched.get(candidate.key);
      const head = entry?.liveHead;
      if (!entry || !nodes || !head) continue;
      if (applyTeammateThreadItems(entry, nodes)) isDirty = true;
      if (!isViewerThreadEligible(candidate) || !github.resolveReviewThread) continue;
      const viewerThreads = viewerThreadTally(nodes);
      if (viewerThreads.total !== entry.viewerThreads?.total || viewerThreads.resolved !== entry.viewerThreads?.resolved) {
        entry.viewerThreads = viewerThreads;
        isDirty = true;
      }
      const threads = answeredViewerThreads(nodes, entry.threads ?? [], head, entry.autoResolvedThreadIds);
      if (JSON.stringify(threads) !== JSON.stringify(entry.threads)) isDirty = true;
      entry.threads = threads;
      for (const thread of threads) {
        if (loop.isStopped()) break;
        if (!shouldAutoResolveThread(thread)) continue;
        thread.resolveAttemptReplyAt = thread.lastReplyAt;
        isDirty = true;
        await persist();
        const resolution = await github.resolveReviewThread(thread.id).catch((error: unknown) => ({ ok: false, err: errorMessage(error) }));
        if (resolution.ok) {
          thread.isResolved = true;
          entry.viewerThreads = countViewerThreadResolved(entry.viewerThreads);
          entry.autoResolvedThreadIds = [...(entry.autoResolvedThreadIds ?? []), thread.id];
        }
        if (!resolution.ok) thread.resolveError = resolution.err || 'GitHub refused to resolve the thread';
      }
      if (reconcileThreadPlaceholder(entry, candidate, head)) isDirty = true;
      if (!deps.judgeThread || keysWithoutLiveHead.has(candidate.key)) continue;
      const pending = threads.filter((thread) => shouldJudgeThread(thread, head, now()))
        .sort((left, right) => (left.judgeAttempt?.retryAt ?? 0) - (right.judgeAttempt?.retryAt ?? 0));
      if (pending.length === 0) continue;
      const base = nodes.find((node) => node.id === pending[0].id)?.comments.nodes[0]?.originalCommit?.oid;
      const comparisonRead = base ? await store.requestTeamReviewCompare(candidate.repo, base, head, 'no-wait') : { isRateLimited: false as const, value: { ok: true as const, comparison: null } };
      if (comparisonRead.isRateLimited) {
        runtime.tickRateLimitWaitMs = comparisonRead.waitMs;
        return isDirty;
      }
      const comparisonOutcome = comparisonRead.value;
      const threadComparison = comparisonOutcome.ok && comparisonOutcome.comparison?.merge_base_commit.sha === base ? comparisonOutcome.comparison : null;
      const pullRequest = store.getSnapshot().prs[comparablePrKey(candidate)];
      const baseBranchHead = pullRequest && pullRequest.baseRefName === pullRequest.defaultBranch ? pullRequest.baseRefOid : undefined;
      const mainSinceCommentRead = base && baseBranchHead && threadComparison
        ? await readMainSinceComment(candidate.repo, base, baseBranchHead, head)
        : { isRateLimited: false as const, value: { ok: true as const, comparison: null } };
      if (mainSinceCommentRead.isRateLimited) {
        runtime.tickRateLimitWaitMs = mainSinceCommentRead.waitMs;
        return isDirty;
      }
      const mainSinceCommentOutcome = mainSinceCommentRead.value;
      for (const thread of pending) {
        if (loop.isStopped()) break;
        const node = nodes.find((node) => node.id === thread.id);
        if (!node || node.comments.nodes[0]?.originalCommit?.oid !== base) continue;
        thread.judgeAttempt = { head, lastReplyAt: thread.lastReplyAt, retryAt: now() + THREAD_JUDGE_BACKOFF_MS };
        isDirty = true;
        await persist();
        if (!comparisonOutcome.ok || !mainSinceCommentOutcome.ok) continue;
        const evidenceRead = threadJudgeEvidence(node, threadComparison, mainSinceCommentOutcome.comparison);
        if ('unjudgeableReason' in evidenceRead) {
          thread.unjudgeable = { head, lastReplyAt: thread.lastReplyAt, reason: evidenceRead.unjudgeableReason };
          delete thread.judgeAttempt;
          continue;
        }
        emitStatus();
        const raw = await deps.judgeThread(buildThreadJudgeRequest(node, head, evidenceRead.evidence)).catch(() => null);
        const judgement = parseThreadJudgeResult(raw);
        if (judgement && runtime.state[candidate.key] === entry && entry.liveHead === head && entry.threads?.includes(thread)) {
          thread.judgement = { ...judgement, head, lastReplyAt: thread.lastReplyAt, judgedAt: now() };
          delete thread.judgeAttempt;
        }
        await persist();
        emitStatus();
      }
    }
    return isDirty;
  }

  async function refreshThreads(key: string): Promise<boolean> {
    for (const refreshedKey of lastThreadRefreshAtByKey.keys()) {
      if (!runtime.state[refreshedKey]) lastThreadRefreshAtByKey.delete(refreshedKey);
    }
    const entry = runtime.state[key];
    const reference = githubStorePrReference(key);
    if (!entry || !reference || loop.isStopped()) return false;
    const lastRefreshAt = lastThreadRefreshAtByKey.get(key);
    if (lastRefreshAt !== undefined && now() - lastRefreshAt < THREAD_REFRESH_MIN_INTERVAL_MS) return false;
    lastThreadRefreshAtByKey.set(key, now());
    const fetchedRead = await store.requestTeamReviewThreads([reference], 'no-wait');
    if (fetchedRead.isRateLimited || runtime.state[key] !== entry) return false;
    const nodes = [...fetchedRead.value].find(([fetchedKey]) => fetchedKey.toLowerCase() === key.toLowerCase())?.[1];
    return nodes ? applyTeammateThreadItems(entry, nodes) : false;
  }

  function applyTeammateThreadItems(entry: TeamReviewStateEntry, nodes: Parameters<typeof teammateThreadItems>[0]): boolean {
    const otherReviewItems = teammateThreadItems(nodes, 'open');
    const resolvedOtherReviewItems = teammateThreadItems(nodes, 'resolved');
    if (JSON.stringify([otherReviewItems, resolvedOtherReviewItems]) === JSON.stringify([entry.otherReviewItems ?? [], entry.resolvedOtherReviewItems ?? []])) return false;
    entry.otherReviewItems = otherReviewItems;
    entry.resolvedOtherReviewItems = resolvedOtherReviewItems;
    return true;
  }

  async function readMainSinceComment(repo: string, commentCommit: string, baseBranchHead: string, head: string): ReturnType<typeof store.requestTeamReviewCompare> {
    const mergedMainRead = await store.requestTeamReviewCompare(repo, baseBranchHead, head, 'no-wait');
    if (mergedMainRead.isRateLimited || !mergedMainRead.value.ok || !mergedMainRead.value.comparison) return mergedMainRead;
    return store.requestTeamReviewCompare(repo, commentCommit, mergedMainRead.value.comparison.merge_base_commit.sha, 'no-wait');
  }

  function reconcileThreadPlaceholder(entry: TeamReviewStateEntry, candidate: TeamReviewCandidate, head: string): boolean {
    const isPresentable = hasPresentableThreads(entry.threads ?? []);
    if (!entry.draft && isPresentable) {
      entry.draft = { ...core.errorDraft({ candidate, tier: 'full', reasons: [], reviewedHead: head, error: THREAD_PLACEHOLDER_ERROR }), summary: '' };
      return true;
    }
    if (!isPresentable && isThreadPlaceholderDraft(entry.draft)) {
      entry.draft = null;
      return true;
    }
    return false;
  }

  return { handleAnsweredThreads, refreshThreads };
}

export { createTeamReviewAnsweredThreads };
