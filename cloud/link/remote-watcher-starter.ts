import { STATUS_PATH, WatcherStatus } from '../../shared/contracts/watcher-link.ts';
import { directionKey, signedHeaders } from './core/link-signing-core.ts';
import type { createWatcherSupervisor } from './watcher-supervisor.ts';

type WatcherStarter = typeof createWatcherSupervisor;

const STATUS_CHECK_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;

function createRemoteWatcherStarter(remoteWatcherUrl: string, { statusCheckMs = STATUS_CHECK_MS, fetchFn = fetch, now = Date.now }: {
  statusCheckMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
} = {}): WatcherStarter {
  return ({ linkSecret, onListening, onEnded, log = console }) => {
    const commandKey = directionKey(linkSecret, 'server-to-watcher');
    let checkTimer: NodeJS.Timeout | null = null;
    let isAnswering = false;
    let answeringSinceMs = 0;

    async function isWatcherAnswering(): Promise<boolean> {
      try {
        const response = await fetchFn(new URL(STATUS_PATH, remoteWatcherUrl), {
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

    async function checkWatcher(): Promise<void> {
      const answers = await isWatcherAnswering();
      if (checkTimer === null) return;
      if (answers) {
        if (!isAnswering) answeringSinceMs = now();
        isAnswering = true;
        onListening(remoteWatcherUrl);
        return;
      }
      if (!isAnswering) return;
      isAnswering = false;
      log.warn(`[watcher] the remote watcher at ${new URL(remoteWatcherUrl).origin} stopped answering or cannot nudge this server, lanes go back to their own timers`);
      onEnded({ endKind: 'unreachable', runMs: now() - answeringSinceMs, willRestart: true });
    }

    function scheduleCheck(): void {
      checkTimer = setTimeout(() => {
        void checkWatcher().finally(() => {
          if (checkTimer !== null) scheduleCheck();
        });
      }, statusCheckMs);
      checkTimer.unref();
    }

    function start(): void {
      log.log(`[watcher] linking the remote watcher at ${new URL(remoteWatcherUrl).origin}`);
      isAnswering = true;
      answeringSinceMs = now();
      onListening(remoteWatcherUrl);
      scheduleCheck();
    }

    function stop(): void {
      if (checkTimer !== null) clearTimeout(checkTimer);
      checkTimer = null;
    }

    return { start, stop };
  };
}

export { createRemoteWatcherStarter };
