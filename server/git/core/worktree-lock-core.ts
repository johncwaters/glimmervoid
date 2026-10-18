import { isPathInside } from '../../../shared/paths.ts';

export const GLIMMERVOID_WORKTREE_LOCK_REASON = 'glimmervoid: guarded sessions cannot see this checkout, so a git worktree prune run from one would drop it';

export function isWorktreeHiddenFromGuardedSessions(worktreePath: string, glimmervoidHomes: readonly string[]): boolean {
  return glimmervoidHomes.some((glimmervoidHome) => isPathInside(glimmervoidHome, worktreePath, { allowEqual: false }));
}

export function isOwnWorktreeLockLine(porcelainLine: string): boolean {
  return porcelainLine === `locked ${GLIMMERVOID_WORKTREE_LOCK_REASON}`;
}

export function listOwnLockedWorktreePaths(porcelain: string, glimmervoidHomes: readonly string[]): string[] {
  const lockedPaths: string[] = [];
  let currentPath: string | null = null;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
      continue;
    }
    if (currentPath !== null && isOwnWorktreeLockLine(line)) lockedPaths.push(currentPath);
  }
  return lockedPaths.filter((lockedPath) => isWorktreeHiddenFromGuardedSessions(lockedPath, glimmervoidHomes));
}

export function listHomeWorktreePathsMissingLock(porcelain: string, glimmervoidHomes: readonly string[]): string[] {
  const entries: { path: string; isLocked: boolean }[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      entries.push({ path: line.slice('worktree '.length).trim(), isLocked: false });
      continue;
    }
    const currentEntry = entries.at(-1);
    if (currentEntry && line.startsWith('locked')) currentEntry.isLocked = true;
  }
  return entries
    .slice(1)
    .filter((entry) => !entry.isLocked && isWorktreeHiddenFromGuardedSessions(entry.path, glimmervoidHomes))
    .map((entry) => entry.path);
}
