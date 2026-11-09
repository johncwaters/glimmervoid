import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { execFileAsync } from './child-process-safe.ts';
import { glimmervoidHomeDir } from './core/config-path-core.ts';
import { firstLine } from './core/text-core.ts';
import { resolveFfmpegPath } from './runtime-paths.ts';
import { createBoardStore } from './whiteboard/board-store-client.ts';
import { createLayoutClient } from './whiteboard/layout-client.ts';
import { createBoard } from '../shared/whiteboard-ops-core.ts';
import { errorText } from '../shared/text.ts';

type NativeProbeRow = [label: string, outcome: string];

const LOADS_OK = 'loads OK';
const FFMPEG_LABEL = 'ffmpeg';
const FFMPEG_MISSING = 'missing: board videos get no poster. Reinstall with npm install -g glimmervoid --allow-scripts=node-pty,ffmpeg-static';
const OPTIONAL_PROBE_LABELS = new Set([FFMPEG_LABEL]);

function isEveryProbeLoading(rows: readonly NativeProbeRow[]): boolean {
  return rows.every(([label, outcome]) => outcome === LOADS_OK || OPTIONAL_PROBE_LABELS.has(label));
}
const FFMPEG_PROBE_TIMEOUT_MS = 10_000;

async function outcomeOf(probe: () => Promise<unknown>): Promise<string> {
  try {
    await probe();
    return LOADS_OK;
  } catch (failure) {
    return `FAILED: ${firstLine(errorText(failure))}`;
  }
}

async function renderWebpWithSharp(): Promise<void> {
  const { default: sharp } = await import('sharp');
  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } }).webp().toBuffer();
}

async function lockFileWithNativeExtensions(scratchDir: string): Promise<void> {
  const fileLocks: typeof import('fs-native-extensions') = createRequire(import.meta.url)('fs-native-extensions');
  const lockDescriptor = fs.openSync(path.join(scratchDir, 'probe.lock'), 'w');
  try {
    if (!fileLocks.tryLock(lockDescriptor)) throw new Error('tryLock refused an unheld file');
    fileLocks.unlock(lockDescriptor);
  } finally {
    fs.closeSync(lockDescriptor);
  }
}

async function openSqliteInBoardStoreWorker(): Promise<void> {
  await createBoardStore(path.join(glimmervoidHomeDir(os.homedir(), process.env), 'doctor-probe', 'boards')).boardIds();
}

async function layOutBoardInLayoutWorker(): Promise<void> {
  const layoutClient = createLayoutClient({ cachePath: null, onSavedLayoutWritten: () => {} });
  await layoutClient.refresh(createBoard({ id: 'doctor-probe', title: 'Doctor probe', nowMs: Date.now() }), []);
}

async function probeFfmpeg(): Promise<string> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) return FFMPEG_MISSING;
  return outcomeOf(() => execFileAsync(ffmpegPath, ['-version'], { timeout: FFMPEG_PROBE_TIMEOUT_MS }));
}

async function probeNativeModules(): Promise<NativeProbeRow[]> {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-doctor-'));
  try {
    return [
      ['sharp', await outcomeOf(renderWebpWithSharp)],
      ['fs-native-extensions', await outcomeOf(() => lockFileWithNativeExtensions(scratchDir))],
      ['node:sqlite worker', await outcomeOf(openSqliteInBoardStoreWorker)],
      ['layout worker', await outcomeOf(layOutBoardInLayoutWorker)],
      [FFMPEG_LABEL, await probeFfmpeg()],
    ];
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

export { isEveryProbeLoading, probeNativeModules };
