import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore } from '../server/config-store.ts';
import type { ConfigStore, DefaultConfig, GlimmervoidConfig } from '../server/config-store.ts';
import { createReplayLog } from '../server/core/control-replay-core.ts';
import type { ControlMessageRecord } from '../server/core/control-replay-core.ts';
import { sendStampedControlFrame } from '../server/control/control-seq.ts';
import { createPackData } from '../server/packs/pack-data.ts';
import { packsStatePath } from '../server/packs/pack-files.ts';
import { createPackSettings } from '../server/packs/pack-settings.ts';
import { createPackSources, EXAMPLES_SOURCE_SLUG } from '../server/packs/pack-sources.ts';
import { createPackStore } from '../server/packs/pack-store.ts';
import { settingsBlockSpecFor, validateSettingsBlock } from '../server/core/settings-block-core.ts';
import { configSecretsPath } from '../server/secrets/core/secret-files-core.ts';
import { buildSettingsPayload } from '../server/settings-payload.ts';
import { TeamReviewEnvironment } from '../shared/contracts/team-review-environment.ts';
import { currentTeamReviewEnvironment, onTeamReviewEnvironmentChanged, teamReviewScanSettled } from '../server/github/team-review-environment.ts';
import { cachedAgentResolvability, commandFor, resetCommandCache, setCustomAgents } from '../session/adapters/index.ts';
import { CustomAgentDeclaration } from '../shared/contracts/index.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';
import { decideAgentPicker } from '../public/session-card/agent-core.ts';

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
      settings.send({ type: 'update-settings', requestId: 'invalid-root', settings: { repoRoots: [root], debugMode: true } });
      assert.match(String(errorFrom(settings)?.message), /Repository roots must be existing directories/);
      assert.ok(String(errorFrom(settings)?.message).includes(root));
      assert.equal(updatedFrom(settings), undefined);
      assert.equal(settings.reloadCalls.length, 0);
      assert.deepEqual(store.config.repoRoots, []);
      assert.equal(store.config.debugMode, undefined);
      assert.deepEqual(readDisk(), previousConfig);
    }
  });
});

test('existing repository root directories persist, added roots merge into the stored list, and empty roots remain an explicit clearing action', () => {
  withRealStore({ projects: [], repoRoots: [] }, undefined, (settings, store, readDisk) => {
    const directory = path.dirname(store.configPath);
    settings.send({ type: 'update-settings', settings: { repoRoots: [directory] } });
    assert.equal(errorFrom(settings), undefined);
    assert.deepEqual(store.config.repoRoots, [directory]);
    assert.deepEqual(readDisk().repoRoots, [directory]);
    const addedRoot = path.dirname(directory);
    settings.send({ type: 'add-repo-roots', roots: [addedRoot, directory] });
    assert.equal(errorFrom(settings), undefined);
    assert.deepEqual(readDisk().repoRoots, [directory, addedRoot]);
    settings.send({ type: 'update-settings', settings: { repoRoots: [] } });
    assert.deepEqual(store.config.repoRoots, []);
    assert.deepEqual(readDisk().repoRoots, []);
  });
});

test('a pasted repository source that could inject git options or another transport is refused before git runs', async () => {
  const cloneRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-clone-refusal-')));
  try {
    const settings = harness({ projects: [], repoRoots: [cloneRoot] });
    const refusedSources = ['--upload-pack=touch /tmp/pwned', '-c core.sshCommand=x', 'ext::sh -c touch% /tmp/pwned', 'file:///etc', 'https://user:secret@github.com/owner/repo', 'https://github.com/owner/repo?x=1', 'git@github.com:-owner/repo', 'https://github.com/owner/..', 'https://evil.example/x/.git.git', 'git@evil.example:x/.ssh', 'owner/repo\n--depth=1', 'https://github.com/owner/repo\u0000'];
    for (const source of refusedSources) {
      settings.sent.length = 0;
      await settings.send({ type: 'start-repository-clones', requestId: 'refused', sources: [source] });
      const reply = settings.sent.find((message) => message.type === 'repository-clones');
      assert.deepEqual(blockOf(reply, 'jobs'), [], source);
      assert.match(String(blockOf(reply, 'error')), /is not a repository URL/, source);
    }
    assert.deepEqual(fs.readdirSync(cloneRoot), []);
  } finally {
    fs.rmSync(cloneRoot, { recursive: true, force: true });
  }
});

