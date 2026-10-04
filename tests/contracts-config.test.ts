import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore, DEFAULT_CONFIG } from '../server/config-store.ts';
import {
  BRANCH_GC_CONTROL_BOOLEAN_KEYS, BRANCH_GC_CONTROL_NUMERIC_KEYS, BranchGcFileSettings,
  BrowserConfig, Config, CONFIG_BLOCK_KEYS, configIssueMessage, ConfigUpdate, HIDDEN_CONFIG_KEYS, ProjectConfig,
} from '../shared/contracts/index.ts';

test('DEFAULT_CONFIG satisfies the persisted Config contract', () => {
  assert.equal(Config.safeParse(DEFAULT_CONFIG).success, true);
  assert.equal(DEFAULT_CONFIG.integrationBranch, null);
  assert.equal(DEFAULT_CONFIG.updateChannel, 'release');
  assert.equal(Config.shape.integrationBranch.safeParse(null).success, true);
  assert.equal(DEFAULT_CONFIG.trace.enabled, true);
  assert.equal(DEFAULT_CONFIG.planReview.enabled, true);
  assert.deepEqual(DEFAULT_CONFIG.changeMap.narrator, { enabled: false, engine: 'claude', model: '', timeoutSeconds: 90 });
});

test('calmLayout crosses persisted, browser and update contracts as an optional boolean', () => {
  for (const contract of [Config, BrowserConfig, ConfigUpdate]) {
    const requiredSettings = contract === Config ? { projects: [] } : {};
    assert.equal(contract.safeParse(requiredSettings).success, true);
    for (const calmLayout of [true, false]) {
      assert.equal(contract.parse({ ...requiredSettings, calmLayout }).calmLayout, calmLayout);
    }
    for (const calmLayout of ['true', 1, null]) {
      assert.equal(contract.safeParse({ ...requiredSettings, calmLayout }).success, false);
    }
  }
});

test('change map narrator settings cross persisted, browser, and update contracts', () => {
  const changeMap = { narrator: { enabled: true, model: 'sonnet', timeoutSeconds: 15 } };
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, changeMap }).success, true);
  assert.equal(BrowserConfig.safeParse({ changeMap }).success, true);
  assert.equal(ConfigUpdate.safeParse({ changeMap }).success, true);
  assert.equal(CONFIG_BLOCK_KEYS.includes('changeMap'), true);
  for (const timeoutSeconds of [14, 601, 15.5]) {
    assert.equal(ConfigUpdate.safeParse({ changeMap: { narrator: { timeoutSeconds } } }).success, false);
    assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, changeMap: { narrator: { timeoutSeconds } } }).success, false);
  }
  assert.equal(ConfigUpdate.safeParse({ changeMap: { narrator: { enabled: 'true' } } }).success, false);
  for (const engine of ['claude', 'codex']) {
    const narrator = { enabled: true, engine };
    assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, changeMap: { narrator } }).success, true);
    assert.equal(BrowserConfig.safeParse({ changeMap: { narrator } }).success, true);
    assert.equal(ConfigUpdate.safeParse({ changeMap: { narrator } }).success, true);
  }
  for (const engine of ['grok', '', 1, null]) {
    const changeMap = { narrator: { engine } };
    assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, changeMap }).success, false);
    assert.equal(BrowserConfig.safeParse({ changeMap }).success, false);
    const refused = ConfigUpdate.safeParse({ changeMap });
    assert.equal(refused.success, false);
    assert.equal(refused.success === false && configIssueMessage(refused.error), 'changeMap.narrator.engine must be one of claude, codex');
  }
});

test('benchmark settings cross persisted, browser, and update contracts', () => {
  const benchmarks = { enabled: true };
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, benchmarks }).success, true);
  assert.equal(BrowserConfig.safeParse({ benchmarks }).success, true);
  assert.equal(ConfigUpdate.safeParse({ benchmarks }).success, true);
  assert.equal(CONFIG_BLOCK_KEYS.includes('benchmarks'), true);
  assert.equal(ConfigUpdate.safeParse({ benchmarks: { enabled: 'yes' } }).success, false);
  assert.equal(ConfigUpdate.safeParse({ benchmarks: [] }).success, false);
});

test('team review settings cross persisted, browser, and update contracts', () => {
  const teamReview = { enabled: true, org: 'PostHog', team: 'product-engineering', reReviewAfterHours: 24, skipIdleAfterDays: 14, skill: 'my-review' };
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, teamReview }).success, true);
  assert.equal(BrowserConfig.safeParse({ teamReview }).success, true);
  assert.equal(ConfigUpdate.safeParse({ teamReview }).success, true);
  assert.equal(CONFIG_BLOCK_KEYS.includes('teamReview'), true);
  for (const invalid of [
    { enabled: 'true' },
    { org: 42 },
    { team: 42 },
    { skill: 42 },
    { reReviewAfterHours: 0 },
    { reReviewAfterHours: -1 },
    { skipIdleAfterDays: 0 },
    { skipIdleAfterDays: -1 },
  ]) {
    assert.equal(BrowserConfig.safeParse({ teamReview: invalid }).success, false);
    assert.equal(ConfigUpdate.safeParse({ teamReview: invalid }).success, false);
  }
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, teamReview: { enabled: 'true' } }).success, true);
});

