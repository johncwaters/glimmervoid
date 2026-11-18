import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { spawn } from '../server/child-process-safe.ts';
import { SHORT_SOCKET_FOLDER_PREFIX, buildSrtSettings, srtSettingsPathIn } from '../server/sandbox/core/sandbox-policy-core.ts';

const LAUNCHER_PATH = path.join(import.meta.dirname, '..', 'server', 'sandbox', 'seatbelt-launcher.ts');

const PROBE_SOURCE = `
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [allowedPort, dashboardPort, worktreeFile, outsideFile, secretFile, launcherSettingsFile] = process.argv.slice(2);
const connects = (port) => new Promise((resolve) => {
  const socket = net.connect(Number(port), '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve('connected'); });
  socket.once('error', (error) => resolve(error.code));
});
const writes = (filePath) => { try { fs.writeFileSync(filePath, 'probe'); return 'written'; } catch (error) { return error.code; } };
const renamesIntoPlace = (stagedFolder, protectedFolder) => {
  try {
    fs.mkdirSync(stagedFolder + '/commands', { recursive: true });
    fs.writeFileSync(stagedFolder + '/commands/planted.md', 'probe');
    fs.renameSync(stagedFolder, protectedFolder);
    return 'renamed';
  } catch (error) { return error.code; }
};
const reachesProxyAfterTheLauncherIsInterrupted = async () => {
  process.stdout.write('interrupt the launcher\\n');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return connects(new URL(process.env.HTTP_PROXY).port);
};
const fetchesOverHttps = (command, args) => {
  if (!process.env.GH_TOKEN) return 'skipped without GH_TOKEN';
  try { execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 }); return 'ok'; } catch (error) { return String(error.stderr ?? '').trim().split('\\n').at(-1) || [error.code, error.signal, error.message].filter(Boolean).join(' '); }
};
const reads = (filePath) => { try { fs.readFileSync(filePath, 'utf8'); return 'read'; } catch (error) { return error.code; } };
process.stdout.write(JSON.stringify({
  allowedPort: await connects(allowedPort),
  dashboardPort: await connects(dashboardPort),
  worktreeWrite: writes(worktreeFile),
  outsideWrite: writes(outsideFile),
  launcherSettingsWrite: writes(launcherSettingsFile),
  secretRead: reads(secretFile),
  secretReadInOtherCase: reads(secretFile.toUpperCase()),
  protectedFileInOtherCase: writes(path.dirname(worktreeFile) + '/.MCP.JSON'),
  protectedFolderRenamedIntoPlace: renamesIntoPlace(path.dirname(worktreeFile) + '/staged', path.dirname(worktreeFile) + '/.claude'),
  gitOverHttps: fetchesOverHttps('git', ['ls-remote', 'https://github.com/git/git.git', 'HEAD']),
  ghOverHttps: fetchesOverHttps('gh', ['api', '/zen']),
  proxyAfterInterrupt: await reachesProxyAfterTheLauncherIsInterrupted(),
}) + '\\n');
`;