test('the folder browser completes child folders by prefix, hides dot folders until the prefix asks for them, and marks git checkouts', async () => {
  const workArea = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-list-folders-')));
  try {
    fs.mkdirSync(path.join(workArea, 'alpha', '.git'), { recursive: true });
    fs.mkdirSync(path.join(workArea, 'Alpine'));
    fs.mkdirSync(path.join(workArea, '.alcove'));
    fs.mkdirSync(path.join(workArea, 'beta'));
    fs.writeFileSync(path.join(workArea, 'almanac.txt'), 'not a folder', 'utf8');
    const settings = harness({ projects: [], repoRoots: [] });
    await settings.send({ type: 'list-folders', requestId: 'by-prefix', query: path.join(workArea, 'al') });
    const byPrefix = settings.sent.find((message) => message.type === 'folders-listed' && blockOf(message, 'requestId') === 'by-prefix');
    assert.deepEqual(blockOf(byPrefix, 'entries'), [
      { name: 'alpha', path: `${path.join(workArea, 'alpha')}${path.sep}`, isGit: true },
      { name: 'Alpine', path: `${path.join(workArea, 'Alpine')}${path.sep}`, isGit: false },
    ]);
    await settings.send({ type: 'list-folders', requestId: 'hidden', query: `${workArea}${path.sep}.` });
    const hidden = settings.sent.find((message) => message.type === 'folders-listed' && blockOf(message, 'requestId') === 'hidden');
    assert.deepEqual(blockOf(hidden, 'entries'), [{ name: '.alcove', path: `${path.join(workArea, '.alcove')}${path.sep}`, isGit: false }]);
  } finally {
    fs.rmSync(workArea, { recursive: true, force: true });
  }
});

test('a repository root that is itself a git checkout scans as one project instead of listing its folders', async () => {
  const checkoutRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-root-checkout-')));
  try {
    fs.mkdirSync(path.join(checkoutRoot, '.git'));
    fs.mkdirSync(path.join(checkoutRoot, 'src'));
    const settings = harness({ projects: [], repoRoots: [checkoutRoot] });
    await settings.send({ type: 'scan-repo-roots', requestId: 'root-checkout' });
    const scanned = settings.sent.find((message) => message.type === 'repo-roots-scanned');
    assert.deepEqual(blockOf(scanned, 'directories'), [{ root: checkoutRoot, projects: [{ name: path.basename(checkoutRoot), path: checkoutRoot }] }]);
  } finally {
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
  }
});

test('saving the default repository folder as a root creates it instead of refusing it as missing', () => {
  const defaultRoot = path.join(os.homedir(), 'glimmervoid');
  const hadDefaultRoot = fs.existsSync(defaultRoot);
  withRealStore({ projects: [], repoRoots: [] }, undefined, (settings, store) => {
    settings.send({ type: 'update-settings', settings: { repoRoots: [defaultRoot] } });
    assert.equal(errorFrom(settings), undefined);
    assert.deepEqual(store.config.repoRoots, [defaultRoot]);
    assert.ok(fs.statSync(defaultRoot).isDirectory());
  });
  if (!hadDefaultRoot) fs.rmdirSync(defaultRoot);
});

test('a Telegram payload persists and echoes with its secret redacted', () => {
  const settings = harness({ projects: [] });
  settings.send({ type: 'update-settings', settings: { telegram: { botToken: 'tok', chatId: '123' } } });
  assert.deepEqual(settings.cfg.telegram, { botToken: 'tok', chatId: '123' });
  assert.deepEqual(updatedFrom(settings)?.settings?.telegram, settings.store.getSettings().telegram);
});

test('dashboard saves branch deletion while a stale postTurnChecks block from an older config stays on disk untouched', () => {
  const branchGc = { prefixes: ['custom/'], dryRun: true, deleteUnmerged: false };
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
  const h = harness({ branchGc: { prefixes: ['custom/'], dryRun: true, deleteUnmerged: false }, projects: [] });
  h.send({ type: 'update-settings', settings: { branchGc: { deleteUnmerged: true, prefixes: ['evil/'] } } });

  assert.deepEqual(h.cfg.branchGc, { prefixes: ['custom/'], dryRun: true, deleteUnmerged: true });
});

