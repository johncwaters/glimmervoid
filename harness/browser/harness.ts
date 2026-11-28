import '../support/disable-telemetry.ts';
import '../support/git-local-env.ts';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Browser } from 'playwright-core';
import type { Plugin } from 'vite';

import { resolveWorktreeGitDir } from '../../detection/worktree-watch.ts';
import { setDefaultHeadroomReader } from '../../server/backend/backend-health.ts';
import { getAdapter, listAgentIds } from '../../session/adapters/index.ts';
import { isolateTranscriptHomes } from '../../tests/helpers/transcript-homes.ts';
import { findFreeHighPort, removeHarnessTempDirectory, safeTextTail } from '../support/backend-harness.ts';
import { BROWSER_ENGINES, browserEngineNamed, browserTypeOf } from '../support/browser-engines.ts';
import { createProject } from '../site-capture/isolated-glimmervoid.ts';
import { needsDoneMeansChecks, needsGitOrigin, needsSessionChat, needsTeamReview, selectCases } from './cases-core.ts';
import { DONE_MEANS_UNTRACKED_FILE } from './chat-page.ts';
import { deviceLogPlugin, withoutIpv4MappedPrefix } from './device-log.ts';
import type { HarnessCase } from './cases-core.ts';
import {
  EXIT_HARNESS_ERROR,
  PROVE_FAILURE_SCENARIO,
  decideExitCode,
  renderMarkdown,
  renderProveFailureCheck,
  summarize,
} from './report-core.ts';
import type { BrowserRunReport, CaseRecord, SurvivorCheck } from './report-core.ts';
import { FAKE_PR_STATE_ENV, fakePrStatePathIn } from './fake-pr.ts';
import { COLD_START_PAGE_READY_MS, DEFAULT_DEADLINES, errorText, runCase } from './runner.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_ARTIFACTS_DIR = path.join(REPO_ROOT, 'harness', 'browser', 'artifacts');
const FAKE_AGENT_PATH = path.join(import.meta.dirname, 'fake-agent.ts');
const FAKE_ACP_AGENT_PATH = path.join(import.meta.dirname, 'fake-acp-agent.ts');
const FAKE_GH_PATH = path.join(import.meta.dirname, 'fake-gh.ts');
const REFUSED_LIFECYCLE_EVENTS = new Set(['build', 'start', 'prepare', 'postinstall']);
const LEFTOVER_SCAN_ATTEMPTS = 25;
const LEFTOVER_SCAN_INTERVAL_MS = 200;
const PROCESS_LISTING_MAX_BYTES = 8 * 1024 * 1024;
const HARNESS_FIXED_HEADROOM_BYTES = 64 * 1024 * 1024 * 1024;

interface HarnessOptions {
  only: string[];
  viewportNames: string[];
  artifactsDir: string;
  proveFailure: boolean;
  headed: boolean;
  executablePath: string | null;
  browserName: string;
  lanAddress: string | null;
  lanAllowedPeers: string[];
  typingSearchSeed: number;
  typingSearchBudgetSeconds: number;
  typingSearchDeviceLogPath: string | null;
  unknownArguments: string[];
  flagsMissingValues: string[];
  flagsWithInvalidValues: string[];
}

const DEFAULT_TYPING_SEARCH_BUDGET_SECONDS = 60;
const LAN_DEFAULT_VIEWPORT = 'phone-393';
const LAN_DEFAULT_SCENARIO_PREFIX = 'touch-';
const LAN_DEVICE_STEPS = [
  'Open the URL in iOS Safari and in Android Chrome; with a cable, inspect each from Safari Web Inspector or chrome://inspect.',
  'Add to Home Screen, open it from the icon, and confirm it runs without the browser bar and clear of the notch.',
  'On the Terminal screen, tap the terminal and type with suggestions and dictation; accept an autocorrect and the word changes in the agent prompt.',
  'Tap Ctrl then c on the terminal keyboard; the agent gets Ctrl+C.',
  'Hold an arrow key; it repeats and stops on release. Every key row fits the screen without scrolling sideways.',
  'In the shell session, typing gets no automatic capital; run vim or less and the keys go to the app.',
  'Rotate the phone and open and close the keyboard; the terminal refits each time.',
  'Long-press a word in the terminal: the phone selects it with its own handles lined up on the text, drag a handle across rows, Copy, and paste elsewhere unchanged. Scroll still works after.',
  'Under More, tap Select: select across many lines in the sheet and copy; then try Copy screen and Copy output and paste each elsewhere.',
];

