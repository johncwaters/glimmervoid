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
import { launchArgs } from '../../shared/agent-models-core.ts';
import { EFFORT_OPTION_ID } from '../../shared/contracts/agent-models.ts';
import type { AgentSetup, CatalogAgentId } from '../../shared/contracts/agent-models.ts';
import { currentAgentModelCatalog } from '../../server/agent-models/agent-models.ts';
import { AUTO_CONTINUE_PROMPT } from '../../session/core/auto-resume.ts';
import { packsStatePath, PACKS_DIR_NAME, readPackDir } from '../../server/packs/pack-files.ts';

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

const WHITEBOARD_PROBE_BOARD_TITLE = 'Lanternfish';
const WHITEBOARD_PROBE_ANSWER = WHITEBOARD_PROBE_BOARD_TITLE.toUpperCase();
const WHITEBOARD_PROBE_PROMPT = 'Glimmervoid may have attached context to this prompt saying a whiteboard changed. Reply with only that board title in capital letters, or NONE if you were told nothing. Run no tools.';
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
  if (!response.ok) throw new Error(`whiteboard ${String(body.sub)} answered ${response.status}`);
  const reply: Record<string, unknown> = await response.json();
  if (reply.ok !== true) throw new Error(`whiteboard ${String(body.sub)} was refused: ${String(reply.error)}`);
  return reply;
}

async function agentIngressBaseOf(backend: { hookPort: () => number | null }): Promise<string> {
  for (let attempt = 0; attempt < 100 && backend.hookPort() === null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const hookPort = backend.hookPort();
  if (hookPort === null) throw new Error('the agent ingress listener never bound');
  return `http://127.0.0.1:${hookPort}`;
}

async function queueWhiteboardEditFor(backend: { hookPort: () => number | null }, reader: WhiteboardProbeSession, writer: WhiteboardProbeSession): Promise<void> {
  const baseUrl = await agentIngressBaseOf(backend);
  const created = await callWhiteboard(baseUrl, writer, { sub: 'new', title: WHITEBOARD_PROBE_BOARD_TITLE });
  const boardId = typeof created.board === 'object' && created.board !== null && 'id' in created.board ? created.board.id : null;
  if (typeof boardId !== 'string') throw new Error('whiteboard new answered without a board id');
  await callWhiteboard(baseUrl, reader, { sub: 'connect', board: boardId });
  await callWhiteboard(baseUrl, writer, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'probe-box', title: 'Probe box', place: { at: { x: 40, y: 40 } } } },
  ] });
}

function screenShowsWhiteboardAnswer(screenText: string): boolean {
  return stripVTControlCharacters(screenText).replace(/\s+/g, '').includes(WHITEBOARD_PROBE_ANSWER);
}

const SHOULD_RUN_ONLY_HINT_PROBE = process.argv.includes('--only-hints');
const SHOULD_RUN_ONLY_MODEL_SETUP_PROBE = process.argv.includes('--only-model-setup');
const SHOULD_RUN_ONLY_BACKGROUND_SELF_WAKE_PROBE = process.argv.includes('--only-background-self-wake');
const SHOULD_RUN_ONLY_RESUME_CONTINUE_PROBE = process.argv.includes('--only-resume-continue');
const BACKGROUND_SELF_WAKE_SETTLE_MS = 20000;
const BACKGROUND_SELF_WAKE_PROBE_PROMPT = 'Start the shell command `sleep 4; echo bg-done` as a background task and do not wait for it: use your shell tool\'s background option (run_in_background) or leave it running in a background terminal. Run no other tool. Then, as your final reply, write a 300-word paragraph about lighthouses and end your turn without checking on the background task. When you are later told the background task finished, reply with the single word finished.';
const MODEL_SETUP_PROBE_PROMPT = 'Reply with the single word copperheron and nothing else.';

async function liveDefaultSetup(agent: CatalogAgentId): Promise<AgentSetup> {
  const deadline = Date.now() + PROBE_STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const models = currentAgentModelCatalog().agents.find((agentModels) => agentModels.agent === agent)?.models ?? [];
    const model = models.find((candidate) => candidate.isDefault) ?? models[0];
    const effort = model?.options.find((option) => option.id === EFFORT_OPTION_ID);
    if (model) return { agent, model: model.id, options: effort ? [{ id: effort.id, value: effort.choices[0] }] : [], instructions: '' };
    await delay(1000);
  }
  throw new Error(`no ${agent} model reached the agent model catalog`);
}

interface ModelSetupProbe {
  session: Session;
  agent: CatalogAgentId;
  hookRecords: ProbeHookRecord[];
  fixtureTarget: ProbeFixtureTarget;
  check: (label: string, condition: boolean) => void;
  answerWaiting: () => Promise<void>;
  afterStart?: () => Promise<void>;
}

