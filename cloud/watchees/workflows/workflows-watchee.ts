import type { Watchee } from '../watchee.ts';
import { createWatcheeGithubStore, observedPayloadEventKey } from '../github-store-watchee.ts';
import { createWorkflowsSearch } from './workflows-search.ts';

const MS_PER_MINUTE = 60_000;

const workflowsWatchee: Watchee<'workflows.candidates'> = {
  kind: 'workflows.candidates',
  laneId: 'workflows',
  trigger: (settings) => ({ kind: 'interval', everyMs: settings.workflows.intervalMinutes * MS_PER_MINUTE }),
  gate: ({ workflows }) => {
    if (!workflows.enabled) return { run: false, reason: 'workflows is off' };
    if (workflows.repos.length === 0) return { run: false, reason: 'no workflow rule names a repository' };
    return { run: true };
  },
  start: (context) => {
    const search = createWorkflowsSearch({ store: createWatcheeGithubStore(context), now: context.now });
    return {
      detect: async ({ workflows }) => {
        const searched = await search.search(workflows);
        if (!searched.ok) return searched;
        return { ok: true, events: searched.payloads };
      },
      stop: search.stop,
    };
  },
  eventKey: observedPayloadEventKey,
};

export { workflowsWatchee };
