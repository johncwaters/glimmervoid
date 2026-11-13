import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from '../server/child-process-safe.ts';
import { createAgentIngressApp } from '../server/backend/backend-http.ts';
import { installGitCredentialShim } from '../server/ssh-signing.ts';
import { HookRouter } from '../detection/hook-source.ts';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { GIT_CREDENTIAL_URL_ENV } from '../shared/contracts/session.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

const USER_TOKEN = 'ghu_session_credential_probe';
const TOKEN_EXPIRY_MS = Date.parse('2099-01-01T00:00:00Z');

async function gitCredentialFill(env: Record<string, string | undefined>, host: string): Promise<{ exitCode: number | null; stdout: string }> {
  const git = spawn('git', ['credential', 'fill'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const stdoutChunks: Buffer[] = [];
  git.stdout?.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk); });
  git.stdin?.end(`protocol=https\nhost=${host}\n\n`);
  const exitCode = await new Promise<number | null>((resolve) => { git.on('close', resolve); });
  return { exitCode, stdout: Buffer.concat(stdoutChunks).toString('utf8') };
}

async function startedSessionUnder(inheritedEnv: Record<string, string | undefined>, hooksBaseDir: string): Promise<{ session: Session; env: Record<string, string | undefined> }> {
  const inheritedNames = [GIT_CREDENTIAL_URL_ENV, 'GIT_CONFIG_PARAMETERS'];
  const serverEnvBefore = inheritedNames.map((name) => [name, process.env[name]] as const);
  for (const name of inheritedNames) process.env[name] = inheritedEnv[name];
  const spawnedEnvs: Record<string, string | undefined>[] = [];
  const session = new Session({
    id: 'nested-lane-session',
    name: 'nested-lane-session',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (_file, _args, options) => { spawnedEnvs.push(options.env ?? {}); return fakePty(); },
    hookRouter: new HookRouter(),
    getHookPort: () => 1,
    hooksBaseDir,
  });
  try {
    await session.start();
  } finally {
    for (const [name, value] of serverEnvBefore) {
      if (value === undefined) delete process.env[name];
      if (value !== undefined) process.env[name] = value;
    }
  }
  return { session, env: spawnedEnvs[0] ?? {} };
}

test('git in an operator session reads the connected GitHub user token for github.com only, a session of a server started inside it inherits none, and nothing once the session ends', async () => {
  const binDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-git-credential-'));
  const helperProgram = installGitCredentialShim({ binDir, cliLaunch: [process.execPath, path.resolve('bin/glimmervoid.ts')] });
  assert.ok(helperProgram);
  let session: Session | null = null;
  const app = createAgentIngressApp({
    allowedHosts: [],
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) },
    getSession: (id) => (session?.id === id ? session : null),
    getUsage: () => ({ ingestStatusline: () => {} }),
    githubUserCredential: async () => ({ login: 'octo-carbon', token: USER_TOKEN, expiresAtMs: TOKEN_EXPIRY_MS }),
    logger: { warn: () => {} },
  });
  const server = http.createServer(app);
  await listenOnLoopback(server);
  const spawnedEnvs: Record<string, string | undefined>[] = [];
  const hooksBaseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-git-credential-hooks-'));
  session = new Session({
    id: 'git-credential-session',
    name: 'git-credential-session',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (_file, _args, options) => { spawnedEnvs.push(options.env ?? {}); return fakePty(); },
    hookRouter: new HookRouter(),
    getHookPort: () => boundPort(server),
    hooksBaseDir,
    resolveGitCredentialHelper: async () => helperProgram,
  });
  try {
    await session.start();
    const sessionEnv = { ...process.env, ...spawnedEnvs[0] };

    const github = await gitCredentialFill(sessionEnv, 'github.com');
    assert.equal(github.exitCode, 0);
    assert.ok(github.stdout.split('\n').includes('username=octo-carbon'), 'git reads the connected login');
    assert.ok(github.stdout.split('\n').includes(`password=${USER_TOKEN}`), 'git reads the connected user token');

    const otherHost = await gitCredentialFill(sessionEnv, 'gitlab.com');
    assert.notEqual(otherHost.exitCode, 0);
    assert.ok(!otherHost.stdout.includes(USER_TOKEN), 'another host gets no token');

    const nestedServerSession = await startedSessionUnder(sessionEnv, hooksBaseDir);
    const nestedGithub = await gitCredentialFill({ ...process.env, ...nestedServerSession.env }, 'github.com');
    nestedServerSession.session.destroy();
    assert.ok(!nestedGithub.stdout.includes(USER_TOKEN), 'a lane of a server started inside the session gets no token');

    session.destroy();
    const afterEnd = await gitCredentialFill(sessionEnv, 'github.com');
    assert.notEqual(afterEnd.exitCode, 0);
    assert.ok(!afterEnd.stdout.includes(USER_TOKEN), 'an ended session gets no token');
  } finally {
    session.destroy();
    await closeServer(server);
    await fsp.rm(binDir, { recursive: true, force: true });
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
  }
});
