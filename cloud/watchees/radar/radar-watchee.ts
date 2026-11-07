import { extractRows, normalizeIssues } from '../../../server/radar/posthog-api.ts';
import type { PosthogApi } from '../../../server/radar/posthog-api.ts';
import { dailyVolumeQuery } from '../../../server/radar/core/radar-lane-core.ts';
import { shouldRetryTrafficQuery } from '../../../server/core/traffic-spike-core.ts';
import type { RadarProjectPayload } from '../../../shared/contracts/radar-project.ts';
import type { RadarWatcheeSettings } from '../../../shared/contracts/watchee-settings.ts';
import type { DetectOutcome, Watchee, WatcheeContext } from '../watchee.ts';
import { observedPayloadEventKey } from '../watchee-event-key.ts';
import { POSTHOG_API_KEY_ENV, createWatcheePosthog, posthogDetectFailure } from '../posthog-watchee.ts';
import type { PosthogDetectFailure, WatchedPosthogProject } from '../posthog-watchee.ts';

const MS_PER_MINUTE = 60_000;
const TRAFFIC_RETRY_DELAY_MS = 1000;

type TrafficObservation = Pick<RadarProjectPayload, 'traffic' | 'trafficError'>;

async function observeTraffic(api: PosthogApi, projectId: string | number, baselineDays: number): Promise<TrafficObservation> {
  let response = await api.queryTrafficBuckets(projectId, { baselineDays });
  if (!response.ok && 'status' in response && shouldRetryTrafficQuery(response.status)) {
    await new Promise((resolve) => { setTimeout(resolve, TRAFFIC_RETRY_DELAY_MS); });
    response = await api.queryTrafficBuckets(projectId, { baselineDays });
  }
  if (response.ok && 'buckets' in response) return { traffic: { currentUsers: response.currentUsers, buckets: response.buckets }, trafficError: null };
  return { traffic: null, trafficError: 'error' in response ? response.error : 'no response' };
}

async function observeDailyVolumeRows(api: PosthogApi, projectId: string | number, issuesBody: unknown): Promise<RadarProjectPayload['dailyVolumeRows']> {
  const query = dailyVolumeQuery(projectId, normalizeIssues(issuesBody).map((issue) => issue.issueId));
  if (query === null) return null;
  const response = await api.runHogQL(projectId, query);
  return response.ok ? extractRows(response.body) : null;
}

async function observeProject(api: PosthogApi, project: WatchedPosthogProject, radar: RadarWatcheeSettings, now: () => number): Promise<RadarProjectPayload | PosthogDetectFailure> {
  const observed = { observedAt: new Date(now()).toISOString(), host: radar.host, projectId: project.projectId, projectName: project.name };
  const issues = await api.queryIssues(project.projectId);
  if (!issues.ok && 'retryAfterMs' in issues && issues.retryAfterMs !== undefined) return posthogDetectFailure('issue query', issues);
  if (!issues.ok) return { ...observed, error: issues.error, issuesBody: null, spikesBody: null, traffic: null, trafficError: null, dailyVolumeRows: null };
  const spikes = await api.listSpikeEvents(project.projectId);
  const traffic = radar.traffic.enabled ? await observeTraffic(api, project.projectId, radar.traffic.baselineDays) : { traffic: null, trafficError: null };
  return {
    ...observed,
    error: null,
    issuesBody: issues.body,
    spikesBody: spikes.ok ? spikes.body : null,
    ...traffic,
    dailyVolumeRows: await observeDailyVolumeRows(api, project.projectId, issues.body),
  };
}

function createRadarDetect(context: Pick<WatcheeContext, 'now'>, fetchFn?: typeof fetch) {
  return async ({ radar }: { radar: RadarWatcheeSettings }): Promise<DetectOutcome<'radar.project'>> => {
    const posthog = createWatcheePosthog(radar.host, fetchFn);
    if (posthog === null) return { ok: false, reason: `${POSTHOG_API_KEY_ENV} is not set for glimmervoid watch` };
    const projects = await posthog.resolveProjects(radar.projects, radar.projectNames);
    if (!Array.isArray(projects)) return projects;
    const events: RadarProjectPayload[] = [];
    for (const project of projects) {
      const observed = await observeProject(posthog.api, project, radar, context.now);
      if ('ok' in observed) return observed;
      events.push(observed);
    }
    return { ok: true, events };
  };
}

const radarWatchee: Watchee<'radar.project'> = {
  kind: 'radar.project',
  laneId: 'radar',
  trigger: (settings) => ({ kind: 'interval', everyMs: settings.radar.intervalMinutes * MS_PER_MINUTE }),
  gate: ({ radar }) => {
    if (!radar.enabled) return { run: false, reason: 'PostHog monitoring is off' };
    return { run: true };
  },
  start: (context) => ({ detect: createRadarDetect(context), stop: () => {} }),
  eventKey: observedPayloadEventKey,
};

export { createRadarDetect, radarWatchee };
