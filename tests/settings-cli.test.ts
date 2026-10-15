import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore, DEFAULT_CONFIG } from '../server/config-store.ts';
import { runSettingsCommand } from '../server/settings-cli.ts';
import { AGENT_URL_ENV } from '../shared/contracts/session.ts';
import { SETTINGS_REGISTRY } from '../shared/settings/registry.ts';
import { settingsOf, valueAtPath } from '../shared/settings/registry-core.ts';

const SECRET_VALUE = 'phx_do_not_print_me';

function isolatedGlimmervoidHome(config: Record<string, unknown> | null): string {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-home-'));
  if (config) fs.writeFileSync(path.join(homeDirectory, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  process.env.GLIMMERVOID_HOME = homeDirectory;
  delete process.env.GLIMMERVOID_CONFIG;
  delete process.env[AGENT_URL_ENV];
  return homeDirectory;
}

function run(commandArguments: string[]): { exitCode: number; stdout: string; stderr: string } {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = runSettingsCommand(commandArguments, { writeOutput: (text) => output.push(text), writeError: (text) => errors.push(text) });
  return { exitCode, stdout: output.join(''), stderr: errors.join('') };
}

function runJson(commandArguments: string[]): { exitCode: number; parsed: unknown; stderr: string } {
  const result = run([...commandArguments, '--json']);
  return { exitCode: result.exitCode, parsed: result.exitCode === 0 ? JSON.parse(result.stdout) : null, stderr: result.stderr };
}

function readConfig(homeDirectory: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(homeDirectory, 'config.json'), 'utf8'));
}

function baseConfig(): Record<string, unknown> {
  return { port: 3000, projects: [], repoRoots: [], posthog: { enabled: true, apiKey: SECRET_VALUE, trafficSpikeEnabled: true } };
}

test('schema --json prints every registry setting with id, path, type, default, unit, effect and section, with no config file', () => {
  const homeDirectory = isolatedGlimmervoidHome(null);
  const { exitCode, parsed } = runJson(['schema']);
  assert.equal(exitCode, 0);
  assert.ok(Array.isArray(parsed));
  const entries = parsed as Record<string, unknown>[];
  assert.equal(entries.length, settingsOf(SETTINGS_REGISTRY.sections).length + SETTINGS_REGISTRY.fileOnly.length);
  for (const entry of entries) {
    for (const key of ['id', 'path', 'type', 'default', 'unit', 'effect', 'section']) assert.ok(key in entry, `${entry.id} lacks ${key}`);
    const section = entry.section as { id: string; title: string };
    assert.ok(section.id.length > 0 && section.title.length > 0, `${entry.id} has no section`);
  }
  const spike = entries.find((entry) => entry.id === 'posthog-traffic-enabled');
  assert.deepEqual(spike && { path: spike.path, type: spike.type, default: spike.default, effect: spike.effect }, { path: 'posthog.trafficSpikeEnabled', type: 'toggle', default: true, effect: 'now' });
  const fileOnly = entries.find((entry) => entry.id === 'file-replay-buffer');
  assert.equal(fileOnly?.unit, 'KB');
  const quiet = entries.find((entry) => entry.id === 'file-visions-quiet-delay');
  assert.deepEqual(
    quiet && { path: quiet.path, default: quiet.default, unit: quiet.unit, displayUnit: quiet.displayUnit, storedPerDisplay: quiet.storedPerDisplay },
    { path: 'visions.dispatch.quietMs', default: 30000, unit: 'ms', displayUnit: 'seconds', storedPerDisplay: 1000 },
  );
  assert.match(run(['schema']).stdout, /visions\.dispatch\.quietMs +\| number +\| 30000 +\| ms +\| seconds +\|/);
  assert.equal(fs.existsSync(path.join(homeDirectory, 'config.json')), false);
  assert.equal(run(['schema']).exitCode, 0);
});

