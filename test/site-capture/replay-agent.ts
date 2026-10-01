import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { writeJsonAtomic } from '../../server/json-file.ts';
import { ReplayEnvironment, compressTimeline, findHookEndpoint, parseCaptureRecording, redactRecording } from './manifest-core.ts';

const runCommand = promisify(execFile);
const cancellation = new AbortController();
process.once('SIGTERM', () => cancellation.abort());
process.once('SIGINT', () => cancellation.abort());
const keepAlive = setInterval(() => {}, 60_000);
let statusPath: string | undefined;

async function runReplay(): Promise<void> {
  const argv = process.argv.slice(2);
  const settingsIndex = argv.indexOf('--settings');
  const settingsPath = argv.find((argument) => argument.startsWith('--settings='))?.slice('--settings='.length)
    ?? (settingsIndex >= 0 ? argv[settingsIndex + 1] : undefined);
  if (!settingsPath) throw new Error('replay agent needs injected --settings');
  const endpoint = findHookEndpoint(argv, JSON.parse(await fs.readFile(settingsPath, 'utf8')));
  const environmentPath = process.env.GLIMMERVOID_SITE_CAPTURE_MAP;
  if (!environmentPath) throw new Error('missing GLIMMERVOID_SITE_CAPTURE_MAP');
  let environment = ReplayEnvironment.parse(JSON.parse(await fs.readFile(environmentPath, 'utf8')));
  statusPath = path.join(environment.tempDirectory, `${endpoint.sessionId}.status.json`);
  const mappingDeadline = Date.now() + 10_000;
  while (!environment.sessionsById[endpoint.sessionId] && Date.now() < mappingDeadline) {
    await sleep(20, undefined, { signal: cancellation.signal });
    environment = ReplayEnvironment.parse(JSON.parse(await fs.readFile(environmentPath, 'utf8')));
  }
  const session = environment.sessionsById[endpoint.sessionId];
  if (!session) throw new Error('recording missing for injected session id');
  const records = redactRecording(parseCaptureRecording(await fs.readFile(session.recording, 'utf8')), environment.manifest.redactions);
  const firstResize = records.find((record) => record.type === 'resize');
  const timeline = compressTimeline(records, environment.manifest.speed, environment.manifest.maxIdleGapMs);
  await writeJsonAtomic(statusPath, { phase: 'ready', pid: process.pid });
  const startPath = path.join(environment.tempDirectory, 'start.json');
  while (!(await fs.stat(startPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }))) await sleep(20, undefined, { signal: cancellation.signal });
  const { startAt } = z.strictObject({ startAt: z.number().finite() }).parse(JSON.parse(await fs.readFile(startPath, 'utf8')));
  const warning = firstResize && (process.stdout.columns !== firstResize.cols || process.stdout.rows !== firstResize.rows)
    ? `PTY size ${process.stdout.columns}x${process.stdout.rows} differs from recording ${firstResize.cols}x${firstResize.rows}`
    : undefined;
  if (warning) process.stderr.write(`WARNING: ${warning}\n`);
  let hasAppliedPatch = false;
  const replaySessionId = crypto.randomUUID();
  for (const { record, atMs } of timeline) {
    await sleep(Math.max(0, startAt + atMs - Date.now()), undefined, { signal: cancellation.signal });
    if (record.type === 'data' && typeof record.data === 'string') {
      const output = record.data;
      await new Promise<void>((resolve, reject) => process.stdout.write(output, (error) => {
        if (error) { reject(error); return; }
        resolve();
      }));
    }
    if (record.type !== 'hook' || typeof record.event !== 'string') continue;
    if (session.patch && !hasAppliedPatch && record.event === session.patchAtEvent) {
      const worktreePath = await fs.realpath(process.cwd());
      const tempDirectory = await fs.realpath(environment.tempDirectory);
      const relativePath = path.relative(tempDirectory, worktreePath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || relativePath.length === 0) throw new Error('patch worktree must be inside capture temp directory');
      await runCommand('git', ['-C', worktreePath, '-c', 'core.hooksPath=/dev/null', 'am', session.patch], {
        signal: cancellation.signal, timeout: 30_000,
      });
      hasAppliedPatch = true;
    }
    const response = await fetch(`${endpoint.base}/${record.event}${endpoint.query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...record.payload, session_id: replaySessionId, cwd: process.cwd() }),
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) throw new Error(`hook ${record.event} failed: ${response.status}`);
    await response.arrayBuffer();
  }
  await writeJsonAtomic(statusPath, { phase: 'complete', pid: process.pid, warning, patchApplied: hasAppliedPatch });
  await new Promise<void>((resolve) => {
    if (cancellation.signal.aborted) { resolve(); return; }
    cancellation.signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

try {
  await runReplay();
} catch (error) {
  if (!cancellation.signal.aborted) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Replay failed: ${message}\n`);
    if (statusPath) await writeJsonAtomic(statusPath, { phase: 'failed', pid: process.pid, error: message });
    process.exitCode = 1;
  }
} finally {
  clearInterval(keepAlive);
}
