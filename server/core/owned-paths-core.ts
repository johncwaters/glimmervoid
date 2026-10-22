import path from 'node:path';
import type { OwnedPathEntry } from '../../shared/contracts/owned-paths.ts';

const SESSION_OWNER_PREFIX = 'session:';
const RESTART_SURVIVING_LANE_OWNERS: ReadonlySet<string> = new Set(['lane:update-apply', 'lane:team-review']);

function isOwnerGone(owner: string, configuredSessionIds: ReadonlySet<string>): boolean {
  if (!owner.startsWith(SESSION_OWNER_PREFIX)) return !RESTART_SURVIVING_LANE_OWNERS.has(owner);
  return !configuredSessionIds.has(owner.slice(SESSION_OWNER_PREFIX.length));
}

function orphanedOwnedPaths(entries: readonly OwnedPathEntry[], configuredSessionIds: ReadonlySet<string>): OwnedPathEntry[] {
  const orphans = entries.filter((entry) => isOwnerGone(entry.owner, configuredSessionIds));
  return [...orphans.filter((entry) => entry.kind === 'git-worktree'), ...orphans.filter((entry) => entry.kind === 'folder')];
}

function holdsKeptPath(folderPath: string, keptPaths: readonly string[]): boolean {
  return keptPaths.some((keptPath) => {
    const relativePath = path.relative(folderPath, keptPath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
  });
}

export { holdsKeptPath, orphanedOwnedPaths };
