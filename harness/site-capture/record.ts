import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type WebSocket from 'ws';
import { z } from 'zod';
import { ServerMessage, SessionCardFields } from '../../shared/contracts/control-messages.ts';
import { SessionState as SessionStateSchema } from '../../shared/contracts/session.ts';
import { STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';
import { dashboardClient, openSocket } from '../../tests/helpers/dashboard-ws.ts';
import { safeTextTail } from '../support/backend-harness.ts';
import {
  addSession, cancellation, createProject, git, listProcessesMentioning, prepareIsolatedEnvironment, quoteShell, readSessionGrid,
  refuseUnsupportedLaunch, runIsolatedDashboard, selectSession,
} from './isolated-glimmervoid.ts';
import { classifyClaudeStartup, hasRunSettled, isRecordingClosed, validateRecordManifest } from './manifest-core.ts';
import type { RecordManifest } from './manifest-core.ts';

type RecordSession = RecordManifest['sessions'][number];

interface SessionProgress {
  statesSeen: SessionState[];
  branch: string | null;
}

interface RecordContext {
  page: Page;
  socket: WebSocket;
  port: number;
  projectPaths: Map<string, string>;
  recordingsDirectory: string;
  outputDirectory: string;
  progressById: Map<string, SessionProgress>;
  terminalSize: { cols: number; rows: number } | null;
}

const StateChangeFields = z.object({ id: SessionCardFields.shape.id, to: SessionStateSchema });
const WorktreeReadyFields = z.object({ id: SessionCardFields.shape.id, branch: z.string().nullable() });
const OnboardingState = z.object({ hasCompletedOnboarding: z.boolean().optional(), lastOnboardingVersion: z.string().optional() });
const socketOpenState = 1;
const recordedSessionEnvironmentAllowlist = new Set(['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME']);
const harnessClaudeConfigDirectoryName = 'claude-config';
const agentHomeDirectoryName = 'agent-home';
const claudeCredentialsFileName = '.credentials.json';
const claudeGlobalConfigFileName = '.claude.json';
const demoSettingsRelativePath = path.join('.claude', 'settings.local.json');
const demoDeniedPermissions = [
  'Bash(git push:*)', 'Bash(rm -rf:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(ssh:*)', 'Bash(scp:*)', 'Bash(env)', 'Bash(printenv:*)',
  'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.config/gh/**)', 'Read(~/.npmrc)', 'Read(~/.claude/**)',
];

function parseArguments(argv: string[]): { manifestPath: string; executablePath?: string } {
  const manifestPath = argv[0];
  if (!manifestPath || manifestPath.startsWith('--')) throw new Error('usage: site:record <record-manifest.json> [--executable <Chrome path>]');
  let executablePath = process.env.CHROME_PATH;
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag === '--executable') { executablePath = path.resolve(value); continue; }
    throw new Error(`unknown argument ${flag}`);
  }
  return { manifestPath: path.resolve(manifestPath), executablePath };
}

async function findExecutableOnPath(commandName: string, searchPath: string): Promise<string> {
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, commandName);
    const isExecutable = await fs.access(candidate, fs.constants.X_OK).then(() => true, () => false);
    if (isExecutable) return fs.realpath(candidate);
  }
  throw new Error(`${commandName} is not on PATH`);
}

async function excludeDemoSettings(projectPath: string): Promise<void> {
  const infoDirectory = path.join(projectPath, '.git', 'info');
  await fs.mkdir(infoDirectory, { recursive: true });
  await fs.appendFile(path.join(infoDirectory, 'exclude'), `/${demoSettingsRelativePath}\n`);
}

