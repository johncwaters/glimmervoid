import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore, DEFAULT_CONFIG } from '../server/config-store.ts';
import {
  BRANCH_GC_CONTROL_BOOLEAN_KEYS, BRANCH_GC_CONTROL_NUMERIC_KEYS, BranchGcFileSettings,
  BrowserConfig, Config, CONFIG_BLOCK_KEYS, configIssueMessage, ConfigUpdate, HIDDEN_CONFIG_KEYS,
} from '../shared/contracts/index.ts';

test('DEFAULT_CONFIG satisfies the persisted Config contract', () => {
  assert.equal(Config.safeParse(DEFAULT_CONFIG).success, true);
  assert.equal(DEFAULT_CONFIG.integrationBranch, null);
  assert.equal(DEFAULT_CONFIG.updateChannel, 'release');
  assert.equal(Config.shape.integrationBranch.safeParse(null).success, true);
  assert.equal(DEFAULT_CONFIG.trace.enabled, true);
  assert.equal(DEFAULT_CONFIG.planReview.enabled, true);
});

test('trace.enabled is a boolean file-only setting with a default-on projection', () => {
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, trace: { enabled: false } }).success, true);
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, trace: { enabled: 'false' } }).success, false);
  assert.equal('trace' in ConfigUpdate.shape, false);
  assert.equal('trace' in BrowserConfig.shape, false);
});

test('planReview.enabled is a boolean file-only setting that defaults on', () => {
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, planReview: { enabled: false } }).success, true);
  const refused = Config.safeParse({ ...DEFAULT_CONFIG, planReview: { enabled: 'false' } });
  assert.equal(refused.success, false);
  assert.equal(refused.success === false && configIssueMessage(refused.error), 'planReview.enabled must be a boolean');
  assert.equal('planReview' in ConfigUpdate.shape, false);
  assert.equal('planReview' in BrowserConfig.shape, false);
});

test('agentApi.enabled is a boolean dashboard-writable setting that defaults off', () => {
  assert.equal(DEFAULT_CONFIG.agentApi.enabled, false);
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, agentApi: { enabled: true } }).success, true);
  const refused = Config.safeParse({ ...DEFAULT_CONFIG, agentApi: { enabled: 'true' } });
  assert.equal(refused.success, false);
  assert.equal(refused.success === false && configIssueMessage(refused.error), 'agentApi.enabled must be a boolean');
  assert.equal('agentApi' in ConfigUpdate.shape, true);
  assert.equal('agentApi' in BrowserConfig.shape, true);
});

test('the persisted config tolerates an unrecognized agentApi key the dashboard update refuses', () => {
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, agentApi: { enabled: true, token: 'x' } }).success, true);
  assert.equal(ConfigUpdate.safeParse({ agentApi: { enabled: true, token: 'x' } }).success, false);
  assert.equal(BrowserConfig.safeParse({ agentApi: { enabled: true, token: 'x' } }).success, false);
  assert.equal(CONFIG_BLOCK_KEYS.includes('agentApi'), true);
});

test('a settings update carries agentApi.enabled and nothing else inside the block', () => {
  const accepted = ConfigUpdate.safeParse({ agentApi: { enabled: true } });
  assert.equal(accepted.success, true);
  assert.deepEqual(accepted.success === true && accepted.data.agentApi, { enabled: true });
  assert.equal(ConfigUpdate.safeParse({ agentApi: { enabled: true, token: 'x' } }).success, false);
  assert.equal(ConfigUpdate.safeParse({ agentApi: { enabled: 'true' } }).success, false);
});

function withCustomAgents(customAgents: unknown) {
  return Config.safeParse({ ...DEFAULT_CONFIG, projects: [], customAgents });
}

test('a custom agent declaration round-trips through the persisted config with defaulted args', () => {
  const parsed = withCustomAgents([
    { id: 'opencode', label: 'OpenCode', command: 'opencode' },
    { id: 'gemini-cli', label: 'Gemini CLI', command: '/opt/gemini/bin/gemini', args: ['--yolo'], idleTitle: 'gemini', busyTitle: 'thinking' },
  ]);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.success === true && parsed.data.customAgents, [
    { id: 'opencode', label: 'OpenCode', command: 'opencode', args: [] },
    { id: 'gemini-cli', label: 'Gemini CLI', command: '/opt/gemini/bin/gemini', args: ['--yolo'], idleTitle: 'gemini', busyTitle: 'thinking' },
  ]);
  assert.equal('customAgents' in ConfigUpdate.shape, false);
  assert.equal('customAgents' in BrowserConfig.shape, false);
});

