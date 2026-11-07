import type { WorkflowsCandidatesPayload } from '../../../shared/contracts/workflows-candidates.ts';
import type { WorkflowsWatcheeSettings } from '../../../shared/contracts/watchee-settings.ts';
import type { GithubPr } from '../../../shared/contracts/github-prs.ts';
import { mergedSinceDate } from '../../../server/github/core/my-prs-core.ts';
import { WORKFLOWS_POLL_INTERVAL_MINUTES, workflowPrFromGithubPr, workflowRepoWatchNames } from '../../../server/core/workflows-core.ts';
import type { createGithubStorePoller } from '../../../server/github/github-store-poller.ts';

type GithubStore = Pick<ReturnType<typeof createGithubStorePoller>, 'requestViewer' | 'registerWatch' | 'unregisterWatch' | 'refreshWatches' | 'getSnapshot'>;
type SearchOutcome = { ok: true; payloads: WorkflowsCandidatesPayload[] } | { ok: false; reason: string; retryAfterMs?: number };

const MAX_PRS_PER_WATCH = 50;

function createWorkflowsSearch({ store, now }: { store: GithubStore; now: () => number }) {
  let viewer: string | null = null;
  const qualifiersByWatchName = new Map<string, string>();

  async function search(settings: WorkflowsWatcheeSettings): Promise<SearchOutcome> {
    const viewerRead = viewer === null ? await store.requestViewer('no-wait') : { isRateLimited: false as const, value: viewer };
    if (viewerRead.isRateLimited) return { ok: false, reason: 'GitHub rate limit asks to wait.', retryAfterMs: viewerRead.waitMs };
    if (viewerRead.value === null) return { ok: false, reason: 'Could not look up your GitHub account.' };
    viewer = viewerRead.value;
    registerWatches(settings.repos);
    const refreshed = await store.refreshWatches([...qualifiersByWatchName.keys()]);
    if (!refreshed.ok) return { ok: false, reason: refreshed.error ?? 'GitHub search failed.' };
    const observedAt = new Date(now()).toISOString();
    const listedViewer = viewer;
    return { ok: true, payloads: settings.repos.map((repo) => ({ observedAt, viewer: listedViewer, ...repoFromSnapshot(repo) })) };
  }

  function registerWatches(repos: readonly string[]): void {
    const mergedSince = mergedSinceDate(now());
    const nextQualifiersByWatchName = new Map<string, string>();
    for (const repo of repos) {
      const { openWatchName, mergedWatchName } = workflowRepoWatchNames(repo);
      nextQualifiersByWatchName.set(openWatchName, `is:open repo:${repo} sort:updated-desc`);
      nextQualifiersByWatchName.set(mergedWatchName, `is:merged repo:${repo} merged:>=${mergedSince} sort:updated-desc`);
    }
    for (const name of qualifiersByWatchName.keys()) {
      if (!nextQualifiersByWatchName.has(name)) store.unregisterWatch(name);
    }
    for (const [name, qualifiers] of nextQualifiersByWatchName) {
      if (qualifiersByWatchName.get(name) === qualifiers) continue;
      store.registerWatch({ name, qualifiers, needsDetail: true, maxMembers: MAX_PRS_PER_WATCH, intervalMs: WORKFLOWS_POLL_INTERVAL_MINUTES * 60_000 });
    }
    qualifiersByWatchName.clear();
    for (const [name, qualifiers] of nextQualifiersByWatchName) qualifiersByWatchName.set(name, qualifiers);
  }

  function repoFromSnapshot(repo: string): Omit<WorkflowsCandidatesPayload, 'observedAt' | 'viewer'> {
    const snapshot = store.getSnapshot();
    const watches = Object.values(workflowRepoWatchNames(repo)).map((name) => snapshot.watches[name]);
    const keys = new Set(watches.flatMap((watch) => watch?.keys ?? []));
    const prs = [...keys].flatMap((key): GithubPr[] => snapshot.prs[key] ? [snapshot.prs[key]] : []);
    const isComplete = watches.every((watch) => watch?.isLoaded === true && watch.isComplete) && prs.length === keys.size;
    return { repo, isComplete, prs: prs.map(workflowPrFromGithubPr) };
  }

  function stop(): void {
    for (const name of qualifiersByWatchName.keys()) store.unregisterWatch(name);
    qualifiersByWatchName.clear();
  }

  return { search, stop };
}

export { createWorkflowsSearch };