test('browser and update contracts trim usage directories and require absolute paths', () => {
  const absoluteDirectory = path.resolve('project');
  for (const contract of [BrowserConfig, ConfigUpdate]) {
    const parsed = contract.parse({ usage: { extraProjectsDirs: [`  ${absoluteDirectory}  `] } });
    assert.deepEqual(parsed.usage?.extraProjectsDirs, [absoluteDirectory]);
    for (const directory of ['project', './project', '  ']) {
      assert.equal(contract.safeParse({ usage: { extraProjectsDirs: [directory] } }).success, false);
    }
  }
});

test('workspace projects require at least two repository paths', () => {
  const project = { id: 'workspace', name: 'Workspace', path: '/worktrees/ws-workspace', repos: ['/repos/one', '/repos/two'] };
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, projects: [project] }).success, true);
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, projects: [{ ...project, repos: ['/repos/one'] }] }).success, false);
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

test('telemetry.enabled is a boolean dashboard-writable setting that defaults on', () => {
  assert.equal(DEFAULT_CONFIG.telemetry.enabled, true);
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, telemetry: { enabled: false } }).success, true);
  const refused = ConfigUpdate.safeParse({ telemetry: { enabled: 'false' } });
  assert.equal(refused.success === false && configIssueMessage(refused.error), 'telemetry.enabled must be a boolean');
  assert.equal(ConfigUpdate.safeParse({ telemetry: { enabled: false, installId: 'x' } }).success, false);
  assert.equal(BrowserConfig.safeParse({ telemetry: { enabled: false, installId: 'x' } }).success, false);
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, telemetry: { enabled: false, installId: 'x' } }).success, true);
  assert.equal(CONFIG_BLOCK_KEYS.includes('telemetry'), true);
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

test('a config still carrying the retired mill and memory keys parses, and the keys pass through untouched', () => {
  const retired = {
    millEnabled: false,
    packsAutoRebuild: false,
    packDistiller: { enabled: true, intervalHours: 24, timeoutSeconds: 900 },
    millMetrics: { retainDays: 90, holdoutPercent: 50 },
    memory: { enabled: true, retainDays: 365, distill: { enabled: true, intervalMinutes: 60 } },
  };
  const config = {
    ...DEFAULT_CONFIG,
    ...retired,
    projects: [{ id: 'p1', name: 'proj', path: '/repo/proj', packs: ['house-rules'] }],
    posthog: { enabled: false, packs: ['crew-rules'] },
  };
  const parsed = Config.safeParse(config);
  assert.equal(parsed.success, true);
  const data: Record<string, unknown> = parsed.success ? parsed.data : {};
  for (const [key, value] of Object.entries(retired)) assert.deepEqual(data[key], value, key);
  for (const key of Object.keys(retired)) assert.equal(CONFIG_BLOCK_KEYS.includes(key), false, key);
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
    branchGc: { enabled: true, staleDays: 21, intervalMs: 3600000, deleteUnmerged: true, prefixes: ['evil/'], dryRun: true },
  });
  assert.deepEqual(
    Object.keys(parsed.branchGc ?? {}).sort(),
    [...BRANCH_GC_CONTROL_BOOLEAN_KEYS, ...BRANCH_GC_CONTROL_NUMERIC_KEYS].sort(),
  );
});

test('the safe defaults ship permission prompts on, unmerged branches kept and post-turn checks report-only', () => {
  assert.equal(DEFAULT_CONFIG.skipPermissionsByDefault, false);
  assert.equal(DEFAULT_CONFIG.branchGc.deleteUnmerged, false);
  assert.equal(DEFAULT_CONFIG.postTurnChecks.mode, 'report');
});

test('skipPermissionsByDefault is a dashboard-settable boolean and nothing else', () => {
  assert.equal(ConfigUpdate.parse({ skipPermissionsByDefault: true }).skipPermissionsByDefault, true);
  assert.equal(ConfigUpdate.safeParse({ skipPermissionsByDefault: 'true' }).success, false);
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, skipPermissionsByDefault: 1 }).success, false);
});

test('a project permission choice must be a boolean when present', () => {
  assert.equal(ProjectConfig.safeParse({ path: '/repo' }).success, true);
  assert.equal(ProjectConfig.safeParse({ path: '/repo', dangerouslySkipPermissions: true }).success, true);
  assert.equal(ProjectConfig.safeParse({ path: '/repo', dangerouslySkipPermissions: false }).success, true);
  assert.equal(ProjectConfig.safeParse({ path: '/repo', dangerouslySkipPermissions: 'false' }).success, false);
});

test('branchGc.deleteUnmerged is a dashboard-settable boolean', () => {
  assert.equal(BranchGcFileSettings.parse({ deleteUnmerged: true }).deleteUnmerged, true);
  assert.equal(BranchGcFileSettings.safeParse({ deleteUnmerged: 'yes' }).success, false);
  assert.equal(ConfigUpdate.parse({ branchGc: { deleteUnmerged: true } }).branchGc?.deleteUnmerged, true);
  assert.equal(ConfigUpdate.safeParse({ branchGc: { deleteUnmerged: 'yes' } }).success, false);
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
