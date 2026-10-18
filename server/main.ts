import fs from 'node:fs';
import http from 'node:http';
import type { Server } from 'node:http';
import { isIPv6 } from 'node:net';

import { createBackend } from './backend/backend.ts';
import { spawn } from './child-process-safe.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { parseCommandLine } from './core/command-line-core.ts';
import { decideConfigPath } from './core/config-path-core.ts';
import { decideBindHost } from './core/remote-config.ts';
import { FIRST_RUN_NOTICE } from './core/telemetry-core.ts';
import { buildTitleClearSequence, buildTitleSequence } from './core/terminal-title.ts';
import { sweepOrphanedHostScratch } from './host-scratch.ts';
import { createHostUrlOpener } from './host-url-opener.ts';
import { createLifecycle } from './server-lifecycle.ts';

const bind = decideBindHost({
  envHost: process.env.GLIMMERVOID_HOST,
  insecureBind: process.env.GLIMMERVOID_INSECURE_BIND === '1',
});
if (!bind.allowed) {
  console.error(`Refusing to bind ${bind.host}: Glimmervoid has no authentication on the local listener.`);
  console.error('Use remote mode (config.remote) behind a reverse proxy, or set GLIMMERVOID_INSECURE_BIND=1 if you truly mean it.');
  process.exit(1);
}

const server = http.createServer();

const isFirstStart = decideConfigPath({ env: process.env, homeDir: glimmervoidHomeDir() }, (candidate) => fs.existsSync(candidate)).path === null;

function isBootRefusal(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (!('glimmervoidBoot' in error)) return false;
  return error.glimmervoidBoot === true;
}

function createBackendOrExit(): ReturnType<typeof createBackend> {
  try {
    return createBackend(server, { staticDir: 'auto', downloadUpdatesInBackground: true });
  } catch (err) {
    if (!isBootRefusal(err)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}

const backend = createBackendOrExit();

const { shutdown, handOffStagedUpdate, port, app, telemetry, version } = backend;
server.on('request', app);

function writeTerminalTitle(sequence: string): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(sequence);
}

function listeningPort(target: Server, fallback: number): number {
  const address = target.address();
  if (address === null || typeof address === 'string') return fallback;
  return address.port;
}

function isPortInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

function isBrowserOpenSkipped(): boolean {
  const commandLine = parseCommandLine(process.argv.slice(2));
  if (commandLine.kind !== 'server') return true;
  return commandLine.isBrowserOpenSkipped;
}

async function openDashboardOnFirstStart(dashboardUrl: string): Promise<boolean> {
  if (!isFirstStart || !process.stdout.isTTY || isBrowserOpenSkipped()) return false;
  return (await createHostUrlOpener()(dashboardUrl)) === 'opened';
}

function indentLines(text: string): string {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

function dashboardUrlHost(bindHost: string): string {
  if (bindHost === '127.0.0.1') return 'localhost';
  if (isIPv6(bindHost)) return `[${bindHost}]`;
  return bindHost;
}

async function printStartupBanner(boundPort: number): Promise<void> {
  const dashboardHost = dashboardUrlHost(bind.host);
  const dashboardUrl = `http://${dashboardHost}:${boundPort}`;
  const isDashboardOpened = await openDashboardOnFirstStart(dashboardUrl);
  console.log(`\n  GLIMMERVOID ${version}\n`);
  console.log(`  Open ${dashboardUrl}${isDashboardOpened ? '  opened in your browser' : ''}`);
  if (await telemetry.consumeFirstRunNotice()) console.log(`\n${indentLines(FIRST_RUN_NOTICE)}`);
  console.log('\n  Ctrl+C stops the server.\n');
}

server.on('error', (err) => {
  if (isPortInUse(err)) {
    console.error(`Another Glimmervoid is already running on port ${port} - exiting.`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, bind.host, () => {
  const boundPort = listeningPort(server, port);
  void printStartupBanner(boundPort);
  sweepOrphanedHostScratch().catch((error: unknown) => {
    console.warn(`Leftover scratch sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  telemetry.capture('app_started', {});
  writeTerminalTitle(buildTitleSequence(`glimmervoid :${boundPort}`));
  if (bind.reason === 'insecure-bind') {
    console.warn(`WARNING: bound ${bind.host} with GLIMMERVOID_INSECURE_BIND=1 - this listener has NO authentication.`);
  }
});

const remoteServers: Server[] = [];
if (backend.remote.enabled) {
  const remoteServer = http.createServer();
  backend.remote.attach(remoteServer);
  remoteServer.on('error', (err) => {
    if (isPortInUse(err)) {
      console.error(`Remote listener port ${backend.remote.port} is already in use - exiting.`);
      process.exit(1);
    }
    throw err;
  });
  if (backend.remote.port === null) {
    throw Object.assign(new Error('remote.enabled requires remote.port; refusing to bind an ephemeral port'), { glimmervoidBoot: true });
  }
  remoteServer.listen(backend.remote.port, bind.host, () => {
    console.log(`Glimmervoid remote listener on http://${bind.host}:${backend.remote.port} (paired devices only)`);
    const publicHost = backend.remote.publicHost || '(remote.publicHost not set)';
    console.log(`  proxy target for ${publicHost}; pair a device with: glimmervoid pair`);
  });
  remoteServers.push(remoteServer);
}

function exitWithClearedTerminalTitle(code?: number): never {
  writeTerminalTitle(buildTitleClearSequence());
  process.exit(code);
}

const { requestShutdown } = createLifecycle({
  shutdown,
  httpServer: server,
  extraServers: remoteServers,
  spawn,
  exit: exitWithClearedTerminalTitle,
  beforeHandOff: handOffStagedUpdate,
});

function handleShutdownSignal(signal: string): void {
  console.log(`\n${signal} received - shutting down...`);
  void requestShutdown();
}

process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGBREAK', () => handleShutdownSignal('SIGBREAK'));
process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
