import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createBackend } from '../server/backend/backend.ts';
import { REFUSAL_REASON } from '../server/core/agent-api-core.ts';
import { waitFor } from './helpers/wait-for.ts';
import { mcpCredentialFor } from '../mcp/core/credentials.ts';
import { spawnReplyForMcp } from '../mcp/core/replies.ts';
import { boardPicture } from '../mcp/core/board-reading.ts';
import { layoutBoard } from '../shared/whiteboard-layout-core.ts';
import { Board } from '../shared/contracts/whiteboard.ts';
import { MCP_CREDENTIAL_ENV, MCP_URL_ENV } from '../mcp/core/agent-config.ts';
import { main as runStdioBridge } from '../mcp/stdio-bridge.ts';
import { Readable } from 'node:stream';
import { HookRouter } from '../detection/hook-source.ts';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';
import { agentIngressBase, settleBackendShutdown } from './helpers/lanes.ts';
import { AgentWakeReply } from '../shared/contracts/wakes.ts';
import { AgentMemoryReply } from '../shared/contracts/memory.ts';
import { createRequire } from 'node:module';
import { AgentCodemapReply, CodemapSetup } from '../shared/contracts/codemap.ts';
import { glimmervoidHomeDir } from '../server/config-store.ts';
import { clock } from '../shared/clock.ts';
import { repoKeyOf, setupPathOf } from '../server/codemap/codemap-store.ts';
import { runOperatorCodemapCli } from '../server/codemap/codemap-cli.ts';
import { runAgentApiCli } from '../server/agent-api-cli.ts';
import { AGENT_URL_ENV } from '../shared/contracts/session.ts';
import { checkWorktree } from '../server/codemap/codemap-wiring.ts';
import { createCodemapClient } from '../server/codemap/codemap-client.ts';
import { git } from './helpers/git-fixture.ts';

const SESSION_ID = 'mcp-endpoint-session';
const DONE_MEANS_OFF_SESSION_ID = 'mcp-done-means-off-contestant';
const STUDIO_BRANCH_SESSION_ID = 'mcp-studio-branch';

interface BootedBackend {
  tmpDir: string;
  server: Server;
  backend: Backend;
  mcpUrl: string;
  credential: string;
  studioBranchCredential: string;
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
  fs.writeFileSync(configPath, JSON.stringify({ projects: [{ id: SESSION_ID, name: 'mcp endpoint', path: projectDir }, { id: DONE_MEANS_OFF_SESSION_ID, name: 'done means off contestant', path: projectDir, raceId: 'race-ab', isDoneMeansOff: true }, { id: STUDIO_BRANCH_SESSION_ID, name: 'studio branch', path: projectDir, parent: { sessionId: SESSION_ID, box: { id: 'cm-project-root', title: 'project' } } }], repoRoots: [], autoResume: false, agentRules: { rules: ['Run the targeted tests before claiming done.'] } }), 'utf8');
  process.env.GLIMMERVOID_CONFIG = configPath;
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);
  const session = backend.getSession(SESSION_ID);
  assert.ok(session, 'the boot loop created the configured session');
  session._hooks.inject();
  assert.ok(session.agentToken, 'the session was minted an agent token');
  const studioBranch = backend.getSession(STUDIO_BRANCH_SESSION_ID);
  assert.ok(studioBranch, 'the boot loop created the Studio branch session');
  studioBranch._hooks.inject();
  assert.ok(studioBranch.agentToken, 'the Studio branch was minted an agent token');
  return { tmpDir, server, backend, projectDir, mcpUrl: `${await agentIngressBase(backend)}/mcp`, credential: mcpCredentialFor(SESSION_ID, session.agentToken), studioBranchCredential: mcpCredentialFor(STUDIO_BRANCH_SESSION_ID, studioBranch.agentToken) };
}

function firstTextOf(content: unknown): string {
  assert.ok(Array.isArray(content) && typeof content[0]?.text === 'string', JSON.stringify(content));
  return content[0].text;
}

let nextRequestId = 1;

