import { z } from 'zod';
import { parseJsonOrNull } from '../../core/json-core.ts';
import { CoherenceOrient } from '../../../shared/contracts/coherence.ts';

export const COHERENCE_JOURNAL_MAX_BYTES = 1024 * 1024;

const claudeSessionIdSchema = z.uuid();
const WORKER_JOURNAL_DIRECTORIES = ['decisions', 'activity', 'calibration', 'read-traces'];
const TERMINAL_DECISION_KINDS = ['retraction', 'resolution', 'dismissal'];
const DECISION_ID_PATTERN = /^d-[0-9a-f]{8}$/;
const OrientHeading = CoherenceOrient.pick({ action: true, reasons: true });

function journalPathOf(directory: string, claudeSessionId: string): string {
  return `.coherence/${directory}/${claudeSessionId}.jsonl`;
}

export function listWorkerJournalPaths(claudeSessionId: string | undefined): string[] {
  const parsedSessionId = claudeSessionIdSchema.safeParse(claudeSessionId);
  if (!parsedSessionId.success) return [];
  return WORKER_JOURNAL_DIRECTORIES.map((directory) => journalPathOf(directory, parsedSessionId.data));
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseJournalRow(line: string): object | null {
  try {
    const parsedLine: unknown = JSON.parse(line);
    if (typeof parsedLine !== 'object' || parsedLine === null || Array.isArray(parsedLine)) return null;
    return parsedLine;
  } catch {
    return null;
  }
}

function isOwnDecisionRow(row: object, claudeSessionId: string): boolean {
  if (Reflect.get(row, 'session') !== claudeSessionId) return false;
  if ('supersedes' in row) return false;
  const kind: unknown = Reflect.get(row, 'kind');
  if (typeof kind !== 'string' || TERMINAL_DECISION_KINDS.includes(kind)) return false;
  const decisionId: unknown = Reflect.get(row, 'id');
  return typeof decisionId === 'string' && DECISION_ID_PATTERN.test(decisionId) && typeof Reflect.get(row, 'at') === 'string';
}

const isJournalRowAllowedByDirectory: Record<string, (row: object, claudeSessionId: string) => boolean> = {
  decisions: isOwnDecisionRow,
  activity: (row, claudeSessionId) => Reflect.get(row, 'session') === claudeSessionId,
  calibration: (row, claudeSessionId) => isHookSampleOfFile(row, `${claudeSessionId}.jsonl`),
  'read-traces': () => true,
};

export function isValidWorkerJournal({ relativePath, bytes, claudeSessionId }: {
  relativePath: string; bytes: Uint8Array; claudeSessionId: string | undefined;
}): boolean {
  if (claudeSessionId === undefined || !listWorkerJournalPaths(claudeSessionId).includes(relativePath)) return false;
  if (bytes.byteLength > COHERENCE_JOURNAL_MAX_BYTES) return false;
  const text = decodeStrictUtf8(bytes);
  if (text === null || text === '' || !text.endsWith('\n')) return false;
  const directory = WORKER_JOURNAL_DIRECTORIES.find((journalDirectory) => relativePath === journalPathOf(journalDirectory, claudeSessionId));
  const isRowAllowed = directory === undefined ? undefined : isJournalRowAllowedByDirectory[directory];
  if (isRowAllowed === undefined) return false;
  return text.slice(0, -1).split('\n').every((line) => {
    const row = parseJournalRow(line);
    return row !== null && isRowAllowed(row, claudeSessionId);
  });
}

export function isJournalProjectionTrusted(orientOutput: string | null): boolean {
  const orientHeading = OrientHeading.safeParse(parseJsonOrNull(orientOutput));
  if (!orientHeading.success || orientHeading.data.action === 'refuse') return false;
  return !orientHeading.data.reasons.some((reason) => /damage/i.test(reason));
}

const HOOK_SAMPLE_OUTCOME = 'unknown';
const HOOK_SAMPLE_FILE_STEM_MAX_LENGTH = 120;
const HOOK_SAMPLE_TEXT_FIELDS = ['id', 'at'];
const HOOK_SAMPLE_PATH_LIST_FIELDS = ['changed', 'predicted', 'observed'];

function hookSampleFileName(session: string): string {
  const fileStem = session.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, HOOK_SAMPLE_FILE_STEM_MAX_LENGTH) || 'unknown';
  return `${fileStem}.jsonl`;
}

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isHookSampleOfFile(record: object | null, fileName: string): boolean {
  if (record === null) return false;
  const session: unknown = Reflect.get(record, 'session');
  if (typeof session !== 'string') return false;
  if (HOOK_SAMPLE_TEXT_FIELDS.some((field) => typeof Reflect.get(record, field) !== 'string')) return false;
  if (HOOK_SAMPLE_PATH_LIST_FIELDS.some((field) => !isStringList(Reflect.get(record, field)))) return false;
  return Reflect.get(record, 'outcome') === HOOK_SAMPLE_OUTCOME && hookSampleFileName(session) === fileName;
}
