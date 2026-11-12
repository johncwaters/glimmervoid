import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

import { createBackend } from '../server/backend/backend.ts';
import { glimmervoidHomeDir } from '../server/config-store.ts';
import { execFileAsync } from '../server/child-process-safe.ts';
import { resolveFnoxPath, selfLaunch } from '../server/runtime-paths.ts';
import { mcpCredentialFor } from '../mcp/core/credentials.ts';
import { maskSecrets } from '../shared/secret-patterns.ts';
import { hasGit, git } from './helpers/git-fixture.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';
import { agentIngressBase, settleBackendShutdown } from './helpers/lanes.ts';
import { waitFor } from './helpers/wait-for.ts';

const SESSION_ID = 'secrets-canary-session';
const CANARY_VALUE = 'zq81-plain-canary-value';
const CANARY_MARKER = 'canary-marker-before-value';

const cannotRunFakeOp = process.platform === 'win32' || !fs.existsSync(resolveFnoxPath());
const FAKE_OP_SCRIPT = `#!/bin/sh
printf '%s' '${CANARY_VALUE}'
`;

interface CanaryBackend {
  tmpDir: string;
  fakeBin: string;
  projectDir: string;
  configPath: string;
  server: Server;
  backend: Backend;
  base: string;
}

async function bootCanaryBackend(): Promise<CanaryBackend> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-canary-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  git(['init', '-q'], projectDir);
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-canary-op-'));
  fs.writeFileSync(path.join(fakeBin, 'op'), FAKE_OP_SCRIPT, { mode: 0o755 });
  process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`;
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: 'secrets canary', path: projectDir }],
    repoRoots: [],
    autoResume: false,
    secrets: { byProject: { [projectDir]: { CANARY_KEY: { isAllowed: true }, REFUSED_KEY: { isAllowed: false } } } },
  }, null, 2), 'utf8');
  process.env.GLIMMERVOID_CONFIG = configPath;
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);
  return { tmpDir, fakeBin, projectDir, configPath, server, backend, base: await agentIngressBase(backend) };
}

async function runNeedCli(context: CanaryBackend, names: readonly string[]): Promise<{ exitCode: number; output: string }> {
  const session = context.backend.getSession(SESSION_ID);
  assert.ok(session?.agentToken, 'the session was minted an agent token');
  const agentUrl = `${context.base}/agent/${SESSION_ID}?t=${encodeURIComponent(session.agentToken)}`;
  const [launcherPath, ...launchArguments] = selfLaunch('cli');
  const run = execFileAsync(launcherPath, [...launchArguments, 'need', ...names], { env: { ...process.env, GLIMMERVOID_AGENT_URL: agentUrl }, encoding: 'utf8' });
  return run.then(
    ({ stdout, stderr }) => ({ exitCode: 0, output: `${stdout}${stderr}` }),
    (error: { code?: unknown; stdout?: unknown; stderr?: unknown }) => ({ exitCode: typeof error.code === 'number' ? error.code : -1, output: `${String(error.stdout ?? '')}${String(error.stderr ?? '')}` }),
  );
}

async function runNeedUntilSettled(context: CanaryBackend, names: readonly string[]): Promise<{ exitCode: number; output: string }> {
  const deadlineMs = Date.now() + 15_000;
  let attempt = await runNeedCli(context, names);
  while (attempt.exitCode === 30 && Date.now() < deadlineMs) attempt = await runNeedCli(context, names);
  return attempt;
}

function chooseSource(context: CanaryBackend): void {
  const savedConfig = JSON.parse(fs.readFileSync(context.configPath, 'utf8'));
  savedConfig.vault = { ...savedConfig.vault, manager: '1password', lookIn: 'Agents' };
  fs.writeFileSync(context.configPath, JSON.stringify(savedConfig, null, 2), 'utf8');
}

async function submitPrompt(context: CanaryBackend, prompt: string): Promise<void> {
  const session = context.backend.getSession(SESSION_ID);
  const hookToken = session?._hooks.token();
  assert.ok(hookToken, 'hook injection minted a token');
  const reply = await fetch(`${context.base}/hook/${SESSION_ID}/UserPromptSubmit?t=${encodeURIComponent(hookToken)}`, {
    method: 'POST', body: JSON.stringify({ prompt }), headers: { 'content-type': 'application/json' },
  });
  assert.equal(reply.status, 200);
}

async function askNeedOverMcp(context: CanaryBackend, names: readonly string[]): Promise<string> {
  const session = context.backend.getSession(SESSION_ID);
  assert.ok(session?.agentToken, 'the session was minted an agent token');
  const reply = await fetch(`${context.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      authorization: `Bearer ${mcpCredentialFor(SESSION_ID, session.agentToken)}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'secrets', arguments: { names } } }),
  });
  assert.equal(reply.status, 200);
  return reply.text();
}

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function filesHoldingText(directories: readonly string[], text: string, skippedFile: string): string[] {
  return directories.flatMap(filesUnder).filter((file) => file !== skippedFile && fs.readFileSync(file).includes(text));
}

test('a delivered canary reaches the env file only, never a trace, recording, MCP reply or need output', { skip: !hasGit() || cannotRunFakeOp }, async () => {
  assert.equal(maskSecrets(CANARY_VALUE), CANARY_VALUE, 'the canary has no secret shape, so only exact-value masking can hide it');
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  const previousPath = process.env.PATH;
  const context = await bootCanaryBackend();
  try {
    const session = context.backend.getSession(SESSION_ID);
    assert.ok(session, 'the boot loop created the configured session');
    session._hooks.inject();

    const noSource = await runNeedCli(context, ['CANARY_KEY']);
    assert.equal(noSource.exitCode, 30, noSource.output);
    assert.match(noSource.output, /no-source/);

    chooseSource(context);
    const delivered = await runNeedUntilSettled(context, ['CANARY_KEY']);
    assert.equal(delivered.exitCode, 0, delivered.output);
    const envFile = String(JSON.parse(delivered.output).envFile);
    await submitPrompt(context, `${CANARY_MARKER}-${CANARY_VALUE}${CANARY_VALUE}`);
    assert.equal(session.taskTitle?.startsWith(CANARY_MARKER), true, 'the prompt became the task title, its readable part kept');
    assert.ok(fs.readFileSync(envFile, 'utf8').includes(CANARY_VALUE), 'the value reached the env file');

    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    session.transition('first_output');
    const notifiedNotes: string[] = [];
    session.on('agent-attention', ({ note }: { note: string }) => notifiedNotes.push(note));
    const attentionReply = await fetch(`${context.base}/agent/${SESSION_ID}/attention`, {
      method: 'POST', body: JSON.stringify({ note: `${CANARY_MARKER} ${CANARY_VALUE}` }), headers: { 'content-type': 'application/json', authorization: `Bearer ${session.agentToken}` },
    });
    assert.equal(attentionReply.status, 200, 'the attention note was accepted');
    assert.deepEqual(notifiedNotes.map((note) => note.includes(CANARY_MARKER) && !note.includes(CANARY_VALUE)), [true], 'a value the agent repeats in a note is masked before the note is kept or notified');

    assert.equal((await runNeedCli(context, ['CANARY_KEY', 'UNSEEN_KEY'])).exitCode, 10, 'an unapproved name is pending');
    assert.equal((await runNeedCli(context, ['CANARY_KEY', 'REFUSED_KEY'])).exitCode, 20, 'a denied name outranks pending');

    const mcpReply = await askNeedOverMcp(context, ['CANARY_KEY']);
    assert.match(mcpReply, /delivered/);
    assert.equal(mcpReply.includes(CANARY_VALUE), false, 'the MCP reply carries no value');
    for (const output of [noSource.output, delivered.output]) assert.equal(output.includes(CANARY_VALUE), false, 'need output carries no value');

    session._recorder?.writeHeader({ agent: 'claude', cols: 80, rows: 24 });
    session._recorder?.writeHook('PostToolUse', { tool_name: 'Bash', tool_response: { stdout: `${CANARY_MARKER} ${CANARY_VALUE}` } });
    session.emit('conversation-records', { records: [{ ts: Date.now(), uuid: 'canary-prompt', parentUuid: null, vendorSessionId: 'canary-vendor', kind: 'prompt', text: `${CANARY_MARKER} ${CANARY_VALUE}` }] });
    const sinkDirectories = [context.tmpDir, glimmervoidHomeDir()];
    await waitFor(() => filesHoldingText(sinkDirectories, CANARY_MARKER, envFile).length >= 2, 'the trace and the recording both wrote the printed line', 10_000);
    await waitFor(() => fs.readFileSync(path.join(context.tmpDir, 'config.json'), 'utf8').includes(CANARY_MARKER), 'config persisted the task title', 10_000);
    assert.equal(fs.readFileSync(path.join(context.tmpDir, 'config.json'), 'utf8').includes(CANARY_VALUE.slice(0, 7)), false, 'a value cut by the title length limit leaves no readable head');

    assert.deepEqual(filesHoldingText(sinkDirectories, CANARY_VALUE, envFile), [], 'no glimmervoid file holds the canary');
  } finally {
    await settleBackendShutdown(context.backend);
    context.server.closeAllConnections();
    await closeServer(context.server);
    fs.rmSync(context.tmpDir, { recursive: true, force: true });
    fs.rmSync(context.fakeBin, { recursive: true, force: true });
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    process.env.PATH = previousPath;
  }
});
