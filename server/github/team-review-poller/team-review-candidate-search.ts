import * as core from '../core/team-review-core.ts';
import type { TeamReviewCandidate } from '../core/team-review-core.ts';
import { ASKED_FOR_WATCH_OWNER } from './team-review-poller-context.ts';
import type { TeamReviewPollerContext } from './team-review-poller-context.ts';

function createTeamReviewCandidateSearch(context: TeamReviewPollerContext) {
  const { org, teams, store, discardResumable, now, skipIdleAfterMs, runtime, watches, loop } = context;

  function closedEntryKeys(): Set<string> {
    const prs = store.getSnapshot().prs;
    return new Set(Object.keys(runtime.state).filter((key) => {
      const pr = prs[key.toLowerCase()];
      return !runtime.state[key]?.inFlight && pr !== undefined && pr.state !== 'OPEN';
    }));
  }

  function watchDeparted(candidateKeys: Set<string>): void {
    const departedKeys = Object.keys(runtime.state).filter((key) => !candidateKeys.has(key) && !runtime.state[key]?.inFlight);
    store.setWatchedKeys('team-review-departed', departedKeys.map((key) => key.toLowerCase()));
  }

  async function pruneDeparted(candidateKeys: Set<string>, isComplete: boolean): Promise<boolean> {
    let isDirty = false;
    watchDeparted(candidateKeys);
    const closedKeys = closedEntryKeys();
    for (const [key, entry] of Object.entries(runtime.state)) {
      const isClosed = closedKeys.has(key);
      if (candidateKeys.has(key) || (!isComplete && !isClosed)) continue;
      if (entry.resumable) {
        await discardResumable(entry.resumable);
        entry.resumable = null;
        isDirty = true;
      }
      if (!core.shouldPruneEntry(entry, false, now(), isClosed)) continue;
      delete runtime.state[key];
      isDirty = true;
    }
    return isDirty;
  }

  async function collectCandidates(): Promise<{ candidates: TeamReviewCandidate[]; isComplete: boolean } | null> {
    if (!org) {
      unregisterWatches();
      return null;
    }
    const viewer = await requestSelf();
    if (viewer === null) return null;
    const membership = teams.length === 0 ? { memberLists: [], isComplete: true } : await requestTeamMembership();
    if (membership === null || loop.isStopped()) return null;
    registerWatches(core.orgSearchPlans(org, teams, membership.memberLists, viewer));
    const collected = candidatesFromSnapshot(viewer);
    runtime.teamCandidateKeys = collected.teamCandidateKeys;
    return { candidates: collected.candidates, isComplete: membership.isComplete && collected.isComplete };
  }

  async function requestSelf(): Promise<string | null> {
    if (runtime.self !== null) return runtime.self;
    const viewerRead = await store.requestViewer('no-wait');
    if (viewerRead.isRateLimited) { runtime.tickRateLimitWaitMs = viewerRead.waitMs; return null; }
    runtime.self = viewerRead.value;
    return runtime.self;
  }

  async function requestTeamMembership(): Promise<{ memberLists: string[][]; isComplete: boolean } | null> {
    const [firstTeam] = teams;
    if (firstTeam && runtime.teamProfile === null) {
      const profileRead = await store.requestTeamProfile(firstTeam.org, firstTeam.slug, 'no-wait');
      if (profileRead.isRateLimited) { runtime.tickRateLimitWaitMs = profileRead.waitMs; return null; }
      runtime.teamProfile = profileRead.value;
    }
    const memberLists: (string[] | null)[] = [];
    for (const team of teams) {
      const membersRead = await store.requestTeamMembers(team.org, team.slug, 'no-wait');
      if (membersRead.isRateLimited) { runtime.tickRateLimitWaitMs = membersRead.waitMs; return null; }
      memberLists.push(membersRead.value);
    }
    const isComplete = memberLists.every((members) => members !== null);
    const fetchedMemberLists = memberLists.map((members) => members ?? []);
    if (fetchedMemberLists.every((members) => members.length === 0)) {
      if (isComplete) unregisterWatches();
      return null;
    }
    return { memberLists: fetchedMemberLists, isComplete };
  }

  function registerWatches(searchPlans: ReturnType<typeof core.orgSearchPlans>): void {
    const nextWatches = new Map<string, { qualifiers: string; source: 'direct' | 'team' | 'authored' }>();
    for (const plan of searchPlans) {
      nextWatches.set(`team-review-direct:${plan.org.toLowerCase()}`, { qualifiers: `is:open draft:false org:${plan.org} user-review-requested:@me`, source: 'direct' });
      for (let index = 0; index < plan.authors.length; index += 5) {
        const authors = plan.authors.slice(index, index + 5).map((author) => `author:${author}`).join(' ');
        nextWatches.set(`team-review-authored:${plan.org.toLowerCase()}:${index / 5}`, { qualifiers: `is:open draft:false org:${plan.org} ${authors}`, source: 'authored' });
      }
    }
    for (const team of teams) {
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

  function askedForKeys(): string[] {
    return Object.keys(runtime.state).filter((key) => runtime.state[key]?.requestedAt !== undefined);
  }

  function isTeamCandidate(key: string): boolean {
    return runtime.teamCandidateKeys.has(key.toLowerCase());
  }

  function askedForSlotsInUse(): number {
    return askedForKeys().filter((key) => runtime.state[key]?.draft?.status !== 'posted' && !isTeamCandidate(key)).length;
  }

  function watchAskedFor(): void {
    store.setWatchedKeys(ASKED_FOR_WATCH_OWNER, askedForKeys());
  }

  function candidatesFromSnapshot(viewer: string): { candidates: TeamReviewCandidate[]; teamCandidateKeys: ReadonlySet<string>; isComplete: boolean } {
    const snapshot = store.getSnapshot();
    let isAskedForComplete = true;
    const askedFor = askedForKeys().flatMap((key) => {
      const pr = snapshot.prs[key.toLowerCase()];
      if (pr) return [pr];
      const requestedAt = runtime.state[key]?.requestedAt ?? 0;
      if (now() - requestedAt < core.ASKED_FOR_FETCH_GRACE_MS) isAskedForComplete = false;
      return [];
    });
    const prsBySource: Record<'direct' | 'team' | 'authored', (typeof snapshot.prs)[string][]> = { direct: [], team: [], authored: [] };
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
    const selected = core.selectCandidates(prsBySource.direct, prsBySource.team, prsBySource.authored, { self: viewer, nowMs: now(), skipIdleAfterMs, askedFor });
    return { ...selected, isComplete: isComplete && isAskedForComplete };
  }

  function unregisterWatches(): void {
    for (const name of watches.keys()) store.unregisterWatch(name);
    watches.clear();
    store.setWatchedKeys('team-review-departed', []);
    store.setWatchedKeys(ASKED_FOR_WATCH_OWNER, []);
  }

  return { closedEntryKeys, pruneDeparted, collectCandidates, isTeamCandidate, askedForSlotsInUse, watchAskedFor, candidatesFromSnapshot, unregisterWatches };
}

type TeamReviewCandidateSearch = ReturnType<typeof createTeamReviewCandidateSearch>;

export { createTeamReviewCandidateSearch };
export type { TeamReviewCandidateSearch };
