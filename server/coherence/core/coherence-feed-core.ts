import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  COHERENCE_JOURNAL_DRAWER_MAX_ROWS,
  COHERENCE_JOURNAL_TEXT_MAX_CHARS,
  CoherenceJournalKind,
  CoherenceRegulateOutput,
} from '../../../shared/contracts/coherence.ts';
import type { CoherenceJournalEntry, CoherenceNextAction, CoherenceRegulationReading } from '../../../shared/contracts/coherence.ts';
import type { CoherenceHooksState } from '../../../shared/contracts/session.ts';
import { judgeCoherenceConfig } from './coherence-config-core.ts';
import { sanitizeOneLine } from '../../core/text-core.ts';
import type { CoherenceConfigEntry } from './coherence-config-core.ts';

const SHOWN_KINDS: ReadonlySet<CoherenceJournalKind> = new Set(['decision', 'defect', 'blocked', 'conjecture']);
const TERMINAL_KINDS: ReadonlySet<CoherenceJournalKind> = new Set(['retraction', 'resolution', 'dismissal']);
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_JOURNAL_LINE_CHARS = 64 * 1024;

const COHERENCE_FEED_UNAVAILABLE = Object.freeze({
  noCli: 'the coherence CLI could not be resolved',
  timedOut: 'coherence regulate timed out',
  failed: 'coherence regulate failed',
  unrecognized: 'the coherence regulate output was not recognized',
  guardrails: 'the guardrails sandbox for coherence regulate could not start',
  snapshotTooLarge: 'the session changes are too large to snapshot for coherence regulate',
  snapshotFailed: 'the session checkout could not be snapshotted for coherence regulate',
  journalNotAFile: 'the Coherence journal is not a regular file',
  journalUnreadable: 'the Coherence journal could not be read',
});

const canonicalTimestamp = z.string().regex(CANONICAL_TIMESTAMP).refine((at) => new Date(at).toISOString() === at);

const RawDecisionRow = z.looseObject({
  id: z.string().regex(/^d-[0-9a-f]{8}$/),
  at: canonicalTimestamp,
  kind: CoherenceJournalKind.exclude(['defect']),
  session: z.string(),
  chose: z.string(),
  because: z.string(),
  supersedes: z.string().regex(/^d-[0-9a-f]{8}$/).optional(),
});

const RawDefectRow = z.looseObject({
  event: z.literal('recorded'),
  id: z.string().regex(/^def-[a-f0-9]{12}$/),
  at: canonicalTimestamp,
  session: z.string(),
  summary: z.string(),
  evidence: z.string(),
});

type JournalSource = 'decisions' | 'defects';

function plainText(text: string): string {
  return sanitizeOneLine(text, COHERENCE_JOURNAL_TEXT_MAX_CHARS);
}

function optionalPlainText(text: string | undefined): string | null {
  const flattened = text === undefined ? '' : plainText(text);
  return flattened === '' ? null : flattened;
}

