import type { GithubPr } from '../../../shared/contracts/github-prs.ts';
import type { TeamReviewCandidatesPayload } from '../../../shared/contracts/team-review-candidates.ts';
import type { TeamReviewWatcheeSettings } from '../../../shared/contracts/watchee-settings.ts';
import { orgSearchPlans } from '../../../server/github/core/team-review-core.ts';
import type { createGithubStorePoller } from '../../../server/github/github-store-poller.ts';

type GithubStore = Pick<ReturnType<typeof createGithubStorePoller>, 'requestViewer' | 'requestTeamMembers' | 'registerWatch' | 'unregisterWatch' | 'refreshWatches' | 'getSnapshot'>;
type WatchSource = 'direct' | 'team' | 'authored';
type SearchOutcome = { ok: true; payload: TeamReviewCandidatesPayload } | { ok: false; reason: string; retryAfterMs?: number };

const AUTHORS_PER_SEARCH = 5;

function createTeamReviewSearch({ store, now }: { store: GithubStore; now: () => number }) {
  const watches = new Map<string, { qualifiers: string; source: WatchSource }>();
  let viewer: string | null = null;

  async function search(settings: TeamReviewWatcheeSettings): Promise<SearchOutcome> {
    const viewerRead = viewer === null ? await store.requestViewer('no-wait') : { isRateLimited: false as const, value: viewer };
    if (viewerRead.isRateLimited) return { ok: false, reason: 'GitHub rate limit asks to wait.', retryAfterMs: viewerRead.waitMs };
    if (viewerRead.value === null) return { ok: false, reason: 'Could not look up your GitHub account.' };
    viewer = viewerRead.value;
    const membership = await requestTeamMembership(settings.teams);
    if (!membership.ok) return membership;
    registerWatches(settings, orgSearchPlans(settings.org, settings.teams, membership.memberLists, viewer));
    const refreshed = await store.refreshWatches([...watches.keys()]);
    if (!refreshed.ok) return { ok: false, reason: refreshed.error ?? 'GitHub search failed.' };
    const searched = searchResultFromSnapshot();
    return { ok: true, payload: { observedAt: new Date(now()).toISOString(), viewer, ...searched, isComplete: membership.isComplete && searched.isComplete } };
  }

  async function requestTeamMembership(teams: TeamReviewWatcheeSettings['teams']): Promise<{ ok: true; memberLists: string[][]; isComplete: boolean } | { ok: false; reason: string; retryAfterMs?: number }> {
    const memberLists: (string[] | null)[] = [];
    for (const team of teams) {
      const membersRead = await store.requestTeamMembers(team.org, team.slug, 'no-wait');
      if (membersRead.isRateLimited) return { ok: false, reason: 'GitHub rate limit asks to wait.', retryAfterMs: membersRead.waitMs };
      memberLists.push(membersRead.value);
    }
    const fetchedMemberLists = memberLists.map((members) => members ?? []);
    if (teams.length > 0 && fetchedMemberLists.every((members) => members.length === 0)) return { ok: false, reason: 'Could not look up your team members.' };
    return { ok: true, memberLists: fetchedMemberLists, isComplete: memberLists.every((members) => members !== null) };
  }

  function registerWatches(settings: TeamReviewWatcheeSettings, searchPlans: ReturnType<typeof orgSearchPlans>): void {
    const nextWatches = new Map<string, { qualifiers: string; source: WatchSource }>();
    for (const plan of searchPlans) {
      nextWatches.set(`team-review-direct:${plan.org.toLowerCase()}`, { qualifiers: `is:open draft:false org:${plan.org} user-review-requested:@me`, source: 'direct' });
      for (let index = 0; index < plan.authors.length; index += AUTHORS_PER_SEARCH) {
        const authors = plan.authors.slice(index, index + AUTHORS_PER_SEARCH).map((author) => `author:${author}`).join(' ');
        nextWatches.set(`team-review-authored:${plan.org.toLowerCase()}:${index / AUTHORS_PER_SEARCH}`, { qualifiers: `is:open draft:false org:${plan.org} ${authors}`, source: 'authored' });
      }
    }
    for (const team of settings.teams) {
      nextWatches.set(`team-review-team:${team.org.toLowerCase()}/${team.slug.toLowerCase()}`, { qualifiers: `is:open draft:false org:${team.org} team-review-requested:${team.org}/${team.slug}`, source: 'team' });
    }
    for (const name of watches.keys()) {
      if (!nextWatches.has(name)) store.unregisterWatch(name);
    }
    for (const [name, watch] of nextWatches) {
      if (watches.get(name)?.qualifiers !== watch.qualifiers) store.registerWatch({ name, qualifiers: watch.qualifiers, needsDetail: true });
    }
    watches.clear();
    for (const [name, watch] of nextWatches) watches.set(name, watch);
  }

  function searchResultFromSnapshot(): Pick<TeamReviewCandidatesPayload, 'directRequested' | 'teamRequested' | 'authored' | 'isComplete'> {
    const snapshot = store.getSnapshot();
    const prsBySource: Record<WatchSource, GithubPr[]> = { direct: [], team: [], authored: [] };
    let isComplete = true;
    for (const [name, { source }] of watches) {
      const watch = snapshot.watches[name];
      if (!watch?.isLoaded || !watch.isComplete) isComplete = false;
      for (const key of watch?.keys ?? []) {
        const pr = snapshot.prs[key];
        if (!pr) {
          isComplete = false;
          continue;
        }
        prsBySource[source].push(pr);
      }
    }
    return { isComplete, directRequested: prsBySource.direct, teamRequested: prsBySource.team, authored: prsBySource.authored };
  }

  function stop(): void {
    for (const name of watches.keys()) store.unregisterWatch(name);
    watches.clear();
  }

  return { search, stop };
}

export { createTeamReviewSearch };