const APPLY_VALUE_BY_FLAG = new Map<string, (options: HarnessOptions, value: string) => void>([
  ['--only', (options, value) => { options.only.push(value); }],
  ['--viewport', (options, value) => { options.viewportNames.push(value); }],
  ['--artifacts', (options, value) => { options.artifactsDir = path.resolve(value); }],
  ['--executable', (options, value) => { options.executablePath = path.resolve(value); }],
  ['--browser', (options, value) => { options.browserName = value; }],
  ['--lan', (options, value) => { options.lanAddress = value; }],
  ['--lan-allow', (options, value) => { options.lanAllowedPeers.push(value); }],
  ['--seed', (options, value) => {
    const seed = Number(value);
    if (!Number.isSafeInteger(seed) || seed < 0) {
      options.flagsWithInvalidValues.push(`--seed ${value}`);
      return;
    }
    options.typingSearchSeed = seed;
  }],
  ['--replay-device-log', (options, value) => { options.typingSearchDeviceLogPath = path.resolve(value); }],
  ['--budget-seconds', (options, value) => {
    const budgetSeconds = Number(value);
    if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
      options.flagsWithInvalidValues.push(`--budget-seconds ${value}`);
      return;
    }
    options.typingSearchBudgetSeconds = budgetSeconds;
  }],
]);

function valueFollowing(argv: readonly string[], flagIndex: number): string | null {
  const value = argv[flagIndex + 1];
  if (value === undefined) return null;
  if (value.startsWith('--')) return null;
  return value;
}

function parseArguments(argv: readonly string[]): HarnessOptions {
  const options: HarnessOptions = {
    only: [],
    viewportNames: [],
    artifactsDir: DEFAULT_ARTIFACTS_DIR,
    proveFailure: false,
    headed: false,
    executablePath: null,
    browserName: 'chromium',
    lanAddress: null,
    lanAllowedPeers: [],
    typingSearchSeed: Date.now() % 2 ** 32,
    typingSearchBudgetSeconds: DEFAULT_TYPING_SEARCH_BUDGET_SECONDS,
    typingSearchDeviceLogPath: null,
    unknownArguments: [],
    flagsMissingValues: [],
    flagsWithInvalidValues: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--prove-failure') {
      options.proveFailure = true;
      continue;
    }
    if (argument === '--headed') {
      options.headed = true;
      continue;
    }
    const applyValue = APPLY_VALUE_BY_FLAG.get(argument);
    if (!applyValue) {
      options.unknownArguments.push(argument);
      continue;
    }
    const value = valueFollowing(argv, index);
    if (value === null) {
      options.flagsMissingValues.push(argument);
      continue;
    }
    applyValue(options, value);
    index += 1;
  }
  return options;
}

