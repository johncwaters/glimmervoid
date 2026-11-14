import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync, spawn } from '../server/child-process-safe.ts';
import { parseSshPublicKey } from '../server/core/ssh-signing-core.ts';
import { parseRawCommitLog } from '../shared/git-text.ts';
import { createSshSigner, installCommitSigningShim } from '../server/ssh-signing.ts';
import http from 'node:http';
import { createCommitSigning, createHostSigningKeyStore, followingGithubConnection } from '../server/commit-signing.ts';
import type { GithubConnection } from '../shared/contracts/watcher-link.ts';
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
    await hostSigningKeys.writeRecord({ github: null, identity: { name: 'Octo Carbon', email: '7+octo-carbon@users.noreply.github.com' }, isSwitchedOff: false });
    const privateKeyStats = await fs.stat(path.join(root, 'commit-signing', 'signing-key'));
    assert.equal(privateKeyStats.mode & 0o077, 0, 'the private key is readable by its owner only');

    const plainRepository = await newRepository(root, 'plain');
    const plain = await startedSessionIn(plainRepository, { port: boundPort(server), hooksBaseDir: root, signingProgram, hostSigningKeys });
    sessions.push(plain.session);
    assert.ok(!Object.values(plain.env).some((value) => value?.includes('PRIVATE KEY')), 'no session variable carries the private key');
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'signed by the host key'], { cwd: plainRepository, env: plain.env });
    const shownSignature = await execFileAsync('git', ['log', '-1', '--show-signature', '--format=%an <%ae>'], { cwd: plainRepository, env: plain.env, encoding: 'utf8' });
    assert.match(shownSignature.stdout, /Good "git" signature for 7\+octo-carbon@users\.noreply\.github\.com/, 'the session checks the host signature with no setup of its own');
    assert.match(shownSignature.stdout, /Glimmervoid Test <test@glimmervoid\.invalid>/, 'a git identity the operator set wins over the GitHub one');
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'authored as the GitHub account'], { cwd: plainRepository, env: { ...plain.env, GIT_CONFIG_GLOBAL: os.devNull } });
    const hostAuthored = await execFileAsync('git', ['log', '-1', '--format=%an <%ae> %cn <%ce>'], { cwd: plainRepository, env: plain.env, encoding: 'utf8' });
    assert.equal(hostAuthored.stdout.trim(), 'Octo Carbon <7+octo-carbon@users.noreply.github.com> Octo Carbon <7+octo-carbon@users.noreply.github.com>', 'with no identity of its own, a session commits as the connected GitHub account');

    await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'left unsigned'], { cwd: plainRepository, env: plain.env });
    const rawLog = await execFileAsync('git', ['log', '--pretty=raw', '-3'], { cwd: plainRepository, env: plain.env, encoding: 'utf8' });
    assert.deepEqual(
      parseRawCommitLog(rawLog.stdout).map((commit) => [commit.subject, commit.isSigned]),
      [['left unsigned', false], ['authored as the GitHub account', true], ['signed by the host key', true]],
      'a raw log tells a signed commit from an unsigned one',
    );
    const forgedHeaderSha = 'b'.repeat(40);
    assert.deepEqual(
      parseRawCommitLog(`commit ${'a'.repeat(40)}\ntree ${'c'.repeat(40)}\ncommit ${forgedHeaderSha}\n\n    subject\n`).map((commit) => commit.sha),
      ['a'.repeat(40)],
      'a commit header line that names another commit lists no second commit',
    );

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
    assert.equal(tagSigning.env.GIT_CONFIG_SYSTEM, path.join(root, 'commit-signing', 'identity.gitconfig'), 'a project that signs tags its own way gets the identity and no host signing defaults');
    assert.ok(!(await fs.readFile(path.join(root, 'commit-signing', 'identity.gitconfig'), 'utf8')).includes('gpgsign'));

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

