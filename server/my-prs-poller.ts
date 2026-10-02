import * as core from './core/my-prs-core.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS } from './core/github-rate-limit-core.ts';
import { createTickLoop } from './lane-runner.ts';
import type { SharedClock } from './lane-runner.ts';
import type { PrGh } from './pr-gh.ts';
import type { MyPr, MyPrAutoRebase, MyPrsStatus, MyPrThreadNode } from '../shared/contracts/my-prs.ts';

const MY_PRS_RATE_LIMIT_RESOURCES = ['graphql'] as const;

interface MyPrsPollerDependencies {
  org: string;
  shouldAutoRebase?: boolean;
  github: Pick<PrGh, 'viewer' | 'searchMyPrs' | 'behindCounts' | 'reviewThreadsBatch' | 'rebasePr' | 'rateLimitWaitMs'>;
  onTickComplete: (status: MyPrsStatus) => void;
  now?: () => number;
  intervalMinutes?: number;
  setIntervalFn?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  clock?: SharedClock;
  firstTickDelayMs?: () => number;
  log?: Pick<Console, 'warn'>;
}

export function createMyPrsPoller(dependencies: MyPrsPollerDependencies) {
  const { org, shouldAutoRebase = false, github, onTickComplete, now = Date.now, intervalMinutes = core.POLL_INTERVAL_MINUTES, setIntervalFn, clearIntervalFn, clock, firstTickDelayMs, log } = dependencies;
  let viewer: string | null = null;
  let hasLookedUpViewer = false;
  let previousPrs: MyPr[] = [];
  let previousTruncatedNote: string | null = null;
  const autoRebaseByKey = new Map<string, MyPrAutoRebase>();
  const failedAutoRebaseAttempts = new Set<string>();
  const loop = createTickLoop({
    tag: core.MY_PRS_LANE_ID, intervalMs: intervalMinutes * 60000, setIntervalFn, clearIntervalFn, clock, firstTickDelayMs, backoffMaxMs: GITHUB_RATE_LIMIT_WINDOW_MS, log,
    tick: async () => {
      if (!hasLookedUpViewer) {
        viewer = await github.viewer();
        hasLookedUpViewer = true;
        if (loop.isStopped()) return { failed: false };
      }
      const timestamp = now();
      const search = await github.searchMyPrs(org, core.mergedSinceDate(timestamp));
      if (loop.isStopped()) return { failed: false };
      if (!search.ok) {
        onTickComplete(core.myPrsStatus({ ts: timestamp, configured: true, viewer, prs: previousPrs, error: search.error, truncatedNote: previousTruncatedNote }));
        const rateLimitWaitMs = await github.rateLimitWaitMs(now(), MY_PRS_RATE_LIMIT_RESOURCES);
        return rateLimitWaitMs === null ? { failed: true } : { failed: true, retryAfterMs: rateLimitWaitMs };
      }
      const openPrs = search.items.filter((node) => node.state === 'OPEN').map((node) => ({ repo: node.repository.nameWithOwner, number: node.number, headSha: node.headRefOid }));
      const behindCounts = openPrs.length > 0 ? await github.behindCounts(openPrs) : new Map<string, number>();
      if (loop.isStopped()) return { failed: false };
      const threadedPrs = search.items.filter((node) => node.state === 'OPEN' && core.hasUnresolvedThreads(node)).map((node) => ({ repo: node.repository.nameWithOwner, number: node.number }));
      const threadsByPr = threadedPrs.length > 0 ? await github.reviewThreadsBatch(threadedPrs) : new Map<string, MyPrThreadNode[]>();
      if (loop.isStopped()) return { failed: false };
      const prs: MyPr[] = [];
      for (const node of search.items) {
        const key = `${node.repository.nameWithOwner}#${node.number}`;
        const behindBy = node.state === 'OPEN' ? behindCounts.get(key) ?? null : null;
        const isFailedRecordForAnotherHead = autoRebaseByKey.get(key)?.outcome === 'failed' && !failedAutoRebaseAttempts.has(core.autoRebaseAttemptKey(node));
        if (isFailedRecordForAnotherHead) autoRebaseByKey.delete(key);
        if (shouldAutoRebase && core.shouldAutoRebase(node, behindBy, failedAutoRebaseAttempts)) {
          const rebase = await github.rebasePr(node.id, node.headRefOid);
          if (loop.isStopped()) return { failed: false };
          if (!rebase.ok) failedAutoRebaseAttempts.add(core.autoRebaseAttemptKey(node));
          if (!rebase.ok) log?.warn(`[${core.MY_PRS_LANE_ID}] auto-rebase of ${key} failed: ${rebase.err.trim()}`);
          autoRebaseByKey.set(key, core.autoRebaseRecord(rebase, node.baseRefName, now()));
        }
        const threadNodes = threadsByPr.get(key) ?? [];
        prs.push(core.withAutoRebase(core.toMyPr(node, behindBy, threadNodes), autoRebaseByKey.get(key)));
      }
      const listedKeys = new Set(prs.map((pr) => pr.key));
      for (const key of [...autoRebaseByKey.keys()]) {
        if (!listedKeys.has(key)) autoRebaseByKey.delete(key);
      }
      previousPrs = core.sortedMyPrs(prs, timestamp);
      previousTruncatedNote = core.truncatedSearchNote(search.items.length, search.totalCount);
      onTickComplete(core.myPrsStatus({ ts: timestamp, configured: true, viewer, prs: previousPrs, truncatedNote: previousTruncatedNote }));
      return { failed: false };
    },
  });
  return { start: loop.start, stop: loop.stop, tick: loop.tick };
}
