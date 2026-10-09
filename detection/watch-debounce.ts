import fs from 'node:fs';
import type { FSWatcher, WatchListener } from 'node:fs';

import { createCoalescedTimer } from '../shared/coalesce-timer.ts';
import { canonicalizePath } from '../shared/paths.ts';

export interface WatchDebounce {
  fire: () => void;
  watch: (dir: string, listener?: WatchListener<string> | null) => boolean;
  stop: () => void;
  readonly active: boolean;
  readonly stopped: boolean;
}

function createWatchDebounce(
  { onChange, debounceMs }: { onChange: () => void; debounceMs: number },
): WatchDebounce {
  let watcher: FSWatcher | null = null;
  let stopped = false;
  const changeTimer = createCoalescedTimer({
    mode: 'leading',
    delayMs: debounceMs,
    run: () => {
      if (stopped) return;
      try { onChange(); } catch {  }
    },
  });

  function fire(): void {
    changeTimer.schedule();
  }

  function watch(dir: string, listener?: WatchListener<string> | null): boolean {
    if (stopped || watcher) return !!watcher;
    try {
      watcher = fs.watch(canonicalizePath(dir), { persistent: false }, listener || (() => fire()));
      watcher.on('error', stop);
    } catch {
      watcher = null;
      return false;
    }
    return true;
  }

  function stop(): void {
    stopped = true;
    changeTimer.cancel();
    if (watcher) {
      try { watcher.close(); } catch {  }
      watcher = null;
    }
  }

  return {
    fire,
    watch,
    stop,
    get active() { return !!watcher; },
    get stopped() { return stopped; },
  };
}

export { createWatchDebounce };
