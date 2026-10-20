import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createAgentConnect } from '../server/agent-login/agent-connect.ts';
import type { ConnectPty } from '../server/agent-login/agent-connect.ts';
import { createClaudeCredentials } from '../server/claude-credentials.ts';
import { createCodexCredentials } from '../server/codex-credentials.ts';
import { readConnectPrompt } from '../server/agent-login/core/agent-connect-core.ts';
import type { LoginSource } from '../server/agent-login/core/agent-connect-core.ts';
import type { AgentLoginStatus } from '../shared/contracts/control-messages.ts';

const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=client&response_type=code&state=opaque';
const CLAUDE_LOGIN_OUTPUT = `Opening browser to sign in\r\nIf the browser didn't open, visit: ${ESCAPE}]8;;${CLAUDE_AUTHORIZE_URL}${BELL}${ESCAPE}[94m${CLAUDE_AUTHORIZE_URL}${ESCAPE}[39m${ESCAPE}]8;;${BELL}\r\nPaste code here if prompted > `;
const CODEX_LOGIN_OUTPUT = `Follow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n1. Open this link in your browser and sign in to your account\r\n   ${ESCAPE}[94mhttps://auth.openai.com/codex/device${ESCAPE}[0m\r\n\r\n2. Enter this one-time code ${ESCAPE}[90m(expires in 15 minutes)${ESCAPE}[0m\r\n   ${ESCAPE}[94mWXYZ-12345${ESCAPE}[0m\r\n`;