async function listRecordingFiles(recordingsDirectory: string): Promise<Set<string>> {
  const names = await fs.readdir(recordingsDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return new Set(names.filter((name) => name.endsWith('.jsonl')));
}

async function hasFooter(recordingPath: string): Promise<boolean> {
  return isRecordingClosed(await fs.readFile(recordingPath, 'utf8'));
}

function readConfiguredClaudeConfigDirectory(): string | undefined {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || undefined;
}

function resolveOperatorClaudeConfigDirectory(): string {
  return readConfiguredClaudeConfigDirectory() ?? path.join(os.homedir(), '.claude');
}

async function readOperatorOnboardingState(): Promise<z.infer<typeof OnboardingState>> {
  const globalConfigPath = path.join(readConfiguredClaudeConfigDirectory() ?? os.homedir(), claudeGlobalConfigFileName);
  const globalConfigText = await fs.readFile(globalConfigPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (globalConfigText === null) return { hasCompletedOnboarding: true };
  return { ...OnboardingState.parse(JSON.parse(globalConfigText)), hasCompletedOnboarding: true };
}

async function isolateClaudeConfig(tempDirectory: string, operatorCredentialsPath: string, onboardingState: z.infer<typeof OnboardingState>): Promise<void> {
  for (const key of Object.keys(process.env)) if (!recordedSessionEnvironmentAllowlist.has(key)) delete process.env[key];
  const claudeConfigDirectory = path.join(tempDirectory, harnessClaudeConfigDirectoryName);
  await fs.mkdir(claudeConfigDirectory, { mode: 0o700 });
  await fs.copyFile(operatorCredentialsPath, path.join(claudeConfigDirectory, claudeCredentialsFileName));
  await fs.chmod(path.join(claudeConfigDirectory, claudeCredentialsFileName), 0o600);
  await fs.writeFile(path.join(claudeConfigDirectory, claudeGlobalConfigFileName), `${JSON.stringify(onboardingState, null, 2)}\n`, { mode: 0o600 });
  await fs.mkdir(path.join(tempDirectory, agentHomeDirectoryName));
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDirectory;
}

function trackControlFrames(socket: WebSocket, progressById: Map<string, SessionProgress>): void {
  socket.on('message', (raw: Buffer) => {
    const parsedFrame = ServerMessage.safeParse(JSON.parse(raw.toString()));
    if (!parsedFrame.success) return;
    const frame = parsedFrame.data;
    if (frame.type === 'state-change') {
      const stateChange = StateChangeFields.parse(frame);
      const progress = progressById.get(stateChange.id);
      if (!progress) return;
      progress.statesSeen.push(stateChange.to);
      console.log(`  state: ${stateChange.to}`);
      return;
    }
    if (frame.type !== 'session-worktree-ready') return;
    const worktreeReady = WorktreeReadyFields.parse(frame);
    const progress = progressById.get(worktreeReady.id);
    if (progress) progress.branch = worktreeReady.branch;
  });
}

async function sendInput(inputSocket: WebSocket, text: string): Promise<void> {
  if (inputSocket.readyState !== socketOpenState) throw new Error('terminal input socket closed');
  inputSocket.send(JSON.stringify({ type: 'input', data: text }));
  await sleep(0, undefined, { signal: cancellation.signal });
}

async function waitForClaudePrompt(page: Page, sessionId: string, inputSocket: WebSocket): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const grid = await readSessionGrid(page, sessionId);
    const screen = classifyClaudeStartup(grid?.lines ?? []);
    if (screen === 'ready') return;
    if (screen === 'trust-prompt') {
      await sleep(800, undefined, { signal: cancellation.signal });
      await sendInput(inputSocket, '\u001b[B');
    }
    if (screen === 'trust-accept-selected') {
      console.log('  trust prompt: accepting for the throwaway worktree');
      await sendInput(inputSocket, '\r');
      await sleep(1500, undefined, { signal: cancellation.signal });
    }
    await sleep(250, undefined, { signal: cancellation.signal });
  }
  const lastScreen = (await readSessionGrid(page, sessionId))?.lines ?? [];
  console.log(lastScreen.filter((line) => line.trim().length > 0).join('\n'));
  throw new Error('Claude Code prompt did not appear within 90s');
}

async function typeTask(inputSocket: WebSocket, task: string): Promise<void> {
  const charactersPerKeystroke = 4;
  for (let offset = 0; offset < task.length; offset += charactersPerKeystroke) {
    await sendInput(inputSocket, task.slice(offset, offset + charactersPerKeystroke));
    await sleep(30, undefined, { signal: cancellation.signal });
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(200, undefined, { signal: cancellation.signal });
  }
  return condition();
}

async function submitTask(inputSocket: WebSocket, progress: SessionProgress): Promise<void> {
  const hasStartedRunning = () => progress.statesSeen.includes(STATES.RUNNING);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sendInput(inputSocket, '\r');
    if (await waitFor(hasStartedRunning, 20_000)) return;
    console.log('  prompt not submitted yet, pressing Enter again');
  }
  throw new Error('task was never submitted');
}

async function waitForSettledRun(progress: SessionProgress, maxMinutes: number): Promise<boolean> {
  const deadline = Date.now() + maxMinutes * 60_000;
  while (Date.now() < deadline) {
    const isSettled = await waitFor(() => hasRunSettled(progress.statesSeen), deadline - Date.now());
    if (!isSettled) return false;
    await sleep(5000, undefined, { signal: cancellation.signal });
    if (hasRunSettled(progress.statesSeen)) return true;
  }
  return false;
}

