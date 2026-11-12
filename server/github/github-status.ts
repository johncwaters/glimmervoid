import { StatuspageSummary, STATUS_REFRESH_INTERVAL_MS, isStatusReadDue, openIncidents, statusReadErrorText } from './core/github-status-core.ts';
import type { ProviderStatus } from '../../shared/contracts/pack-bridge.ts';
import { clock } from '../../shared/clock.ts';
import { DEFAULT_TIMER_FNS, unrefTimer } from '../../shared/timer-deps.ts';
import type { ClearIntervalFn, SetIntervalFn, TimerHandle } from '../../shared/timer-deps.ts';

const GITHUB_STATUS_URL = 'https://www.githubstatus.com/api/v2/summary.json';
const STATUS_READ_TIMEOUT_MS = 5000;
const STATUS_RESPONSE_MAX_BYTES = 512 * 1024;

type StatusReaderDeps = { fetchFn: typeof fetch; now: () => number; log: Pick<Console, 'warn'> };

async function cappedResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`the response is over ${maxBytes} bytes`);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createStatusReader(url: string, { fetchFn, now, log }: StatusReaderDeps) {
  let status: ProviderStatus = { url, name: null, incidents: [], checkedAtMs: null, error: null };
  let lastReadAtMs: number | null = null;
  let pendingRead: Promise<void> = Promise.resolve();
  let hasWarned = false;

  async function readNow(): Promise<void> {
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS), redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const summary = StatuspageSummary.parse(JSON.parse(await cappedResponseText(response, STATUS_RESPONSE_MAX_BYTES)));
      status = { url, name: summary.page?.name ?? null, incidents: openIncidents(summary), checkedAtMs: now(), error: null };
      hasWarned = false;
    } catch (error: unknown) {
      const errorText = statusReadErrorText(error);
      status = { url, name: status.name, incidents: [], checkedAtMs: now(), error: errorText };
      if (hasWarned) return;
      hasWarned = true;
      log.warn(`[status] read of ${url} failed: ${errorText}`);
    }
  }

  function readIfDue(): Promise<void> {
    const nowMs = now();
    if (!isStatusReadDue(lastReadAtMs, nowMs)) return pendingRead;
    lastReadAtMs = nowMs;
    pendingRead = readNow();
    return pendingRead;
  }

  return { readIfDue, status: () => status };
}

type StatusReader = ReturnType<typeof createStatusReader>;

export function createProviderStatus({
  fetchFn = fetch, now = clock.nowMs, log, onChange,
  setIntervalFn = DEFAULT_TIMER_FNS.setIntervalFn, clearIntervalFn = DEFAULT_TIMER_FNS.clearIntervalFn,
}: {
  fetchFn?: typeof fetch;
  now?: () => number;
  log: Pick<Console, 'warn'>;
  onChange: () => void;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
}) {
  const readerByUrl = new Map<string, StatusReader>();
  let trackedUrls: readonly string[] = [];
  let refreshTimer: TimerHandle | null = null;

  function readerFor(url: string): StatusReader {
    const existing = readerByUrl.get(url);
    if (existing) return existing;
    const reader = createStatusReader(url, { fetchFn, now, log });
    readerByUrl.set(url, reader);
    return reader;
  }

  function refresh(): Promise<void> {
    return Promise.all(trackedUrls.map((url) => readerFor(url).readIfDue())).then(onChange);
  }

  function track(urls: readonly string[]): Promise<void> {
    trackedUrls = [...new Set(urls)];
    if (trackedUrls.length === 0 && refreshTimer !== null) {
      clearIntervalFn(refreshTimer);
      refreshTimer = null;
    }
    if (trackedUrls.length > 0) refreshTimer ??= unrefTimer(setIntervalFn(() => void refresh(), STATUS_REFRESH_INTERVAL_MS));
    return refresh();
  }

  function statuses(urls: readonly string[]): ProviderStatus[] {
    return urls.map((url) => readerByUrl.get(url)?.status() ?? { url, name: null, incidents: [], checkedAtMs: null, error: null });
  }

  return { readerFor, track, statuses };
}

export function createGithubStatus({ providerStatus }: { providerStatus: Pick<ReturnType<typeof createProviderStatus>, 'readerFor'> }) {
  const reader = providerStatus.readerFor(GITHUB_STATUS_URL);
  return {
    noteTransientFailure: (): void => void reader.readIfDue(),
    incident: (): string | null => reader.status().incidents[0]?.name ?? null,
  };
}
