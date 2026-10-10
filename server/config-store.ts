import crypto from 'node:crypto';
import { DEFAULT_FACTORY_CHECKS, DEFAULT_FACTORY_PROTECTED_PATHS } from '../shared/contracts/browser-config.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { canonicalizePath, equalsIgnoringCaseOnWindows } from '../shared/paths.ts';
import { DEFAULT_BRANCH_GC_PREFIXES } from './core/branch-gc-core.ts';
import { decideConfigPath, glimmervoidHomeDir as resolveGlimmervoidHomeDir } from './core/config-path-core.ts';
import { readEnvSecrets, withEnvSecrets, withoutEnvSecrets } from './core/config-secrets-core.ts';
import { isTelemetryForcedOff } from './core/telemetry-core.ts';
import { AGENT_ID_SHAPE_MESSAGE, BranchGcFileSettings, Config, configIssueMessage, RUNTIME_CONFIG_SCALAR_KEYS } from '../shared/contracts/index.ts';
import type { CustomAgentDeclaration } from '../shared/contracts/index.ts';
import { DEFAULT_WORKFLOW_MAX_ACTIONS_PER_POLL, DEFAULT_WORKFLOW_MAX_CONCURRENT_SESSIONS } from '../shared/contracts/workflows.ts';
import type { WorkflowRule } from '../shared/contracts/workflows.ts';
import { isPlainObject } from './core/usage-number-core.ts';
import { INGEST_SPEC, pickSettingsBlock } from './core/settings-block-core.ts';
import { writeJsonAtomicSync, writeTextAtomic, writeTextAtomicSync } from './json-file.ts';
import { errorMessage } from './core/text-core.ts';

type ProjectEntry = Config['projects'][number] & { id: string; name: string };
interface GlimmervoidConfig extends Config {
  projects: ProjectEntry[];
}
type ConfigValidation = { ok: true; config: GlimmervoidConfig } | { ok: false; errors: string[] };

const DEFAULT_CONFIG = {
  port: 3000,
  autoRecoverSeconds: 3,
  inputGraceSeconds: 5,
  promptDetectionMs: 1500,
  notifyDebounceMs: 3000,

  phoneEscalationMs: 300000,
  cursorBlink: false,
  debugMode: false,
  calmLayout: false,

  detectBackgroundAgents: true,

  detectScheduledWakeups: true,

  replayBufferKB: 512,

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
  changeMap: {
    narrator: { enabled: false, engine: 'claude', model: '', timeoutSeconds: 90 },
  },

  factory: { enabled: false, maxRisk: 'medium' as const, maxLiveWorkers: 2, checks: DEFAULT_FACTORY_CHECKS, protectedPaths: DEFAULT_FACTORY_PROTECTED_PATHS, reviewerModel: null, watchWindowMinutes: 30, watchProjects: [], dailyBudgetUsd: null, verifierModel: null },

  agentApi: {
    enabled: false,
  },

  telemetry: {
    enabled: true,
  },

  checkForUpdates: true,
  updateChannel: 'release' as const,

  autoResume: true,

  skipPermissionsByDefault: false,

  antiSlopPrompt: false,
  rtk: false,
  saneYolo: true,

  telegramNotifications: false,

  integrationBranch: null as string | null,

  worktreeRoot: '',

  worktreeShare: ['node_modules', '.env', '.env.local', '.claude'],

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

  postTurnChecks: {
    enabled: true,
    mode: 'report',

    rules: { trailingWs: true, finalNewline: true, bom: true, slop: false },
  },

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

function errorCode(error: unknown): string {
  const source = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof source.code === 'string') return source.code;
  return typeof source.message === 'string' ? source.message : String(error);
}

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
    console.error(`Config file not found: ${decided.envPath}`);
    process.exit(1);
  }

  const homeConfig = decided.homePath;
  fs.mkdirSync(homeDir, { recursive: true, mode: CONFIG_DIR_MODE });
  restrictMode(homeDir, CONFIG_DIR_MODE);
  fs.writeFileSync(homeConfig, JSON.stringify(DEFAULT_CONFIG, null, 2), { encoding: 'utf8', mode: CONFIG_FILE_MODE });
  restrictMode(homeConfig, CONFIG_FILE_MODE);
  console.log(`Created default config at ${homeConfig}`);
  return homeConfig;
}

