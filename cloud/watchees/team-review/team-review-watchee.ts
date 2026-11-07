import type { Watchee } from '../watchee.ts';
import { createWatcheeGithubStore } from '../github-store-watchee.ts';
import { observedPayloadEventKey } from '../watchee-event-key.ts';
import { createTeamReviewSearch } from './team-review-search.ts';

const MS_PER_MINUTE = 60_000;

const teamReviewWatchee: Watchee<'team-review.candidates'> = {
  kind: 'team-review.candidates',
  laneId: 'team-review',
  trigger: (settings) => ({ kind: 'interval', everyMs: settings.teamReview.intervalMinutes * MS_PER_MINUTE }),
  gate: ({ teamReview }) => {
    if (!teamReview.enabled) return { run: false, reason: 'team review is off' };
    if (!teamReview.org) return { run: false, reason: 'team review has no GitHub organization or team' };
    return { run: true };
  },
  start: (context) => {
    const search = createTeamReviewSearch({ store: createWatcheeGithubStore(context), now: context.now });
    return {
      detect: async ({ teamReview }) => {
        const searched = await search.search(teamReview);
        if (!searched.ok) return searched;
        return { ok: true, events: [searched.payload] };
      },
      stop: search.stop,
    };
  },
  eventKey: observedPayloadEventKey,
};

export { teamReviewWatchee };
