import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { decideConfigPath, glimmervoidHomeDir as resolveGlimmervoidHomeDir } from '../core/config-path-core.ts';
import { readEnvSecrets, withEnvSecrets } from '../core/config-secrets-core.ts';
import { AGENT_ID_SHAPE_MESSAGE, Config } from '../../shared/contracts/index.ts';
import { writeJsonAtomicSync, writeTextAtomicSync } from '../json-file.ts';
import { errorLabel, errorMessage } from '../../shared/text.ts';
import { isRecord } from '../../shared/coerce.ts';
import { normalizeLegacyConfigNumbers } from '../../shared/contracts/config-numbers-core.ts';
import { WorktreeFileSettings } from '../../shared/contracts/browser-config.ts';
import type { GlimmervoidConfig, ConfigValidation, ConfigFileSave, EnvSecrets } from './config-types.ts';
import { DEFAULT_CONFIG, DEFAULT_CONFIG_BY_KEY } from './config-defaults.ts';
import { moveRenamedKeys, resolveBranchGc } from './config-migrations.ts';

const ABORT_CONFIG_SAVE = 'abort-config-save';

const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

function glimmervoidHomeDir(): string {
  return resolveGlimmervoidHomeDir(os.homedir(), process.env);
}

function restrictMode(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {

  }
}

function resolveConfigPath(): string {
  const homeDir = glimmervoidHomeDir();
  const decided = decideConfigPath({
    env: process.env,
    homeDir,
  }, (candidate: string) => fs.existsSync(candidate));
  if (decided.path) return decided.path;
  if (decided.source === 'env') {
    console.error(`Config file not found: ${decided.envPath}, the path GLIMMERVOID_CONFIG names. Create that file, or unset GLIMMERVOID_CONFIG to use ${decided.homePath}.`);
    process.exit(1);
  }

  const homeConfig = decided.homePath;
  fs.mkdirSync(homeDir, { recursive: true, mode: CONFIG_DIR_MODE });
  restrictMode(homeDir, CONFIG_DIR_MODE);
  writeJsonAtomicSync(homeConfig, DEFAULT_CONFIG, { mode: CONFIG_FILE_MODE, enforceMode: true });
  console.log(`Created default config at ${homeConfig}`);
  return homeConfig;
}

function generateProjectId(): string {
  return crypto.randomUUID();
}

function validateConfig(candidate: unknown): ConfigValidation {
  if (!isRecord(candidate)) return { ok: false, errors: ['config must be a plain object'] };
  const parsedConfig = Config.safeParse(candidate);
  if (!parsedConfig.success) {
    const errors = parsedConfig.error.issues.map((issue) => {
      if (issue.code === 'custom') return issue.message;
      const [root, index, field] = issue.path;
      if (root === 'port') return 'port must be an integer from 0 to 65535';
      if (root === 'replayBufferKB') return issue.message;
      if (root === 'repoRoots') return `${root} must be an array of strings`;
      if (root === 'remote') return 'remote must be a plain object';
      if (root !== 'projects' && typeof DEFAULT_CONFIG_BY_KEY[String(root)] === 'number') {
        return `${String(root)} must be a finite number greater than or equal to 0`;
      }
      if (root !== 'projects') return issue.message;
      if (typeof index !== 'number') return 'projects must be an array';
      if (!field) return `projects[${index}] must be a plain object`;
      if (field === 'agent') return `projects[${index}].agent must be ${AGENT_ID_SHAPE_MESSAGE}`;
      if (field === 'codexBypassHookTrust') return `projects[${index}].codexBypassHookTrust must be a boolean`;
      if (field === 'environment') return issue.message;
      return `projects[${index}].${String(field)} must be a string`;
    });
    return { ok: false, errors };
  }
  return { ok: true, config: parsedConfig.data as GlimmervoidConfig };
}

function replaceInvalidWorktreeLeaves(draft: Record<string, unknown>): void {
  const worktree = draft.worktree;
  if (!isRecord(worktree)) return;
  for (const [leaf, fallback] of Object.entries(DEFAULT_CONFIG.worktree)) {
    if (!Object.hasOwn(worktree, leaf)) continue;
    const leafSchema = WorktreeFileSettings.shape[leaf as keyof typeof WorktreeFileSettings.shape];
    if (leafSchema.safeParse(worktree[leaf]).success) continue;
    console.warn(`[config] worktree.${leaf} value ${JSON.stringify(worktree[leaf])} is invalid; using ${JSON.stringify(fallback)}`);
    worktree[leaf] = fallback;
  }
}

function normalizeConfigFile(candidate: unknown, renamedKeyMessages: string[] = []): GlimmervoidConfig {
  if (!isRecord(candidate)) throw new Error('config must be a plain object');
  const draft = normalizeLegacyConfigNumbers(candidate);
  renamedKeyMessages.push(...moveRenamedKeys(draft));
  replaceInvalidWorktreeLeaves(draft);
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG_BY_KEY)) {
    if (fallback === null || typeof fallback === 'object') continue;
    if (!Object.hasOwn(draft, key)) continue;
    const fieldSchema = Config.shape[key as keyof typeof Config.shape];
    if (!fieldSchema || fieldSchema.safeParse(draft[key]).success) continue;
    console.warn(`[config] ${key} value ${JSON.stringify(draft[key])} is invalid; using ${JSON.stringify(fallback)}`);
    draft[key] = fallback;
  }
  const validation = validateConfig(draft);
  if (!validation.ok) throw new Error(`validation failed: ${validation.errors.join('; ')}`);
  return validation.config;
}

