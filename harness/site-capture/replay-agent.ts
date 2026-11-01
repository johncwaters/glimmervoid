import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { writeJsonAtomic } from '../../server/json-file.ts';
import { ReplayEnvironment, compressTimeline, findEnterAnswerTimestamps, findHookEndpoint, parseCaptureRecording, redactRecording } from './manifest-core.ts';

const runCommand = promisify(execFile);
const cancellation = new AbortController();
process.once('SIGTERM', () => cancellation.abort());
process.once('SIGINT', () => cancellation.abort());
const keepAlive = setInterval(() => {}, 60_000);
let statusPath: string | undefined;
const GlimmervoidCall = z.strictObject({ ts: z.number().finite(), args: z.array(z.string()).min(1), exitCode: z.number().int() });
type GlimmervoidCall = z.infer<typeof GlimmervoidCall>;
const dashboardChangingVerbs = new Set(['spawn', 'show', 'whiteboard']);

async function readGlimmervoidCalls(callLogPath: string | undefined): Promise<GlimmervoidCall[]> {
  if (!callLogPath) return [];
  const lines = (await fs.readFile(callLogPath, 'utf8')).split('\n').filter((line) => line.trim().length > 0);
  return lines.map((line) => GlimmervoidCall.parse(JSON.parse(line)))
    .filter((call) => call.exitCode === 0 && dashboardChangingVerbs.has(call.args[0] ?? ''));
}

async function restoreShownFiles(call: GlimmervoidCall, shownFilesDirectory: string | undefined, worktreePath: string): Promise<void> {
  if (!shownFilesDirectory || call.args[0] !== 'show') return;
  const keptNames = new Set(await fs.readdir(shownFilesDirectory));
  for (const argument of call.args.slice(1)) {
    if (argument.startsWith('-') || !keptNames.has(path.basename(argument))) continue;
    const targetPath = path.resolve(worktreePath, argument);
    if (path.relative(worktreePath, targetPath).startsWith('..')) throw new Error(`shown file ${argument} resolves outside the worktree`);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(path.join(shownFilesDirectory, path.basename(argument)), targetPath);
  }
}

async function replayGlimmervoidCall(call: GlimmervoidCall, shownFilesDirectory: string | undefined): Promise<void> {
  const worktreePath = await fs.realpath(process.cwd());
  await restoreShownFiles(call, shownFilesDirectory, worktreePath);
  await runCommand('glimmervoid', call.args, { cwd: worktreePath, signal: cancellation.signal, timeout: 30_000 }).catch((error: Error & { stderr?: string }) => {
    throw new Error(`glimmervoid ${call.args[0]} failed: ${error.stderr?.trim() || error.message}`);
  });
}

function createEnterGate(): () => Promise<void> {
  let unansweredEnterPresses = 0;
  let releaseWaitingAnswer: (() => void) | undefined;
  process.stdin.on('data', (chunk: Buffer) => {
    if (!chunk.includes(13)) return;
    unansweredEnterPresses += 1;
    releaseWaitingAnswer?.();
  });
  return async () => {
    while (unansweredEnterPresses === 0) {
      await new Promise<void>((resolve, reject) => {
        releaseWaitingAnswer = resolve;
        cancellation.signal.addEventListener('abort', () => reject(cancellation.signal.reason), { once: true });
      });
      releaseWaitingAnswer = undefined;
    }
    unansweredEnterPresses -= 1;
  };
}

async function runReplay(): Promise<void> {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const waitForEnterPress = createEnterGate();
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
  const recordingText = await fs.readFile(session.recording, 'utf8');
  const records = redactRecording(parseCaptureRecording(recordingText), environment.manifest.redactions);
  const firstResize = records.find((record) => record.type === 'resize');
  const calls = await readGlimmervoidCalls(session.glimmervoidCalls);
  const timedEvents = [
    ...records.map((record) => ({ ts: record.ts, record, call: undefined, isEnterAnswer: false })),
    ...calls.map((call) => ({ ts: call.ts, record: undefined, call, isEnterAnswer: false })),
    ...findEnterAnswerTimestamps(recordingText).map((ts) => ({ ts, record: undefined, call: undefined, isEnterAnswer: true })),
  ].sort((first, second) => (first.ts ?? 0) - (second.ts ?? 0));
  const timeline = compressTimeline(timedEvents, environment.manifest.speed, session.maxIdleGapMs ?? environment.manifest.maxIdleGapMs);
  await writeJsonAtomic(statusPath, { phase: 'ready' });
  const startPath = path.join(environment.tempDirectory, 'start.json');
  while (!(await fs.stat(startPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }))) await sleep(20, undefined, { signal: cancellation.signal });
  const { startAt } = z.strictObject({ startAt: z.number().finite() }).parse(JSON.parse(await fs.readFile(startPath, 'utf8')));
  let timelineStartAt = session.spawnedBy ? Date.now() : startAt + session.startAtMs;
  const warning = firstResize && (process.stdout.columns !== firstResize.cols || process.stdout.rows !== firstResize.rows)
    ? `PTY size ${process.stdout.columns}x${process.stdout.rows} differs from recording ${firstResize.cols}x${firstResize.rows}`
    : undefined;
  if (warning) process.stderr.write(`WARNING: ${warning}\n`);
  let hasAppliedPatch = false;
  const replaySessionId = crypto.randomUUID();
  for (const { record: { record, call, isEnterAnswer }, atMs } of timeline) {
    await sleep(Math.max(0, timelineStartAt + atMs - Date.now()), undefined, { signal: cancellation.signal });
    if (isEnterAnswer) {
      const pausedAt = Date.now();
      await waitForEnterPress();
      timelineStartAt += Date.now() - pausedAt;
      continue;
    }
    if (call) { await replayGlimmervoidCall(call, environment.manifest.shownFiles); continue; }
    if (!record) continue;
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
  await writeJsonAtomic(statusPath, { phase: 'complete', warning, patchApplied: hasAppliedPatch });
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
    if (statusPath) await writeJsonAtomic(statusPath, { phase: 'failed', error: message });
    process.exitCode = 1;
  }
} finally {
  clearInterval(keepAlive);
}
