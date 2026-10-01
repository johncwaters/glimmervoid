import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type WebSocket from 'ws';
import type { ViteDevServer } from 'vite';
import { z } from 'zod';
import { writeJsonAtomic } from '../../server/json-file.ts';
import { SessionCardFields } from '../../shared/contracts/control-messages.ts';
import { isolateTranscriptHomes } from '../../tests/helpers/transcript-homes.ts';
import { CARD_REGISTRY_URL, readGrid } from '../browser/probe.ts';
import { connectControl, findFreeHighPort, removeHarnessTempDirectory, safeTextTail } from '../support/backend-harness.ts';
import { ReplayStatus, parseCaptureRecording, redactRecording, validateManifest } from './manifest-core.ts';
import type { ReplayEnvironment } from './manifest-core.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const replayAgentPath = path.join(import.meta.dirname, 'replay-agent.ts');
const runCommand = promisify(execFile);
const cancellation = new AbortController();

function parseArguments(argv: string[]): { manifestPath: string; outputDirectory: string; executablePath?: string } {
  const manifestPath = argv[0];
  if (!manifestPath || manifestPath.startsWith('--')) throw new Error('usage: site:capture <manifest.json> [--out <directory>] [--executable <Chrome path>]');
  let outputDirectory = path.join(import.meta.dirname, 'out');
  let executablePath = process.env.CHROME_PATH;
  if (!executablePath && process.platform === 'darwin') executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag === '--out') { outputDirectory = path.resolve(value); continue; }
    if (flag === '--executable') { executablePath = path.resolve(value); continue; }
    throw new Error(`unknown argument ${flag}`);
  }
  return { manifestPath: path.resolve(manifestPath), outputDirectory, executablePath };
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const { stdout } = await runCommand('git', ['-C', repositoryPath, '-c', 'core.hooksPath=/dev/null', ...args], {
    timeout: 30_000, signal: cancellation.signal,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return stdout;
}

async function createProject(tempDirectory: string, index: number): Promise<string> {
  const projectPath = path.join(tempDirectory, 'projects', `project-${index}`);
  const originPath = path.join(tempDirectory, 'origins', `project-${index}.git`);
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(originPath, { recursive: true });
  await git(originPath, ['init', '--bare', '--initial-branch=main']);
  await git(projectPath, ['init', '--initial-branch=main']);
  await git(projectPath, ['config', 'user.name', 'Site Capture']);
  await git(projectPath, ['config', 'user.email', 'capture@example.invalid']);
  await git(projectPath, ['commit', '--allow-empty', '-m', 'Capture baseline']);
  await git(projectPath, ['remote', 'add', 'origin', originPath]);
  await git(projectPath, ['push', '--set-upstream', 'origin', 'main']);
  return projectPath;
}

async function addSession(socket: WebSocket, name: string, projectPath: string): Promise<string> {
  const card = await new Promise<SessionCardFields>((resolve, reject) => {
    const finish = (error?: Error, session?: SessionCardFields) => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) { reject(error); return; }
      if (session) resolve(session);
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error('control socket closed while adding session'));
    const onMessage = (raw: Buffer) => {
      try {
        const frame = z.object({ type: z.string(), session: z.string().optional(), message: z.string().optional(), error: z.string().optional() }).passthrough().parse(JSON.parse(raw.toString()));
        if (frame.type === 'error') { finish(new Error(frame.message ?? frame.error ?? 'add-session failed')); return; }
        if (frame.type !== 'session-added' || frame.session !== name) return;
        finish(undefined, SessionCardFields.parse(frame));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const timeout = setTimeout(() => finish(new Error(`session ${name} was not created within 30s`)), 30_000);
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.send(JSON.stringify({ type: 'add-session', name, path: projectPath, agent: 'claude-code', dangerouslySkipPermissions: false }));
  });
  return card.id;
}

async function selectSession(page: Page, sessionId: string): Promise<void> {
  const phoneRow = page.locator(`button.phone-row[data-id="${sessionId}"]`);
  const selectDesktop = async () => {
    await page.locator('#tab-focus').click();
    await page.locator(`button.focus-pill[data-id="${sessionId}"]`).click();
  };
  await (await phoneRow.isVisible() ? phoneRow.click() : selectDesktop());
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const grid = await page.evaluate(readGrid, { sessionId, registryUrl: CARD_REGISTRY_URL });
    if (grid?.dataWsState === 1 && grid.cols === grid.ptySize?.cols && grid.rows === grid.ptySize?.rows) return;
    await sleep(20, undefined, { signal: cancellation.signal });
  }
  throw new Error(`terminal ${sessionId} did not negotiate its PTY size`);
}

async function refreshReview(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async ({ moduleUrl, id }) => {
    const imported: unknown = await import(moduleUrl);
    const controlModule = imported as { sendControlMsg(message: { type: string; id: string }): void };
    for (const type of ['request-session-diff', 'request-change-map', 'request-branch-sync']) controlModule.sendControlMsg({ type, id });
  }, { moduleUrl: '/control-ws.ts', id: sessionId });
}