async function exportCommits(projectPath: string, branch: string | null, patchPath: string): Promise<string[]> {
  await fs.rm(patchPath, { force: true });
  if (!branch) return [];
  const subjects = (await git(projectPath, ['log', '--format=%s', `main..${branch}`])).split('\n').filter(Boolean);
  if (subjects.length === 0) return [];
  await fs.writeFile(patchPath, await git(projectPath, ['format-patch', '--stdout', `main..${branch}`]));
  return subjects;
}

async function collectRecording(recordingsDirectory: string, previousRecordings: Set<string>, recordingCopyPath: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const newRecordings = [...await listRecordingFiles(recordingsDirectory)].filter((name) => !previousRecordings.has(name));
    if (newRecordings.length > 1) throw new Error(`expected one new recording, found ${newRecordings.join(', ')}`);
    const recordingName = newRecordings[0];
    if (recordingName && await hasFooter(path.join(recordingsDirectory, recordingName))) {
      await fs.copyFile(path.join(recordingsDirectory, recordingName), recordingCopyPath);
      return;
    }
    await sleep(250, undefined, { signal: cancellation.signal });
  }
  throw new Error('session recording did not close within 20s');
}

async function selectSessionAtTerminalSize(page: Page, sessionId: string, expectedSize: { cols: number; rows: number } | null): Promise<{ cols: number; rows: number }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await selectSession(page, sessionId);
    const grid = await readSessionGrid(page, sessionId);
    if (grid && !expectedSize) return { cols: grid.cols, rows: grid.rows };
    if (grid && grid.cols === expectedSize?.cols && grid.rows === expectedSize.rows) return expectedSize;
    await sleep(500, undefined, { signal: cancellation.signal });
  }
  throw new Error(`terminal ${sessionId} never reached ${expectedSize?.cols}x${expectedSize?.rows}`);
}

async function recordSession(context: RecordContext, session: RecordSession): Promise<void> {
  const projectPath = context.projectPaths.get(session.project);
  if (!projectPath) throw new Error(`missing project ${session.project}`);
  const startedAt = Date.now();
  console.log(`session: ${session.name} (${session.project}, ${session.dangerouslySkipPermissions ? 'skip permissions' : 'default permissions'})`);
  const previousRecordings = await listRecordingFiles(context.recordingsDirectory);
  const sessionId = await addSession(context.socket, session.name, projectPath, session.dangerouslySkipPermissions);
  const progress: SessionProgress = { statesSeen: [], branch: null };
  context.progressById.set(sessionId, progress);
  context.terminalSize = await selectSessionAtTerminalSize(context.page, sessionId, context.terminalSize);
  console.log(`  terminal: ${context.terminalSize.cols}x${context.terminalSize.rows}`);
  const client = await dashboardClient(context.port);
  const inputSocket = await openSocket(client, `/terminals/${encodeURIComponent(sessionId)}`);
  try {
    await waitForClaudePrompt(context.page, sessionId, inputSocket);
    await sleep(1500, undefined, { signal: cancellation.signal });
    await typeTask(inputSocket, session.task);
    await sleep(800, undefined, { signal: cancellation.signal });
    await submitTask(inputSocket, progress);
    const isSettled = await waitForSettledRun(progress, session.maxMinutes);
    console.log(`  run ${isSettled ? 'settled' : 'hit maxMinutes'} as ${progress.statesSeen.at(-1)} after ${Math.round((Date.now() - startedAt) / 1000)}s`);
    await sleep(2000, undefined, { signal: cancellation.signal });
    const commitSubjects = await exportCommits(projectPath, progress.branch, path.join(context.outputDirectory, `${session.name}.patch`));
    if (commitSubjects.length === 0) console.warn(`  warning: ${session.name} produced no commits, so no patch was written`);
    if (commitSubjects.length > 0) console.log(`  commits: ${commitSubjects.join(' | ')}`);
  } finally {
    context.socket.send(JSON.stringify({ type: 'kill', id: sessionId }));
    inputSocket.terminate();
  }
  const recordingCopyPath = path.join(context.outputDirectory, `${session.name}.jsonl`);
  await collectRecording(context.recordingsDirectory, previousRecordings, recordingCopyPath);
  context.socket.send(JSON.stringify({ type: 'remove-session', id: sessionId }));
  console.log(`  recording: ${recordingCopyPath} (${(await fs.stat(recordingCopyPath)).size} bytes)`);
}

async function waitForAgentExit(processNeedles: string[]): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const survivors = await listProcessesMentioning(processNeedles);
    if (survivors.length === 0) { console.log('cleanup: no surviving agent processes'); return; }
    await sleep(200);
  }
  throw new Error(`agent processes survived record cleanup: ${(await listProcessesMentioning(processNeedles)).join('; ')}`);
}

