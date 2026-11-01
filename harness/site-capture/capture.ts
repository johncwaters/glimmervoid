import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Locator, Page } from 'playwright-core';
import type WebSocket from 'ws';
import { z } from 'zod';
import { ServerMessage } from '../../shared/contracts/control-messages.ts';
import { writeJsonAtomic } from '../../server/json-file.ts';
import { resolveFfmpegPath } from '../../server/runtime-paths.ts';
import { isolateTranscriptHomes } from '../../tests/helpers/transcript-homes.ts';
import { safeTextTail } from '../support/backend-harness.ts';
import {
  addSession, cancellation, createProject, listProcessesMentioning, prepareIsolatedEnvironment, quoteShell, refuseUnsupportedLaunch, runCommand, runIsolatedDashboard, selectSession,
} from './isolated-glimmervoid.ts';
import { ReplayStatus, parseCaptureRecording, redactRecording, validateManifest } from './manifest-core.ts';
import type { ReplayEnvironment } from './manifest-core.ts';

const replayAgentPath = path.join(import.meta.dirname, 'replay-agent.ts');
const glimmervoidCliPath = path.resolve(import.meta.dirname, '../../bin/glimmervoid.ts');
const cursorGlideMs = 650;
const replayAgentMemoryReserveMB = 128;
const demoHomeDirectory = '/home/demo';
const webFramesPerSecond = 60;
const posterShotName = 'hero';
const socialCrop = { width: 1000, height: 300 };
const readmeGif = { width: 960, height: 600, framesPerSecond: 4 };

type CaptureSessionEntry = ReplayEnvironment['manifest']['sessions'][number];

interface ScreencastFrame {
  fileName: string;
  capturedAtMs: number;
}

interface Screencast {
  stop(): Promise<ScreencastFrame[]>;
}

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

async function refreshReview(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async ({ moduleUrl, id }) => {
    const imported: unknown = await import(moduleUrl);
    const controlModule = imported as { sendControlMsg(message: { type: string; id: string }): void };
    for (const type of ['request-session-diff', 'request-change-map', 'request-branch-sync']) controlModule.sendControlMsg({ type, id });
  }, { moduleUrl: '/control-ws.ts', id: sessionId });
}

async function showCursor(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.evaluate(({ startX, startY, glideMs }) => {
    const cursor = document.createElement('div');
    cursor.id = 'site-capture-cursor';
    cursor.style.cssText = `position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(${startX}px,${startY}px);transition:transform ${glideMs}ms cubic-bezier(.45,0,.2,1)`;
    cursor.innerHTML = '<span class="site-capture-cursor-ring" style="position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid #b9a8ff;opacity:0;transform:scale(.4)"></span>'
      + '<svg width="22" height="26" viewBox="0 0 22 26" style="display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.55))"><path d="M2 2 L2 21 L7.2 16.4 L10.6 24 L14 22.6 L10.7 15 L18 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.append(cursor);
  }, { startX: Math.round(viewport.width * 0.62), startY: Math.round(viewport.height * 0.58), glideMs: cursorGlideMs });
}

