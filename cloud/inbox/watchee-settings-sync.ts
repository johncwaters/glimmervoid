import { POLL_INTERVAL_MINUTES as ISSUES_POLL_INTERVAL_MINUTES } from '../../server/github/core/issues-core.ts';
import { readGithubTeams } from '../../server/github/core/github-teams-core.ts';
import type { TeamReviewSettingsSource } from '../../server/github/core/team-review-core.ts';
import { WORKFLOWS_POLL_INTERVAL_MINUTES, resolveWorkflowsSettings, watchedWorkflowRepos, workflowsShouldStart } from '../../server/core/workflows-core.ts';
import { DEFAULT_INTERVAL_MINUTES as RADAR_POLL_INTERVAL_MINUTES, radarShouldStart, resolvePosthogHost } from '../../server/radar/core/radar-lane-core.ts';
import { DEFAULT_TRAFFIC_BASELINE_DAYS } from '../../server/core/traffic-spike-core.ts';
import { communityGate, readCommunitySettings } from '../../server/community/core/community-core.ts';
import type { CommunityWatcheeSettings, RadarWatcheeSettings, WatcheeSettingsFile } from '../../shared/contracts/watchee-settings.ts';

interface RadarSettingsSource {
  posthog?: {
    enabled?: boolean;
    apiKey?: string;
    host?: unknown;
    intervalMinutes?: unknown;
    projects?: unknown;
    projectMap?: unknown;
    trafficSpikeEnabled?: unknown;
    trafficSpikeBaselineDays?: unknown;
  } | null;
  telegram?: { botToken?: string; chatId?: string } | null;
}

type WatcheeSettingsSource = TeamReviewSettingsSource & RadarSettingsSource & { workflows?: unknown; issues?: { enabled?: unknown } | null };

function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isProjectId(value: unknown): value is string | number {
  return (typeof value === 'string' && value !== '') || Number.isInteger(value);
}

function watchedProjects(projects: unknown): RadarWatcheeSettings['projects'] {
  return Array.isArray(projects) ? projects.filter(isProjectId) : 'all';
}

function projectNamesFrom(projectMap: unknown): Record<string, string> {
  if (projectMap === null || typeof projectMap !== 'object') return {};
  return Object.fromEntries(Object.entries(projectMap).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function radarWatcheeSettings(config: RadarSettingsSource): RadarWatcheeSettings {
  const posthog = config.posthog ?? {};
  return {
    enabled: radarShouldStart(config).start,
    host: resolvePosthogHost(typeof posthog.host === 'string' ? posthog.host : null),
    projects: watchedProjects(posthog.projects),
    projectNames: projectNamesFrom(posthog.projectMap),
    intervalMinutes: positiveNumberOr(posthog.intervalMinutes, RADAR_POLL_INTERVAL_MINUTES),
    traffic: {
      enabled: posthog.trafficSpikeEnabled !== false,
      baselineDays: positiveNumberOr(posthog.trafficSpikeBaselineDays, DEFAULT_TRAFFIC_BASELINE_DAYS),
    },
  };
}

function communityWatcheeSettings(config: { community?: unknown; posthog?: unknown; github?: { readToken?: string } | null }): CommunityWatcheeSettings {
  const posthogHost = (config.posthog as { host?: unknown } | null | undefined)?.host;
  const { projectId, discordChannels, intervalMinutes } = readCommunitySettings(config);
  return {
    enabled: communityGate(config, process.env).start,
    host: resolvePosthogHost(typeof posthogHost === 'string' ? posthogHost : null),
    projectId,
    discordChannels,
    intervalMinutes,
  };
}

function watcheeSettingsFromConfig(config: WatcheeSettingsSource, issuesProjectRepos: readonly string[]): WatcheeSettingsFile {
  const workflowsSettings = resolveWorkflowsSettings(config.workflows);
  return {
    version: 1,
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
    radar: radarWatcheeSettings(config),
    community: communityWatcheeSettings(config),
  };
}

export { watcheeSettingsFromConfig };
