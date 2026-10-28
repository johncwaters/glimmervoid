import path from 'node:path';
import { nextBackoffMs } from '../../../shared/backoff.ts';
import { rawTextOr } from '../../../shared/coerce.ts';
import { KIMI_USAGE_FILENAME } from './usage-kimi-core.ts';

export type PassOutcome = 'complete' | 'byte-limited' | 'io-failed';

type LaneSpend =
  | { status: 'tracking-off' }
  | { status: 'scanner-missing' }
  | { status: 'catching-up' }
  | { status: 'read-failing' }
  | { status: 'known'; amountUsd: number };

export function laneSpendStatus({ isTrackingEnabled, scan }: {
  isTrackingEnabled: boolean; scan: { isHistoryCaughtUp: boolean; lastOutcome: PassOutcome | null } | null;
}): LaneSpend['status'] {
  if (!isTrackingEnabled) return 'tracking-off';
  if (scan === null) return 'scanner-missing';
  if (scan.lastOutcome === 'io-failed') return 'read-failing';
  if (!scan.isHistoryCaughtUp || scan.lastOutcome === null) return 'catching-up';
  return 'known';
}

interface FileReadCursor {
  offset?: number;
  size?: number;
  mtimeMs?: number;
}

export interface VendorRoot {
  dir: string;
  kind: 'active' | 'archived' | 'flat';
  home: string;
}

function scopedClaudeRoots(
  scopeDirs: readonly string[] | null | undefined,
  claudeDirs: readonly string[],
): { vendor: 'claude'; dir: string; kind: 'active' }[] | null {
  if (!scopeDirs || scopeDirs.length === 0) return null;
  const isInside = (candidate: string, parent: string) => candidate.startsWith(`${parent}${path.sep}`);
  const roots: string[] = [];
  for (const scopeDir of [...new Set(scopeDirs.map((dir) => path.resolve(dir)))].sort((left, right) => left.length - right.length)) {
    if (!claudeDirs.some((claudeDir) => isInside(scopeDir, claudeDir))) return null;
    if (roots.some((root) => isInside(scopeDir, root))) continue;
    roots.push(scopeDir);
  }
  return roots.map((dir) => ({ vendor: 'claude', dir, kind: 'active' }));
}

function decideFileRead(
  prior: FileReadCursor | null | undefined,
  stat: { size?: unknown; mtimeMs?: unknown } | null | undefined,
): { action: 'restart' | 'skip' | 'append'; readFrom: number } {
  if (!prior) return { action: 'restart', readFrom: 0 };
  if (!stat || typeof stat.size !== 'number') return { action: 'skip', readFrom: prior.offset || 0 };
  if (stat.size < (prior.size || 0)) return { action: 'restart', readFrom: 0 };
  if (stat.size < (prior.offset || 0)) return { action: 'restart', readFrom: 0 };
  if (stat.size === (prior.offset || 0) && stat.mtimeMs === prior.mtimeMs) return { action: 'skip', readFrom: prior.offset || 0 };
  return { action: 'append', readFrom: prior.offset || 0 };
}

function splitLines(carry: string | null | undefined, chunkText: string | null | undefined): { lines: string[]; carry: string } {
  const text = `${carry || ''}${chunkText || ''}`;
  const lines = text.split(/\r?\n/);
  const nextCarry = text.endsWith('\n') || text.endsWith('\r\n') ? '' : lines.pop();
  return { lines: lines.filter((line) => line.length > 0), carry: nextCarry || '' };
}

function resolveProjectsDirs(
  env: NodeJS.ProcessEnv = process.env,
  extraDirs: string[] = [],
  isDirectory?: (candidate: string) => boolean,
  homeDir: string | null = null,
): string[] {
  if (typeof isDirectory !== 'function') throw new TypeError('resolveProjectsDirs requires an isDirectory function');
  const surviving = projectDirCandidates(env, extraDirs, homeDir).filter(isDirectory);
  if (!configDirOverride(env)) return surviving;
  const overrideSurvivors = projectDirCandidates(env, [], homeDir).filter(isDirectory);
  if (overrideSurvivors.length === 0) throw new Error('CLAUDE_CONFIG_DIR is set but no projects directory exists');
  return surviving;
}

function projectDirCandidates(
  env: NodeJS.ProcessEnv = process.env,
  extraDirs: string[] = [],
  homeDir: string | null = null,
): string[] {
  const override = configDirOverride(env);
  const extraHomes = normalizeHomeCandidates(extraDirs, env, homeDir);
  if (override) {
    const overrideHomes = normalizeHomeCandidates(override.split(','), env, homeDir);
    return uniqueStrings([...projectsDirsFromHomes(overrideHomes), ...projectsDirsFromHomes(extraHomes)]);
  }

  const resolvedHomeDir = resolveHomeDir(env, homeDir);
  if (!resolvedHomeDir) return uniqueStrings(projectsDirsFromHomes(extraHomes));
  const xdgConfigHome = rawTextOr(env.XDG_CONFIG_HOME, null) || path.join(resolvedHomeDir, '.config');
  const defaultHomes = [path.join(xdgConfigHome, 'claude'), path.join(resolvedHomeDir, '.claude')];
  return uniqueStrings([...projectsDirsFromHomes(defaultHomes), ...projectsDirsFromHomes(extraHomes)]);
}

function configDirOverride(env: NodeJS.ProcessEnv): string {
  const override = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : '';
  return override.trim();
}

function projectsDirsFromHomes(homes: string[]): string[] {
  const projectsDirs: string[] = [];
  for (const candidate of homes) {
    const home = path.basename(candidate) === 'projects' ? path.dirname(candidate) : candidate;
    const projectsDir = path.join(home, 'projects');
    projectsDirs.push(projectsDir);
  }
  return projectsDirs;
}