async function glideCursorTo(target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('cursor target has no box');
  await target.page().evaluate(({ x, y }) => {
    const cursor = document.getElementById('site-capture-cursor');
    if (cursor) cursor.style.transform = `translate(${x}px,${y}px)`;
  }, { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
  await sleep(cursorGlideMs, undefined, { signal: cancellation.signal });
  await target.page().evaluate(() => {
    const ring = document.querySelector<HTMLElement>('#site-capture-cursor .site-capture-cursor-ring');
    ring?.animate([{ opacity: 0.9, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(1.6)' }], { duration: 420, easing: 'ease-out' });
  });
  await sleep(120, undefined, { signal: cancellation.signal });
}

function mapSpawnedChildren(socket: WebSocket, children: CaptureSessionEntry[], sessionIds: Map<string, string>, environment: ReplayEnvironment, mapPath: string): void {
  const pendingChildren = [...children];
  socket.on('message', (raw: Buffer) => {
    const parsedFrame = ServerMessage.safeParse(JSON.parse(raw.toString()));
    if (!parsedFrame.success || parsedFrame.data.type !== 'session-added') return;
    const card = parsedFrame.data;
    if (!card.ownerId || environment.sessionsById[card.id]) return;
    const parentName = [...sessionIds].find(([, id]) => id === card.ownerId)?.[0];
    const childIndex = pendingChildren.findIndex((child) => child.spawnedBy === parentName);
    const child = pendingChildren[childIndex];
    if (!child) return;
    pendingChildren.splice(childIndex, 1);
    sessionIds.set(child.name, card.id);
    environment.sessionsById[card.id] = child;
    void writeJsonAtomic(mapPath, environment).then(() => console.log(`session: ${child.name} spawned by ${parentName}`));
  });
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

async function startScreencast(page: Page, framesDirectory: string, viewport: { width: number; height: number }): Promise<Screencast> {
  await fs.mkdir(framesDirectory, { recursive: true });
  const cdpSession = await page.context().newCDPSession(page);
  const frames: ScreencastFrame[] = [];
  let pendingWrites: Promise<void> = Promise.resolve();
  let isStopping = false;
  let screencastError: unknown = null;
  cdpSession.on('Page.screencastFrame', (frame) => {
    if (isStopping) return;
    const fileName = `frame-${String(frames.length).padStart(6, '0')}.png`;
    frames.push({ fileName, capturedAtMs: (frame.metadata.timestamp ?? Date.now() / 1000) * 1000 });
    pendingWrites = pendingWrites
      .then(() => fs.writeFile(path.join(framesDirectory, fileName), Buffer.from(frame.data, 'base64')))
      .then(() => cdpSession.send('Page.screencastFrameAck', { sessionId: frame.sessionId }))
      .then(() => undefined, (error: unknown) => { screencastError ??= error; });
  });
  await cdpSession.send('Page.startScreencast', {
    format: 'png', everyNthFrame: 1, maxWidth: viewport.width, maxHeight: viewport.height,
  });
  return {
    stop: async () => {
      isStopping = true;
      await cdpSession.send('Page.stopScreencast');
      await pendingWrites;
      if (screencastError) throw screencastError;
      await cdpSession.detach();
      return frames;
    },
  };
}

function concatFrameWindow(frames: ScreencastFrame[], startAtMs: number, endAtMs: number): string {
  const firstIndex = Math.max(0, frames.findLastIndex((frame) => frame.capturedAtMs <= startAtMs));
  const windowFrames = frames.slice(firstIndex).filter((frame) => frame.capturedAtMs < endAtMs);
  if (windowFrames.length === 0) throw new Error('the screencast produced no frames inside the replay window');
  const lines = ['ffconcat version 1.0'];
  for (const [index, frame] of windowFrames.entries()) {
    const shownFromMs = Math.max(frame.capturedAtMs, startAtMs);
    const shownUntilMs = windowFrames[index + 1]?.capturedAtMs ?? endAtMs;
    lines.push(`file '${frame.fileName}'`, `duration ${((shownUntilMs - shownFromMs) / 1000).toFixed(6)}`);
  }
  lines.push(`file '${windowFrames.at(-1)?.fileName}'`);
  return `${lines.join('\n')}\n`;
}

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  await runCommand(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024, signal: cancellation.signal });
}

async function encodeWebOutputs(concatPath: string, outputDirectory: string): Promise<void> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) throw new Error('ffmpeg-static is not installed');
  const frameInput = ['-reinit_filter', '0', '-f', 'concat', '-safe', '0', '-i', concatPath];
  const webVideoFilter = `fps=${webFramesPerSecond},format=yuv420p`;
  const encodes: { fileName: string; args: string[]; isVideo?: boolean }[] = [
    { fileName: 'dashboard.webm', isVideo: true, args: [...frameInput, '-vf', webVideoFilter, '-an', '-c:v', 'libaom-av1', '-crf', '22', '-b:v', '0', '-cpu-used', '3', '-row-mt', '0', '-g', '600'] },
    { fileName: 'dashboard.mp4', isVideo: true, args: [...frameInput, '-vf', webVideoFilter, '-an', '-c:v', 'libx264', '-preset', 'veryslow', '-tune', 'animation', '-crf', '17', '-profile:v', 'high', '-level:v', '4.2', '-g', '600', '-movflags', '+faststart'] },
    {
      fileName: 'glimmervoid-demo.gif',
      args: [...frameInput, '-vf', `fps=${readmeGif.framesPerSecond},scale=${readmeGif.width}:${readmeGif.height}:flags=lanczos,split[frames][copy];[copy]palettegen=stats_mode=diff[palette];[frames][palette]paletteuse=diff_mode=rectangle`],
    },
  ];
  const posterShotPath = path.join(outputDirectory, `${posterShotName}.png`);
  const hasPosterShot = await fs.access(posterShotPath).then(() => true, () => false);
  if (hasPosterShot) {
    encodes.push(
      { fileName: `${posterShotName}.webp`, args: ['-i', posterShotPath, '-c:v', 'libwebp', '-quality', '85', '-frames:v', '1'] },
      { fileName: 'dashboard-top.png', args: ['-i', posterShotPath, '-vf', `crop=${socialCrop.width}:${socialCrop.height}:0:0`, '-frames:v', '1'] },
    );
  }
  for (const encode of encodes) {
    const outputPath = path.join(outputDirectory, encode.fileName);
    await runFfmpeg(ffmpegPath, [...encode.args, outputPath]);
    if (encode.isVideo) await runFfmpeg(ffmpegPath, ['-xerror', '-i', outputPath, '-f', 'null', '-']);
    console.log(`encoded: ${outputPath} (${(await fs.stat(outputPath)).size} bytes)`);
  }
}

async function waitForReplayExit(tempDirectory: string): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const survivors = (await listProcessesMentioning([replayAgentPath])).filter((line) => line.includes(tempDirectory));
    if (survivors.length === 0) { console.log('cleanup: no surviving replay agents'); return; }
    await sleep(200);
  }
  throw new Error('replay agents survived capture cleanup');
}

