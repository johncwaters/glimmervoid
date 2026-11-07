import type { WatcheeRegistry } from './watchee.ts';
import { issuesWatchee } from './issues/issues-watchee.ts';
import { workflowsWatchee } from './workflows/workflows-watchee.ts';
import { radarWatchee } from './radar/radar-watchee.ts';
import { communityWatchee } from './community/community-watchee.ts';

const WATCHEES: WatcheeRegistry = Object.freeze({
  'workflows.candidates': workflowsWatchee,
  'issues.listing': issuesWatchee,
  'radar.project': radarWatchee,
  'community.rows': communityWatchee,
});

export { WATCHEES };
