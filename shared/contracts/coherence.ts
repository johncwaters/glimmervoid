import { z } from 'zod';

export const COHERENCE_JOURNAL_TEXT_MAX_CHARS = 280;
export const COHERENCE_JOURNAL_DRAWER_MAX_ROWS = 200;

export const CoherenceJournalKind = z.enum([
  'decision', 'retraction', 'conjecture', 'resolution', 'dismissal', 'defect',
  'experiment', 'close', 'unable', 'escalation', 'acknowledgement', 'enactment',
]);
export type CoherenceJournalKind = z.infer<typeof CoherenceJournalKind>;

const recordHead = {
  id: z.string().min(1), at: z.iso.datetime(), session: z.string(), agent: z.string(),
  commit: z.string().nullable(), dirty: z.boolean(), binding: z.string(),
};
const reference = { of: z.string().min(1), because: z.string() };
const step = z.looseObject({ id: z.string(), text: z.string() });
const KnownJournalRecord = z.discriminatedUnion('kind', [
  z.looseObject({ ...recordHead, kind: z.literal('decision'), chose: z.string(), over: z.array(z.string()), because: z.string() }),
  z.looseObject({ ...recordHead, kind: z.literal('retraction'), ...reference }),
  z.looseObject({ ...recordHead, kind: z.literal('conjecture'), observation: z.string(), couldBe: z.array(z.string()), discriminatedBy: z.string() }),
  z.looseObject({ ...recordHead, kind: z.literal('resolution'), ...reference, as: z.string().optional() }),
  z.looseObject({ ...recordHead, kind: z.literal('dismissal'), ...reference }),
  z.looseObject({ ...recordHead, kind: z.literal('defect'), what: z.string(), evidence: z.string(), files: z.array(z.string()) }),
  z.looseObject({ ...recordHead, kind: z.literal('experiment'), expectation: z.string(), context: z.array(z.string()), actions: z.array(step), criteria: z.array(step) }),
  z.looseObject({ ...recordHead, kind: z.literal('close'), of: z.string(), outcome: z.enum(['success', 'failure', 'inconclusive']), results: z.record(z.string(), z.unknown()) }),
  z.looseObject({ ...recordHead, kind: z.literal('unable'), what: z.string(), because: z.string() }),
  z.looseObject({ ...recordHead, kind: z.literal('escalation'), what: z.string(), because: z.string() }),
  z.looseObject({ ...recordHead, kind: z.literal('acknowledgement'), ...reference }),
  z.looseObject({ ...recordHead, kind: z.literal('enactment'), practice: z.string(), results: z.record(z.string(), z.unknown()) }),
]);

export const CoherenceJournalRecord = z.union([
  KnownJournalRecord,
  z.object({ id: z.string().min(1), kind: z.string().min(1).refine((kind) => !CoherenceJournalKind.safeParse(kind).success) }),
]);
export type CoherenceJournalRecord = z.infer<typeof CoherenceJournalRecord>;

export const CoherenceJournalOutput = z.looseObject({
  branch: z.string().nullable(), escalations: z.array(z.unknown()), records: z.array(CoherenceJournalRecord),
  citedBy: z.record(z.string(), z.array(z.unknown())), damaged: z.array(z.unknown()),
});
export type CoherenceJournalOutput = z.infer<typeof CoherenceJournalOutput>;

export const CoherenceJournalEntry = z.strictObject({
  id: z.string().min(1), at: z.iso.datetime().nullable(), kind: z.string().min(1),
  text: z.string().max(COHERENCE_JOURNAL_TEXT_MAX_CHARS),
  detail: z.string().max(COHERENCE_JOURNAL_TEXT_MAX_CHARS).nullable(), supersedes: z.string().nullable(),
});
export type CoherenceJournalEntry = z.infer<typeof CoherenceJournalEntry>;

export const CoherenceJournalReading = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), latest: CoherenceJournalEntry.nullable() }),
  z.strictObject({ ok: z.literal(false), reason: z.string().min(1).max(200) }),
]);
export type CoherenceJournalReading = z.infer<typeof CoherenceJournalReading>;

export const SessionCoherence = z.strictObject({ journal: CoherenceJournalReading, updatedAt: z.number().finite() });
export type SessionCoherence = z.infer<typeof SessionCoherence>;
