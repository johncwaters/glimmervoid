import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { DecisionSummary, RepoSnapshot, WorkOrderSummary } from './coherence-delta.ts';
import { stripUnsafeTextCharacters } from './graph-schema.ts';

const LedgerText = z.string().transform(stripUnsafeTextCharacters);

const CoherenceRefusal = z.looseObject({ error: LedgerText });

const WorkInspectOutput = z.looseObject({
  work: z.array(z.looseObject({
    work: LedgerText,
    state: LedgerText,
    readiness: LedgerText,
    opened: z.looseObject({ objective: LedgerText }),
    last: z.looseObject({ at: LedgerText }).nullable(),
  })),
});

const OrientOutput = z.looseObject({
  action: LedgerText,
  reasons: z.array(LedgerText),
  consequences: z.looseObject({ unverifiedCompletedWork: z.array(LedgerText) }),
});

const JournalRow = z.looseObject({
  id: LedgerText,
  kind: LedgerText,
  at: LedgerText,
  chose: LedgerText.optional(),
  because: LedgerText.optional(),
  work: LedgerText.optional(),
  supersedes: LedgerText.optional(),
});

export type CoherenceRunner = (repo: string, commandArguments: readonly string[]) => string;

const JOURNAL_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function readRegularFile(filePath: string, displayName: string): string {
  if (!lstatSync(filePath).isFile()) throw new Error(`${displayName} is not a regular file`);
  const fileDescriptor = openSync(filePath, JOURNAL_OPEN_FLAGS);
  try {
    if (!fstatSync(fileDescriptor).isFile()) throw new Error(`${displayName} is not a regular file`);
    return readFileSync(fileDescriptor, 'utf8');
  } finally {
    closeSync(fileDescriptor);
  }
}

function readCompleteJournalLines(filePath: string, displayName: string): string[] {
  const lines = readRegularFile(filePath, displayName).split('\n');
  return lines.slice(0, -1).filter((line) => line.trim() !== '');
}

function findEarliestRetractionAtById(rows: readonly z.infer<typeof JournalRow>[]): Map<string, string> {
  const retractedAtById = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== 'retraction' || !row.supersedes) continue;
    const knownAt = retractedAtById.get(row.supersedes);
    if (knownAt !== undefined && Date.parse(knownAt) <= Date.parse(row.at)) continue;
    retractedAtById.set(row.supersedes, row.at);
  }
  return retractedAtById;
}

function listJournalFiles(journalDirectory: string, relativeDirectory: string): string[] {
  return readdirSync(join(journalDirectory, relativeDirectory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.name.endsWith('.jsonl')) return [relativePath];
    if (entry.isSymbolicLink()) throw new Error(`${relativePath} is a symbolic link`);
    if (entry.isDirectory()) return listJournalFiles(journalDirectory, relativePath);
    return [];
  });
}

function readDecisionJournal(repo: string): DecisionSummary[] {
  const journalDirectory = join(repo, '.coherence', 'decisions');
  const journalDirectoryStats = lstatSync(journalDirectory, { throwIfNoEntry: false });
  if (journalDirectoryStats === undefined) return [];
  if (!journalDirectoryStats.isDirectory()) throw new Error('.coherence/decisions is not a directory');
  const journalFiles = listJournalFiles(journalDirectory, '');
  const rows = journalFiles.flatMap((fileName) =>
    readCompleteJournalLines(join(journalDirectory, fileName), fileName).map((line, index) => {
      const parsed = JournalRow.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`unreadable journal row ${fileName}:${index + 1}`);
      return parsed.data;
    }));
  const retractedAtById = findEarliestRetractionAtById(rows);
  return rows
    .filter((row) => row.kind === 'decision')
    .map((row) => ({
      id: row.id,
      chose: row.chose ?? '',
      because: row.because ?? '',
      at: row.at,
      workId: row.work ?? null,
      isRetracted: retractedAtById.has(row.id),
      retractedAt: retractedAtById.get(row.id) ?? null,
    }))
    .toSorted((left, right) => left.at.localeCompare(right.at));
}

function describeReadFailure(error: unknown): string {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'coherence CLI not found';
  const rawReason = error instanceof Error ? error.message.split('\n')[0] ?? 'unknown error' : String(error);
  return stripUnsafeTextCharacters(rawReason);
}

export function readRepoSnapshot(repo: string, runCoherence: CoherenceRunner): RepoSnapshot {
  const runCoherenceJson = (commandArguments: readonly string[]): unknown => JSON.parse(runCoherence(repo, commandArguments));
  if (!existsSync(join(repo, '.coherence'))) return { isAvailable: false, reason: 'no .coherence ledger in this repo' };
  try {
    const workInspectJson = runCoherenceJson(['work', 'inspect', '--json']);
    const workRefusal = CoherenceRefusal.safeParse(workInspectJson);
    if (workRefusal.success) return { isAvailable: false, reason: `work ledger refused: ${workRefusal.data.error}` };
    const workInspect = WorkInspectOutput.parse(workInspectJson);
    const orient = OrientOutput.parse(runCoherenceJson(['orient', '--json']));
    const workOrders: WorkOrderSummary[] = workInspect.work.map((entry) => ({
      id: entry.work,
      objective: entry.opened.objective,
      state: entry.state,
      readiness: entry.readiness,
      lastEventAt: entry.last?.at ?? null,
    }));
    return {
      isAvailable: true,
      heading: orient.action,
      headingReasons: orient.reasons,
      workOrders,
      unverifiedCompletedWorkIds: orient.consequences.unverifiedCompletedWork,
      decisions: readDecisionJournal(repo),
    };
  } catch (error) {
    return { isAvailable: false, reason: describeReadFailure(error) };
  }
}
