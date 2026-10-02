import test from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeCredentials } from '../server/claude-credentials.ts';
import type { CommandRunner } from '../server/claude-credentials.ts';
import { LOGIN_REFRESH_MARGIN_MS, decideArmToken, parseStoredCredentials } from '../server/core/claude-credentials-core.ts';

const NOW = 1_800_000_000_000;
const CELL_TIMEOUT_SECONDS = 1800;
const ENOUGH = NOW + CELL_TIMEOUT_SECONDS * 1000 + LOGIN_REFRESH_MARGIN_MS;

function storedCredentials(expiresAt: number, accessToken = 'login-access-token'): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'operator-refresh-token', expiresAt, scopes: [] } });
}

test('stored credentials yield only the access token and its expiry, never the refresh token', () => {
  assert.deepEqual(parseStoredCredentials(storedCredentials(ENOUGH)), { accessToken: 'login-access-token', expiresAt: ENOUGH });
  assert.equal(parseStoredCredentials('not json'), null);
  assert.equal(parseStoredCredentials(JSON.stringify({ claudeAiOauth: { accessToken: '', expiresAt: ENOUGH } })), null);
  assert.equal(parseStoredCredentials(JSON.stringify({ mcpOAuth: {} })), null);
});

test('a login token is used only when it outlives the cell timeout plus the margin', () => {
  const decide = (expiresAt: number, hasRefreshed = false) => decideArmToken({
    login: { accessToken: 'login-access-token', expiresAt }, nowMs: NOW, cellTimeoutSeconds: CELL_TIMEOUT_SECONDS, hasRefreshed,
  });
  assert.deepEqual(decide(ENOUGH), { kind: 'use', token: 'login-access-token' });
  assert.deepEqual(decide(ENOUGH - 1), { kind: 'refresh' });
  const exhausted = decide(NOW + 5 * 60_000, true);
  assert.equal(exhausted.kind, 'unavailable');
  assert.match(exhausted.kind === 'unavailable' ? exhausted.reason : '', /expires in 5 minutes/);
});

test('an exhausted login reason says whether the refresh extended the token, and still recommends the setup token', () => {
  const exhausted = (expiresAt: number, expiresAtBeforeRefresh: number | null) => {
    const decision = decideArmToken({
      login: { accessToken: 'login-access-token', expiresAt }, nowMs: NOW, cellTimeoutSeconds: CELL_TIMEOUT_SECONDS, hasRefreshed: true, expiresAtBeforeRefresh,
    });
    return decision.kind === 'unavailable' ? decision.reason : '';
  };
  const unchanged = exhausted(NOW + 5 * 60_000, NOW + 5 * 60_000);
  assert.match(unchanged, /a refresh did not extend it/);
  assert.match(unchanged, /GLIMMERVOID_CLAUDE_OAUTH_TOKEN from claude setup-token/);
  const extended = exhausted(NOW + 20 * 60_000, NOW + 5 * 60_000);
  assert.match(extended, /a refresh extended it to 20 minutes, still too soon/);
  assert.doesNotMatch(extended, /did not extend/);
  assert.match(extended, /GLIMMERVOID_CLAUDE_OAUTH_TOKEN from claude setup-token/);
});

test('no login after a refresh is unavailable with a named cause', () => {
  const decision = decideArmToken({ login: null, nowMs: NOW, cellTimeoutSeconds: CELL_TIMEOUT_SECONDS, hasRefreshed: true });
  assert.equal(decision.kind, 'unavailable');
  assert.match(decision.kind === 'unavailable' ? decision.reason : '', /no Claude Code login/);
});

function recordingRunner(keychainReplies: string[]) {
  const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const runCommand: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (command === 'security') return { ok: true, stdout: keychainReplies.shift() ?? '' };
    return { ok: true, stdout: 'OK' };
  };
  return { calls, runCommand };
}

test('a near-expiry keychain token triggers one refresh on the operator default config, then is read again', async () => {
  const { calls, runCommand } = recordingRunner([storedCredentials(NOW + 60_000, 'stale-token'), storedCredentials(ENOUGH, 'fresh-token')]);
  const credentials = createClaudeCredentials({
    platform: 'darwin', env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/stage/.claude', CLAUDE_CODE_OAUTH_TOKEN: 'leftover', ANTHROPIC_API_KEY: 'key' },
    now: () => NOW, claudeCommand: () => '/usr/local/bin/claude', runCommand,
  });
  assert.deepEqual(await credentials.resolveArmToken(CELL_TIMEOUT_SECONDS), { ok: true, token: 'fresh-token' });
  assert.deepEqual(calls.map((call) => call.command), ['security', '/usr/local/bin/claude', 'security']);
  assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
  assert.deepEqual(calls[1].env, { PATH: '/bin' });
});

test('a refresh that does not extend the token fails with a named cause instead of looping', async () => {
  const { calls, runCommand } = recordingRunner([storedCredentials(NOW + 60_000), storedCredentials(NOW + 60_000)]);
  const credentials = createClaudeCredentials({ platform: 'darwin', env: {}, now: () => NOW, claudeCommand: () => 'claude', runCommand });
  const resolved = await credentials.resolveArmToken(CELL_TIMEOUT_SECONDS);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? '' : resolved.reason, /GLIMMERVOID_CLAUDE_OAUTH_TOKEN/);
  assert.equal(calls.length, 3);
});

test('the override env token wins over the login and skips the keychain entirely', async () => {
  const { calls, runCommand } = recordingRunner([]);
  const credentials = createClaudeCredentials({ platform: 'darwin', env: { GLIMMERVOID_CLAUDE_OAUTH_TOKEN: 'setup-token-value' }, now: () => NOW, claudeCommand: () => 'claude', runCommand });
  assert.deepEqual(await credentials.resolveArmToken(CELL_TIMEOUT_SECONDS), { ok: true, token: 'setup-token-value' });
  assert.equal(calls.length, 0);
});

test('the override token is removed from the environment it was read from and still resolves afterwards', async () => {
  const { runCommand } = recordingRunner([]);
  const env: NodeJS.ProcessEnv = { PATH: '/bin', GLIMMERVOID_CLAUDE_OAUTH_TOKEN: 'setup-token-value' };
  const credentials = createClaudeCredentials({ platform: 'darwin', env, now: () => NOW, claudeCommand: () => 'claude', runCommand });
  assert.equal(Object.hasOwn(env, 'GLIMMERVOID_CLAUDE_OAUTH_TOKEN'), false);
  assert.deepEqual(env, { PATH: '/bin' });
  assert.deepEqual(await credentials.resolveArmToken(CELL_TIMEOUT_SECONDS), { ok: true, token: 'setup-token-value' });
});

test('off macOS the login token comes from the credentials file under the home directory', async () => {
  const readPaths: string[] = [];
  const credentials = createClaudeCredentials({
    platform: 'linux', homeDir: '/home/operator', env: {}, now: () => NOW, claudeCommand: () => null,
    runCommand: async () => ({ ok: false, stdout: '' }),
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return storedCredentials(ENOUGH, 'file-token');
    },
  });
  assert.deepEqual(await credentials.resolveArmToken(CELL_TIMEOUT_SECONDS), { ok: true, token: 'file-token' });
  assert.deepEqual(readPaths, ['/home/operator/.claude/.credentials.json']);
});