async function readStatuses(environment: ReplayEnvironment): Promise<(z.infer<typeof ReplayStatus> | null)[]> {
  return Promise.all(Object.keys(environment.sessionsById).map(async (sessionId) => {
    const statusText = await fs.readFile(path.join(environment.tempDirectory, `${sessionId}.status.json`), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (statusText === null) return null;
    const status = ReplayStatus.parse(JSON.parse(statusText));
    if (status.phase === 'failed') throw new Error(`replay ${sessionId} failed: ${status.error}`);
    process.kill(status.pid, 0);
    return status;
  }));
}

async function waitUntil(atMs: number, environment: ReplayEnvironment): Promise<void> {
  while (Date.now() < atMs) {
    await readStatuses(environment);
    await sleep(Math.min(100, atMs - Date.now()), undefined, { signal: cancellation.signal });
  }
  await readStatuses(environment);
}

async function waitForReplayExit(tempDirectory: string): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const { stdout } = await runCommand('ps', ['-Ao', 'pid,args'], { maxBuffer: 8 * 1024 * 1024 });
    const survivors = stdout.split('\n').filter((line) => line.includes(replayAgentPath) && line.includes(tempDirectory));
    if (survivors.length === 0) { console.log('cleanup: no surviving replay agents'); return; }
    await sleep(200);
  }
  throw new Error('replay agents survived capture cleanup');
}

