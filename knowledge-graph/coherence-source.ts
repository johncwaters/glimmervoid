import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { journalRecordKinds } from './coherence-delta.ts';
import type { DecisionSummary, JournalRecordStanding, RepoSnapshot, WorkOrderSummary } from './coherence-delta.ts';
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

const OrientHeading = z.looseObject({
  action: LedgerText,
  reasons: z.array(LedgerText),
});

const OrientOutput = OrientHeading.extend({
  consequences: z.looseObject({ unverifiedCompletedWork: z.array(LedgerText) }),
});

const TrackableJournalKind = z.enum(journalRecordKinds);

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

function findSettlementById(rows: readonly z.infer<typeof JournalRow>[], retractedAtById: ReadonlyMap<string, string>): Map<string, 'resolved' | 'dismissed'> {
  const settlementById = new Map<string, 'resolved' | 'dismissed'>();
  for (const row of rows) {
    if (!row.supersedes || retractedAtById.has(row.id)) continue;
    if (row.kind === 'resolution') settlementById.set(row.supersedes, 'resolved');
    if (row.kind === 'dismissal' && settlementById.get(row.supersedes) !== 'resolved') settlementById.set(row.supersedes, 'dismissed');
  }
  return settlementById;
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
  const settlementById = findSettlementById(rows, retractedAtById);
  const standingOf = (row: z.infer<typeof JournalRow>, isConjecture: boolean): JournalRecordStanding => {
    if (retractedAtById.has(row.id)) return 'retracted';
    if (!isConjecture) return 'standing';
    return settlementById.get(row.id) ?? 'open';
  };
  return rows
    .flatMap((row): DecisionSummary[] => {
      const kind = TrackableJournalKind.safeParse(row.kind);
      if (!kind.success) return [];
      return [{
        id: row.id,
        kind: kind.data,
        standing: standingOf(row, kind.data === 'conjecture'),
        chose: row.chose ?? '',
        because: row.because ?? '',
        at: row.at,
        workId: row.work ?? null,
        retractedAt: retractedAtById.get(row.id) ?? null,
      }];
    })
    .toSorted((left, right) => left.at.localeCompare(right.at));
}

function describeShapeDrift(commandName: string, error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (firstIssue === undefined) return `unexpected ${commandName} output`;
  const location = firstIssue.path.length === 0 ? 'top level' : firstIssue.path.join('.');
  return stripUnsafeTextCharacters(`unexpected ${commandName} output at ${location}: ${firstIssue.message}`);
}

function describeOrientFailure(orientJson: unknown, error: z.ZodError): string {
  const heading = OrientHeading.safeParse(orientJson);
  if (heading.success && heading.data.action === 'refuse') return `orient refused: ${heading.data.reasons.join('; ')}`;
  return describeShapeDrift('coherence orient', error);
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
    const workInspect = WorkInspectOutput.safeParse(workInspectJson);
    if (!workInspect.success) return { isAvailable: false, reason: describeShapeDrift('coherence work inspect', workInspect.error) };
    const orientJson = runCoherenceJson(['orient', '--json']);
    const orient = OrientOutput.safeParse(orientJson);
    if (!orient.success) return { isAvailable: false, reason: describeOrientFailure(orientJson, orient.error) };
    const workOrders: WorkOrderSummary[] = workInspect.data.work.map((entry) => ({
      id: entry.work,
      objective: entry.opened.objective,
      state: entry.state,
      readiness: entry.readiness,
      lastEventAt: entry.last?.at ?? null,
    }));
    return {
      isAvailable: true,
      heading: orient.data.action,
      headingReasons: orient.data.reasons,
      workOrders,
      unverifiedCompletedWorkIds: orient.data.consequences.unverifiedCompletedWork,
      decisions: readDecisionJournal(repo),
    };
  } catch (error) {
    return { isAvailable: false, reason: describeReadFailure(error) };
  }
}
