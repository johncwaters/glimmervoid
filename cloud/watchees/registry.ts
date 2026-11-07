import type { WatcheeRegistry } from './watchee.ts';
import { issuesWatchee } from './issues/issues-watchee.ts';
import { myPrsWatchee } from './my-prs/my-prs-watchee.ts';
import { teamReviewWatchee } from './team-review/team-review-watchee.ts';
import { workflowsWatchee } from './workflows/workflows-watchee.ts';
import { radarWatchee } from './radar/radar-watchee.ts';

const WATCHEES: WatcheeRegistry = Object.freeze({
  'team-review.candidates': teamReviewWatchee,
  'my-prs.candidates': myPrsWatchee,
  'workflows.candidates': workflowsWatchee,
  'issues.listing': issuesWatchee,
  'radar.project': radarWatchee,
});

export { WATCHEES };
