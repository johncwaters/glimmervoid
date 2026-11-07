import { POLL_INTERVAL_MINUTES, readTeamReviewSettings } from '../../server/github/core/team-review-core.ts';
import { POLL_INTERVAL_MINUTES as MY_PRS_POLL_INTERVAL_MINUTES } from '../../server/github/core/my-prs-core.ts';
import type { TeamReviewSettingsSource } from '../../server/github/core/team-review-core.ts';
import { WORKFLOWS_POLL_INTERVAL_MINUTES, resolveWorkflowsSettings, watchedWorkflowRepos, workflowsShouldStart } from '../../server/core/workflows-core.ts';
import type { WatcheeSettingsFile } from '../../shared/contracts/watchee-settings.ts';
import { errorMessage } from '../../shared/text.ts';
import { watcherHomeDir, writeWatcheeSettings } from '../watcher/watchee-settings.ts';

type WatcheeSettingsSource = TeamReviewSettingsSource & { workflows?: unknown };

function watcheeSettingsFromConfig(config: WatcheeSettingsSource): WatcheeSettingsFile {
  const { enabled, org, teams } = readTeamReviewSettings(config);
  const workflowsSettings = resolveWorkflowsSettings(config.workflows);
  return {
    version: 1,
    teamReview: { enabled, org, teams, intervalMinutes: POLL_INTERVAL_MINUTES },
    myPrs: { enabled, org, intervalMinutes: MY_PRS_POLL_INTERVAL_MINUTES },
    workflows: {
      enabled: workflowsShouldStart(workflowsSettings).start,
      repos: workflowsSettings.ok ? watchedWorkflowRepos(workflowsSettings.rules) : [],
      intervalMinutes: WORKFLOWS_POLL_INTERVAL_MINUTES,
    },
  };
}

function syncWatcheeSettings(config: WatcheeSettingsSource, log: Pick<Console, 'warn'> = console): Promise<void> {
  return writeWatcheeSettings(watcherHomeDir(), watcheeSettingsFromConfig(config))
    .catch((error: unknown) => log.warn(`[watcher] could not write the watchee settings: ${errorMessage(error)}`));
}

export { syncWatcheeSettings, watcheeSettingsFromConfig };
