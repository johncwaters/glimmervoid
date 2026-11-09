import { nextBackoffMs } from '../../shared/backoff.ts';
import { STATUS_PATH, WatcherStatus } from '../../shared/contracts/watcher-link.ts';
import type { WatcherChildEndKind } from '../../shared/contracts/telemetry.ts';
import { directionKey, signedHeaders } from './core/link-signing-core.ts';

interface WatcherEnding {
  endKind: WatcherChildEndKind;
  runMs: number;
  willRestart: boolean;
}

type WatcherStarter = (options: {
  linkSecret: Buffer;
  onListening: (watcherUrl: string) => void;
  onEnded: (ending: WatcherEnding) => void;
  log?: Pick<Console, 'log' | 'warn'>;
}) => { start(): void; stop(): void };

const STATUS_CHECK_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;
const UNLINKED_RETRY_BASE_MS = 1_000;

function originOf(watcherUrl: string): string {
  return URL.parse(watcherUrl)?.origin ?? watcherUrl;
}

function createRemoteWatcherStarter({ resolveWatcherUrl, prepareWatcher = async () => {}, statusCheckMs = STATUS_CHECK_MS, fetchFn = fetch, now = Date.now }: {
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
    let answeringSinceMs = 0;
    let unansweredCheckCount = 0;
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

    async function answeringWatcherUrl(): Promise<string | null> {
      await prepare();
      const watcherUrl = await resolveWatcherUrl();
      if (watcherUrl === null) return null;
      return await isWatcherAnswering(watcherUrl) ? watcherUrl : null;
    }

    async function checkWatcher(): Promise<void> {
      const watcherUrl = await answeringWatcherUrl();
      if (isStopped) return;
      if (watcherUrl !== null) {
        if (answeringUrl === null) {
          answeringSinceMs = now();
          log.log(`[watcher] linked the watcher at ${originOf(watcherUrl)}`);
        }
        answeringUrl = watcherUrl;
        unansweredCheckCount = 0;
        onListening(watcherUrl);
        return;
      }
      unansweredCheckCount += 1;
      if (answeringUrl === null) return;
      log.warn(`[watcher] the watcher at ${originOf(answeringUrl)} stopped answering or cannot nudge this server, lanes go back to their own timers`);
      answeringUrl = null;
      onEnded({ endKind: 'unreachable', runMs: now() - answeringSinceMs, willRestart: true });
    }

    function nextCheckDelayMs(): number {
      if (unansweredCheckCount === 0) return statusCheckMs;
      return nextBackoffMs({ attempt: unansweredCheckCount, baseMs: UNLINKED_RETRY_BASE_MS, maxMs: statusCheckMs, jitter: 'none' });
    }

    function scheduleCheck(delayMs: number): void {
      checkTimer = setTimeout(() => {
        void checkWatcher().finally(() => {
          if (!isStopped) scheduleCheck(nextCheckDelayMs());
        });
      }, delayMs);
      checkTimer.unref();
    }

    function start(): void {
      scheduleCheck(0);
    }

    function stop(): void {
      isStopped = true;
      if (checkTimer !== null) clearTimeout(checkTimer);
      checkTimer = null;
    }

    return { start, stop };
  };
}

export { createRemoteWatcherStarter };
export type { WatcherEnding, WatcherStarter };