function callMcp(method: string, params: Record<string, unknown>, credential: string | null, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
    ...extraHeaders,
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
  const { credential, studioBranchCredential } = bootedBackend();
  const listed = await resultOf(await callMcp('tools/list', {}, credential));
  const tools = listed.tools;
  assert.ok(Array.isArray(tools));
  const toolNames = tools.map((tool: { name: string }) => tool.name).sort();
  assert.deepEqual(toolNames, ['arena', 'attention', 'claim', 'memory', 'packs', 'preview', 'review', 'secrets', 'session', 'settings', 'show', 'wake', 'wargames', 'whiteboard', 'why'], 'a session outside Studio is offered no codemap tool');
  const studioBranchTools = (await resultOf(await callMcp('tools/list', {}, studioBranchCredential))).tools;
  assert.ok(Array.isArray(studioBranchTools) && studioBranchTools.some((tool: { name: string }) => tool.name === 'codemap'), 'a Studio branch keeps the codemap tool');
  const askedOutsideStudio = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'ask', about: 'lib', question: 'Which store?' } }, credential));
  assert.equal(askedOutsideStudio.isError, true);
  assert.match(JSON.stringify(askedOutsideStudio.content), /belongs to Studio[^"]*ask the operator in chat/);
  const sessionTool = tools.find((tool: { name: string }) => tool.name === 'session');
  assert.ok(sessionTool.inputSchema.properties.action.enum.includes('spawn'));
  assert.match(sessionTool.inputSchema.properties.agent.description, /claude-code, codex/);
  const showTool = tools.find((tool: { name: string }) => tool.name === 'show');
  assert.equal(showTool.inputSchema.properties.action, undefined);

  const listedWakes = await resultOf(await callMcp('tools/call', { name: 'wake', arguments: { action: 'list' } }, credential));
  assert.notEqual(listedWakes.isError, true, JSON.stringify(listedWakes));
  const wakeList = AgentWakeReply.parse(listedWakes.structuredContent);
  assert.deepEqual('wakes' in wakeList ? wakeList.wakes : null, []);

  const listedWargames = await resultOf(await callMcp('tools/call', { name: 'wargames', arguments: { action: 'matches' } }, credential));
  assert.notEqual(listedWargames.isError, true, JSON.stringify(listedWargames));
  assert.deepEqual(listedWargames.structuredContent, { ok: true, matches: [] });

  const called = await resultOf(await callMcp('tools/call', { name: 'session', arguments: { action: 'sessions' } }, credential));
  assert.notEqual(called.isError, true, JSON.stringify(called));
  const structured = called.structuredContent;
  assert.ok(typeof structured === 'object' && structured !== null && 'sessions' in structured && Array.isArray(structured.sessions));
  assert.ok(structured.sessions.some((row: { id: string }) => row.id === SESSION_ID));

  const whyOutsideCheckout = await resultOf(await callMcp('tools/call', { name: 'why', arguments: { target: 'notes.md:1' } }, credential));
  assert.equal(whyOutsideCheckout.isError, true);
  assert.match(JSON.stringify(whyOutsideCheckout.content), /is not inside a git checkout/);

  const settingsListed = await resultOf(await callMcp('tools/call', { name: 'settings', arguments: { action: 'list' } }, credential));
  assert.notEqual(settingsListed.isError, true, JSON.stringify(settingsListed));
  const settingsReply = settingsListed.structuredContent;
  assert.ok(typeof settingsReply === 'object' && settingsReply !== null && 'text' in settingsReply && typeof settingsReply.text === 'string');
  const settingsText = settingsReply.text;
  assert.ok(settingsText.split('\n').every((line) => / = .+ \(.+\)$/.test(line)), settingsText.slice(0, 300));
  assert.ok(settingsText.includes('autoResume = '));

  const packsGuide = await resultOf(await callMcp('tools/call', { name: 'packs', arguments: { action: 'guide' } }, credential));
  assert.notEqual(packsGuide.isError, true, JSON.stringify(packsGuide));
  assert.match(firstTextOf(packsGuide.content), /examples[\\/]packs[\\/]session-board: /);
  fs.mkdirSync(path.join(bootedBackend().projectDir, 'half-pack'));
  fs.writeFileSync(path.join(bootedBackend().projectDir, 'half-pack', 'pack.json'), JSON.stringify({ name: 'half-pack', version: 1, ui: { panels: [{ id: 'p', label: 'P', entry: 'missing.html' }] } }));
  const packChecked = await resultOf(await callMcp('tools/call', { name: 'packs', arguments: { action: 'check', path: 'half-pack' } }, credential));
  assert.match(firstTextOf(packChecked.content), /^Checked pack half-pack v1 at .*half-pack: fix the problems below, then check it again\nerror: pack\.json ui\.panels\.0: missing\.html is not a file in the pack/);
  assert.match(firstTextOf(packChecked.content), /error: .*missing\.html/);
  assert.equal(spawnReplyForMcp({ ok: true, sessionId: 'child-1', name: 'child' }).note?.toString().includes('glimmervoid '), false);

  const reviewComments = await resultOf(await callMcp('tools/call', { name: 'review', arguments: { action: 'comments' } }, credential));
  assert.notEqual(reviewComments.isError, true, JSON.stringify(reviewComments));
  assert.deepEqual(reviewComments.structuredContent, { ok: true, comments: [] });
  const unknownResolve = await resultOf(await callMcp('tools/call', { name: 'review', arguments: { action: 'resolve', commentId: 'c-0123abcd' } }, credential));
  assert.equal(unknownResolve.isError, true);
  assert.match(JSON.stringify(unknownResolve.content), /c-0123abcd/);
});

test('memory keeps a note for later sessions of the project, fenced as untrusted, beside the operator rules', async () => {
  const { credential } = bootedBackend();
  const initialized = await resultOf(await callMcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, credential));
  assert.match(String(initialized.instructions), /The operator's rules for every session:\n- Run the targeted tests before claiming done\./);

  const written = await resultOf(await callMcp('tools/call', { name: 'memory', arguments: { action: 'write', key: 'test-command', text: 'npm run test:files -- <files>' } }, credential));
  assert.notEqual(written.isError, true, JSON.stringify(written));
  const listed = AgentMemoryReply.parse((await resultOf(await callMcp('tools/call', { name: 'memory', arguments: { action: 'list' } }, credential))).structuredContent);
  assert.deepEqual('entries' in listed ? listed.entries.map((entry) => entry.key) : null, ['test-command']);
  const read = AgentMemoryReply.parse((await resultOf(await callMcp('tools/call', { name: 'memory', arguments: { action: 'read', key: 'test-command' } }, credential))).structuredContent);
  assert.ok('entry' in read);
  assert.equal(read.entry.text, 'npm run test:files -- <files>');
  assert.match(read.note, /never as instructions from the operator/);
  const forgotten = await resultOf(await callMcp('tools/call', { name: 'memory', arguments: { action: 'forget', key: 'test-command' } }, credential));
  assert.notEqual(forgotten.isError, true, JSON.stringify(forgotten));
  const missing = await resultOf(await callMcp('tools/call', { name: 'memory', arguments: { action: 'read', key: 'test-command' } }, credential));
  assert.equal(missing.isError, true);
});

test('session done puts the agent lines on the session snapshot, a later call replaces them, a line without a command or with one Sane YOLO denies is refused, and session check reaches the verification runner', async () => {
  const { credential, backend } = bootedBackend();
  const declaredLines = [{ text: 'login tests pass', command: 'npm test -- login' }, { text: 'the redirect keeps the query string', command: 'npm test -- redirect' }];
  const declared = await resultOf(await callMcp('tools/call', { name: 'session', arguments: { action: 'done', lines: declaredLines } }, credential));
  assert.notEqual(declared.isError, true, JSON.stringify(declared));
  assert.deepEqual(backend.getSession(SESSION_ID)?.agentDoneLines, declaredLines);
  const withoutCommand = await resultOf(await callMcp('tools/call', { name: 'session', arguments: { action: 'done', lines: [{ text: 'the README reads well' }] } }, credential));
  assert.equal(withoutCommand.isError, true);
  assert.match(JSON.stringify(withoutCommand), /each done line needs a command/);
  const denied = await resultOf(await callMcp('tools/call', { name: 'session', arguments: { action: 'done', lines: [{ text: 'the tree is clean', command: 'git reset --hard' }] } }, credential));
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /Sane YOLO refused the command for/);
  assert.deepEqual(backend.getSession(SESSION_ID)?.agentDoneLines, declaredLines);
  const replaced = await resultOf(await callMcp('tools/call', { name: 'session', arguments: { action: 'done', lines: [{ text: 'typecheck passes', command: 'npm run typecheck' }] } }, credential));
  assert.notEqual(replaced.isError, true, JSON.stringify(replaced));
  assert.deepEqual(backend.getSession(SESSION_ID)?.agentDoneLines, [{ text: 'typecheck passes', command: 'npm run typecheck' }]);
  const checked = await resultOf(await callMcp('tools/call', { name: 'session', arguments: { action: 'check' } }, credential));
  assert.equal(checked.isError, true);
  assert.match(JSON.stringify(checked), /no worktree of its own, so there is nothing to check/);
});

