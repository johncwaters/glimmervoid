import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from '../../server/child-process-safe.ts';
import { selfLaunch } from '../../server/runtime-paths.ts';
import { loadFileLocks } from '../../server/session-temp/session-temp-locks.ts';
import { DOORMAN_LOCK_FILE_NAME, DOORMAN_PORT_FILE_NAME, DoormanTableServerUrls, OFFICIAL_GITHUB_APP } from '../../shared/contracts/doorman.ts';
import type { DoormanTenantTable } from '../../shared/contracts/doorman.ts';
import { GITHUB_API_BASE_ENV } from '../../shared/contracts/watcher-link.ts';
import { watcherLinkKeyPath } from '../../server/secrets/core/secret-files-core.ts';

const INHERITED_ENVIRONMENT_NAMES = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', GITHUB_API_BASE_ENV];
const DOORMAN_FOLDER_NAME = 'doorman';
const TENANT_TABLE_FILE_NAME = 'tenants.json';
const DOORMAN_LOG_FILE_NAME = 'doorman.log';
const STARTED_BY_FILE_NAME = 'started-by';
const LEGACY_WATCHER_HOME_NAME = 'watcher';
const RETIRE_POLL_MS = 100;
const RETIRE_POLL_LIMIT = 50;
const SERVER_ANSWER_TIMEOUT_MS = 1_000;
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::']);
const LOCAL_PORT_FOLDER_PATTERN = /^\d{1,5}$/;

function doormenDir(glimmervoidHome: string): string {
  return path.join(glimmervoidHome, DOORMAN_FOLDER_NAME);
}

function doormanStateDir(glimmervoidHome: string, localPort: number): string {
  return path.join(doormenDir(glimmervoidHome), String(localPort));
}

function inheritedEnvironment(): Record<string, string> {
  const entries = INHERITED_ENVIRONMENT_NAMES.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  });
  return Object.fromEntries(entries);
}

function startedByIdentity(version: string, launchCommand: readonly string[], environment: Record<string, string>): string {
  const launchDigest = crypto.createHash('sha256').update(JSON.stringify({ launchCommand, environment })).digest('hex');
  return `${version} ${launchDigest}\n`;
}

function remoteListenerUrl(bindHost: string, remoteListenerPort: number): string {
  const reachableHost = WILDCARD_HOSTS.has(bindHost) ? '127.0.0.1' : bindHost;
  const urlHost = reachableHost.includes(':') ? `[${reachableHost}]` : reachableHost;
  return `http://${urlHost}:${remoteListenerPort}`;
}

function localWatcherHome(glimmervoidHome: string, localPort: number): string {
  return path.join(doormanStateDir(glimmervoidHome, localPort), 'watcher');
}

function localTenantTable({ glimmervoidHome, localPort, bindHost, remoteListenerPort }: { glimmervoidHome: string; localPort: number; bindHost: string; remoteListenerPort: number }): DoormanTenantTable {
  return {
    tenantDomain: null,
    githubApp: { ...OFFICIAL_GITHUB_APP, privateKeySecret: null },
    tenants: [{
      slug: `local${String(localPort).padStart(7, '0')}`,
      serverUrl: remoteListenerUrl(bindHost, remoteListenerPort),
      linkSecretPath: watcherLinkKeyPath(glimmervoidHome),
      watcherHome: localWatcherHome(glimmervoidHome, localPort),
      awakeHoursPerMonth: null,
      host: null,
    }],
  };
}

async function pathExists(candidatePath: string): Promise<boolean> {
  return fsp.access(candidatePath).then(() => true, () => false);
}

async function moveLegacyWatcherHome(glimmervoidHome: string, watcherHome: string): Promise<void> {
  const legacyWatcherHome = path.join(glimmervoidHome, LEGACY_WATCHER_HOME_NAME);
  if (!await pathExists(legacyWatcherHome) || await pathExists(watcherHome)) return;
  await fsp.rename(legacyWatcherHome, watcherHome);
}

async function writeTableWhenChanged(tablePath: string, table: DoormanTenantTable): Promise<void> {
  const tableText = `${JSON.stringify(table, null, 2)}\n`;
  const currentText = await fsp.readFile(tablePath, 'utf8').catch(() => null);
  if (currentText === tableText) return;
  const stagingPath = `${tablePath}.${process.pid}`;
  await fsp.writeFile(stagingPath, tableText, { mode: 0o600 });
  await fsp.rename(stagingPath, tablePath);
}

async function isDoormanRunning(stateDir: string): Promise<boolean> {
  const locks = loadFileLocks();
  if (locks === null) throw new Error('kernel file locks are unavailable, so a running doorman cannot be told apart from a stale port file');
  const lockFile = await fsp.open(path.join(stateDir, DOORMAN_LOCK_FILE_NAME), 'a');
  try {
    if (!locks.tryLock(lockFile.fd)) return true;
    locks.unlock(lockFile.fd);
    return false;
  } finally {
    await lockFile.close();
  }
}

