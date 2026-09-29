import * as core from './core/my-prs-core.ts';
import { createTickLoop } from './lane-runner.ts';
import type { PrGh } from './pr-gh.ts';
import type { MyPr, MyPrsStatus } from '../shared/contracts/my-prs.ts';

interface MyPrsPollerDependencies {
  org: string;
  github: Pick<PrGh, 'viewer' | 'searchMyPrs' | 'behindBy' | 'reviewThreads'>;
  onTickComplete: (status: MyPrsStatus) => void;
  now?: () => number;
  intervalMinutes?: number;
  setIntervalFn?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  log?: Pick<Console, 'warn'>;
}

export function createMyPrsPoller(dependencies: MyPrsPollerDependencies) {
  const { org, github, onTickComplete, now = Date.now, intervalMinutes = core.POLL_INTERVAL_MINUTES, setIntervalFn, clearIntervalFn, log } = dependencies;
  let viewer: string | null = null;
  let hasLookedUpViewer = false;
  let previousPrs: MyPr[] = [];
  let previousTruncatedNote: string | null = null;
  const loop = createTickLoop({
    tag: core.MY_PRS_LANE_ID, intervalMs: intervalMinutes * 60000, setIntervalFn, clearIntervalFn, log,
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
        return { failed: true };
      }
      const prs: MyPr[] = [];
      for (const node of search.items) {
        const behindBy = node.state === 'OPEN' ? await github.behindBy(node.repository.nameWithOwner, node.baseRefName, node.headRefOid) : null;
        if (loop.isStopped()) return { failed: false };
        const threadNodes = node.state === 'OPEN' && core.hasUnresolvedThreads(node) ? await github.reviewThreads(node.repository.nameWithOwner, node.number) : [];
        if (loop.isStopped()) return { failed: false };
        prs.push(core.toMyPr(node, behindBy, threadNodes));
      }
      previousPrs = core.sortedMyPrs(prs, timestamp);
      previousTruncatedNote = core.truncatedSearchNote(search.items.length, search.totalCount);
      onTickComplete(core.myPrsStatus({ ts: timestamp, configured: true, viewer, prs: previousPrs, truncatedNote: previousTruncatedNote }));
      return { failed: false };
    },
  });
  return { start: loop.start, stop: loop.stop, tick: loop.tick };
}