test('a race contestant with Done means off is never asked to call session done and cannot', async () => {
  const { backend } = bootedBackend();
  const contestant = backend.getSession(DONE_MEANS_OFF_SESSION_ID);
  assert.ok(contestant?.agentToken);
  contestant._hooks.inject();
  const credential = mcpCredentialFor(DONE_MEANS_OFF_SESSION_ID, contestant.agentToken);
  const initialized = await resultOf(await callMcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, credential));
  assert.doesNotMatch(String(initialized.instructions), /session done/);
  const operatorInitialized = await resultOf(await callMcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, bootedBackend().credential));
  assert.match(String(operatorInitialized.instructions), /call session done/);
  const called = await resultOf(await callMcp('tools/call', { name: 'session', arguments: { action: 'done', lines: [{ text: 'tests pass', command: 'npm test' }] } }, credential));
  assert.equal(called.isError, true);
  assert.deepEqual(contestant.agentDoneLines, []);
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
  const fromForeignPage = await callMcp('tools/list', {}, credential, { origin: 'https://attacker.example' });
  assert.equal(fromForeignPage.status, 404);
});

test('the stdio bridge answers a refused request with a JSON-RPC error carrying its id', async () => {
  const { mcpUrl } = bootedBackend();
  const bridgeOutput: string[] = [];
  const request = '{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n';
  await runStdioBridge(Readable.from([request]), { [MCP_URL_ENV]: mcpUrl, [MCP_CREDENTIAL_ENV]: `${SESSION_ID}.not-the-token` }, { write: (text: string) => bridgeOutput.push(text) });
  assert.deepEqual(bridgeOutput.map((line) => JSON.parse(line)), [{ jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'Glimmervoid could not be reached: the endpoint answered HTTP 404' } }]);
});

test('the stdio bridge carries a modern-envelope tool call through the standard request headers', async () => {
  const { mcpUrl, credential } = bootedBackend();
  const bridgeOutput: string[] = [];
  const envelope = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  const request = `${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'session', arguments: { action: 'limits' }, _meta: envelope } })}\n`;
  await runStdioBridge(Readable.from([request]), { [MCP_URL_ENV]: mcpUrl, [MCP_CREDENTIAL_ENV]: credential }, { write: (text: string) => bridgeOutput.push(text) });
  const [reply] = bridgeOutput.map((line) => JSON.parse(line));
  assert.equal(reply.id, 8);
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply));
});

test('the stdio bridge reaches an IPv6 loopback pack server with the bearer from the session env, starts a new MCP session when the server ends one, and offers no tools outside a Glimmervoid session', async (testContext) => {
  const seenAuthorizations = new Set<string | undefined>();
  const liveSessionIds = new Set<string>();
  let initializeCount = 0;
  let hasEndedASession = false;
  const packServer = http.createServer((request, response) => {
    seenAuthorizations.add(request.headers.authorization);
    let bodyText = '';
    request.on('data', (chunk: Buffer) => { bodyText += chunk.toString('utf8'); });
    request.on('end', () => {
      const message = JSON.parse(bodyText);
      const sentSessionId = request.headers['mcp-session-id'];
      if (message.method === 'initialize') {
        initializeCount += 1;
        const issuedSessionId = `pack-session-${initializeCount}`;
        liveSessionIds.add(issuedSessionId);
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': issuedSessionId });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method } }));
        return;
      }
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (typeof sentSessionId !== 'string' || !liveSessionIds.has(sentSessionId)) {
        response.writeHead(404).end();
        return;
      }
      if (!hasEndedASession) {
        hasEndedASession = true;
        liveSessionIds.delete(sentSessionId);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method } }));
    });
  });
  const port = await new Promise<number>((resolve) => packServer.listen(0, '::1', () => resolve((packServer.address() as AddressInfo).port)));
  testContext.after(() => closeServer(packServer));
  const packArgs = ['--pack-url', `http://[::1]:${port}/mcp`, '--pack-secret-env', 'GLIMMERVOID_PACK_HUB_TOKEN'];
  const requests = ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n', '{"jsonrpc":"2.0","method":"notifications/initialized"}\n', '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n', '{"jsonrpc":"2.0","id":3,"method":"tools/list"}\n'];
  const bridgeOutput: string[] = [];
  await runStdioBridge(Readable.from(requests), { [MCP_URL_ENV]: 'http://127.0.0.1:1/mcp', GLIMMERVOID_PACK_HUB_TOKEN: 'hub-bearer' }, { write: (text: string) => bridgeOutput.push(text) }, packArgs);
  const resultsById = Object.fromEntries(bridgeOutput.map((line) => JSON.parse(line)).map((reply) => [reply.id, reply.result]));
  assert.deepEqual(resultsById, { 1: { echoed: 'initialize' }, 2: { echoed: 'tools/list' }, 3: { echoed: 'tools/list' } });
  assert.equal(initializeCount, 2);
  assert.deepEqual([...seenAuthorizations], ['Bearer hub-bearer']);
  const outsideOutput: string[] = [];
  await runStdioBridge(Readable.from(['{"jsonrpc":"2.0","id":4,"method":"tools/list"}\n']), { GLIMMERVOID_PACK_HUB_TOKEN: 'hub-bearer' }, { write: (text: string) => outsideOutput.push(text) }, packArgs);
  assert.deepEqual(outsideOutput.map((line) => JSON.parse(line).result), [{ tools: [] }]);
  assert.equal(initializeCount, 2);
});

