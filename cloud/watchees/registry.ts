import type { WatcheeRegistry } from './watchee.ts';
import { myPrsWatchee } from './my-prs/my-prs-watchee.ts';
import { teamReviewWatchee } from './team-review/team-review-watchee.ts';
import { workflowsWatchee } from './workflows/workflows-watchee.ts';

const WATCHEES: WatcheeRegistry = Object.freeze({
  'team-review.candidates': teamReviewWatchee,
  'my-prs.candidates': myPrsWatchee,
  'workflows.candidates': workflowsWatchee,
});

export { WATCHEES };
