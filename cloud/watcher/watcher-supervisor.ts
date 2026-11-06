import type { ChildProcess } from 'node:child_process';
import { spawn } from '../../server/child-process-safe.ts';
import { cliPath } from '../../server/runtime-paths.ts';
import { stableNodePath } from '../../server/stable-node-path.ts';
import { nextCrashCount, restartDelayMs } from './core/watcher-core.ts';

const MS_PER_SECOND = 1000;

function createWatcherSupervisor({ inboxUrl, token, log = console }: {
  inboxUrl: string;
  token: string;
  log?: Pick<Console, 'log' | 'warn'>;
}): { start(): void; stop(): void } {
  let crashCount = 0;
  let isStopped = false;
  let runningChild: ChildProcess | null = null;
  let pendingRestart: NodeJS.Timeout | null = null;

  function scheduleRestart(endedHow: string, runDurationMs: number): void {
    runningChild = null;
    if (isStopped) return;
    crashCount = nextCrashCount(crashCount, runDurationMs);
    const delayMs = restartDelayMs(crashCount);
    log.warn(`[watcher] child ${endedHow}, restarting in ${Math.round(delayMs / MS_PER_SECOND)}s`);
    pendingRestart = setTimeout(start, delayMs);
    pendingRestart.unref();
  }

  function spawnWatcherChild(): ChildProcess | Error {
    try {
      return spawn(stableNodePath, [cliPath, 'watch', '--inbox', inboxUrl], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, GLIMMERVOID_WATCHER_TOKEN: token },
      });
    } catch (spawnError) {
      return spawnError instanceof Error ? spawnError : new Error(String(spawnError));
    }
  }

  function start(): void {
    pendingRestart = null;
    if (isStopped) return;
    const startedAtMs = Date.now();
    let hasEnded = false;
    const endOnce = (endedHow: string) => {
      if (hasEnded) return;
      hasEnded = true;
      scheduleRestart(endedHow, Date.now() - startedAtMs);
    };
    const watcherChild = spawnWatcherChild();
    if (watcherChild instanceof Error) {
      endOnce(`failed to start (${watcherChild.message})`);
      return;
    }
    runningChild = watcherChild;
    watcherChild.once('error', (error) => endOnce(`failed to start (${error.message})`));
    watcherChild.once('exit', (code, signal) => endOnce(`exited (${signal ?? `code ${code}`})`));
    log.log(`[watcher] started child pid ${watcherChild.pid} (glimmervoid watch --inbox ${inboxUrl})`);
  }

  function stop(): void {
    isStopped = true;
    if (pendingRestart !== null) clearTimeout(pendingRestart);
    runningChild?.kill();
  }

  return { start, stop };
}

export { createWatcherSupervisor };
