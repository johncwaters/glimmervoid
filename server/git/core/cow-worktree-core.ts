import crypto from 'node:crypto';
import path from 'node:path';
import { sanitizeWorktreeName } from '../../../shared/paths.ts';
import { cloneFlagsFor } from './dependency-clone-core.ts';

export const COW_TEMPLATE_DIR_NAME = '.git-cow';
export const DEFAULT_COW_WARM_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_COW_SHARED_HIDDEN_DIRS: readonly string[] = [
  '.uv-cache',
  '.next',
  '.turbo',
  '.nuxt',
  '.svelte-kit',
  '.parcel-cache',
  '.gradle',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
];

export type CowTemplatePaths = {
  rootDir: string;
  templateDir: string;
  stampPath: string;
  warmStagingDir: string;
};

export type CowFallbackReason = 'disabled' | 'platform' | 'no-copy-on-write' | 'submodules' | 'failed';

type CowPlan =
  | { action: 'clone'; cloneFlags: readonly string[] }
  | { action: 'fallback'; reason: CowFallbackReason };

const EXCLUDED_BUILD_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules']);

function repoNameFromCommonDir(repoCommonDir: string): string {
  const normalized = path.resolve(repoCommonDir);
  const baseName = path.basename(normalized);
  const repoDir = baseName === '.git' ? path.dirname(normalized) : normalized;
  const rawName = path.basename(repoDir).replace(/\.git$/, '');
  return sanitizeWorktreeName(rawName) || 'repo';
}

export function templatePathsFor(worktreeParent: string, repoCommonDir: string): CowTemplatePaths {
  const rootDir = path.join(worktreeParent, COW_TEMPLATE_DIR_NAME);
  const repoName = repoNameFromCommonDir(repoCommonDir);
  const repoHash = crypto.createHash('sha256').update(path.resolve(repoCommonDir)).digest('hex').slice(0, 10);
  const repoKey = `${repoName}-${repoHash}`;
  return {
    rootDir,
    templateDir: path.join(rootDir, repoKey),
    stampPath: path.join(rootDir, `.${repoKey}.warmed`),
    warmStagingDir: path.join(rootDir, `.${repoKey}.warm`),
  };
}

export function isCowDisabledByEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.GIT_COW === '0';
}

export function isWarmStale(stampMtimeMs: number | null, nowMs: number, warmIntervalMs: number): boolean {
  if (!Number.isFinite(warmIntervalMs)) return false;
  if (warmIntervalMs <= 0) return true;
  if (stampMtimeMs === null) return true;
  return nowMs - stampMtimeMs >= warmIntervalMs;
}

export function trackedAncestorDirsFrom(lsFilesNulOutput: string): Set<string> {
  const trackedPaths = new Set<string>();
  for (const rawEntry of lsFilesNulOutput.split('\0')) {
    if (!rawEntry) continue;
    const normalized = rawEntry.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized) continue;
    trackedPaths.add(normalized);
    let current = path.posix.dirname(normalized);
    while (current && current !== '.' && !trackedPaths.has(current)) {
      trackedPaths.add(current);
      current = path.posix.dirname(current);
    }
  }
  return trackedPaths;
}

export function isDisallowedStagedEntry(entryName: string, isDirectory: boolean, allowedHiddenDirs: ReadonlySet<string>): boolean {
  if (EXCLUDED_BUILD_DIRS.has(entryName)) return true;
  if (entryName.startsWith('.env')) return true;
  if (isDirectory && entryName.startsWith('.') && !allowedHiddenDirs.has(entryName)) return true;
  return false;
}

function isAllowedBuildDir(relativeDir: string, allowedHiddenDirs: ReadonlySet<string>): boolean {
  if (!relativeDir) return false;
  const segments = relativeDir.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return false;
    if (EXCLUDED_BUILD_DIRS.has(segment)) return false;
    if (segment.startsWith('.') && !allowedHiddenDirs.has(segment)) return false;
  }
  return true;
}

export function filterIgnoredBuildDirs(
  lsFilesNulOutput: string,
  sharedHiddenDirs: readonly string[] = DEFAULT_COW_SHARED_HIDDEN_DIRS,
  trackedAncestors: ReadonlySet<string> = new Set(),
): string[] {
  const allowedHiddenDirs = new Set(sharedHiddenDirs);
  const dirs = new Set<string>();
  for (const rawEntry of lsFilesNulOutput.split('\0')) {
    if (!rawEntry.endsWith('/')) continue;
    const relativeDir = rawEntry.slice(0, -1).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!isAllowedBuildDir(relativeDir, allowedHiddenDirs)) continue;
    if (trackedAncestors.has(relativeDir)) continue;
    dirs.add(relativeDir);
  }
  return [...dirs].sort((left, right) => left.localeCompare(right));
}

export function planCowWorktreeAdd(facts: {
  platform: string;
  cowDisabled: boolean;
  hasSubmodules: boolean;
  canCloneCopyOnWrite: boolean;
}): CowPlan {
  if (facts.cowDisabled) return { action: 'fallback', reason: 'disabled' };
  const cloneFlags = cloneFlagsFor(facts.platform);
  if (!cloneFlags) return { action: 'fallback', reason: 'platform' };
  if (facts.hasSubmodules) return { action: 'fallback', reason: 'submodules' };
  if (!facts.canCloneCopyOnWrite) return { action: 'fallback', reason: 'no-copy-on-write' };
  return { action: 'clone', cloneFlags };
}
