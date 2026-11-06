import { POLL_INTERVAL_MINUTES, readTeamReviewSettings } from '../../server/github/core/team-review-core.ts';
import type { TeamReviewSettingsSource } from '../../server/github/core/team-review-core.ts';
import type { WatcheeSettingsFile } from '../../shared/contracts/watchee-settings.ts';
import { errorMessage } from '../../shared/text.ts';
import { watcherHomeDir, writeWatcheeSettings } from '../watcher/watchee-settings.ts';

function watcheeSettingsFromConfig(config: TeamReviewSettingsSource): WatcheeSettingsFile {
  const { enabled, org, teams } = readTeamReviewSettings(config);
  return { version: 1, teamReview: { enabled, org, teams, intervalMinutes: POLL_INTERVAL_MINUTES } };
}

function syncWatcheeSettings(config: TeamReviewSettingsSource, log: Pick<Console, 'warn'> = console): Promise<void> {
  return writeWatcheeSettings(watcherHomeDir(), watcheeSettingsFromConfig(config))
    .catch((error: unknown) => log.warn(`[watcher] could not write the watchee settings: ${errorMessage(error)}`));
}

export { syncWatcheeSettings, watcheeSettingsFromConfig };