async function runModelSetupProbe({ session, agent, hookRecords, fixtureTarget, check, answerWaiting, afterStart = async () => {} }: ModelSetupProbe): Promise<void> {
  console.log('\nmodel-setup-turn:');
  const setup = await liveDefaultSetup(agent);
  console.log(`  [setup] ${JSON.stringify(setup)}`);
  const launchedArgs: string[][] = [];
  const spawnPty = session._ptySpawn;
  session._ptySpawn = (file, spawnArgs, spawnOptions) => {
    launchedArgs.push([...spawnArgs]);
    return spawnPty(file, spawnArgs, spawnOptions);
  };
  session._agentSetup = setup;
  session._initialPrompt = MODEL_SETUP_PROBE_PROMPT;
  const scenarioStart = hookRecords.length;
  await session.start();
  await afterStart();
  await waitForState(session, ['RUNNING', 'WAITING', 'COMPLETE'], 'the model setup turn to start');
  while ((await waitForState(session, ['COMPLETE', 'WAITING'], 'the model setup turn to finish')) === 'WAITING') await answerWaiting();
  await delay(3000);
  const scenarioHooks = hookRecords.slice(scenarioStart);
  console.log(`  [fixture] ${writeHookFixture('model-setup-turn', scenarioHooks, fixtureTarget)}`);
  console.log(`  [events] ${hookEventsOf(scenarioHooks).join(', ')}`);
  const expectedFlags = launchArgs(session.agentId, setup);
  check('the setup produced model flags', expectedFlags.length > 0);
  check('the launch carried the model setup flags', launchedArgs.some((spawnArgs) => expectedFlags.every((flag) => spawnArgs.includes(flag))));
  check('the first prompt reached the agent', scenarioHooks.some((hook) => hook.event.toLowerCase() === 'userpromptsubmit'));
}
const SHOULD_RUN_ONLY_PACK_AGENT_PROBE = process.argv.includes('--only-pack-agent');
const PACK_AGENT_PROBE_PACK_NAME = 'probe-pack';
const PACK_AGENT_PROBE_SKILL_WORD = 'quartzheron';
const PACK_AGENT_PROBE_CONTEXT_WORD = 'emberfinch';
const PACK_AGENT_PROBE_PROMPT = `You have a skill named lookup from the pack ${PACK_AGENT_PROBE_PACK_NAME}, and Glimmervoid may have named a pack context file with this prompt. Use that skill and read that file, then reply with only the two code words they give, separated by a space.`;

async function installApprovedProbePack(glimmervoidHome: string): Promise<void> {
  const packDir = path.join(glimmervoidHome, PACKS_DIR_NAME, PACK_AGENT_PROBE_PACK_NAME);
  fs.mkdirSync(path.join(packDir, 'skills', 'lookup'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({ name: PACK_AGENT_PROBE_PACK_NAME, version: 1, agent: { context: 'CONTEXT.md', skills: ['skills/lookup'] } }));
  fs.writeFileSync(path.join(packDir, 'CONTEXT.md'), `The context code word is ${PACK_AGENT_PROBE_CONTEXT_WORD}.\n`);
  fs.writeFileSync(path.join(packDir, 'skills', 'lookup', 'SKILL.md'), `---\nname: lookup\ndescription: Gives the lookup code word. Use when asked to use the lookup skill.\n---\nThe lookup code word is ${PACK_AGENT_PROBE_SKILL_WORD}.\n`);
  const read = await readPackDir(packDir, process.env);
  if (!read.ok) throw new Error(`the probe pack is invalid: ${read.errors.join('; ')}`);
  fs.writeFileSync(packsStatePath(glimmervoidHome), JSON.stringify({ approvedFingerprints: [read.pack.fingerprint] }));
}

async function waitForPackSessionFiles(configPath: string): Promise<void> {
  const root = path.join(path.dirname(configPath), 'pack-session-files');
  const deadline = Date.now() + PROBE_STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const folders = fs.existsSync(root) ? fs.readdirSync(root) : [];
    if (folders.some((folder) => folder.startsWith(`${PACK_AGENT_PROBE_PACK_NAME}-`) && !folder.includes('.partial-'))) return;
    await delay(250);
  }
  throw new Error(`no approved pack copy appeared in ${root}`);
}

interface PackAgentProbe {
  session: Session;
  configPath: string;
  hookRecords: ProbeHookRecord[];
  fixtureTarget: ProbeFixtureTarget;
  check: (label: string, condition: boolean) => void;
  answerWaiting: () => Promise<void>;
  afterStart?: () => Promise<void>;
  startSession?: () => Promise<void>;
}