test('a call missing a field or carrying another action\'s field is refused naming the action and the fields', async () => {
  const { credential } = bootedBackend();
  const cases: [Record<string, unknown>, string][] = [
    [{ action: 'send', child: 'helper' }, 'session send needs text'],
    [{ action: 'close' }, 'session close needs child'],
    [{ action: 'limits', text: 'hello' }, 'session limits takes no other fields, so drop text'],
  ];
  for (const [toolArguments, expectedError] of cases) {
    const called = await resultOf(await callMcp('tools/call', { name: 'session', arguments: toolArguments }, credential));
    assert.equal(called.isError, true);
    assert.deepEqual(called.content, [{ type: 'text', text: expectedError }]);
  }
  const putWithTitle = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'put', board: 'flow', title: 'Flow' } }, credential));
  assert.deepEqual(putWithTitle.content, [{ type: 'text', text: 'whiteboard put takes board and ops, so drop title' }]);
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

async function newBoardAfterLeavingOthers(credential: string, title: string): Promise<Record<string, unknown>> {
  const listed = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'list' } }, credential));
  const boards = (listed.structuredContent as { boards: { id: string; connectedSessionIds: string[] }[] }).boards;
  for (const board of boards.filter((listedBoard) => listedBoard.connectedSessionIds.includes(SESSION_ID))) {
    await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'disconnect', board: board.id } }, credential));
  }
  return resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'new', title } }, credential));
}

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('show puts a file named relative to the session on a board as a card, counts as running show, and refuses a path that is not a file', async () => {
  const { credential, projectDir } = bootedBackend();
  fs.writeFileSync(path.join(projectDir, 'pixel.png'), ONE_PIXEL_PNG);
  const shown = await resultOf(await callMcp('tools/call', { name: 'show', arguments: { path: 'pixel.png', caption: 'one pixel' } }, credential));
  assert.notEqual(shown.isError, true, JSON.stringify(shown));
  assert.match(JSON.stringify(shown.structuredContent), /showed pixel\.png as box shown-1 on board/);
  assert.equal(bootedBackend().backend.getSession(SESSION_ID)?._ranCommands.has('show'), true);

  for (const requestedPath of ['missing.png', '.']) {
    const refused = await resultOf(await callMcp('tools/call', { name: 'show', arguments: { path: requestedPath } }, credential));
    assert.equal(refused.isError, true, requestedPath);
  }
});

test('a whiteboard put that renames its board still returns its plan steps, get returns them too, view returns a PNG of the board, and each put counts the puts since the session last viewed it', async () => {
  const { credential } = bootedBackend();
  const created = await newBoardAfterLeavingOthers(credential, 'mcp plan');
  assert.notEqual(created.isError, true, JSON.stringify(created));
  assert.equal(JSON.stringify(created).includes('glimmervoid whiteboard put'), false);
  const ops = [
    { op: 'board', title: 'mcp plan renamed' },
    { op: 'add', element: { kind: 'box', id: 'schema', title: 'Add the schema', place: 'plan', step: {} } },
    { op: 'add', element: { kind: 'box', id: 'route', title: 'Serve the route', place: 'plan', step: {} } },
    { op: 'add', element: { kind: 'wire', id: 'schema-to-route', from: 'schema', to: 'route' } },
  ];
  const put = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'put', board: 'mcp plan', ops } }, credential));
  assert.notEqual(put.isError, true, JSON.stringify(put));
  const putBody = put.structuredContent as { plan: { boxId: string; label: string; afterLabels: string[] }[]; layoutWarnings: string[] };
  assert.deepEqual(putBody.plan.map((step) => [step.boxId, step.label, step.afterLabels]), [['schema', '1', []], ['route', '2', ['1']]]);
  assert.ok(Array.isArray(putBody.layoutWarnings));

  const read = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'get', board: 'mcp plan renamed' } }, credential));
  assert.equal((read.structuredContent as { plan: unknown[] }).plan.length, 2);

  const viewed = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'view', board: 'mcp plan renamed' } }, credential));
  assert.notEqual(viewed.isError, true, JSON.stringify(viewed));
  const [picture] = viewed.content as { type: string; data: string; mimeType: string }[];
  assert.equal(picture?.type, 'image');
  assert.equal(picture?.mimeType, 'image/png');
  assert.deepEqual([...Buffer.from(picture?.data ?? '', 'base64').subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  const unviewedCountsAfterView: (string | undefined)[] = [];
  for (const id of ['cache', 'queue']) {
    const nextPut = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'put', board: 'mcp plan renamed', ops: [{ op: 'add', element: { kind: 'box', id, title: id, place: 'aside' } }] } }, credential));
    const { warnings = [] } = nextPut.structuredContent as { warnings?: string[] };
    unviewedCountsAfterView.push(warnings.find((warning) => warning.includes('since it last viewed this board'))?.split(' by ')[0]);
  }
  assert.deepEqual(unviewedCountsAfterView, ['1 put', '2 puts']);
});

