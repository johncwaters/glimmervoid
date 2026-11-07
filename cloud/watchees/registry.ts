import type { WatcheeRegistry } from './watchee.ts';
import { radarWatchee } from './radar/radar-watchee.ts';
import { communityWatchee } from './community/community-watchee.ts';

const WATCHEES: WatcheeRegistry = Object.freeze({
  'radar.project': radarWatchee,
  'community.rows': communityWatchee,
});

export { WATCHEES };