function fakeGithubSigningKeys(expectedToken: string): { server: http.Server; calls: string[]; keysById: Map<number, string>; failNextDelete: () => void } {
  const calls: string[] = [];
  const keysById = new Map<number, string>();
  let nextKeyId = 41;
  let isNextDeleteFailing = false;
  const server = http.createServer((request, response) => {
    const bodyChunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { bodyChunks.push(chunk); });
    request.on('end', () => {
      calls.push(`${request.method} ${request.url}`);
      const answer = (status: number, body?: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(body === undefined ? '' : JSON.stringify(body)); };
      if (request.headers.authorization !== `Bearer ${expectedToken}`) return answer(401, { message: 'Bad credentials' });
      if (request.method === 'POST' && request.url === '/user/ssh_signing_keys') {
        const { key } = JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) as { key: string };
        if ([...keysById.values()].includes(key)) return answer(422, { message: 'Validation Failed' });
        nextKeyId += 1;
        keysById.set(nextKeyId, key);
        return answer(201, { id: nextKeyId, key, title: 'Glimmervoid commit signing', created_at: '2026-11-13T00:00:00Z' });
      }
      if (request.method === 'GET' && request.url === '/user') return answer(200, { id: 7, login: 'octo-carbon', name: 'Octo Carbon', email: null });
      if (request.method === 'GET' && request.url?.startsWith('/user/ssh_signing_keys')) return answer(200, [...keysById].map(([id, key]) => ({ id, key })));
      const deleted = /^\/user\/ssh_signing_keys\/(\d+)$/.exec(request.url ?? '');
      if (request.method === 'DELETE' && deleted && isNextDeleteFailing) {
        isNextDeleteFailing = false;
        response.writeHead(502, { 'Content-Type': 'text/html' });
        return response.end('<html>bad gateway</html>');
      }
      if (request.method === 'DELETE' && deleted) return answer(keysById.delete(Number(deleted[1])) ? 204 : 404);
      return answer(404, { message: 'Not Found' });
    });
  });
  return { server, calls, keysById, failNextDelete: () => { isNextDeleteFailing = true; } };
}

