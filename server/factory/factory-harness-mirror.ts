import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { FactoryHarnessVerdict } from '../../shared/contracts/factory.ts';
import type { FactoryProjectState, FactoryState } from '../../shared/contracts/factory.ts';
import { HARNESS_STATE_FILE_NAME, HARNESS_VERDICT_FILE_NAME, describeHarnessOutcome, isHarnessRunFresh, latestHarnessRunName, latestHarnessState, mirrorHarnessProjects, newestHarnessBatchNames } from './core/factory-harness-mirror-core.ts';

const STATE_TAIL_MAX_BYTES = 4 * 1024 * 1024;
const NON_BLOCKING_READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

type RegularFile = { handle: FileHandle; stats: Stats };

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function listNames(directory: string): Promise<string[]> {
  try { return await readdir(directory); }
  catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
}

async function openIfPresent(filePath: string): Promise<FileHandle | null> {
  try { return await open(filePath, NON_BLOCKING_READ_FLAGS); }
  catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

async function openRegularFile(filePath: string): Promise<RegularFile | null> {
  const handle = await openIfPresent(filePath);
  if (!handle) return null;
  const stats = await handle.stat().catch(async (error: unknown) => {
    await handle.close();
    throw error;
  });
  if (stats.isFile()) return { handle, stats };
  await handle.close();
  return null;
}

async function readTail(handle: FileHandle, size: number): Promise<{ tail: string; isCutAtStart: boolean }> {
  const length = Math.min(size, STATE_TAIL_MAX_BYTES);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, size - length);
  return { tail: buffer.subarray(0, bytesRead).toString('utf8'), isCutAtStart: length < size };
}

async function readVerdict(verdictPath: string): Promise<{ verdict: FactoryHarnessVerdict | null; modifiedMs: number | null }> {
  const verdictFile = await openRegularFile(verdictPath);
  if (!verdictFile) return { verdict: null, modifiedMs: null };
  try {
    const text = await verdictFile.handle.readFile('utf8');
    return { verdict: FactoryHarnessVerdict.safeParse(JSON.parse(text)).data ?? null, modifiedMs: verdictFile.stats.mtimeMs };
  } catch (error) {
    if (error instanceof SyntaxError) return { verdict: null, modifiedMs: null };
    throw error;
  } finally { await verdictFile.handle.close(); }
}

export function createFactoryHarnessMirror({ runsDirectory, now = Date.now }: { runsDirectory: string; now?: () => number }) {
  type CachedState = { modifiedMs: number; size: number; state: FactoryState | null };
  let cachedStatesByPath = new Map<string, CachedState>();

  async function readLatestState(statePath: string, stateFile: RegularFile, nextCachedStatesByPath: Map<string, CachedState>): Promise<FactoryState | null> {
    const { mtimeMs: modifiedMs, size } = stateFile.stats;
    const cached = cachedStatesByPath.get(statePath);
    if (cached?.modifiedMs === modifiedMs && cached.size === size) {
      nextCachedStatesByPath.set(statePath, cached);
      return cached.state;
    }
    const { tail, isCutAtStart } = await readTail(stateFile.handle, size);
    const state = latestHarnessState(tail, isCutAtStart);
    nextCachedStatesByPath.set(statePath, { modifiedMs, size, state });
    return state;
  }

  async function listBatchProjects(batchName: string, nextCachedStatesByPath: Map<string, CachedState>): Promise<FactoryProjectState[]> {
    const batchDirectory = path.join(runsDirectory, batchName);
    const runName = latestHarnessRunName(await listNames(batchDirectory));
    if (!runName) return [];
    const recordDirectory = path.join(batchDirectory, runName);
    const statePath = path.join(recordDirectory, HARNESS_STATE_FILE_NAME);
    const stateFile = await openRegularFile(statePath);
    if (!stateFile) return [];
    try {
      const { verdict, modifiedMs: verdictModifiedMs } = await readVerdict(path.join(recordDirectory, HARNESS_VERDICT_FILE_NAME));
      if (!isHarnessRunFresh(Math.max(stateFile.stats.mtimeMs, verdictModifiedMs ?? 0), now())) return [];
      const state = await readLatestState(statePath, stateFile, nextCachedStatesByPath);
      if (!state) return [];
      return mirrorHarnessProjects(state, batchName, { recordDirectory, outcome: describeHarnessOutcome(verdict) });
    } finally { await stateFile.handle.close(); }
  }

  async function listObservedProjects(): Promise<FactoryProjectState[]> {
    const nextCachedStatesByPath = new Map<string, CachedState>();
    const projects: FactoryProjectState[] = [];
    for (const batchName of newestHarnessBatchNames(await listNames(runsDirectory))) projects.push(...await listBatchProjects(batchName, nextCachedStatesByPath));
    cachedStatesByPath = nextCachedStatesByPath;
    return projects;
  }

  return { listObservedProjects };
}
