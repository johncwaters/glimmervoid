import { nextBackoffMs } from '../../shared/backoff.ts';
import { STATUS_PATH, WatcherStatus } from '../../shared/contracts/watcher-link.ts';
import { directionKey, signedHeaders } from './core/link-signing-core.ts';
import { clock } from '../../shared/clock.ts';

type WatcherStarter = (options: {
  linkSecret: Buffer;
  onListening: (watcherUrl: string) => void;
  onEnded: () => void;
  log?: Pick<Console, 'log' | 'warn'>;
}) => { start(): void; stop(): void; checkNow(): void };

const STATUS_CHECK_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;
const UNLINKED_RETRY_BASE_MS = 1_000;
const UNLINKED_WARNING_CHECK_COUNT = 5;

function originOf(watcherUrl: string): string {
  return URL.parse(watcherUrl)?.origin ?? watcherUrl;
}

function createRemoteWatcherStarter({ resolveWatcherUrl, prepareWatcher = async () => {}, statusCheckMs = STATUS_CHECK_MS, fetchFn = fetch, now = clock.nowMs }: {
  resolveWatcherUrl: () => Promise<string | null>;
  prepareWatcher?: () => Promise<void>;
  statusCheckMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}): WatcherStarter {
  return ({ linkSecret, onListening, onEnded, log = console }) => {
    const commandKey = directionKey(linkSecret, 'server-to-watcher');
    let checkTimer: NodeJS.Timeout | null = null;
    let isStopped = false;
    let answeringUrl: string | null = null;
    let unansweredCheckCount = 0;
    let isCheckWantedNow = false;
    let lastPrepareProblem: string | null = null;

    async function isWatcherAnswering(watcherUrl: string): Promise<boolean> {
      try {
        const response = await fetchFn(new URL(STATUS_PATH, watcherUrl), {
          method: 'GET',
          headers: signedHeaders(commandKey, { method: 'GET', path: STATUS_PATH, body: '' }, now()),
          signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return false;
        }
        const status = WatcherStatus.safeParse(await response.json());
        if (!status.success) return false;
        return status.data.nudgesFailingForMs === null || status.data.nudgesFailingForMs < statusCheckMs;
      } catch {
        return false;
      }
    }

    async function prepare(): Promise<void> {
      const problem = await prepareWatcher().then(() => null, (prepareError: unknown) => prepareError instanceof Error ? prepareError.message : String(prepareError));
      if (problem !== null && problem !== lastPrepareProblem) log.warn(`[watcher] could not start the local doorman: ${problem}`);
      lastPrepareProblem = problem;
    }

    async function checkWatcher(): Promise<void> {
      await prepare();
      const triedUrl = await resolveWatcherUrl();
      const isAnswering = triedUrl !== null && await isWatcherAnswering(triedUrl);
      if (isStopped) return;
      const watcherUrl = isAnswering ? triedUrl : null;
      if (watcherUrl !== null) {
        if (answeringUrl === null) log.log(`[watcher] linked the watcher at ${originOf(watcherUrl)}`);
        answeringUrl = watcherUrl;
        unansweredCheckCount = 0;
        onListening(watcherUrl);
        return;
      }
      unansweredCheckCount += 1;
      if (answeringUrl === null) {
        if (unansweredCheckCount === UNLINKED_WARNING_CHECK_COUNT) log.warn(`[watcher] no watcher answers${triedUrl === null ? ' yet' : ` at ${originOf(triedUrl)}`} after ${unansweredCheckCount} checks, lanes keep their own timers until one does`);
        return;
      }
      log.warn(`[watcher] the watcher at ${originOf(answeringUrl)} stopped answering or cannot nudge this server, lanes go back to their own timers`);
      answeringUrl = null;
      onEnded();
    }

    function nextCheckDelayMs(): number {
      if (unansweredCheckCount === 0) return statusCheckMs;
      return nextBackoffMs({ attempt: unansweredCheckCount, baseMs: UNLINKED_RETRY_BASE_MS, maxMs: statusCheckMs, jitter: 'none' });
    }

    function scheduleCheck(delayMs: number): void {
      checkTimer = setTimeout(() => {
        checkTimer = null;
        void checkWatcher().finally(() => {
          if (isStopped) return;
          scheduleCheck(isCheckWantedNow ? 0 : nextCheckDelayMs());
          isCheckWantedNow = false;
        });
      }, delayMs);
      checkTimer.unref();
    }

    function start(): void {
      scheduleCheck(0);
    }

    function checkNow(): void {
      if (isStopped) return;
      if (checkTimer === null) {
        isCheckWantedNow = true;
        return;
      }
      clearTimeout(checkTimer);
      scheduleCheck(0);
    }

    function stop(): void {
      isStopped = true;
      if (checkTimer !== null) clearTimeout(checkTimer);
      checkTimer = null;
    }

    return { start, stop, checkNow };
  };
}

export { createRemoteWatcherStarter };
export type { WatcherStarter };
