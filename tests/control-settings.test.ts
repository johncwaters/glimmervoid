import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore } from '../server/config-store.ts';
import type { ConfigStore, DefaultConfig, GlimmervoidConfig } from '../server/config-store.ts';
import type { ControlMessageRecord } from '../server/core/control-replay-core.ts';
import { buildSettingsPayload } from '../server/settings-payload.ts';
import { TeamReviewEnvironment } from '../shared/contracts/team-review-environment.ts';
import { commandFor, resetCommandCache, setCustomAgents } from '../session/adapters/index.ts';
import { CustomAgentDeclaration } from '../shared/contracts/index.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';

interface SettingsFrame {
  type: string;
  message?: string;
  settings?: Record<string, unknown>;
}

interface SettingsHarness {
  send(message: unknown): unknown;
  sent: SettingsFrame[];
  broadcasts: ControlMessageRecord[];
  reloadCalls: GlimmervoidConfig[];
  cfg: GlimmervoidConfig;
  store: ConfigStore;
}

function harness(cfg: GlimmervoidConfig, store: ConfigStore = testConfigStore(cfg)): SettingsHarness {
  const broadcasts: ControlMessageRecord[] = [];
  const reloadCalls: GlimmervoidConfig[] = [];
  const server = createControlServer(controlDeps(cfg, {
    configStore: store,
    applySettingsReload: (fresh) => { reloadCalls.push(fresh); store.applySettings(fresh); },
    broadcastControl: (message) => { broadcasts.push(message); },
  }));
  const connection = connectControl<SettingsFrame>(server);
  connection.sent.length = 0;
  return { send: connection.send, sent: connection.sent, broadcasts, reloadCalls, cfg, store };
}

function errorFrom(h: SettingsHarness): SettingsFrame | undefined {
  return h.sent.find((message) => message.type === 'settings-error');
}

function updatedFrom(h: SettingsHarness): SettingsFrame | undefined {
  return h.sent.find((message) => message.type === 'settings-updated');
}

