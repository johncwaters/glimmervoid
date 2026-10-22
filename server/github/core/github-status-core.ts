import { z } from 'zod';

const GITHUB_STATUS_CACHE_MS = 5 * 60_000;

export const GithubStatusSummary = z.object({
  incidents: z.array(z.object({
    name: z.string(),
    status: z.string(),
    updated_at: z.iso.datetime({ offset: true }),
  })),
});

export function openIncidentName(body: unknown): string | null {
  const summary = GithubStatusSummary.safeParse(body);
  if (!summary.success) return null;
  const openIncidents = summary.data.incidents.filter((incident) => incident.status !== 'resolved' && incident.status !== 'postmortem');
  openIncidents.sort((first, second) => Date.parse(second.updated_at) - Date.parse(first.updated_at));
  return openIncidents[0]?.name ?? null;
}

export function isStatusReadDue(lastReadAtMs: number | null, nowMs: number): boolean {
  return lastReadAtMs === null || nowMs - lastReadAtMs >= GITHUB_STATUS_CACHE_MS;
}
