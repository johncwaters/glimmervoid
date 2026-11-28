import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createBackend } from '../server/backend/backend.ts';
import { acquireHomeLockSync } from '../server/home-lock.ts';
import {
  ALLOW_SHARED_HOME_ENV,
  HANDOFF_FROM_PID_ENV,
  HOME_LOCK_METADATA_FILE_NAME,
  parseHomeLockHolder,
} from '../server/core/home-lock-core.ts';
import type { HomeLockHolder } from '../server/core/home-lock-core.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'index.ts');
const BOOT_TIMEOUT_MS = 25_000;

interface SpawnedServer {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function buildServerEnv(homeDir: string, extraEnv: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.GLIMMERVOID_CONFIG;
  delete env.GLIMMERVOID_PORT;
  delete env[ALLOW_SHARED_HOME_ENV];
  delete env[HANDOFF_FROM_PID_ENV];
  env.GLIMMERVOID_HOME = homeDir;
  env.GLIMMERVOID_PORT = '0';
  env.GLIMMERVOID_TELEMETRY = '0';
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function spawnServerProcess(homeDir: string, extraEnv: Record<string, string | undefined> = {}): SpawnedServer {
  const child = spawn(process.execPath, [SERVER_ENTRY, '--no-open'], {
    cwd: REPO_ROOT,
    env: buildServerEnv(homeDir, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, stdout: () => out, stderr: () => err, exitPromise };
}

async function waitForListeningServer(server: SpawnedServer, homeDir: string): Promise<HomeLockHolder | null> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  void server.exitPromise.then((exitStatus) => { exited = exitStatus; });
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(`server exited early (${JSON.stringify(exited)}): stdout=${server.stdout()} stderr=${server.stderr()}`);
    }
    if (server.stdout().includes('Open http://')) {
      const metadataPath = path.join(homeDir, HOME_LOCK_METADATA_FILE_NAME);
      const raw = await fs.readFile(metadataPath, 'utf8').catch(() => null);
      const holder = raw === null ? null : parseHomeLockHolder(raw);
      if (holder !== null && holder.port !== null && holder.port > 0) return holder;
      return holder;
    }
    await sleep(50);
  }
  throw new Error(`server did not listen within ${BOOT_TIMEOUT_MS}ms: stdout=${server.stdout()} stderr=${server.stderr()}`);
}

async function waitForReplacementHolder(homeDir: string, predecessorPid: number): Promise<HomeLockHolder> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  const metadataPath = path.join(homeDir, HOME_LOCK_METADATA_FILE_NAME);
  while (Date.now() < deadline) {
    const raw = await fs.readFile(metadataPath, 'utf8').catch(() => null);
    const holder = raw === null ? null : parseHomeLockHolder(raw);
    if (holder !== null && holder.pid !== predecessorPid && holder.port !== null && holder.port > 0) return holder;
    await sleep(50);
  }
  throw new Error(`replacement server did not acquire lock within ${BOOT_TIMEOUT_MS}ms`);
}

async function stopServerProcess(server: SpawnedServer, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill(signal);
  await Promise.race([
    server.exitPromise,
    sleep(10_000).then(() => { server.child.kill('SIGKILL'); }),
  ]);
}

async function stopPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(50);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
  }
}

async function snapshotDirectory(rootDir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile()) files.set(relativePath, await fs.readFile(fullPath));
    }
  }
  await walk(rootDir);
  return files;
}

