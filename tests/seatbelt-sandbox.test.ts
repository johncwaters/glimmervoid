import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileAsync } from '../server/child-process-safe.ts';
import { buildSrtSettings } from '../server/sandbox/core/sandbox-policy-core.ts';

const LAUNCHER_PATH = path.join(import.meta.dirname, '..', 'server', 'sandbox', 'seatbelt-launcher.ts');

const PROBE_SOURCE = `
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
const [allowedPort, dashboardPort, worktreeFile, outsideFile, secretFile] = process.argv.slice(2);
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
const interruptsLauncherThenReachesProxy = async () => {
  process.kill(process.ppid, 'SIGINT');
  await new Promise((resolve) => setTimeout(resolve, 500));
  return connects(new URL(process.env.HTTP_PROXY).port);
};
const reads = (filePath) => { try { fs.readFileSync(filePath, 'utf8'); return 'read'; } catch (error) { return error.code; } };
process.stdout.write(JSON.stringify({
  allowedPort: await connects(allowedPort),
  dashboardPort: await connects(dashboardPort),
  worktreeWrite: writes(worktreeFile),
  outsideWrite: writes(outsideFile),
  secretRead: reads(secretFile),
  secretReadInOtherCase: reads(secretFile.toUpperCase()),
  protectedFileInOtherCase: writes(path.dirname(worktreeFile) + '/.MCP.JSON'),
  protectedFolderRenamedIntoPlace: renamesIntoPlace(path.dirname(worktreeFile) + '/staged', path.dirname(worktreeFile) + '/.claude'),
  proxyAfterInterrupt: await interruptsLauncherThenReachesProxy(),
}));
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

test('a process under the generated Seatbelt profile reaches only its allowed loopback port and writes only inside its worktree', { skip: process.platform !== 'darwin' && 'Seatbelt runs only on macOS' }, async () => {
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
  fs.writeFileSync(probePath, PROBE_SOURCE);
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
  const settingsPath = path.join(sessionTempFolder, 'srt.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const ingress = await listeningOnLoopback();
  const dashboard = await listeningOnLoopback();
  const probeArguments = [String(portOf(ingress)), String(portOf(dashboard)), path.join(worktree, 'written.txt'), path.join(outsideFolder, 'escaped.txt'), secretFile];
  const launch = execFileAsync(process.execPath, [LAUNCHER_PATH, settingsPath, String(portOf(ingress)), sessionTempFolder, '0', process.execPath, probePath, ...probeArguments], { cwd: worktree, encoding: 'utf8', timeout: 60_000 });
  const { stdout } = await launch.finally(() => { ingress.close(); dashboard.close(); });
  assert.deepEqual(JSON.parse(stdout), {
    allowedPort: 'connected',
    dashboardPort: 'EPERM',
    worktreeWrite: 'written',
    outsideWrite: 'EPERM',
    secretRead: 'EPERM',
    secretReadInOtherCase: 'EPERM',
    protectedFileInOtherCase: 'EPERM',
    protectedFolderRenamedIntoPlace: 'EPERM',
    proxyAfterInterrupt: 'connected',
  });
  assert.equal(fs.existsSync(path.join(outsideFolder, 'escaped.txt')), false);
  fs.rmSync(root, { recursive: true, force: true });
});