test('a malformed custom agent id fails closed rather than reaching the registry', () => {
  const refused = withCustomAgents([{ id: 'OpenCode', label: 'OpenCode', command: 'opencode' }]);
  assert.equal(refused.success, false);
  assert.equal(
    refused.success === false && configIssueMessage(refused.error),
    'customAgents[].id must be an agent id of 2 to 32 characters of lowercase letters, digits and dashes, starting with a letter',
  );
  assert.equal(withCustomAgents([{ id: 'a', label: 'A', command: 'a' }]).success, false);
  assert.equal(withCustomAgents([{ id: 'opencode', label: '', command: 'opencode' }]).success, false);
  assert.equal(withCustomAgents([{ id: 'opencode', label: 'O', command: 'o', extra: true }]).success, false);
  assert.equal(withCustomAgents('opencode').success, false);
});

test('a duplicate custom agent id fails closed, so no declaration order decides which one wins', () => {
  const refused = withCustomAgents([
    { id: 'opencode', label: 'One', command: 'one' },
    { id: 'opencode', label: 'Two', command: 'two' },
  ]);
  assert.equal(refused.success, false);
  assert.match(String(refused.success === false && configIssueMessage(refused.error)), /declared more than once/);
});

test('a custom agent id that collides with a builtin fails closed', () => {
  for (const id of ['claude-code', 'codex', 'grok']) {
    const refused = withCustomAgents([{ id, label: 'Impostor', command: 'impostor' }]);
    assert.equal(refused.success, false, id);
    assert.match(String(refused.success === false && configIssueMessage(refused.error)), /collides with the builtin agent/);
  }
});

test('a blank custom agent command fails closed rather than spawning nothing', () => {
  assert.equal(withCustomAgents([{ id: 'opencode', label: 'OpenCode', command: '' }]).success, false);
  const blank = withCustomAgents([{ id: 'opencode', label: 'OpenCode', command: '   ' }]);
  assert.equal(blank.success, false);
  assert.match(String(blank.success === false && configIssueMessage(blank.error)), /must not be blank/);
  const blankIssues = blank.success === false
    ? blank.error.issues.filter((issue) => /must not be blank/.test(issue.message)).map((issue) => issue.path.join('.'))
    : [];
  assert.deepEqual(blankIssues, ['customAgents.0.command']);
});

test('a project may name a declared custom agent', () => {
  const parsed = Config.safeParse({
    ...DEFAULT_CONFIG,
    customAgents: [{ id: 'opencode', label: 'OpenCode', command: 'opencode' }],
    projects: [{ path: '/repo', agent: 'opencode' }, { path: '/other', agent: 'codex' }],
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success === true && parsed.data.projects[0].agent, 'opencode');
  assert.equal(parsed.success === true && parsed.data.projects[1].agent, 'codex');
});

test('a project naming an undeclared agent fails closed rather than silently running claude-code', () => {
  const refused = Config.safeParse({
    ...DEFAULT_CONFIG,
    projects: [{ path: '/repo', agent: 'opencode' }],
  });
  assert.equal(refused.success, false);
  assert.equal(
    refused.success === false && configIssueMessage(refused.error),
    'projects[0].agent "opencode" names no known agent; declare it under customAgents or use one of claude-code, codex, grok',
  );
});

test('dropping a custom agent declaration refuses the config that still points a project at it', () => {
  const declared = { id: 'opencode', label: 'OpenCode', command: 'opencode' };
  const projects = [{ path: '/repo', agent: 'opencode' }];
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, customAgents: [declared], projects }).success, true);
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, customAgents: [], projects }).success, false);
});

test('updateChannel accepts release and main across config boundaries', () => {
  for (const updateChannel of ['release', 'main']) {
    assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, updateChannel }).success, true);
    assert.equal(BrowserConfig.safeParse({ updateChannel }).success, true);
    assert.equal(ConfigUpdate.safeParse({ updateChannel }).success, true);
  }
  assert.equal(ConfigUpdate.safeParse({ updateChannel: 'nightly' }).success, false);
});

test('mill measurement retention crosses file, browser, and update boundaries', () => {
  const millMetrics = { retainDays: 90 };
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, millMetrics }).success, true);
  assert.equal(BrowserConfig.safeParse({ millMetrics }).success, true);
  assert.equal(ConfigUpdate.safeParse({ millMetrics }).success, true);
  assert.equal(CONFIG_BLOCK_KEYS.includes('millMetrics'), true);
});

test('the persisted mill measurement block keeps its retention setting', () => {
  const config = { ...DEFAULT_CONFIG, millMetrics: { retainDays: 90 } };
  assert.deepEqual(Config.parse(config).millMetrics, { retainDays: 90 });
});

