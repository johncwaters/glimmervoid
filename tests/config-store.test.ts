import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createConfigStore, ensureProjectIds, validateConfig, loadConfigFile, DEFAULT_CONFIG,
  CONFIG_FILE_MODE, SECRET_PRESENCE_SUFFIX,
} from '../server/config-store.ts';
import type { ConfigStore, DefaultConfig, GlimmervoidConfig } from '../server/config-store.ts';
import { ENV_SECRET_BINDINGS } from '../server/core/config-secrets-core.ts';
import { settingsBlockSpecFor } from '../server/core/settings-block-core.ts';
import { getAdapter, setCustomAgents } from '../session/adapters/index.ts';
import { SETTINGS_REGISTRY } from '../shared/settings/registry.ts';
import { settingsOf } from '../shared/settings/registry-core.ts';
import { ConfigUpdate } from '../shared/contracts/index.ts';
import { SECRET_PRESENCE_SUFFIX as CLIENT_SECRET_PRESENCE_SUFFIX } from '../public/settings/settings-view-core.ts';
import { manualTimers } from './helpers/manual-timers.ts';
import { waitForFsWatchToArm } from './helpers/wait-for.ts';

type ConfigFileContent = Record<string, unknown>;
type StoreOptions = { settingsDefaults?: Partial<DefaultConfig>; isExperimentalBuild?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function block(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('the settings projection carries no block here');
  return value;
}

function readJson(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return block(parsed);
}

function writeTmpConfig(cfg: ConfigFileContent): { dir: string; p: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-cfgstore-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return { dir, p };
}

function richConfig(overrides: ConfigFileContent = {}): ConfigFileContent {
  return {
    port: 4123,
    notifyDebounceMs: 3,
    cursorBlink: false,
    repoRoots: ['/repo'],
    worktreeShare: ['node_modules'],
    remote: { port: 4124 },
    projects: [{ id: 'p1', name: 'proj', path: '/repo/proj' }],
    ...overrides,
  };
}

const SECRET_ENV_VARIABLE_NAMES = ENV_SECRET_BINDINGS.map((binding) => binding.environmentVariable);

function withSecretEnv<T>(values: Record<string, string>, fn: () => T): T {
  const previous = new Map(SECRET_ENV_VARIABLE_NAMES.map((name) => [name, process.env[name]]));
  for (const name of SECRET_ENV_VARIABLE_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  try {
    return fn();
  } finally {
    for (const name of SECRET_ENV_VARIABLE_NAMES) {
      const restored = previous.get(name);
      delete process.env[name];
      if (restored != null) process.env[name] = restored;
    }
  }
}

function withStore<T>(
  cfg: ConfigFileContent,
  fn: (store: ConfigStore, configPath: string) => T,
  storeOpts?: StoreOptions,
): T {
  const { dir, p } = writeTmpConfig(cfg);
  const prev = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = p;
  try {
    return fn(createConfigStore(storeOpts), p);
  } finally {
    if (prev == null) delete process.env.GLIMMERVOID_CONFIG;
    if (prev != null) process.env.GLIMMERVOID_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ensureProjectIds assigns ids only where missing and reports change', () => {
  const projects = [{ name: 'a', path: 'C:/a' }, { id: 'keep-me', name: 'b', path: 'C:/b' }];
  assert.equal(ensureProjectIds(projects), true, 'changed: one project lacked an id');
  assert.ok(projects[0].id, 'missing id assigned');
  assert.equal(projects[1].id, 'keep-me', 'existing id untouched');
  assert.equal(ensureProjectIds(projects), false, 'second pass is a no-op');
});

test('validateConfig accepts lenient partial configs and unknown keys', () => {
  assert.deepEqual(validateConfig({ projects: [], custom: { any: true } }), {
    ok: true,
    config: { projects: [], custom: { any: true } },
  });
  const lenient = {
    projects: [{ path: '/repo' }],
    port: 65535,
    notifyDebounceMs: 0,
    cursorBlink: true,
    worktree: { integrationBranch: 'develop', share: ['node_modules'] },
    repoRoots: ['/repo'],
    remote: {},
    unknownKey: 123,
  };
  assert.deepEqual(validateConfig(lenient), { ok: true, config: lenient });
});

test('config file compatibility keeps port zero and migrates replayBufferKB zero to its minimum', () => {
  withStore({ projects: [], port: 0, replayBufferKB: 0 }, (store) => {
    assert.equal(store.config.port, 0);
    assert.equal(store.config.replayBufferKB, 64);
  });
});

test('a legacy packReadTelemetry config key is ignored', () => {
  withStore({ projects: [], packReadTelemetry: false }, (store) => {
    assert.equal('packReadTelemetry' in store.getSettings(), false);
  });
});

test('a config carrying the retired mill and memory keys still loads, and a save keeps them on disk', () => {
  const retiredKeys = {
    millEnabled: false,
    packsAutoRebuild: false,
    packDistiller: { enabled: true, intervalHours: 24 },
    millMetrics: { retainDays: 90, holdoutPercent: 10 },
    memory: { enabled: true, retainDays: 365, distill: { enabled: true } },
  };
  withStore({
    projects: [{ id: 'p1', name: 'proj', path: '/repo/proj', packs: ['house-rules'] }],
    posthog: { enabled: false, packs: ['crew-rules'] },
    ...retiredKeys,
  }, (store, configPath) => {
    const settings = store.getSettings();
    for (const key of Object.keys(retiredKeys)) assert.equal(key in settings, false, key);
    assert.notEqual(store.save((cfg) => { cfg.port = 4125; }), null);
    const onDisk = readJson(configPath);
    for (const [key, value] of Object.entries(retiredKeys)) assert.deepEqual(onDisk[key], value, key);
    assert.deepEqual(block(onDisk.posthog).packs, ['crew-rules']);
  });
});

test('validateConfig rejects malformed known fields', () => {
  const validation = validateConfig({
    projects: [{ id: 7 }],
    port: 70000,
    notifyDebounceMs: Number.POSITIVE_INFINITY,
    cursorBlink: 'yes',
    worktree: { integrationBranch: 3, share: 'node_modules' },
    repoRoots: ['/repo', 5],
    remote: [],
  });
  assert.equal(validation.ok, false);
  const errors = validation.ok ? [] : validation.errors;
  assert.match(errors.join('\n'), /projects\[0\]\.path must be a string/);
  assert.match(errors.join('\n'), /port must be an integer/);
  assert.match(errors.join('\n'), /notifyDebounceMs must be a finite number/);
  assert.match(errors.join('\n'), /cursorBlink must be a boolean/);
  assert.match(errors.join('\n'), /worktree\.integrationBranch must be a string/);
  assert.match(errors.join('\n'), /repoRoots must be an array of strings/);
  assert.match(errors.join('\n'), /worktree\.share must be an array of strings/);
  assert.match(errors.join('\n'), /remote must be a plain object/);
  assert.equal(validateConfig(null).ok, false);
  assert.equal(validateConfig([]).ok, false);
});

test('validateConfig rejects a config missing the projects key entirely', () => {
  const validation = validateConfig({ port: 4123 });
  assert.equal(validation.ok, false);
  assert.match((validation.ok ? [] : validation.errors).join('\n'), /projects must be an array/);
});

test('a loaded config carries the contract defaults, so a bare custom agent declaration reaches the registry intact, and one shadowed by a built-in id survives a save', () => {
  const shadowedDeclaration = { id: 'gemini', label: 'My Gemini', command: 'my-gemini', args: [] };
  withStore(richConfig({ customAgents: [{ id: 'aider', label: 'Aider', command: 'aider' }, shadowedDeclaration] }), (store) => {
    assert.deepEqual(store.config.customAgents, [
      { id: 'aider', label: 'Aider', command: 'aider', args: [] },
      shadowedDeclaration,
    ]);
    try {
      assert.deepEqual(setCustomAgents(store.config.customAgents ?? []), ['gemini']);
      assert.deepEqual(getAdapter('aider')?.buildArgs(), []);
      assert.equal(getAdapter('gemini')?.label, 'Gemini CLI');
      assert.deepEqual(store.save(() => {})?.customAgents?.[1], shadowedDeclaration);
    } finally {
      setCustomAgents([]);
    }
  });
});

test('a dashboard save returns the validated config, so a contract default reaches the runtime without a restart', () => {
  withStore(richConfig(), (store) => {
    const saved = store.save((cfg) => {
      const draft: Record<string, unknown> = cfg;
      draft.customAgents = [{ id: 'aider', label: 'Aider', command: 'aider' }];
    });
    assert.deepEqual(saved?.customAgents, [
      { id: 'aider', label: 'Aider', command: 'aider', args: [] },
    ]);
  });
});

test('save refuses a corrupt fresh read and leaves the file as it is', () => {
  withStore(richConfig(), (store, p) => {
    fs.writeFileSync(p, '{ not json', 'utf8');
    assert.equal(store.save((cfg) => { cfg.port = 4124; }), null);
    assert.equal(fs.readFileSync(p, 'utf8'), '{ not json');
  });
});

test('createConfigStore persists auto-assigned ids, stable across reloads', () => {
  const { dir, p } = writeTmpConfig({ projects: [{ name: 'proj', path: 'C:/proj' }] });
  const prev = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = p;
  try {
    const first = createConfigStore();
    const id = first.config.projects[0].id;
    assert.ok(id, 'id assigned on first load');
    const onDiskProjects = readJson(p).projects;
    assert.ok(Array.isArray(onDiskProjects));
    assert.equal(block(onDiskProjects[0]).id, id, 'assigned id persisted to disk');
    const second = createConfigStore();
    assert.equal(second.config.projects[0].id, id, 'same id on reload (stable session identity)');
  } finally {
    if (prev == null) delete process.env.GLIMMERVOID_CONFIG;
    if (prev != null) process.env.GLIMMERVOID_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a config with guardrails.unreadablePaths boots with them moved to saneYoloUnreadablePaths on disk', () => {
  const { dir, p } = writeTmpConfig({ projects: [], guardrails: { blockedPaths: ['~/keep'], unreadablePaths: ['~/notes', 'relative/folder', '/srv/secrets'] } });
  const prev = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = p;
  try {
    const store = createConfigStore();
    assert.deepEqual(store.getSettings().saneYoloUnreadablePaths, ['~/notes', '/srv/secrets']);
    const onDisk = readJson(p);
    assert.deepEqual(onDisk.saneYoloUnreadablePaths, ['~/notes', '/srv/secrets']);
    assert.deepEqual(block(onDisk.guardrails), { blockedPaths: ['~/keep'] });
  } finally {
    if (prev == null) delete process.env.GLIMMERVOID_CONFIG;
    if (prev != null) process.env.GLIMMERVOID_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createConfigStore removes the retired boot and invalid config copies, which hold secrets', () => {
  const original = { projects: [{ name: 'proj', path: 'C:/proj' }] };
  const { dir, p } = writeTmpConfig(original);
  fs.writeFileSync(`${p}.boot.bak`, '{}', 'utf8');
  fs.writeFileSync(`${p}.invalid.bak`, '{ not json', 'utf8');
  const prev = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = p;
  try {
    createConfigStore();
    assert.equal(fs.existsSync(`${p}.boot.bak`), false);
    assert.equal(fs.existsSync(`${p}.invalid.bak`), false);
  } finally {
    if (prev == null) delete process.env.GLIMMERVOID_CONFIG;
    if (prev != null) process.env.GLIMMERVOID_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save is an atomic read-modify-write round-trip', () => {
  withStore({ projects: [] }, (store, p) => {
    const out = store.save((cfg) => { cfg.projects.push({ id: 'x1', name: 'x', path: 'C:/x' }); });
    assert.equal(out?.projects.length, 1, 'returns the mutated config');
    const onDiskProjects = readJson(p).projects;
    assert.ok(Array.isArray(onDiskProjects));
    assert.equal(block(onDiskProjects[0]).id, 'x1', 'mutation written to disk');
  });
});

test('save returns null when the config file is unreadable', () => {
  withStore({ projects: [] }, (store, p) => {
    fs.rmSync(p);
    assert.equal(store.save((cfg) => { cfg.projects = []; }), null);
  });
});

test('save refuses an invalid fresh read without writing', () => {
  withStore(richConfig(), (store, p) => {
    const invalidContent = JSON.stringify({ projects: [{ id: 'missing-path' }] }, null, 2);
    fs.writeFileSync(p, invalidContent, 'utf8');
    assert.equal(store.save((cfg) => { cfg.port = 4124; }), null);
    assert.equal(fs.readFileSync(p, 'utf8'), invalidContent);
  });
});

test('save refuses an invalid mutation result without writing', () => {
  withStore(richConfig(), (store, p) => {
    const before = fs.readFileSync(p, 'utf8');
    assert.equal(store.save((cfg) => { cfg.port = 70000; }), null);
    assert.equal(fs.readFileSync(p, 'utf8'), before);
  });
});

test('save refuses a suspected external wipe without laundering it', () => {
  withStore(richConfig(), (store, p) => {
    const wipedContent = JSON.stringify({ projects: [] }, null, 2);
    fs.writeFileSync(p, wipedContent, 'utf8');
    assert.equal(store.save((cfg) => { cfg.projects.push({ id: 'x', name: 'x', path: '/x' }); }), null);
    assert.equal(fs.readFileSync(p, 'utf8'), wipedContent);
  });
});

test('save writes a rolling backup before replacing changed config content', () => {
  withStore(richConfig(), (store, p) => {
    const before = readJson(p);
    const out = store.save((cfg) => { cfg.port = 4124; });
    assert.equal(out?.port, 4124);
    assert.deepEqual(readJson(`${p}.bak`), before);
    assert.equal(readJson(p).port, 4124);
  });
});

test('loadConfigFile returns the startup error for corrupt JSON when requested, naming the one backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-cfgstore-corrupt-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, '{ not json', 'utf8');
  try {
    const loaded = loadConfigFile(p, { exitOnError: false });
    if (!('error' in loaded)) throw new Error('corrupt JSON must report a startup error');
    assert.ok(loaded.error);
    assert.match(loaded.message, /Could not load/);
    assert.match(loaded.message, /config\.json\.bak/);
    assert.equal(fs.readFileSync(p, 'utf8'), '{ not json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stored watcher.url moves to remote.doormanUrl on load, and a doormanUrl already set wins', () => {
  withStore({ projects: [], watcher: { url: 'https://doorman.example' } }, (_store, configPath) => {
    const stored = readJson(configPath);
    assert.equal(Object.hasOwn(stored, 'watcher'), false);
    assert.equal(block(stored.remote).doormanUrl, 'https://doorman.example');
  });
  withStore({ projects: [], remote: { doormanUrl: 'https://kept.example' }, watcher: { url: 'https://dropped.example' } }, (_store, configPath) => {
    assert.equal(block(readJson(configPath).remote).doormanUrl, 'https://kept.example');
  });
});

test('flat worktree keys nest into the worktree block on load, and a worktree key already set wins', () => {
  const flatKeys = { worktreeRoot: '/wt', worktreeShare: ['.env'], integrationBranch: 'develop', worktreeAutoRebase: false, worktreeSyncOnStart: false, worktreeCloneDependencies: false, worktreeRerere: false };
  withStore({ projects: [], ...flatKeys, worktree: { root: '/kept' } }, (_store, configPath) => {
    const stored = readJson(configPath);
    assert.deepEqual(Object.keys(flatKeys).filter((key) => Object.hasOwn(stored, key)), []);
    assert.deepEqual(stored.worktree, { root: '/kept', share: ['.env'], integrationBranch: 'develop', autoRebase: false, syncOnStart: false, cloneDependencies: false, rerere: false });
  });
  withStore({ projects: [], worktreeAutoRebase: 'false', worktreeRoot: null }, (store) => {
    assert.equal(store.config.worktree?.autoRebase, true);
    assert.equal(store.config.worktree?.root, '');
  });
});

test('getSettings falls back to DEFAULT_CONFIG for absent keys', () => {
  withStore({ projects: [] }, (store) => {
    const s = store.getSettings();
    assert.equal(s.cursorBlink, DEFAULT_CONFIG.cursorBlink);
    assert.equal(s.detectBackgroundAgents, DEFAULT_CONFIG.detectBackgroundAgents);
    assert.deepEqual(s.worktree, DEFAULT_CONFIG.worktree);
  });
});

test('a config file naming the retired experimental update channel loses the key on load', () => {
  withStore({ projects: [], updateChannel: 'experimental' }, (store, configPath) => {
    assert.equal(Object.hasOwn(store.config, 'updateChannel'), false);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(configPath, 'utf8')), 'updateChannel'), false);
  });
});

test('a stable build reads experimental features as off and keeps their stored values and a retired conversationView key on save', () => {
  const stored = { projects: [], conversationView: true, remoteSessions: true, coherence: { enabled: true }, issues: { enabled: true } };
  withStore(stored, (store, configPath) => {
    assert.deepEqual(
      [store.config.remoteSessions, store.config.coherence?.enabled, store.config.issues?.enabled],
      [false, false, false],
    );
    const saved = store.save((config) => { config.debugMode = true; });
    assert.ok(saved);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(
      [onDisk.conversationView, onDisk.remoteSessions, onDisk.coherence.enabled, onDisk.issues.enabled, onDisk.debugMode],
      [true, true, true, true, true],
    );
  }, { isExperimentalBuild: false });
  withStore(stored, (store) => {
    assert.equal(store.config.coherence?.enabled, true);
  }, { isExperimentalBuild: true });
});

test('a stable build saves a config that sets no experimental feature', () => {
  withStore({ projects: [] }, (store) => {
    const saved = store.save((config) => { config.debugMode = true; });
    assert.equal(saved?.debugMode, true);
    assert.equal(store.config.issues?.enabled ?? false, false);
  }, { isExperimentalBuild: false });
});

test('settingsDefaults is never persisted and leaves other keys on DEFAULT_CONFIG', () => {
  withStore({ projects: [] }, (store, p) => {
    store.getSettings();
    assert.equal('debugMode' in readJson(p), false, 'a launch default writes nothing to config.json');
    assert.equal(store.getSettings().cursorBlink, DEFAULT_CONFIG.cursorBlink, 'unrelated keys are untouched');
  }, { settingsDefaults: { debugMode: true } });
});

test('getSettings redacts the telegram bot token and the PostHog api key to presence flags', () => {
  withStore({ projects: [] }, (store) => {
    store.config.telegram = { botToken: 'tok-secret', chatId: '123' };
    store.config.posthog = { enabled: true, host: 'https://us.posthog.com', apiKey: 'phx_secret', repoPath: '/repo' };
    const settings = store.getSettings();

    assert.equal(SECRET_PRESENCE_SUFFIX, CLIENT_SECRET_PRESENCE_SUFFIX, 'the wire convention the dashboard hydrates from');
    assert.equal(JSON.stringify(settings).includes('tok-secret'), false, 'no bot token anywhere in the payload');
    assert.equal(JSON.stringify(settings).includes('phx_secret'), false, 'no api key anywhere in the payload');
    assert.equal(Object.hasOwn(block(settings.telegram), 'botToken'), false);
    assert.equal(Object.hasOwn(block(settings.posthog), 'apiKey'), false);
    assert.equal(block(settings.telegram).botTokenConfigured, true);
    assert.equal(block(settings.posthog).apiKeyConfigured, true);
    assert.deepEqual(settings.telegram, { chatId: '123', botTokenConfigured: true });

    store.config.telegram = { botToken: '', chatId: '123' };
    store.config.posthog = { enabled: false };
    const cleared = store.getSettings();
    assert.equal(block(cleared.telegram).botTokenConfigured, false, 'an empty string is not a stored credential');
    assert.equal(block(cleared.posthog).apiKeyConfigured, false);
  });
});

test('a secret from the environment wins over the one stored in config.json', () => {
  withSecretEnv({ GLIMMERVOID_POSTHOG_API_KEY: 'phx-from-env', GLIMMERVOID_TELEGRAM_BOT_TOKEN: 'bot-from-env' }, () => {
    const stored = {
      projects: [],
      posthog: { enabled: true, apiKey: 'phx-from-file' },
      telegram: { botToken: 'bot-from-file', chatId: '123' },
    };
    withStore(stored, (store) => {
      assert.equal(block(store.config.posthog).apiKey, 'phx-from-env');
      assert.equal(block(store.config.telegram).botToken, 'bot-from-env');
      assert.equal(block(store.config.telegram).chatId, '123', 'the rest of the block is untouched');
    });
  });
});

test('a save leaves out every secret the environment provides', () => {
  withSecretEnv({ GLIMMERVOID_POSTHOG_API_KEY: 'phx-from-env' }, () => {
    const stored = { projects: [], posthog: { enabled: true, apiKey: 'phx-from-file' } };
    withStore(stored, (store, configPath) => {
      const saved = store.save((config) => {
        config.posthog = { ...block(config.posthog), enabled: false, apiKey: 'phx-from-dashboard' };
      });

      const written = readJson(configPath);
      assert.equal(Object.hasOwn(block(written.posthog), 'apiKey'), false, 'the file carries no api key');
      assert.equal(fs.readFileSync(configPath, 'utf8').includes('phx-'), false, 'no api key anywhere in the file');
      assert.equal(block(written.posthog).enabled, false, 'the rest of the block still persists');
      assert.equal(block(saved?.posthog).apiKey, 'phx-from-env', 'the environment still wins in memory');
    });
  });
});

function secretsFilePath(configPath: string): string {
  return path.join(path.dirname(configPath), 'secrets', 'config-secrets.json');
}

function storedSecretsAt(configPath: string): Record<string, unknown> {
  return block(readJson(secretsFilePath(configPath)).secrets);
}

test('secrets move out of config.json into the secrets file beside it and are saved, cleared and reloaded there', () => {
  withSecretEnv({ GLIMMERVOID_POSTHOG_API_KEY: 'phx-from-env' }, () => {
    const stored = { projects: [], posthog: { enabled: true, apiKey: 'phx-from-file' }, telegram: { botToken: 'bot-from-file', chatId: '123' } };
    withStore(stored, (store, configPath) => {
      assert.equal(fs.readFileSync(configPath, 'utf8').includes('-from-file'), false, 'boot leaves no secret in config.json');
      assert.deepEqual(storedSecretsAt(configPath), { 'posthog.apiKey': 'phx-from-file', 'telegram.botToken': 'bot-from-file' });
      if (process.platform !== 'win32') assert.equal(fs.statSync(secretsFilePath(configPath)).mode & 0o777, 0o600);
      assert.equal(block(store.config.telegram).botToken, 'bot-from-file', 'the moved token still loads');
      assert.equal(block(store.config.posthog).apiKey, 'phx-from-env', 'the environment still wins');

      store.save((config) => { config.telegram = { botToken: 'bot-from-dashboard', chatId: '123' }; });

      assert.equal(fs.readFileSync(configPath, 'utf8').includes('bot-from-dashboard'), false, 'a saved token never reaches config.json');
      assert.deepEqual(storedSecretsAt(configPath), { 'posthog.apiKey': 'phx-from-file', 'telegram.botToken': 'bot-from-dashboard' }, 'the environment value is never stored');
      assert.equal(block(createConfigStore().config.telegram).botToken, 'bot-from-dashboard', 'a restart reads it back');

      store.save((config) => { config.telegram = { chatId: '123' }; });

      assert.deepEqual(storedSecretsAt(configPath), { 'posthog.apiKey': 'phx-from-file' }, 'a cleared token leaves the secrets file');
    });
  });
});

test('a secrets file that cannot be written leaves config.json and its tokens as they were', () => {
  withSecretEnv({}, () => {
    withStore({ projects: [] }, (store, configPath) => {
      fs.writeFileSync(path.join(path.dirname(configPath), 'secrets'), 'not a folder');
      const contentBeforeSave = fs.readFileSync(configPath, 'utf8');

      const saved = store.save((config) => { config.telegram = { botToken: 'bot-from-dashboard', chatId: '123' }; });

      assert.equal(saved, null, 'the save is refused');
      assert.equal(fs.readFileSync(configPath, 'utf8'), contentBeforeSave);

      fs.writeFileSync(configPath, JSON.stringify({ projects: [], telegram: { botToken: 'bot-from-file', chatId: '123' } }));
      const restarted = createConfigStore();

      assert.equal(block(restarted.config.telegram).botToken, 'bot-from-file', 'the token still loads from config.json');
      assert.equal(block(readJson(configPath).telegram).botToken, 'bot-from-file', 'and stays there until it can be moved');
    });
  });
});

test('a token in config.json.bak or hand-written into config.json never survives in the backup', () => {
  withSecretEnv({}, () => {
    withStore({ projects: [] }, (store, configPath) => {
      fs.writeFileSync(`${configPath}.bak`, JSON.stringify({ projects: [], telegram: { botToken: 'bot-stale-in-backup', chatId: '123' } }));
      createConfigStore();

      assert.equal(fs.readFileSync(`${configPath}.bak`, 'utf8').includes('bot-stale-in-backup'), false, 'boot removes it from the backup');
      assert.equal(block(readJson(`${configPath}.bak`).telegram).chatId, '123', 'and keeps the rest of the backup');

      fs.writeFileSync(configPath, JSON.stringify({ projects: [], telegram: { botToken: 'bot-hand-written', chatId: '123' } }));
      store.save((config) => { config.cursorBlink = false; });

      assert.equal(fs.readFileSync(`${configPath}.bak`, 'utf8').includes('bot-hand-written'), false, 'a save backs up the file without it');
      assert.deepEqual(storedSecretsAt(configPath), { 'telegram.botToken': 'bot-hand-written' });
    });
  });
});

test('two config files in one folder keep their tokens in separate secrets files', () => {
  withSecretEnv({}, () => {
    withStore({ projects: [], telegram: { botToken: 'bot-first-config', chatId: '123' } }, (_store, configPath) => {
      const secondConfigPath = path.join(path.dirname(configPath), 'second.json');
      fs.writeFileSync(secondConfigPath, JSON.stringify({ projects: [], telegram: { botToken: 'bot-second-config', chatId: '456' } }));
      process.env.GLIMMERVOID_CONFIG = secondConfigPath;
      createConfigStore();
      process.env.GLIMMERVOID_CONFIG = configPath;

      assert.equal(block(createConfigStore().config.telegram).botToken, 'bot-first-config');
    });
  });
});

test('getSettings reports a secret the environment alone provides as configured', () => {
  withSecretEnv({ GLIMMERVOID_TELEGRAM_BOT_TOKEN: 'bot-from-env' }, () => {
    withStore({ projects: [], telegram: { chatId: '123' } }, (store) => {
      const settings = store.getSettings();

      assert.equal(block(settings.telegram).botTokenConfigured, true);
      assert.equal(JSON.stringify(settings).includes('bot-from-env'), false, 'the projection still redacts it');
    });
  });
});

test('getSettings exposes environment ownership for both credentials without sending their values', () => {
  withSecretEnv({ GLIMMERVOID_TELEGRAM_BOT_TOKEN: 'telegram-env-secret', GLIMMERVOID_POSTHOG_API_KEY: 'posthog-env-secret' }, () => {
    withStore({ projects: [] }, (store) => {
      const settings = store.getSettings();
      assert.deepEqual(settings.secretSources, {
        'telegram.botToken': 'GLIMMERVOID_TELEGRAM_BOT_TOKEN',
        'posthog.apiKey': 'GLIMMERVOID_POSTHOG_API_KEY',
      });
      assert.equal(JSON.stringify(settings).includes('telegram-env-secret'), false);
      assert.equal(JSON.stringify(settings).includes('posthog-env-secret'), false);
    });
  });
});

test('loading legacy fractional settings migrates counts without rejecting the file or discarding unknown keys', () => {
  withStore({
    projects: [], replayBufferKB: 512.5,
    posthog: { maxConcurrentInvestigations: 2.5, trafficSpikeBaselineDays: 7.5, intervalMinutes: 2.5, futureKey: 'kept' },
  }, (store) => {
    assert.equal(store.config.replayBufferKB, 512);
    assert.deepEqual(store.config.posthog, { maxConcurrentInvestigations: 3, trafficSpikeBaselineDays: 7, intervalMinutes: 2.5, futureKey: 'kept' });
  });
});

test('every block of the settings payload is picked through the registry spec, so an unlisted key never reaches the dashboard', () => {
  withStore({
    projects: [],
    teamReview: { enabled: true, org: 'PostHog', ignored: true },
    telemetry: { enabled: false, installId: 'install-1' },
    usage: { enabled: true, futureKey: 'kept-on-disk', budget: { dailyUsd: 5, secretLedger: 'x' } },
  }, (store) => {
    const settings = store.getSettings();
    assert.deepEqual(settings.teamReview, { enabled: true, org: 'PostHog' });
    assert.deepEqual(settings.telemetry, { enabled: false });
    assert.deepEqual(settings.usage, { enabled: true, budget: { dailyUsd: 5 } });
    assert.equal(block(store.config.usage).futureKey, 'kept-on-disk', 'the file keeps what the payload leaves out');
  }, { isExperimentalBuild: true });
});

test('a config.json still carrying the retired postTurnChecks block loads and leaves it out of the payload', () => {
  withStore({ projects: [], postTurnChecks: { enabled: false, mode: 'fix', rules: { bom: false } } }, (store) => {
    assert.equal('postTurnChecks' in store.getSettings(), false);
  });
});

test('the environment secret bindings shown in Settings and the password leaves of the registry are the same set, so each shows as configured and never as its value', () => {
  const settingsBindings = ENV_SECRET_BINDINGS.filter((binding) => !binding.isEnvironmentOnly);
  const boundPaths = settingsBindings.map((binding) => `${binding.blockName}.${binding.secretKey}`).sort();
  const passwordPaths = [...settingsOf(SETTINGS_REGISTRY.sections), ...SETTINGS_REGISTRY.fileOnly]
    .filter((setting) => setting.control === 'password')
    .map((setting) => setting.path)
    .sort();
  assert.deepEqual(passwordPaths, boundPaths);
  for (const binding of settingsBindings) {
    const leaf = settingsBlockSpecFor(binding.blockName).values?.[binding.secretKey];
    assert.equal(leaf?.control, 'password', `${binding.blockName}.${binding.secretKey}`);
  }
});

test('branchGc defaults survive a config save round trip', () => {
  withStore({ projects: [] }, (store, configPath) => {
    const saved = store.save((config) => { config.cursorBlink = true; });

    assert.equal(saved?.branchGc, undefined);
    assert.deepEqual(store.config.branchGc, DEFAULT_CONFIG.branchGc);
    assert.deepEqual(store.getSettings().branchGc, DEFAULT_CONFIG.branchGc);
    assert.equal(readJson(configPath).branchGc, undefined);
  });
});

const WATCH_DEADLINE_MS = 15000;
const READ_SETTLE_MS = 25;
const SIBLING_EVENT_SETTLE_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + WATCH_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`${message} (waited ${WATCH_DEADLINE_MS}ms)`);
}

async function withStoreAsync<T>(
  cfg: ConfigFileContent,
  fn: (store: ConfigStore, configPath: string) => Promise<T>,
): Promise<T> {
  const { dir, p } = writeTmpConfig(cfg);
  const prev = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = p;
  try {
    return await fn(createConfigStore(), p);
  } finally {
    if (prev == null) delete process.env.GLIMMERVOID_CONFIG;
    if (prev != null) process.env.GLIMMERVOID_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface WatchedStore {
  store: ConfigStore;
  configPath: string;
  reloads: GlimmervoidConfig[];
  pendingReloadTimerCount: () => number;
  readAfter: (change: () => void) => Promise<void>;
  reloadAfter: (change: () => void, message: string) => Promise<void>;
}

async function withWatchedStore(cfg: ConfigFileContent, fn: (watched: WatchedStore) => Promise<void>): Promise<void> {
  const { dir, p } = writeTmpConfig(cfg);
  const prev = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = p;
  const timers = manualTimers();
  const reloads: GlimmervoidConfig[] = [];
  const store = createConfigStore({ setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
  const stop = store.watchForChanges((reloaded) => { reloads.push(reloaded); });
  const fireReloadAfter = async (change: () => void) => {
    const timersBeforeChange = timers.pending.length;
    change();
    await waitFor(() => timers.pending.length > timersBeforeChange, 'the config.json change never reached the watcher');
    timers.fireAll();
  };
  try {
    await waitForFsWatchToArm();
    await fn({
      store,
      configPath: p,
      reloads,
      pendingReloadTimerCount: () => timers.pending.length,
      readAfter: async (change) => {
        await fireReloadAfter(change);
        await sleep(READ_SETTLE_MS);
      },
      reloadAfter: async (change, message) => {
        const reloadsBeforeChange = reloads.length;
        await fireReloadAfter(change);
        await waitFor(() => reloads.length > reloadsBeforeChange, message);
      },
    });
  } finally {
    stop();
    if (prev == null) delete process.env.GLIMMERVOID_CONFIG;
    if (prev != null) process.env.GLIMMERVOID_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('watchForChanges still sees a hand-edit after a save replaced the file inode', async () => {
  await withWatchedStore({ projects: [] }, async ({ store, configPath, reloads, readAfter, reloadAfter }) => {
    await readAfter(() => store.save((cfg) => { cfg.projects.push({ id: 'from-save', name: 's', path: 'C:/s' }); }));
    assert.equal(reloads.length, 0, 'a self-write does not reload');

    await reloadAfter(() => fs.writeFileSync(configPath, JSON.stringify({ projects: [{ id: 'hand-edit', name: 'h', path: 'C:/h' }] }, null, 2), 'utf8'), 'hand-edit after a save never reloaded');
    assert.equal(reloads[reloads.length - 1].projects[0].id, 'hand-edit', 'callback carries the edited content');
  });
});

test('watchForChanges rejects invalid and wiped config edits', async () => {
  await withWatchedStore(richConfig(), async ({ configPath, reloads, readAfter, reloadAfter }) => {
    await readAfter(() => fs.writeFileSync(configPath, JSON.stringify({ projects: [{ id: 'bad' }] }, null, 2), 'utf8'));
    assert.equal(reloads.length, 0, 'invalid config must not reload');

    await readAfter(() => fs.writeFileSync(configPath, JSON.stringify({ projects: [] }, null, 2), 'utf8'));
    assert.equal(reloads.length, 0, 'wiped config must not reload');

    await reloadAfter(() => fs.writeFileSync(configPath, JSON.stringify(richConfig({ port: 4124 }), null, 2), 'utf8'), 'valid config after rejected edits never reloaded');
    assert.equal(reloads[0].port, 4124);
  });
});

test('watchForChanges ignores directory events for other files', async () => {
  await withWatchedStore({ projects: [] }, async ({ configPath, reloads, pendingReloadTimerCount }) => {
    const reloadTimersBeforeSiblingWrites = pendingReloadTimerCount();
    fs.writeFileSync(`${configPath}.tmp.9999`, 'not the config', 'utf8');
    fs.writeFileSync(path.join(path.dirname(configPath), 'unrelated.json'), '{}', 'utf8');
    await sleep(SIBLING_EVENT_SETTLE_MS);
    assert.equal(pendingReloadTimerCount(), reloadTimersBeforeSiblingWrites, 'a sibling write schedules no reload');
    assert.equal(reloads.length, 0, 'a sibling write is not a config change');
  });
});

test('watchForChanges returns a closer that releases the fs.watch handle', () => {
  withStore({ projects: [] }, (store) => {
    const stop = store.watchForChanges(() => {});
    assert.equal(typeof stop, 'function', 'returns a closer');
    assert.doesNotThrow(stop);
    assert.doesNotThrow(stop, 'idempotent');
  });
});

test('a hand-edit landing immediately after a self-write is applied, not swallowed', async () => {
  await withWatchedStore({ projects: [] }, async ({ store, configPath, reloads, reloadAfter }) => {
    await reloadAfter(() => {
      store.save((cfg) => { cfg.projects.push({ id: 'from-save', name: 's', path: 'C:/s' }); });
      fs.writeFileSync(configPath, JSON.stringify({
        projects: [{ id: 'from-save', name: 's', path: 'C:/s' }], port: 4321,
      }, null, 2), 'utf8');
    }, 'the hand-edit was swallowed as a self-write');
    assert.equal(reloads[reloads.length - 1].port, 4321);
  });
});

test('a self-write is still suppressed, however many events it produces', async () => {
  await withWatchedStore({ projects: [] }, async ({ store, reloads, readAfter }) => {
    await readAfter(() => store.save((cfg) => { cfg.projects.push({ id: 'a', name: 'a', path: 'C:/a' }); }));
    await readAfter(() => store.save((cfg) => { cfg.projects.push({ id: 'b', name: 'b', path: 'C:/b' }); }));
    assert.deepEqual(reloads, [], 'a save must never reload its own write back through the settings path');
  });
});

test('reverting a hand-edit back to previously written bytes still reloads', async () => {
  await withWatchedStore({ projects: [] }, async ({ store, configPath, reloads, readAfter, reloadAfter }) => {
    await readAfter(() => store.save((cfg) => { cfg.projects.push({ id: 'from-save', name: 's', path: 'C:/s' }); }));
    assert.equal(reloads.length, 0, 'the save itself is suppressed');
    const written = fs.readFileSync(configPath, 'utf8');

    await reloadAfter(() => fs.writeFileSync(configPath, JSON.stringify({
      projects: [{ id: 'from-save', name: 's', path: 'C:/s' }], port: 4321,
    }, null, 2), 'utf8'), 'the hand-edit never reloaded');

    await reloadAfter(() => fs.writeFileSync(configPath, written, 'utf8'), 'the revert was swallowed as a stale self-write');
    assert.equal(reloads[reloads.length - 1].port, undefined, 'the reverted content is what was applied');
  });
});

test('a duplicate event for content already applied is not re-applied', async () => {
  await withWatchedStore({ projects: [] }, async ({ configPath, reloads, readAfter, reloadAfter }) => {
    const edited = JSON.stringify({ projects: [{ id: 'hand', name: 'h', path: 'C:/h' }] }, null, 2);
    await reloadAfter(() => fs.writeFileSync(configPath, edited, 'utf8'), 'the hand-edit never reloaded');

    await readAfter(() => fs.writeFileSync(configPath, edited, 'utf8'));
    assert.equal(reloads.length, 1);
  });
});

test('phoneEscalationMs is a settable timeout key with the five-minute default', async () => {
  assert.equal('phoneEscalationMs' in ConfigUpdate.shape, true);
  assert.equal(DEFAULT_CONFIG.phoneEscalationMs, 300000);

  await withStoreAsync({ projects: [] }, async (store) => {
    assert.equal(store.getSettings().phoneEscalationMs, 300000, 'an absent key reports the default');
    store.applySettings({ projects: [], phoneEscalationMs: 0 });
    assert.equal(store.config.phoneEscalationMs, 0, 'and zero, which switches the rung off, survives');
  });
});

test('reverting to bytes that were applied before a save still reloads', async () => {
  await withWatchedStore({ projects: [] }, async ({ store, configPath, reloads, readAfter, reloadAfter }) => {
    const handEdited = JSON.stringify({
      projects: [{ id: 'hand', name: 'h', path: 'C:/h' }], port: 4100,
    }, null, 2);
    await reloadAfter(() => fs.writeFileSync(configPath, handEdited, 'utf8'), 'the hand-edit never reloaded');

    await readAfter(() => store.save((cfg) => { cfg.port = 4200; }));
    assert.equal(reloads.length, 1, 'the save itself is still suppressed');

    await reloadAfter(() => fs.writeFileSync(configPath, handEdited, 'utf8'), 'the revert was swallowed as a stale applied-signature');
    assert.equal(reloads[reloads.length - 1].port, 4100, 'the reverted content is what was applied');
  });
});

test('a saved config.json, and its backup, are owner-only', { skip: process.platform === 'win32' }, async () => {
  await withStoreAsync(richConfig(), async (store, p) => {
    fs.chmodSync(p, 0o644);
    assert.ok(store.save((cfg) => { cfg.port = 4999; }), 'the save succeeded');

    assert.equal(fs.statSync(p).mode & 0o777, CONFIG_FILE_MODE, 'the save repairs a world-readable config');
    assert.equal(fs.statSync(`${p}.bak`).mode & 0o777, CONFIG_FILE_MODE, 'the backup carries the same bytes, so the same mode');
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).port, 4999, 'and the content still landed');
  });
});

test('async config saves serialize resume and title changes without synchronous reads or writes', async () => {
  const { dir, p: configPath } = writeTmpConfig(richConfig());
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  const originalReadFileSync = fs.readFileSync;
  const originalWriteFileSync = fs.writeFileSync;
  let synchronousCalls = 0;
  try {
    const store = createConfigStore();
    const rejectSynchronousCall = () => { synchronousCalls++; throw new Error('Unexpected synchronous filesystem call'); };
    fs.readFileSync = rejectSynchronousCall;
    fs.writeFileSync = rejectSynchronousCall;
    const saves = [
      store.saveAsync((config) => { config.projects[0].resumeSessionId = 'conversation'; }),
      store.saveAsync((config) => { config.projects[0].wasActive = true; }),
      store.saveAsync((config) => { config.projects[0].taskTitleState = { taskTitle: 'Newest task', isCustom: false, sources: { refinedTitle: 'Newest task' } }; }),
    ];
    assert.ok((await Promise.all(saves)).every(Boolean));
    await store.idle();
    const persistedConfig = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    assert.equal(persistedConfig.projects[0].resumeSessionId, 'conversation');
    assert.equal(persistedConfig.projects[0].wasActive, true);
    assert.equal(persistedConfig.projects[0].taskTitleState.taskTitle, 'Newest task');
    assert.equal(synchronousCalls, 0);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('a session removed by a synchronous save while an async save is in flight stays removed through a later synchronous save', async () => {
  const { dir, p: configPath } = writeTmpConfig(richConfig({ projects: [{ id: 'p1', name: 'proj', path: '/repo/proj' }, { id: 'removed', name: 'gone', path: '/repo/gone' }] }));
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  const originalWriteFile = fs.promises.writeFile;
  const stagedConfigPrefix = `${configPath}.${process.pid}.`;
  const stagedBackupPrefix = `${configPath}.bak.${process.pid}.`;
  let hasRemovedSession = false;
  let hasSavedSettingsAfterRemoval = false;
  try {
    const store = createConfigStore();
    fs.promises.writeFile = async (...writeArguments: Parameters<typeof originalWriteFile>) => {
      const writtenPath = String(writeArguments[0]);
      if (writtenPath.startsWith(stagedConfigPrefix) && !hasRemovedSession) {
        hasRemovedSession = true;
        assert.ok(store.save((config) => { config.projects = config.projects.filter((project) => project.id !== 'removed'); config.projects[0].name = 'Renamed project'; }));
      }
      if (writtenPath.startsWith(stagedBackupPrefix) && hasRemovedSession && !hasSavedSettingsAfterRemoval) {
        hasSavedSettingsAfterRemoval = true;
        assert.ok(store.save((config) => { config.cursorBlink = true; }));
      }
      await originalWriteFile(...writeArguments);
    };
    assert.ok(await store.saveAsync((config) => { config.projects[0].resumeSessionId = 'conversation'; }));
    const persistedConfig = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    assert.equal(hasSavedSettingsAfterRemoval, true);
    assert.deepEqual(persistedConfig.projects.map((project: { id: string }) => project.id), ['p1']);
    assert.equal(persistedConfig.cursorBlink, true);
    assert.equal(persistedConfig.projects[0].name, 'Renamed project');
    assert.equal(persistedConfig.projects[0].resumeSessionId, 'conversation');
  } finally {
    fs.promises.writeFile = originalWriteFile;
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('an async save refuses invalid config, then accepts a repaired file without poisoning the queue', async () => {
  const { dir, p: configPath } = writeTmpConfig(richConfig());
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  try {
    const store = createConfigStore();
    await fs.promises.writeFile(configPath, '{broken');
    assert.equal(await store.saveAsync((config) => { config.projects[0].wasActive = true; }), null);
    assert.equal(await fs.promises.readFile(configPath, 'utf8'), '{broken');
    await fs.promises.writeFile(configPath, JSON.stringify(richConfig()));
    assert.ok(await store.saveAsync((config) => { config.projects[0].wasActive = true; }));
    assert.equal(JSON.parse(await fs.promises.readFile(configPath, 'utf8')).projects[0].wasActive, true);
  } finally {
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
