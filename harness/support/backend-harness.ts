import type { Server } from 'node:http';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import os from 'node:os';
import { writeJsonAtomic } from '../../server/json-file.ts';
import { projectHookPayload } from '../../session/core/hook-payload-projection.ts';
import type { Session } from '../../session/sessions.ts';
import type { HookPayload } from '../../shared/contracts/index.ts';

import WebSocket from 'ws';

import { dashboardClient } from '../../tests/helpers/dashboard-ws.ts';

const CLAUDE_CONFIG_DIRECTORY_NAME = 'claude-config';
const CREDENTIALS_COPY_NAME = '.credentials.json';
const PROBE_FIXTURE_DIRECTORY = path.join(import.meta.dirname, '..', '..', 'tests', 'fixtures');
const PROBE_STEP_TIMEOUT_MS = 120000;

export interface ProbeHookRecord {
  event: string;
  payload: HookPayload | null;
}

export interface ProbeFixtureTarget {
  agentId: string;
  tempDirectory: string;
  keepDirectory: string;
  shouldWriteFixtures: boolean;
}

function createProbeChecks() {
  let passedCount = 0;
  let failedCount = 0;
  function check(label: string, condition: boolean): void {
    if (condition) {
      console.log(`  PASS  ${label}`);
      passedCount += 1;
      return;
    }
    console.error(`  FAIL  ${label}`);
    failedCount += 1;
  }
  return { check, passed: () => passedCount, failed: () => failedCount };
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function waitForState(session: Session, states: string[], label: string, timeoutMs = PROBE_STEP_TIMEOUT_MS): Promise<string> {
  const wantedStates = new Set(states);
  if (wantedStates.has(session.state)) return Promise.resolve(session.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off('state-change', onStateChange);
      reject(new Error(`timed out waiting for ${label}, still ${session.state}`));
    }, timeoutMs);
    function onStateChange({ to }: { to: string }): void {
      if (!wantedStates.has(to)) return;
      clearTimeout(timer);
      session.off('state-change', onStateChange);
      resolve(to);
    }
    session.on('state-change', onStateChange);
  });
}

function sanitizeProbeText(text: string, target: ProbeFixtureTarget): string {
  const placeholder = `<${target.agentId}-probe>`;
  const realTempDirectory = fs.realpathSync(target.tempDirectory);
  const encodedProjectPrefix = realTempDirectory.replace(/[^A-Za-z0-9]/g, '-');
  return text
    .split(realTempDirectory).join(placeholder)
    .split(target.tempDirectory).join(placeholder)
    .split(encodedProjectPrefix).join(placeholder)
    .split(os.homedir()).join('<home>');
}

function writeHookFixture(name: string, hooks: ProbeHookRecord[], target: ProbeFixtureTarget): string {
  const header = { type: 'header', version: 2, records: 'signals', session: `fixture-${target.agentId}-${name}`, agent: target.agentId, startedAt: 0, config: { hooksInjected: true } };
  const lines = [header, ...hooks.map((hook, index) => ({ type: 'hook', ts: index + 1, event: hook.event, payload: projectHookPayload(hook.payload) }))];
  const directory = target.shouldWriteFixtures ? PROBE_FIXTURE_DIRECTORY : target.keepDirectory;
  const destination = path.join(directory, `v2-${target.agentId}-${name}.jsonl`);
  fs.writeFileSync(destination, `${sanitizeProbeText(lines.map((line) => JSON.stringify(line)).join('\n'), target)}\n`, 'utf8');
  return destination;
}

function hookEventsOf(hooks: ProbeHookRecord[]): string[] {
  return hooks.map((hook) => hook.event.toLowerCase());
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off('listening', onListening);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function closeServer(server: Server | null | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function findFreeHighPort(): Promise<number> {
  const reservationServer = http.createServer();
  await listen(reservationServer, 0);
  const address = reservationServer.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await closeServer(reservationServer);
  if (port === null || !Number.isInteger(port) || port < 1024) throw new Error('could not reserve a free high port');
  return port;
}

async function connectControl(port: number): Promise<WebSocket> {
  const client = await dashboardClient(port);
  const socket = new WebSocket(client.url('/control'), client.options);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function safeTextTail(value: unknown, maxCharacters = 2048): string {
  return stripVTControlCharacters(String(value || ''))
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .slice(-maxCharacters);
}

function credentialsCopyPath(tempDirectory: string): string {
  return path.join(tempDirectory, CLAUDE_CONFIG_DIRECTORY_NAME, CREDENTIALS_COPY_NAME);
}

function removeHarnessTempDirectory(tempDirectory: string): void {
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.error(`temp directory removal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const leftoverCredentialsPath = credentialsCopyPath(tempDirectory);
  if (!fs.existsSync(leftoverCredentialsPath)) return;
  console.error(`WARNING: copied Claude credentials remain at ${leftoverCredentialsPath}, delete them by hand`);
  process.exitCode = 1;
}

export {
  closeServer,
  connectControl,
  createProbeChecks,
  delay,
  findFreeHighPort,
  hookEventsOf,
  listen,
  removeHarnessTempDirectory,
  safeTextTail,
  sanitizeProbeText,
  waitForState,
  writeHookFixture,
};

export interface IsolatedConfigOptions {
  tempDirectory: string;
  repoRoots: string[];
  recordSessions: boolean;
  mutateEnvironment?: boolean;
}

export async function prepareIsolatedEnvironment({ tempDirectory, repoRoots, recordSessions, mutateEnvironment = true }: IsolatedConfigOptions) {
  const port = await findFreeHighPort();
  const configPath = path.join(tempDirectory, 'config.json');
  await writeJsonAtomic(configPath, {
    port, projects: [], teams: [], repoRoots,
    worktreeRoot: path.join(tempDirectory, 'worktrees'), integrationBranch: 'main',
    autoResume: false, worktreeAutoRebase: false, worktreeSyncOnStart: false,
    branchGc: { enabled: false }, usage: { enabled: false }, capture: { enabled: recordSessions },
    recordSignals: recordSessions, postTurnChecks: { enabled: false }, checkForUpdates: false,
    planReview: { enabled: false }, remote: { enabled: false },
    posthog: { enabled: false }, telegram: { enabled: false }, teamReview: { enabled: false },
    telemetry: { enabled: false },
  });
  const isolatedHome = path.join(tempDirectory, 'home');
  const isolatedTemp = path.join(tempDirectory, 'tmp');
  await fs.promises.mkdir(isolatedHome);
  await fs.promises.mkdir(isolatedTemp);
  const environment = {
    GLIMMERVOID_HOME: isolatedHome, GLIMMERVOID_CONFIG: configPath, GLIMMERVOID_PORT: String(port),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', TMPDIR: isolatedTemp,
  };
  if (mutateEnvironment) Object.assign(process.env, environment);
  return { port, configPath, isolatedHome, isolatedTemp, environment };
}
