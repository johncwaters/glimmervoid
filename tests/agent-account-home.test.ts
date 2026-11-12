import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_HOME_PROFILE } from '../session/core/agent-home-core.ts';
import { prepareAccountHome } from '../session/agent-home.ts';

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
  writeJson(path.join(homeDir, '.claude.json'), { oauthAccount: { org: 'personal' }, mcpServers: { posthog: { url: 'p' } } });
  writeJson(path.join(accountFolder, '.claude.json'), { oauthAccount: { org: 'team' }, mcpServers: { stale: {} } });
  writeJson(path.join(accountFolder, 'policy-limits.json'), { team: true });
  return { homeDir, realHome, accountFolder };
}

test('a claude account home shares the real setup, keeps its own login and policy, and takes the real MCP servers', async () => {
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
  assert.deepEqual(readJson(path.join(accountFolder, '.claude.json')), { oauthAccount: { org: 'team' }, mcpServers: { posthog: { url: 'p' } } });
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
