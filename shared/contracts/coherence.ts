import { z } from 'zod';

export const CoherenceRisk = z.enum(['low', 'medium', 'high', 'critical']);
export const CoherenceWorkState = z.enum(['open', 'active', 'blocked', 'completed', 'cancelled']);
export const CoherenceReadiness = z.enum(['ready', 'waiting', 'active', 'blocked', 'done']);

const CoherenceWorkStats = z.looseObject({
  total: z.number().int().nonnegative(),
  roots: z.number().int().nonnegative(),
  dependencies: z.number().int().nonnegative(),
  states: z.looseObject({
    open: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  readiness: z.looseObject({
    ready: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
  }),
  risks: z.looseObject({
    low: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative(),
  }),
  graphProblems: z.number().int().nonnegative(),
  scopeOverlaps: z.number().int().nonnegative(),
  scopeConflicts: z.number().int().nonnegative(),
  orphans: z.number().int().nonnegative(),
  unsynthesizedChildren: z.number().int().nonnegative(),
});

export const CoherenceOrient = z.looseObject({
  action: z.enum([
    'steady', 'dispatch', 'continue', 'verify', 'synthesize', 'unblock',
    'resolve-conflict', 'repair-navigation', 'refuse',
  ]),
  reasons: z.array(z.string()),
  sources: z.array(z.looseObject({
    name: z.string(),
    ok: z.boolean(),
    detail: z.string(),
  })),
  work: z.looseObject({
    stats: CoherenceWorkStats,
    ready: z.array(z.string()),
    active: z.array(z.string()),
    blocked: z.array(z.string()),
    completed: z.array(z.string()),
    conflicts: z.array(z.looseObject({
      left: z.string(),
      right: z.string(),
      scope: z.string(),
    })),
    unsynthesized: z.array(z.unknown()),
  }).nullable(),
  consequences: z.looseObject({
    unverifiedCompletedWork: z.array(z.string()),
  }).nullable(),
  verification: z.looseObject({
    state: z.string(),
  }).nullable(),
});

export const CoherenceWorkInspect = z.looseObject({
  work: z.array(z.looseObject({
    work: z.string(),
    state: CoherenceWorkState,
    readiness: CoherenceReadiness,
    owner: z.looseObject({
      session: z.string(),
      agent: z.string(),
    }),
    last: z.looseObject({
      event: z.string(),
      at: z.string(),
      session: z.string(),
      reason: z.string().optional(),
    }).nullable(),
    opened: z.looseObject({
      at: z.iso.datetime(),
      objective: z.string(),
      authority: z.looseObject({ boundary: z.string() }),
      criteria: z.array(z.string()),
      risk: CoherenceRisk,
      parent: z.string().nullable(),
      dependsOn: z.array(z.string()),
      readScopes: z.array(z.string()),
      writeScopes: z.array(z.string()),
    }),
  })),
  scopeConflicts: z.array(z.looseObject({
    left: z.string(),
    right: z.string(),
    leftScope: z.string(),
    rightScope: z.string(),
    status: z.string(),
  })),
});

export type CoherenceOrient = z.infer<typeof CoherenceOrient>;
export type CoherenceWorkInspect = z.infer<typeof CoherenceWorkInspect>;
export type CoherenceRisk = z.infer<typeof CoherenceRisk>;

export const CoherenceWorkCreated = z.looseObject({
  version: z.literal(1),
  event: z.literal('opened'),
  at: z.iso.datetime(),
  session: z.literal('glimmervoid-factory'),
  work: z.string().regex(/^wrk-[a-f0-9]{16}$/),
  id: z.string().regex(/^wev-[a-f0-9]{16}$/),
  parent: z.null(),
  objective: z.string(),
  criteria: z.array(z.string()),
  risk: CoherenceRisk,
  state: z.literal('open'),
  authority: z.object({ kind: z.literal('user-directed'), grantedBy: z.literal('operator'), boundary: z.string() }),
  writeScopes: z.array(z.string()),
});

export const CoherenceTicketCreated = CoherenceWorkCreated.extend({ parent: z.string().regex(/^wrk-[a-f0-9]{16}$/) });

export const COHERENCE_JOURNAL_TEXT_MAX_CHARS = 280;
export const COHERENCE_JOURNAL_DRAWER_MAX_ROWS = 200;
const COHERENCE_FEED_REASON_MAX_CHARS = 200;
const COHERENCE_ENTRY_ID_MAX_CHARS = 64;

export const CoherenceJournalKind = z.enum([
  'session', 'decision', 'blocked', 'retraction', 'conjecture', 'resolution', 'dismissal', 'defect',
]);
export type CoherenceJournalKind = z.infer<typeof CoherenceJournalKind>;

export const CoherenceJournalEntry = z.strictObject({
  id: z.string().min(1).max(COHERENCE_ENTRY_ID_MAX_CHARS),
  at: z.iso.datetime(),
  kind: CoherenceJournalKind,
  text: z.string().max(COHERENCE_JOURNAL_TEXT_MAX_CHARS),
  detail: z.string().max(COHERENCE_JOURNAL_TEXT_MAX_CHARS).nullable(),
  supersedes: z.string().max(COHERENCE_ENTRY_ID_MAX_CHARS).nullable(),
});
export type CoherenceJournalEntry = z.infer<typeof CoherenceJournalEntry>;

export const CoherenceRegulateOutput = z.looseObject({
  doctrine: z.string(),
  id: z.string(),
  action: z.enum(['release', 'refuse', 'require-decision', 'redirect']),
  host: z.enum(['claude', 'codex']),
  selected: z.looseObject({
    rule: z.string(),
    evidence: z.string(),
    remedy: z.string().optional(),
    command: z.looseObject({ name: z.string(), args: z.array(z.string()) }).optional(),
  }).optional(),
  remaining: z.number().int().nonnegative(),
});
export type CoherenceRegulateOutput = z.infer<typeof CoherenceRegulateOutput>;

export const CoherenceNextAction = z.strictObject({
  action: CoherenceRegulateOutput.shape.action,
  rule: z.string().max(COHERENCE_JOURNAL_TEXT_MAX_CHARS).nullable(),
  evidence: z.string().max(COHERENCE_JOURNAL_TEXT_MAX_CHARS).nullable(),
  remedy: z.string().max(COHERENCE_JOURNAL_TEXT_MAX_CHARS).nullable(),
  command: z.string().max(COHERENCE_JOURNAL_TEXT_MAX_CHARS).nullable(),
  remaining: z.number().int().nonnegative(),
});
export type CoherenceNextAction = z.infer<typeof CoherenceNextAction>;

const CoherenceUnavailable = z.strictObject({ ok: z.literal(false), reason: z.string().min(1).max(COHERENCE_FEED_REASON_MAX_CHARS) });

export const CoherenceJournalReading = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), latest: CoherenceJournalEntry.nullable() }),
  CoherenceUnavailable,
]);
export type CoherenceJournalReading = z.infer<typeof CoherenceJournalReading>;

export const CoherenceRegulationReading = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), nextAction: CoherenceNextAction }),
  CoherenceUnavailable,
]);
export type CoherenceRegulationReading = z.infer<typeof CoherenceRegulationReading>;

export const SessionCoherence = z.strictObject({
  journal: CoherenceJournalReading,
  regulation: CoherenceRegulationReading,
  updatedAt: z.number().finite(),
});
export type SessionCoherence = z.infer<typeof SessionCoherence>;