async function runPackAgentProbe({ session, configPath, hookRecords, fixtureTarget, check, answerWaiting, afterStart = async () => {}, startSession = () => session.start() }: PackAgentProbe): Promise<void> {
  console.log('\npack-agent-context-skills:');
  await waitForPackSessionFiles(configPath);
  session._initialPrompt = PACK_AGENT_PROBE_PROMPT;
  const scenarioStart = hookRecords.length;
  const outputOffset = session.getOutputOffset();
  await startSession();
  await afterStart();
  await runTurnToCompletion(session, answerWaiting, 'the pack turn');
  await delay(3000);
  const scenarioHooks = hookRecords.slice(scenarioStart);
  console.log(`  [fixture] ${writeHookFixture('pack-agent-context-skills', scenarioHooks, fixtureTarget)}`);
  console.log(`  [events] ${hookEventsOf(scenarioHooks).join(', ')}`);
  const screenText = stripVTControlCharacters(session.getBufferSince(outputOffset).data);
  check('the agent answered with the pack skill code word', screenText.includes(PACK_AGENT_PROBE_SKILL_WORD));
  check('the agent answered with the pack context code word', screenText.includes(PACK_AGENT_PROBE_CONTEXT_WORD));
}

interface ResumeContinueProbe {
  session: Session;
  hookRecords: ProbeHookRecord[];
  fixtureTarget: ProbeFixtureTarget;
  check: (label: string, condition: boolean) => void;
  answerWaiting: () => Promise<void>;
  submitFirstTurn: (() => Promise<void>) | null;
  afterStart?: () => Promise<void>;
}

async function runTurnToCompletion(session: Session, answerWaiting: () => Promise<void>, label: string): Promise<void> {
  await waitForState(session, ['RUNNING', 'WAITING', 'COMPLETE'], `${label} to start`);
  while ((await waitForState(session, ['COMPLETE', 'WAITING'], `${label} to finish`)) === 'WAITING') await answerWaiting();
}

async function runResumeContinueProbe({ session, hookRecords, fixtureTarget, check, answerWaiting, submitFirstTurn, afterStart = async () => {} }: ResumeContinueProbe): Promise<void> {
  console.log('\nresume-continue:');
  if (submitFirstTurn !== null) {
    await submitFirstTurn();
    await runTurnToCompletion(session, answerWaiting, 'the turn before the restart');
  }
  const capturedId = session._resumeSessionId;
  check('the first turn captured a resume id', typeof capturedId === 'string' && capturedId.length > 0);
  const scenarioStart = hookRecords.length;
  check('the respawn with the resume note was accepted', session.forceRestart({ resumePrompt: AUTO_CONTINUE_PROMPT }));
  await waitForState(session, ['DONE', 'FAILED'], 'the killed PTY to be reaped');
  await waitForState(session, ['INITIALIZING', 'STARTING', 'RUNNING', 'IDLE', 'WAITING', 'COMPLETE'], 'the resumed spawn');
  await afterStart();
  await runTurnToCompletion(session, answerWaiting, 'the resumed turn');
  await delay(3000);
  const scenarioHooks = hookRecords.slice(scenarioStart);
  console.log(`  [fixture] ${writeHookFixture('resume-continue', scenarioHooks, fixtureTarget)}`);
  console.log(`  [events] ${hookEventsOf(scenarioHooks).join(', ')}`);
  check('the resume kept the conversation id', session._resumeSessionId === capturedId);
  check('the resumed turn ended on Stop', hookEventsOf(scenarioHooks).includes('stop'));
}
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
  agentIngressBaseOf,
  BACKGROUND_SELF_WAKE_PROBE_PROMPT,
  BACKGROUND_SELF_WAKE_SETTLE_MS,
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
  installApprovedProbePack,
  runModelSetupProbe,
  runPackAgentProbe,
  runResumeContinueProbe,
  SHOULD_RUN_ONLY_BACKGROUND_SELF_WAKE_PROBE,
  SHOULD_RUN_ONLY_HINT_PROBE,
  SHOULD_RUN_ONLY_MODEL_SETUP_PROBE,
  SHOULD_RUN_ONLY_PACK_AGENT_PROBE,
  SHOULD_RUN_ONLY_RESUME_CONTINUE_PROBE,
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
    worktree: { root: path.join(tempDirectory, 'worktrees'), integrationBranch: 'main', autoRebase: false, syncOnStart: false },
    autoResume: false,
    branchGc: { enabled: false }, usage: { enabled: false }, capture: { enabled: recordSessions },
    recordSignals: recordSessions, postTurnChecks: { enabled: false }, checkForUpdates: false,
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
