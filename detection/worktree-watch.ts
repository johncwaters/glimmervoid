import fs from 'node:fs';
import path from 'node:path';

import { createWatchDebounce } from './watch-debounce.ts';

function worktreeGitdirOf(dotGitText: string): string | null {
  const m = /^gitdir:\s*(.+)$/m.exec(dotGitText);
  if (!m) return null;
  const raw = m[1].trim();
  return /(^|[/\\])worktrees[/\\]/.test(raw) ? raw : null;
}

function readWorktreeGitdirPointer(dir: string | null | undefined): string | null {
  if (!dir) return null;
  try {
    const dotGit = path.join(dir, '.git');
    if (!fs.statSync(dotGit).isFile()) return null;
    return worktreeGitdirOf(fs.readFileSync(dotGit, 'utf8'));
  } catch {
    return null;
  }
}

async function isLinkedWorktreeFolder(dir: string): Promise<boolean> {
  const dotGit = path.join(dir, '.git');
  const stats = await fs.promises.stat(dotGit).catch(() => null);
  if (!stats?.isFile()) return false;
  const dotGitText = await fs.promises.readFile(dotGit, 'utf8').catch(() => '');
  return worktreeGitdirOf(dotGitText) !== null;
}

function resolveWorktreeGitDir(dir: string | null | undefined): string | null {
  const raw = readWorktreeGitdirPointer(dir);
  if (!raw || !dir) return null;
  const resolved = path.resolve(dir, raw);
  return fs.existsSync(resolved) ? resolved : null;
}

function createWorktreeWatcher(
  { worktreeDir, onChange, debounceMs = 400 }:
    { worktreeDir: string | null | undefined; onChange: () => void; debounceMs?: number },
) {
  const w = createWatchDebounce({ onChange, debounceMs });

  function start(): boolean {
    if (w.active || w.stopped) return w.active;
    const gitDir = resolveWorktreeGitDir(worktreeDir);
    if (!gitDir) return false;

    return w.watch(gitDir);
  }

  return { start, stop: w.stop, get active() { return w.active; } };
}

export { createWorktreeWatcher, isLinkedWorktreeFolder, resolveWorktreeGitDir, readWorktreeGitdirPointer };
