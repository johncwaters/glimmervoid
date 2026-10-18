import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorCode, errorMessage, isMissingFileError } from '../../shared/text.ts';
import { decideCoherenceAttachment } from '../core/coherence-session-core.ts';
import { FACTORY_WORKER_JOURNAL_MAX_BYTES, isJournalProjectionTrusted, isValidWorkerJournal, listWorkerJournalPaths } from '../factory/core/factory-journal-core.ts';
import { prepareCoherenceJournal } from '../lanes/lane-spawn.ts';
import type { CoherenceJournal, LaneCoherenceCli } from '../lanes/lane-spawn.ts';
import { createSerialQueue } from '../spawn-gate.ts';

type RunCoherence = (request: { cwd: string; args: string[] }) => Promise<string>;

type LaneJournalRead = { outcome: 'absent' } | { outcome: 'rejected'; reason: string } | { outcome: 'valid'; bytes: Buffer };

const LOCAL_STORE_LABEL = 'local Coherence store';
const LOCAL_STORE_CONFIG_FILENAME = 'coherence.config.json';

async function readLaneJournalFile(realLaneCwd: string, journalPath: string, claudeSessionId: string): Promise<LaneJournalRead> {
  const sourcePath = path.join(realLaneCwd, journalPath);
  const sourceStats = await lstat(sourcePath).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (sourceStats === null) return { outcome: 'absent' };
  if (!sourceStats.isFile()) return { outcome: 'rejected', reason: 'it is not a regular file' };
  if (await realpath(sourcePath) !== sourcePath) return { outcome: 'rejected', reason: 'it resolves outside the lane folder' };
  if (sourceStats.size > FACTORY_WORKER_JOURNAL_MAX_BYTES) return { outcome: 'rejected', reason: 'it is over 1 MiB' };
  const journalFile = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const bytes = await journalFile.readFile().finally(() => journalFile.close());
  if (!isValidWorkerJournal({ relativePath: journalPath, bytes, claudeSessionId })) return { outcome: 'rejected', reason: "it is not a canonical JSONL journal of the lane's own session" };
  return { outcome: 'valid', bytes };
}

async function writeNewJournal(realDestinationCwd: string, destinationLabel: string, journalPath: string, bytes: Buffer): Promise<string | null> {
  const destinationPath = path.join(realDestinationCwd, journalPath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  if (await realpath(path.dirname(destinationPath)) !== path.dirname(destinationPath)) return `its ${destinationLabel} folder resolves elsewhere`;
  try {
    await writeFile(destinationPath, bytes, { flag: 'wx' });
    return null;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return `it already exists in the ${destinationLabel}`;
    throw error;
  }
}

export async function copyLaneJournal({ laneCwd, claudeSessionId, destinationCwd, destinationLabel, runCoherence, onRejected, onUntrusted }: {
  laneCwd: string; claudeSessionId: string; destinationCwd: string; destinationLabel: string; runCoherence: RunCoherence;
  onRejected: (journalPath: string, reason: string) => void; onUntrusted: (journalPaths: readonly string[]) => void;
}): Promise<void> {
  const realLaneCwd = await realpath(laneCwd);
  const realDestinationCwd = await realpath(destinationCwd);
  const copiedJournalPaths: string[] = [];
  for (const journalPath of listWorkerJournalPaths(claudeSessionId)) {
    const laneJournal = await readLaneJournalFile(realLaneCwd, journalPath, claudeSessionId);
    if (laneJournal.outcome === 'absent') continue;
    if (laneJournal.outcome === 'rejected') {
      onRejected(journalPath, laneJournal.reason);
      continue;
    }
    const writeRefusal = await writeNewJournal(realDestinationCwd, destinationLabel, journalPath, laneJournal.bytes);
    if (writeRefusal !== null) {
      onRejected(journalPath, writeRefusal);
      continue;
    }
    copiedJournalPaths.push(journalPath);
  }
  if (copiedJournalPaths.length === 0) return;
  const orientOutput = await runCoherence({ cwd: realDestinationCwd, args: ['orient', '--json'] }).catch(() => null);
  if (isJournalProjectionTrusted(orientOutput)) return;
  await Promise.all(copiedJournalPaths.map((journalPath) => rm(path.join(realDestinationCwd, journalPath), { force: true })));
  onUntrusted(copiedJournalPaths);
}

async function ensureLocalJournalStore(storeRoot: string, repoKey: string): Promise<string> {
  const storeCwd = path.join(storeRoot, repoKey);
  await mkdir(storeCwd, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path.join(storeCwd, LOCAL_STORE_CONFIG_FILENAME), '{}\n', { flag: 'wx' });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  return storeCwd;
}

export function createLocalCoherenceJournals({ storeRoot, isSettingOn, coherenceCli, runCoherence, hasRepoConfig, log }: {
  storeRoot: string; isSettingOn: () => boolean; coherenceCli: LaneCoherenceCli | null; runCoherence: RunCoherence;
  hasRepoConfig: (repoDir: string) => Promise<boolean>; log: Pick<Console, 'warn'>;
}) {
  const landingQueue = createSerialQueue();

  async function prepare({ repoDir, laneCwd, laneName, resumedClaudeSessionId = null }: {
    repoDir: string; laneCwd: string; laneName: string; resumedClaudeSessionId?: string | null;
  }): Promise<CoherenceJournal | null> {
    if (coherenceCli === null) return null;
    try {
      const isSettingOnNow = isSettingOn();
      const isAttached = decideCoherenceAttachment({ sessionKind: 'review', isSettingOn: isSettingOnNow }) && await hasRepoConfig(repoDir);
      if (!isAttached) return null;
      return await prepareCoherenceJournal({ laneCwd, coherenceCli, isCodex: false, laneName, resumedClaudeSessionId });
    } catch (error) {
      log.warn(`[${laneName}] running without a Coherence journal: ${errorMessage(error)}`);
      return null;
    }
  }

  async function release(journal: CoherenceJournal, laneName: string): Promise<void> {
    await rm(journal.shimDir, { recursive: true, force: true })
      .catch((error: unknown) => log.warn(`[${laneName}] could not delete ${journal.shimDir}: ${errorMessage(error)}`));
  }

  async function land({ journal, laneCwd, repoKey, laneName }: { journal: CoherenceJournal; laneCwd: string; repoKey: string; laneName: string }): Promise<void> {
    try {
      await landingQueue.run(async () => {
        const storeCwd = await ensureLocalJournalStore(storeRoot, repoKey);
        const discarded: string[] = [];
        await copyLaneJournal({
          laneCwd, claudeSessionId: journal.claudeSessionId, destinationCwd: storeCwd, destinationLabel: LOCAL_STORE_LABEL, runCoherence,
          onRejected: (journalPath, reason) => { discarded.push(`${journalPath}: ${reason}`); },
          onUntrusted: (journalPaths) => { discarded.push(`${journalPaths.join(', ')}: coherence orient did not read them as an undamaged trusted projection`); },
        });
        if (discarded.length > 0) log.warn(`[${laneName}] discarding lane journals instead of keeping them in the ${LOCAL_STORE_LABEL}: ${discarded.join('; ')}`);
      });
    } catch (error) {
      log.warn(`[${laneName}] could not keep the lane journal in the ${LOCAL_STORE_LABEL}: ${errorMessage(error)}`);
    } finally {
      await release(journal, laneName);
    }
  }

  return { prepare, land, release };
}

export type LocalCoherenceJournals = ReturnType<typeof createLocalCoherenceJournals>;
