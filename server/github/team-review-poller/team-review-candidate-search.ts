import { comparablePrKey } from '../../../shared/contracts/github-prs.ts';
import type { GithubPr } from '../../../shared/contracts/github-prs.ts';
import type { TeamReviewCandidatesPayload } from '../../../shared/contracts/team-review-candidates.ts';
import * as core from '../core/team-review-core.ts';
import type { TeamReviewCandidate } from '../core/team-review-core.ts';
import { ASKED_FOR_WATCH_OWNER } from './team-review-poller-context.ts';
import type { TeamReviewPollerContext } from './team-review-poller-context.ts';

function newerPr(watchedPr: GithubPr, heldPr: GithubPr | undefined): GithubPr {
  if (heldPr === undefined || Date.parse(heldPr.updatedAt) <= Date.parse(watchedPr.updatedAt)) return watchedPr;
  return heldPr;
}

function createTeamReviewCandidateSearch(context: TeamReviewPollerContext) {
  const { teams, store, discardResumable, now, skipIdleAfterMs, runtime } = context;

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

  function candidatesFrom(searched: TeamReviewCandidatesPayload): { candidates: TeamReviewCandidate[]; prsByKey: Map<string, GithubPr>; isComplete: boolean } {
    const snapshot = store.getSnapshot();
    let isAskedForComplete = true;
    const askedFor = askedForKeys().flatMap((key) => {
      const pr = snapshot.prs[key.toLowerCase()];
      if (pr) return [pr];
      const requestedAt = runtime.state[key]?.requestedAt ?? 0;
      if (now() - requestedAt < core.ASKED_FOR_FETCH_GRACE_MS) isAskedForComplete = false;
      return [];
    });
    const prsByKey = new Map<string, GithubPr>();
    for (const pr of [...askedFor, ...searched.directRequested, ...searched.teamRequested, ...searched.authored]) {
      const key = comparablePrKey(pr);
      prsByKey.set(key, newerPr(pr, snapshot.prs[key]));
    }
    const selected = core.selectCandidates(searched.directRequested, searched.teamRequested, searched.authored, { self: searched.viewer, nowMs: now(), skipIdleAfterMs, askedFor });
    runtime.teamCandidateKeys = selected.teamCandidateKeys;
    return { candidates: selected.candidates, prsByKey, isComplete: searched.isComplete && isAskedForComplete };
  }

  async function requestTeamProfile(): Promise<void> {
    const [firstTeam] = teams;
    if (!firstTeam || runtime.teamProfile !== null) return;
    const profileRead = await store.requestTeamProfile(firstTeam.org, firstTeam.slug, 'no-wait');
    if (profileRead.isRateLimited) {
      runtime.tickRateLimitWaitMs = profileRead.waitMs;
      return;
    }
    runtime.teamProfile = profileRead.value;
  }

  function unregisterWatches(): void {
    store.setWatchedKeys('team-review-departed', []);
    store.setWatchedKeys(ASKED_FOR_WATCH_OWNER, []);
  }

  return { closedEntryKeys, pruneDeparted, candidatesFrom, requestTeamProfile, isTeamCandidate, askedForSlotsInUse, watchAskedFor, unregisterWatches };
}

type TeamReviewCandidateSearch = ReturnType<typeof createTeamReviewCandidateSearch>;

export { createTeamReviewCandidateSearch };
export type { TeamReviewCandidateSearch };
