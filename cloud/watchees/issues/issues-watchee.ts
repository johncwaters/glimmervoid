import type { Watchee } from '../watchee.ts';
import { createWatcheeGithubStore, observedPayloadEventKey } from '../github-store-watchee.ts';
import { createIssuesListing } from './issues-listing.ts';

const MS_PER_MINUTE = 60_000;

const issuesWatchee: Watchee<'issues.listing'> = {
  kind: 'issues.listing',
  laneId: 'issues',
  trigger: (settings) => ({ kind: 'interval', everyMs: settings.issues.intervalMinutes * MS_PER_MINUTE }),
  gate: ({ issues }) => issues.enabled ? { run: true } : { run: false, reason: 'issues is off' },
  start: (context) => {
    const listing = createIssuesListing({ store: createWatcheeGithubStore(context), now: context.now });
    return {
      detect: async ({ issues }) => {
        const listed = await listing.list(issues);
        if (!listed.ok) return listed;
        return { ok: true, events: listed.payloads };
      },
      stop: () => {},
    };
  },
  eventKey: observedPayloadEventKey,
};

export { issuesWatchee };
