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