function normalizeHomeCandidates(candidates: unknown, env: NodeJS.ProcessEnv, homeDir: string | null): string[] {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((candidate) => expandTilde(String(candidate || '').trim(), env, homeDir))
    .filter(Boolean);
}

function expandTilde(candidate: string, env: NodeJS.ProcessEnv, homeDir: string | null): string {
  if (!candidate.startsWith('~')) return candidate;
  const home = resolveHomeDir(env, homeDir);
  if (!home) return '';
  if (candidate === '~') return home;
  if (!candidate.startsWith(`~${path.sep}`) && !candidate.startsWith('~/')) return candidate;
  return path.join(home, candidate.slice(2));
}

function resolveHomeDir(env: NodeJS.ProcessEnv, homeDir: string | null): string | null {
  return rawTextOr(env.HOME, null) || rawTextOr(env.USERPROFILE, null) || homeDir;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function passOutcome(
  { byteLimited, ioFailures }: { byteLimited: boolean; ioFailures: number },
): PassOutcome {
  if (ioFailures > 0) return 'io-failed';
  if (byteLimited) return 'byte-limited';
  return 'complete';
}

function shouldPersistWarehouse(
  { outcome, storeReset }: { outcome: PassOutcome; storeReset: boolean },
): boolean {
  if (outcome === 'complete') return true;
  if (outcome === 'byte-limited') return false;
  return !storeReset;
}

function continuationDelayMs(
  { outcome, ioFailureStreak, partialMs }: {
    outcome: PassOutcome;
    ioFailureStreak: number;
    partialMs: number;
  },
): number | null {
  if (outcome === 'complete') return null;
  if (outcome === 'byte-limited') return partialMs;
  return nextBackoffMs({ attempt: ioFailureStreak, baseMs: 30_000, maxMs: 300_000 });
}

function shouldEvaluateDespiteIoFailures(
  { ioFailureStreak, limit }: { ioFailureStreak: number; limit: number },
): boolean {
  if (!Number.isFinite(ioFailureStreak) || !Number.isFinite(limit)) return false;
  if (limit <= 0) return false;
  return ioFailureStreak >= limit;
}

function vendorHomes(
  env: NodeJS.ProcessEnv,
  varName: string,
  defaultDirName: string,
  homeDir: string | null,
): string[] {
  const rawOverride = env?.[varName];
  const override = typeof rawOverride === 'string' ? rawOverride.trim() : '';
  if (override) return normalizeHomeCandidates(override.split(','), env, homeDir);
  const home = resolveHomeDir(env, homeDir);
  if (!home) return [];
  return [path.join(home, defaultDirName)];
}

function codexHomes(env: NodeJS.ProcessEnv = process.env, homeDir: string | null = null): string[] {
  return vendorHomes(env, 'CODEX_HOME', '.codex', homeDir);
}

function grokHomes(env: NodeJS.ProcessEnv = process.env, homeDir: string | null = null): string[] {
  return vendorHomes(env, 'GROK_HOME', '.grok', homeDir);
}

function kimiHomes(env: NodeJS.ProcessEnv = process.env, homeDir: string | null = null): string[] {
  return vendorHomes(env, 'KIMI_CODE_HOME', '.kimi-code', homeDir);
}

function codexRootCandidates(homes: string[]): VendorRoot[] {
  const candidates: VendorRoot[] = [];
  for (const home of homes) {
    candidates.push({ dir: path.join(home, 'sessions'), kind: 'active', home });
    candidates.push({ dir: path.join(home, 'archived_sessions'), kind: 'archived', home });
  }
  return candidates;
}

function codexFallbackRoots(homes: string[], survivingRoots: VendorRoot[]): VendorRoot[] {
  const covered = new Set(survivingRoots.map((root) => root.home));
  return homes.filter((home) => !covered.has(home)).map((home) => ({ dir: home, kind: 'flat', home }));
}

function sessionsRootCandidates(homes: string[]): VendorRoot[] {
  return homes.map((home) => ({ dir: path.join(home, 'sessions'), kind: 'active', home }));
}

const GROK_USAGE_FILENAME = 'updates.jsonl';

function isUsageFile(vendor: string, fileName: unknown): boolean {
  if (typeof fileName !== 'string') return false;
  if (vendor === 'grok') return fileName === GROK_USAGE_FILENAME;
  if (vendor === 'kimi') return fileName === KIMI_USAGE_FILENAME;
  return fileName.endsWith('.jsonl');
}

function dedupeCodexFiles<T extends { file: string; kind: string }>(files: T[]): T[] {
  const byName = new Map<string, T>();
  for (const file of files) {
    const name = path.basename(file.file);
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, file);
      continue;
    }
    if (existing.kind === 'archived' && file.kind !== 'archived') byName.set(name, file);
  }
  return Array.from(byName.values());
}

function codexSessionIdFromPath(filePath: unknown): string | null {
  const base = path.basename(String(filePath || ''), '.jsonl');
  const match = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(base);
  if (match) return match[1];
  return base || null;
}

export { expandTilde, decideFileRead, projectDirCandidates, resolveProjectsDirs, scopedClaudeRoots, splitLines, passOutcome, shouldPersistWarehouse, continuationDelayMs, shouldEvaluateDespiteIoFailures, codexHomes, grokHomes, kimiHomes, codexRootCandidates, codexFallbackRoots, sessionsRootCandidates, codexSessionIdFromPath, dedupeCodexFiles, isUsageFile };
