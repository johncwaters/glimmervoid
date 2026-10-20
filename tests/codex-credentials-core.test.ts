import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexCredentials } from '../server/codex-credentials.ts';
import { chatgptAuthTokensLogin, chatgptAuthTokensRefreshResult, parseCodexAuth } from '../server/core/codex-credentials-core.ts';

const NOW = 1_800_000_000_000;

function accessTokenExpiringAt(expiresAtMs: number, marker: string): string {
  const claims = Buffer.from(JSON.stringify({ exp: expiresAtMs / 1000, marker })).toString('base64url');
  return `header.${claims}.signature`;
}

function storedAuth(accessToken: string): string {
  return JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'id-token', access_token: accessToken, refresh_token: 'host-refresh-token', account_id: 'account-1' }, last_refresh: 'x' });
}

test('a stored Codex login yields the access token, account id and expiry, never the refresh token', () => {
  const accessToken = accessTokenExpiringAt(NOW + 3_600_000, 'fresh');
  const login = parseCodexAuth(storedAuth(accessToken));
  assert.deepEqual(login, { accessToken, accountId: 'account-1', expiresAtMs: NOW + 3_600_000 });
  assert.ok(login);
  const remotePayloads = JSON.stringify([chatgptAuthTokensLogin(login), chatgptAuthTokensRefreshResult(login)]);
  assert.doesNotMatch(remotePayloads, /host-refresh-token|id-token/);
  assert.deepEqual(chatgptAuthTokensLogin(login), { type: 'chatgptAuthTokens', accessToken, chatgptAccountId: 'account-1' });
  assert.equal(parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: 'sk-x', tokens: null })), null);
  assert.equal(parseCodexAuth('not json'), null);
});

test('a host refresh through a real codex app-server process renews the login it then reads from CODEX_HOME', { skip: process.platform === 'win32' }, async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'gv-codex-credentials-'));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const codexHome = path.join(scratch, 'codex home');
  const fakeCodex = path.join(scratch, 'codex');
  const freshToken = accessTokenExpiringAt(NOW + 3_600_000, 'renewed');
  await writeFile(path.join(scratch, 'renewed.json'), storedAuth(freshToken));
  await mkdir(codexHome);
  await writeFile(path.join(codexHome, 'auth.json'), storedAuth(accessTokenExpiringAt(NOW + 60_000, 'stale')));
  await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
let buffered = '';
process.stdin.on('data', (chunk) => {
  const lines = (buffered + chunk).split('\\n');
  buffered = lines.pop();
  for (const line of lines) {
    const message = JSON.parse(line);
    fs.appendFileSync(path.join(${JSON.stringify(scratch)}, 'calls.log'), message.method + ' ' + JSON.stringify(message.params ?? null) + '\\n');
    if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'fake' } }) + '\\n');
    if (message.method === 'account/read') {
      fs.copyFileSync(path.join(${JSON.stringify(scratch)}, 'renewed.json'), path.join(process.env.CODEX_HOME, 'auth.json'));
      process.stdout.write(JSON.stringify({ id: 2, result: { account: null } }) + '\\n');
    }
  }
});
`);
  await chmod(fakeCodex, 0o755);
  const credentials = createCodexCredentials({
    homeDir: scratch,
    env: { PATH: process.env.PATH ?? '', CODEX_HOME: codexHome },
    now: () => NOW,
    codexCommand: () => ({ file: fakeCodex, argsBeforeAppServer: [] }),
  });
  const result = await credentials.hostLogin();
  assert.deepEqual(result, { ok: true, login: { accessToken: freshToken, accountId: 'account-1', expiresAtMs: NOW + 3_600_000 } });
  const calls = await readFile(path.join(scratch, 'calls.log'), 'utf8');
  assert.match(calls, /^initialize .*\ninitialized null\naccount\/read \{"refreshToken":true\}\n$/);
});
