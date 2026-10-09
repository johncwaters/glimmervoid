import { DEFAULT_DEADLINE_MS, DEFAULT_INTERVAL_MS, planHeartbeatSweep } from './core/heartbeat-core.ts';
import { errorMessage } from '../shared/text.ts';
import { DEFAULT_TIMER_FNS, unrefTimer } from './core/timer-deps.ts';
import type { ClearIntervalFn, SetIntervalFn } from './core/timer-deps.ts';

interface HeartbeatSocket {
  glimmervoidLastSeenAt?: number;
  on: (event: string, listener: () => void) => unknown;
  terminate: () => void;
  ping: () => void;
}

interface HeartbeatServer {
  clients: Iterable<HeartbeatSocket>;
}

interface HeartbeatOptions {
  servers?: HeartbeatServer[];
  intervalMs?: number;
  deadlineMs?: number;
  now?: () => number;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
  onTerminate?: (socket: HeartbeatSocket) => void;
  warn?: (message: string) => void;
}

interface Heartbeat {
  track(ws: HeartbeatSocket): void;
  sweep(): void;
  start(): void;
  stop(): void;
}

function createHeartbeat({
  servers = [],
  intervalMs = DEFAULT_INTERVAL_MS,
  deadlineMs = DEFAULT_DEADLINE_MS,
  now = Date.now,
  setIntervalFn = DEFAULT_TIMER_FNS.setIntervalFn,
  clearIntervalFn = DEFAULT_TIMER_FNS.clearIntervalFn,
  onTerminate = () => {},
  warn = console.warn,
}: HeartbeatOptions = {}): Heartbeat {
  let timer: NodeJS.Timeout | null = null;

  function track(ws: HeartbeatSocket): void {
    ws.glimmervoidLastSeenAt = now();
    const seen = () => { ws.glimmervoidLastSeenAt = now(); };
    ws.on('pong', seen);
    ws.on('message', seen);
  }

  function sweep(): void {
    for (const server of servers) {
      const clients = [...(server?.clients || [])];
      const { terminate, ping } = planHeartbeatSweep(
        clients.map((ws) => ({ key: ws, lastSeenAt: ws.glimmervoidLastSeenAt ?? now() })),
        { now: now(), deadlineMs },
      );
      for (const ws of terminate) {
        try { ws.terminate(); } catch {  }
        onTerminate(ws);
      }
      for (const ws of ping) {
        try {
          ws.ping();
        } catch (error) {
          warn(`[heartbeat] ping failed: ${errorMessage(error)}`);
        }
      }
    }
  }

  function start(): void {
    if (timer) return;
    timer = setIntervalFn(sweep, intervalMs);
    unrefTimer(timer);
  }

  function stop(): void {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return { track, sweep, start, stop };
}

export { createHeartbeat };
export type { Heartbeat, HeartbeatOptions, HeartbeatServer, HeartbeatSocket };
