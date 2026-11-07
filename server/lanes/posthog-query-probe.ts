import type { Probe } from '../../shared/contracts/watcher-link.ts';

const MIN_PROBE_EVERY_MS = 60_000;

interface PosthogQueryProbeRequest {
  id: string;
  laneId: string;
  host: string;
  projectId: string | number;
  query: string;
  values?: Record<string, unknown>;
  intervalMinutes: number;
}

function posthogQueryProbe({ id, laneId, host, projectId, query, values, intervalMinutes }: PosthogQueryProbeRequest): Probe {
  const url = new URL(`/api/projects/${encodeURIComponent(String(projectId))}/query/`, host);
  const body = JSON.stringify({ query: { kind: 'HogQLQuery', query, ...(values ? { values } : {}) }, name: `glimmervoid watcher ${id}` });
  const everyMs = Math.max(MIN_PROBE_EVERY_MS, Math.round(intervalMinutes * 60_000));
  return { id, laneId, everyMs, method: 'POST', url: url.toString(), body, credential: 'posthog', answerField: 'results' };
}

export { posthogQueryProbe };
