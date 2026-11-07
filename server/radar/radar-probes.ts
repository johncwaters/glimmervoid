import type { Probe } from '../../shared/contracts/watcher-link.ts';
import { posthogQueryProbe } from '../lanes/posthog-query-probe.ts';

const RADAR_LANE_ID = 'radar';
const NEWEST_EXCEPTION_QUERY = "SELECT max(timestamp) FROM events WHERE event = '$exception' AND timestamp > now() - INTERVAL 7 DAY";

function radarProbes({ host, projectIds, intervalMinutes }: { host: string; projectIds: readonly (string | number)[]; intervalMinutes: number }): Probe[] {
  const probedProjectIds = [...new Set(projectIds.map(String))].filter((projectId) => /^[0-9]{1,20}$/.test(projectId));
  return probedProjectIds.map((projectId) => posthogQueryProbe({
    id: `${RADAR_LANE_ID}:${projectId}`, laneId: RADAR_LANE_ID, host, projectId, query: NEWEST_EXCEPTION_QUERY, intervalMinutes,
  }));
}

export { RADAR_LANE_ID, radarProbes };
