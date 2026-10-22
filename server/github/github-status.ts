import { errorMessage } from '../../shared/text.ts';
import { GithubStatusSummary, isStatusReadDue, openIncidentName } from './core/github-status-core.ts';

interface GithubStatusOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  log: Pick<Console, 'warn'>;
}

export function createGithubStatus({ fetchFn = fetch, now = Date.now, log }: GithubStatusOptions) {
  let lastReadAtMs: number | null = null;
  let cachedIncident: string | null = null;
  let hasWarned = false;

  async function readStatus(): Promise<void> {
    try {
      const response = await fetchFn('https://www.githubstatus.com/api/v2/summary.json', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const summary = GithubStatusSummary.parse(await response.json());
      cachedIncident = openIncidentName(summary);
      hasWarned = false;
    } catch (error: unknown) {
      cachedIncident = null;
      if (hasWarned) return;
      hasWarned = true;
      log.warn(`[github-status] read failed: ${errorMessage(error)}`);
    }
  }

  function noteTransientFailure(): void {
    const nowMs = now();
    if (!isStatusReadDue(lastReadAtMs, nowMs)) return;
    lastReadAtMs = nowMs;
    void readStatus();
  }

  return { noteTransientFailure, incident: (): string | null => cachedIncident };
}
