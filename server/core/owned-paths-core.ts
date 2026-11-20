import path from 'node:path';
import type { OwnedPathEntry } from '../../shared/contracts/owned-paths.ts';

const SESSION_OWNER_PREFIX = 'session:';
const DAY_MS = 24 * 60 * 60 * 1000;
const PARK_UNTOUCHED_DAYS = 7;
const PARKED_REF_RETAIN_DAYS = 30;
const PARKED_REF_PREFIX = 'refs/glimmervoid/parked/';
const REF_SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
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

function refSafeFolderSegment(folderName: string): string {
  return folderName.replace(/[^A-Za-z0-9-]/g, (character) => `_${character.charCodeAt(0).toString(16)}`);
}

function parkedRefFor(owner: string, worktreePath: string): string | null {
  if (!owner.startsWith(SESSION_OWNER_PREFIX)) return null;
  const sessionId = owner.slice(SESSION_OWNER_PREFIX.length);
  const folderSegment = refSafeFolderSegment(path.basename(worktreePath));
  if (!REF_SAFE_SEGMENT.test(sessionId) || folderSegment === '') return null;
  return `${PARKED_REF_PREFIX}${sessionId}/${folderSegment}`;
}

function isUntouchedLongEnoughToPark(lastTouchedMs: number | null, nowMs: number): boolean {
  return lastTouchedMs !== null && nowMs - lastTouchedMs >= PARK_UNTOUCHED_DAYS * DAY_MS;
}

function expiredParkedRefs(refListing: string, nowMs: number): string[] {
  return refListing.split('\n').flatMap((refLine) => {
    const [refName, committedAtSeconds] = refLine.trim().split(' ');
    if (!refName?.startsWith(PARKED_REF_PREFIX) || !/^\d+$/.test(committedAtSeconds ?? '')) return [];
    return nowMs - Number(committedAtSeconds) * 1000 >= PARKED_REF_RETAIN_DAYS * DAY_MS ? [refName] : [];
  });
}

export { PARKED_REF_PREFIX, PARKED_REF_RETAIN_DAYS, PARK_UNTOUCHED_DAYS, expiredParkedRefs, holdsKeptPath, isUntouchedLongEnoughToPark, orphanedOwnedPaths, parkedRefFor };
