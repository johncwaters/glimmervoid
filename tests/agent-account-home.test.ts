import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_HOME_PROFILE, CODEX_HOME_PROFILE, KIMI_HOME_PROFILE } from '../session/core/agent-home-core.ts';
import { holdPreparedAgentHome, prepareAccountHome, releaseAgentHome } from '../session/agent-home.ts';

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function claudeAccountScratch() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-account-'));
  const realHome = path.join(homeDir, '.claude');
  const accountFolder = path.join(homeDir, 'accounts', 'team');
  fs.mkdirSync(path.join(realHome, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(realHome, 'projects'), { recursive: true });
  fs.mkdirSync(accountFolder, { recursive: true });
  writeJson(path.join(realHome, 'settings.json'), { hooks: {} });
  writeJson(path.join(realHome, '.credentials.json'), { personal: true });
  writeJson(path.join(realHome, 'policy-limits.json'), { personal: true });
  writeJson(path.join(homeDir, '.claude.json'), { oauthAccount: { org: 'personal' }, mcpServers: { posthog: { url: 'p' } }, hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.0', theme: 'dark' });
  writeJson(path.join(accountFolder, '.claude.json'), { oauthAccount: { org: 'team' }, mcpServers: { stale: {} } });
  writeJson(path.join(accountFolder, 'policy-limits.json'), { team: true });
  return { homeDir, realHome, accountFolder };
}

test('a claude account home shares the real setup, keeps its own login and policy, and takes the real MCP servers and onboarding', async () => {
  const { homeDir, realHome, accountFolder } = claudeAccountScratch();
  const env = { HOME: homeDir };

  const prepared = await prepareAccountHome(CLAUDE_HOME_PROFILE, { env, accountFolder, homeDir });

  assert.deepEqual(prepared, { home: accountFolder });
  for (const sharedName of ['settings.json', 'skills', 'projects']) {
    assert.equal(fs.readlinkSync(path.join(accountFolder, sharedName)), path.join(realHome, sharedName));
  }
  assert.equal(fs.existsSync(path.join(accountFolder, '.credentials.json')), false);
  assert.deepEqual(readJson(path.join(accountFolder, 'policy-limits.json')), { team: true });
  assert.deepEqual(readJson(path.join(realHome, 'policy-limits.json')), { personal: true });
  assert.deepEqual(readJson(path.join(accountFolder, '.claude.json')), { oauthAccount: { org: 'team' }, mcpServers: { posthog: { url: 'p' } }, hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.0', theme: 'dark' });
});

test('a claude account home keeps its own onboarding when the machine config has none', async () => {
  const { homeDir, accountFolder } = claudeAccountScratch();
  writeJson(path.join(homeDir, '.claude.json'), { userID: 'x' });
  writeJson(path.join(accountFolder, '.claude.json'), { oauthAccount: { org: 'team' }, hasCompletedOnboarding: true, theme: 'light' });

  await prepareAccountHome(CLAUDE_HOME_PROFILE, { env: { HOME: homeDir }, accountFolder, homeDir });

  assert.deepEqual(readJson(path.join(accountFolder, '.claude.json')), { oauthAccount: { org: 'team' }, hasCompletedOnboarding: true, theme: 'light' });
});

test('a codex account home sets its own config aside and leaves no copy of the machine config behind', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-account-'));
  const realHome = path.join(homeDir, '.codex');
  const accountFolder = path.join(homeDir, 'accounts', 'codex-own');
  fs.mkdirSync(realHome, { recursive: true });
  fs.mkdirSync(accountFolder, { recursive: true });
  fs.writeFileSync(path.join(realHome, 'config.toml'), 'API_TOKEN = "machine"\n');
  fs.writeFileSync(path.join(accountFolder, 'config.toml'), 'model = "mine"\n');

  await prepareAccountHome(CODEX_HOME_PROFILE, { env: { HOME: homeDir }, accountFolder, homeDir });

  const keptNames = fs.readdirSync(path.join(accountFolder, '.glimmervoid-conflicts'));
  assert.equal(keptNames.length, 1);
  assert.equal(fs.readFileSync(path.join(accountFolder, '.glimmervoid-conflicts', keptNames[0]), 'utf8'), 'model = "mine"\n');
  assert.equal(fs.existsSync(path.join(accountFolder, 'config.toml')), false);
});

test('a codex account home links the real setup and keeps its own login', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-account-'));
  const realHome = path.join(homeDir, '.codex');
  const accountFolder = path.join(homeDir, 'accounts', 'codex-two');
  fs.mkdirSync(path.join(realHome, 'skills'), { recursive: true });
  fs.mkdirSync(accountFolder, { recursive: true });
  fs.writeFileSync(path.join(realHome, 'config.toml'), 'model = "gpt"\n');
  writeJson(path.join(realHome, 'auth.json'), { personal: true });
  writeJson(path.join(accountFolder, 'auth.json'), { second: true });

  const prepared = await prepareAccountHome(CODEX_HOME_PROFILE, { env: { HOME: homeDir }, accountFolder, homeDir });

  assert.deepEqual(prepared, { home: accountFolder });
  assert.equal(fs.readlinkSync(path.join(accountFolder, 'skills')), path.join(realHome, 'skills'));
  assert.equal(fs.lstatSync(path.join(accountFolder, 'auth.json')).isSymbolicLink(), false);
  assert.deepEqual(readJson(path.join(accountFolder, 'auth.json')), { second: true });
});

test('a kimi account home links the real sessions and device id and keeps its own credentials, region and login slot', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-account-'));
  const realHome = path.join(homeDir, '.kimi-code');
  const accountFolder = path.join(homeDir, 'accounts', 'kimi-two');
  fs.mkdirSync(path.join(realHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(realHome, 'credentials'), { recursive: true });
  fs.mkdirSync(path.join(accountFolder, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(realHome, 'config.toml'), 'default_model = "k2"\n\n[providers."managed:kimi-code".oauth]\nkey = "oauth/kimi-code-env-global"\noauth_host = "https://auth.kimi.ai"\n');
  fs.writeFileSync(path.join(accountFolder, 'config.toml'), 'default_model = "mine"\n\n[providers."managed:kimi-code".oauth]\nkey = "oauth/kimi-code"\noauth_host = "https://auth.kimi.com"\n');
  fs.writeFileSync(path.join(realHome, 'device_id'), 'machine\n');
  fs.writeFileSync(path.join(realHome, 'region'), 'global\n');
  writeJson(path.join(realHome, 'credentials', 'kimi-code.json'), { personal: true });
  writeJson(path.join(accountFolder, 'credentials', 'kimi-code.json'), { second: true });

  const prepared = await prepareAccountHome(KIMI_HOME_PROFILE, { env: { HOME: homeDir }, accountFolder, homeDir });

  assert.deepEqual(prepared, { home: accountFolder });
  assert.equal(fs.readlinkSync(path.join(accountFolder, 'sessions')), path.join(realHome, 'sessions'));
  assert.equal(fs.readlinkSync(path.join(accountFolder, 'device_id')), path.join(realHome, 'device_id'));
  assert.equal(fs.existsSync(path.join(accountFolder, 'region')), false);
  assert.equal(fs.lstatSync(path.join(accountFolder, 'credentials')).isSymbolicLink(), false);
  assert.deepEqual(readJson(path.join(accountFolder, 'credentials', 'kimi-code.json')), { second: true });
  const holdSessionConfig = () => {
    assert.deepEqual(holdPreparedAgentHome(KIMI_HOME_PROFILE, { HOME: homeDir, KIMI_CODE_HOME: realHome }, () => '', () => ({}), false, accountFolder), { home: accountFolder });
    const sessionConfig = fs.readFileSync(path.join(accountFolder, 'config.toml'), 'utf8');
    releaseAgentHome(accountFolder);
    return sessionConfig;
  };
  const firstSessionConfig = holdSessionConfig();
  assert.match(firstSessionConfig, /default_model = "k2"/);
  assert.match(firstSessionConfig, /key = "oauth\/kimi-code"\noauth_host = "https:\/\/auth\.kimi\.com"/);
  assert.doesNotMatch(firstSessionConfig, /kimi-code-env-global/);
  assert.equal(fs.existsSync(path.join(accountFolder, 'config.toml')), false);
  assert.equal(holdSessionConfig(), firstSessionConfig);
});

test('a claude account home refuses a missing account folder and the machine home under any spelling', async () => {
  const { homeDir, realHome } = claudeAccountScratch();
  const env = { HOME: homeDir };
  const realHomeAlias = path.join(homeDir, 'alias-of-claude');
  fs.symlinkSync(realHome, realHomeAlias);

  const missing = await prepareAccountHome(CLAUDE_HOME_PROFILE, { env, accountFolder: path.join(homeDir, 'accounts', 'gone'), homeDir });
  const machineHome = await prepareAccountHome(CLAUDE_HOME_PROFILE, { env, accountFolder: realHome, homeDir });
  const machineHomeAlias = await prepareAccountHome(CLAUDE_HOME_PROFILE, { env, accountFolder: realHomeAlias, homeDir });

  assert.match('refusal' in missing ? missing.refusal : '', /missing; sign in/);
  assert.match('refusal' in machineHome ? machineHome.refusal : '', /machine's own claude home/);
  assert.match('refusal' in machineHomeAlias ? machineHomeAlias.refusal : '', /machine's own claude home/);
  assert.equal(fs.lstatSync(path.join(realHome, 'settings.json')).isSymbolicLink(), false);
});

test('a claude account home keeps the legacy global config its own and takes the MCP servers from the legacy machine config', async () => {
  const { homeDir, realHome, accountFolder } = claudeAccountScratch();
  const env = { HOME: homeDir };
  fs.rmSync(path.join(homeDir, '.claude.json'));
  writeJson(path.join(realHome, '.config.json'), { oauthAccount: { org: 'personal' }, mcpServers: { legacy: { url: 'l' } } });

  const prepared = await prepareAccountHome(CLAUDE_HOME_PROFILE, { env, accountFolder, homeDir });

  assert.deepEqual(prepared, { home: accountFolder });
  assert.equal(fs.existsSync(path.join(accountFolder, '.config.json')), false);
  assert.deepEqual(readJson(path.join(accountFolder, '.claude.json')), { oauthAccount: { org: 'team' }, mcpServers: { legacy: { url: 'l' } } });
});

test('a claude account home starts when the machine global config is empty and leaves the account config alone', async () => {
  const { homeDir, accountFolder } = claudeAccountScratch();
  const env = { HOME: homeDir };
  fs.writeFileSync(path.join(homeDir, '.claude.json'), '{');

  const prepared = await prepareAccountHome(CLAUDE_HOME_PROFILE, { env, accountFolder, homeDir });

  assert.deepEqual(prepared, { home: accountFolder });
  assert.deepEqual(readJson(path.join(accountFolder, '.claude.json')), { oauthAccount: { org: 'team' }, mcpServers: { stale: {} } });
});
