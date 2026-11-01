import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

import { createBackend } from '../server/backend/backend.ts';
import { REFUSAL_REASON } from '../server/core/agent-api-core.ts';
import { mcpCredentialFor } from '../mcp/core/credentials.ts';
import { MCP_CREDENTIAL_ENV } from '../mcp/core/agent-config.ts';
import { HookRouter } from '../detection/hook-source.ts';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';

const SESSION_ID = 'mcp-endpoint-session';

interface BootedBackend {
  tmpDir: string;
  server: Server;
  backend: Backend;
  mcpUrl: string;
  credential: string;
}

const booted: { context: BootedBackend | null; previousConfigPath: string | undefined } = { context: null, previousConfigPath: undefined };

function bootedBackend(): BootedBackend {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

async function boot(): Promise<BootedBackend> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-mcp-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projects: [{ id: SESSION_ID, name: 'mcp endpoint', path: projectDir }], repoRoots: [], autoResume: false }), 'utf8');
  process.env.GLIMMERVOID_CONFIG = configPath;
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);
  const session = backend.getSession(SESSION_ID);
  assert.ok(session, 'the boot loop created the configured session');
  session._hooks.inject();
  assert.ok(session.agentToken, 'the session was minted an agent token');
  return { tmpDir, server, backend, mcpUrl: `http://127.0.0.1:${boundPort(server)}/mcp`, credential: mcpCredentialFor(SESSION_ID, session.agentToken) };
}

let nextRequestId = 1;

function callMcp(method: string, params: Record<string, unknown>, credential: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
  if (credential !== null) headers.authorization = `Bearer ${credential}`;
  nextRequestId += 1;
  return fetch(bootedBackend().mcpUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: nextRequestId, method, params }) });
}

async function resultOf(response: Response): Promise<Record<string, unknown>> {
  assert.equal(response.status, 200);
  const responseText = await response.text();
  const dataLine = responseText.split('\n').find((line) => line.startsWith('data:'));
  const message: unknown = JSON.parse(dataLine === undefined ? responseText : dataLine.slice('data:'.length));
  assert.ok(typeof message === 'object' && message !== null && 'result' in message, JSON.stringify(message));
  const { result } = message;
  assert.ok(typeof result === 'object' && result !== null);
  return { ...result };
}

test.before(async () => {
  booted.previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  booted.context = await boot();
});

test.after(async () => {
  const context = booted.context;
  if (context) {
    await settleBackendShutdown(context.backend);
    context.server.closeAllConnections();
    await closeServer(context.server);
    fs.rmSync(context.tmpDir, { recursive: true, force: true });
  }
  if (booted.previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
  if (booted.previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = booted.previousConfigPath;
});

test('a session without its own worktree lists every grouped tool but push and reads its board through them', async () => {
  const { credential } = bootedBackend();
  const listed = await resultOf(await callMcp('tools/list', {}, credential));
  const tools = listed.tools;
  assert.ok(Array.isArray(tools));
  const toolNames = tools.map((tool: { name: string }) => tool.name).sort();
  assert.deepEqual(toolNames, ['attention', 'review', 'session', 'settings', 'whiteboard']);
  const sessionTool = tools.find((tool: { name: string }) => tool.name === 'session');
  assert.ok(sessionTool.inputSchema.properties.action.enum.includes('spawn'));

  const called = await resultOf(await callMcp('tools/call', { name: 'session', arguments: { action: 'board' } }, credential));
  assert.notEqual(called.isError, true, JSON.stringify(called));
  const structured = called.structuredContent;
  assert.ok(typeof structured === 'object' && structured !== null && 'sessions' in structured && Array.isArray(structured.sessions));
  assert.ok(structured.sessions.some((row: { id: string }) => row.id === SESSION_ID));
});

test('a refused verb comes back as a tool error the agent can read', async () => {
  const { credential } = bootedBackend();
  const called = await resultOf(await callMcp('tools/call', { name: 'session', arguments: { action: 'close', child: 'nobody' } }, credential));
  assert.equal(called.isError, true);
  assert.ok(Array.isArray(called.content) && called.content.length === 1);
});

test('a missing, wrong or misshapen credential gets the unknown-session refusal', async () => {
  const { credential } = bootedBackend();
  const [, secret = ''] = credential.split('.');
  for (const presented of [null, `${SESSION_ID}.not-the-token`, `no-such-session.${secret}`, secret, `${SESSION_ID}.`]) {
    const response = await callMcp('tools/list', {}, presented);
    assert.equal(response.status, 404, String(presented));
    assert.deepEqual(await response.json(), { ok: false, error: REFUSAL_REASON });
  }
});

test('a Claude Code session spawns with the MCP config and its credential in the environment, never in argv', async () => {
  const hooksBaseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-mcp-spawn-'));
  const spawnCalls: { args: string[]; env: Record<string, string | undefined> }[] = [];
  const session = new Session({
    id: 'mcp-spawn',
    name: 'mcp spawn',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    hookRouter: new HookRouter(),
    getHookPort: () => 41234,
    hooksBaseDir,
    ptySpawn: (_file, args, options) => { spawnCalls.push({ args, env: options.env ?? {} }); return fakePty(); },
  });
  try {
    await session.start();
    const [spawnCall] = spawnCalls;
    assert.ok(spawnCall, 'the session spawned its agent');
    assert.ok(session.agentToken);
    const credential = mcpCredentialFor('mcp-spawn', session.agentToken);
    assert.equal(spawnCall.env[MCP_CREDENTIAL_ENV], credential);
    const mcpConfigIndex = spawnCall.args.indexOf('--mcp-config');
    assert.ok(mcpConfigIndex >= 0, spawnCall.args.join(' '));
    const mcpConfig = JSON.parse(spawnCall.args[mcpConfigIndex + 1] ?? '');
    assert.equal(mcpConfig.mcpServers.glimmervoid.url, 'http://127.0.0.1:41234/mcp');
    assert.ok(!spawnCall.args.some((argument) => argument.includes(session.agentToken ?? 'unset')));
  } finally {
    session.destroy();
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
  }
});
