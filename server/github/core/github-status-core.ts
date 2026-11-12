import { z } from 'zod';
import { ProviderIncidentStatus } from '../../../shared/contracts/pack-bridge.ts';

const STATUS_CACHE_MS = 5 * 60_000;

export const StatuspageSummary = z.object({
  page: z.object({ name: z.string().max(200) }).optional(),
  incidents: z.array(z.object({
    name: z.string(),
    status: z.string(),
    impact: z.string().optional(),
    shortlink: z.string().optional(),
    updated_at: z.iso.datetime({ offset: true }),
  })),
});
type StatuspageSummary = z.infer<typeof StatuspageSummary>;

const CLOSED_INCIDENT_STATUSES: readonly string[] = ['resolved', 'postmortem', 'completed'];
const INCIDENT_NAME_MAX_CHARS = 300;
const INCIDENT_IMPACT_MAX_CHARS = 40;

type StatusIncident = { name: string; status: IncidentStatus; impact: string | null; updatedAtMs: number; url: string | null };
type IncidentStatus = z.infer<typeof ProviderIncidentStatus>;

function incidentStatusOf(status: string): IncidentStatus {
  const known = ProviderIncidentStatus.safeParse(status);
  return known.success ? known.data : 'other';
}

function httpsLinkOrNull(link: string | undefined): string | null {
  return link !== undefined && URL.canParse(link) && new URL(link).protocol === 'https:' ? link : null;
}

export function openIncidents(summary: StatuspageSummary): StatusIncident[] {
  return summary.incidents
    .filter((incident) => !CLOSED_INCIDENT_STATUSES.includes(incident.status))
    .map((incident) => ({
      name: incident.name.slice(0, INCIDENT_NAME_MAX_CHARS), status: incidentStatusOf(incident.status), impact: incident.impact?.slice(0, INCIDENT_IMPACT_MAX_CHARS) ?? null,
      updatedAtMs: Date.parse(incident.updated_at), url: httpsLinkOrNull(incident.shortlink),
    }))
    .sort((first, second) => second.updatedAtMs - first.updatedAtMs);
}

export function isStatusReadDue(lastReadAtMs: number | null, nowMs: number): boolean {
  return lastReadAtMs === null || nowMs - lastReadAtMs >= STATUS_CACHE_MS;
}

export const STATUS_REFRESH_INTERVAL_MS = STATUS_CACHE_MS;

const STATUS_ERROR_MAX_CHARS = 300;

export function statusReadErrorText(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'the reply is not a statuspage summary JSON';
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
  return `${message}${cause}`.slice(0, STATUS_ERROR_MAX_CHARS);
}
