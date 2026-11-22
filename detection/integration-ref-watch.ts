import fs from 'node:fs';
import path from 'node:path';

import { createCoalescedTimer } from '../shared/coalesce-timer.ts';
import { createWatchDebounce } from './watch-debounce.ts';

interface ReflogTarget {
  watchDir: string;
  leaf: string;
}

function reflogTargetsOf(commonGitDir: string | null | undefined, branch: string | null | undefined): ReflogTarget[] {
  if (!commonGitDir || !branch) return [];
  return [
    path.join(commonGitDir, 'logs', 'refs', 'heads', branch),
    path.join(commonGitDir, 'logs', 'refs', 'remotes', 'origin', branch),
  ].map((reflogPath) => ({ watchDir: path.dirname(reflogPath), leaf: path.basename(reflogPath) }));
}

function directoryExists(dir: string): boolean {
  try { return fs.existsSync(dir); } catch { return false; }
}

function createIntegrationRefWatcher(
  { commonGitDir, branch, onChange, debounceMs = 400 }:
    {
      commonGitDir: string | null | undefined;
      branch: string | null | undefined;
      onChange: () => void;
      debounceMs?: number;
    },
) {
  let stopped = false;
  const changeTimer = createCoalescedTimer({
    mode: 'leading',
    delayMs: debounceMs,
    run: () => {
      if (stopped) return;
      try { onChange(); } catch { }
    },
  });
  const targets = reflogTargetsOf(commonGitDir, branch);
  const watchers = targets.map(() => createWatchDebounce({ onChange: () => changeTimer.schedule(), debounceMs: 0 }));

  function isActive(): boolean {
    return watchers.some((watcher) => watcher.active);
  }

  function start(): boolean {
    if (stopped || isActive()) return isActive();
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      const watcher = watchers[index];
      if (!target || !watcher || !directoryExists(target.watchDir)) continue;
      watcher.watch(target.watchDir, (_evt, filename) => {
        if (!filename || filename === target.leaf) changeTimer.schedule();
      });
    }
    return isActive();
  }

  function stop(): void {
    stopped = true;
    changeTimer.cancel();
    for (const watcher of watchers) watcher.stop();
  }

  return { start, stop, get active() { return isActive(); } };
}

export { createIntegrationRefWatcher };
