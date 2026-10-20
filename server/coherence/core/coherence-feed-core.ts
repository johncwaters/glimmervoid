import { z } from 'zod';
import { COHERENCE_JOURNAL_DRAWER_MAX_ROWS, COHERENCE_JOURNAL_TEXT_MAX_CHARS } from '../../../shared/contracts/coherence.ts';
import type { CoherenceJournalEntry, CoherenceJournalOutput, CoherenceJournalRecord } from '../../../shared/contracts/coherence.ts';
import { sanitizeOneLine } from '../../core/text-core.ts';

const SHOWN_KINDS: ReadonlySet<string> = new Set(['decision', 'defect', 'unable', 'escalation', 'conjecture']);
const TERMINAL_KINDS: ReadonlySet<string> = new Set(['retraction', 'resolution', 'dismissal', 'acknowledgement']);

function textField(record: CoherenceJournalRecord, field: string): string | null {
  const value: unknown = Reflect.get(record, field);
  if (typeof value !== 'string') return null;
  return sanitizeOneLine(value, COHERENCE_JOURNAL_TEXT_MAX_CHARS);
}

export function journalEntries(output: CoherenceJournalOutput, sessionId: string): CoherenceJournalEntry[] {
  return output.records.flatMap((record) => {
    if ('session' in record && record.session !== sessionId) return [];
    return [{
      id: record.id, kind: record.kind, at: textField(record, 'at'),
      text: textField(record, 'chose') ?? textField(record, 'observation') ?? textField(record, 'what') ?? textField(record, 'expectation') ?? textField(record, 'practice') ?? textField(record, 'of') ?? record.kind,
      detail: textField(record, 'because') ?? textField(record, 'evidence') ?? textField(record, 'discriminatedBy') ?? textField(record, 'outcome'),
      supersedes: textField(record, 'of'),
    }];
  });
}

function compareEntryTimes(left: { entry: CoherenceJournalEntry; index: number }, right: { entry: CoherenceJournalEntry; index: number }): number {
  if ((left.entry.at ?? '') < (right.entry.at ?? '')) return -1;
  if ((left.entry.at ?? '') > (right.entry.at ?? '')) return 1;
  return left.index - right.index;
}

function appendJournalWindow(window: readonly CoherenceJournalEntry[], arrivals: readonly CoherenceJournalEntry[]): CoherenceJournalEntry[] {
  const seenIds = new Set(window.map((entry) => entry.id));
  const freshArrivals = arrivals.filter((entry) => {
    if (seenIds.has(entry.id)) return false;
    seenIds.add(entry.id);
    return true;
  });
  const merged = [...window, ...freshArrivals].map((entry, index) => ({ entry, index }));
  merged.sort(compareEntryTimes);
  return merged.slice(-COHERENCE_JOURNAL_DRAWER_MAX_ROWS).map(({ entry }) => entry);
}

function selectLatestShownEntry(window: readonly CoherenceJournalEntry[]): CoherenceJournalEntry | null {
  const supersededIds = new Set<string>();
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const entry = window[index];
    if (TERMINAL_KINDS.has(entry.kind)) {
      if (entry.supersedes !== null) supersededIds.add(entry.supersedes);
      continue;
    }
    if (!SHOWN_KINDS.has(entry.kind) || supersededIds.has(entry.id)) continue;
    return entry;
  }
  return null;
}

export { appendJournalWindow, selectLatestShownEntry };

const MAX_TARGETED_CHANGED_PATHS = 200;
const TOTALITY_ORACLE_FORM = 'totality oracle';
const OPERATOR_NOTE_MAX_CHARS = 500;

const VerdictEntry = z.object({ component: z.string(), name: z.string(), form: z.string(), verdict: z.string(), enforces: z.array(z.string()).optional() });
const RunOutput = z.object({ invariants: z.array(VerdictEntry) });
const StatusOutput = z.object({ latest: z.record(z.string(), VerdictEntry) });

export type TotalityVerdicts = Record<string, { verdict: string; test: string }>;
type SpecWatch = 'clean' | 'preexisting' | 'standing' | 'noted';
export interface CoherenceVerdictBaseline { head: string; verdicts: TotalityVerdicts; hasSpecProblems: boolean }
export interface CoherenceTurnReading { head: string; observed: TotalityVerdicts; hasSpecProblems: boolean | null }
export interface CoherenceVerdictWatch { head: string; verdicts: TotalityVerdicts; standingFailures: string[]; notedFailures: string[]; spec: SpecWatch }