async function retireDoorman(stateDir: string): Promise<void> {
  await fsp.rm(path.join(stateDir, TENANT_TABLE_FILE_NAME), { force: true });
  for (let pollCount = 0; pollCount < RETIRE_POLL_LIMIT; pollCount += 1) {
    if (!await isDoormanRunning(stateDir)) return;
    await sleep(RETIRE_POLL_MS);
  }
}

async function retireOutdatedDoorman(stateDir: string, startedBy: string): Promise<void> {
  const previousStartedBy = await fsp.readFile(path.join(stateDir, STARTED_BY_FILE_NAME), 'utf8').catch(() => null);
  if (previousStartedBy === null || previousStartedBy === startedBy) return;
  await retireDoorman(stateDir);
}

function isServerAnswering(serverUrl: string): Promise<boolean> {
  const url = URL.parse(serverUrl);
  if (url === null) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) });
    socket.setTimeout(SERVER_ANSWER_TIMEOUT_MS);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function tenantServerUrlOf(tablePath: string): Promise<string | null> {
  const tableText = await fsp.readFile(tablePath, 'utf8').catch(() => null);
  if (tableText === null) return null;
  const table = DoormanTableServerUrls.safeParse(JSON.parse(tableText));
  return table.success ? table.data.tenants.at(0)?.serverUrl ?? null : null;
}

async function retireDoormenOfStoppedServers(glimmervoidHome: string, localPort: number): Promise<void> {
  const folderNames = await fsp.readdir(doormenDir(glimmervoidHome)).catch(() => []);
  const otherFolderNames = folderNames.filter((folderName) => LOCAL_PORT_FOLDER_PATTERN.test(folderName) && folderName !== String(localPort));
  await Promise.all(otherFolderNames.map(async (folderName) => {
    const tablePath = path.join(doormenDir(glimmervoidHome), folderName, TENANT_TABLE_FILE_NAME);
    const serverUrl = await tenantServerUrlOf(tablePath).catch(() => null);
    if (serverUrl === null || await isServerAnswering(serverUrl)) return;
    await fsp.rm(tablePath, { force: true });
  }));
}

async function spawnDoorman(stateDir: string, tablePath: string, launchCommand: readonly string[], environment: Record<string, string>): Promise<void> {
  const logFile = await fsp.open(path.join(stateDir, DOORMAN_LOG_FILE_NAME), 'a', 0o600);
  try {
    const [launcher, ...launchArguments] = launchCommand;
    const doorman = spawn(launcher, [...launchArguments, 'doorman', '--tenants', tablePath], {
      cwd: stateDir,
      stdio: ['ignore', logFile.fd, logFile.fd],
      env: environment,
      detached: true,
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      doorman.once('spawn', () => resolve());
      doorman.once('error', reject);
    });
    doorman.unref();
  } finally {
    await logFile.close();
  }
}

async function ensureDoorman({ glimmervoidHome, localPort, bindHost, remoteListenerPort, version }: { glimmervoidHome: string; localPort: number; bindHost: string; remoteListenerPort: number; version: string }): Promise<void> {
  const stateDir = doormanStateDir(glimmervoidHome, localPort);
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await retireDoormenOfStoppedServers(glimmervoidHome, localPort);
  await moveLegacyWatcherHome(glimmervoidHome, localWatcherHome(glimmervoidHome, localPort));
  const launchCommand = selfLaunch('cli');
  const environment = inheritedEnvironment();
  const startedBy = startedByIdentity(version, launchCommand, environment);
  await retireOutdatedDoorman(stateDir, startedBy);
  const tablePath = path.join(stateDir, TENANT_TABLE_FILE_NAME);
  await writeTableWhenChanged(tablePath, localTenantTable({ glimmervoidHome, localPort, bindHost, remoteListenerPort }));
  if (await isDoormanRunning(stateDir)) return;
  await fsp.rm(path.join(stateDir, DOORMAN_PORT_FILE_NAME), { force: true });
  await spawnDoorman(stateDir, tablePath, launchCommand, environment);
  await fsp.writeFile(path.join(stateDir, STARTED_BY_FILE_NAME), startedBy);
}

async function retireLocalDoorman(glimmervoidHome: string, localPort: number): Promise<void> {
  await fsp.rm(path.join(doormanStateDir(glimmervoidHome, localPort), TENANT_TABLE_FILE_NAME), { force: true });
}

async function localDoormanUrl(glimmervoidHome: string, localPort: number): Promise<string | null> {
  const stateDir = doormanStateDir(glimmervoidHome, localPort);
  if (!await isDoormanRunning(stateDir).catch(() => false)) return null;
  const portText = await fsp.readFile(path.join(stateDir, DOORMAN_PORT_FILE_NAME), 'utf8').catch(() => '');
  const doormanPort = Number(portText.trim());
  if (!Number.isInteger(doormanPort) || doormanPort <= 0 || doormanPort > 65535) return null;
  return `http://127.0.0.1:${doormanPort}`;
}

export { ensureDoorman, localDoormanUrl, retireLocalDoorman };
