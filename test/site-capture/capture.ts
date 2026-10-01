import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { z } from 'zod';
import { writeJsonAtomic } from '../../server/json-file.ts';
import { isolateTranscriptHomes } from '../../tests/helpers/transcript-homes.ts';
import { safeTextTail } from '../support/backend-harness.ts';
import { addSession, cancellation, createProject, listProcessesMentioning, prepareIsolatedEnvironment, quoteShell, refuseUnsupportedLaunch, runIsolatedDashboard, selectSession } from './isolated-glimmervoid.ts';
import { ReplayStatus, parseCaptureRecording, redactRecording, validateManifest } from './manifest-core.ts';
import type { ReplayEnvironment } from './manifest-core.ts';

const replayAgentPath = path.join(import.meta.dirname, 'replay-agent.ts');

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
    const mapPath = path.join(tempDirectory, 'replay-map.json');
    await writeJsonAtomic(mapPath, environment);
    process.env.GLIMMERVOID_SITE_CAPTURE_MAP = mapPath;
    const shimDirectory = path.join(tempDirectory, 'shim');
    await fs.mkdir(shimDirectory);
    await fs.writeFile(path.join(shimDirectory, 'claude'), `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(replayAgentPath)} --site-capture-owner ${quoteShell(tempDirectory)} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${shimDirectory}${path.delimiter}${savedPath}`;
    const { socket } = await startServer(port, configPath);
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
    const page = await openDashboard(port, { viewport: manifest.viewport, recordVideo: { dir: path.join(tempDirectory, 'video'), size: manifest.viewport } });
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
    await closeBrowserContext();
    const videoPath = path.join(options.outputDirectory, 'capture.webm');
    await video.saveAs(videoPath);
    console.log(`video: ${videoPath} (${(await fs.stat(videoPath)).size} bytes)`);
  });
}

try {
  await main();
} catch (error) {
  console.error(`site capture failed: ${safeTextTail(error, 2000)}`);
  process.exitCode = cancellation.signal.aborted ? 130 : 1;
}