test('branchGc prefixes parse as string arrays and reject non-arrays', () => {
  assert.equal(BranchGcFileSettings.safeParse({ prefixes: ['glimmervoid/session/', 'worktree-agent-'] }).success, true);
  assert.equal(BranchGcFileSettings.safeParse({ prefixes: 'glimmervoid/session/' }).success, false);
});

test('branchGc worktrees is file-only and boolean', () => {
  assert.equal(BranchGcFileSettings.safeParse({ worktrees: false }).success, true);
  assert.equal(BranchGcFileSettings.safeParse({ worktrees: 'false' }).success, false);
  assert.deepEqual(ConfigUpdate.parse({ branchGc: { worktrees: false } }).branchGc, {});
});

test('a branchGc prefix that would select every origin branch fails closed', () => {
  const parsed = BranchGcFileSettings.safeParse({ prefixes: ['glimmervoid/session/', ''] });
  assert.equal(parsed.success, false);
  assert.equal(parsed.success === false && configIssueMessage(parsed.error), 'branchGc.prefixes entries must be non-empty strings');
});

test('a hand-edited branchGc field type never costs the boot', () => {
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, branchGc: { staleDays: '21' } }).success, true);
});

test('the branchGc control update keeps its literal key types', () => {
  const staleDays: number | undefined = ConfigUpdate.parse({ branchGc: { staleDays: 21 } }).branchGc?.staleDays;
  assert.equal(staleDays, 21);
});

test('the control update keeps exactly the exported settable branchGc keys', () => {
  const parsed = ConfigUpdate.parse({
    branchGc: { enabled: true, staleDays: 21, intervalMs: 3600000, prefixes: ['evil/'], dryRun: true },
  });
  assert.deepEqual(
    Object.keys(parsed.branchGc ?? {}).sort(),
    [...BRANCH_GC_CONTROL_BOOLEAN_KEYS, ...BRANCH_GC_CONTROL_NUMERIC_KEYS].sort(),
  );
});

test('any hooks value parses, so one hand edit cannot cost the boot', () => {
  const cases: unknown[] = [
    [{ id: 'x' }],
    [{ id: 'x', enabled: 'yes', timeout: 0, type: 'prompt' }],
    [{}],
    [null],
    ['x'],
    { Stop: [] },
    'nope',
  ];
  for (const hooks of cases) {
    assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, hooks }).success, true, JSON.stringify(hooks));
  }
});

test('hidden persisted config keys never enter the browser settings projection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-contract-config-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ ...DEFAULT_CONFIG, trace: {} }), 'utf8');
  const previousConfig = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  try {
    const settings = createConfigStore().getSettings();
    assert.deepEqual(HIDDEN_CONFIG_KEYS.filter((key) => Object.hasOwn(settings, key)), []);
    assert.deepEqual(settings.trace, { enabled: true });
  } finally {
    if (previousConfig == null) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfig != null) process.env.GLIMMERVOID_CONFIG = previousConfig;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a custom agent command that could reach a shell fails closed', () => {
  const injected = withCustomAgents([{ id: 'opencode', label: 'OpenCode', command: 'opencode; touch /tmp/pwned' }]);
  assert.equal(injected.success, false);
  assert.match(
    String(injected.success === false && configIssueMessage(injected.error)),
    /must be a bare command name or an absolute path/,
  );
  for (const command of ['opencode --yolo', 'open code', '$(id)', '`id`', 'opencode|tee /tmp/x', '../opencode', './opencode', '~/bin/opencode', '/opt/my agents/opencode']) {
    assert.equal(withCustomAgents([{ id: 'opencode', label: 'OpenCode', command }]).success, false, command);
  }
  for (const command of ['opencode', 'open-code', 'open_code.v2+beta', '/opt/agents/opencode', 'C:\\tools\\opencode.exe']) {
    assert.equal(withCustomAgents([{ id: 'opencode', label: 'OpenCode', command }]).success, true, command);
  }
});

test('dropping the customAgents key from config.json clears the overlay rather than leaving a deleted agent registered', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-custom-agents-'));
  const configPath = path.join(directory, 'config.json');
  const declared = [{ id: 'opencode', label: 'OpenCode', command: 'opencode', args: [] }];
  fs.writeFileSync(configPath, JSON.stringify({ ...DEFAULT_CONFIG, customAgents: declared }), 'utf8');
  const previousConfig = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  try {
    const store = createConfigStore();
    assert.deepEqual(store.config.customAgents, declared);
    store.applySettings({ ...DEFAULT_CONFIG, projects: [] });
    assert.deepEqual(store.config.customAgents, []);
  } finally {
    if (previousConfig == null) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfig != null) process.env.GLIMMERVOID_CONFIG = previousConfig;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