async function main(): Promise<void> {
  if (process.platform === 'win32') throw new Error('site capture requires the POSIX shim on macOS or Linux');
  if (['build', 'start', 'prepare', 'postinstall'].includes(process.env.npm_lifecycle_event ?? '')) throw new Error('site capture refuses build or server lifecycle scripts');
  const options = parseArguments(process.argv.slice(2));
  const manifestDirectory = path.dirname(options.manifestPath);
  const manifest = validateManifest(JSON.parse(await fs.readFile(options.manifestPath, 'utf8')));
  manifest.sessions = await Promise.all(manifest.sessions.map(async (session) => {
    const recording = path.resolve(manifestDirectory, session.recording);
    const records = redactRecording(parseCaptureRecording(await fs.readFile(recording, 'utf8')), manifest.redactions);
    const patch = session.patch ? path.resolve(manifestDirectory, session.patch) : undefined;
    if (patch) {
      await fs.access(patch);
      if (!records.some((record) => record.type === 'hook' && record.event === session.patchAtEvent)) throw new Error(`patch event ${session.patchAtEvent} missing in ${session.name}`);
    }
    return { ...session, recording, patch };
  }));
  await fs.mkdir(options.outputDirectory, { recursive: true });
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-site-capture-'));
  const environment: ReplayEnvironment = { manifest, sessionsById: {}, tempDirectory };
  const savedEnvironment = { ...process.env };
  const restoreTranscriptHomes = isolateTranscriptHomes(tempDirectory);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let vite: ViteDevServer | undefined;
  let socket: WebSocket | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanUp = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const failures: unknown[] = [];
      for (const close of [async () => { if (context) await context.close(); }, async () => { if (browser) await browser.close(); },
        async () => { socket?.terminate(); if (vite) await vite.close(); }, async () => waitForReplayExit(tempDirectory)]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      removeHarnessTempDirectory(tempDirectory);
      restoreTranscriptHomes();
      for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
      Object.assign(process.env, savedEnvironment);
      if (failures.length > 0) throw new AggregateError(failures, 'capture cleanup failed');
    })();
    return cleanupPromise;
  };
  const onSignal = () => cancellation.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const projectPaths = new Map<string, string>();
    for (const session of manifest.sessions) {
      if (projectPaths.has(session.project)) continue;
      projectPaths.set(session.project, await createProject(tempDirectory, projectPaths.size));
    }
    const port = await findFreeHighPort();
    const configPath = path.join(tempDirectory, 'config.json');
    await writeJsonAtomic(configPath, {
      port, projects: [], teams: [], repoRoots: [...projectPaths.values()],
      worktreeRoot: path.join(tempDirectory, 'worktrees'), integrationBranch: 'main',
      autoResume: false, worktreeAutoRebase: false, worktreeSyncOnStart: false,
      branchGc: { enabled: false }, usage: { enabled: false }, capture: { enabled: false },
      recordSignals: false, postTurnChecks: { enabled: false }, checkForUpdates: false,
      planReview: { enabled: false }, remote: { enabled: false },
      posthog: { enabled: false }, telegram: { enabled: false }, teamReview: { enabled: false },
    });
    const captureHome = path.join(tempDirectory, 'home');
    await fs.mkdir(captureHome);
    const mapPath = path.join(tempDirectory, 'replay-map.json');
    await writeJsonAtomic(mapPath, environment);
    Object.assign(process.env, {
      GLIMMERVOID_HOME: captureHome, GLIMMERVOID_CONFIG: configPath, GLIMMERVOID_PORT: String(port),
      GLIMMERVOID_SITE_CAPTURE_MAP: mapPath, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    });
    const shimDirectory = path.join(tempDirectory, 'shim');
    await fs.mkdir(shimDirectory);
    const quoteShell = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    await fs.writeFile(path.join(shimDirectory, 'claude'), `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(replayAgentPath)} --site-capture-owner ${quoteShell(tempDirectory)} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${shimDirectory}${path.delimiter}${savedEnvironment.PATH ?? ''}`;
    const signalListeners = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, new Set(process.listeners(signal))]));
    const stdinEndListeners = new Set(process.stdin.listeners('end'));
    const { createServer } = await import('vite');
    vite = await createServer({ configFile: path.join(repoRoot, 'vite.config.ts'), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'warn', clearScreen: false });
    for (const [signal, previousListeners] of signalListeners) {
      for (const listener of process.listeners(signal)) if (!previousListeners.has(listener)) process.off(signal, listener);
    }
    for (const listener of process.stdin.listeners('end')) if (!stdinEndListeners.has(listener)) process.stdin.off('end', listener);
    await vite.listen();
    socket = await connectControl(port);
    const sessionIds = new Map<string, string>();
    for (const session of manifest.sessions) {
      const projectPath = projectPaths.get(session.project);
      if (!projectPath) throw new Error(`missing project ${session.project}`);
      const sessionId = await addSession(socket, session.name, projectPath);
      sessionIds.set(session.name, sessionId);
      environment.sessionsById[sessionId] = session;
      await writeJsonAtomic(mapPath, environment);
      console.log(`session: ${session.name} (${session.project})`);
    }
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ headless: true, executablePath: options.executablePath, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    context = await browser.newContext({ viewport: manifest.viewport, recordVideo: { dir: path.join(tempDirectory, 'video'), size: manifest.viewport } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { timeout: 60_000 });
    await page.locator('body.app-ready').waitFor({ timeout: 60_000 });
    for (const sessionId of sessionIds.values()) await selectSession(page, sessionId);
    const firstId = sessionIds.values().next().value;
    if (firstId) await selectSession(page, firstId);
    const readyDeadline = Date.now() + 30_000;
    while ((await readStatuses(environment)).some((status) => status === null)) {
      if (Date.now() >= readyDeadline) throw new Error('replay agents did not become ready within 30s');
      await sleep(50, undefined, { signal: cancellation.signal });
    }
    const startAt = Date.now() + 250;
    await writeJsonAtomic(path.join(tempDirectory, 'start.json'), { startAt });
    for (const shot of [...manifest.shots].sort((first, second) => first.atMs - second.atMs)) {
      await waitUntil(startAt + shot.atMs, environment);
      if (shot.selectSession) {
        const sessionId = sessionIds.get(shot.selectSession);
        if (!sessionId) throw new Error(`unknown session ${shot.selectSession}`);
        await selectSession(page, sessionId);
        await refreshReview(page, sessionId);
        const session = environment.sessionsById[sessionId];
        const status = ReplayStatus.parse(JSON.parse(await fs.readFile(path.join(tempDirectory, `${sessionId}.status.json`), 'utf8')));
        if (session?.patch && status.patchApplied) {
          const diffButton = page.locator('.review-view-option', { hasText: 'Diff' });
          if (await diffButton.isVisible()) {
            await diffButton.click();
            await page.locator('.review-sidebar-body .review-file').first().waitFor({ timeout: 10_000 });
            console.log(`review: real committed diff visible for ${shot.selectSession}`);
          }
        }
      }
      const shotPath = path.join(options.outputDirectory, `${shot.name}.png`);
      await page.screenshot({ path: shotPath });
      console.log(`shot: ${shotPath} (${(await fs.stat(shotPath)).size} bytes)`);
    }
    await waitUntil(startAt + manifest.videoMs, environment);
    const finalStatuses = await readStatuses(environment);
    for (const status of finalStatuses) if (status?.warning) console.warn(status.warning);
    console.log(`replay: ${finalStatuses.filter((status) => status?.phase === 'complete').length} completed, ${finalStatuses.length} agents alive`);
    const video = page.video();
    if (!video) throw new Error('Playwright did not create a video');
    await context.close();
    context = undefined;
    const videoPath = path.join(options.outputDirectory, 'capture.webm');
    await video.saveAs(videoPath);
    console.log(`video: ${videoPath} (${(await fs.stat(videoPath)).size} bytes)`);
  } finally {
    await cleanUp();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

try {
  await main();
} catch (error) {
  console.error(`site capture failed: ${safeTextTail(error, 2000)}`);
  process.exitCode = cancellation.signal.aborted ? 130 : 1;
}