async function main(): Promise<void> {
  refuseUnsupportedLaunch('site capture');
  const options = parseArguments(process.argv.slice(2));
  const manifestDirectory = path.dirname(options.manifestPath);
  const manifest = validateManifest(JSON.parse(await fs.readFile(options.manifestPath, 'utf8')));
  const operatorHomeDirectory = os.homedir();
  manifest.redactions.push({ from: operatorHomeDirectory, to: demoHomeDirectory.length <= operatorHomeDirectory.length ? demoHomeDirectory : '~' });
  manifest.sessions = await Promise.all(manifest.sessions.map(async (session) => {
    const recording = path.resolve(manifestDirectory, session.recording);
    const records = redactRecording(parseCaptureRecording(await fs.readFile(recording, 'utf8')), manifest.redactions);
    const patch = session.patch ? path.resolve(manifestDirectory, session.patch) : undefined;
    if (patch) {
      await fs.access(patch);
      if (!records.some((record) => record.type === 'hook' && record.event === session.patchAtEvent)) throw new Error(`patch event ${session.patchAtEvent} missing in ${session.name}`);
    }
    const glimmervoidCalls = session.glimmervoidCalls ? path.resolve(manifestDirectory, session.glimmervoidCalls) : undefined;
    if (glimmervoidCalls) await fs.access(glimmervoidCalls);
    return { ...session, recording, patch, glimmervoidCalls };
  }));
  if (manifest.shownFiles) manifest.shownFiles = path.resolve(manifestDirectory, manifest.shownFiles);
  manifest.projects = Object.fromEntries(Object.entries(manifest.projects).map(([projectName, seedDirectory]) => [projectName, path.resolve(manifestDirectory, seedDirectory)]));
  await fs.mkdir(options.outputDirectory, { recursive: true });
  await runIsolatedDashboard({
    label: 'site capture',
    tempDirectoryPrefix: 'glimmervoid-site-capture-',
    executablePath: options.executablePath,
    isolateEnvironment: async (tempDirectory) => { isolateTranscriptHomes(tempDirectory); },
    waitForAgentExit: waitForReplayExit,
  }, async ({ tempDirectory, startServer, openDashboard, closeBrowserContext }) => {
    const environment: ReplayEnvironment = { manifest, sessionsById: {}, tempDirectory };
    const savedPath = process.env.PATH ?? '';
    const projectPaths = new Map<string, string>();
    for (const session of manifest.sessions) {
      if (projectPaths.has(session.project)) continue;
      const seedDirectory = manifest.projects[session.project];
      const directoryName = seedDirectory ? session.project : `project-${projectPaths.size}`;
      projectPaths.set(session.project, await createProject(tempDirectory, directoryName, seedDirectory));
    }
    const { port, configPath } = await prepareIsolatedEnvironment({ tempDirectory, repoRoots: [...projectPaths.values()], recordSessions: false });
    const isolatedConfig = z.record(z.string(), z.unknown()).parse(JSON.parse(await fs.readFile(configPath, 'utf8')));
    await writeJsonAtomic(configPath, { ...isolatedConfig, sessionMemoryReserveMB: replayAgentMemoryReserveMB });
    const mapPath = path.join(tempDirectory, 'replay-map.json');
    await writeJsonAtomic(mapPath, environment);
    process.env.GLIMMERVOID_SITE_CAPTURE_MAP = mapPath;
    const shimDirectory = path.join(tempDirectory, 'shim');
    await fs.mkdir(shimDirectory);
    await fs.writeFile(path.join(shimDirectory, 'claude'), `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(replayAgentPath)} --site-capture-owner ${quoteShell(tempDirectory)} "$@"\n`, { mode: 0o755 });
    await fs.writeFile(path.join(shimDirectory, 'glimmervoid'), `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(glimmervoidCliPath)} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${shimDirectory}${path.delimiter}${savedPath}`;
    const { socket } = await startServer(port, configPath);
    const sessionIds = new Map<string, string>();
    mapSpawnedChildren(socket, manifest.sessions.filter((session) => session.spawnedBy), sessionIds, environment, mapPath);
    for (const session of manifest.sessions.filter((candidate) => !candidate.spawnedBy)) {
      const projectPath = projectPaths.get(session.project);
      if (!projectPath) throw new Error(`missing project ${session.project}`);
      const sessionId = await addSession(socket, session.name, projectPath);
      sessionIds.set(session.name, sessionId);
      environment.sessionsById[sessionId] = session;
      await writeJsonAtomic(mapPath, environment);
      console.log(`session: ${session.name} (${session.project})`);
    }
    const page = await openDashboard(port, { viewport: manifest.viewport });
    const addedSessionIds = [...sessionIds.values()];
    for (const sessionId of addedSessionIds) await selectSession(page, sessionId);
    const firstId = sessionIds.values().next().value;
    if (firstId) await selectSession(page, firstId);
    const readyDeadline = Date.now() + 30_000;
    while ((await readStatuses(environment)).some((status) => status === null)) {
      if (Date.now() >= readyDeadline) throw new Error('replay agents did not become ready within 30s');
      await sleep(50, undefined, { signal: cancellation.signal });
    }
    const framesDirectory = path.join(options.outputDirectory, 'frames');
    await fs.rm(framesDirectory, { recursive: true, force: true });
    await showCursor(page, manifest.viewport);
    const screencast = await startScreencast(page, framesDirectory, manifest.viewport);
    const startAt = Date.now() + 250;
    await writeJsonAtomic(path.join(tempDirectory, 'start.json'), { startAt });
    for (const shot of [...manifest.shots].sort((first, second) => first.atMs - second.atMs)) {
      await waitUntil(startAt + shot.atMs, environment);
      if (shot.press) {
        await page.keyboard.press(shot.press);
        console.log(`press: ${shot.press}`);
      }
      if (shot.selectSession) {
        const sessionId = sessionIds.get(shot.selectSession);
        if (!sessionId) throw new Error(`unknown session ${shot.selectSession}`);
        const railRow = page.locator(`.focus-rail button.session-row[data-id="${sessionId}"]`);
        if (await railRow.isVisible()) await glideCursorTo(railRow);
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
      if (shot.click) {
        const clickScopeId = shot.clickIn ? sessionIds.get(shot.clickIn) : undefined;
        if (shot.clickIn && !clickScopeId) throw new Error(`session ${shot.clickIn} is not on the board`);
        const clickScope = clickScopeId ? page.locator(`[data-id="${clickScopeId}"]`) : page.locator('body');
        const clickTarget = clickScope.locator(shot.click).locator('visible=true').first();
        await clickTarget.waitFor({ state: 'visible', timeout: 10_000 });
        await glideCursorTo(clickTarget);
        await clickTarget.click();
        console.log(`click: ${shot.click}${shot.clickIn ? ` in ${shot.clickIn}` : ''}`);
      }
      if (!shot.name) continue;
      const shotPath = path.join(options.outputDirectory, `${shot.name}.png`);
      await page.screenshot({ path: shotPath });
      console.log(`shot: ${shotPath} (${(await fs.stat(shotPath)).size} bytes)`);
    }
    await waitUntil(startAt + manifest.videoMs, environment);
    const finalStatuses = await readStatuses(environment);
    for (const status of finalStatuses) if (status?.warning) console.warn(status.warning);
    console.log(`replay: ${finalStatuses.filter((status) => status?.phase === 'complete').length} of ${finalStatuses.length} completed`);
    const frames = await screencast.stop();
    await closeBrowserContext();
    console.log(`screencast: ${frames.length} frames`);
    const concatPath = path.join(framesDirectory, 'window.ffconcat');
    await fs.writeFile(concatPath, concatFrameWindow(frames, startAt + manifest.videoStartMs, startAt + manifest.videoMs));
    await encodeWebOutputs(concatPath, options.outputDirectory);
  });
}

try {
  await main();
} catch (error) {
  console.error(`site capture failed: ${safeTextTail(error, 2000)}`);
  process.exitCode = cancellation.signal.aborted ? 130 : 1;
}