test('list and get show a secret as configured and never print its value, in text and in JSON', () => {
  isolatedGlimmervoidHome(baseConfig());
  const listing = run(['list']);
  assert.equal(listing.exitCode, 0);
  assert.doesNotMatch(listing.stdout, new RegExp(SECRET_VALUE));
  assert.match(listing.stdout, /posthog\.apiKey +\| configured +\| config\.json/);
  const listingJson = runJson(['list']);
  assert.equal(listingJson.exitCode, 0);
  const entries = listingJson.parsed as Record<string, unknown>[];
  const apiKey = entries.find((entry) => entry.path === 'posthog.apiKey');
  assert.deepEqual(apiKey && { secret: apiKey.secret, configured: apiKey.configured, hasValue: 'value' in apiKey, source: apiKey.source }, { secret: true, configured: true, hasValue: false, source: 'config.json' });
  assert.ok(entries.every((entry) => JSON.stringify(entry).includes(SECRET_VALUE) === false));
  assert.ok(entries.every((entry) => entry.scope === 'machine' && entry.type !== 'readonly'));
  const got = run(['get', 'posthog.apiKey']);
  assert.equal(got.exitCode, 0);
  assert.equal(got.stdout, 'posthog.apiKey = configured (config.json)\n');
  const gotJson = runJson(['get', 'posthog-api-key']);
  assert.equal(gotJson.exitCode, 0);
  assert.equal('value' in (gotJson.parsed as Record<string, unknown>), false);
  const unsetSecret = run(['get', 'telegram.botToken']);
  assert.equal(unsetSecret.stdout, 'telegram.botToken = not configured\n');
});

function assertSecretWritesRefused(): void {
  for (const [secretPath, sectionTitle, variable] of [['posthog.apiKey', 'PostHog', 'GLIMMERVOID_POSTHOG_API_KEY'], ['telegram-bot-token', 'Telegram', 'GLIMMERVOID_TELEGRAM_BOT_TOKEN']]) {
    for (const refused of [run(['set', secretPath, '123456:ARGV_SECRET']), run(['unset', secretPath])]) {
      assert.equal(refused.exitCode, 1, secretPath);
      assert.match(refused.stderr, new RegExp(`Settings > ${sectionTitle}, or set ${variable} in the environment`), secretPath);
    }
  }
}

