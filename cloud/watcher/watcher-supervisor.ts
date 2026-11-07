import type { ChildProcess } from 'node:child_process';
import { spawn } from '../../server/child-process-safe.ts';
import { cliPath } from '../../server/runtime-paths.ts';
import { stableNodePath } from '../../server/stable-node-path.ts';
import { WATCHER_HOME_ENV } from '../../shared/contracts/watchee-settings.ts';
import { nextCrashCount, restartDelayMs } from './core/watcher-core.ts';
import { watcherHomeDir } from './watchee-settings.ts';

const MS_PER_SECOND = 1000;

function sameEnvironment(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => left[key] === right[key]);
}

function createWatcherSupervisor({ inboxUrl, token, environment = () => ({}), log = console }: {
  inboxUrl: string;
  token: string;
  environment?: () => Record<string, string>;
  log?: Pick<Console, 'log' | 'warn'>;
}): { start(): void; stop(): void; refreshEnvironment(): void } {
  let crashCount = 0;
  let supervision: 'watching' | 'restarting' | 'stopped' = 'watching';
  let childEnvironment: Record<string, string> = {};
  let runningChild: ChildProcess | null = null;
  let pendingRestart: NodeJS.Timeout | null = null;

  function scheduleRestart(endedHow: string, runDurationMs: number): void {
    runningChild = null;
    if (supervision === 'stopped') return;
    if (supervision === 'restarting') {
      supervision = 'watching';
      log.log(`[watcher] child ${endedHow}, restarting with its new environment`);
      start();
      return;
    }
    crashCount = nextCrashCount(crashCount, runDurationMs);
    const delayMs = restartDelayMs(crashCount);
    log.warn(`[watcher] child ${endedHow}, restarting in ${Math.round(delayMs / MS_PER_SECOND)}s`);
    pendingRestart = setTimeout(start, delayMs);
    pendingRestart.unref();
  }

  function spawnWatcherChild(): ChildProcess | Error {
    try {
      childEnvironment = environment();
      return spawn(stableNodePath, [cliPath, 'watch', '--inbox', inboxUrl], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, ...childEnvironment, GLIMMERVOID_WATCHER_TOKEN: token, [WATCHER_HOME_ENV]: watcherHomeDir() },
      });
    } catch (spawnError) {
      return spawnError instanceof Error ? spawnError : new Error(String(spawnError));
    }
  }

  function start(): void {
    pendingRestart = null;
    if (supervision === 'stopped') return;
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
    supervision = 'stopped';
    if (pendingRestart !== null) clearTimeout(pendingRestart);
    runningChild?.kill();
  }

  function refreshEnvironment(): void {
    if (supervision === 'stopped' || runningChild === null || sameEnvironment(childEnvironment, environment())) return;
    supervision = 'restarting';
    runningChild.kill();
  }

  return { start, stop, refreshEnvironment };
}

export { createWatcherSupervisor };
