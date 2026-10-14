import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync, spawn } from '../server/child-process-safe.ts';
import { parseSshPublicKey } from '../server/core/ssh-signing-core.ts';
import { createSshSigner } from '../server/ssh-signing.ts';

const UNIX_SOCKET_PATH_MAX_BYTES = process.platform === 'darwin' ? 103 : 107;
const SOCKET_WAIT_LIMIT_MS = 10_000;
const AGENT_SOCKET_PATH_TEMPLATE = path.join(os.tmpdir(), 'gv-sign-wait-XXXXXX', 'auth-agent1', 'listener.sock');

function isExecutableFile(candidatePath: string): boolean {
  try {
    accessSync(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function forwardedAgentSkipReason(): string | false {
  const executableName = process.platform === 'win32' ? 'ssh-agent.exe' : 'ssh-agent';
  const searchDirectories = (process.env.PATH ?? '').split(path.delimiter).filter((directory) => directory !== '');
  const isSshAgentOnPath = searchDirectories.some((directory) => isExecutableFile(path.join(directory, executableName)));
  if (!isSshAgentOnPath) return 'ssh-agent is not on PATH';
  if (process.platform !== 'win32' && Buffer.byteLength(AGENT_SOCKET_PATH_TEMPLATE) > UNIX_SOCKET_PATH_MAX_BYTES) return `the temp dir leaves no room for a unix socket path: ${AGENT_SOCKET_PATH_TEMPLATE}`;
  return false;
}

async function waitForSocket(socketPath: string, agent: ReturnType<typeof spawn>, readAgentStderr: () => string): Promise<void> {
  const deadlineMs = Date.now() + SOCKET_WAIT_LIMIT_MS;
  while (Date.now() < deadlineMs) {
    const stats = await fs.lstat(socketPath).catch(() => null);
    if (stats?.isSocket()) return;
    if (agent.exitCode !== null || agent.signalCode !== null) throw new Error(`ssh-agent exited before listening on ${socketPath}: ${readAgentStderr().trim()}`);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error(`ssh-agent did not listen on ${socketPath} within ${SOCKET_WAIT_LIMIT_MS} ms: ${readAgentStderr().trim()}`);
}

test('signing waits for a forwarded agent that reconnects after the request arrives', { skip: forwardedAgentSkipReason() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-sign-wait-'));
  const keyPath = path.join(root, 'signing-key');
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
  const publicKey = parseSshPublicKey(await fs.readFile(`${keyPath}.pub`, 'utf8'));
  assert.ok(publicKey);
  const socketPath = path.join(root, 'auth-agent1', 'listener.sock');
  const signer = createSshSigner({ env: { ...process.env, SSH_AUTH_SOCK: '' }, agentSearchRoots: [root], agentWaitMs: 10_000 });
  const reconnectingAgent = { stop: () => {} };
  const signing = signer.signWithAgent({ publicKey, namespace: 'git', payload: Buffer.from('tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nprobe\n') });
  try {
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
    await fs.mkdir(path.dirname(socketPath), { mode: 0o700 });
    const agentStderrChunks: Buffer[] = [];
    const agent = spawn('ssh-agent', ['-D', '-a', socketPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    agent.stderr?.on('data', (chunk: Buffer) => { agentStderrChunks.push(chunk); });
    reconnectingAgent.stop = () => { agent.kill(); };
    await waitForSocket(socketPath, agent, () => Buffer.concat(agentStderrChunks).toString());
    await execFileAsync('ssh-add', [keyPath], { env: { ...process.env, SSH_AUTH_SOCK: socketPath } });
    const outcome = await signing;
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
  } finally {
    reconnectingAgent.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