function blockOf(value: unknown, key: string): unknown {
  assert.ok(value && typeof value === 'object', `expected an object to read ${key} from`);
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

test('repository root files and missing paths reject the whole save without changing disk or runtime', () => {
  withRealStore({ projects: [], repoRoots: [] }, undefined, (settings, store, readDisk) => {
    const previousConfig = readDisk();
    for (const root of [store.configPath, path.join(path.dirname(store.configPath), 'missing')]) {
      settings.sent.length = 0;
      settings.send({ type: 'update-settings', requestId: 'invalid-root', settings: { repoRoots: [root], cursorBlink: true } });
      assert.match(String(errorFrom(settings)?.message), /Repository roots must be existing directories/);
      assert.ok(String(errorFrom(settings)?.message).includes(root));
      assert.equal(updatedFrom(settings), undefined);
      assert.equal(settings.reloadCalls.length, 0);
      assert.deepEqual(store.config.repoRoots, []);
      assert.equal(store.config.cursorBlink, undefined);
      assert.deepEqual(readDisk(), previousConfig);
    }
  });
});

test('existing repository root directories persist and empty roots remain an explicit clearing action', () => {
  withRealStore({ projects: [], repoRoots: [] }, undefined, (settings, store, readDisk) => {
    const directory = path.dirname(store.configPath);
    settings.send({ type: 'update-settings', settings: { repoRoots: [directory] } });
    assert.equal(errorFrom(settings), undefined);
    assert.deepEqual(store.config.repoRoots, [directory]);
    assert.deepEqual(readDisk().repoRoots, [directory]);
    settings.send({ type: 'update-settings', settings: { repoRoots: [] } });
    assert.deepEqual(store.config.repoRoots, []);
    assert.deepEqual(readDisk().repoRoots, []);
  });
});

test('a Telegram payload persists and echoes with its secret redacted', () => {
  const settings = harness({ projects: [] });
  settings.send({ type: 'update-settings', settings: { telegram: { botToken: 'tok', chatId: '123' } } });
  assert.deepEqual(settings.cfg.telegram, { botToken: 'tok', chatId: '123' });
  assert.deepEqual(updatedFrom(settings)?.settings?.telegram, settings.store.getSettings().telegram);
});

test('dashboard saves branch deletion while a stale postTurnChecks block from an older config stays on disk untouched', () => {
  const branchGc = { enabled: true, prefixes: ['custom/'], dryRun: true, staleDays: 21, deleteUnmerged: false, intervalMs: 3600000 };
  const postTurnChecks = { enabled: true, mode: 'report', rules: { trailingWs: false, finalNewline: true } };
  withRealStore({ projects: [], branchGc, postTurnChecks }, undefined, (h, store, readDisk) => {
    h.send({ type: 'update-settings', settings: { branchGc: { deleteUnmerged: true } } });
    assert.equal(errorFrom(h), undefined);
    assert.deepEqual(readDisk().branchGc, { ...branchGc, deleteUnmerged: true });
    assert.deepEqual(readDisk().postTurnChecks, postTurnChecks);
    assert.equal(blockOf(store.getSettings().branchGc, 'deleteUnmerged'), true);
    assert.equal('postTurnChecks' in (updatedFrom(h)?.settings ?? {}), false);
  });
});

test('a branchGc control update keeps the stored file-only keys', () => {
  const h = harness({ branchGc: { enabled: true, prefixes: ['custom/'], dryRun: true, staleDays: 14, intervalMs: 3600000 }, projects: [] });
  h.send({ type: 'update-settings', settings: { branchGc: { staleDays: 21, prefixes: ['evil/'] } } });

  assert.deepEqual(h.cfg.branchGc, { enabled: true, prefixes: ['custom/'], dryRun: true, staleDays: 21, intervalMs: 3600000 });
});

test('a visions save carrying one leaf leaves every stored sibling and nested leaf as it was', () => {
  const stored = { enabled: true, autoFix: true, projects: ['p1'], dispatch: { enabled: false, model: 'opus', quietMs: 5000 }, intent: { threadTtlMs: 3600000 } };
  const h = harness({ projects: [], visions: structuredClone(stored) });
  h.send({ type: 'update-settings', settings: { visions: { dispatch: { enabled: true } } } });
  assert.equal(errorFrom(h), undefined);
  assert.deepEqual(h.cfg.visions, { ...stored, dispatch: { ...stored.dispatch, enabled: true } });
});

test('a list value is one leaf: a saved list replaces the stored list whole and leaves sibling lists alone', () => {
  const h = harness({ projects: [], guardrails: { unguardedRepos: ['/repo-a', '/repo-b'], blockedPaths: ['/secrets'] } });
  h.send({ type: 'update-settings', settings: { guardrails: { unguardedRepos: ['/repo-c'] } } });
  assert.equal(errorFrom(h), undefined);
  assert.deepEqual(h.cfg.guardrails, { unguardedRepos: ['/repo-c'], blockedPaths: ['/secrets'] });
});

test('a leaf the registry does not list is refused by name even where the schema lets the block pass through', () => {
  const h = harness({ projects: [], ingest: { enabled: true } });
  h.send({ type: 'update-settings', settings: { ingest: { sources: { fs: { roots: ['/'] } } } } });
  assert.match(String(errorFrom(h)?.message ?? ''), /ingest\.sources\.fs\.roots is not settable from the dashboard/);
  assert.deepEqual(h.cfg.ingest, { enabled: true });
});

test('an environment-supplied secret stays read-only through a dashboard save', () => {
  const previous = process.env.GLIMMERVOID_TELEGRAM_BOT_TOKEN;
  process.env.GLIMMERVOID_TELEGRAM_BOT_TOKEN = 'bot-from-env';
  try {
    withRealStore({ projects: [], telegram: { chatId: '123' } }, undefined, (h, store, readDisk) => {
      h.send({ type: 'update-settings', settings: { telegram: { botToken: 'typed-tok', chatId: '456' } } });
      assert.equal(errorFrom(h), undefined);
      assert.deepEqual(readDisk().telegram, { chatId: '456' }, 'the file never holds a token the environment supplies');
      assert.equal(blockOf(store.config.telegram, 'botToken'), 'bot-from-env', 'the environment value stays in force');
      const payload = store.getSettings();
      assert.deepEqual(payload.telegram, { chatId: '456', botTokenConfigured: true });
      assert.deepEqual(payload.secretSources, { 'telegram.botToken': 'GLIMMERVOID_TELEGRAM_BOT_TOKEN' });
      assert.equal(JSON.stringify(payload).includes('bot-from-env'), false);
    });
  } finally {
    if (previous == null) delete process.env.GLIMMERVOID_TELEGRAM_BOT_TOKEN;
    if (previous != null) process.env.GLIMMERVOID_TELEGRAM_BOT_TOKEN = previous;
  }
});

function storedWorkflowRule(id: string, enabled: boolean) {
  return { id, name: `Rule ${id}`, enabled, repos: ['Acme/app'], trigger: 'opened', actions: [{ type: 'spawn', promptTemplate: 'Look at {{url}}' }] };
}

test('workflow limits and rule toggles persist by rule id and leave every other rule field as the file has it', () => {
  const stored = { rules: [storedWorkflowRule('one', false), storedWorkflowRule('two', true)] };
  const h = harness({ projects: [], workflows: stored });
  h.send({ type: 'update-settings', settings: { workflows: { enabled: false, maxConcurrentSessions: 3, maxActionsPerPoll: 50, rules: [{ id: 'one', enabled: true }] } } });
  const expected = { enabled: false, maxConcurrentSessions: 3, maxActionsPerPoll: 50, rules: [storedWorkflowRule('one', true), storedWorkflowRule('two', true)] };
  assert.equal(errorFrom(h), undefined);
  assert.deepEqual(h.cfg.workflows, expected);
  assert.deepEqual(updatedFrom(h)?.settings?.workflows, expected);
});

test('a workflows rule toggle for a rule renamed on disk since the last load fails the whole save and stores nothing', () => {
  const stored = { rules: [storedWorkflowRule('one', false)] };
  withRealStore({ projects: [], workflows: stored }, undefined, (h, _store, readDisk) => {
    const configPath = process.env.GLIMMERVOID_CONFIG;
    assert.ok(configPath);
    const renamedOnDisk = { projects: [], workflows: { rules: [storedWorkflowRule('renamed', false)] } };
    fs.writeFileSync(configPath, JSON.stringify(renamedOnDisk, null, 2), 'utf8');
    h.send({ type: 'update-settings', settings: { cursorBlink: true, workflows: { rules: [{ id: 'one', enabled: true }] } } });
    assert.match(String(errorFrom(h)?.message ?? ''), /workflows.rules has no rule with id "one"/);
    assert.equal(updatedFrom(h), undefined);
    assert.deepEqual(readDisk(), renamedOnDisk);
  });
});

test('a save over an unreadable config file on disk replies settings-error', () => {
  withRealStore({ projects: [] }, undefined, (h) => {
    const configPath = process.env.GLIMMERVOID_CONFIG;
    assert.ok(configPath);
    fs.writeFileSync(configPath, '{ not json', 'utf8');
    h.send({ type: 'update-settings', settings: { cursorBlink: true } });
    assert.match(String(errorFrom(h)?.message ?? ''), /Settings were not saved/);
    assert.equal(updatedFrom(h), undefined);
  });
});

function posthogPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    host: 'https://us.posthog.com',
    apiKey: 'phx_secret',
    projects: [1, 2],
    intervalMinutes: 15,
    maxConcurrentInvestigations: 2,
    investigationTimeoutSeconds: 900,
    minUsersToInvestigate: 1,
    userEscalationThreshold: 25,
    repoPath: '/repo/web',
    autoFix: false,
    fixTimeoutSeconds: 1800,
    trafficSpikeEnabled: true,
    trafficSpikeMultiplier: 3,
    trafficSpikeMinUsers: 10,
    trafficSpikeCooldownMinutes: 360,
    trafficSpikeBaselineDays: 7,
    ...over,
  };
}