function totalityVerdicts(entries: readonly z.infer<typeof VerdictEntry>[]): TotalityVerdicts {
  return Object.fromEntries(entries.filter((entry) => entry.form === TOTALITY_ORACLE_FORM).map((entry) => [
    `${entry.component}/${entry.name}`,
    { verdict: entry.verdict, test: sanitizeOneLine(entry.enforces?.join(', ') || entry.name, COHERENCE_JOURNAL_TEXT_MAX_CHARS) },
  ]));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseRunVerdicts(text: string): TotalityVerdicts | null {
  const output = RunOutput.safeParse(parseJson(text));
  return output.success ? totalityVerdicts(output.data.invariants) : null;
}

export function parseStatusVerdicts(text: string): TotalityVerdicts | null {
  const output = StatusOutput.safeParse(parseJson(text));
  return output.success ? totalityVerdicts(Object.values(output.data.latest)) : null;
}

export function invariantQueryPaths(changedPaths: readonly string[]): readonly string[] | 'all' | null {
  if (changedPaths.length === 0) return null;
  return changedPaths.length > MAX_TARGETED_CHANGED_PATHS ? 'all' : changedPaths;
}

export function totalityRunTargets(queryText: string): string[] | 'all' {
  const lines = queryText.split(/\r?\n/);
  if (!lines.some((line) => line.startsWith('  by component ') || line.startsWith('  in no component'))) return 'all';
  const invariantIds = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith('  ') || line.startsWith('  by ') || line.startsWith('  in ')) continue;
    const bullet = /^ {2}(\S(?:.*?\S)?) {2}(.+)$/u.exec(line);
    if (!bullet?.[1].includes('/')) return 'all';
    if (bullet[2].includes(`${TOTALITY_ORACLE_FORM} "`)) invariantIds.add(bullet[1]);
  }
  return [...invariantIds];
}

export function startVerdictWatch(baseline: CoherenceVerdictBaseline): CoherenceVerdictWatch {
  return { head: baseline.head, verdicts: baseline.verdicts, standingFailures: [], notedFailures: [], spec: baseline.hasSpecProblems ? 'preexisting' : 'clean' };
}

function nextSpecWatch(spec: SpecWatch, hasSpecProblems: boolean | null): { spec: SpecWatch; isNoteDue: boolean } {
  if (hasSpecProblems === false) return { spec: 'clean', isNoteDue: false };
  if (spec === 'standing') return { spec: 'noted', isNoteDue: true };
  if (hasSpecProblems === true && spec === 'clean') return { spec: 'standing', isNoteDue: false };
  return { spec, isNoteDue: false };
}

export function judgeTurnEnd(watch: CoherenceVerdictWatch, reading: CoherenceTurnReading): { watch: CoherenceVerdictWatch; notes: string[] } {
  const verdicts = { ...watch.verdicts, ...reading.observed };
  const isFailing = (invariantId: string) => verdicts[invariantId]?.verdict === 'fail';
  const standingFailures = watch.standingFailures.filter(isFailing);
  const notedFailures = watch.notedFailures.filter(isFailing);
  const notes: string[] = [];
  for (const invariantId of standingFailures) {
    if (notedFailures.includes(invariantId)) continue;
    const note = `Coherence invariant ${sanitizeOneLine(invariantId, COHERENCE_JOURNAL_TEXT_MAX_CHARS)} still fails after the agent's turn; its test: ${verdicts[invariantId].test}`;
    notes.push(sanitizeOneLine(note, OPERATOR_NOTE_MAX_CHARS));
    notedFailures.push(invariantId);
  }
  for (const [invariantId, observed] of Object.entries(reading.observed)) {
    if (observed.verdict !== 'fail' || watch.verdicts[invariantId]?.verdict !== 'pass' || standingFailures.includes(invariantId)) continue;
    standingFailures.push(invariantId);
  }
  const spec = nextSpecWatch(watch.spec, reading.hasSpecProblems);
  if (spec.isNoteDue) notes.push('Coherence spec check still reports problems after the agent\'s turn; run: spec --check');
  return { watch: { head: reading.head, verdicts, standingFailures, notedFailures, spec: spec.spec }, notes };
}
