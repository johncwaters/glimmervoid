import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { TestContext } from 'node:test';
import path from 'node:path';
import { reserveFreePort } from '../../helpers/http-server.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'index.ts');

const BOOT_DEADLINE_MS = 30_000;
const SHUTDOWN_DEADLINE_MS = 10_000;
const LOG_LINE_DEADLINE_MS = 15_000;
const POLL_INTERVAL_MS = 25;

const PROCESS_WARNING = /^\(node:\d+\) (?:\[[\w-]+\] )?\w*Warning: /;
const UNCAUGHT_ERROR = /^(?:Uncaught )?\w*Error: |^\s+at .+:\d+:\d+\)?$/;
const SERVER_MARK_VARIABLE = 'GLIMMERVOID_E2E_SERVER_MARK';
const INHERITED_GLIMMERVOID_NAMES = new Set(['GLIMMERVOID_TELEMETRY']);
const WARNINGS_EVERY_BOOT_PRINTS = [/ExperimentalWarning: SQLite is an experimental feature/];

interface ServerStartOptions {
  scenarioName: string;
  testContext: TestContext;
  extraEnvironment?: Readonly<Record<string, string>>;
  removedEnvironmentNames?: readonly string[];
  pathPrefix?: string;
  seedConfig?: Readonly<Record<string, unknown>>;
}

interface StoppedServer {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  hasMissedShutdownDeadline: boolean;
  shutdownMs: number;
  descendantPidsStillRunning: number[];
}

interface RunningServer {
  port: number;
  home: string;
  bootMs: number;
  logText: () => string;
  waitForLogLine: (pattern: RegExp, label: string, deadlineMs?: number) => Promise<string>;
  descendantPids: () => number[];
  stopProcessGroup: (signal?: NodeJS.Signals) => Promise<StoppedServer>;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function childPidsOf(parentPid: number): number[] {
  const listing = spawnSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' });
  return listing.stdout.split('\n').filter((line) => line.trim() !== '').map((line) => Number.parseInt(line, 10));
}

function descendantPidsOf(rootPid: number): number[] {
  const children = childPidsOf(rootPid);
  return [...children, ...children.flatMap((childPid) => descendantPidsOf(childPid))];
}

function isProcessRunning(pid: number): boolean {
  const probe = spawnSync('kill', ['-0', String(pid)]);
  return probe.status === 0;
}

function markedPidsOf(serverMark: string): number[] {
  const listing = spawnSync('ps', ['axeww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const markText = `${SERVER_MARK_VARIABLE}=${serverMark}`;
  return listing.stdout.split('\n')
    .filter((line) => line.split(/\s+/).includes(markText))
    .map((line) => Number.parseInt(line.trim(), 10));
}

function signalProcessGroup(groupLeaderPid: number, signal: NodeJS.Signals): void {
  spawnSync('kill', [`-${signal.replace(/^SIG/, '')}`, '--', `-${groupLeaderPid}`]);
}

function linesOf(logText: string): string[] {
  return logText.split('\n');
}

function findUnexpectedLogLines(logText: string, allowedPatterns: readonly RegExp[] = []): string[] {
  const acceptedPatterns = [...WARNINGS_EVERY_BOOT_PRINTS, ...allowedPatterns];
  return linesOf(logText)
    .filter((line) => PROCESS_WARNING.test(line) || UNCAUGHT_ERROR.test(line))
    .filter((line) => !acceptedPatterns.some((pattern) => pattern.test(line)));
}

function assertCleanLog(logText: string, allowedPatterns: readonly RegExp[] = []): void {
  const unexpectedLines = findUnexpectedLogLines(logText, allowedPatterns);
  assert.deepEqual(unexpectedLines, [], `the server log holds unexpected warning or error lines:\n${unexpectedLines.join('\n')}`);
}

function countLogLines(logText: string, pattern: RegExp): number {
  return linesOf(logText).filter((line) => pattern.test(line)).length;
}

function childEnvironment(options: ServerStartOptions, home: string, port: number): NodeJS.ProcessEnv {
  const inheritedEnvironment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !name.startsWith('GLIMMERVOID_') || INHERITED_GLIMMERVOID_NAMES.has(name)));
  const environment: NodeJS.ProcessEnv = {
    ...inheritedEnvironment,
    [SERVER_MARK_VARIABLE]: home,
    GLIMMERVOID_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, 'claude-config'),
    GLIMMERVOID_PORT: String(port),
    ...options.extraEnvironment,
  };
  delete environment.NODE_TEST_CONTEXT;
  for (const removedName of options.removedEnvironmentNames ?? []) delete environment[removedName];
  if (options.pathPrefix === undefined) return environment;
  environment.PATH = `${options.pathPrefix}${path.delimiter}${environment.PATH ?? ''}`;
  return environment;
}

