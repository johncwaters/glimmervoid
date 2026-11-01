import '../support/disable-telemetry.ts';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright-core';
import type { ViteDevServer } from 'vite';
import type WebSocket from 'ws';
import { z } from 'zod';
import { SessionCardFields } from '../../shared/contracts/control-messages.ts';
import { Op } from '../../shared/contracts/whiteboard.ts';
import { applyOps, createBoard } from '../../shared/whiteboard-ops-core.ts';
import { writeJsonAtomic } from '../../server/json-file.ts';
import { CARD_REGISTRY_URL, readGrid } from '../browser/probe.ts';
import type { GridReading } from '../browser/probe.ts';
import { connectControl, removeHarnessTempDirectory } from '../support/backend-harness.ts';

export const repoRoot = path.resolve(import.meta.dirname, '../..');
export const runCommand = promisify(execFile);
export const cancellation = new AbortController();

const SEED_SUFFIX = '.seed';

export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function git(repositoryPath: string, args: string[]): Promise<string> {
  const { stdout } = await runCommand('git', ['-C', repositoryPath, '-c', 'core.hooksPath=/dev/null', ...args], {
    timeout: 30_000, signal: cancellation.signal, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return stdout;
}

async function copySeed(seedDirectory: string, projectPath: string): Promise<void> {
  for (const entry of await fs.readdir(seedDirectory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const sourcePath = path.join(entry.parentPath, entry.name);
    const relativePath = path.relative(seedDirectory, sourcePath);
    const targetRelativePath = relativePath.endsWith(SEED_SUFFIX) ? relativePath.slice(0, -SEED_SUFFIX.length) : relativePath;
    const targetPath = path.join(projectPath, targetRelativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

export async function createProject(tempDirectory: string, directoryName: string, seedDirectory?: string): Promise<string> {
  const projectPath = path.join(tempDirectory, 'projects', directoryName);
  const originPath = path.join(tempDirectory, 'origins', `${directoryName}.git`);
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(originPath, { recursive: true });
  await git(originPath, ['init', '--bare', '--initial-branch=main']);
  await git(projectPath, ['init', '--initial-branch=main']);
  await git(projectPath, ['config', 'user.name', 'Site Capture']);
  await git(projectPath, ['config', 'user.email', 'capture@example.invalid']);
  await git(projectPath, ['config', 'commit.gpgsign', 'false']);
  await git(projectPath, ['config', 'core.hooksPath', '/dev/null']);
  await git(projectPath, ['commit', '--allow-empty', '-m', 'Capture baseline']);
  if (seedDirectory) {
    await copySeed(seedDirectory, projectPath);
    await git(projectPath, ['add', '-A']);
    await git(projectPath, ['commit', '-m', 'chore: initial project']);
  }
  await git(projectPath, ['remote', 'add', 'origin', originPath]);
  await git(projectPath, ['push', '--set-upstream', 'origin', 'main']);
  return projectPath;
}

const ControlFrame = z.object({ type: z.string(), session: z.string().optional(), message: z.string().nullish(), error: z.string().nullish() }).passthrough();

export async function addSession(socket: WebSocket, name: string, projectPath: string, dangerouslySkipPermissions = false): Promise<string> {
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
        const frame = ControlFrame.parse(JSON.parse(raw.toString()));
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
    socket.send(JSON.stringify({ type: 'add-session', name, path: projectPath, agent: 'claude-code', dangerouslySkipPermissions }));
  });
  return card.id;
}

export async function readSessionGrid(page: Page, sessionId: string): Promise<GridReading | null> {
  return page.evaluate(readGrid, { sessionId, registryUrl: CARD_REGISTRY_URL });
}

export async function selectSession(page: Page, sessionId: string): Promise<void> {
  const phoneRow = page.locator(`.phone-board-list button.session-row[data-id="${sessionId}"]`);
  const selectDesktop = async () => {
    await page.locator('#tab-focus').click();
    await page.locator(`.focus-rail button.session-row[data-id="${sessionId}"]`).click();
  };
  await (await phoneRow.isVisible() ? phoneRow.click() : selectDesktop());
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const grid = await readSessionGrid(page, sessionId);
    if (grid?.dataWsState === 1 && grid.cols === grid.ptySize?.cols && grid.rows === grid.ptySize?.rows) return;
    await sleep(20, undefined, { signal: cancellation.signal });
  }
  throw new Error(`terminal ${sessionId} did not negotiate its PTY size`);
}

export interface IsolatedServer {
  port: number;
  vite: ViteDevServer;
  socket: WebSocket;
  configPath: string;
}

export async function startIsolatedServer(port: number, configPath: string): Promise<IsolatedServer> {
  const signalListeners = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, new Set(process.listeners(signal))]));
  const stdinEndListeners = new Set(process.stdin.listeners('end'));
  const { createServer } = await import('vite');
  const vite = await createServer({ configFile: path.join(repoRoot, 'vite.config.ts'), server: { port, strictPort: true, host: '127.0.0.1', watch: null }, logLevel: 'warn', clearScreen: false });
  for (const [signal, previousListeners] of signalListeners) {
    for (const listener of process.listeners(signal)) if (!previousListeners.has(listener)) process.off(signal, listener);
  }
  for (const listener of process.stdin.listeners('end')) if (!stdinEndListeners.has(listener)) process.stdin.off('end', listener);
  await vite.listen();
  const socket = await connectControl(port);
  return { port, vite, socket, configPath };
}

