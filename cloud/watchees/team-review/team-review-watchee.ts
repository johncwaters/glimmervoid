import crypto from 'node:crypto';
import type { Watchee } from '../watchee.ts';
import { createGithubStorePoller } from '../../../server/github/github-store-poller.ts';
import { createPrGh } from '../../../server/github/pr-gh.ts';
import { DEFAULT_TIMER_FNS } from '../../../shared/timer-deps.ts';
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
  start: ({ watcherHome, now, log }) => {
    const store = createGithubStorePoller({
      github: createPrGh(watcherHome),
      now,
      isDashboardConnected: () => false,
      exclusive: async (work) => work(),
      setTimeoutFn: DEFAULT_TIMER_FNS.setTimeoutFn,
      clearTimeoutFn: DEFAULT_TIMER_FNS.clearTimeoutFn,
      log,
    });
    const search = createTeamReviewSearch({ store, now });
    return {
      detect: async ({ teamReview }) => {
        const searched = await search.search(teamReview);
        if (!searched.ok) return searched;
        return { ok: true, events: [searched.payload] };
      },
      stop: search.stop,
    };
  },
  eventKey: (payload, intervalStartMs) => {
    const { observedAt: _observedAt, ...observed } = payload;
    return `${intervalStartMs}:${crypto.createHash('sha256').update(JSON.stringify(observed)).digest('hex')}`;
  },
};

export { teamReviewWatchee };
