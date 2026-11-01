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
import { spawnReplyForMcp } from '../mcp/core/replies.ts';
import { boardPicture } from '../mcp/core/board-reading.ts';
import { Board } from '../shared/contracts/whiteboard.ts';
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
  projectDir: string;
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
  return { tmpDir, server, backend, projectDir, mcpUrl: `http://127.0.0.1:${boundPort(server)}/mcp`, credential: mcpCredentialFor(SESSION_ID, session.agentToken) };
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
  assert.deepEqual(toolNames, ['attention', 'review', 'session', 'settings', 'show', 'whiteboard']);
  const sessionTool = tools.find((tool: { name: string }) => tool.name === 'session');
  assert.ok(sessionTool.inputSchema.properties.action.enum.includes('spawn'));
  assert.match(sessionTool.inputSchema.properties.agent.description, /claude-code, codex/);
  const showTool = tools.find((tool: { name: string }) => tool.name === 'show');
  assert.equal(showTool.inputSchema.properties.action, undefined);

  const called = await resultOf(await callMcp('tools/call', { name: 'session', arguments: { action: 'board' } }, credential));
  assert.notEqual(called.isError, true, JSON.stringify(called));
  const structured = called.structuredContent;
  assert.ok(typeof structured === 'object' && structured !== null && 'sessions' in structured && Array.isArray(structured.sessions));
  assert.ok(structured.sessions.some((row: { id: string }) => row.id === SESSION_ID));

  const settingsListed = await resultOf(await callMcp('tools/call', { name: 'settings', arguments: { action: 'list' } }, credential));
  assert.notEqual(settingsListed.isError, true, JSON.stringify(settingsListed));
  const settingsReply = settingsListed.structuredContent;
  assert.ok(typeof settingsReply === 'object' && settingsReply !== null && 'text' in settingsReply && typeof settingsReply.text === 'string');
  const settingsText = settingsReply.text;
  assert.ok(settingsText.split('\n').every((line) => / = .+ \(.+\)$/.test(line)), settingsText.slice(0, 300));
  assert.ok(settingsText.includes('autoResume = '));
  assert.equal(spawnReplyForMcp({ ok: true, sessionId: 'child-1', name: 'child' }).note?.toString().includes('glimmervoid '), false);
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

for (const agent of ['claude-code', 'codex']) {
  test(`a ${agent} session spawns with the MCP server url in argv and its credential only in the environment`, async () => {
    const hooksBaseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-mcp-spawn-'));
    const spawnCalls: { args: string[]; env: Record<string, string | undefined> }[] = [];
    const session = new Session({
      id: `mcp-spawn-${agent}`,
      name: `mcp spawn ${agent}`,
      path: process.cwd(),
      agent,
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
      assert.equal(spawnCall.env[MCP_CREDENTIAL_ENV], mcpCredentialFor(`mcp-spawn-${agent}`, session.agentToken));
      assert.ok(spawnCall.args.some((argument) => argument.includes('http://127.0.0.1:41234/mcp')), spawnCall.args.join(' '));
      assert.ok(spawnCall.args.some((argument) => argument.includes(MCP_CREDENTIAL_ENV)), spawnCall.args.join(' '));
      assert.ok(!spawnCall.args.some((argument) => argument.includes(session.agentToken ?? 'unset')));
    } finally {
      session.destroy();
      await fsp.rm(hooksBaseDir, { recursive: true, force: true });
    }
  });
}

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('show reads a file by a path relative to the session and refuses a path that is not a file', async () => {
  const { credential, projectDir } = bootedBackend();
  fs.writeFileSync(path.join(projectDir, 'pixel.png'), ONE_PIXEL_PNG);
  const shown = await resultOf(await callMcp('tools/call', { name: 'show', arguments: { path: 'pixel.png', caption: 'one pixel' } }, credential));
  assert.notEqual(shown.isError, true, JSON.stringify(shown));
  assert.deepEqual(shown.structuredContent, { ok: true, shown: { name: 'pixel.png', kind: 'image' } });

  for (const requestedPath of ['missing.png', '.']) {
    const refused = await resultOf(await callMcp('tools/call', { name: 'show', arguments: { path: requestedPath } }, credential));
    assert.equal(refused.isError, true, requestedPath);
  }
});

test('a whiteboard put that renames its board still returns its plan steps, get returns them too, and view returns a PNG of the board', async () => {
  const { credential } = bootedBackend();
  const created = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'new', title: 'mcp plan' } }, credential));
  assert.notEqual(created.isError, true, JSON.stringify(created));
  assert.equal(JSON.stringify(created).includes('glimmervoid whiteboard put'), false);
  const ops = [
    { op: 'board', title: 'mcp plan renamed' },
    { op: 'add', element: { kind: 'unit', id: 'schema', title: 'Add the schema' } },
    { op: 'add', element: { kind: 'unit', id: 'route', title: 'Serve the route', after: ['schema'] } },
  ];
  const put = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'put', board: 'mcp plan', ops } }, credential));
  assert.notEqual(put.isError, true, JSON.stringify(put));
  const putBody = put.structuredContent as { plan: { unitId: string; label: string }[]; layoutWarnings: string[] };
  assert.deepEqual(putBody.plan.map((step) => [step.unitId, step.label]), [['schema', '1'], ['route', '2']]);
  assert.ok(Array.isArray(putBody.layoutWarnings));

  const read = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'get', board: 'mcp plan renamed' } }, credential));
  assert.equal((read.structuredContent as { plan: unknown[] }).plan.length, 2);

  const viewed = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'view', board: 'mcp plan renamed' } }, credential));
  assert.notEqual(viewed.isError, true, JSON.stringify(viewed));
  const [picture] = viewed.content as { type: string; data: string; mimeType: string }[];
  assert.equal(picture?.type, 'image');
  assert.equal(picture?.mimeType, 'image/png');
  assert.deepEqual([...Buffer.from(picture?.data ?? '', 'base64').subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('whiteboard view pictures a board with a far-off box at a capped size', async () => {
  const { credential } = bootedBackend();
  await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'new', title: 'far board' } }, credential));
  const farBox = { op: 'add', element: { kind: 'box', id: 'far', title: 'Far', at: { x: 0, y: 100_000 } } };
  const put = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'put', board: 'far board', ops: [farBox] } }, credential));
  assert.notEqual(put.isError, true, JSON.stringify(put));
  const viewed = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'view', board: 'far board' } }, credential));
  assert.notEqual(viewed.isError, true, JSON.stringify(viewed));
  const [picture] = viewed.content as { data: string }[];
  const png = Buffer.from(picture?.data ?? '', 'base64');
  assert.ok(png.readUInt32BE(16) <= 1600 && png.readUInt32BE(20) <= 4800, `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
});

test('every board just past the picture width still pictures instead of being refused', () => {
  const refusedOffsets: number[] = [];
  for (let boxOffset = 1400; boxOffset <= 1800; boxOffset += 1) {
    const box = { kind: 'box', id: 'edge', title: 'Edge', at: { x: boxOffset, y: 0 } };
    const board = Board.parse({ id: 'edge-board', title: 'edge', version: 1, caption: null, columns: [], lanes: [], elements: { edge: box }, createdAt: 0, updatedAt: 0 });
    if (!boardPicture(board).ok) refusedOffsets.push(boxOffset);
  }
  assert.deepEqual(refusedOffsets, []);
});