test('set and unset refuse a secret with or without its variable exported, and get reads an environment-supplied one as configured', () => {
  const homeDirectory = isolatedGlimmervoidHome(baseConfig());
  const before = fs.readFileSync(path.join(homeDirectory, 'config.json'), 'utf8');
  assertSecretWritesRefused();
  process.env.GLIMMERVOID_POSTHOG_API_KEY = 'phx_from_the_environment';
  process.env.GLIMMERVOID_TELEGRAM_BOT_TOKEN = '654321:FROM_THE_ENVIRONMENT';
  try {
    const got = runJson(['get', 'posthog.apiKey']);
    assert.equal(got.exitCode, 0);
    const readout = got.parsed as Record<string, unknown>;
    assert.deepEqual({ configured: readout.configured, source: readout.source, hasValue: 'value' in readout }, { configured: true, source: 'GLIMMERVOID_POSTHOG_API_KEY', hasValue: false });
    assertSecretWritesRefused();
  } finally {
    delete process.env.GLIMMERVOID_POSTHOG_API_KEY;
    delete process.env.GLIMMERVOID_TELEGRAM_BOT_TOKEN;
  }
  assert.equal(fs.readFileSync(path.join(homeDirectory, 'config.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(homeDirectory, 'config.json.bak')), false);
});

test('set validates the whole file, writes it with a backup, keeps a stored secret the shell environment also supplies, and get reads the new value', () => {
  const homeDirectory = isolatedGlimmervoidHome(baseConfig());
  const before = fs.readFileSync(path.join(homeDirectory, 'config.json'), 'utf8');
  process.env.GLIMMERVOID_POSTHOG_API_KEY = 'phx_from_the_environment';
  const set = run(['set', 'posthog.trafficSpikeEnabled', 'false']);
  delete process.env.GLIMMERVOID_POSTHOG_API_KEY;
  assert.equal(set.exitCode, 0, set.stderr);
  assert.equal(set.stdout, 'posthog.trafficSpikeEnabled = false\nA running Glimmervoid applies it without a restart.\n');
  const written = readConfig(homeDirectory);
  assert.deepEqual(written.posthog, { enabled: true, apiKey: SECRET_VALUE, trafficSpikeEnabled: false });
  assert.equal(written.port, 3000);
  assert.equal(fs.readFileSync(path.join(homeDirectory, 'config.json.bak'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(homeDirectory, 'config.json.boot.bak')), false);
  const got = runJson(['get', 'posthog.trafficSpikeEnabled']);
  assert.equal(got.exitCode, 0);
  const readout = got.parsed as Record<string, unknown>;
  assert.deepEqual({ value: readout.value, source: readout.source, effect: readout.effect }, { value: false, source: 'config.json', effect: 'now' });
  const setJson = runJson(['set', 'posthog-traffic-enabled', 'on']);
  assert.equal(setJson.exitCode, 0);
  const result = setJson.parsed as Record<string, unknown>;
  assert.deepEqual({ value: result.value, previous: result.previous, configPath: result.configPath }, { value: true, previous: false, configPath: path.join(homeDirectory, 'config.json') });
});

test('a wrong value exits 1 with the schema message and writes nothing', () => {
  const homeDirectory = isolatedGlimmervoidHome(baseConfig());
  const before = fs.readFileSync(path.join(homeDirectory, 'config.json'), 'utf8');
  const notBoolean = run(['set', 'posthog.trafficSpikeEnabled', 'maybe']);
  assert.equal(notBoolean.exitCode, 1);
  assert.match(notBoolean.stderr, /^settings: posthog\.trafficSpikeEnabled must be a boolean/);
  const badHost = run(['set', 'posthog.host', 'ftp://example.invalid']);
  assert.equal(badHost.exitCode, 1);
  assert.match(badHost.stderr, /posthog\.host must be an http\(s\) URL/);
  const relativeDirs = run(['set', 'usage.extraProjectsDirs', 'relative/dir']);
  assert.equal(relativeDirs.exitCode, 1);
  assert.match(relativeDirs.stderr, /usage\.extraProjectsDirs entries must be absolute paths/);
  const outOfRange = run(['set', 'posthog.intervalMinutes', '0']);
  assert.equal(outOfRange.exitCode, 1);
  assert.match(outOfRange.stderr, /posthog\.intervalMinutes/);
  const looseBlockRange = run(['set', 'visions.dispatch.maxPerHour', '0']);
  assert.equal(looseBlockRange.exitCode, 1);
  assert.match(looseBlockRange.stderr, /visions\.dispatch\.maxPerHour must be a positive number/);
  const badOption = run(['set', 'factory.maxRisk', 'extreme']);
  assert.equal(badOption.exitCode, 1);
  assert.match(badOption.stderr, /factory\.maxRisk/);
  const badJson = run(['set', 'customAgents', '{not json']);
  assert.equal(badJson.exitCode, 1);
  assert.match(badJson.stderr, /customAgents must be JSON/);
  assert.equal(fs.readFileSync(path.join(homeDirectory, 'config.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(homeDirectory, 'config.json.bak')), false);
  fs.writeFileSync(path.join(homeDirectory, 'config.json'), JSON.stringify({ ...baseConfig(), visions: { enabled: false, dispatch: { maxPerHour: 0 } } }));
  const brokenBlock = fs.readFileSync(path.join(homeDirectory, 'config.json'), 'utf8');
  for (const siblingEdit of [run(['set', 'visions.enabled', 'true']), run(['unset', 'visions.enabled'])]) {
    assert.equal(siblingEdit.exitCode, 1);
    assert.match(siblingEdit.stderr, /visions\.dispatch\.maxPerHour must be a positive number/);
  }
  assert.equal(fs.readFileSync(path.join(homeDirectory, 'config.json'), 'utf8'), brokenBlock);
});

test('a path outside the registry, the listener port, a browser preference and a status row are refused with a message naming where they live', () => {
  const homeDirectory = isolatedGlimmervoidHome(baseConfig());
  const before = fs.readFileSync(path.join(homeDirectory, 'config.json'), 'utf8');
  for (const outside of ['remote.enabled', 'projects', 'hooks', 'remote', 'port', 'file-port']) {
    for (const refused of [run(['set', outside, '3456']), run(['unset', outside])]) {
      assert.equal(refused.exitCode, 1, outside);
      assert.match(refused.stderr, /edit config\.json at .* by hand/, outside);
      assert.match(refused.stderr, new RegExp(outside === 'file-port' ? 'port' : outside.replace('.', '\\.')));
    }
  }
  assert.equal(run(['get', 'port']).stdout, 'port = 3000 (config.json)\n');
  const browserPreference = run(['set', 'theme', 'dark']);
  assert.equal(browserPreference.exitCode, 1);
  assert.match(browserPreference.stderr, /browser preference/);
  const statusRow = run(['get', 'update-actions']);
  assert.equal(statusRow.exitCode, 1);
  assert.match(statusRow.stderr, /read-only status row/);
  assert.equal(fs.readFileSync(path.join(homeDirectory, 'config.json'), 'utf8'), before);
});

test('unset removes the key so the default applies, and reports when nothing was set, naming the whole default', () => {
  const homeDirectory = isolatedGlimmervoidHome(baseConfig());
  const unset = run(['unset', 'posthog.trafficSpikeEnabled']);
  assert.equal(unset.exitCode, 0, unset.stderr);
  assert.match(unset.stdout, /^posthog\.trafficSpikeEnabled unset; the default true applies\n/);
  assert.deepEqual(readConfig(homeDirectory).posthog, { enabled: true, apiKey: SECRET_VALUE });
  const got = runJson(['get', 'posthog.trafficSpikeEnabled']);
  const readout = got.parsed as Record<string, unknown>;
  assert.deepEqual({ value: readout.value, source: readout.source }, { value: true, source: 'default' });
  const again = runJson(['unset', 'posthog.trafficSpikeEnabled']);
  assert.equal(again.exitCode, 0);
  assert.equal((again.parsed as Record<string, unknown>).changed, false);
  assert.equal(run(['unset', 'worktreeShare']).stdout, `worktreeShare is not set in config.json; the default ${JSON.stringify(DEFAULT_CONFIG.worktreeShare)} already applies\n`);
});

test('set parses numbers, lists, nullable text and structured JSON per the registry control', () => {
  const homeDirectory = isolatedGlimmervoidHome(baseConfig());
  assert.equal(run(['set', 'usage.retainDays', '30']).exitCode, 0);
  assert.equal(run(['set', 'repoRoots', `${homeDirectory}, ${os.tmpdir()}`]).exitCode, 0);
  assert.equal(run(['set', 'factory.checks', '["npm test"]']).exitCode, 0);
  assert.equal(run(['set', 'integrationBranch', 'main']).exitCode, 0);
  assert.equal(run(['set', 'posthog.projects', '12, 34']).exitCode, 0);
  assert.equal(run(['set', 'customAgents', '[{"id":"my-agent","label":"Mine","command":"my-agent"}]']).exitCode, 0);
  const written = readConfig(homeDirectory);
  assert.equal((written.usage as Record<string, unknown>).retainDays, 30);
  assert.deepEqual(written.repoRoots, [homeDirectory, os.tmpdir()]);
  assert.deepEqual((written.factory as Record<string, unknown>).checks, ['npm test']);
  assert.equal(written.integrationBranch, 'main');
  assert.deepEqual((written.posthog as Record<string, unknown>).projects, [12, 34]);
  assert.equal((written.customAgents as Record<string, unknown>[])[0].id, 'my-agent');
  assert.equal(run(['set', 'integrationBranch', '']).exitCode, 0);
  assert.equal(readConfig(homeDirectory).integrationBranch, null);
  assert.equal(run(['get', 'posthog.projects']).stdout, 'posthog.projects = 12, 34 (config.json)\n');
  assert.equal(run(['set', 'usage.retainDays', '1.5']).exitCode, 1);
  assert.equal(run(['get', 'visions.dispatch.quietMs']).stdout, 'visions.dispatch.quietMs = 30000 (30 seconds) (default)\n');
  assert.match(run(['set', 'visions.dispatch.quietMs', '45000']).stdout, /^visions\.dispatch\.quietMs = 45000 \(45 seconds\)\n/);
  assert.deepEqual((readConfig(homeDirectory).visions as Record<string, unknown>).dispatch, { quietMs: 45000 });
});

test('search ranks through the shared scorer and reaches file-only entries', () => {
  isolatedGlimmervoidHome(null);
  const spike = runJson(['search', 'spike']);
  assert.equal(spike.exitCode, 0);
  const results = spike.parsed as Record<string, unknown>[];
  assert.match(String(results[0]?.title), /spike/i);
  assert.ok(results.some((result) => result.id === 'posthog-traffic-enabled'));
  assert.ok(results.every((result) => typeof result.score === 'number' && typeof result.path === 'string'));
  const scores = results.map((result) => Number(result.score));
  assert.deepEqual(scores, [...scores].sort((left, right) => right - left));
  const rerere = runJson(['search', 'rerere']);
  assert.equal((rerere.parsed as Record<string, unknown>[])[0]?.id, 'file-worktree-rerere');
  const text = run(['search', 'traffic', 'spike']);
  assert.equal(text.exitCode, 0);
  assert.match(text.stdout, /posthog\.trafficSpikeEnabled +\| Traffic spike alerts +\| PostHog/);
  assert.equal(run(['search', 'zzzz-nothing-matches']).stdout, '(no matches)\n');
  assert.equal(run(['search']).exitCode, 1);
});

test('a missing, unreadable or broken config.json is named instead of created or crashed on', () => {
  const homeDirectory = isolatedGlimmervoidHome(null);
  const missing = run(['get', 'autoResume']);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, new RegExp(`no config\\.json at ${path.join(homeDirectory, 'config.json').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  assert.equal(fs.existsSync(path.join(homeDirectory, 'config.json')), false);
  fs.writeFileSync(path.join(homeDirectory, 'config.json'), '{"posthog":');
  const broken = run(['get', 'autoResume']);
  assert.equal(broken.exitCode, 1);
  assert.match(broken.stderr, /Could not load .*config\.json/);
  process.env.GLIMMERVOID_CONFIG = path.join(homeDirectory, 'absent.json');
  const absentEnvPath = run(['list']);
  assert.equal(absentEnvPath.exitCode, 1);
  assert.match(absentEnvPath.stderr, /config file not found: .*absent\.json/);
  delete process.env.GLIMMERVOID_CONFIG;
});

test('inside a guarded session the command names the unreadable Glimmervoid home', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const homeDirectory = isolatedGlimmervoidHome(baseConfig());
  fs.chmodSync(homeDirectory, 0o000);
  try {
    const refused = run(['get', 'autoResume']);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, new RegExp(`cannot read the Glimmervoid home at ${homeDirectory.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    assert.match(refused.stderr, /guardrails/);
  } finally {
    fs.chmodSync(homeDirectory, 0o700);
  }
  process.env[AGENT_URL_ENV] = 'http://127.0.0.1:1/agent';
  process.env.GLIMMERVOID_HOME = path.join(homeDirectory, 'hidden-by-guardrails');
  try {
    const hidden = run(['get', 'autoResume']);
    assert.equal(hidden.exitCode, 1);
    assert.match(hidden.stderr, /cannot read the Glimmervoid home at .*hidden-by-guardrails/);
  } finally {
    delete process.env[AGENT_URL_ENV];
  }
  assert.equal(run(['schema']).exitCode, 0);
});

test('a running server reloads a value the CLI wrote through its file watch, without a restart', async () => {
  isolatedGlimmervoidHome(baseConfig());
  const store = createConfigStore();
  let reloadedValue: (value: unknown) => void = () => undefined;
  const reloaded = new Promise<unknown>((resolve) => {
    reloadedValue = resolve;
  });
  const stopWatching = store.watchForChanges((config) => reloadedValue(valueAtPath(config, 'posthog.trafficSpikeEnabled')));
  try {
    assert.equal(run(['set', 'posthog.trafficSpikeEnabled', 'false']).exitCode, 0);
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000).unref());
    assert.equal(await Promise.race([reloaded, timeout]), false);
  } finally {
    stopWatching();
  }
});

test('--help prints usage and exits 0; an unknown command prints usage and exits 1', () => {
  isolatedGlimmervoidHome(null);
  const help = run(['--help']);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /glimmervoid settings set <path> <value>/);
  assert.equal(run(['frobnicate']).exitCode, 1);
  assert.equal(run([]).exitCode, 1);
});
