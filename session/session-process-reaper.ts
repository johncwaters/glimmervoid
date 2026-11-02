import { awaitBounded } from "../server/core/shutdown-core.ts";

const KILL_POLL_INTERVAL_MS = 200;
const KILL_MAX_WAIT_MS = 3000;
const KILL_REAP_MAX_WAIT_MS = 2400;

type KillProc = (
  args: string[],
  options: Record<string, unknown>,
  callback: (error: unknown, stdout?: string, stderr?: string) => void,
) => unknown;

type SignalProc = (pid: number, signal: NodeJS.Signals | 0) => void;

interface ReaperPort {
  isDestroyed: () => boolean;
  emitError: (error: unknown) => void;
}

interface SessionProcessReaperOptions {
  platform: NodeJS.Platform;
  killProc: KillProc;
  signalProc: SignalProc;
  port: ReaperPort;
}

interface SessionProcessReaper {
  kill(pid: number): void;
  reapTreeOnce(pid: number | null): Promise<void> | null;
  awaitPendingReaps(): Promise<void> | null;
  isProcessAlive(pid: number | null): boolean;
  clearKillPoll(): void;
  killReap: Promise<void> | null;
  exitReap: Promise<void> | null;
  readonly killPollTimer: NodeJS.Timeout | null;
  readonly killReapTimer: NodeJS.Timeout | null;
}

function signalablePid(pid: unknown): number | null {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 2) return null;
  return parsed;
}

function createSessionProcessReaper({ platform, killProc, signalProc, port }: SessionProcessReaperOptions): SessionProcessReaper {
  let killPollTimer: NodeJS.Timeout | null = null;
  let killReapTimer: NodeJS.Timeout | null = null;
  let resolveKillReap: (() => void) | null = null;
  let killReap: Promise<void> | null = null;
  let exitReap: Promise<void> | null = null;

  function clearKillPoll(): void {
    if (!killPollTimer) return;
    clearTimeout(killPollTimer);
    killPollTimer = null;
  }

  function clearKillReapTimer(): void {
    if (!killReapTimer) return;
    clearTimeout(killReapTimer);
    killReapTimer = null;
  }

  function taskkill(pid: number | null, opts: Record<string, unknown> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      killProc(["/PID", String(Number(pid)), "/T", "/F"], { ...opts }, (err: unknown) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  function killProcessGroup(pid: number | null, signal: NodeJS.Signals = "SIGKILL"): void {
    const target = signalablePid(pid);
    if (target === null) return;
    try {
      signalProc(-target, signal);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
      if (err && code !== "ESRCH") port.emitError(err);
    }
  }

  function isProcessAlive(pid: number | null): boolean {
    const target = signalablePid(pid);
    if (target === null) return false;
    const probeTarget = platform === "win32" ? target : -target;
    try {
      signalProc(probeTarget, 0);
      return true;
    } catch {
      return false;
    }
  }

  function awaitProcessGone(pid: number | null, maxWaitMs: number): Promise<void> {
    if (resolveKillReap) resolveKillReap();
    return new Promise((resolve) => {
      const settle = (): void => {
        clearKillReapTimer();
        resolveKillReap = null;
        resolve();
      };
      resolveKillReap = settle;
      let waited = 0;

      const poll = (): void => {
        if (!isProcessAlive(pid)) {
          settle();
          return;
        }
        waited += KILL_POLL_INTERVAL_MS;
        if (waited >= maxWaitMs) {
          settle();
          return;
        }
        clearKillReapTimer();
        killReapTimer = setTimeout(() => {
          killReapTimer = null;
          poll();
        }, KILL_POLL_INTERVAL_MS);
      };

      poll();
    });
  }

  function reapProcessGroup(pid: number | null, { maxWaitMs = KILL_REAP_MAX_WAIT_MS }: { maxWaitMs?: number } = {}): Promise<void> {
    killProcessGroup(pid);
    return awaitProcessGone(pid, maxWaitMs);
  }

  function reapTreeOnce(pid: number | null): Promise<void> | null {
    if (platform === "win32") {
      return taskkill(pid, { timeout: KILL_REAP_MAX_WAIT_MS })
        .catch(() => {});
    }
    if (resolveKillReap) return killReap;
    return reapProcessGroup(pid);
  }

  function awaitPendingReaps(): Promise<void> | null {
    const pending = [killReap, exitReap].filter((reap) => reap !== null);
    if (pending.length === 0) return null;
    return awaitBounded(pending, { capMs: KILL_REAP_MAX_WAIT_MS }).then(() => {});
  }

  function forceKillAfterTimeout(pid: number): void {
    let elapsed = 0;
    const poll = (): void => {
      if (port.isDestroyed()) return;
      if (!isProcessAlive(pid)) return;
      elapsed += KILL_POLL_INTERVAL_MS;
      if (elapsed >= KILL_MAX_WAIT_MS) {
        if (platform === "win32") {
          taskkill(pid).catch((err: unknown) => port.emitError(err));
          return;
        }
        killProcessGroup(pid);
        return;
      }
      armKillPoll(poll);
    };

    armKillPoll(poll);
  }

  function armKillPoll(poll: () => void): void {
    clearKillPoll();
    killPollTimer = setTimeout(() => {
      killPollTimer = null;
      poll();
    }, KILL_POLL_INTERVAL_MS);
  }

  function kill(pid: number): void {
    if (platform === "win32") {
      const windowsKillReap = taskkill(pid);
      killReap = windowsKillReap;
      windowsKillReap.catch((err: unknown) => port.emitError(err));
    }
    if (platform !== "win32") {
      killReap = reapProcessGroup(pid);
    }
    forceKillAfterTimeout(pid);
  }

  return {
    kill,
    reapTreeOnce,
    awaitPendingReaps,
    isProcessAlive,
    clearKillPoll,
    get killReap() { return killReap; },
    set killReap(next: Promise<void> | null) { killReap = next; },
    get exitReap() { return exitReap; },
    set exitReap(next: Promise<void> | null) { exitReap = next; },
    get killPollTimer() { return killPollTimer; },
    get killReapTimer() { return killReapTimer; },
  };
}

export { createSessionProcessReaper };
export type { KillProc, SessionProcessReaper, SignalProc };