test('a second server on a held scratch home refuses before writing anything, boots with the override, and recovers after SIGKILL', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-home-lock-'));
  await fs.writeFile(path.join(homeDir, 'config.json'), JSON.stringify({ projects: [], checkForUpdates: false, telemetry: { enabled: false } }, null, 2));
  const server1 = spawnServerProcess(homeDir);
  let server2Refused: SpawnedServer | null = null;
  let server2Shared: SpawnedServer | null = null;
  let server3Recovered: SpawnedServer | null = null;
  try {
    const holder = await waitForListeningServer(server1, homeDir);
    assert.ok(holder !== null, 'first server writes lock metadata');
    assert.equal(holder.pid, server1.child.pid);
    assert.ok(holder.port !== null && holder.port > 0, 'first server records its bound port');

    const liveScratchDir = path.join(homeDir, 'scratch', 'glimmervoid-live-check');
    await fs.mkdir(liveScratchDir, { recursive: true });
    await fs.writeFile(path.join(liveScratchDir, 'sentinel.txt'), 'server-1-owned\n');

    const quietHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-home-lock-quiet-'));
    const quietLock = acquireHomeLockSync({ homeDir: quietHomeDir, port: 43210, env: {} });
    let quietRefused: SpawnedServer | null = null;
    try {
      const quietBefore = await snapshotDirectory(quietHomeDir);
      quietRefused = spawnServerProcess(quietHomeDir);
      const quietExit = await Promise.race([
        quietRefused.exitPromise,
        sleep(BOOT_TIMEOUT_MS).then(() => { throw new Error('second server did not exit on quiet held home'); }),
      ]);
      assert.notEqual(quietExit.code, 0, 'refused server exits non-zero on a quiet held home');
      const quietAfter = await snapshotDirectory(quietHomeDir);
      assert.deepEqual([...quietAfter.keys()].sort(), [...quietBefore.keys()].sort(), 'refused server creates or deletes no files in a quiet held home');
      for (const [relativePath, beforeBytes] of quietBefore.entries()) {
        assert.deepEqual(quietAfter.get(relativePath), beforeBytes, `refused server leaves ${relativePath} byte-identical`);
      }
    } finally {
      if (quietRefused) await stopServerProcess(quietRefused);
      quietLock.release();
      await fs.rm(quietHomeDir, { recursive: true, force: true });
    }

    const beforeProtectedFiles = new Map<string, Buffer>();
    const protectedRelativePaths = [
      'config.json',
      HOME_LOCK_METADATA_FILE_NAME,
      path.join('scratch', 'glimmervoid-live-check', 'sentinel.txt'),
      ...(process.platform === 'win32' ? [] : [
        path.join('bin', 'glimmervoid-ssh-sign'),
        path.join('bin', 'glimmervoid-git-credential'),
        path.join('gh-bin', 'gh'),
      ]),
    ];
    for (const relativePath of protectedRelativePaths) {
      beforeProtectedFiles.set(relativePath, await fs.readFile(path.join(homeDir, relativePath)));
    }

    server2Refused = spawnServerProcess(homeDir);
    const refusedExit = await Promise.race([
      server2Refused.exitPromise,
      sleep(BOOT_TIMEOUT_MS).then(() => { throw new Error('second server did not exit when home was locked'); }),
    ]);
    assert.notEqual(refusedExit.code, 0, 'second server exits non-zero on a held home');
    const refusalText = server2Refused.stderr();
    assert.match(refusalText, new RegExp(`PID ${holder.pid}`), 'refusal names the live server PID');
    assert.match(refusalText, new RegExp(`port ${holder.port}`), 'refusal names the live server port');
    assert.ok(refusalText.includes(holder.startedAt), 'refusal names when the live server started');
    assert.ok(refusalText.includes(`${ALLOW_SHARED_HOME_ENV}=1`), 'refusal names the override flag');

    for (const [relativePath, beforeBytes] of beforeProtectedFiles.entries()) {
      assert.deepEqual(await fs.readFile(path.join(homeDir, relativePath)), beforeBytes, `refused server leaves ${relativePath} byte-identical`);
    }
    const serverLogText = await fs.readFile(path.join(homeDir, 'logs', 'server.log'), 'utf8').catch(() => '');
    assert.equal(serverLogText.includes('Refusing to start'), false, 'refused server writes nothing to logs/server.log');

    server2Shared = spawnServerProcess(homeDir, { [ALLOW_SHARED_HOME_ENV]: '1' });
    await waitForListeningServer(server2Shared, homeDir);
    assert.ok(server2Shared.stderr().includes(`Sharing live home ${homeDir}`), 'shared-home boot prints the one-line sharing notice');
    assert.ok(server2Shared.stderr().includes(`${ALLOW_SHARED_HOME_ENV}=1`), 'shared-home notice names the override flag');
    const holderAfterShared = parseHomeLockHolder(await fs.readFile(path.join(homeDir, HOME_LOCK_METADATA_FILE_NAME), 'utf8'));
    assert.equal(holderAfterShared?.pid, server1.child.pid, 'shared-home boot does not overwrite the primary lock holder metadata');
    await stopServerProcess(server2Shared);
    server2Shared = null;

    await stopServerProcess(server1, 'SIGKILL');

    server3Recovered = spawnServerProcess(homeDir);
    const recoveredHolder = await waitForListeningServer(server3Recovered, homeDir);
    assert.ok(recoveredHolder !== null, 'new server boots cleanly after SIGKILL with no stale lock');
    assert.equal(recoveredHolder.pid, server3Recovered.child.pid);
  } finally {
    if (server3Recovered) await stopServerProcess(server3Recovered);
    if (server2Shared) await stopServerProcess(server2Shared);
    if (server2Refused) await stopServerProcess(server2Refused);
    await stopServerProcess(server1);
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('an unsupervised restart handoff keeps the lock through handoff and lets the replacement take over without refusal', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-home-handoff-'));
  const configPath = path.join(homeDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ projects: [], checkForUpdates: false, telemetry: { enabled: false } }, null, 2));
  const savedEnv = {
    GLIMMERVOID_HOME: process.env.GLIMMERVOID_HOME,
    GLIMMERVOID_CONFIG: process.env.GLIMMERVOID_CONFIG,
    GLIMMERVOID_PORT: process.env.GLIMMERVOID_PORT,
    GLIMMERVOID_SUPERVISOR: process.env.GLIMMERVOID_SUPERVISOR,
    INVOCATION_ID: process.env.INVOCATION_ID,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
  };
  process.env.GLIMMERVOID_HOME = homeDir;
  process.env.GLIMMERVOID_CONFIG = configPath;
  process.env.GLIMMERVOID_PORT = '0';
  delete process.env.GLIMMERVOID_SUPERVISOR;
  delete process.env.INVOCATION_ID;
  delete process.env.NODE_TEST_CONTEXT;

  const httpServer = http.createServer();
  let exitCalledWith: number | undefined;
  let backend: ReturnType<typeof createBackend> | null = null;
  let replacementPid: number | null = null;
  try {
    backend = createBackend(httpServer, {
      staticDir: null,
      exit: (code) => { exitCalledWith = code; },
    });
    await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', resolve); });

    const originalArgv = process.argv;
    try {
      process.argv = [process.execPath, SERVER_ENTRY, '--no-open'];
      await backend.requestRestart();
    } finally {
      process.argv = originalArgv;
    }

    assert.equal(exitCalledWith, 0, 'predecessor completed restart handoff and exited 0');
    const replacementHolder = await waitForReplacementHolder(homeDir, process.pid);
    replacementPid = replacementHolder.pid;
    assert.ok(replacementHolder.port !== null && replacementHolder.port > 0, 'replacement server bound a port and holds the home lock');
  } finally {
    if (replacementPid !== null) await stopPid(replacementPid);
    backend?.shutdown();
    httpServer.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      if (value !== undefined) process.env[key] = value;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
