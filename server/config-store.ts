import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { canonicalizePath } from '../shared/canonical-paths.ts';
import { equalsIgnoringCaseOnWindows } from '../shared/paths.ts';
import { DEFAULT_BRANCH_GC_PREFIXES } from './core/branch-gc-core.ts';
import { decideConfigPath, glimmervoidHomeDir as resolveGlimmervoidHomeDir } from './core/config-path-core.ts';
import { readEnvSecrets, withEnvSecrets, withoutEnvSecrets } from './core/config-secrets-core.ts';
import { isTelemetryForcedOff } from './core/telemetry-core.ts';
import { AGENT_ID_SHAPE_MESSAGE, BranchGcFileSettings, Config, configIssueMessage, RUNTIME_CONFIG_SCALAR_KEYS } from '../shared/contracts/index.ts';
import type { CustomAgentDeclaration } from '../shared/contracts/index.ts';
import { DEFAULT_WORKFLOW_MAX_ACTIONS_PER_POLL, DEFAULT_WORKFLOW_MAX_CONCURRENT_SESSIONS } from '../shared/contracts/workflows.ts';
import type { WorkflowRule } from '../shared/contracts/workflows.ts';
import { SECRET_PRESENCE_SUFFIX, pickSettingsBlock, settingsBlockSpecFor } from './core/settings-block-core.ts';
import { writeJsonAtomicSync, writeTextAtomic, writeTextAtomicSync } from './json-file.ts';
import { errorLabel, errorMessage } from '../shared/text.ts';
import { isRecord } from '../shared/coerce.ts';
import { normalizeLegacyConfigNumbers } from '../shared/contracts/config-numbers-core.ts';
import { assetForPlatform } from './core/rtk-install-core.ts';
import { DEFAULT_SESSION_MEMORY_RESERVE_MB } from './core/memory-admission-core.ts';
import { withExperimentalFeaturesGated } from './core/experimental-gate-core.ts';
import { isExperimentalBuild as isExperimentalVersion } from '../shared/build-channel.ts';
import { packageRoot } from './runtime-paths.ts';
import { DEFAULT_TIMER_FNS } from '../shared/timer-deps.ts';
import type { ClearTimeoutFn, SetTimeoutFn, TimerHandle } from '../shared/timer-deps.ts';

type ProjectEntry = Config['projects'][number] & { id: string; name: string };
interface GlimmervoidConfig extends Config {
  projects: ProjectEntry[];
}
type ConfigValidation = { ok: true; config: GlimmervoidConfig } | { ok: false; errors: string[] };
type ConfigFileSave = { ok: true; config: GlimmervoidConfig } | { ok: false; message: string };
type EnvSecrets = ReturnType<typeof readEnvSecrets>;

const DEFAULT_CONFIG = {
  port: 3000,
  notifyDebounceMs: 3000,

  phoneEscalationMs: 300000,
  cursorBlink: false,
  debugMode: false,
  streamerMode: false,
  viewTabOrder: [] as string[],
  remoteSessions: false,

  detectBackgroundAgents: true,

  detectScheduledWakeups: true,

  replayBufferKB: 512,

  sessionMemoryReserveMB: DEFAULT_SESSION_MEMORY_RESERVE_MB,

  recordSignals: true,

  trace: {
    enabled: true,
  },

  planReview: {
    enabled: true,
  },

  taskTitle: {
    refiner: { enabled: true, model: 'haiku', minIntervalSeconds: 60, timeoutSeconds: 60 },
  },
  guardrails: {
    unguardedRepos: [] as string[],
    blockedPaths: [] as string[],
    unreadablePaths: [] as string[],
  },

  telemetry: {
    enabled: true,
  },

  checkForUpdates: true,
  updateChannel: 'release' as const,

  autoResume: true,

  skipPermissionsByDefault: false,

  rtk: false,
  saneYolo: true,

  telegramNotifications: false,

  integrationBranch: null as string | null,

  worktreeRoot: '',

  worktreeShare: ['.env', '.env.local', '.claude'],

  worktreeAutoRebase: true,
  worktreeSyncOnStart: true,

  worktreeRerere: true,
  branchGc: {
    enabled: true,
    worktrees: true,
    prefixes: [...DEFAULT_BRANCH_GC_PREFIXES],
    dryRun: false,
    staleDays: 14,
    deleteUnmerged: false,
    intervalMs: 6 * 60 * 60 * 1000,
  },
  repoRoots: [] as string[],

  customAgents: [] as CustomAgentDeclaration[],

  remote: {
    enabled: false,

    port: null as number | null,

    publicHost: '',

    allowedOrigins: [] as string[],
  },
  workflows: {
    enabled: true,
    maxConcurrentSessions: DEFAULT_WORKFLOW_MAX_CONCURRENT_SESSIONS,
    maxActionsPerPoll: DEFAULT_WORKFLOW_MAX_ACTIONS_PER_POLL,
    rules: [] as WorkflowRule[],
  },
  projects: [] as ProjectEntry[],
};