async function listeningOnLoopback(): Promise<net.Server> {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function portOf(server: net.Server): number {
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return address.port;
}

interface SandboxedProbeRun {
  launcher: ChildProcess;
  worktree: string;
  outsideFolder: string;
  secretFile: string;
  settingsPath: string;
  ingressPort: number;
  removeFolders: () => void;
}

async function launchSandboxedProbe(probeSource: string, probeArguments: (run: Omit<SandboxedProbeRun, 'launcher' | 'removeFolders'>) => string[], { detached }: { detached: boolean }): Promise<SandboxedProbeRun> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-')));
  const homeDir = path.join(root, 'home');
  const glimmervoidHome = path.join(homeDir, '.glimmervoid');
  const worktree = path.join(root, 'worktree');
  const sessionTempFolder = path.join(glimmervoidHome, 'session-temp');
  const outsideFolder = path.join(root, 'outside');
  const secretFile = path.join(glimmervoidHome, 'vault', 'secret.txt');
  for (const folder of [worktree, sessionTempFolder, outsideFolder, path.dirname(secretFile)]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(secretFile, 'secret');
  const probePath = path.join(root, 'probe.mjs');
  fs.writeFileSync(probePath, probeSource);
  const settings = buildSrtSettings({
    homeDir,
    glimmervoidHome,
    configFolder: glimmervoidHome,
    secretPaths: [],
    agent: 'claude-code',
    accountFolder: null,
    sealedLoginHomes: [],
    sealedLoginHomeCarveOuts: [],
    userId: os.userInfo().uid,
    worktree,
    gitRepositories: [],
    sessionTempFolder,
    readableFiles: [],
    extraAllowedHosts: [],
    credentialProxy: null,
  });
  const launcherFolder = fs.mkdtempSync(SHORT_SOCKET_FOLDER_PREFIX);
  const settingsPath = srtSettingsPathIn(launcherFolder);
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const ingress = await listeningOnLoopback();
  const ingressPort = portOf(ingress);
  const extraArguments = probeArguments({ worktree, outsideFolder, secretFile, settingsPath, ingressPort });
  const launcher = spawn(process.execPath, [LAUNCHER_PATH, settingsPath, String(ingressPort), sessionTempFolder, '0', process.execPath, probePath, ...extraArguments], { cwd: worktree, env: { ...process.env, TMPDIR: launcherFolder }, stdio: ['ignore', 'pipe', 'inherit'], timeout: 60_000, detached });
  launcher.on('exit', () => ingress.close());
  const removeFolders = () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(launcherFolder, { recursive: true, force: true });
  };
  return { launcher, worktree, outsideFolder, secretFile, settingsPath, ingressPort, removeFolders };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

test('a process under the generated Seatbelt profile reaches only its allowed loopback port and writes only inside its worktree', { skip: process.platform !== 'darwin' && 'Seatbelt runs only on macOS' }, async () => {
  const dashboard = await listeningOnLoopback();
  const run = await launchSandboxedProbe(PROBE_SOURCE, (paths) => [String(paths.ingressPort), String(portOf(dashboard)), path.join(paths.worktree, 'written.txt'), path.join(paths.outsideFolder, 'escaped.txt'), paths.secretFile, paths.settingsPath], { detached: false });
  let stdout = '';
  run.launcher.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    if (chunk.includes('interrupt the launcher')) run.launcher.kill('SIGINT');
  });
  const exitCode = await new Promise<number | null>((resolve) => run.launcher.on('exit', resolve));
  dashboard.close();
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''), {
    allowedPort: 'connected',
    dashboardPort: 'EPERM',
    worktreeWrite: 'written',
    outsideWrite: 'EPERM',
    launcherSettingsWrite: 'EPERM',
    secretRead: 'EPERM',
    secretReadInOtherCase: 'EPERM',
    protectedFileInOtherCase: 'EPERM',
    protectedFolderRenamedIntoPlace: 'EPERM',
    gitOverHttps: process.env.GH_TOKEN ? 'ok' : 'skipped without GH_TOKEN',
    ghOverHttps: process.env.GH_TOKEN ? 'ok' : 'skipped without GH_TOKEN',
    proxyAfterInterrupt: 'connected',
  });
  assert.equal(fs.existsSync(path.join(run.outsideFolder, 'escaped.txt')), false);
  run.removeFolders();
});

const ESCAPEE_PROBE_SOURCE = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [forkChainGenerationFile] = process.argv.slice(2);
fs.writeFileSync(forkChainGenerationFile + '.sh', 'echo "$1" > "$2"\\nsh "$0" $(( $1 + 1 )) "$2" &\\nexit 0\\n');
const escapee = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
escapee.unref();
spawn('/bin/sh', [forkChainGenerationFile + '.sh', '0', forkChainGenerationFile], { detached: true, stdio: 'ignore' }).unref();
process.stdout.write(JSON.stringify({ escapeePid: escapee.pid }) + '\\n');
setInterval(() => {}, 1000);
`;

test('killing a sandboxed session process group the way the reaper does also stops what it detached, and nothing outside the sandbox', { skip: process.platform !== 'darwin' && 'Seatbelt runs only on macOS' }, async () => {
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const run = await launchSandboxedProbe(ESCAPEE_PROBE_SOURCE, (paths) => [path.join(paths.worktree, 'fork-chain-generation')], { detached: true });
  try {
    const escapeePid = await new Promise<number>((resolve, reject) => {
      let stdout = '';
      run.launcher.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        const line = stdout.split('\n').find((candidate) => candidate.includes('escapeePid'));
        if (line) resolve(JSON.parse(line).escapeePid);
      });
      run.launcher.on('exit', (exitCode, signal) => reject(new Error(`the launcher exited (${exitCode ?? signal}) before the probe reported its escapee`)));
    });
    assert.equal(isAlive(escapeePid), true);
    const launcherPid = run.launcher.pid;
    assert.ok(launcherPid !== undefined);
    process.kill(-launcherPid, 'SIGKILL');
    const isEscapeeGone = await waitUntilGone(escapeePid, 5000);
    if (!isEscapeeGone) process.kill(escapeePid, 'SIGKILL');
    const forkChainGenerationFile = path.join(run.worktree, 'fork-chain-generation');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const generationAfterTeardown = fs.readFileSync(forkChainGenerationFile, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(isEscapeeGone, true);
    assert.equal(fs.readFileSync(forkChainGenerationFile, 'utf8'), generationAfterTeardown);
    assert.equal(bystander.pid !== undefined && isAlive(bystander.pid), true);
  } finally {
    bystander.kill('SIGKILL');
    run.removeFolders();
  }
});
