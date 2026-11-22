import path from 'node:path';
import { rawTextOr } from '../../shared/coerce.ts';

const CLAUDE_GLOBAL_CONFIG_FILE_NAME = '.claude.json';
const CLAUDE_LEGACY_CONFIG_FILE_NAME = '.config.json';

function listClaudeGlobalConfigPathCandidates(env: NodeJS.ProcessEnv, homeDir: string): readonly [legacyConfigPath: string, currentConfigPath: string] {
  const configuredDir = env.CLAUDE_CONFIG_DIR?.trim();
  const legacyConfigHome = (configuredDir || path.join(homeDir, '.claude')).normalize('NFC');
  return [path.join(legacyConfigHome, CLAUDE_LEGACY_CONFIG_FILE_NAME), path.join(configuredDir || homeDir, CLAUDE_GLOBAL_CONFIG_FILE_NAME)];
}

function configDirOverride(env: NodeJS.ProcessEnv): string {
  const override = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : '';
  return override.trim();
}

function resolveHomeDir(env: NodeJS.ProcessEnv, homeDir: string | null): string | null {
  return rawTextOr(env.HOME, null) || rawTextOr(env.USERPROFILE, null) || homeDir;
}

function expandTilde(candidate: string, env: NodeJS.ProcessEnv, homeDir: string | null): string {
  if (!candidate.startsWith('~')) return candidate;
  const home = resolveHomeDir(env, homeDir);
  if (!home) return '';
  if (candidate === '~') return home;
  if (!candidate.startsWith(`~${path.sep}`) && !candidate.startsWith('~/')) return candidate;
  return path.join(home, candidate.slice(2));
}

function normalizeHomeCandidates(candidates: unknown, env: NodeJS.ProcessEnv, homeDir: string | null): string[] {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((candidate) => expandTilde(String(candidate || '').trim(), env, homeDir))
    .filter(Boolean);
}

function projectsDirsFromHomes(homes: string[]): string[] {
  const projectsDirs: string[] = [];
  for (const candidate of homes) {
    const home = path.basename(candidate) === 'projects' ? path.dirname(candidate) : candidate;
    projectsDirs.push(path.join(home, 'projects'));
  }
  return projectsDirs;
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
    return Array.from(new Set([...projectsDirsFromHomes(overrideHomes), ...projectsDirsFromHomes(extraHomes)]));
  }

  const resolvedHomeDir = resolveHomeDir(env, homeDir);
  if (!resolvedHomeDir) return Array.from(new Set(projectsDirsFromHomes(extraHomes)));
  const xdgConfigHome = rawTextOr(env.XDG_CONFIG_HOME, null) || path.join(resolvedHomeDir, '.config');
  const defaultHomes = [path.join(xdgConfigHome, 'claude'), path.join(resolvedHomeDir, '.claude')];
  return Array.from(new Set([...projectsDirsFromHomes(defaultHomes), ...projectsDirsFromHomes(extraHomes)]));
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

export { codexHomes, configDirOverride, expandTilde, listClaudeGlobalConfigPathCandidates, projectDirCandidates, vendorHomes };
