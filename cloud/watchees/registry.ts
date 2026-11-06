import type { WatcheeRegistry } from './watchee.ts';
import { teamReviewWatchee } from './team-review/team-review-watchee.ts';

const WATCHEES: WatcheeRegistry = Object.freeze({
  'team-review.candidates': teamReviewWatchee,
});

export { WATCHEES };
