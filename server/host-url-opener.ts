import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from './child-process-safe.ts';
import { hostOpenerCommandFor } from './core/open-external-core.ts';

type HostOpenOutcome = 'opened' | 'unsupported-platform' | 'spawn-failed';
type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type HostUrlOpener = (url: string) => Promise<HostOpenOutcome>;

const OPENER_EXIT_WINDOW_MS = 2000;

function createHostUrlOpener({
  platform = process.platform,
  spawnProcess = spawn,
  exitWindowMs = OPENER_EXIT_WINDOW_MS,
}: { platform?: string; spawnProcess?: SpawnProcess; exitWindowMs?: number } = {}): HostUrlOpener {
  return (url) => {
    const command = hostOpenerCommandFor(platform);
    if (!command) return Promise.resolve('unsupported-platform');
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnProcess(command, [url], { detached: true, stdio: 'ignore' });
      } catch {
        resolve('spawn-failed');
        return;
      }
      let isSettled = false;
      let exitWindowTimer: NodeJS.Timeout | undefined;
      const onExit = (exitCode: number | null) => { settle(exitCode === 0 ? 'opened' : 'spawn-failed'); };
      const settle = (outcome: HostOpenOutcome) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(exitWindowTimer);
        child.off('exit', onExit);
        resolve(outcome);
      };
      child.once('spawn', () => {
        child.unref();
        exitWindowTimer = setTimeout(() => { settle('opened'); }, exitWindowMs);
        exitWindowTimer.unref();
      });
      child.once('exit', onExit);
      child.once('error', () => { settle('spawn-failed'); });
    });
  };
}

export { createHostUrlOpener };
export type { HostOpenOutcome, HostUrlOpener, SpawnProcess };
