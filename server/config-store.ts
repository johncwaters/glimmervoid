import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from '../shared/canonical-paths.ts';
import { equalsIgnoringCaseOnWindows } from '../shared/paths.ts';
import { readEnvSecrets, withEnvSecrets, withoutEnvSecrets } from './core/config-secrets-core.ts';
import { isTelemetryForcedOff } from './core/telemetry-core.ts';
import { RUNTIME_CONFIG_SCALAR_KEYS } from '../shared/contracts/index.ts';
import { SECRET_PRESENCE_SUFFIX, pickSettingsBlock, settingsBlockSpecFor } from './core/settings-block-core.ts';
import { stageTextAtomic, writeJsonAtomicSync, writeTextAtomic, writeTextAtomicSync } from './json-file.ts';
import { errorLabel, errorMessage } from '../shared/text.ts';
import { isRecord } from '../shared/coerce.ts';
import { withExperimentalFeaturesGated } from './core/experimental-gate-core.ts';
import { isExperimentalBuild as isExperimentalVersion } from '../shared/build-channel.ts';
import { packageRoot } from './runtime-paths.ts';
import { DEFAULT_TIMER_FNS } from '../shared/timer-deps.ts';
import type { ClearTimeoutFn, SetTimeoutFn, TimerHandle } from '../shared/timer-deps.ts';
import type { ProjectEntry, GlimmervoidConfig } from './config/config-types.ts';
import { DEFAULT_CONFIG, DEFAULT_CONFIG_BY_KEY } from './config/config-defaults.ts';
import type { DefaultConfig } from './config/config-defaults.ts';
import { resolveBranchGc, resolveBranchGcAndWarn, retiredGuardrailKeysWarning, migrateGuardrailsUnreadablePaths, dropRetiredUpdateChannel, migrateRemoteEnabled } from './config/config-migrations.ts';
import { ABORT_CONFIG_SAVE, CONFIG_FILE_MODE, glimmervoidHomeDir, resolveConfigPath, generateProjectId, validateConfig, normalizeConfigFile, writeBackupContent, removeRetiredBackups, loadConfigFile, saveConfigFileOnce, isSuspectedExternalWipe, invalidConfigWarning, suspectedWipeWarning, warnSuspectedWipe, ensureProjectIds } from './config/config-file.ts';
import type { LoadedConfig, FailedConfigLoad } from './config/config-file.ts';
import { configBackupPath } from './secrets/core/secret-files-core.ts';

const CONFIG_RELOAD_DEBOUNCE_MS = 500;

