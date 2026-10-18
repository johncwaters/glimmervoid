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

export const COHERENCE_READING_REASON_MAX_CHARS = 200;
export const COHERENCE_READING_TEXT_MAX_CHARS = 120;
export const COHERENCE_READING_PATH_MAX_CHARS = 200;
export const COHERENCE_READING_TOP_ITEMS = 3;
export const COHERENCE_TREND_WINDOW_ROWS = 20;

const readingCount = z.number().int().nonnegative();
const readingPercent = z.number().int().min(0).max(100);
const readingText = z.string().max(COHERENCE_READING_TEXT_MAX_CHARS);

const CoherenceReadingUnavailable = z.strictObject({ status: z.literal('unavailable'), reason: z.string().min(1).max(COHERENCE_READING_REASON_MAX_CHARS) });
const CoherenceReadingNeedsComponents = z.strictObject({ status: z.literal('needs-components'), configLine: z.string().min(1).max(COHERENCE_READING_REASON_MAX_CHARS) });

export const CoherenceDriftReading = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('insufficient-history'), developmentCommits: readingCount }),
  z.strictObject({
    status: z.literal('ok'), developmentCommits: readingCount, localityPercent: readingPercent,
    locality: z.enum(['converging', 'decohering', 'flat']), spread: z.enum(['widening', 'narrowing', 'flat']),
  }),
  CoherenceReadingNeedsComponents,
  CoherenceReadingUnavailable,
]);
export type CoherenceDriftReading = z.infer<typeof CoherenceDriftReading>;

export const CoherenceDecomposeFinding = z.strictObject({
  kind: z.enum(['cross-boundary', 'missing-abstraction', 'structure-hub']),
  subject: readingText,
  count: readingCount,
});
export type CoherenceDecomposeFinding = z.infer<typeof CoherenceDecomposeFinding>;

export const CoherenceDecomposeReading = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'), components: readingCount, commitsAnalyzed: readingCount, localityPercent: readingPercent,
    topFindings: z.array(CoherenceDecomposeFinding).max(COHERENCE_READING_TOP_ITEMS),
  }),
  CoherenceReadingNeedsComponents,
  CoherenceReadingUnavailable,
]);
export type CoherenceDecomposeReading = z.infer<typeof CoherenceDecomposeReading>;

const CoherenceRedundancySite = z.strictObject({ file: z.string().max(COHERENCE_READING_PATH_MAX_CHARS), kind: readingText, name: readingText });

export const CoherenceRedundancyPair = z.strictObject({
  a: CoherenceRedundancySite,
  b: CoherenceRedundancySite,
  score: z.number().nonnegative().finite(),
  isDiverged: z.boolean(),
});
export type CoherenceRedundancyPair = z.infer<typeof CoherenceRedundancyPair>;

export const CoherenceRedundancyReading = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), pairCount: readingCount, topPairs: z.array(CoherenceRedundancyPair).max(COHERENCE_READING_TOP_ITEMS) }),
  CoherenceReadingUnavailable,
]);
export type CoherenceRedundancyReading = z.infer<typeof CoherenceRedundancyReading>;

export const CoherenceMassReading = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), lines: readingCount, files: readingCount, symbols: readingCount }),
  CoherenceReadingUnavailable,
]);
export type CoherenceMassReading = z.infer<typeof CoherenceMassReading>;

export const CoherenceReadingRow = z.strictObject({
  sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  at: z.iso.datetime(),
  drift: CoherenceDriftReading,
  decompose: CoherenceDecomposeReading,
  redundancy: CoherenceRedundancyReading,
  mass: CoherenceMassReading,
});
export type CoherenceReadingRow = z.infer<typeof CoherenceReadingRow>;

const CoherenceTrendSpan = z.strictObject({ from: readingCount, to: readingCount });

export const CoherenceTrendWindow = z.strictObject({
  direction: z.enum(['converging', 'steady', 'decohering']),
  rows: z.number().int().nonnegative().max(COHERENCE_TREND_WINDOW_ROWS),
  comparedRows: z.number().int().nonnegative().max(COHERENCE_TREND_WINDOW_ROWS),
  redundancyPairs: CoherenceTrendSpan.nullable(),
  lines: CoherenceTrendSpan.nullable(),
});
export type CoherenceTrendWindow = z.infer<typeof CoherenceTrendWindow>;

export const ProjectCoherenceTrend = z.strictObject({
  latest: CoherenceReadingRow,
  trend: CoherenceTrendWindow,
});
export type ProjectCoherenceTrend = z.infer<typeof ProjectCoherenceTrend>;

export const CoherenceAdoptError = z.enum({
  invalidRequest: 'invalid request',
  notConfirmed: 'not confirmed',
  unknownProject: 'unknown project',
  alreadyConfigured: 'already configured',
  notGitRepository: 'not a git repository',
  noOrigin: 'no origin',
  tracksNodeModules: 'repo tracks node_modules',
  ignoresControlFiles: 'repo ignores Coherence hook files',
  npmInstallFailed: 'npm install failed',
  hooksInstallFailed: 'hooks install failed',
  pushRejected: 'push rejected',
  timedOut: 'timed out',
  failed: 'adopt failed',
});
export type CoherenceAdoptError = z.infer<typeof CoherenceAdoptError>;

const coherenceProjectId = z.string().min(1).max(128);

export const ProjectCoherenceAdoptRequest = z.object({
  projectId: coherenceProjectId,
  confirm: z.literal(true),
});
export type ProjectCoherenceAdoptRequest = z.infer<typeof ProjectCoherenceAdoptRequest>;

export const ProjectCoherenceAdoptResult = z.object({
  projectId: z.string().max(128),
  ok: z.boolean(),
  sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).optional(),
  error: CoherenceAdoptError.optional(),
  ignoredPaths: z.array(z.string().max(256)).max(16).optional(),
});
export type ProjectCoherenceAdoptResult = z.infer<typeof ProjectCoherenceAdoptResult>;

export const COHERENCE_CHECK_STAGE_IDS = Object.freeze([
  'setting', 'install', 'hooks-claude', 'hooks-codex', 'session-start', 'journal', 'next-action', 'readings', 'live-sessions',
] as const);
export const CoherenceCheckStageId = z.enum(COHERENCE_CHECK_STAGE_IDS);
export type CoherenceCheckStageId = z.infer<typeof CoherenceCheckStageId>;
export const COHERENCE_CHECK_DETAIL_MAX_CHARS = 300;

export const CoherenceCheckStage = z.strictObject({
  id: CoherenceCheckStageId,
  status: z.enum(['pass', 'fail', 'skip']),
  detail: z.string().min(1).max(COHERENCE_CHECK_DETAIL_MAX_CHARS),
});
export type CoherenceCheckStage = z.infer<typeof CoherenceCheckStage>;

export const ProjectCoherenceCheckRequest = z.object({ projectId: coherenceProjectId });
export type ProjectCoherenceCheckRequest = z.infer<typeof ProjectCoherenceCheckRequest>;

export const ProjectCoherenceCheckResult = z.object({
  projectId: z.string().max(128),
  ok: z.boolean(),
  stages: z.array(CoherenceCheckStage).max(COHERENCE_CHECK_STAGE_IDS.length),
  error: z.string().min(1).max(COHERENCE_CHECK_DETAIL_MAX_CHARS).optional(),
});
export type ProjectCoherenceCheckResult = z.infer<typeof ProjectCoherenceCheckResult>;

export const ProjectCoherenceStatus = z.strictObject({ configured: z.boolean() });
export type ProjectCoherenceStatus = z.infer<typeof ProjectCoherenceStatus>;