test('whiteboard view pictures only a named region at twice its size, and render writes the whole board to a PNG or SVG file at the named path', async () => {
  const { credential, projectDir } = bootedBackend();
  await newBoardAfterLeavingOthers(credential, 'sharp board');
  const ops = [
    { op: 'add', element: { kind: 'box', id: 'near', title: 'Near', place: { at: { x: 0, y: 0 } } } },
    { op: 'add', element: { kind: 'box', id: 'far', title: 'Far', place: { at: { x: 900, y: 600 } } } },
  ];
  assert.notEqual((await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'put', board: 'sharp board', ops } }, credential))).isError, true);
  const pixelSizeOf = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

  const viewed = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'view', board: 'sharp board', region: { x: 0, y: 0, width: 300, height: 100 } } }, credential));
  assert.notEqual(viewed.isError, true, JSON.stringify(viewed));
  const [regionPicture] = viewed.content as { data: string }[];
  assert.deepEqual(pixelSizeOf(Buffer.from(regionPicture?.data ?? '', 'base64')), [600, 200]);

  const outside = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'view', board: 'sharp board', region: { x: 50_000, y: 50_000, width: 10, height: 10 } } }, credential));
  assert.equal(outside.isError, true);
  assert.match(JSON.stringify(outside.content), /the region lies outside the board/);

  const sliver = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'view', board: 'sharp board', region: { x: 10, y: 10, width: 0.1, height: 0.1 } } }, credential));
  assert.equal(sliver.isError, true);
  assert.match(JSON.stringify(sliver.content), /under one pixel of picture/);

  const rendered = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'render', board: 'sharp board', scale: 3 } }, credential));
  assert.notEqual(rendered.isError, true, JSON.stringify(rendered));
  const renderedBody = rendered.structuredContent as { wrote: string; format: string; width: number; height: number };
  assert.equal(renderedBody.format, 'png');
  const whole = pixelSizeOf(fs.readFileSync(renderedBody.wrote));
  assert.deepEqual(whole, [renderedBody.width, renderedBody.height]);
  assert.ok((whole[0] ?? 0) >= 1120 * 3, `the whole board at 3 pixels a unit, got ${whole.join('x')}`);

  const drawn = await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'render', board: 'sharp board', format: 'svg' } }, credential));
  assert.notEqual(drawn.isError, true, JSON.stringify(drawn));
  const svgPath = (drawn.structuredContent as { wrote: string }).wrote;
  assert.match(fs.readFileSync(svgPath, 'utf8'), /^<svg .*<\/svg>\n$/s);
  assert.equal(path.dirname(svgPath), path.dirname(renderedBody.wrote));
  assert.equal(fs.statSync(svgPath).mode & 0o077, 0, 'a render is readable by the server account only');

  const [small, large] = await Promise.all([1, 3].map(async (scale) => (await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'render', board: 'sharp board', scale } }, credential))).structuredContent as { wrote: string; width: number; height: number }));
  assert.notEqual(small?.wrote, large?.wrote);
  for (const reply of [small, large]) assert.deepEqual(pixelSizeOf(fs.readFileSync(reply?.wrote ?? '')), [reply?.width, reply?.height]);
  assert.equal(path.relative(projectDir, svgPath).startsWith('..'), true, 'a render lands in a folder Glimmervoid owns, never one the agent names');

  await resultOf(await callMcp('tools/call', { name: 'whiteboard', arguments: { action: 'delete', board: 'sharp board' } }, credential));
  await waitFor(() => fs.readdirSync(path.dirname(svgPath)).length === 0, 'deleting the board removes every render of it');
});

test('whiteboard view pictures a board with a far-off box at a capped size', async () => {
  const { credential } = bootedBackend();
  await newBoardAfterLeavingOthers(credential, 'far board');
  const farBox = { op: 'add', element: { kind: 'box', id: 'far', title: 'Far', place: { at: { x: 0, y: 100_000 } } } };
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
    const box = { kind: 'box', id: 'edge', title: 'Edge', place: { at: { x: boxOffset, y: 0 } } };
    const board = Board.parse({ id: 'edge-board', title: 'edge', version: 1, caption: null, elements: { edge: box }, createdAt: 0, updatedAt: 0 });
    if (!boardPicture(board, layoutBoard(board)).ok) refusedOffsets.push(boxOffset);
  }
  assert.deepEqual(refusedOffsets, []);
});