function parseJsonLine(line: string): unknown {
  if (line.length > MAX_JOURNAL_LINE_CHARS) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function entryFromRow(row: unknown, source: JournalSource, coherenceSessionId: string): CoherenceJournalEntry | null {
  if (source === 'defects') {
    const defect = RawDefectRow.safeParse(row);
    if (!defect.success || defect.data.session !== coherenceSessionId) return null;
    return { id: defect.data.id, at: defect.data.at, kind: 'defect', text: plainText(defect.data.summary), detail: optionalPlainText(defect.data.evidence), supersedes: null };
  }
  const decision = RawDecisionRow.safeParse(row);
  if (!decision.success || decision.data.session !== coherenceSessionId) return null;
  const { id, at, kind, chose, because, supersedes } = decision.data;
  return { id, at, kind, text: plainText(chose), detail: optionalPlainText(because), supersedes: supersedes ?? null };
}

function parseJournalLines(text: string, source: JournalSource, coherenceSessionId: string): CoherenceJournalEntry[] {
  return text.split('\n').flatMap((line) => {
    const entry = entryFromRow(parseJsonLine(line.trim()), source, coherenceSessionId);
    return entry ? [entry] : [];
  });
}

function compareEntryTimes(left: { entry: CoherenceJournalEntry; index: number }, right: { entry: CoherenceJournalEntry; index: number }): number {
  if (left.entry.at < right.entry.at) return -1;
  if (left.entry.at > right.entry.at) return 1;
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

function coherenceSlug(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').replace(/[-.]+$/, '').replace(/-{2,}/g, '-');
  const safe = (clean || 'x').slice(0, 48);
  return safe === raw ? safe : `${safe}-${createHash('sha256').update(raw).digest('hex').slice(0, 6)}`;
}

function hashedSessionFileName(namespace: 'decision' | 'defect', coherenceSessionId: string): string {
  const key = createHash('sha256').update(`coherence:${namespace}-session\0`).update(coherenceSessionId, 'utf8').digest('hex');
  return `s-${key}.jsonl`;
}

function journalFileNames(coherenceSessionId: string): Record<JournalSource, string[]> {
  const readableName = `${coherenceSlug(coherenceSessionId)}.jsonl`;
  return {
    decisions: [readableName, hashedSessionFileName('decision', coherenceSessionId)],
    defects: [hashedSessionFileName('defect', coherenceSessionId), readableName],
  };
}

function renderNextActionCommand(command: { name: string; args: string[] } | undefined): string | null {
  if (!command) return null;
  return plainText(['coherence', command.name, ...command.args].join(' '));
}

function parseRegulateDocument(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function nextActionFromRegulateOutput(stdout: string): CoherenceRegulationReading {
  const parsed = CoherenceRegulateOutput.safeParse(parseRegulateDocument(stdout));
  if (!parsed.success) return { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.unrecognized };
  const { action, selected, remaining } = parsed.data;
  const nextAction: CoherenceNextAction = {
    action,
    rule: selected ? plainText(selected.rule) : null,
    evidence: selected ? plainText(selected.evidence) : null,
    remedy: optionalPlainText(selected?.remedy),
    command: renderNextActionCommand(selected?.command),
    remaining,
  };
  return { ok: true, nextAction };
}

function isSnapshotSafeRelativePath(relativePath: string): boolean {
  if (relativePath === '' || relativePath.startsWith('/') || relativePath.includes('\\')) return false;
  return relativePath.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git');
}

function changedPathsFromPorcelainStatus(statusOutput: string): string[] {
  return statusOutput.split('\0').flatMap((record) => {
    const relativePath = record.slice(3);
    return record.length > 3 && isSnapshotSafeRelativePath(relativePath) ? [relativePath] : [];
  });
}

function regulationFromConfig(entry: CoherenceConfigEntry): CoherenceRegulationReading | null {
  const verdict = judgeCoherenceConfig(entry);
  if (verdict.ok) return null;
  return { ok: false, reason: verdict.reason };
}

function regulateArgs({ host, baseSha }: { host: 'claude' | 'codex'; baseSha: string | null }): string[] {
  const sinceArgs = baseSha !== null && COMMIT_SHA.test(baseSha) ? ['--since', baseSha] : [];
  return ['regulate', '--json', ...sinceArgs, '--host', host];
}

function attachedCoherenceHost({ host, coherenceHooks }: { host: string | null | undefined; coherenceHooks: CoherenceHooksState | null }): 'claude' | 'codex' | null {
  if (host !== 'claude' && host !== 'codex') return null;
  return coherenceHooks?.active === true ? host : null;
}

export type { JournalSource };
export {
  appendJournalWindow, changedPathsFromPorcelainStatus, COHERENCE_FEED_UNAVAILABLE, attachedCoherenceHost, journalFileNames, nextActionFromRegulateOutput,
  parseJournalLines, regulateArgs, regulationFromConfig, selectLatestShownEntry,
};
