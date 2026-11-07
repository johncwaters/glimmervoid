import type { MyPrsCandidatesPayload } from '../../../shared/contracts/my-prs-candidates.ts';
import type { MyPrsWatcheeSettings } from '../../../shared/contracts/watchee-settings.ts';
import type { GithubPr } from '../../../shared/contracts/github-prs.ts';
import { mergedSinceDate } from '../../../server/github/core/my-prs-core.ts';
import type { createGithubStorePoller } from '../../../server/github/github-store-poller.ts';

type GithubStore = Pick<ReturnType<typeof createGithubStorePoller>, 'requestViewer' | 'registerWatch' | 'unregisterWatch' | 'refreshWatches' | 'getSnapshot'>;
type SearchOutcome = { ok: true; payload: MyPrsCandidatesPayload } | { ok: false; reason: string; retryAfterMs?: number };

const OPEN_WATCH = 'my-prs-open';
const MERGED_WATCH = 'my-prs-merged';

function createMyPrsSearch({ store, now }: { store: GithubStore; now: () => number }) {
  let viewer: string | null = null;
  let registeredQualifiers: string | null = null;

  async function search(settings: MyPrsWatcheeSettings): Promise<SearchOutcome> {
    const viewerRead = viewer === null ? await store.requestViewer('no-wait') : { isRateLimited: false as const, value: viewer };
    if (viewerRead.isRateLimited) return { ok: false, reason: 'GitHub rate limit asks to wait.', retryAfterMs: viewerRead.waitMs };
    if (viewerRead.value === null) return { ok: false, reason: 'Could not look up your GitHub account.' };
    viewer = viewerRead.value;
    registerWatches(settings.org);
    const refreshed = await store.refreshWatches([OPEN_WATCH, MERGED_WATCH]);
    if (!refreshed.ok) return { ok: false, reason: refreshed.error ?? 'GitHub search failed.' };
    return { ok: true, payload: { observedAt: new Date(now()).toISOString(), viewer, ...searchResultFromSnapshot() } };
  }

  function registerWatches(org: string): void {
    const mergedSince = mergedSinceDate(now());
    const qualifiers = `${org}:${mergedSince}`;
    if (registeredQualifiers === qualifiers) return;
    store.registerWatch({ name: OPEN_WATCH, qualifiers: `is:open author:@me org:${org} sort:updated-desc`, needsDetail: true });
    store.registerWatch({ name: MERGED_WATCH, qualifiers: `is:merged author:@me org:${org} merged:>=${mergedSince} sort:updated-desc`, needsDetail: true });
    registeredQualifiers = qualifiers;
  }

  function searchResultFromSnapshot(): Omit<MyPrsCandidatesPayload, 'observedAt' | 'viewer'> {
    const snapshot = store.getSnapshot();
    let isComplete = true;
    let returnedCount = 0;
    let totalCount = 0;
    const prsOf = (name: string): GithubPr[] => {
      const watch = snapshot.watches[name];
      if (!watch?.isLoaded || !watch.isComplete) isComplete = false;
      returnedCount += watch?.returnedCount ?? 0;
      totalCount += watch?.totalCount ?? 0;
      return (watch?.keys ?? []).flatMap((key) => {
        const pr = snapshot.prs[key];
        if (pr) return [pr];
        isComplete = false;
        return [];
      });
    };
    const open = prsOf(OPEN_WATCH);
    const merged = prsOf(MERGED_WATCH);
    return { isComplete, returnedCount, totalCount, open, merged };
  }

  function stop(): void {
    store.unregisterWatch(OPEN_WATCH);
    store.unregisterWatch(MERGED_WATCH);
    registeredQualifiers = null;
  }

  return { search, stop };
}

export { createMyPrsSearch };