export function snapshotEnvironment(): () => void {
  const savedEnvironment = { ...process.env };
  return () => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
    Object.assign(process.env, savedEnvironment);
  };
}

export async function listProcessesMentioning(needles: readonly string[]): Promise<string[]> {
  const { stdout } = await runCommand('ps', ['-Ao', 'pid,args'], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').filter((line) => needles.some((needle) => line.includes(needle)) && !line.includes(' ps -Ao '));
}

export interface IsolatedDashboardOptions {
  label: string;
  tempDirectoryPrefix: string;
  executablePath?: string;
  isolateEnvironment(tempDirectory: string): Promise<void>;
  waitForAgentExit(tempDirectory: string): Promise<void>;
}

export interface IsolatedDashboard {
  tempDirectory: string;
  startServer(port: number, configPath: string): Promise<IsolatedServer>;
  openDashboard(port: number, browserContextOptions: BrowserContextOptions): Promise<Page>;
  closeBrowserContext(): Promise<void>;
}

const serverLifecycleEvents = ['build', 'start', 'prepare', 'postinstall'];

export function refuseUnsupportedLaunch(label: string): void {
  if (process.platform === 'win32') throw new Error(`${label} requires macOS or Linux`);
  if (serverLifecycleEvents.includes(process.env.npm_lifecycle_event ?? '')) throw new Error(`${label} refuses build or server lifecycle scripts`);
}

export async function runIsolatedDashboard(options: IsolatedDashboardOptions, runWithDashboard: (dashboard: IsolatedDashboard) => Promise<void>): Promise<void> {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), options.tempDirectoryPrefix));
  const restoreEnvironment = snapshotEnvironment();
  let browser: Browser | undefined;
  let browserContext: BrowserContext | undefined;
  let vite: ViteDevServer | undefined;
  let socket: WebSocket | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const closeBrowserContext = async (): Promise<void> => {
    if (!browserContext) return;
    await browserContext.close();
    browserContext = undefined;
  };
  const cleanUp = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const failures: unknown[] = [];
      for (const close of [closeBrowserContext, async () => { if (browser) await browser.close(); },
        async () => { socket?.terminate(); if (vite) await vite.close(); }, async () => options.waitForAgentExit(tempDirectory)]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      removeHarnessTempDirectory(tempDirectory);
      restoreEnvironment();
      if (failures.length > 0) throw new AggregateError(failures, `${options.label} cleanup failed`);
    })();
    return cleanupPromise;
  };
  const dashboard: IsolatedDashboard = {
    tempDirectory,
    startServer: async (port, configPath) => {
      const server = await startIsolatedServer(port, configPath);
      vite = server.vite;
      socket = server.socket;
      return server;
    },
    openDashboard: async (port, browserContextOptions) => {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true, executablePath: options.executablePath, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      browserContext = await browser.newContext(browserContextOptions);
      const page = await browserContext.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { timeout: 60_000 });
      await page.locator('body.app-ready').waitFor({ timeout: 60_000 });
      return page;
    },
    closeBrowserContext,
  };
  const onSignal = () => cancellation.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await options.isolateEnvironment(tempDirectory);
    await runWithDashboard(dashboard);
  } finally {
    await cleanUp();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

const WhiteboardSeed = z.strictObject({ id: z.string().min(1), title: z.string().min(1), ops: z.array(Op).min(1) });

export async function seedWhiteboard(configPath: string, seedPath: string): Promise<void> {
  const seed = WhiteboardSeed.parse(JSON.parse(await fs.readFile(seedPath, 'utf8')));
  const seededAtMs = Date.now();
  const applied = applyOps(createBoard({ id: seed.id, title: seed.title, nowMs: seededAtMs }), seed.ops, { id: 'site-capture', name: 'site-capture' }, seededAtMs);
  if (!applied.ok) throw new Error(`board seed ${seedPath} op ${applied.opIndex + 1}: ${applied.error}`);
  const boardsDirectory = path.join(path.dirname(configPath), 'whiteboards');
  await fs.mkdir(boardsDirectory, { recursive: true });
  await writeJsonAtomic(path.join(boardsDirectory, `${seed.id}.json`), { board: applied.board, log: [], cursorBySessionId: {}, createdBy: null });
}

export { prepareIsolatedEnvironment } from '../support/backend-harness.ts';
export type { IsolatedConfigOptions } from '../support/backend-harness.ts';