function secretSourcesOf(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(readEnvSecrets(env).map((secret) => [
    `${secret.blockName}.${secret.secretKey}`, secret.environmentVariable,
  ]));
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
  removeRetiredBackups(configPath);
  config.repoRoots = config.repoRoots || [];
  config.branchGc = resolveBranchGcAndWarn(config.branchGc);
  const retiredGuardrailKeys = retiredGuardrailKeysWarning(config);
  if (retiredGuardrailKeys !== null) console.warn(retiredGuardrailKeys);
  const configMigrations = [...loadedConfig.renamedKeyMessages, migrateGuardrailsUnreadablePaths(config), dropRetiredUpdateChannel(config), migrateRemoteEnabled(config)].filter((migration) => migration !== null);
  if (configMigrations.length > 0) {
    try {
      writeJsonAtomicSync(configPath, withoutEnvSecrets(config, envSecrets), { mode: CONFIG_FILE_MODE });
      for (const migration of configMigrations) console.log(migration);
    } catch (err) {
      console.warn('[config] Failed to persist the config migrations:', errorMessage(err));
    }
  }

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
    if ('error' in loaded) return refuseSave(loaded.message, `${configPath} could not be read as a config file. Fix it, or restore from ${configBackupPath(configPath)}, then save again.`);
    const freshConfig = loaded.config;
    const freshContent = loaded.loadedContent;
    const effectiveConfig = prepareSave(freshConfig, mutatorFn);
    if (!effectiveConfig) return null;
    try {
      const nextContent = JSON.stringify(withoutEnvSecrets(effectiveConfig, envSecrets), null, 2);
      if (freshContent !== nextContent) writeBackupContent(configBackupPath(configPath), freshContent);

      _lastWrittenContent = nextContent;

      _lastAppliedContent = null;

      writeTextAtomicSync(configPath, nextContent, { mode: CONFIG_FILE_MODE });
      synchronousWriteRevision++;
    } catch (err) {
      return refuseSave(`[config] Failed to write config.json: ${errorLabel(err)}`);
    }
    return withExperimentalFeaturesGated(effectiveConfig, isExperimentalBuild);
  }

  function saveAsync(mutatorFn: (config: GlimmervoidConfig) => unknown): Promise<GlimmervoidConfig | null> {
    const scheduledSave = pendingSaves.then(async () => {
      for (;;) {
        const revision = synchronousWriteRevision;
        try {
          const freshContent = await fs.promises.readFile(configPath, 'utf8');
          if (revision !== synchronousWriteRevision) continue;
          const freshConfig = withEnvSecrets(normalizeConfigFile(JSON.parse(freshContent)), envSecrets);
          const effectiveConfig = prepareSave(freshConfig, mutatorFn);
          if (!effectiveConfig) return null;
          const nextContent = JSON.stringify(withoutEnvSecrets(effectiveConfig, envSecrets), null, 2);
          if (freshContent !== nextContent) {
            try {
              await writeTextAtomic(configBackupPath(configPath), freshContent, { mode: CONFIG_FILE_MODE, enforceMode: process.platform !== 'win32' });
            } catch (error) {
              console.warn(`[config] Failed to write backup ${configPath}.bak:`, errorLabel(error));
            }
          }
          const staged = await stageTextAtomic(configPath, nextContent, { mode: CONFIG_FILE_MODE });
          if (revision !== synchronousWriteRevision) {
            await staged.discard();
            continue;
          }
          staged.commit();
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
      linkPreviews: config.linkPreviews ?? effectiveDefaults.linkPreviews,
      viewTabOrder: config.viewTabOrder ?? DEFAULT_CONFIG.viewTabOrder,
      sessionOrder: config.sessionOrder ?? DEFAULT_CONFIG.sessionOrder,
      hiddenAgents: config.hiddenAgents ?? DEFAULT_CONFIG.hiddenAgents,
      remoteSessions: config.remoteSessions ?? effectiveDefaults.remoteSessions,
      hintCards: config.hintCards ?? effectiveDefaults.hintCards,
      detectBackgroundAgents: config.detectBackgroundAgents ?? effectiveDefaults.detectBackgroundAgents,
      recordSignals: config.recordSignals ?? effectiveDefaults.recordSignals,
      trace: pickBlock('trace', { ...DEFAULT_CONFIG.trace, ...config.trace }),
      telemetry: pickBlock('telemetry', { ...DEFAULT_CONFIG.telemetry, ...config.telemetry }),
      vault: pickBlock('vault', { ...DEFAULT_CONFIG.vault, ...config.vault }),
      telemetryForcedOff: isTelemetryForcedOff(process.env),
      telemetryInstallId: readTelemetryInstallId?.() ?? null,
      saneYolo: config.saneYolo ?? effectiveDefaults.saneYolo,
      saneYoloUnreadablePaths: config.saneYoloUnreadablePaths ?? DEFAULT_CONFIG.saneYoloUnreadablePaths,
      checkForUpdates: config.checkForUpdates ?? effectiveDefaults.checkForUpdates,
      autoResume: config.autoResume ?? effectiveDefaults.autoResume,
      skipPermissionsByDefault: config.skipPermissionsByDefault ?? effectiveDefaults.skipPermissionsByDefault,
      telegramNotifications: config.telegramNotifications ?? effectiveDefaults.telegramNotifications,
      worktree: pickBlock('worktree', { ...DEFAULT_CONFIG.worktree, ...config.worktree }),
      repoRoots: config.repoRoots,
      repositoryRootCaseInsensitive: equalsIgnoringCaseOnWindows('root', 'ROOT'),

      taskTitle: pickBlock('taskTitle', config.taskTitle ?? DEFAULT_CONFIG.taskTitle),
      branchGc: pickBlock('branchGc', config.branchGc),
      github: pickBlock('github', config.github),
      teamReview: pickBlock('teamReview', config.teamReview),
      benchmarks: pickBlock('benchmarks', config.benchmarks),
      coherence: pickBlock('coherence', config.coherence),
      issues: pickBlock('issues', config.issues),
      community: pickBlock('community', config.community),
      questionManager: pickBlock('questionManager', config.questionManager),
      workflows: config.workflows ?? null,

      posthog: pickBlock('posthog', config.posthog),
      secretSources: secretSourcesOf(process.env),

      usage: pickBlock('usage', config.usage),
      telegram: pickBlock('telegram', config.telegram),
    };
  }

  function isUnchosenLaunchDefault(target: Record<string, unknown>, key: string, value: unknown): boolean {
    if (!launchDefaultKeys.has(key)) return false;
    if (key in target) return false;
    return value === effectiveDefaults[key];
  }

  function applySettings(newConfig: Partial<GlimmervoidConfig>): void {
    for (const key of RUNTIME_CONFIG_SCALAR_KEYS) {
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

    if (newConfig.worktree == null) delete config.worktree;
    if (newConfig.worktree != null) config.worktree = newConfig.worktree;
    if (newConfig.taskTitle != null) config.taskTitle = newConfig.taskTitle;
    if (newConfig.branchGc != null) config.branchGc = resolveBranchGc(newConfig.branchGc);
    if (newConfig.github != null) config.github = newConfig.github;
    if (newConfig.lanes == null) delete config.lanes;
    if (newConfig.lanes != null) config.lanes = newConfig.lanes;
    if (newConfig.teamReview != null) config.teamReview = newConfig.teamReview;
    if (newConfig.benchmarks != null) config.benchmarks = newConfig.benchmarks;
    if (newConfig.coherence != null) config.coherence = newConfig.coherence;
    if (newConfig.issues != null) config.issues = newConfig.issues;
    if (newConfig.community != null) config.community = newConfig.community;
    if (newConfig.questionManager == null) delete config.questionManager;
    if (newConfig.questionManager != null) config.questionManager = newConfig.questionManager;
    if (newConfig.posthog != null) config.posthog = newConfig.posthog;
    if (newConfig.usage != null) config.usage = newConfig.usage;
    if (newConfig.telegram != null) config.telegram = newConfig.telegram;
    if (newConfig.telemetry != null) config.telemetry = newConfig.telemetry;
    if (newConfig.vault != null) config.vault = { ...config.vault, ...newConfig.vault };
    if (newConfig.workflows == null) delete config.workflows;
    if (newConfig.workflows != null) config.workflows = newConfig.workflows;
    if (newConfig.coder == null) delete config.coder;
    if (newConfig.coder != null) config.coder = newConfig.coder;
    config.customAgents = newConfig.customAgents ?? [];
    if (newConfig.hosts == null) delete config.hosts;
    if (newConfig.hosts != null) config.hosts = newConfig.hosts;
    if (newConfig.secrets == null) delete config.secrets;
    if (newConfig.secrets != null) config.secrets = newConfig.secrets;

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
