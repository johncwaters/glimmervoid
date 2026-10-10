import { z } from 'zod';
import { SessionState } from './session.ts';
import { CoherenceOrient, CoherenceReadiness, CoherenceRisk, CoherenceWorkState } from './coherence.ts';

export const FactoryIssue = z.object({ issueId: z.string().min(1), firstSeenMs: z.number().finite(), framePaths: z.array(z.string()) });
export type FactoryIssue = z.infer<typeof FactoryIssue>;

export const FactoryWatchEntry = z.object({
  workId: z.string().min(1), intentId: z.string().min(1), projectId: z.string().min(1),
  mergedSha: z.string().regex(/^[a-f0-9]{40,64}$/), mergedAt: z.iso.datetime(), writeScopes: z.array(z.string()),
  breaches: z.array(FactoryIssue).optional(),
});
export type FactoryWatchEntry = z.infer<typeof FactoryWatchEntry>;

export const FactoryHogQLResponse = z.looseObject({ results: z.array(z.unknown()) });

export const FactoryIssueQueryRow = z.object({
  issueId: z.string().min(1), firstSeen: z.string().min(1), framePaths: z.array(z.string()),
});

export const FactoryConsequences = z.looseObject({
  records: z.array(z.looseObject({ from: z.object({ kind: z.string(), id: z.string() }), relation: z.string(), to: z.object({ kind: z.string(), id: z.string() }), session: z.string().optional(), evidence: z.string().optional() })),
});

export const FactoryProjectState = z.object({
  projectId: z.string(),
  projectName: z.string(),
  headSha: z.string().nullable(),
  paused: z.boolean(),
  orchestrator: z.object({ sessionId: z.string(), intentId: z.string(), state: SessionState }).nullable(),
  liveWorkers: z.array(z.object({ workId: z.string(), sessionId: z.string() })).optional(),
  reviewing: z.array(z.string()).optional(),
  watches: z.array(FactoryWatchEntry).optional(),
  note: z.string().nullable().optional(),
  spentTodayUsd: z.number().finite().nonnegative().optional(),
  dailyBudgetUsd: z.number().finite().nonnegative().nullable().optional(),
  verifierIntentIds: z.array(z.string()).optional(),
  error: z.string().nullable(),
  heading: z.object({ action: CoherenceOrient.shape.action, reasons: z.array(z.string()) }),
  orders: z.array(z.object({
    id: z.string(),
    objective: z.string(),
    openedAt: z.iso.datetime(),
    criteria: z.array(z.string()),
    boundary: z.string(),
    risk: CoherenceRisk,
    state: CoherenceWorkState,
    readiness: CoherenceReadiness,
    parent: z.string().nullable(),
    dependsOn: z.array(z.string()),
    writeScopes: z.array(z.string()),
    owner: z.string().nullable(),
    lastEvent: z.object({ event: z.string(), at: z.string(), session: z.string() }).nullable(),
  })),
  conflicts: z.array(z.object({ left: z.string(), right: z.string(), scope: z.string() })),
  unverifiedCompletedWork: z.array(z.string()),
});
export type FactoryProjectState = z.infer<typeof FactoryProjectState>;

export const FactoryState = z.object({
  type: z.literal('factory-state'),
  ts: z.number().finite(),
  projects: z.array(FactoryProjectState),
});
export type FactoryState = z.infer<typeof FactoryState>;

export const FACTORY_ERROR_MAX_CHARS = 16_384;

const projectId = z.string().trim().min(1).max(128).refine((value) => value !== '.' && value !== '..' && !/[/\\]/.test(value), 'Invalid factory project id');
const intentText = z.string().trim().min(1).max(4096);
const scopeText = z.string().trim().min(1).max(1024);

export const FactoryQueueIntentRequest = z.object({
  projectId,
  objective: intentText,
  criteria: z.array(intentText).min(1).max(12),
  risk: CoherenceRisk,
  boundary: intentText,
  writeScopes: z.array(scopeText).max(32),
});
export type FactoryQueueIntentRequest = z.infer<typeof FactoryQueueIntentRequest>;

export const FactoryQueueIntentResult = z.object({
  projectId: z.string().max(128),
  ok: z.boolean(),
  workId: z.string().min(1).max(128).optional(),
  error: z.string().max(FACTORY_ERROR_MAX_CHARS).optional(),
});
export type FactoryQueueIntentResult = z.infer<typeof FactoryQueueIntentResult>;

export const FactoryControlRequest = z.object({ projectId, action: z.enum(['pause', 'resume']) });
export type FactoryControlRequest = z.infer<typeof FactoryControlRequest>;

export const FactoryControlResult = z.object({
  projectId: z.string().max(128),
  action: FactoryControlRequest.shape.action,
  ok: z.boolean(),
  error: z.string().max(FACTORY_ERROR_MAX_CHARS).optional(),
});
export type FactoryControlResult = z.infer<typeof FactoryControlResult>;

export const FactoryReviewVerdict = z.object({ pass: z.boolean(), findings: z.array(z.string()) }).strict();
export type FactoryReviewVerdict = z.infer<typeof FactoryReviewVerdict>;

export const FactoryReviewerOutput = z.object({
  type: z.literal('result'), subtype: z.literal('success'), is_error: z.literal(false), structured_output: FactoryReviewVerdict,
});

export const FactoryLaneState = z.object({
  ledgerPath: z.string().min(1).max(4096).nullable(),
  ledgerBranch: z.string().min(1).max(1024).nullable(),
  paused: z.boolean(),
  watch: z.array(FactoryWatchEntry).optional(),
  trustedVerifications: z.array(z.object({ id: z.string().min(1), sha: z.string().regex(/^[a-f0-9]{40,64}$/) })).optional(),
  trustedIntentCloses: z.array(z.string().min(1)).optional(),
  trustedIntentIds: z.array(z.string().min(1)).optional(),
});
export type FactoryLaneState = z.infer<typeof FactoryLaneState>;

export const FactoryWorkerEvent = z.object({
  workId: z.string().min(1),
  event: z.string().min(1),
  sessionId: z.string().optional(),
  detail: z.string().optional(),
});
export type FactoryWorkerEvent = z.infer<typeof FactoryWorkerEvent>;

export const FactoryDispatchResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), sessionId: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type FactoryDispatchResult = z.infer<typeof FactoryDispatchResult>;