test('codemap answers map, where, impact and check from the project mainline commit, the same text on every read, overlays the calling session, shrinks the allowed imports mainline lost, gates only value imports from non-test files while refusing unresolved ones and new module cycles, exports a lint config and CODEMAP.md the setup enables and refuses a stale CODEMAP.md, and refuses an agent allowing a module import', async () => {
  const { studioBranchCredential: credential, projectDir } = bootedBackend();
  fs.mkdirSync(path.join(projectDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'lib', 'store.ts'), "// import { main } from '../main.ts';\n/* export * from '../main.ts'; */\nconst quotesPattern = /['\"]/;\nexport const hint = 'import data from \"../main.ts\" first';\nexport function readStore() { return quotesPattern.test(hint) ? 1 : 0; }\n");
  fs.writeFileSync(path.join(projectDir, 'main.ts'), "import { readStore } from './lib/store.ts';\nreadStore();\n");
  git(['init', '--quiet', '--initial-branch', 'main'], projectDir);
  git(['add', 'main.ts', 'lib/store.ts'], projectDir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'seed'], projectDir);
  const headSha = git(['rev-parse', 'HEAD'], projectDir).trim();

  const mapped = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'map' } }, credential))).structuredContent);
  assert.deepEqual(mapped.status, { sha: headSha, mainlineSha: headSha, state: 'current', reason: null });
  assert.match(mapped.text, /^\. \(2, in 0\): none$/m);
  const mappedAgain = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'map' } }, credential))).structuredContent);
  assert.equal(mappedAgain.text, mapped.text);

  const where = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'where', target: 'readStore' } }, credential))).structuredContent);
  assert.match(where.text, /imported by files: main\.ts/);
  assert.match(where.text, /reached from entrances: main\.ts/);
  const impact = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'impact', paths: ['lib/store.ts'] } }, credential))).structuredContent);
  assert.match(impact.text, /^1 changed files reach 1 dependent files/);
  const unknown = await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'where', target: 'missing.ts' } }, credential));
  assert.equal(unknown.isError, true);
  const setupPath = setupPathOf(glimmervoidHomeDir(), await repoKeyOf(projectDir) ?? '');
  const seeded = CodemapSetup.parse(JSON.parse(fs.readFileSync(setupPath, 'utf8')));
  assert.deepEqual({ gate: seeded.gate, allow: seeded.allow }, { gate: true, allow: [] }, 'the first map of a repo seeds its setup from mainline with the gate on');
  const allowed = await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'allow', from: 'lib', to: '.' } }, credential));
  assert.equal(allowed.isError, true);
  assert.match(JSON.stringify(allowed.content), /only the operator allows a module import/);

  const allowedOnMainline = { from: '.', to: 'lib', origin: 'allowed', reason: 'main reads the store', date: '2026-01-02', landed: false, fileImportCeiling: null };
  const awaitingItsBranch = { from: 'lib', to: 'tools', origin: 'allowed', reason: 'a branch not merged yet', date: '2026-01-03', landed: false, fileImportCeiling: null };
  const withoutCeiling = ({ fileImportCeiling: _ceiling, ...entry }: { fileImportCeiling: null }) => entry;
  fs.writeFileSync(setupPath, JSON.stringify({ version: 1, repo: await repoKeyOf(projectDir), gate: false, modules: ['lib'], allow: [withoutCeiling(allowedOnMainline), { from: 'lib', to: '.', origin: 'allowed', reason: 'a cycle once', date: '2026-01-02', landed: true }, withoutCeiling(awaitingItsBranch)], exports: [] }));
  const staleChecked = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'check' } }, credential))).structuredContent);
  assert.match(staleChecked.text, /allowed module imports this branch no longer has, .*: lib -> \./);
  const shrunk = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'shrink' } }, credential))).structuredContent);
  assert.match(shrunk.text, /none was dropped/, 'mapping mainline already ratcheted the setup, so an explicit shrink has nothing left');
  assert.deepEqual(CodemapSetup.parse(JSON.parse(fs.readFileSync(setupPath, 'utf8'))).allow, [{ ...allowedOnMainline, landed: true }, awaitingItsBranch]);
  assert.equal(await runOperatorCodemapCli(['allow', projectDir, 'lib', '.']), 1);
  assert.equal(await runOperatorCodemapCli(['allow', projectDir, 'lib', '.', '--reason', 'store reads config']), 0);
  assert.deepEqual(CodemapSetup.parse(JSON.parse(fs.readFileSync(setupPath, 'utf8'))).allow.at(-1), { from: 'lib', to: '.', origin: 'allowed', reason: 'store reads config', date: clock.dayKeyOf(clock.nowMs()), landed: false, fileImportCeiling: null });
  const allowBeforeAgentSetup = CodemapSetup.parse(JSON.parse(fs.readFileSync(setupPath, 'utf8'))).allow;
  const previousAgentUrl = process.env[AGENT_URL_ENV];
  process.env[AGENT_URL_ENV] = `${await agentIngressBase(bootedBackend().backend)}/agent/${STUDIO_BRANCH_SESSION_ID}?t=${bootedBackend().backend.getSession(STUDIO_BRANCH_SESSION_ID)?.agentToken}`;
  const operatorSetupFromSession = await runAgentApiCli(['codemap', 'setup', projectDir, '--gate', 'off']).finally(() => {
    if (previousAgentUrl === undefined) delete process.env[AGENT_URL_ENV];
    if (previousAgentUrl !== undefined) process.env[AGENT_URL_ENV] = previousAgentUrl;
  });
  assert.equal(operatorSetupFromSession, 1);
  assert.equal(CodemapSetup.parse(JSON.parse(fs.readFileSync(setupPath, 'utf8'))).gate, false, 'an operator setup typed inside a session is refused, never sent as a gate-on request');
  const gatedByAgent = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'setup' } }, credential))).structuredContent);
  assert.match(gatedByAgent.text, /import gate of .* is on: 3 allowed module imports/);
  assert.deepEqual(CodemapSetup.parse(JSON.parse(fs.readFileSync(setupPath, 'utf8'))), { ...CodemapSetup.parse(JSON.parse(fs.readFileSync(setupPath, 'utf8'))), gate: true, allow: allowBeforeAgentSetup }, 'an agent turns an opted-out gate back on and keeps the allow list');
  const gatedAgain = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'setup' } }, credential))).structuredContent);
  assert.match(gatedAgain.text, /is on already/);

  const branchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-branch-'));
  git(['worktree', 'add', '--quiet', '-b', 'tools', branchDir], projectDir);
  fs.mkdirSync(path.join(branchDir, 'tools'));
  fs.writeFileSync(path.join(branchDir, 'tools', 'types.ts'), "import type { readStore } from '../lib/store.ts';\nexport type Reader = typeof readStore;\n");
  fs.writeFileSync(path.join(branchDir, 'tools', 'types.test.ts'), "import { readStore } from '../lib/store.ts';\nreadStore();\n");
  fs.writeFileSync(path.join(branchDir, 'tools', 'look.css'), 'a {}\n');
  fs.writeFileSync(path.join(branchDir, 'tools', 'page.ts'), "import './look.css';\nimport { gone } from './gone.ts';\nimport '../dist/built.js';\ngone();\n");
  fs.writeFileSync(path.join(branchDir, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(branchDir, 'tools', 'fixture.test.ts'), "const source = \"import { x } from './nowhere.ts';\";\n");
  fs.mkdirSync(path.join(branchDir, 'tools', 'test'));
  fs.writeFileSync(path.join(branchDir, 'tools', 'test', 'bridge.ts'), "export { readStore } from '../../lib/store.ts';\n");
  fs.writeFileSync(path.join(branchDir, 'tools', 'bridged.ts'), "import { readStore } from './test/bridge.ts';\nreadStore();\n");
  fs.writeFileSync(path.join(branchDir, 'tools', 'named-type.ts'), "import type from '../lib/store.ts';\ntype();\n");
  fs.writeFileSync(path.join(branchDir, 'lib', 'data.json'), '{}\n');
  fs.writeFileSync(path.join(branchDir, 'tools', 'data.ts'), "import data from '../lib/data.json';\nexport { data };\n");
  fs.writeFileSync(path.join(branchDir, 'lib', 'back.ts'), "import { data } from '../tools/data.ts';\nexport { data };\n");
  git(['add', '-A'], branchDir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'tools'], branchDir);
  fs.writeFileSync(setupPath, JSON.stringify({ version: 2, repo: await repoKeyOf(projectDir), gate: true, modules: ['lib', 'tools'], allow: [{ from: '.', to: 'lib', origin: 'seeded', fileImportCeiling: null }], exports: [] }));
  const branchCheck = await checkWorktree({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(), worktreeDir: branchDir, mainlineSha: headSha });
  assert.ok(branchCheck.ok && branchCheck.isRefusing, JSON.stringify(branchCheck));
  assert.match(branchCheck.text, /relative imports that resolve to no file in the repo, so they cannot be judged: tools\/page\.ts imports \.\/gone\.ts$/m);
  const judgedImports = branchCheck.text.split('\n').filter((line) => line.startsWith('    ')).map((line) => line.trim()).sort();
  assert.deepEqual(judgedImports, ['lib/back.ts imports tools/data.ts', 'tools/data.ts imports lib/data.json', 'tools/named-type.ts imports lib/store.ts', 'tools/test/bridge.ts imports lib/store.ts']);
  assert.doesNotMatch(branchCheck.text, /look\.css|built\.js|nowhere/);
  assert.match(branchCheck.text, /module cycle lib, tools holds .*: lib -> tools, tools -> lib$/m);
  const cycleSetupWithCeiling = (fileImportCeiling: number) => JSON.stringify({ version: 2, repo: projectDir, gate: true, modules: ['lib', 'tools'], allow: [{ from: '.', to: 'lib', origin: 'seeded', fileImportCeiling: null }, { from: 'lib', to: 'tools', origin: 'allowed', reason: 'the store reads tool data', date: '2026-11-19', landed: false, fileImportCeiling }, { from: 'tools', to: 'lib', origin: 'allowed', reason: 'tools read the store', date: '2026-11-19', landed: false, fileImportCeiling: null }], exports: [] });
  fs.writeFileSync(setupPath, cycleSetupWithCeiling(1));
  const allowedCycleCheck = await checkWorktree({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(), worktreeDir: branchDir, mainlineSha: headSha });
  assert.ok(allowedCycleCheck.ok, JSON.stringify(allowedCycleCheck));
  assert.doesNotMatch(allowedCycleCheck.text, /crossed wire/);
  assert.match(allowedCycleCheck.text, /module cycle lib, tools holds .*: lib -> tools, tools -> lib$/m);
  assert.doesNotMatch(allowedCycleCheck.text, /^    /m);
  fs.writeFileSync(path.join(branchDir, 'lib', 'again.ts'), "import { data } from '../tools/data.ts';\nexport const again = data;\n");
  const grownWireCheck = await checkWorktree({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(), worktreeDir: branchDir, mainlineSha: headSha });
  assert.ok(grownWireCheck.ok && grownWireCheck.isRefusing, JSON.stringify(grownWireCheck));
  assert.match(grownWireCheck.text, /lib -> tools is a crossed wire held to 1 file imports and now has 2[^\n]*\n {4}lib\/again\.ts imports tools\/data\.ts\n/, 'an uncommitted file growing a crossed wire is judged and named first');
  fs.rmSync(path.join(branchDir, 'lib', 'again.ts'));
  fs.writeFileSync(setupPath, cycleSetupWithCeiling(0));
  const loweredCeilingCheck = await checkWorktree({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(), worktreeDir: branchDir, mainlineSha: headSha });
  assert.match(loweredCeilingCheck.ok ? loweredCeilingCheck.text : '', /lib -> tools is a crossed wire held to 0 file imports and now has 1/);
  const cycleOnMainlineSha = git(['rev-parse', 'HEAD'], branchDir).trim();
  fs.writeFileSync(path.join(branchDir, 'README.md'), 'tools\n');
  git(['add', '-A'], branchDir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'readme'], branchDir);
  const inheritedCycleCheck = await checkWorktree({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(), worktreeDir: branchDir, mainlineSha: cycleOnMainlineSha });
  assert.ok(inheritedCycleCheck.ok && !inheritedCycleCheck.isRefusing, JSON.stringify(inheritedCycleCheck));
  assert.doesNotMatch(inheritedCycleCheck.text, /crossed wire/, 'a branch adding no file import is never refused for a crossed wire mainline already holds past its ceiling');
  fs.writeFileSync(setupPath, cycleSetupWithCeiling(1));

  const exportNotEnabled = await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'export', kind: 'map' } }, credential));
  assert.equal(exportNotEnabled.isError, true);
  assert.match(JSON.stringify(exportNotEnabled.content), /does not enable the map export; only the operator enables one/);
  assert.match(JSON.stringify(exportNotEnabled.content), /--exports map\)/);
  assert.equal(await runOperatorCodemapCli(['setup', projectDir, '--exports', 'lint,map']), 0);
  fs.writeFileSync(path.join(projectDir, '.dependency-cruiser.cjs'), 'module.exports = { forbidden: [] };\n');
  const handWrittenRefused = await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'export', kind: 'lint' } }, credential));
  assert.match(JSON.stringify(handWrittenRefused.content), /left \.dependency-cruiser\.cjs in .* alone: it was not written by codemap export/);
  fs.rmSync(path.join(projectDir, '.dependency-cruiser.cjs'));
  const outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-outside-')), 'victim.txt');
  fs.writeFileSync(outsideFile, 'Written by glimmervoid codemap export, format 1.\n');
  fs.symlinkSync(outsideFile, path.join(projectDir, 'CODEMAP.md'));
  const symlinkRefused = await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'export', kind: 'map' } }, credential));
  assert.match(JSON.stringify(symlinkRefused.content), /it is not a regular file/);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'Written by glimmervoid codemap export, format 1.\n');
  fs.rmSync(path.join(projectDir, 'CODEMAP.md'));
  assert.deepEqual(CodemapSetup.parse(JSON.parse(fs.readFileSync(setupPath, 'utf8'))).exports, ['lint', 'map']);
  const lintExport = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'export', kind: 'lint' } }, credential))).structuredContent);
  assert.match(lintExport.text, /^codemap export wrote \.dependency-cruiser\.cjs into /);
  const lintConfig = createRequire(import.meta.url)(path.join(projectDir, '.dependency-cruiser.cjs'));
  assert.equal(lintConfig.allowedSeverity, 'error');
  assert.ok(lintConfig.allowed.some((rule: { from: { path?: string }; to: { path?: string } }) => rule.from.path === '^lib/' && rule.to.path === '^tools/'), JSON.stringify(lintConfig.allowed));
  assert.ok(lintConfig.allowed.some((rule: { from: { path?: string; pathNot?: string }; to: { pathNot?: string } }) => rule.from.path === undefined && rule.from.pathNot === '^(lib|tools)/' && rule.to.pathNot === '^(lib|tools)/'), JSON.stringify(lintConfig.allowed));
  const missingMapCheck = await checkWorktree({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(), worktreeDir: branchDir, mainlineSha: cycleOnMainlineSha });
  assert.ok(missingMapCheck.ok && missingMapCheck.isRefusing, JSON.stringify(missingMapCheck));
  assert.match(missingMapCheck.text, /CODEMAP\.md is missing at the branch head; run codemap export map/);
  assert.match(missingMapCheck.text, /\.dependency-cruiser\.cjs is missing at the branch head; run codemap export lint/);
  const mapExport = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'export', kind: 'map' } }, credential))).structuredContent);
  assert.match(mapExport.text, /^codemap export wrote CODEMAP\.md into .*It maps the source committed at /);
  const exportedMap = fs.readFileSync(path.join(projectDir, 'CODEMAP.md'), 'utf8');
  assert.match(exportedMap, /^# Code map\n\nWritten by glimmervoid codemap export, format 1\.[\s\S]*\nlib \(1, in 1\): none\n/);
  git(['add', 'CODEMAP.md', '.dependency-cruiser.cjs'], projectDir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'map'], projectDir);
  const exportedMapSha = git(['rev-parse', 'HEAD'], projectDir).trim();
  const currentMapCheck = await checkWorktree({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(), worktreeDir: projectDir, mainlineSha: exportedMapSha });
  assert.ok(currentMapCheck.ok && !currentMapCheck.isRefusing, JSON.stringify(currentMapCheck));
  fs.copyFileSync(path.join(projectDir, 'CODEMAP.md'), path.join(branchDir, 'CODEMAP.md'));
  fs.copyFileSync(path.join(projectDir, '.dependency-cruiser.cjs'), path.join(branchDir, '.dependency-cruiser.cjs'));
  git(['add', 'CODEMAP.md', '.dependency-cruiser.cjs'], branchDir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'stale map'], branchDir);
  const staleMapCheck = await checkWorktree({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(), worktreeDir: branchDir, mainlineSha: cycleOnMainlineSha });
  assert.ok(staleMapCheck.ok && staleMapCheck.isRefusing, JSON.stringify(staleMapCheck));
  assert.match(staleMapCheck.text, /CODEMAP\.md at the branch head does not match its code map/);
  assert.doesNotMatch(staleMapCheck.text, /dependency-cruiser/);
  fs.writeFileSync(path.join(branchDir, 'CODEMAP.md'), fs.readFileSync(path.join(branchDir, 'CODEMAP.md'), 'utf8').replace('format 1.', 'format 0.'));
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-am', 'older format'], branchDir);
  const olderFormatCheck = await checkWorktree({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(), worktreeDir: branchDir, mainlineSha: cycleOnMainlineSha });
  assert.ok(olderFormatCheck.ok && !olderFormatCheck.isRefusing, JSON.stringify(olderFormatCheck));
  assert.match(olderFormatCheck.text, /CODEMAP\.md was written in export format 0 .*so it is not judged/);

  const overlaid = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'overlay', layer: 'session' } }, credential))).structuredContent);
  assert.match(overlaid.text, /^codemap overlay on the map of project: session studio branch changes \d+ files/);
  const cleared = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'overlay', layer: 'none' } }, credential))).structuredContent);
  assert.match(cleared.text, /shows no overlay/);
});

