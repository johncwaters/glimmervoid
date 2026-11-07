import { createPosthogApi } from '../../server/radar/posthog-api.ts';
import type { PosthogApi, PosthogResponse } from '../../server/radar/posthog-api.ts';
import type { RadarWatcheeSettings } from '../../shared/contracts/watchee-settings.ts';

const POSTHOG_API_KEY_ENV = 'GLIMMERVOID_POSTHOG_API_KEY';
const STOCK_PROJECT_NAME = 'Default project';

type ProjectId = string | number;

interface WatchedPosthogProject {
  projectId: ProjectId;
  name: string;
}

type PosthogDetectFailure = { ok: false; reason: string; retryAfterMs?: number };

interface WatcheePosthog {
  api: PosthogApi;
  resolveProjects(projects: RadarWatcheeSettings['projects'], projectNames: Record<string, string>): Promise<WatchedPosthogProject[] | PosthogDetectFailure>;
}

function listedRows<Row>(body: unknown): Row[] {
  if (Array.isArray(body)) return body as Row[];
  const results = (body as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? results as Row[] : [];
}

function posthogDetectFailure(what: string, response: PosthogResponse): PosthogDetectFailure {
  const reason = `PostHog ${what} failed: ${response.ok ? 'no rows' : response.error}`;
  if (!response.ok && 'retryAfterMs' in response && response.retryAfterMs !== undefined) return { ok: false, reason, retryAfterMs: response.retryAfterMs };
  return { ok: false, reason };
}

function createWatcheePosthog(host: string, fetchFn?: typeof fetch): WatcheePosthog | null {
  const apiKey = process.env[POSTHOG_API_KEY_ENV];
  if (!apiKey) return null;
  const api = createPosthogApi({ host, apiKey, fetchFn });

  async function resolveProjects(projects: RadarWatcheeSettings['projects'], projectNames: Record<string, string>): Promise<WatchedPosthogProject[] | PosthogDetectFailure> {
    if (projects !== 'all') return projects.map((projectId) => ({ projectId, name: projectNames[String(projectId)] || String(projectId) }));
    const organizations = await api.listOrganizations();
    if (!organizations.ok) return posthogDetectFailure('organization list', organizations);
    const watchedProjects: WatchedPosthogProject[] = [];
    for (const organization of listedRows<{ id: string; name?: string }>(organizations.body)) {
      const listed = await api.listProjects(organization.id);
      if (!listed.ok) continue;
      for (const project of listedRows<{ id: ProjectId; name?: string }>(listed.body)) {
        const isStockName = !project.name || project.name === STOCK_PROJECT_NAME;
        const fallbackName = (isStockName && organization.name) || project.name || String(project.id);
        watchedProjects.push({ projectId: project.id, name: projectNames[String(project.id)] || fallbackName });
      }
    }
    return watchedProjects;
  }

  return { api, resolveProjects };
}

export { POSTHOG_API_KEY_ENV, createWatcheePosthog, posthogDetectFailure };
export type { PosthogDetectFailure, WatchedPosthogProject, WatcheePosthog };
