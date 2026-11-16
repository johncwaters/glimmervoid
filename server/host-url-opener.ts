import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from './child-process-safe.ts';
import { hostOpenerFor } from './core/open-external-core.ts';

type HostOpenOutcome = 'opened' | 'unsupported-platform' | 'spawn-failed';
type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type HostUrlOpener = (url: string) => Promise<HostOpenOutcome>;

const OPENER_EXIT_WINDOW_MS = 2000;

function launchDetachedOpener(command: string, commandArguments: string[], { spawnProcess = spawn, exitWindowMs = OPENER_EXIT_WINDOW_MS }: { spawnProcess?: SpawnProcess; exitWindowMs?: number } = {}): Promise<HostOpenOutcome> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(command, commandArguments, { detached: true, stdio: 'ignore' });
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
}

function createHostUrlOpener({
  platform = process.platform,
  spawnProcess = spawn,
  exitWindowMs = OPENER_EXIT_WINDOW_MS,
  windowsSystemRoot = process.env.SystemRoot,
}: {
  platform?: string;
  spawnProcess?: SpawnProcess;
  exitWindowMs?: number;
  windowsSystemRoot?: string;
} = {}): HostUrlOpener {
  return (url) => {
    const opener = hostOpenerFor(platform, windowsSystemRoot);
    if (!opener) return Promise.resolve('unsupported-platform');
    return launchDetachedOpener(opener.command, [...opener.leadingArgs, url], { spawnProcess, exitWindowMs });
  };
}

export { createHostUrlOpener, launchDetachedOpener };
export type { HostOpenOutcome, HostUrlOpener };