async function main(): Promise<void> {
  refuseUnsupportedLaunch('site record');
  const options = parseArguments(process.argv.slice(2));
  const manifestDirectory = path.dirname(options.manifestPath);
  const manifest = validateRecordManifest(JSON.parse(await fs.readFile(options.manifestPath, 'utf8')));
  const seedDirectories = new Map(Object.entries(manifest.projects).map(([projectName, seedDirectory]) => [projectName, path.resolve(manifestDirectory, seedDirectory)]));
  for (const seedDirectory of seedDirectories.values()) await fs.access(seedDirectory);
  const outputDirectory = path.resolve(manifestDirectory, manifest.outputDirectory);
  await fs.mkdir(outputDirectory, { recursive: true });
  const realClaudePath = await findExecutableOnPath('claude', process.env.PATH ?? '');
  const operatorCredentialsPath = path.join(resolveOperatorClaudeConfigDirectory(), claudeCredentialsFileName);
  await fs.access(operatorCredentialsPath).catch(() => { throw new Error(`site record needs Claude credentials at ${operatorCredentialsPath}`); });
  const onboardingState = await readOperatorOnboardingState();
  let processNeedles: string[] = [];
  await runIsolatedDashboard({
    label: 'site record',
    tempDirectoryPrefix: 'gv-demo-',
    executablePath: options.executablePath,
    isolateEnvironment: (tempDirectory) => isolateClaudeConfig(tempDirectory, operatorCredentialsPath, onboardingState),
    waitForAgentExit: (tempDirectory) => waitForAgentExit(processNeedles.length > 0 ? processNeedles : [tempDirectory]),
  }, async ({ tempDirectory, startServer, openDashboard }) => {
    const savedPath = process.env.PATH ?? '';
    const projectPaths = new Map<string, string>();
    for (const [projectName, seedDirectory] of seedDirectories) projectPaths.set(projectName, await createProject(tempDirectory, projectName, seedDirectory));
    for (const projectPath of projectPaths.values()) await excludeDemoSettings(projectPath);
    const demoSettingsPath = path.join(tempDirectory, 'demo-settings.local.json');
    const demoSettings = { skipDangerousModePermissionPrompt: true, permissions: { deny: demoDeniedPermissions } };
    await fs.writeFile(demoSettingsPath, `${JSON.stringify(demoSettings, null, 2)}\n`);
    const { port, configPath } = await prepareIsolatedEnvironment({ tempDirectory, repoRoots: [...projectPaths.values()], recordSessions: true });
    processNeedles = [tempDirectory, `127.0.0.1:${port}`];
    const wrapperDirectory = path.join(tempDirectory, 'bin');
    await fs.mkdir(wrapperDirectory);
    const isolationArguments = ['--setting-sources', 'project,local', '--strict-mcp-config', '--model', manifest.model].map(quoteShell).join(' ');
    const wrapperScript = [
      '#!/bin/sh',
      `HOME=${quoteShell(path.join(tempDirectory, agentHomeDirectoryName))}`,
      'export HOME',
      'permission_mode_arguments="--permission-mode default"',
      'for argument in "$@"; do [ "$argument" = "--dangerously-skip-permissions" ] && permission_mode_arguments=""; done',
      `mkdir -p .claude && cp -f ${quoteShell(demoSettingsPath)} ${quoteShell(demoSettingsRelativePath)} || exit 1`,
      `exec ${quoteShell(realClaudePath)} ${isolationArguments} $permission_mode_arguments "$@"`,
    ].join('\n');
    await fs.writeFile(path.join(wrapperDirectory, 'claude'), `${wrapperScript}\n`, { mode: 0o755 });
    process.env.PATH = `${wrapperDirectory}${path.delimiter}${savedPath}`;
    const { socket } = await startServer(port, configPath);
    const progressById = new Map<string, SessionProgress>();
    trackControlFrames(socket, progressById);
    const page = await openDashboard(port, { viewport: manifest.viewport });
    const recordingsDirectory = path.join(path.dirname(configPath), 'recordings');
    const context: RecordContext = { page, socket, port, projectPaths, recordingsDirectory, outputDirectory, progressById, terminalSize: null };
    for (const session of manifest.sessions) await recordSession(context, session);
  });
}

try {
  await main();
} catch (error) {
  console.error(`site record failed: ${safeTextTail(error, 2000)}`);
  process.exitCode = cancellation.signal.aborted ? 130 : 1;
}