function readRepoHead(): string {
  try {
    const gitDir = resolveWorktreeGitDir(REPO_ROOT) ?? path.join(REPO_ROOT, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const refPath = head.slice('ref: '.length).trim();
    const commonDir = path.join(gitDir, 'commondir');
    const resolvedCommon = fs.existsSync(commonDir)
      ? path.resolve(gitDir, fs.readFileSync(commonDir, 'utf8').trim())
      : gitDir;
    const looseRef = path.join(resolvedCommon, refPath);
    if (fs.existsSync(looseRef)) return fs.readFileSync(looseRef, 'utf8').trim();
    return refPath;
  } catch {
    return 'unknown';
  }
}

function readPlaywrightVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'node_modules', 'playwright-core', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function writeConfigDocument(configPath: string, port: number, cases: HarnessCase[], sessionIds: string[], projectDirs: string[], lanOrigin: string | null): void {
  const projects = cases.map((harnessCase, index) => ({
    id: sessionIds[index],
    name: `${harnessCase.viewport.name}-${harnessCase.scenario.name}`,
    path: projectDirs[index],
    agent: harnessCase.scenario.agent ?? 'claude-code',
    dangerouslySkipPermissions: harnessCase.scenario.skipsPermissions === true,
  }));
  const doneMeansRepos = Object.fromEntries(cases.flatMap((harnessCase, index) => needsDoneMeansChecks(harnessCase.scenario) ? [[projectDirs[index], {
    checks: [{ id: 'status', command: 'git status --short' }, { id: 'committed', command: `git ls-files --error-unmatch ${DONE_MEANS_UNTRACKED_FILE}` }],
  }]] : []));
  const configDocument = {
    port,
    projects,
    teams: [],
    teamReview: { enabled: cases.some((harnessCase) => needsTeamReview(harnessCase.scenario)) },
    sessionChat: { enabled: cases.some((harnessCase) => needsSessionChat(harnessCase.scenario)) },
    repoRoots: [],
    autoResume: false,
    sessionMemoryReserveMB: 0,
    worktree: { autoRebase: false, syncOnStart: false },
    branchGc: { enabled: false },
    usage: { enabled: false },
    capture: { enabled: false },
    recordSignals: false,
    postTurnChecks: { enabled: false },
    verification: { repos: doneMeansRepos },
    checkForUpdates: false,
    telemetry: { enabled: false },
    ...(lanOrigin ? { remote: { allowedOrigins: [lanOrigin] } } : {}),
  };
  fs.writeFileSync(configPath, `${JSON.stringify(configDocument, null, 2)}\n`, 'utf8');
}

function writeAgentShim(shimDirectory: string): string {
  fs.mkdirSync(shimDirectory, { recursive: true });
  const shimPath = path.join(shimDirectory, 'claude');
  const body = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT_PATH)} "$@"\n`;
  fs.writeFileSync(shimPath, body, 'utf8');
  fs.chmodSync(shimPath, 0o755);
  const ghShimPath = path.join(shimDirectory, 'gh');
  const ghBody = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_GH_PATH)} ${JSON.stringify(fakePrStatePathIn(shimDirectory))} "$@"\n`;
  fs.writeFileSync(ghShimPath, ghBody, 'utf8');
  fs.chmodSync(ghShimPath, 0o755);
  const npxShimPath = path.join(shimDirectory, 'npx');
  const npxBody = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_ACP_AGENT_PATH)} "$@"\n`;
  fs.writeFileSync(npxShimPath, npxBody, 'utf8');
  fs.chmodSync(npxShimPath, 0o755);
  return shimPath;
}

interface FakeAgentScan extends SurvivorCheck {
  leftoverPids: number[];
  unavailableReason: string | null;
}

function scanProcForFakeAgents(procRoot: string, glimmervoidHome?: string): FakeAgentScan {
  const leftoverPids: number[] = [];
  const expectedHomeEnv = glimmervoidHome ? `GLIMMERVOID_HOME=${glimmervoidHome}` : null;
  for (const entry of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const commandLine = fs.readFileSync(path.join(procRoot, entry, 'cmdline'), 'utf8');
      if (!commandLine.includes(FAKE_AGENT_PATH) && !commandLine.includes(FAKE_ACP_AGENT_PATH)) continue;
      if (expectedHomeEnv !== null) {
        const environEntries = fs.readFileSync(path.join(procRoot, entry, 'environ'), 'utf8').split('\0');
        if (!environEntries.includes(expectedHomeEnv)) continue;
      }
      leftoverPids.push(Number(entry));
    } catch {}
  }
  return { available: true, leftoverPids, unavailableReason: null };
}

function scanProcessListingForFakeAgents(): FakeAgentScan {
  try {
    const listing = execFileSync('ps', ['-Ao', 'pid,args'], {
      encoding: 'utf8',
      maxBuffer: PROCESS_LISTING_MAX_BYTES,
    });
    const leftoverPids: number[] = [];
    for (const line of listing.split('\n')) {
      if (!line.includes(FAKE_AGENT_PATH) && !line.includes(FAKE_ACP_AGENT_PATH)) continue;
      const pid = /^\s*(\d+)\s/.exec(line)?.[1];
      if (pid === undefined) continue;
      leftoverPids.push(Number(pid));
    }
    return { available: true, leftoverPids, unavailableReason: null };
  } catch (error) {
    return { available: false, leftoverPids: [], unavailableReason: `ps -Ao pid,args failed: ${safeTextTail(error, 300)}` };
  }
}

function scanForFakeAgents(glimmervoidHome?: string): FakeAgentScan {
  if (fs.existsSync('/proc')) return scanProcForFakeAgents('/proc', glimmervoidHome);
  if (process.platform === 'darwin') return scanProcessListingForFakeAgents();
  return {
    available: false,
    leftoverPids: [],
    unavailableReason: `no process listing is available on ${process.platform}`,
  };
}

async function waitForFakeAgentsToExit(glimmervoidHome?: string): Promise<FakeAgentScan> {
  let scan = scanForFakeAgents(glimmervoidHome);
  for (let attempt = 0; attempt < LEFTOVER_SCAN_ATTEMPTS && scan.available && scan.leftoverPids.length > 0; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, LEFTOVER_SCAN_INTERVAL_MS); });
    scan = scanForFakeAgents(glimmervoidHome);
  }
  return scan;
}

function agentCredentialEnvNames(): string[] {
  return listAgentIds().flatMap((agentId) => getAdapter(agentId)?.credentialEnvNames ?? []);
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function isHostLanAddress(address: string): boolean {
  return Object.values(os.networkInterfaces()).some((interfaces) => (interfaces ?? [])
    .some((networkInterface) => !networkInterface.internal && networkInterface.family === 'IPv4' && networkInterface.address === address));
}

function lanRefusal(options: HarnessOptions): string | null {
  if (options.lanAddress === null) return null;
  if (process.env.GLIMMERVOID_INSECURE_BIND !== '1') return '--lan serves an unauthenticated dashboard to the network; set GLIMMERVOID_INSECURE_BIND=1 to confirm';
  if (options.lanAllowedPeers.length === 0) return '--lan needs at least one --lan-allow <device address>';
  if (!isHostLanAddress(options.lanAddress)) return `--lan takes an IPv4 address of this machine, not ${options.lanAddress}`;
  return null;
}

function lanConnectionGuard(allowedPeers: string[]): Plugin {
  const allowed = new Set(allowedPeers);
  return {
    name: 'harness-lan-connection-guard',
    configureServer(server) {
      if (!(server.httpServer instanceof http.Server)) throw new Error('--lan needs Vite\'s plain HTTP server to guard its connections');
      server.httpServer.prependListener('connection', (socket) => {
        const peer = withoutIpv4MappedPrefix(socket.remoteAddress ?? '');
        if (allowed.has(peer)) return;
        console.error(`refused a connection from ${peer || 'an unknown peer'}`);
        socket.destroy();
      });
    },
  };
}

function printDeviceSteps(baseUrl: string, cases: HarnessCase[], deviceLogPath: string): void {
  console.log(`dashboard for the device pass: ${baseUrl}`);
  console.log(`device events append to ${deviceLogPath}`);
  console.log(`sessions: ${cases.map((harnessCase) => `${harnessCase.scenario.name} (${harnessCase.scenario.agent ?? 'claude-code'})`).join(', ')}`);
  console.log('the fake agent answers stop, work, fullscreen and leave-fullscreen typed as a message');
  for (const [index, step] of LAN_DEVICE_STEPS.entries()) console.log(`${index + 1}. ${step}`);
  console.log('report each step as passed or failed with the device and browser version; Ctrl+C ends the run');
}

async function main(): Promise<number> {
  if (process.platform === 'win32') {
    console.error('the browser harness runs on Linux and macOS only: the agent shim it spawns is a POSIX sh script');
    return EXIT_HARNESS_ERROR;
  }
  const lifecycleEvent = process.env.npm_lifecycle_event ?? '';
  if (REFUSED_LIFECYCLE_EVENTS.has(lifecycleEvent)) {
    console.error(`the browser harness refuses to run inside the ${lifecycleEvent} lifecycle script`);
    return EXIT_HARNESS_ERROR;
  }

  const options = parseArguments(process.argv.slice(2));
  if (options.unknownArguments.length > 0) {
    console.error(`unrecognised harness argument: ${options.unknownArguments.join(' ')}`);
    return EXIT_HARNESS_ERROR;
  }
  if (options.flagsMissingValues.length > 0) {
    console.error(`harness flag needs a value: ${options.flagsMissingValues.join(' ')}`);
    return EXIT_HARNESS_ERROR;
  }
  if (options.flagsWithInvalidValues.length > 0) {
    console.error(`harness flag value must be a positive number: ${options.flagsWithInvalidValues.join(', ')}`);
    return EXIT_HARNESS_ERROR;
  }
  const refusedLan = lanRefusal(options);
  if (refusedLan) {
    console.error(refusedLan);
    return EXIT_HARNESS_ERROR;
  }
  const isLanRun = options.lanAddress !== null;
  const browserEngine = browserEngineNamed(options.browserName);
  if (!browserEngine) {
    console.error(`--browser takes ${BROWSER_ENGINES.join(', ')}, not ${options.browserName}`);
    return EXIT_HARNESS_ERROR;
  }
  const selection = selectCases({
    only: options.only.length > 0 ? options.only : undefined,
    viewportNames: options.viewportNames.length > 0 ? options.viewportNames : isLanRun ? [LAN_DEFAULT_VIEWPORT] : undefined,
    proveFailure: options.proveFailure,
  });
  if (selection.unmatchedOnly.length > 0) {
    console.error(`--only matched no case: ${selection.unmatchedOnly.join(', ')}`);
    return EXIT_HARNESS_ERROR;
  }
  const isLanDefaultSelection = isLanRun && options.only.length === 0;
  const cases = isLanDefaultSelection
    ? selection.cases.filter((harnessCase) => harnessCase.scenario.name.startsWith(LAN_DEFAULT_SCENARIO_PREFIX))
    : selection.cases;
  if (cases.length === 0) {
    console.error('no case matched the requested scenarios and viewports');
    return EXIT_HARNESS_ERROR;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDirectory = path.join(options.artifactsDir, runId);
  const deviceLogPath = path.join(runDirectory, 'device-log.jsonl');
  const artifacts = {
    shotsDir: path.join(runDirectory, 'shots'),
    diffsDir: path.join(runDirectory, 'diffs'),
    logsDir: path.join(runDirectory, 'logs'),
  };
  for (const directory of [runDirectory, artifacts.shotsDir, artifacts.diffsDir, artifacts.logsDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-browser-'));
  const glimmervoidHome = path.join(tempDirectory, 'home');
  const previousEnvironment = {
    GLIMMERVOID_HOME: process.env.GLIMMERVOID_HOME,
    GLIMMERVOID_CONFIG: process.env.GLIMMERVOID_CONFIG,
    GLIMMERVOID_PORT: process.env.GLIMMERVOID_PORT,
    PATH: process.env.PATH,
    [FAKE_PR_STATE_ENV]: process.env[FAKE_PR_STATE_ENV],
    ...Object.fromEntries(agentCredentialEnvNames().map((name) => [name, process.env[name]])),
  };
  for (const name of agentCredentialEnvNames()) delete process.env[name];
  const restoreTranscriptHomes = isolateTranscriptHomes(tempDirectory);

  let browser: Browser | null = null;
  let vite: { close: () => Promise<void> } | null = null;
  let cleanUpRun: Promise<void> | null = null;
  let fakeAgentScan: FakeAgentScan = {
    available: false,
    leftoverPids: [],
    unavailableReason: 'the harness never reached its cleanup',
  };

  const cleanUp = (): Promise<void> => {
    if (cleanUpRun) return cleanUpRun;
    cleanUpRun = (async () => {
      try {
        if (browser) await browser.close();
      } catch (error) {
        console.error(`browser cleanup failed: ${safeTextTail(error, 400)}`);
      }
      try {
        if (vite) await vite.close();
      } catch (error) {
        console.error(`vite cleanup failed: ${safeTextTail(error, 400)}`);
      }
      fakeAgentScan = await waitForFakeAgentsToExit(glimmervoidHome);
      setDefaultHeadroomReader(null);
      removeHarnessTempDirectory(tempDirectory);
      restoreTranscriptHomes();
      for (const [name, value] of Object.entries(previousEnvironment)) {
        restoreEnvironmentVariable(name, value);
      }
    })();
    return cleanUpRun;
  };

  const onSignal = (signalName: string) => {
    void (async () => {
      console.error(`received ${signalName}, tearing the harness down`);
      await cleanUp();
      process.exit(130);
    })();
  };
  const onSigint = () => { onSignal('SIGINT'); };
  const onSigterm = () => { onSignal('SIGTERM'); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const startedAt = Date.now();
  const records: CaseRecord[] = [];
  let browserVersion = 'unknown';

  try {
    const projectDirs = cases.map((_, index) => path.join(tempDirectory, 'projects', `case-${index}`));
    for (const projectDirectory of projectDirs) fs.mkdirSync(projectDirectory, { recursive: true });
    for (const [index, harnessCase] of cases.entries()) {
      if (!needsGitOrigin(harnessCase.scenario)) continue;
      const seedDirectory = harnessCase.scenario.projectSeed === undefined ? undefined : path.join(REPO_ROOT, 'harness', 'site-capture', 'fixtures', 'demo', harnessCase.scenario.projectSeed);
      await createProject(tempDirectory, `case-${index}`, seedDirectory);
    }
    const sessionIds = cases.map(() => crypto.randomUUID());
    const port = await findFreeHighPort();
    const configPath = path.join(tempDirectory, 'config.json');
    const servedHost = options.lanAddress ?? '127.0.0.1';
    const baseUrl = `http://${servedHost}:${port}/`;
    writeConfigDocument(configPath, port, cases, sessionIds, projectDirs, isLanRun ? baseUrl.slice(0, -1) : null);

    fs.mkdirSync(glimmervoidHome, { recursive: true });
    process.env.GLIMMERVOID_HOME = glimmervoidHome;
    process.env.GLIMMERVOID_CONFIG = configPath;
    process.env.GLIMMERVOID_PORT = String(port);
    const shimDirectory = path.join(tempDirectory, 'shim');
    writeAgentShim(shimDirectory);
    process.env[FAKE_PR_STATE_ENV] = fakePrStatePathIn(shimDirectory);
    process.env.PATH = `${shimDirectory}${path.delimiter}${previousEnvironment.PATH ?? ''}`;

    setDefaultHeadroomReader(async () => ({ ok: true, headroomBytes: HARNESS_FIXED_HEADROOM_BYTES }));
    const { createServer } = await import('vite');
    const devServer = await createServer({
      configFile: path.join(REPO_ROOT, 'vite.config.ts'),
      server: { port, strictPort: true, host: servedHost },
      plugins: options.lanAddress === null ? [] : [lanConnectionGuard([...options.lanAllowedPeers, options.lanAddress]), deviceLogPlugin(deviceLogPath)],
      logLevel: 'warn',
      clearScreen: false,
    });
    await devServer.listen();
    vite = devServer;
    if (isLanRun) {
      printDeviceSteps(baseUrl, cases, deviceLogPath);
      await new Promise<never>(() => {});
    }

    const browserType = await browserTypeOf(browserEngine);
    browser = await browserType.launch({
      headless: !options.headed,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    });
    browserVersion = browser.version();

    for (const [index, harnessCase] of cases.entries()) {
      const sessionId = sessionIds[index] ?? '';
      const deadlines = index === 0
        ? { ...DEFAULT_DEADLINES, pageReadyMs: COLD_START_PAGE_READY_MS }
        : DEFAULT_DEADLINES;
      const record = await runCase({ browser, harnessCase, sessionId, projectDirectory: projectDirs[index] ?? '', baseUrl, artifacts, deadlines, typingSearch: { seed: options.typingSearchSeed, budgetSeconds: options.typingSearchBudgetSeconds, deviceLogPath: options.typingSearchDeviceLogPath } });
      records.push(record);
      console.log(`${record.outcome.padEnd(7)} ${record.viewport} / ${record.scenario} (${record.durationMs}ms)`);
    }
  } catch (error) {
    console.error(`harness crashed: ${errorText(error)}`);
    await cleanUp();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    return EXIT_HARNESS_ERROR;
  }

  const report: BrowserRunReport = {
    version: 1,
    runId,
    startedAt,
    finishedAt: Date.now(),
    repoHead: readRepoHead(),
    node: process.version,
    playwrightCore: readPlaywrightVersion(),
    browserEngine,
    browserVersion,
    totals: summarize(records),
    cases: records,
  };
  const reportJsonPath = path.join(runDirectory, 'report.json');
  const reportMarkdownPath = path.join(runDirectory, 'report.md');
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(reportMarkdownPath, renderMarkdown(report), 'utf8');

  await cleanUp();
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);

  console.log(`wall time ${((report.finishedAt - report.startedAt) / 1000).toFixed(1)}s over ${records.length} cases`);

  const selfCheck = renderProveFailureCheck(report);
  if (options.proveFailure) {
    console.log(`${PROVE_FAILURE_SCENARIO}: ${selfCheck.ok ? 'ok' : 'NOT ok'} ${selfCheck.detail}`);
  }
  if (!fakeAgentScan.available) {
    console.error(`the surviving fake agent check could not run: ${fakeAgentScan.unavailableReason ?? 'no reason recorded'}`);
  }
  if (fakeAgentScan.leftoverPids.length > 0) {
    console.error(`fake agents survived the run: ${fakeAgentScan.leftoverPids.join(', ')}`);
  }
  console.log(`report: ${reportMarkdownPath}`);
  return decideExitCode({
    report,
    proveFailure: options.proveFailure,
    selfCheck,
    survivors: fakeAgentScan,
  });
}

process.exitCode = await main();