test('a valid posthog payload persists, echoes in settings-updated, and hot-applies', () => {
  const h = harness({ projects: [] });
  const payload = posthogPayload();

  h.send({ type: 'update-settings', settings: { posthog: payload } });

  assert.deepEqual(h.cfg.posthog, payload);
  const updated = updatedFrom(h);
  assert.ok(updated, 'replied settings-updated');
  assert.deepEqual(updated.settings?.posthog, h.store.getSettings().posthog, 'the echo is the redacted projection');
  assert.equal(h.reloadCalls.length, 1, 'applySettingsReload invoked once (hot-applies the poller)');
  assert.ok(h.broadcasts.some((m) => m.type === 'settings-updated'));
});

test('a rejected posthog block blocks the whole save, including unrelated keys', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { cursorBlink: true, posthog: { enabled: 'yes' } } });
  assert.ok(errorFrom(h));
  assert.equal(h.cfg.cursorBlink, undefined, 'the save is atomic: nothing lands when validation fails');
});

function withRealStore(
  seed: Record<string, unknown>,
  storeOpts: { settingsDefaults?: Partial<DefaultConfig> } | undefined,
  fn: (h: SettingsHarness, store: ConfigStore, readDisk: () => Record<string, unknown>) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-ctl-settings-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(seed, null, 2), 'utf8');
  const prev = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  try {
    const store = createConfigStore(storeOpts);
    fn(harness(store.config, store), store, () => JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } finally {
    if (prev == null) delete process.env.GLIMMERVOID_CONFIG;
    if (prev != null) process.env.GLIMMERVOID_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an unrelated save never materializes an untouched launch default', () => {
  withRealStore({ projects: [] }, { settingsDefaults: { debugMode: true } }, (h, store, readDisk) => {
    h.send({ type: 'update-settings', settings: { debugMode: true, cursorBlink: true } });

    const onDisk = readDisk();
    assert.equal(onDisk.cursorBlink, true, 'the real change persists');
    assert.equal('debugMode' in onDisk, false, 'the untouched launch default is not written to disk');
    assert.equal('debugMode' in store.config, false, 'nor into the in-memory config');
    assert.equal(store.getSettings().debugMode, true, 'the dev overlay still echoes true');
  });
});