function startedPidOf(startedProcess: ChildProcess): number {
  if (startedProcess.pid === undefined) throw new Error('the server process did not start');
  return startedProcess.pid;
}

async function waitForDashboard(port: number, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + BOOT_DEADLINE_MS;
  while (Date.now() < deadline && !exited()) {
    const response = await fetch(`http://127.0.0.1:${port}/control-token`).catch(() => null);
    if (response?.ok) return;
    await sleep(POLL_INTERVAL_MS * 4);
  }
  if (exited()) throw new Error('the server exited before it answered /control-token');
  throw new Error(`the server did not answer /control-token within ${BOOT_DEADLINE_MS} ms`);
}

async function startServer(options: ServerStartOptions): Promise<RunningServer> {
  const scenarioHomes = path.join(process.env.GLIMMERVOID_HOME ?? REPO_ROOT, 'e2e');
  fs.mkdirSync(scenarioHomes, { recursive: true });
  const home = fs.mkdtempSync(path.join(scenarioHomes, `${options.scenarioName}-`));
  if (options.seedConfig !== undefined) fs.writeFileSync(path.join(home, 'config.json'), `${JSON.stringify(options.seedConfig, null, 2)}\n`);
  const port = await reserveFreePort();
  const startedAt = Date.now();
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: childEnvironment(options, home, port),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let capturedOutput = '';
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stdout.on('data', (chunk: string) => { capturedOutput += chunk; });
  server.stderr.on('data', (chunk: string) => { capturedOutput += chunk; });
  const exitedServer = new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null }>((resolve) => {
    server.once('exit', (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
  });
  let hasExited = false;
  void exitedServer.then(() => { hasExited = true; });
  const serverPid = startedPidOf(server);

  function killEverythingLeft(): void {
    signalProcessGroup(serverPid, 'SIGKILL');
    for (const pid of [...descendantPidsOf(serverPid), ...markedPidsOf(home)]) spawnSync('kill', ['-KILL', String(pid)]);
  }
  function killEverythingLeftAndExit(signal: NodeJS.Signals): void {
    killEverythingLeft();
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
  }
  process.once('exit', killEverythingLeft);
  process.once('SIGINT', killEverythingLeftAndExit);
  process.once('SIGTERM', killEverythingLeftAndExit);
  options.testContext.after(() => {
    killEverythingLeft();
    process.removeListener('exit', killEverythingLeft);
    process.removeListener('SIGINT', killEverythingLeftAndExit);
    process.removeListener('SIGTERM', killEverythingLeftAndExit);
  });

  await waitForDashboard(port, () => hasExited).catch((error: unknown) => {
    killEverythingLeft();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${capturedOutput}`);
  });
  const bootMs = Date.now() - startedAt;

  async function waitForLogLine(pattern: RegExp, label: string, deadlineMs = LOG_LINE_DEADLINE_MS): Promise<string> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const matchingLine = linesOf(capturedOutput).find((line) => pattern.test(line));
      if (matchingLine !== undefined) return matchingLine;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`timed out after ${deadlineMs} ms waiting for ${label} in the server log:\n${capturedOutput}`);
  }

  async function stopProcessGroup(signal: NodeJS.Signals = 'SIGTERM'): Promise<StoppedServer> {
    const descendantsAtStop = descendantPidsOf(serverPid);
    const stopRequestedAt = Date.now();
    signalProcessGroup(serverPid, signal);
    let shutdownDeadlineTimer: NodeJS.Timeout | undefined;
    const shutdownDeadline = new Promise<null>((resolve) => { shutdownDeadlineTimer = setTimeout(() => resolve(null), SHUTDOWN_DEADLINE_MS); });
    const exit = await Promise.race([exitedServer, shutdownDeadline]);
    clearTimeout(shutdownDeadlineTimer);
    const shutdownMs = Date.now() - stopRequestedAt;
    await sleep(POLL_INTERVAL_MS * 8);
    const descendantPidsStillRunning = [...descendantsAtStop.filter(isProcessRunning), ...markedPidsOf(home)];
    killEverythingLeft();
    return {
      exitCode: exit?.exitCode ?? null,
      exitSignal: exit?.exitSignal ?? null,
      hasMissedShutdownDeadline: exit === null,
      shutdownMs,
      descendantPidsStillRunning: [...new Set(descendantPidsStillRunning)],
    };
  }

  return {
    port,
    home,
    bootMs,
    logText: () => capturedOutput,
    waitForLogLine,
    descendantPids: () => descendantPidsOf(serverPid),
    stopProcessGroup,
  };
}

export { assertCleanLog, countLogLines, startServer };
export type { RunningServer, StoppedServer };