function generateProjectId(): string {
  return crypto.randomUUID();
}

function validateConfig(candidate: unknown): ConfigValidation {
  if (!isPlainObject(candidate)) return { ok: false, errors: ['config must be a plain object'] };
  const parsedConfig = Config.safeParse(candidate);
  if (!parsedConfig.success) {
    const errors = parsedConfig.error.issues.map((issue) => {
      if (issue.code === 'custom') return issue.message;
      const [root, index, field] = issue.path;
      if (root === 'port') return 'port must be an integer from 0 to 65535';
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
      return `projects[${index}].${String(field)} must be a string`;
    });
    return { ok: false, errors };
  }
  return { ok: true, config: parsedConfig.data as GlimmervoidConfig };
}

function normalizeConfigFile(candidate: unknown): GlimmervoidConfig {
  if (!isPlainObject(candidate)) throw new Error('config must be a plain object');
  const draft: Record<string, unknown> = candidate;
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
    fs.writeFileSync(backupPath, content, { encoding: 'utf8', mode: CONFIG_FILE_MODE });
    restrictMode(backupPath, CONFIG_FILE_MODE);
  } catch (err) {
    console.warn(`[config] Failed to write backup ${backupPath}:`, errorCode(err));
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

function loadConfigFile(configPath: string, options?: { exitOnError?: true }): LoadedConfig;
function loadConfigFile(configPath: string, options: { exitOnError: false }): LoadedConfig | FailedConfigLoad;
function loadConfigFile(configPath: string, { exitOnError = true }: { exitOnError?: boolean } = {}): LoadedConfig | FailedConfigLoad {
  const loadedContent = fs.readFileSync(configPath, 'utf8');
  try {
    const parsed = normalizeConfigFile(JSON.parse(loadedContent));
    return { config: withEnvSecrets(parsed, readEnvSecrets(process.env)), loadedContent };
  } catch (err) {
    const invalidBackupPath = `${configPath}.invalid.bak`;
    try {
      fs.writeFileSync(invalidBackupPath, loadedContent, { encoding: 'utf8', mode: CONFIG_FILE_MODE });
      restrictMode(invalidBackupPath, CONFIG_FILE_MODE);
    } catch (backupErr) {
      console.warn(`[config] Failed to save invalid config copy ${invalidBackupPath}:`, errorCode(backupErr));
    }
    const message = `[config] Could not load ${configPath}: ${errorMessage(err)}. The broken file was copied to ${invalidBackupPath} when possible. Restore from ${configPath}.boot.bak or ${configPath}.bak, then restart Glimmervoid.`;
    if (!exitOnError) return { error: err, message, invalidBackupPath };
    console.error(message);
    process.exit(1);
  }
}

function topLevelKeyCount(candidate: unknown): number {
  if (!isPlainObject(candidate)) return 0;
  return Object.keys(candidate).length;
}

function isSuspectedExternalWipe(candidate: GlimmervoidConfig, currentConfig: GlimmervoidConfig): boolean {
  const currentKeyCount = topLevelKeyCount(currentConfig);
  if (currentKeyCount === 0) return false;
  const resolvedCandidate = { ...candidate, branchGc: resolveBranchGc(candidate.branchGc) };
  return topLevelKeyCount(resolvedCandidate) * 2 < currentKeyCount;
}

function warnInvalidConfig(action: string, validation: { errors: string[] }): void {
  console.warn(`[config] Refusing to ${action}; validation failed: ${validation.errors.join('; ')}. Recovery sources: config.json.bak and config.json.boot.bak.`);
}

function warnSuspectedWipe(action: string): void {
  console.warn(`[config] Refusing to ${action}; config.json has fewer than half the top-level keys of the in-memory config. This looks like an external wipe. Recovery sources: config.json.bak and config.json.boot.bak.`);
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
  if (!isPlainObject(branchGc)) return { block: { ...DEFAULT_CONFIG.branchGc }, issues: [] };
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

const POSTHOG_SETTINGS_KEYS = Object.freeze([
  'enabled', 'recurrenceDedupe', 'trafficSpikeEnabled', 'autoFix',
  'host', 'repoPath', 'projects', 'projectMap',
  'intervalMinutes', 'maxConcurrentInvestigations', 'investigationTimeoutSeconds', 'fixTimeoutSeconds',
  'minUsersToInvestigate', 'userEscalationThreshold', 'recurrenceWindowDays', 'transientRecurrenceLimit',
  'trafficSpikeMultiplier', 'trafficSpikeMinUsers', 'trafficSpikeCooldownMinutes', 'trafficSpikeBaselineDays',
]);
const POSTHOG_SECRET_KEYS = Object.freeze(['apiKey']);
const TELEGRAM_SETTINGS_KEYS = Object.freeze(['chatId']);
const TELEGRAM_SECRET_KEYS = Object.freeze(['botToken']);
const SECRET_PRESENCE_SUFFIX = 'Configured';

function pickRedactedBlock(
  stored: unknown,
  allowedKeys: readonly string[],
  secretKeys: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainObject(stored)) return null;
  const source: Record<string, unknown> = stored;
  const redacted: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (source[key] !== undefined) redacted[key] = source[key];
  }
  for (const secretKey of secretKeys) {
    const secret = source[secretKey];
    redacted[`${secretKey}${SECRET_PRESENCE_SUFFIX}`] = typeof secret === 'string' && secret.length > 0;
  }
  return redacted;
}