test('commit signing registers the host key on GitHub with the connected user token and never leaves it there while GitHub access exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-signing-setup-'));
  const keyFolder = path.join(root, 'commit-signing');
  const userToken = 'ghu_signing_setup_probe';
  const github = fakeGithubSigningKeys(userToken);
  await listenOnLoopback(github.server);
  const connectedGrant = { login: 'octo-carbon', token: userToken, expiresAtMs: Date.parse('2099-01-01T00:00:00Z') };
  let grant: typeof connectedGrant | null = null;
  let connectionState: GithubConnection | null = { state: 'disconnected' };
  const store = createHostSigningKeyStore({ folder: keyFolder });
  const warnings: string[] = [];
  const commitSigning = createCommitSigning({ store, githubUserCredential: async () => grant, githubConnectionState: async () => connectionState, githubApiUrl: `http://127.0.0.1:${boundPort(github.server)}`, log: { warn: (line: string) => { warnings.push(line); } } });
  let linkConnection: GithubConnection = { state: 'disconnected' };
  const disconnect = followingGithubConnection(async () => linkConnection, commitSigning);
  try {
    assert.equal((await commitSigning.act('read')).state, 'off');
    const unregistered = await commitSigning.act('setup');
    assert.equal(unregistered.state, 'unregistered');
    assert.equal(unregistered.canRegister, false, 'with no GitHub connection the key is added by hand');
    assert.match(unregistered.publicKey ?? '', /^ssh-ed25519 /);
    assert.match(unregistered.fingerprint ?? '', /^SHA256:/);

    grant = connectedGrant;
    const registered = await commitSigning.act('register');
    assert.equal(registered.state, 'registered', registered.problem ?? '');
    assert.equal(registered.login, 'octo-carbon');
    assert.deepEqual([...github.keysById.values()], [unregistered.publicKey]);
    await store.writeRecord({ github: null, identity: null, isSwitchedOff: false });
    assert.equal((await commitSigning.act('register')).state, 'registered', 'a key GitHub already holds is found by listing');
    assert.equal(await commitSigning.noticeOfKeyGoneFromGithub(), null, 'a key still on GitHub raises nothing');
    github.keysById.clear();
    assert.match(await commitSigning.noticeOfKeyGoneFromGithub() ?? '', /no longer on GitHub for octo-carbon/);
    assert.equal((await commitSigning.act('read')).state, 'unregistered', 'a key gone from GitHub reads as unregistered');
    assert.equal(await commitSigning.noticeOfKeyGoneFromGithub(), null, 'a key gone from GitHub is raised once');
    assert.equal((await commitSigning.act('register')).state, 'registered');

    grant = null;
    connectionState = null;
    const unreadable = await commitSigning.act('remove');
    assert.equal(unreadable.state, 'registered', 'remove refuses while the GitHub connection cannot be read');
    assert.match(unreadable.problem ?? '', /could not read the GitHub connection/);
    assert.equal(github.keysById.size, 1);

    grant = connectedGrant;
    github.failNextDelete();
    await disconnect('disconnect');
    assert.equal(github.keysById.size, 1);
    const afterRefusedDelete = await commitSigning.act('read');
    assert.equal(afterRefusedDelete.state, 'registered', 'a refused delete keeps the record of the GitHub key');
    assert.match(afterRefusedDelete.problem ?? '', /Disconnect left the signing key on GitHub: GitHub refused to delete the signing key \(HTTP 502\)/);

    await disconnect('disconnect');
    assert.equal(github.keysById.size, 0, 'disconnecting GitHub deletes the signing key there first');
    assert.equal((await commitSigning.act('read')).state, 'unregistered');

    github.keysById.set(9, unregistered.publicKey ?? '');
    await fs.writeFile(path.join(keyFolder, 'commit-signing.json'), '');
    assert.match((await commitSigning.act('read')).problem ?? '', /JSON/, 'an unreadable record is reported, not fatal');
    const removed = await commitSigning.act('remove');
    assert.equal(removed.state, 'off', removed.problem ?? '');
    assert.equal(github.keysById.size, 0, 'remove deletes every copy of the key GitHub holds, recorded or not');
    assert.deepEqual(await fs.readdir(keyFolder), ['commit-signing.json'], 'remove deletes the key on this host');

    const setUpWhileConnected = await commitSigning.act('setup');
    assert.equal(setUpWhileConnected.state, 'registered', setUpWhileConnected.problem ?? '');
    assert.equal(setUpWhileConnected.login, 'octo-carbon');
    assert.deepEqual([...github.keysById.values()], [setUpWhileConnected.publicKey], 'with GitHub connected, setup registers the new key in the same request');

    await commitSigning.act('remove');
    linkConnection = { state: 'connected', login: 'octo-carbon', accounts: [], refreshTokenExpiresAtMs: Date.parse('2099-01-01T00:00:00Z'), installUrl: 'https://github.com/apps/glimmervoid/installations/new' };
    await disconnect('read');
    const connectedAfterRemove = await commitSigning.act('read');
    assert.equal(connectedAfterRemove.state, 'off', 'a key the operator removed is not made again when GitHub connects');
    assert.deepEqual(connectedAfterRemove.identity, { name: 'Octo Carbon', email: '7+octo-carbon@users.noreply.github.com' }, 'connecting GitHub records the account as the git identity');

    assert.equal((await commitSigning.act('setup')).state, 'registered');
    await disconnect('disconnect');
    const afterDisconnect = await commitSigning.act('read');
    assert.equal(afterDisconnect.state, 'unregistered');
    assert.equal(afterDisconnect.identity, null, 'disconnecting GitHub stops sessions committing as that account');
    await disconnect('read');
    const connectedAgain = await commitSigning.act('read');
    assert.equal(connectedAgain.state, 'registered', connectedAgain.problem ?? '');
    assert.equal(github.keysById.size, 1, 'connecting GitHub registers the signing key with no press');

    const signingOfHostAt = (folder: string) => createCommitSigning({ store: createHostSigningKeyStore({ folder }), githubUserCredential: async () => grant, githubConnectionState: async () => connectionState, githubApiUrl: `http://127.0.0.1:${boundPort(github.server)}`, log: { warn: (line: string) => { warnings.push(line); } } });
    const freshHostSigning = signingOfHostAt(path.join(root, 'fresh-host'));
    await followingGithubConnection(async () => linkConnection, freshHostSigning)('read');
    const freshHost = await freshHostSigning.act('read');
    assert.equal(freshHost.problem, null, 'the first GitHub connection of a host that never held a key reports no problem');
    assert.equal(freshHost.state, 'registered');
    assert.equal(freshHost.identity?.email, '7+octo-carbon@users.noreply.github.com');

    const folderAnEarlierRemoveEmptied = path.join(root, 'earlier-remove');
    await fs.mkdir(folderAnEarlierRemoveEmptied);
    const earlierRemoveSigning = signingOfHostAt(folderAnEarlierRemoveEmptied);
    await followingGithubConnection(async () => linkConnection, earlierRemoveSigning)('read');
    assert.equal((await earlierRemoveSigning.act('read')).state, 'off', 'a key removed on an earlier release, which kept no record of it, is not made again when GitHub connects');

    const failingKeygenFolder = path.join(root, 'failing-keygen');
    await fs.mkdir(failingKeygenFolder);
    await fs.writeFile(path.join(failingKeygenFolder, 'ssh-keygen'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const pathBefore = process.env.PATH;
    process.env.PATH = `${failingKeygenFolder}${path.delimiter}${pathBefore}`;
    const failedSetup = await signingOfHostAt(path.join(root, 'failed-setup')).act('setup').finally(() => { process.env.PATH = pathBefore; });
    assert.notEqual(failedSetup.problem, null);
    assert.equal((await createHostSigningKeyStore({ folder: path.join(root, 'failed-setup') }).readRecord()).isSwitchedOff, false, 'a Set up that failed is not read after a restart as a Remove');
    assert.ok(!warnings.join('\n').includes(userToken), 'no warning carries the token');
    assert.ok(github.calls.every((call) => !call.includes(userToken)), 'the token never rides in a URL');
  } finally {
    await closeServer(github.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});
