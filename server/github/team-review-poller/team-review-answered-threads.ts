import { viewerThreadTally, hasPresentableThreads, isThreadPlaceholderDraft, answeredViewerThreads, shouldAutoResolveThread, shouldJudgeThread, buildThreadJudgeRequest, parseThreadJudgeResult, threadJudgePatch, THREAD_JUDGE_BACKOFF_MS, THREAD_PLACEHOLDER_ERROR } from '../core/team-review-threads-core.ts';
import * as core from '../core/team-review-core.ts';
import { teammateThreadItems } from '../core/pr-flows-core.ts';
import type { TeamReviewCandidate } from '../core/team-review-core.ts';
import type { TeamReviewStateEntry } from '../../../shared/contracts/team-review.ts';
import { errorMessage } from '../../../shared/text.ts';
import type { TeamReviewPollerContext } from './team-review-poller-context.ts';
import type { TeamReviewStatusReporter } from './team-review-status-reporter.ts';

function createTeamReviewAnsweredThreads(context: TeamReviewPollerContext, statusReporter: TeamReviewStatusReporter) {
  const { deps, github, store, now, runtime, loop, persist } = context;
  const { emitStatus } = statusReporter;

  async function handleAnsweredThreads(candidates: TeamReviewCandidate[]): Promise<boolean> {
    const isViewerThreadEligible = ({ key }: TeamReviewCandidate) => {
      const entry = runtime.state[key];
      return Boolean(github.resolveReviewThread) && (entry?.githubReviews?.some((review) => review.isViewer) || entry?.draft?.status === 'posted');
    };
    const eligible = candidates.filter((candidate) => isViewerThreadEligible(candidate) || runtime.state[candidate.key]?.draft?.status === 'ready');
    if (eligible.length === 0) return false;
    const fetchedRead = await store.requestTeamReviewThreads(eligible, 'no-wait');
    if (fetchedRead.isRateLimited) {
      runtime.tickRateLimitWaitMs = fetchedRead.waitMs;
      return false;
    }
    const fetched = fetchedRead.value;
    let isDirty = false;
    for (const candidate of eligible) {
      if (loop.isStopped()) break;
      const entry = runtime.state[candidate.key];
      const nodes = fetched.get(candidate.key);
      const head = entry?.liveHead;
      if (!entry || !nodes || !head) continue;
      const otherReviewItems = teammateThreadItems(nodes);
      if (JSON.stringify(otherReviewItems) !== JSON.stringify(entry.otherReviewItems ?? [])) {
        entry.otherReviewItems = otherReviewItems;
        isDirty = true;
      }
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
          viewerThreads.resolved += 1;
          entry.viewerThreads = viewerThreads;
          entry.autoResolvedThreadIds = [...(entry.autoResolvedThreadIds ?? []), thread.id];
        }
        if (!resolution.ok) thread.resolveError = resolution.err || 'GitHub refused to resolve the thread';
      }
      if (reconcileThreadPlaceholder(entry, candidate, head)) isDirty = true;
      if (!deps.judgeThread) continue;
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
      for (const thread of pending) {
        if (loop.isStopped()) break;
        const node = nodes.find((node) => node.id === thread.id);
        if (!node || node.comments.nodes[0]?.originalCommit?.oid !== base) continue;
        thread.judgeAttempt = { head, lastReplyAt: thread.lastReplyAt, retryAt: now() + THREAD_JUDGE_BACKOFF_MS };
        isDirty = true;
        await persist();
        if (!comparisonOutcome.ok) continue;
        const evidence = threadJudgePatch(node, comparisonOutcome.comparison);
        if ('unjudgeableReason' in evidence) {
          thread.unjudgeable = { head, lastReplyAt: thread.lastReplyAt, reason: evidence.unjudgeableReason };
          delete thread.judgeAttempt;
          continue;
        }
        emitStatus();
        const raw = await deps.judgeThread(buildThreadJudgeRequest(node, head, evidence.patch)).catch(() => null);
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

  return { handleAnsweredThreads };
}

export { createTeamReviewAnsweredThreads };