function writeBackupContent(backupPath: string, content: string): void {
  try {
    writeTextAtomicSync(backupPath, content, { mode: CONFIG_FILE_MODE, enforceMode: true });
  } catch (err) {
    console.warn(`[config] Failed to write backup ${backupPath}:`, errorLabel(err));
  }
}

interface LoadedConfig {
  config: GlimmervoidConfig;
  loadedContent: string;
  renamedKeyMessages: string[];
}

interface FailedConfigLoad {
  config?: undefined;
  loadedContent?: undefined;
  error: unknown;
  message: string;
  invalidBackupPath: string;
}

function loadConfigFile(configPath: string, options?: { exitOnError?: true; envSecrets?: EnvSecrets }): LoadedConfig;
function loadConfigFile(configPath: string, options: { exitOnError: false; envSecrets?: EnvSecrets }): LoadedConfig | FailedConfigLoad;
function loadConfigFile(
  configPath: string,
  { exitOnError = true, envSecrets = readEnvSecrets(process.env) }: { exitOnError?: boolean; envSecrets?: EnvSecrets } = {},
): LoadedConfig | FailedConfigLoad {
  const loadedContent = fs.readFileSync(configPath, 'utf8');
  try {
    const renamedKeyMessages: string[] = [];
    const parsed = normalizeConfigFile(JSON.parse(loadedContent), renamedKeyMessages);
    return { config: withEnvSecrets(parsed, envSecrets), loadedContent, renamedKeyMessages };
  } catch (err) {
    const invalidBackupPath = `${configPath}.invalid.bak`;
    try {
      writeTextAtomicSync(invalidBackupPath, loadedContent, { mode: CONFIG_FILE_MODE, enforceMode: true });
    } catch (backupErr) {
      console.warn(`[config] Failed to save invalid config copy ${invalidBackupPath}:`, errorLabel(backupErr));
    }
    const message = `[config] Could not load ${configPath}: ${errorMessage(err)}. The broken file was copied to ${invalidBackupPath} when possible. Restore from ${configPath}.boot.bak or ${configPath}.bak, then restart Glimmervoid.`;
    if (!exitOnError) return { error: err, message, invalidBackupPath };
    console.error(message);
    process.exit(1);
  }
}

function writeMutatedConfigFile(configPath: string, mutatorFn: (config: GlimmervoidConfig) => void): ConfigFileSave {
  const loaded = loadConfigFile(configPath, { exitOnError: false, envSecrets: [] });
  if ('error' in loaded) return { ok: false, message: loaded.message };
  mutatorFn(loaded.config);
  const validation = validateConfig(loaded.config);
  if (!validation.ok) return { ok: false, message: `config.json at ${configPath} was not written; validation failed: ${validation.errors.join('; ')}` };
  const nextContent = JSON.stringify(validation.config, null, 2);
  if (nextContent !== loaded.loadedContent) writeBackupContent(`${configPath}.bak`, loaded.loadedContent);
  writeTextAtomicSync(configPath, nextContent, { mode: CONFIG_FILE_MODE });
  return { ok: true, config: validation.config };
}

function saveConfigFileOnce(configPath: string, mutatorFn: (config: GlimmervoidConfig) => void): ConfigFileSave {
  try {
    return writeMutatedConfigFile(configPath, mutatorFn);
  } catch (error) {
    return { ok: false, message: `config.json at ${configPath} was not written: ${errorMessage(error)}` };
  }
}

function topLevelKeyCount(candidate: unknown): number {
  if (!isRecord(candidate)) return 0;
  return Object.keys(candidate).length;
}

function isSuspectedExternalWipe(candidate: GlimmervoidConfig, currentConfig: GlimmervoidConfig): boolean {
  const currentKeyCount = topLevelKeyCount(currentConfig);
  if (currentKeyCount === 0) return false;
  const resolvedCandidate = { ...candidate, branchGc: resolveBranchGc(candidate.branchGc) };
  return topLevelKeyCount(resolvedCandidate) * 2 < currentKeyCount;
}

function invalidConfigWarning(action: string, validation: { errors: string[] }): string {
  return `[config] Refusing to ${action}; validation failed: ${validation.errors.join('; ')}. Recovery sources: config.json.bak and config.json.boot.bak.`;
}

function suspectedWipeWarning(action: string): string {
  return `[config] Refusing to ${action}; config.json has fewer than half the top-level keys of the in-memory config. This looks like an external wipe. Recovery sources: config.json.bak and config.json.boot.bak.`;
}

function warnSuspectedWipe(action: string): void {
  console.warn(suspectedWipeWarning(action));
}

function ensureProjectIds(projects: { id?: string }[]): boolean {
  let changed = false;
  for (const p of projects) {
    if (!p.id) {
      p.id = generateProjectId();
      changed = true;
    }
  }
  return changed;
}

export { ABORT_CONFIG_SAVE, CONFIG_FILE_MODE, glimmervoidHomeDir, resolveConfigPath, generateProjectId, validateConfig, normalizeConfigFile, writeBackupContent, loadConfigFile, saveConfigFileOnce, isSuspectedExternalWipe, invalidConfigWarning, suspectedWipeWarning, warnSuspectedWipe, ensureProjectIds };
export type { LoadedConfig, FailedConfigLoad };