test('codemap check ignores pre-existing unallowed mainline imports on touched files and settles newly supported scanner languages once without re-seeding tracked languages', async () => {
  const { studioBranchCredential: credential, projectDir } = bootedBackend();
  fs.mkdirSync(path.join(projectDir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'site'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'lib', 'store.ts'), 'export const storeValue = 1;\n');
  fs.writeFileSync(path.join(projectDir, 'tools', 'helper.ts'), "import { storeValue } from '../lib/store.ts';\nexport const helperValue = storeValue + 1;\n");
  fs.writeFileSync(path.join(projectDir, 'site', 'page.astro'), "---\nimport { storeValue } from '../lib/store.ts';\n---\n<div>{storeValue}</div>\n");
  git(['init', '--quiet', '--initial-branch', 'main'], projectDir);
  git(['add', '-A'], projectDir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'seed'], projectDir);
  const mainlineSha = git(['rev-parse', 'HEAD'], projectDir).trim();
  const repoKey = await repoKeyOf(projectDir);
  assert.ok(repoKey);
  const setupPath = setupPathOf(glimmervoidHomeDir(), repoKey);
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  fs.writeFileSync(setupPath, JSON.stringify({ version: 2, repo: repoKey, gate: true, modules: ['lib', 'site', 'tools'], allow: [], exports: [] }));

  const branchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-preexisting-'));
  git(['worktree', 'add', '--quiet', '-b', 'touch-astro', branchDir], projectDir);
  fs.writeFileSync(path.join(branchDir, 'site', 'page.astro'), "---\nimport { storeValue } from '../lib/store.ts';\n---\n<section>{storeValue}</section>\n");
  const untouchedImportCheck = await checkWorktree({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(), worktreeDir: branchDir, mainlineSha });
  assert.ok(untouchedImportCheck.ok && !untouchedImportCheck.isRefusing, JSON.stringify(untouchedImportCheck));

  fs.writeFileSync(path.join(branchDir, 'site', 'page.astro'), "---\nimport { storeValue } from '../lib/store.ts';\nimport { helperValue } from '../tools/helper.ts';\n---\n<section>{storeValue}{helperValue}</section>\n");
  const addedImportCheck = await checkWorktree({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(), worktreeDir: branchDir, mainlineSha });
  assert.ok(addedImportCheck.ok && addedImportCheck.isRefusing, JSON.stringify(addedImportCheck));
  assert.match(addedImportCheck.text, /site -> tools is not allowed/);
  assert.match(addedImportCheck.text, /site\/page\.astro imports tools\/helper\.ts/);
  assert.doesNotMatch(addedImportCheck.text, /site -> lib/);

  const mapped = AgentCodemapReply.parse((await resultOf(await callMcp('tools/call', { name: 'codemap', arguments: { action: 'map' } }, credential))).structuredContent);
  assert.equal(mapped.status.mainlineSha, mainlineSha);
  const settled = CodemapSetup.parse(JSON.parse(fs.readFileSync(setupPath, 'utf8')));
  assert.ok(settled.languages?.includes('astro'));
  assert.ok(settled.languages?.includes('typescript'));
  assert.deepEqual(settled.allow, [{ from: 'site', to: 'lib', origin: 'seeded', fileImportCeiling: null }]);

  fs.writeFileSync(path.join(branchDir, 'site', 'page.astro'), "---\nimport { storeValue } from '../lib/store.ts';\n---\n<section>{storeValue}</section>\n");
  fs.writeFileSync(path.join(branchDir, 'site', 'second.astro'), "---\nimport { storeValue } from '../lib/store.ts';\n---\n<p>{storeValue}</p>\n");
  const newAstroFileCheck = await checkWorktree({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(), worktreeDir: branchDir, mainlineSha });
  assert.ok(newAstroFileCheck.ok && !newAstroFileCheck.isRefusing, JSON.stringify(newAstroFileCheck));
});