test('flipping the checkbox away from the launch default persists it, and it wins from then on', () => {
  withRealStore({ projects: [] }, { settingsDefaults: { debugMode: true } }, (h, store, readDisk) => {
    h.send({ type: 'update-settings', settings: { debugMode: false } });
    assert.equal(readDisk().debugMode, false, 'an explicit choice is persisted');
    assert.equal(store.getSettings().debugMode, false, 'and beats the launch default in the echo');

    h.send({ type: 'update-settings', settings: { debugMode: true } });
    assert.equal(readDisk().debugMode, true);
    assert.equal(store.getSettings().debugMode, true);
  });
});

test('the browser round trip never sees a credential and never blanks one', async () => {
  const [{ SETTINGS_REGISTRY }, view] = await Promise.all([
    import('../shared/settings/registry.ts'),
    import('../public/settings/settings-view-core.ts'),
  ]);
  const telegramSection = SETTINGS_REGISTRY.sections.filter((section) => section.id === 'machine-telegram');
  const stored = {
    telegram: { botToken: 'stored-tok', chatId: '123' },
    posthog: { enabled: true, apiKey: 'phx_stored' },
    projects: [],
  };

  withRealStore(stored, undefined, (h, store, readDisk) => {
    const firstPayload = store.getSettings();
    assert.equal(JSON.stringify(firstPayload).includes('stored-tok'), false, 'the connect snapshot carries no token');
    assert.equal(JSON.stringify(firstPayload).includes('phx_stored'), false, 'nor the api key');

    const original = view.hydrateFromSettings(telegramSection, firstPayload);
    const edited = view.hydrateFromSettings(telegramSection, firstPayload);
    edited['telegram.chatId'] = '456';
    const settings = view.collectDirtyBlocks(telegramSection, original, edited);
    assert.deepEqual(settings, { telegram: { chatId: '456' } }, 'the mask never leaves the browser');

    h.send({ type: 'update-settings', settings });

    assert.equal(blockOf(readDisk().telegram, 'botToken'), 'stored-tok', 'the stored token survives a chat-id save');
    assert.equal(blockOf(readDisk().telegram, 'chatId'), '456');
    assert.equal(blockOf(store.getSettings().telegram, 'botTokenConfigured'), true);

    const replaced = view.hydrateFromSettings(telegramSection, store.getSettings());
    replaced['telegram.botToken'] = 'fresh-tok';
    h.send({
      type: 'update-settings',
      settings: view.collectDirtyBlocks(telegramSection, original, replaced),
    });
    assert.equal(blockOf(readDisk().telegram, 'botToken'), 'fresh-tok', 'a pasted token still writes through');
  });
});

test('a settings payload build reads the resolution cache and spawns no PATH probe', () => {
  const warm = CustomAgentDeclaration.parse({ id: 'opencode', label: 'OpenCode', command: 'opencode' });
  const missing = CustomAgentDeclaration.parse({ id: 'ghostcode', label: 'GhostCode', command: 'ghostcode' });
  const unprobed = CustomAgentDeclaration.parse({ id: 'shadowcode', label: 'ShadowCode', command: 'node' });
  const realExecFileSync = childProcess.execFileSync;
  let probes = 0;
  childProcess.execFileSync = (): never => {
    probes += 1;
    throw new Error('a settings payload build must not probe PATH');
  };
  try {
    setCustomAgents([warm, missing, unprobed]);
    commandFor('opencode', { platform: process.platform, execFile: () => '/usr/local/bin/opencode\n' });
    commandFor('ghostcode', { platform: process.platform, execFile: () => '', pathExists: () => false });
    probes = 0;
    const payload = buildSettingsPayload({
      configStore: { getSettings: () => ({}), config: { customAgents: [warm, missing, unprobed] } },
      resolveRtk: () => null,
    });
    assert.equal(probes, 0, 'a settings payload build never probes PATH');
    assert.ok(TeamReviewEnvironment.safeParse(payload.teamReviewEnvironment).success, 'the team review environment matches its wire contract');
    assert.deepEqual(payload.customAgents, [
      { id: 'opencode', label: 'OpenCode', command: 'opencode', args: [], resolvable: true },
      { id: 'ghostcode', label: 'GhostCode', command: 'ghostcode', args: [], resolvable: false },
      { id: 'shadowcode', label: 'ShadowCode', command: 'node', args: [], resolvable: null },
    ]);
  } finally {
    childProcess.execFileSync = realExecFileSync;
    setCustomAgents([]);
    resetCommandCache();
  }
});