test('a usage save carrying one nested leaf leaves every stored sibling and nested leaf as it was', () => {
  const stored = { enabled: true, retainDays: 30, extraProjectsDirs: ['/extra'], budget: { dailyUsd: 5, monthlyUsd: 100 } };
  const h = harness({ projects: [], usage: structuredClone(stored) });
  h.send({ type: 'update-settings', settings: { usage: { budget: { dailyUsd: 7 } } } });
  assert.equal(errorFrom(h), undefined);
  assert.deepEqual(h.cfg.usage, { ...stored, budget: { ...stored.budget, dailyUsd: 7 } });
});

test('a list value is one leaf: a saved list replaces the stored list whole and leaves its siblings alone', () => {
  const h = harness({ projects: [], posthog: { projects: [1, 2], enabled: false } });
  h.send({ type: 'update-settings', settings: { posthog: { projects: [3] } } });
  assert.equal(errorFrom(h), undefined);
  assert.deepEqual(h.cfg.posthog, { projects: [3], enabled: false });
});

test('an agent hidden in Settings drops out of the Add Session picker while the default agent stays offered', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { hiddenAgents: ['shell', 'claude-code'] } });
  assert.equal(errorFrom(h), undefined);
  h.sent.length = 0;
  h.send({ type: 'list-agents' });
  const listing = h.sent.find((message) => message.type === 'agents-listed');
  const listedAgents = blockOf(listing, 'agents');
  const installedAgents = (listedAgents as Array<{ id: string; resolvable: boolean }>).map((agent) => ({ ...agent, resolvable: true }));
  const offeredIds = decideAgentPicker(installedAgents).options.map((option) => option.id);
  assert.ok(!offeredIds.includes('shell'));
  assert.ok(offeredIds.includes('claude-code'));
  assert.ok(offeredIds.includes('codex'));
});

test('the block validator refuses by name a leaf the registry does not list', () => {
  assert.equal(validateSettingsBlock({ scanRoots: ['/'] }, settingsBlockSpecFor('usage')), 'usage.scanRoots is not settable from the dashboard');
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
  h.send({ type: 'update-settings', settings: { workflows: { enabled: false, maxConcurrentSessions: 3, rules: [{ id: 'one', enabled: true }] } } });
  const expected = { enabled: false, maxConcurrentSessions: 3, rules: [storedWorkflowRule('one', true), storedWorkflowRule('two', true)] };
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
    h.send({ type: 'update-settings', settings: { debugMode: true, workflows: { rules: [{ id: 'one', enabled: true }] } } });
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
    h.send({ type: 'update-settings', settings: { debugMode: true } });
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
    maxConcurrentInvestigations: 2,
    minUsersToInvestigate: 1,
    repoPath: '/repo/web',
    autoFix: false,
    trafficSpikeEnabled: true,
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
  h.send({ type: 'update-settings', settings: { debugMode: true, posthog: { enabled: 'yes' } } });
  assert.ok(errorFrom(h));
  assert.equal(h.cfg.debugMode, undefined, 'the save is atomic: nothing lands when validation fails');
});