function createConfigStore({ settingsDefaults }: { settingsDefaults?: Partial<DefaultConfig> } = {}) {
  const configPath = resolveConfigPath();
  const effectiveDefaults: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(settingsDefaults || {}) };

  const launchDefaultKeys = new Set(Object.keys(settingsDefaults || {}));

  const envSecrets = readEnvSecrets(process.env);
  const loadedConfig = loadConfigFile(configPath);
  const config = loadedConfig.config;
  writeBackupContent(`${configPath}.boot.bak`, loadedConfig.loadedContent);
  config.repoRoots = config.repoRoots || [];
  config.branchGc = resolveBranchGcAndWarn(config.branchGc);

  if (Array.isArray(config.projects) && ensureProjectIds(config.projects)) {
    try {
      writeJsonAtomicSync(configPath, withoutEnvSecrets(config, envSecrets), { mode: CONFIG_FILE_MODE });
      console.log('[config] Auto-assigned IDs to projects missing them');
    } catch (err) {
      console.warn('[config] Failed to persist auto-assigned project IDs:', errorMessage(err));
    }
  }

  let _lastWrittenContent: string | null = null;
  let _lastAppliedContent: string | null = loadedConfig.loadedContent;
  let synchronousWriteRevision = 0;
  let lastSynchronousContent: string | null = null;
  let pendingSaves: Promise<unknown> = Promise.resolve();

  function prepareSave(freshConfig: GlimmervoidConfig, mutatorFn: (config: GlimmervoidConfig) => unknown): GlimmervoidConfig | null {
    const freshValidation = validateConfig(freshConfig);
    if (!freshValidation.ok) {
      warnInvalidConfig('save config.json', freshValidation);
      return null;
    }
    if (isSuspectedExternalWipe(freshConfig, config)) {
      warnSuspectedWipe('save config.json');
      return null;
    }
    if (mutatorFn(freshConfig) === ABORT_CONFIG_SAVE) return null;
    const effectiveConfig = withEnvSecrets(freshConfig, envSecrets);
    const mutatedValidation = validateConfig(effectiveConfig);
    if (!mutatedValidation.ok) {
      warnInvalidConfig('save config.json', mutatedValidation);
      return null;
    }
    return mutatedValidation.config;
  }

  function save(mutatorFn: (config: GlimmervoidConfig) => unknown): GlimmervoidConfig | null {
    let loaded: LoadedConfig | FailedConfigLoad;
    try {
      loaded = loadConfigFile(configPath, { exitOnError: false });
    } catch (err) {
      console.warn('[config] Failed to read config.json for save:', errorCode(err));
      return null;
    }
    if ('error' in loaded) {
      console.warn(loaded.message);
      return null;
    }
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
      console.warn('[config] Failed to write config.json:', errorCode(err));
      return null;
    }
    return effectiveConfig;
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
              await fs.promises.writeFile(`${configPath}.bak`, freshContent, { encoding: 'utf8', mode: CONFIG_FILE_MODE });
              if (process.platform !== 'win32') await fs.promises.chmod(`${configPath}.bak`, CONFIG_FILE_MODE);
            } catch (error) {
              console.warn(`[config] Failed to write backup ${configPath}.bak:`, errorCode(error));
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
          return effectiveConfig;
        } catch (error) {
          console.warn('[config] Failed to save config.json asynchronously:', errorMessage(error));
          return null;
        }
      }
    });
    pendingSaves = scheduledSave;
    return scheduledSave;
  }

  function getSettings() {
    return {
      port: config.port,
      autoRecoverSeconds: config.autoRecoverSeconds,
      inputGraceSeconds: config.inputGraceSeconds,
      promptDetectionMs: config.promptDetectionMs,
      notifyDebounceMs: config.notifyDebounceMs,
      phoneEscalationMs: config.phoneEscalationMs ?? DEFAULT_CONFIG.phoneEscalationMs,
      replayBufferKB: config.replayBufferKB,
      cursorBlink: config.cursorBlink ?? effectiveDefaults.cursorBlink,
      debugMode: config.debugMode ?? effectiveDefaults.debugMode,
      calmLayout: config.calmLayout ?? effectiveDefaults.calmLayout,
      detectBackgroundAgents: config.detectBackgroundAgents ?? effectiveDefaults.detectBackgroundAgents,
      recordSignals: config.recordSignals ?? effectiveDefaults.recordSignals,
      trace: { enabled: config.trace?.enabled ?? DEFAULT_CONFIG.trace.enabled },
      agentApi: { enabled: config.agentApi?.enabled ?? DEFAULT_CONFIG.agentApi.enabled },
      telemetry: { enabled: config.telemetry?.enabled ?? DEFAULT_CONFIG.telemetry.enabled },
      telemetryForcedOff: isTelemetryForcedOff(process.env),
      antiSlopPrompt: config.antiSlopPrompt ?? effectiveDefaults.antiSlopPrompt,
      rtk: config.rtk ?? effectiveDefaults.rtk,
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

      taskTitle: config.taskTitle ? { ...config.taskTitle } : { ...DEFAULT_CONFIG.taskTitle },
      changeMap: config.changeMap ? { ...config.changeMap } : null,
      branchGc: { ...config.branchGc },
      postTurnChecks: config.postTurnChecks ? { ...config.postTurnChecks } : { ...DEFAULT_CONFIG.postTurnChecks },
      visions: config.visions ? { ...config.visions } : null,
      teamReview: config.teamReview ? { ...config.teamReview } : null,
      benchmarks: config.benchmarks ? { ...config.benchmarks } : null,
      factory: config.factory ? { ...config.factory } : null,
      knowledgeGraph: config.knowledgeGraph ? { ...config.knowledgeGraph } : null,
      workflows: config.workflows ?? null,

      posthog: pickRedactedBlock(config.posthog, POSTHOG_SETTINGS_KEYS, POSTHOG_SECRET_KEYS),

      usage: config.usage ? { ...config.usage } : null,
      telegram: pickRedactedBlock(config.telegram, TELEGRAM_SETTINGS_KEYS, TELEGRAM_SECRET_KEYS),

      ingest: pickSettingsBlock(config.ingest, INGEST_SPEC),

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
      if (key === 'integrationBranch') {
        if (newConfig[key] === undefined) continue;
        config[key] = newConfig[key] === null || String(newConfig[key]) === '' ? null : String(newConfig[key]);
        continue;
      }
      if (newConfig[key] == null) continue;
      let nextValue = newConfig[key];
      if (typeof DEFAULT_CONFIG_BY_KEY[key] === 'boolean') nextValue = !!nextValue;
      if (typeof DEFAULT_CONFIG_BY_KEY[key] === 'string') nextValue = String(nextValue);
      if (typeof nextValue === 'boolean' && isUnchosenLaunchDefault(config, key, nextValue)) continue;
      config[key] = nextValue;
    }
    config.repoRoots = newConfig.repoRoots || [];

    if (newConfig.postTurnChecks != null) config.postTurnChecks = newConfig.postTurnChecks;
    if (newConfig.worktreeShare != null) config.worktreeShare = newConfig.worktreeShare;
    if (newConfig.taskTitle != null) config.taskTitle = newConfig.taskTitle;
    if (newConfig.changeMap != null) config.changeMap = newConfig.changeMap;
    if (newConfig.branchGc != null) config.branchGc = resolveBranchGc(newConfig.branchGc);
    if (newConfig.visions != null) config.visions = newConfig.visions;
    if (newConfig.teamReview != null) config.teamReview = newConfig.teamReview;
    if (newConfig.benchmarks != null) config.benchmarks = newConfig.benchmarks;
    if (newConfig.factory != null) config.factory = newConfig.factory;
    if (newConfig.knowledgeGraph != null) config.knowledgeGraph = newConfig.knowledgeGraph;
    if (newConfig.posthog != null) config.posthog = newConfig.posthog;
    if (newConfig.usage != null) config.usage = newConfig.usage;
    if (newConfig.telegram != null) config.telegram = newConfig.telegram;
    if (newConfig.ingest != null) config.ingest = newConfig.ingest;
    if (newConfig.agentApi != null) config.agentApi = newConfig.agentApi;
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

  function watchForChanges(callback: (config: GlimmervoidConfig) => void): () => void {
    let reloadTimer: NodeJS.Timeout | null = null;
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
      callback(newConfig);
      console.log('[config] Reloaded config.json');
    }

    try {

      const canonicalConfigPath = canonicalizePath(configPath);
      const watchDir = path.dirname(canonicalConfigPath);
      const targetName = path.basename(canonicalConfigPath);

      watcher = fs.watch(watchDir, (_event, filename) => {
        if (filename != null && !equalsIgnoringCaseOnWindows(path.basename(String(filename)), targetName)) return;

        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          fs.readFile(configPath, 'utf8', handleConfigChange);
        }, 500);
      });
      console.log('[config] Watching config.json for changes');
    } catch (watchErr) {
      console.warn('[config] Failed to watch config.json:', errorMessage(watchErr));
    }
    return function stop(): void {
      if (reloadTimer) clearTimeout(reloadTimer);
      if (watcher) { try { watcher.close(); } catch {} }
      watcher = null;
    };
  }

  return {
    config,
    configPath,
    save,
    saveAsync,
    idle: () => pendingSaves,
    getSettings,
    applySettings,
    isUnchosenLaunchDefault,
    watchForChanges,
    DEFAULT_CONFIG,
  };
}

type ConfigStore = ReturnType<typeof createConfigStore>;

export {
  createConfigStore, resolveConfigPath, glimmervoidHomeDir, generateProjectId, ensureProjectIds, validateConfig, loadConfigFile,
  ABORT_CONFIG_SAVE, DEFAULT_CONFIG, CONFIG_DIR_MODE, CONFIG_FILE_MODE, SECRET_PRESENCE_SUFFIX,
};
export type { BranchGcBlock, ConfigStore, DefaultConfig, GlimmervoidConfig, LoadedConfig, ProjectEntry };
