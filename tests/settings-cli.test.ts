import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore } from '../server/config-store.ts';
import { runSettingsCommand } from '../server/settings-cli.ts';
import { AGENT_URL_ENV } from '../shared/contracts/session.ts';
import { valueAtPath } from '../shared/settings/registry-core.ts';

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