function withRealStore(
  seed: Record<string, unknown>,
  storeOpts: { settingsDefaults?: Partial<DefaultConfig> } | undefined,
  fn: (h: SettingsHarness, store: ConfigStore, readDisk: () => Record<string, unknown>, configPath: string) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-ctl-settings-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(seed, null, 2), 'utf8');
  const prev = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  try {
    const store = createConfigStore(storeOpts);
    fn(harness(store.config, store), store, () => JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath);
  } finally {
    if (prev == null) delete process.env.GLIMMERVOID_CONFIG;
    if (prev != null) process.env.GLIMMERVOID_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an unrelated save never materializes an untouched launch default', () => {
  withRealStore({ projects: [] }, { settingsDefaults: { debugMode: true } }, (h, store, readDisk) => {
    h.send({ type: 'update-settings', settings: { debugMode: true, linkPreviews: false } });

    const onDisk = readDisk();
    assert.equal(onDisk.linkPreviews, false, 'the real change persists');
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

function storedSecret(configPath: string, secretKey: string): unknown {
  const secretsFile = JSON.parse(fs.readFileSync(configSecretsPath(configPath), 'utf8'));
  return blockOf(secretsFile.secrets, secretKey);
}

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

  withRealStore(stored, undefined, (h, store, readDisk, configPath) => {
    const firstPayload = store.getSettings();
    assert.equal(JSON.stringify(firstPayload).includes('stored-tok'), false, 'the connect snapshot carries no token');
    assert.equal(JSON.stringify(firstPayload).includes('phx_stored'), false, 'nor the api key');

    const original = view.hydrateFromSettings(telegramSection, firstPayload);
    const edited = view.hydrateFromSettings(telegramSection, firstPayload);
    edited['telegram.chatId'] = '456';
    const settings = view.collectDirtyBlocks(telegramSection, original, edited);
    assert.deepEqual(settings, { telegram: { chatId: '456' } }, 'the mask never leaves the browser');

    h.send({ type: 'update-settings', settings });

    assert.equal(storedSecret(configPath, 'telegram.botToken'), 'stored-tok', 'the stored token survives a chat-id save');
    assert.equal(blockOf(readDisk().telegram, 'chatId'), '456');
    assert.equal(blockOf(store.getSettings().telegram, 'botTokenConfigured'), true);

    const replaced = view.hydrateFromSettings(telegramSection, store.getSettings());
    replaced['telegram.botToken'] = 'fresh-tok';
    h.send({
      type: 'update-settings',
      settings: view.collectDirtyBlocks(telegramSection, original, replaced),
    });
    assert.equal(storedSecret(configPath, 'telegram.botToken'), 'fresh-tok', 'a pasted token still writes through');
  });
});

test('a settings payload build reads the resolution cache and spawns no PATH probe, and an agent installed after a probed miss resolves on its next lookup', () => {
  const warm = CustomAgentDeclaration.parse({ id: 'aider', label: 'Aider', command: 'aider' });
  const missing = CustomAgentDeclaration.parse({ id: 'ghostcode', label: 'GhostCode', command: 'ghostcode' });
  const unprobed = CustomAgentDeclaration.parse({ id: 'shadowcode', label: 'ShadowCode', command: 'node' });
  const shadowedByBuiltIn = CustomAgentDeclaration.parse({ id: 'gemini', label: 'My Gemini', command: 'my-gemini' });
  const realExecFileSync = childProcess.execFileSync;
  let probes = 0;
  childProcess.execFileSync = (): never => {
    probes += 1;
    throw new Error('a settings payload build must not probe PATH');
  };
  try {
    setCustomAgents([warm, missing, unprobed, shadowedByBuiltIn]);
    commandFor('aider', { platform: process.platform, execFile: () => '/usr/local/bin/aider\n' });
    commandFor('ghostcode', { platform: process.platform, execFile: () => '', pathExists: () => false });
    commandFor('gemini', { platform: process.platform, execFile: () => '/usr/local/bin/gemini\n' });
    probes = 0;
    const payload = buildSettingsPayload({
      configStore: { getSettings: () => ({}), config: { customAgents: [warm, missing, unprobed, shadowedByBuiltIn] } },
    });
    assert.equal(probes, 0, 'a settings payload build never probes PATH');
    assert.ok(TeamReviewEnvironment.safeParse(payload.teamReviewEnvironment).success, 'the team review environment matches its wire contract');
    assert.deepEqual(payload.customAgents, [
      { id: 'aider', label: 'Aider', command: 'aider', args: [], resolvable: true, isShadowedByBuiltIn: false },
      { id: 'ghostcode', label: 'GhostCode', command: 'ghostcode', args: [], resolvable: false, isShadowedByBuiltIn: false },
      { id: 'shadowcode', label: 'ShadowCode', command: 'node', args: [], resolvable: null, isShadowedByBuiltIn: false },
      { id: 'gemini', label: 'My Gemini', command: 'my-gemini', args: [], resolvable: null, isShadowedByBuiltIn: true },
    ]);
    const installedLater = commandFor('ghostcode', { platform: process.platform, execFile: () => '/usr/local/bin/ghostcode\n' });
    assert.equal(installedLater.path, '/usr/local/bin/ghostcode');
    assert.equal(cachedAgentResolvability('ghostcode').resolvable, true);
  } finally {
    childProcess.execFileSync = realExecFileSync;
    setCustomAgents([]);
    resetCommandCache();
  }
});

test('a repo root scan lists a link to a directory once at its real path, skips broken links and links to files, and reports each git directory mtime and whether HEAD has a commit on request, following the gitdir file of a worktree', async () => {
  const workArea = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-scan-links-')));
  try {
    const repoRoot = path.join(workArea, 'Projects');
    const linkedRepo = path.join(workArea, 'posthog');
    fs.mkdirSync(path.join(repoRoot, 'real-repo'), { recursive: true });
    fs.mkdirSync(linkedRepo);
    fs.writeFileSync(path.join(workArea, 'notes.txt'), 'not a repo', 'utf8');
    fs.symlinkSync(linkedRepo, path.join(repoRoot, 'posthog'));
    fs.symlinkSync(linkedRepo, path.join(repoRoot, 'posthog-again'));
    fs.symlinkSync(path.join(workArea, 'gone'), path.join(repoRoot, 'broken'));
    fs.symlinkSync(path.join(workArea, 'notes.txt'), path.join(repoRoot, 'notes'));
    const settings = harness({ projects: [], repoRoots: [repoRoot, workArea] });
    await settings.send({ type: 'scan-repo-roots', requestId: 'scan-links' });
    const scanned = settings.sent.find((message) => message.type === 'repo-roots-scanned');
    assert.deepEqual(blockOf(scanned, 'directories'), [
      { root: repoRoot, projects: [{ name: 'posthog', path: linkedRepo }, { name: 'real-repo', path: path.join(repoRoot, 'real-repo') }] },
      { root: workArea, projects: [{ name: 'Projects', path: repoRoot }] },
    ]);
    const lastCommitAt = new Date('2026-01-02T03:04:05Z');
    fs.mkdirSync(path.join(repoRoot, 'real-repo', '.git'));
    fs.utimesSync(path.join(repoRoot, 'real-repo', '.git'), lastCommitAt, lastCommitAt);
    const worktreeCommitAt = new Date('2026-02-03T04:05:06Z');
    const worktreeGitDir = path.join(repoRoot, 'real-repo', '.git', 'worktrees', 'feature');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'feature'));
    fs.writeFileSync(path.join(repoRoot, 'feature', '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
    fs.mkdirSync(path.join(repoRoot, 'real-repo', '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'real-repo', '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'real-repo', '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`, 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'real-repo', '.git', 'packed-refs'), `${'b'.repeat(40)} refs/heads/feature\n`, 'utf8');
    fs.writeFileSync(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature\n', 'utf8');
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');
    fs.mkdirSync(path.join(repoRoot, 'unborn', '.git'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'unborn', '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    fs.utimesSync(path.join(repoRoot, 'unborn', '.git'), lastCommitAt, lastCommitAt);
    fs.utimesSync(worktreeGitDir, worktreeCommitAt, worktreeCommitAt);
    fs.utimesSync(path.join(repoRoot, 'real-repo', '.git'), lastCommitAt, lastCommitAt);
    await settings.send({ type: 'scan-repo-roots', requestId: 'scan-activity', includeActivity: true });
    const scannedWithActivity = settings.sent.filter((message) => message.type === 'repo-roots-scanned').at(-1);
    assert.deepEqual(blockOf(scannedWithActivity, 'directories'), [
      { root: repoRoot, projects: [{ name: 'feature', path: path.join(repoRoot, 'feature'), isGit: true, hasCommits: true, lastActivityMs: worktreeCommitAt.getTime() }, { name: 'posthog', path: linkedRepo, isGit: false }, { name: 'real-repo', path: path.join(repoRoot, 'real-repo'), isGit: true, hasCommits: true, lastActivityMs: lastCommitAt.getTime() }, { name: 'unborn', path: path.join(repoRoot, 'unborn'), isGit: true, hasCommits: false, lastActivityMs: lastCommitAt.getTime() }] },
      { root: workArea, projects: [{ name: 'Projects', path: repoRoot, isGit: false }] },
    ]);
  } finally {
    fs.rmSync(workArea, { recursive: true, force: true });
  }
});

test('the team review environment announces its skill scan once it lands, so the dashboard need not poll for it', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-review-scan-'));
  try {
    const claudeHome = path.join(homeDir, '.claude');
    fs.mkdirSync(path.join(claudeHome, 'skills', 'reviewing'), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'skills', 'reviewing', 'SKILL.md'), '---\nname: reviewing\ndescription: Reviews a pull request.\n---\nBody.\n');
    await teamReviewScanSettled();
    const scanLanded = new Promise<void>((resolve) => {
      const stopListening = onTeamReviewEnvironmentChanged(() => { stopListening(); resolve(); });
    });
    currentTeamReviewEnvironment({ homeDir, env: { CLAUDE_CONFIG_DIR: claudeHome } });
    await scanLanded;
    const environment = currentTeamReviewEnvironment({ homeDir, env: { CLAUDE_CONFIG_DIR: claudeHome } });
    assert.deepEqual(environment.agents[0]?.skills.map((skill) => skill.name), ['reviewing']);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('mutating settings and hook handlers broadcast before replying with appliedSeq', () => {
  const replayLog = createReplayLog();
  const cfg: GlimmervoidConfig = { projects: [] };
  const store = testConfigStore(cfg);
  const sockets: Parameters<typeof sendStampedControlFrame>[0][] = [];
  const server = createControlServer(controlDeps(cfg, {
    configStore: store,
    controlReplayLog: replayLog,
    applySettingsReload: (fresh) => { store.applySettings(fresh); },
    broadcastControl: (message) => {
      const stamped = replayLog.stamp(message);
      const payload = JSON.stringify(stamped);
      for (const socket of sockets) sendStampedControlFrame(socket, payload, stamped.seq);
    },
  }));
  server.on('connection', (ws) => { sockets.push(ws); });
  const connection = connectControl<SettingsFrame & { seq?: number; appliedSeq?: number; requestId?: string | null; hook?: { id: string } }>(server);
  connection.sent.length = 0;

  connection.send({ type: 'update-settings', requestId: 'req-settings', settings: { debugMode: true } });
  const settingsBroadcastIndex = connection.sent.findIndex((frame) => frame.type === 'settings-updated' && frame.requestId === undefined);
  const settingsReplyIndex = connection.sent.findIndex((frame) => frame.type === 'settings-updated' && frame.requestId === 'req-settings');
  assert.ok(settingsBroadcastIndex >= 0 && settingsReplyIndex > settingsBroadcastIndex, 'settings-updated broadcast precedes reply');
  assert.ok(typeof connection.sent[settingsBroadcastIndex]?.seq === 'number');
  assert.ok(typeof connection.sent[settingsReplyIndex]?.appliedSeq === 'number');
  assert.ok(connection.sent[settingsReplyIndex].appliedSeq >= connection.sent[settingsBroadcastIndex].seq);

  connection.sent.length = 0;
  connection.send({
    type: 'save-hook',
    requestId: 'req-hook-save',
    hook: { name: 'lint', event: 'PostToolUse', matcher: 'Edit', type: 'command', command: 'npm run lint', enabled: true },
  });
  const hookSaveBroadcastIndex = connection.sent.findIndex((frame) => frame.type === 'hooks-updated');
  const hookSaveReplyIndex = connection.sent.findIndex((frame) => frame.type === 'save-hook-result' && frame.requestId === 'req-hook-save');
  assert.ok(hookSaveBroadcastIndex >= 0 && hookSaveReplyIndex > hookSaveBroadcastIndex, 'hooks-updated broadcast precedes save-hook-result');
  assert.ok(typeof connection.sent[hookSaveBroadcastIndex]?.seq === 'number');
  assert.ok(typeof connection.sent[hookSaveReplyIndex]?.appliedSeq === 'number');
  assert.ok(connection.sent[hookSaveReplyIndex].appliedSeq >= connection.sent[hookSaveBroadcastIndex].seq);
  const savedHookId = connection.sent[hookSaveReplyIndex]?.hook?.id;
  assert.ok(typeof savedHookId === 'string' && savedHookId.length > 0);

  connection.sent.length = 0;
  connection.send({ type: 'delete-hook', requestId: 'req-hook-delete', id: savedHookId });
  const hookDeleteBroadcastIndex = connection.sent.findIndex((frame) => frame.type === 'hooks-updated');
  const hookDeleteReplyIndex = connection.sent.findIndex((frame) => frame.type === 'delete-hook-result' && frame.requestId === 'req-hook-delete');
  assert.ok(hookDeleteBroadcastIndex >= 0 && hookDeleteReplyIndex > hookDeleteBroadcastIndex, 'hooks-updated broadcast precedes delete-hook-result');
  assert.ok(typeof connection.sent[hookDeleteBroadcastIndex]?.seq === 'number');
  assert.ok(typeof connection.sent[hookDeleteReplyIndex]?.appliedSeq === 'number');
  assert.ok(connection.sent[hookDeleteReplyIndex].appliedSeq >= connection.sent[hookDeleteBroadcastIndex].seq);
});

test('pack-data-set and pack-source-enable broadcast before replying with appliedSeq while signal pack handlers omit appliedSeq', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pack-control-')));
  const examplePacksDir = path.join(homeDir, 'examples');
  const demoPackDir = path.join(examplePacksDir, 'demo-pack');
  fs.mkdirSync(demoPackDir, { recursive: true });
  fs.writeFileSync(path.join(demoPackDir, 'pack.json'), JSON.stringify({
    name: 'demo-pack',
    version: 1,
    description: 'Demo pack',
    settings: [{ key: 'API_HOST', label: 'API host', kind: 'text' }],
  }));
  const replayLog = createReplayLog();
  const cfg: GlimmervoidConfig = { projects: [] };
  const store = testConfigStore(cfg);
  const sockets: Parameters<typeof sendStampedControlFrame>[0][] = [];
  const broadcastControl = (message: ControlMessageRecord) => {
    const stamped = replayLog.stamp(message);
    const payload = JSON.stringify(stamped);
    for (const socket of sockets) sendStampedControlFrame(socket, payload, stamped.seq);
  };
  const packStore = createPackStore({ homeDir, statePath: packsStatePath(homeDir), env: process.env, log: { warn: () => {} }, frameSecret: crypto.randomBytes(32) });
  let lastPacksFrameText = '';
  const broadcastPacksIfChanged = () => {
    const frame = packStore.statusFrame();
    const frameText = JSON.stringify(frame);
    if (frameText === lastPacksFrameText) return;
    lastPacksFrameText = frameText;
    broadcastControl(frame);
  };
  const packSources = createPackSources({
    homeDir,
    env: process.env,
    examplePacksDir,
    log: { warn: () => {} },
    packRows: () => packStore.statusFrame().packs,
    isApproved: (fingerprint) => packStore.isApproved(fingerprint),
    onChange: async () => {
      await packStore.rescanHomePacks();
      broadcastPacksIfChanged();
    },
  });
  packStore.setSourceRows(packSources.rows);
  packStore.on('changed', broadcastPacksIfChanged);
  const packData = createPackData({
    homeDir,
    panelPackDir: (packName) => (packName === 'demo-pack' ? demoPackDir : null),
    onWritten: (pack, storedPackData) => broadcastControl({ type: 'pack-data-changed', pack, data: storedPackData }),
  });
  const packSettings = createPackSettings({
    homeDir,
    vault: { source: () => null, read: async () => ({ failure: { kind: 'not-found', message: 'none', detail: '' } }), saveToAgeFile: async () => null },
    approvedPack: (packName) => packStore.packInUse(packName),
  });
  try {
    await packStore.start();
    await packSources.start();
    const server = createControlServer(controlDeps(cfg, {
      configStore: store,
      controlReplayLog: replayLog,
      broadcastControl,
      packs: packStore,
      packData,
      packSettings,
      packSources,
    }));
    server.on('connection', (ws) => { sockets.push(ws); });
    const connection = connectControl<SettingsFrame & { seq?: number; appliedSeq?: number; requestId?: string | null; ok?: boolean; packs?: { name: string }[]; data?: Record<string, unknown> }>(server);
    connection.sent.length = 0;

    await Promise.all([
      connection.send({ type: 'pack-data-set', requestId: 'data-1', pack: 'demo-pack', key: 'first', value: 1 }),
      connection.send({ type: 'pack-data-set', requestId: 'data-2', pack: 'demo-pack', key: 'second', value: 2 }),
    ]);
    const firstChangedIndex = connection.sent.findIndex((frame) => frame.type === 'pack-data-changed' && frame.data?.first === 1);
    const firstReplyIndex = connection.sent.findIndex((frame) => frame.type === 'pack-data-set-result' && frame.requestId === 'data-1');
    const secondChangedIndex = connection.sent.findIndex((frame) => frame.type === 'pack-data-changed' && frame.data?.second === 2);
    const secondReplyIndex = connection.sent.findIndex((frame) => frame.type === 'pack-data-set-result' && frame.requestId === 'data-2');
    assert.ok(firstChangedIndex >= 0 && firstReplyIndex > firstChangedIndex, 'first pack-data-changed precedes its pack-data-set-result');
    assert.ok(secondChangedIndex >= 0 && secondReplyIndex > secondChangedIndex, 'second pack-data-changed precedes its pack-data-set-result');
    assert.ok(typeof connection.sent[firstChangedIndex]?.seq === 'number' && typeof connection.sent[firstReplyIndex]?.appliedSeq === 'number');
    assert.ok(connection.sent[firstReplyIndex].appliedSeq >= connection.sent[firstChangedIndex].seq);
    assert.ok(typeof connection.sent[secondChangedIndex]?.seq === 'number' && typeof connection.sent[secondReplyIndex]?.appliedSeq === 'number');
    assert.ok(connection.sent[secondReplyIndex].appliedSeq >= connection.sent[secondChangedIndex].seq);

    connection.sent.length = 0;
    await connection.send({ type: 'pack-data-get', requestId: 'data-get', pack: 'demo-pack' });
    const dataGetReply = connection.sent.find((frame) => frame.type === 'pack-data-result' && frame.requestId === 'data-get');
    assert.equal(dataGetReply?.ok, true);
    assert.equal('appliedSeq' in (dataGetReply ?? {}), false);

    connection.sent.length = 0;
    await connection.send({ type: 'pack-source-enable', requestId: 'enable-1', slug: EXAMPLES_SOURCE_SLUG, pack: 'demo-pack', isEnabled: true });
    const statusBroadcastIndex = connection.sent.findIndex((frame) => frame.type === 'packs-status' && frame.packs?.some((row) => row.name === 'demo-pack'));
    const enableReplyIndex = connection.sent.findIndex((frame) => frame.type === 'pack-source-result' && frame.requestId === 'enable-1');
    assert.ok(statusBroadcastIndex >= 0 && enableReplyIndex > statusBroadcastIndex, 'packs-status with enabled pack precedes pack-source-result');
    assert.ok(typeof connection.sent[statusBroadcastIndex]?.seq === 'number' && typeof connection.sent[enableReplyIndex]?.appliedSeq === 'number');
    assert.ok(connection.sent[enableReplyIndex].appliedSeq >= connection.sent[statusBroadcastIndex].seq);

    connection.sent.length = 0;
    await connection.send({ type: 'pack-request-dismiss', requestId: 'dismiss-1', pack: 'demo-pack' });
    const dismissReply = connection.sent.find((frame) => frame.type === 'pack-request-dismiss-result' && frame.requestId === 'dismiss-1');
    assert.equal(dismissReply?.ok, true);
    assert.equal('appliedSeq' in (dismissReply ?? {}), false);

    const fingerprint = packStore.statusFrame().packs.find((row) => row.name === 'demo-pack')?.fingerprint;
    assert.ok(fingerprint);
    await connection.send({ type: 'pack-approve', requestId: 'approve-1', fingerprint });

    connection.sent.length = 0;
    await connection.send({ type: 'pack-settings-save', requestId: 'settings-save-1', pack: 'demo-pack', valuesByKey: { API_HOST: 'api.example' } });
    const settingsSaveReply = connection.sent.find((frame) => frame.type === 'pack-settings-result' && frame.requestId === 'settings-save-1');
    assert.equal(settingsSaveReply?.ok, true);
    assert.equal('appliedSeq' in (settingsSaveReply ?? {}), false);
  } finally {
    packSources.stop();
    packStore.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