function accessTokenExpiringAt(expiresAtMs: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp: expiresAtMs / 1000 })).toString('base64url')}.signature`;
}

test('the sign-in link and code are read from the real login output of Claude Code and Codex', () => {
  assert.deepEqual(readConnectPrompt('claude-code', CLAUDE_LOGIN_OUTPUT), { verificationUrl: CLAUDE_AUTHORIZE_URL, userCode: null, needsPastedCode: true });
  assert.deepEqual(readConnectPrompt('codex', CODEX_LOGIN_OUTPUT), { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'WXYZ-12345', needsPastedCode: false });
  assert.deepEqual(readConnectPrompt('codex', 'Welcome to Codex'), { verificationUrl: null, userCode: null, needsPastedCode: false });
});

test('a Connect runs the agent login in its own private home outside any session and reports only the link, the code and the outcome', async () => {
  const spawns: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const writes: string[] = [];
  const createdHomes: string[] = [];
  const broadcasts: AgentLoginStatus[][] = [];
  let emitOutput: (data: string) => void = () => {};
  let emitExit: (event: { exitCode: number }) => void = () => {};
  let sourceAfterLogin: LoginSource | null = null;
  const connect = createAgentConnect({
    loginsRoot: '/srv/glimmervoid/agent-logins',
    loginSource: async () => sourceAfterLogin,
    launchFor: (_agent, loginArgs) => ({ file: '/usr/bin/claude', args: loginArgs, env: { PATH: '/usr/bin' } }),
    onChange: (logins) => { broadcasts.push(logins); },
    makeHomeDir: async (directory) => { createdHomes.push(directory); },
    ptySpawn: (file, args, options): ConnectPty => {
      spawns.push({ file, args, env: options.env });
      return {
        onData: (listener) => { emitOutput = listener; },
        onExit: (listener) => { emitExit = listener; },
        write: (data) => { writes.push(data); },
        kill: () => {},
      };
    },
    setTimeoutFn: () => setTimeout(() => {}, 0),
    clearTimeoutFn: () => {},
  });

  assert.deepEqual(await connect.start('claude-code'), { ok: true });
  const claudeHome = path.join('/srv/glimmervoid/agent-logins', 'claude-code');
  assert.deepEqual(createdHomes, [claudeHome]);
  assert.deepEqual(spawns.map(({ file, args, env }) => [file, args, env.CLAUDE_CONFIG_DIR]), [['/usr/bin/claude', ['auth', 'login', '--claudeai'], claudeHome]]);

  emitOutput(CLAUDE_LOGIN_OUTPUT);
  const waiting = connect.logins().find((login) => login.agent === 'claude-code');
  assert.deepEqual([waiting?.state, waiting?.verificationUrl, waiting?.needsPastedCode], ['connecting', CLAUDE_AUTHORIZE_URL, true]);
  assert.equal(connect.submitCode('claude-code', `code${ESCAPE}[A`).ok, false);
  assert.deepEqual(connect.submitCode('claude-code', ' pasted#code '), { ok: true });
  assert.deepEqual(writes, ['pasted#code\r']);
  emitOutput('Invalid code. Please make sure the full code was copied.\r\n');
  const rejected = connect.logins().find((login) => login.agent === 'claude-code');
  assert.deepEqual([rejected?.state, rejected?.needsPastedCode, rejected?.reason], ['connecting', true, 'Claude Code did not accept that code. Copy the whole code from the sign-in page and paste it again.']);
  assert.deepEqual(connect.submitCode('claude-code', 'second#code'), { ok: true });
  assert.equal(connect.logins().find((login) => login.agent === 'claude-code')?.reason, null);

  sourceAfterLogin = 'glimmervoid';
  emitExit({ exitCode: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(connect.logins().find((login) => login.agent === 'claude-code'), {
    agent: 'claude-code', state: 'signed-in', source: 'glimmervoid', verificationUrl: null, userCode: null, needsPastedCode: false, reason: null,
  });
  assert.doesNotMatch(JSON.stringify(broadcasts), /Opening browser|Paste code here|pasted#code|second#code|Invalid code/);
});

test('a refresh still reading the login source when a Connect starts leaves the Connect waiting for its pasted code', async () => {
  let releaseClaudeSource: (source: LoginSource | null) => void = () => {};
  let emitOutput: (data: string) => void = () => {};
  const connect = createAgentConnect({
    loginsRoot: '/srv/glimmervoid/agent-logins',
    loginSource: (agent) => {
      if (agent !== 'claude-code') return Promise.resolve(null);
      return new Promise((resolve) => { releaseClaudeSource = resolve; });
    },
    launchFor: (_agent, loginArgs) => ({ file: '/usr/bin/claude', args: loginArgs, env: { PATH: '/usr/bin' } }),
    onChange: () => {},
    makeHomeDir: async () => {},
    ptySpawn: (): ConnectPty => ({
      onData: (listener) => { emitOutput = listener; },
      onExit: () => {},
      write: () => {},
      kill: () => {},
    }),
    setTimeoutFn: () => setTimeout(() => {}, 0),
    clearTimeoutFn: () => {},
  });

  const pendingRefresh = connect.refresh();
  assert.deepEqual(await connect.start('claude-code'), { ok: true });
  emitOutput(CLAUDE_LOGIN_OUTPUT);
  releaseClaudeSource(null);
  await pendingRefresh;

  const waiting = connect.logins().find((login) => login.agent === 'claude-code');
  assert.deepEqual([waiting?.state, waiting?.needsPastedCode], ['connecting', true]);
  assert.deepEqual(connect.submitCode('claude-code', 'pasted#code'), { ok: true });
});

test('remote logins fall back to the folder Glimmervoid connected only when the host has no login, and refresh it there', async () => {
  const nowMs = 1_800_000_000_000;
  const connectedRoot = '/srv/glimmervoid/agent-logins';
  const nearlyExpiredCodexToken = accessTokenExpiringAt(nowMs + 60_000);
  const filesByPath = new Map<string, string>([
    [path.join(connectedRoot, 'codex', 'auth.json'), JSON.stringify({ tokens: { access_token: nearlyExpiredCodexToken, account_id: 'account-1' } })],
    [path.join(connectedRoot, 'claude-code', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'connected-claude-token', expiresAt: nowMs + 3_600_000 } })],
  ]);
  const readTextFile = async (filePath: string) => filesByPath.get(filePath) ?? null;
  const codexRefreshHomes: (string | undefined)[] = [];
  const codexCredentials = createCodexCredentials({
    homeDir: '/srv/operator',
    connectedCodexHome: path.join(connectedRoot, 'codex'),
    env: { PATH: '/usr/bin' },
    now: () => nowMs,
    codexCommand: () => ({ file: '/usr/bin/codex', argsBeforeAppServer: [] }),
    refreshHostLogin: async (_command, env) => { codexRefreshHomes.push(env.CODEX_HOME); return true; },
    readTextFile,
  });
  assert.equal(await codexCredentials.loginSource(), 'glimmervoid');
  assert.deepEqual(await codexCredentials.hostLogin(), { ok: true, login: { accessToken: nearlyExpiredCodexToken, accountId: 'account-1', expiresAtMs: nowMs + 60_000 } });
  assert.deepEqual(codexRefreshHomes, [path.join(connectedRoot, 'codex')]);

  const claudeCredentials = createClaudeCredentials({
    platform: 'linux',
    homeDir: '/srv/operator',
    connectedConfigDir: path.join(connectedRoot, 'claude-code'),
    env: {},
    now: () => nowMs,
    claudeCommand: () => '/usr/bin/claude',
    readTextFile,
  });
  assert.equal(await claudeCredentials.loginSource(), 'glimmervoid');
  assert.deepEqual(await claudeCredentials.resolveArmToken(60), { ok: true, token: 'connected-claude-token' });

  filesByPath.set(path.join('/srv/operator', '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'host-claude-token', expiresAt: nowMs + 3_600_000 } }));
  assert.equal(await claudeCredentials.loginSource(), 'host');
  assert.deepEqual(await claudeCredentials.resolveArmToken(60), { ok: true, token: 'host-claude-token' });
});
