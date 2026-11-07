import type { Watchee } from '../watchee.ts';
import { createWatcheeGithubStore } from '../github-store-watchee.ts';
import { observedPayloadEventKey } from '../watchee-event-key.ts';
import { createMyPrsSearch } from './my-prs-search.ts';

const MS_PER_MINUTE = 60_000;

const myPrsWatchee: Watchee<'my-prs.candidates'> = {
  kind: 'my-prs.candidates',
  laneId: 'my-prs',
  trigger: (settings) => ({ kind: 'interval', everyMs: settings.myPrs.intervalMinutes * MS_PER_MINUTE }),
  gate: ({ myPrs }) => {
    if (!myPrs.enabled) return { run: false, reason: 'my pull requests is off' };
    if (!myPrs.org) return { run: false, reason: 'my pull requests has no GitHub organization' };
    return { run: true };
  },
  start: (context) => {
    const search = createMyPrsSearch({ store: createWatcheeGithubStore(context), now: context.now });
    return {
      detect: async ({ myPrs }) => {
        const searched = await search.search(myPrs);
        if (!searched.ok) return searched;
        return { ok: true, events: [searched.payload] };
      },
      stop: search.stop,
    };
  },
  eventKey: observedPayloadEventKey,
};

export { myPrsWatchee };
