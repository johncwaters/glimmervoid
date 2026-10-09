import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { DecisionSummary, RepoSnapshot, WorkOrderSummary } from './coherence-delta.ts';

const LAST_C0_CONTROL_CODE = 0x1f;
const FIRST_DELETE_OR_C1_CONTROL_CODE = 0x7f;
const LAST_C1_CONTROL_CODE = 0x9f;

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= LAST_C0_CONTROL_CODE || (code >= FIRST_DELETE_OR_C1_CONTROL_CODE && code <= LAST_C1_CONTROL_CODE);
}

function stripControlCharacters(text: string): string {
  return [...text].filter((character) => !isControlCharacter(character)).join('');
}

const LedgerText = z.string().transform(stripControlCharacters);

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

function readCompleteJournalLines(filePath: string): string[] {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  return lines.slice(0, -1).filter((line) => line.trim() !== '');
}

function readDecisionJournal(repo: string): DecisionSummary[] {
  const journalDirectory = join(repo, '.coherence', 'decisions');
  if (!existsSync(journalDirectory)) return [];
  const journalFiles = readdirSync(journalDirectory, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.jsonl'));
  const rows = journalFiles.flatMap((fileName) =>
    readCompleteJournalLines(join(journalDirectory, fileName)).map((line, index) => {
      const parsed = JournalRow.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`unreadable journal row ${fileName}:${index + 1}`);
      return parsed.data;
    }));
  const retractedIds = new Set(rows.filter((row) => row.kind === 'retraction' && row.supersedes).map((row) => row.supersedes));
  return rows
    .filter((row) => row.kind === 'decision')
    .map((row) => ({
      id: row.id,
      chose: row.chose ?? '',
      because: row.because ?? '',
      at: row.at,
      workId: row.work ?? null,
      isRetracted: retractedIds.has(row.id),
    }))
    .toSorted((left, right) => left.at.localeCompare(right.at));
}

function describeReadFailure(error: unknown): string {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'coherence CLI not found';
  const rawReason = error instanceof Error ? error.message.split('\n')[0] ?? 'unknown error' : String(error);
  return stripControlCharacters(rawReason);
}

export function readRepoSnapshot(repo: string, runCoherence: CoherenceRunner): RepoSnapshot {
  const runCoherenceJson = (commandArguments: readonly string[]): unknown => JSON.parse(runCoherence(repo, commandArguments));
  if (!existsSync(join(repo, '.coherence'))) return { isAvailable: false, reason: 'no .coherence ledger in this repo' };
  try {
    const workInspect = WorkInspectOutput.parse(runCoherenceJson(['work', 'inspect', '--json']));
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
