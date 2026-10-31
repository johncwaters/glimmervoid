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
    .split(os.homedir()).join('<home>')
    .replace(operatorUsernamePattern(), '<user>');
}

function operatorUsernamePattern(): RegExp {
  const escapedUsername = os.userInfo().username.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return new RegExp(`\\b${escapedUsername}\\b`, 'g');
}

function writeHookFixture(name: string, hooks: ProbeHookRecord[], target: ProbeFixtureTarget): string {
  const header = { type: 'header', version: 2, records: 'signals', session: `fixture-${target.agentId}-${name}`, agent: target.agentId, startedAt: 0, config: { hooksInjected: true } };
  const lines = [header, ...hooks.map((hook, index) => ({ type: 'hook', ts: index + 1, event: hook.event, payload: projectHookPayload(hook.payload) }))];
  const directory = target.shouldWriteFixtures ? PROBE_FIXTURE_DIRECTORY : target.keepDirectory;
  const destination = path.join(directory, `v2-${target.agentId}-${name}.jsonl`);
  fs.writeFileSync(destination, `${sanitizeProbeText(lines.map((line) => JSON.stringify(line)).join('\n'), target)}\n`, 'utf8');
  return destination;
}

const WHITEBOARD_PROBE_BOX_TITLE = 'Lanternfish';
const WHITEBOARD_PROBE_ANSWER = 'HSIFNRETNAL';
const WHITEBOARD_PROBE_PROMPT = 'Glimmervoid may have attached context to this prompt saying a box was added to a whiteboard. Reply with only that box title spelled backwards in capital letters, or NONE if you were told nothing. Run no tools.';
const SHOULD_RUN_ONLY_WHITEBOARD_PROBE = process.argv.includes('--only-whiteboard');

interface WhiteboardProbeSession {
  id: string;
  agentToken: string | null;
}

function whiteboardWriterIdFor(readerId: string): string {
  return `${readerId}-board-writer`;
}

function whiteboardWriterProject(readerId: string, projectDirectory: string, agent: string): Record<string, unknown> {
  return { id: whiteboardWriterIdFor(readerId), name: 'board writer', path: projectDirectory, agent, dangerouslySkipPermissions: false };
}

async function callWhiteboard(baseUrl: string, session: WhiteboardProbeSession, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!session.agentToken) throw new Error(`${session.id} has no agent token`);
  const response = await fetch(`${baseUrl}/agent/${session.id}/whiteboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.agentToken}` },
    body: JSON.stringify(body),
  });
  const reply: Record<string, unknown> = await response.json();
  if (reply.ok !== true) throw new Error(`whiteboard ${String(body.sub)} was refused: ${String(reply.error)}`);
  return reply;
}

async function queueWhiteboardEditFor(baseUrl: string, reader: WhiteboardProbeSession, writer: WhiteboardProbeSession): Promise<void> {
  const created = await callWhiteboard(baseUrl, writer, { sub: 'new', title: 'Probe board' });
  const boardId = typeof created.board === 'object' && created.board !== null && 'id' in created.board ? created.board.id : null;
  if (typeof boardId !== 'string') throw new Error('whiteboard new answered without a board id');
  await callWhiteboard(baseUrl, reader, { sub: 'connect', board: boardId });
  await callWhiteboard(baseUrl, writer, { sub: 'put', board: boardId, ops: [
    { op: 'columns', columns: [{ id: 'intake', title: 'Intake' }] },
    { op: 'add', element: { kind: 'box', id: 'probe-box', title: WHITEBOARD_PROBE_BOX_TITLE, column: 'intake' } },
  ] });
}

function screenShowsWhiteboardAnswer(screenText: string): boolean {
  return stripVTControlCharacters(screenText).replace(/\s+/g, '').includes(WHITEBOARD_PROBE_ANSWER);
}

const SHOULD_RUN_ONLY_HINT_PROBE = process.argv.includes('--only-hints');
const HINT_PROBE_PROMPT = "Run the shell command: echo hint-probe.png . Then quote verbatim every sentence beginning with 'Glimmervoid' that reached you with this message or with that tool result, or reply none.";
const SPAWN_HINT_PROBE_PROMPT = "Use the Agent tool to start one subagent that replies with the single word ok. Wait for it, then reply with the single word done.";
const QUEUED_HINT_PROBE_PROMPT = "Quote verbatim every sentence beginning with 'Glimmervoid:' that reached you with this message, or reply none.";
const SHOW_HINT_MARKER = 'glimmervoidshow<path>';
const SPAWN_HINT_MARKER = 'glimmervoidspawn<prompt>';
const START_LINE_MARKER = 'Glimmervoidsupervisesthissession';

function screenShows(screenText: string, marker: string): boolean {
  return stripVTControlCharacters(screenText).replace(/\s+/g, '').includes(marker);
}

function screenShowsShowHint(screenText: string): boolean {
  return screenShows(screenText, SHOW_HINT_MARKER);
}

function screenShowsSpawnHint(screenText: string): boolean {
  return screenShows(screenText, SPAWN_HINT_MARKER);
}

function screenShowsStartLine(screenText: string): boolean {
  return screenShows(screenText, START_LINE_MARKER);
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
  HINT_PROBE_PROMPT,
  hookEventsOf,
  QUEUED_HINT_PROBE_PROMPT,
  SPAWN_HINT_PROBE_PROMPT,
  listen,
  removeHarnessTempDirectory,
  queueWhiteboardEditFor,
  safeTextTail,
  sanitizeProbeText,
  screenShowsShowHint,
  screenShowsSpawnHint,
  screenShowsStartLine,
  screenShowsWhiteboardAnswer,
  SHOULD_RUN_ONLY_HINT_PROBE,
  SHOULD_RUN_ONLY_WHITEBOARD_PROBE,
  waitForState,
  whiteboardWriterIdFor,
  whiteboardWriterProject,
  WHITEBOARD_PROBE_PROMPT,
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
