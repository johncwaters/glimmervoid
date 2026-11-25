import { createCoalescedTimer } from '../shared/coalesce-timer.ts';
import { watchFolderEntries } from '../server/path-watch.ts';
import type { StopWatching } from '../server/path-watch.ts';

type EntryListener = (changedName: string | null) => void;

export interface WatchDebounce {
  fire: () => void;
  watch: (dir: string, listener?: EntryListener | null) => boolean;
  stop: () => void;
  readonly active: boolean;
  readonly stopped: boolean;
}

function createWatchDebounce(
  { onChange, debounceMs }: { onChange: () => void; debounceMs: number },
): WatchDebounce {
  let stopWatcher: StopWatching | null = null;
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

  function watch(dir: string, listener?: EntryListener | null): boolean {
    if (stopped || stopWatcher) return !!stopWatcher;
    let isUnwatchable = false;
    const stopEntries = watchFolderEntries(dir, listener || (() => fire()), { onGone: noteFolderGone, onUnwatchable: () => { isUnwatchable = true; } });
    if (isUnwatchable) return false;
    stopWatcher = stopEntries;
    return true;
  }

  function noteFolderGone(): void {
    stopWatcher = null;
    fire();
  }

  function stop(): void {
    stopped = true;
    changeTimer.cancel();
    stopWatcher?.();
    stopWatcher = null;
  }

  return {
    fire,
    watch,
    stop,
    get active() { return !!stopWatcher; },
    get stopped() { return stopped; },
  };
}

export { createWatchDebounce };
