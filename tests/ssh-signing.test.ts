import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync, spawn } from '../server/child-process-safe.ts';
import { parseSshPublicKey } from '../server/core/ssh-signing-core.ts';
import { createSshSigner, installCommitSigningShim } from '../server/ssh-signing.ts';
import http from 'node:http';
import { createHostSigningKeyStore } from '../server/commit-signing.ts';
import { createAgentIngressApp } from '../server/backend/backend-http.ts';
import { HookRouter } from '../detection/hook-source.ts';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

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
  const signer = createSshSigner({ env: { ...process.env, SSH_AUTH_SOCK: '' }, agentSearchRoots: [root], agentWaitMs: 10_000, agentRescanIntervalMs: 50 });
  const reconnectingAgent = { stop: () => {} };
  const signing = signer.sign({ publicKey, namespace: 'git', payload: Buffer.from('tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nprobe\n') });
  try {
    await new Promise((resolve) => { setTimeout(resolve, 200); });
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

test('signing finds the key in an agent app socket when the inherited agent holds none', { skip: forwardedAgentSkipReason() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-sign-app-'));
  const keyPath = path.join(root, 'signing-key');
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
  const publicKey = parseSshPublicKey(await fs.readFile(`${keyPath}.pub`, 'utf8'));
  assert.ok(publicKey);
  const socketPath = path.join(root, 'socket.ssh');
  const agentStderrChunks: Buffer[] = [];
  const agent = spawn('ssh-agent', ['-D', '-a', socketPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  agent.stderr?.on('data', (chunk: Buffer) => { agentStderrChunks.push(chunk); });
  try {
    await waitForSocket(socketPath, agent, () => Buffer.concat(agentStderrChunks).toString());
    await execFileAsync('ssh-add', [keyPath], { env: { ...process.env, SSH_AUTH_SOCK: socketPath } });
    const signer = createSshSigner({ env: { ...process.env, SSH_AUTH_SOCK: '' }, agentSearchRoots: [], wellKnownAgentSockets: [socketPath], agentWaitMs: 0 });
    const outcome = await signer.sign({ publicKey, namespace: 'git', payload: Buffer.from('tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nprobe\n') });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
  } finally {
    agent.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function startedSessionIn(projectPath: string, { port, hooksBaseDir, signingProgram, hostSigningKeys }: { port: number; hooksBaseDir: string; signingProgram: string; hostSigningKeys: ReturnType<typeof createHostSigningKeyStore> }): Promise<{ session: Session; env: Record<string, string | undefined> }> {
  const spawnedEnvs: Record<string, string | undefined>[] = [];
  const session = new Session({
    id: `host-signing-${path.basename(projectPath)}`,
    name: 'host-signing',
    path: projectPath,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (_file, _args, options) => { spawnedEnvs.push(options.env ?? {}); return fakePty(); },
    hookRouter: new HookRouter(),
    getHookPort: () => port,
    hooksBaseDir,
    commitSigningProgram: signingProgram,
    resolveHostSigningEnv: hostSigningKeys.gitEnvFor,
  });
  await session.start();
  return { session, env: { ...process.env, SSH_AUTH_SOCK: '', ...spawnedEnvs[0] } };
}

async function newRepository(root: string, name: string): Promise<string> {
  const repositoryPath = path.join(root, name);
  await execFileAsync('git', ['init', '-q', '-b', 'main', repositoryPath]);
  return repositoryPath;
}

test('a session commit is signed with the host signing key outside the session, and any repository with its own signing settings keeps them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-host-sign-'));
  const hostSigningKeys = createHostSigningKeyStore({ folder: path.join(root, 'commit-signing') });
  const signingProgram = installCommitSigningShim({ binDir: path.join(root, 'bin'), cliLaunch: [process.execPath, path.resolve('bin/glimmervoid.ts')] });
  assert.ok(signingProgram);
  const sessions: Session[] = [];
  const app = createAgentIngressApp({
    allowedHosts: [],
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) },
    getSession: (id) => sessions.find((candidate) => candidate.id === id) ?? null,
    getUsage: () => ({ ingestStatusline: () => {} }),
    sshSigner: createSshSigner({ env: { ...process.env, SSH_AUTH_SOCK: '' }, agentSearchRoots: [], wellKnownAgentSockets: [], agentWaitMs: 0, hostSigningKeys }),
    logger: { warn: () => {} },
  });
  const server = http.createServer(app);
  await listenOnLoopback(server);
  try {
    const hostKey = await hostSigningKeys.setup();
    assert.match(hostKey.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    const privateKeyStats = await fs.stat(path.join(root, 'commit-signing', 'signing-key'));
    assert.equal(privateKeyStats.mode & 0o077, 0, 'the private key is readable by its owner only');

    const plainRepository = await newRepository(root, 'plain');
    const plain = await startedSessionIn(plainRepository, { port: boundPort(server), hooksBaseDir: root, signingProgram, hostSigningKeys });
    sessions.push(plain.session);
    assert.ok(!Object.values(plain.env).some((value) => value?.includes('PRIVATE KEY')), 'no session variable carries the private key');
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'signed by the host key'], { cwd: plainRepository, env: plain.env });
    const allowedSigners = path.join(root, 'allowed-signers');
    await fs.writeFile(allowedSigners, `test@glimmervoid.invalid ${hostKey.publicKeyText}\n`);
    const verified = await execFileAsync('git', ['-c', `gpg.ssh.allowedSignersFile=${allowedSigners}`, 'verify-commit', 'HEAD'], { cwd: plainRepository, encoding: 'utf8' });
    assert.match(verified.stderr, /Good "git" signature/);

    const ownSigningRepository = await newRepository(root, 'own-signing');
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: ownSigningRepository });
    const ownSigning = await startedSessionIn(ownSigningRepository, { port: boundPort(server), hooksBaseDir: root, signingProgram, hostSigningKeys });
    sessions.push(ownSigning.session);
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'unsigned as configured'], { cwd: ownSigningRepository, env: ownSigning.env });
    const ownCommit = await execFileAsync('git', ['cat-file', 'commit', 'HEAD'], { cwd: ownSigningRepository, encoding: 'utf8' });
    assert.ok(!ownCommit.stdout.includes('gpgsig'), 'a project that sets its own signing is left as configured');

    const tagSigningRepository = await newRepository(root, 'tag-signing');
    await execFileAsync('git', ['config', 'tag.gpgsign', 'true'], { cwd: tagSigningRepository });
    const tagSigning = await startedSessionIn(tagSigningRepository, { port: boundPort(server), hooksBaseDir: root, signingProgram, hostSigningKeys });
    sessions.push(tagSigning.session);
    assert.equal(tagSigning.env.GIT_CONFIG_SYSTEM, process.env.GIT_CONFIG_SYSTEM, 'a project that signs tags its own way gets no host signing defaults');

    const siblingRepository = await newRepository(root, 'sibling');
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: siblingRepository });
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'sibling keeps its own setting'], { cwd: siblingRepository, env: plain.env });
    const siblingCommit = await execFileAsync('git', ['cat-file', 'commit', 'HEAD'], { cwd: siblingRepository, encoding: 'utf8' });
    assert.ok(!siblingCommit.stdout.includes('gpgsig'), 'another repository the session commits in keeps its own signing setting');

    await hostSigningKeys.remove();
    assert.equal(await hostSigningKeys.read(), null);
  } finally {
    for (const session of sessions) session.destroy();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});