type DefaultConfig = typeof DEFAULT_CONFIG;

const DEFAULT_CONFIG_BY_KEY: GlimmervoidConfig = DEFAULT_CONFIG;

const ABORT_CONFIG_SAVE = 'abort-config-save';

const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const CONFIG_RELOAD_DEBOUNCE_MS = 500;

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
      if (root === 'repoRoots' || root === 'worktreeShare') return `${root} must be an array of strings`;
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

function normalizeConfigFile(candidate: unknown): GlimmervoidConfig {
  if (!isRecord(candidate)) throw new Error('config must be a plain object');
  const draft = normalizeLegacyConfigNumbers(candidate);
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
    const parsed = normalizeConfigFile(JSON.parse(loadedContent));
    return { config: withEnvSecrets(parsed, envSecrets), loadedContent };
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

type BranchGcBlock = DefaultConfig['branchGc'];

function collectBranchGcIssues(branchGc: unknown): { block: BranchGcBlock; issues: string[] } {
  if (!isRecord(branchGc)) return { block: { ...DEFAULT_CONFIG.branchGc }, issues: [] };
  const accepted: Record<string, unknown> = {};
  const issues: string[] = [];
  for (const [field, value] of Object.entries(branchGc)) {
    if (!Object.hasOwn(BranchGcFileSettings.shape, field)) {
      issues.push(`[config] Ignoring unknown branchGc.${field}; it is not a branchGc setting, so the default block applies.`);
      continue;
    }
    const parsed = BranchGcFileSettings.safeParse({ [field]: value });
    if (!parsed.success) {
      issues.push(`[config] Ignoring invalid branchGc.${field}; using the default instead: ${configIssueMessage(parsed.error)}`);
      continue;
    }
    accepted[field] = value;
  }
  return { block: { ...DEFAULT_CONFIG.branchGc, ...accepted }, issues };
}

function resolveBranchGc(branchGc: unknown): BranchGcBlock {
  return collectBranchGcIssues(branchGc).block;
}

function resolveBranchGcAndWarn(branchGc: unknown): BranchGcBlock {
  const resolved = collectBranchGcIssues(branchGc);
  for (const issue of resolved.issues) console.warn(issue);
  return resolved.block;
}

function secretSourcesOf(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(readEnvSecrets(env).map((secret) => [
    `${secret.blockName}.${secret.secretKey}`, secret.environmentVariable,
  ]));
}

function retiredGuardrailKeysWarning(config: GlimmervoidConfig): string | null {
  const projects: unknown[] = Array.isArray(config.projects) ? config.projects : [];
  const retiredKeys = [
    ...(Object.hasOwn(config, 'sandbox') ? ['sandbox (move it to guardrails, renaming unconfinedRepos to unguardedRepos)'] : []),
    ...(projects.some((project) => isRecord(project) && Object.hasOwn(project, 'unconfined')) ? ['projects[].unconfined (rename it to unguarded)'] : []),
  ];
  if (retiredKeys.length === 0) return null;
  return `[guardrails] config.json still has ${retiredKeys.join(' and ')}. These keys are ignored, so their unreadable paths and opt-outs do not apply until you move them.`;
}

function readIsExperimentalBuild(): boolean {
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return isRecord(manifest) && isExperimentalVersion(manifest.version);
}

const IS_EXPERIMENTAL_BUILD = readIsExperimentalBuild();

function createConfigStore({
  settingsDefaults, readTelemetryInstallId, isExperimentalBuild = IS_EXPERIMENTAL_BUILD,
  setTimeoutFn = DEFAULT_TIMER_FNS.setTimeoutFn, clearTimeoutFn = DEFAULT_TIMER_FNS.clearTimeoutFn,
}: {
  settingsDefaults?: Partial<DefaultConfig>;
  readTelemetryInstallId?: () => string | null;
  isExperimentalBuild?: boolean;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
} = {}) {
  const configPath = resolveConfigPath();
  const effectiveDefaults: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(settingsDefaults || {}) };

  const launchDefaultKeys = new Set(Object.keys(settingsDefaults || {}));

  const envSecrets = readEnvSecrets(process.env);
  const loadedConfig = loadConfigFile(configPath);
  const config = loadedConfig.config;
  writeBackupContent(`${configPath}.boot.bak`, loadedConfig.loadedContent);
  config.repoRoots = config.repoRoots || [];
  config.branchGc = resolveBranchGcAndWarn(config.branchGc);
  const retiredGuardrailKeys = retiredGuardrailKeysWarning(config);
  if (retiredGuardrailKeys !== null) console.warn(retiredGuardrailKeys);

  if (Array.isArray(config.projects) && ensureProjectIds(config.projects)) {
    try {
      writeJsonAtomicSync(configPath, withoutEnvSecrets(config, envSecrets), { mode: CONFIG_FILE_MODE });
      console.log('[config] Auto-assigned IDs to projects missing them');
    } catch (err) {
      console.warn('[config] Failed to persist auto-assigned project IDs:', errorMessage(err));
    }
  }
  Object.assign(config, withExperimentalFeaturesGated(config, isExperimentalBuild));

  let _lastWrittenContent: string | null = null;
  let _lastAppliedContent: string | null = loadedConfig.loadedContent;
  let synchronousWriteRevision = 0;
  let lastSynchronousContent: string | null = null;
  let pendingSaves: Promise<unknown> = Promise.resolve();

  let lastSaveFailureReason: string | null = null;

  function refuseSave(warning: string, operatorReason = warning.replace(/^\[config\] /, '')): null {
    console.warn(warning);
    lastSaveFailureReason = operatorReason;
    return null;
  }

  function prepareSave(freshConfig: GlimmervoidConfig, mutatorFn: (config: GlimmervoidConfig) => unknown): GlimmervoidConfig | null {
    const freshValidation = validateConfig(freshConfig);
    if (!freshValidation.ok) return refuseSave(invalidConfigWarning('save config.json', freshValidation));
    if (isSuspectedExternalWipe(freshConfig, config)) return refuseSave(suspectedWipeWarning('save config.json'));
    if (mutatorFn(freshConfig) === ABORT_CONFIG_SAVE) return null;
    const effectiveConfig = withEnvSecrets(freshConfig, envSecrets);
    const mutatedValidation = validateConfig(effectiveConfig);
    if (!mutatedValidation.ok) return refuseSave(invalidConfigWarning('save config.json', mutatedValidation));
    return mutatedValidation.config;
  }

  function save(mutatorFn: (config: GlimmervoidConfig) => unknown): GlimmervoidConfig | null {
    lastSaveFailureReason = null;
    let loaded: LoadedConfig | FailedConfigLoad;
    try {
      loaded = loadConfigFile(configPath, { exitOnError: false });
    } catch (err) {
      return refuseSave(`[config] Failed to read config.json for save: ${errorLabel(err)}`);
    }
    if ('error' in loaded) return refuseSave(loaded.message, `${configPath} could not be read as a config file. The broken file was copied to ${loaded.invalidBackupPath} when possible. Fix it, or restore from ${configPath}.bak, then save again.`);
    const freshConfig = loaded.config;
    const freshContent = loaded.loadedContent;
    const effectiveConfig = prepareSave(freshConfig, mutatorFn);
    if (!effectiveConfig) return null;
    try {
      const nextContent = JSON.stringify(withoutEnvSecrets(effectiveConfig, envSecrets), null, 2);
      if (freshContent !== nextContent) writeBackupContent(`${configPath}.bak`, freshContent);

      _lastWrittenContent = nextContent;

      _lastAppliedContent = null;

      writeTextAtomicSync(configPath, nextContent, { mode: CONFIG_FILE_MODE });
      lastSynchronousContent = nextContent;
      synchronousWriteRevision++;
    } catch (err) {
      return refuseSave(`[config] Failed to write config.json: ${errorLabel(err)}`);
    }
    return withExperimentalFeaturesGated(effectiveConfig, isExperimentalBuild);
  }

  function saveAsync(mutatorFn: (config: GlimmervoidConfig) => unknown): Promise<GlimmervoidConfig | null> {
    const scheduledSave = pendingSaves.then(async () => {
      let concurrentContent: string | null = null;
      for (;;) {
        const revision = synchronousWriteRevision;
        try {
          const diskContent = await fs.promises.readFile(configPath, 'utf8');
          if (revision !== synchronousWriteRevision) {
            concurrentContent = lastSynchronousContent;
            continue;
          }
          const freshContent = concurrentContent ?? diskContent;
          const freshConfig = withEnvSecrets(normalizeConfigFile(JSON.parse(freshContent)), envSecrets);
          const effectiveConfig = prepareSave(freshConfig, mutatorFn);
          if (!effectiveConfig) return null;
          const nextContent = JSON.stringify(withoutEnvSecrets(effectiveConfig, envSecrets), null, 2);
          if (freshContent !== nextContent) {
            try {
              await writeTextAtomic(`${configPath}.bak`, freshContent, { mode: CONFIG_FILE_MODE, enforceMode: process.platform !== 'win32' });
            } catch (error) {
              console.warn(`[config] Failed to write backup ${configPath}.bak:`, errorLabel(error));
            }
          }
          if (revision !== synchronousWriteRevision) {
            concurrentContent = lastSynchronousContent;
            continue;
          }
          await writeTextAtomic(configPath, nextContent, { mode: CONFIG_FILE_MODE });
          if (revision !== synchronousWriteRevision) {
            concurrentContent = lastSynchronousContent;
            continue;
          }
          _lastWrittenContent = nextContent;
          _lastAppliedContent = null;
          return withExperimentalFeaturesGated(effectiveConfig, isExperimentalBuild);
        } catch (error) {
          console.warn('[config] Failed to save config.json asynchronously:', errorMessage(error));
          return null;
        }
      }
    });
    pendingSaves = scheduledSave;
    return scheduledSave;
  }

  const warnedTooDeepPaths = new Set<string>();

  function pickBlock(blockName: string, stored: unknown): Record<string, unknown> | null {
    const tooDeepPaths: string[] = [];
    const picked = pickSettingsBlock(stored, settingsBlockSpecFor(blockName), tooDeepPaths);
    for (const tooDeepPath of tooDeepPaths) {
      if (warnedTooDeepPaths.has(tooDeepPath)) continue;
      warnedTooDeepPaths.add(tooDeepPath);
      console.warn(`[config] ${tooDeepPath} is nested too deeply to send to the dashboard, so Settings leaves it out; config.json keeps it as it is.`);
    }
    return picked;
  }

  function getSettings() {
    return {
      port: config.port,
      notifyDebounceMs: config.notifyDebounceMs,
      phoneEscalationMs: config.phoneEscalationMs ?? DEFAULT_CONFIG.phoneEscalationMs,
      replayBufferKB: config.replayBufferKB,
      cursorBlink: config.cursorBlink ?? effectiveDefaults.cursorBlink,
      debugMode: config.debugMode ?? effectiveDefaults.debugMode,
      streamerMode: config.streamerMode ?? effectiveDefaults.streamerMode,
      viewTabOrder: config.viewTabOrder ?? DEFAULT_CONFIG.viewTabOrder,
      remoteSessions: config.remoteSessions ?? effectiveDefaults.remoteSessions,
      detectBackgroundAgents: config.detectBackgroundAgents ?? effectiveDefaults.detectBackgroundAgents,
      recordSignals: config.recordSignals ?? effectiveDefaults.recordSignals,
      trace: pickBlock('trace', { ...DEFAULT_CONFIG.trace, ...config.trace }),
      guardrails: pickBlock('guardrails', { ...DEFAULT_CONFIG.guardrails, ...config.guardrails }),
      telemetry: pickBlock('telemetry', { ...DEFAULT_CONFIG.telemetry, ...config.telemetry }),
      telemetryForcedOff: isTelemetryForcedOff(process.env),
      telemetryInstallId: readTelemetryInstallId?.() ?? null,
      rtk: config.rtk ?? effectiveDefaults.rtk,
      rtkInstallSupported: assetForPlatform(process.platform, process.arch) !== null,
      saneYolo: config.saneYolo ?? effectiveDefaults.saneYolo,
      checkForUpdates: config.checkForUpdates ?? effectiveDefaults.checkForUpdates,
      updateChannel: config.updateChannel ?? effectiveDefaults.updateChannel,
      autoResume: config.autoResume ?? effectiveDefaults.autoResume,
      skipPermissionsByDefault: config.skipPermissionsByDefault ?? effectiveDefaults.skipPermissionsByDefault,
      telegramNotifications: config.telegramNotifications ?? effectiveDefaults.telegramNotifications,
      integrationBranch: config.integrationBranch === undefined ? effectiveDefaults.integrationBranch : config.integrationBranch,
      worktreeRoot: config.worktreeRoot ?? effectiveDefaults.worktreeRoot,
      worktreeShare: config.worktreeShare ?? effectiveDefaults.worktreeShare,
      repoRoots: config.repoRoots,
      repositoryRootCaseInsensitive: equalsIgnoringCaseOnWindows('root', 'ROOT'),

      taskTitle: pickBlock('taskTitle', config.taskTitle ?? DEFAULT_CONFIG.taskTitle),
      branchGc: pickBlock('branchGc', config.branchGc),
      visions: pickBlock('visions', config.visions),
      github: pickBlock('github', config.github),
      teamReview: pickBlock('teamReview', config.teamReview),
      benchmarks: pickBlock('benchmarks', config.benchmarks),
      coherence: pickBlock('coherence', config.coherence),
      issues: pickBlock('issues', config.issues),
      community: pickBlock('community', config.community),
      workflows: config.workflows ?? null,

      posthog: pickBlock('posthog', config.posthog),
      secretSources: secretSourcesOf(process.env),

      usage: pickBlock('usage', config.usage),
      telegram: pickBlock('telegram', config.telegram),

      ingest: pickBlock('ingest', config.ingest),

      projectChoices: (config.projects || []).map((p) => ({ id: p.id, name: p.name, path: p.path })),
    };
  }

  function isUnchosenLaunchDefault(target: Record<string, unknown>, key: string, value: unknown): boolean {
    if (!launchDefaultKeys.has(key)) return false;
    if (key in target) return false;
    return value === effectiveDefaults[key];
  }

  function applySettings(newConfig: Partial<GlimmervoidConfig>): void {
    for (const key of RUNTIME_CONFIG_SCALAR_KEYS) {
      if (key === 'integrationBranch' && newConfig[key] !== undefined) {
        config[key] = newConfig[key] === null || String(newConfig[key]) === '' ? null : String(newConfig[key]);
        continue;
      }
      if (newConfig[key] == null) {
        delete config[key];
        continue;
      }
      let nextValue = newConfig[key];
      if (typeof DEFAULT_CONFIG_BY_KEY[key] === 'boolean') nextValue = !!nextValue;
      if (typeof DEFAULT_CONFIG_BY_KEY[key] === 'string') nextValue = String(nextValue);
      if (typeof nextValue === 'boolean' && isUnchosenLaunchDefault(config, key, nextValue)) continue;
      config[key] = nextValue;
    }
    config.repoRoots = newConfig.repoRoots || [];

    if (newConfig.worktreeShare == null) delete config.worktreeShare;
    if (newConfig.worktreeShare != null) config.worktreeShare = newConfig.worktreeShare;
    if (newConfig.taskTitle != null) config.taskTitle = newConfig.taskTitle;
    if (newConfig.branchGc != null) config.branchGc = resolveBranchGc(newConfig.branchGc);
    if (newConfig.visions != null) config.visions = newConfig.visions;
    if (newConfig.github != null) config.github = newConfig.github;
    if (newConfig.teamReview != null) config.teamReview = newConfig.teamReview;
    if (newConfig.benchmarks != null) config.benchmarks = newConfig.benchmarks;
    if (newConfig.coherence != null) config.coherence = newConfig.coherence;
    if (newConfig.issues != null) config.issues = newConfig.issues;
    if (newConfig.community != null) config.community = newConfig.community;
    if (newConfig.posthog != null) config.posthog = newConfig.posthog;
    if (newConfig.usage != null) config.usage = newConfig.usage;
    if (newConfig.telegram != null) config.telegram = newConfig.telegram;
    if (newConfig.ingest != null) config.ingest = newConfig.ingest;
    if (newConfig.guardrails != null) config.guardrails = newConfig.guardrails;
    if (newConfig.telemetry != null) config.telemetry = newConfig.telemetry;
    if (newConfig.workflows == null) delete config.workflows;
    if (newConfig.workflows != null) config.workflows = newConfig.workflows;
    if (newConfig.coder == null) delete config.coder;
    if (newConfig.coder != null) config.coder = newConfig.coder;
    config.customAgents = newConfig.customAgents ?? [];

    config.hooks = Array.isArray(newConfig.hooks) ? newConfig.hooks : [];
    if (newConfig.port != null && newConfig.port !== config.port) {
      console.log(`[settings] Port changed to ${newConfig.port} - restart required to take effect`);
    }
  }

  function watchForChanges(callback: (config: GlimmervoidConfig) => void, { reloadDebounceMs = CONFIG_RELOAD_DEBOUNCE_MS }: { reloadDebounceMs?: number } = {}): () => void {
    let reloadTimer: TimerHandle | null = null;
    let watcher: fs.FSWatcher | null = null;

    function handleConfigChange(err: NodeJS.ErrnoException | null, data: string): void {
      if (err) {
        console.warn('[config] Failed to read config.json:', err.code);
        return;
      }

      if (_lastWrittenContent !== null && data === _lastWrittenContent) return;
      if (_lastAppliedContent !== null && data === _lastAppliedContent) return;
      let newConfig: GlimmervoidConfig;
      try {
        newConfig = withEnvSecrets(normalizeConfigFile(JSON.parse(data)), envSecrets);
      } catch (parseErr) {
        console.warn('[config] Invalid config.json:', errorMessage(parseErr));
        return;
      }
      newConfig.branchGc = resolveBranchGcAndWarn(newConfig.branchGc);
      if (isSuspectedExternalWipe(newConfig, config)) {
        warnSuspectedWipe('reload config.json');
        return;
      }
      _lastAppliedContent = data;

      _lastWrittenContent = null;
      callback(withExperimentalFeaturesGated(newConfig, isExperimentalBuild));
      console.log('[config] Reloaded config.json');
    }

    try {

      const canonicalConfigPath = canonicalizePath(configPath);
      const watchDir = path.dirname(canonicalConfigPath);
      const targetName = path.basename(canonicalConfigPath);

      watcher = fs.watch(watchDir, (_event, filename) => {
        if (filename != null && !equalsIgnoringCaseOnWindows(path.basename(String(filename)), targetName)) return;

        if (reloadTimer) clearTimeoutFn(reloadTimer);
        reloadTimer = setTimeoutFn(() => {
          fs.readFile(configPath, 'utf8', handleConfigChange);
        }, reloadDebounceMs);
      });
      console.log('[config] Watching config.json for changes');
    } catch (watchErr) {
      console.warn('[config] Failed to watch config.json:', errorMessage(watchErr));
    }
    return function stop(): void {
      if (reloadTimer) clearTimeoutFn(reloadTimer);
      if (watcher) { try { watcher.close(); } catch {} }
      watcher = null;
    };
  }

  return {
    config,
    configPath,
    save,
    saveAsync,
    lastSaveFailureReason: () => lastSaveFailureReason,
    idle: () => pendingSaves,
    getSettings,
    applySettings,
    isUnchosenLaunchDefault,
    watchForChanges,
    isExperimentalBuild,
    DEFAULT_CONFIG,
  };
}

type ConfigStore = ReturnType<typeof createConfigStore>;

export { IS_EXPERIMENTAL_BUILD, createConfigStore, resolveConfigPath, glimmervoidHomeDir, generateProjectId, ensureProjectIds, validateConfig, loadConfigFile, saveConfigFileOnce, ABORT_CONFIG_SAVE, DEFAULT_CONFIG, CONFIG_FILE_MODE, SECRET_PRESENCE_SUFFIX };
export type { ConfigStore, DefaultConfig, GlimmervoidConfig, ProjectEntry };
