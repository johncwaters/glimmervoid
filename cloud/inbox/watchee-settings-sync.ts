import { POLL_INTERVAL_MINUTES, readTeamReviewSettings } from '../../server/github/core/team-review-core.ts';
import { POLL_INTERVAL_MINUTES as ISSUES_POLL_INTERVAL_MINUTES } from '../../server/github/core/issues-core.ts';
import { readGithubTeams } from '../../server/github/core/github-teams-core.ts';
import { POLL_INTERVAL_MINUTES as MY_PRS_POLL_INTERVAL_MINUTES } from '../../server/github/core/my-prs-core.ts';
import type { TeamReviewSettingsSource } from '../../server/github/core/team-review-core.ts';
import { WORKFLOWS_POLL_INTERVAL_MINUTES, resolveWorkflowsSettings, watchedWorkflowRepos, workflowsShouldStart } from '../../server/core/workflows-core.ts';
import type { WatcheeSettingsFile } from '../../shared/contracts/watchee-settings.ts';
import { errorMessage } from '../../shared/text.ts';
import { watcherHomeDir, writeWatcheeSettings } from '../watcher/watchee-settings.ts';

type WatcheeSettingsSource = TeamReviewSettingsSource & { workflows?: unknown; issues?: { enabled?: unknown } | null };

function watcheeSettingsFromConfig(config: WatcheeSettingsSource, issuesProjectRepos: readonly string[]): WatcheeSettingsFile {
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
    issues: {
      enabled: config.issues?.enabled === true,
      projectRepos: [...issuesProjectRepos],
      teams: readGithubTeams(config).map((team) => `${team.org}/${team.slug}`),
      intervalMinutes: ISSUES_POLL_INTERVAL_MINUTES,
    },
  };
}

function syncWatcheeSettings(config: WatcheeSettingsSource, issuesProjectRepos: readonly string[], log: Pick<Console, 'warn'> = console): Promise<void> {
  return writeWatcheeSettings(watcherHomeDir(), watcheeSettingsFromConfig(config, issuesProjectRepos))
    .catch((error: unknown) => log.warn(`[watcher] could not write the watchee settings: ${errorMessage(error)}`));
}

export { syncWatcheeSettings, watcheeSettingsFromConfig };
