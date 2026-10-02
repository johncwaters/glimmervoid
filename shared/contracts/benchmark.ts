import { z } from 'zod';
import { CommitSha } from './team-review.ts';

const BENCHMARK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const repoSlug = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const timestamp = z.number().finite();
const nonEmptyText = z.string().min(1);

export const BENCHMARK_INJECTED_ENV_NAMES = Object.freeze(['CLAUDE_CODE_OAUTH_TOKEN']);
export const BENCHMARK_REFERENCE_TAGS = Object.freeze(['human', 'bot'] as const);

export const BenchmarkId = z.string().regex(BENCHMARK_ID_RE);
export type BenchmarkId = z.infer<typeof BenchmarkId>;

function hasUniqueIds(entries: readonly { id: string }[]): boolean {
  return new Set(entries.map((entry) => entry.id)).size === entries.length;
}

export const BenchmarkCaseSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({
    kind: z.literal('github-merged-prs'),
    repo: repoSlug,
    minBodies: z.number().int().min(1),
    limit: z.number().int().min(1).max(500),
  }),
]);
export type BenchmarkCaseSource = z.infer<typeof BenchmarkCaseSource>;

export const BenchmarkWorkspace = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('pr-checkout') }),
]);
export type BenchmarkWorkspace = z.infer<typeof BenchmarkWorkspace>;

export const BenchmarkSubjectOutput = z.enum(['review-findings', 'json']);
export type BenchmarkSubjectOutput = z.infer<typeof BenchmarkSubjectOutput>;

export const BenchmarkSubject = z.strictObject({
  promptTemplate: nonEmptyText,
  output: BenchmarkSubjectOutput,
  timeoutSeconds: z.number().int().min(30).max(4 * 60 * 60),
});
export type BenchmarkSubject = z.infer<typeof BenchmarkSubject>;

export const BenchmarkArm = z.strictObject({
  id: BenchmarkId,
  env: z.record(z.string().regex(ENV_NAME_RE), z.string())
    .refine((env) => BENCHMARK_INJECTED_ENV_NAMES.every((name) => !Object.hasOwn(env, name)), {
      message: `arm env must not set ${BENCHMARK_INJECTED_ENV_NAMES.join(', ')}; Glimmervoid injects it per cell`,
    })
    .optional(),
  extraArgs: z.array(z.string()).optional(),
  setup: z.strictObject({ command: z.array(nonEmptyText).min(1) }).optional(),
});
export type BenchmarkArm = z.infer<typeof BenchmarkArm>;

export const BenchmarkScorer = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('llm-judge-match'), model: nonEmptyText }),
]);
export type BenchmarkScorer = z.infer<typeof BenchmarkScorer>;

export const BenchmarkSuite = z.strictObject({
  id: BenchmarkId,
  title: nonEmptyText,
  caseSource: BenchmarkCaseSource,
  workspace: BenchmarkWorkspace,
  subject: BenchmarkSubject,
  arms: z.array(BenchmarkArm).min(2).refine(hasUniqueIds, { message: 'arm ids must be unique' }),
  baselineArm: BenchmarkId,
  trials: z.number().int().min(1).max(20),
  scorer: BenchmarkScorer,
}).refine((suite) => suite.arms.some((arm) => arm.id === suite.baselineArm), {
  message: 'baselineArm must name one of the arms',
  path: ['baselineArm'],
});
export type BenchmarkSuite = z.infer<typeof BenchmarkSuite>;

export const BenchmarkReference = z.strictObject({
  id: BenchmarkId,
  text: nonEmptyText,
  tags: z.array(BenchmarkId),
  path: nonEmptyText.optional(),
  line: z.number().int().positive().optional(),
});
export type BenchmarkReference = z.infer<typeof BenchmarkReference>;

export const BenchmarkCaseOrigin = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({
    kind: z.literal('github-pr'),
    repo: repoSlug,
    number: z.number().int().positive(),
    url: nonEmptyText,
    minedAt: timestamp,
  }),
]);
export type BenchmarkCaseOrigin = z.infer<typeof BenchmarkCaseOrigin>;

export const BenchmarkCase = z.strictObject({
  id: BenchmarkId,
  input: z.record(z.string(), z.unknown()),
  references: z.array(BenchmarkReference).min(1).refine(hasUniqueIds, { message: 'reference ids must be unique' }),
  source: BenchmarkCaseOrigin,
});
export type BenchmarkCase = z.infer<typeof BenchmarkCase>;

export const PrCheckoutCaseInput = z.object({
  repo: repoSlug,
  number: z.number().int().positive(),
  reviewedSha: CommitSha,
  baseSha: CommitSha,
  changedFiles: z.array(nonEmptyText),
});
export type PrCheckoutCaseInput = z.infer<typeof PrCheckoutCaseInput>;

export const BenchmarkMatchVerdict = z.enum(['found', 'partial', 'missed']);
export type BenchmarkMatchVerdict = z.infer<typeof BenchmarkMatchVerdict>;

export const BenchmarkJudgement = z.strictObject({
  referenceId: BenchmarkId,
  verdict: BenchmarkMatchVerdict,
  findingIndexes: z.array(z.number().int().nonnegative()),
});
export type BenchmarkJudgement = z.infer<typeof BenchmarkJudgement>;

export const BenchmarkCellStatus = z.enum(['scored', 'invalid', 'error']);
export type BenchmarkCellStatus = z.infer<typeof BenchmarkCellStatus>;

export const BenchmarkCellResult = z.strictObject({
  caseId: BenchmarkId,
  armId: BenchmarkId,
  trial: z.number().int().min(1),
  status: BenchmarkCellStatus,
  startedAt: timestamp,
  finishedAt: timestamp,
  degradedReasons: z.array(nonEmptyText),
  findingCount: z.number().int().nonnegative(),
  judgements: z.array(BenchmarkJudgement),
  costUsd: z.number().finite().nonnegative().nullable(),
  error: nonEmptyText.nullable(),
});
export type BenchmarkCellResult = z.infer<typeof BenchmarkCellResult>;

export const BenchmarkRunStatus = z.enum(['running', 'completed', 'interrupted', 'failed']);
export type BenchmarkRunStatus = z.infer<typeof BenchmarkRunStatus>;

export const BenchmarkRun = z.strictObject({
  id: BenchmarkId,
  suiteId: BenchmarkId,
  status: BenchmarkRunStatus,
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  error: nonEmptyText.nullable(),
  cells: z.array(BenchmarkCellResult),
});
export type BenchmarkRun = z.infer<typeof BenchmarkRun>;

const nullableRatio = z.number().min(0).max(1).nullable();

export const BenchmarkArmScore = z.strictObject({
  trials: z.number().int().nonnegative(),
  recall: nullableRatio,
  recallByTag: z.record(BenchmarkId, nullableRatio),
  degraded: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative().nullable(),
});
export type BenchmarkArmScore = z.infer<typeof BenchmarkArmScore>;

export const BenchmarkReportRow = z.strictObject({
  caseId: BenchmarkId,
  arms: z.record(BenchmarkId, BenchmarkArmScore),
  deltaVsBaseline: z.record(BenchmarkId, z.number().min(-1).max(1).nullable()),
});
export type BenchmarkReportRow = z.infer<typeof BenchmarkReportRow>;

export const BenchmarkReport = z.strictObject({
  runId: BenchmarkId,
  suiteId: BenchmarkId,
  status: BenchmarkRunStatus,
  baselineArm: BenchmarkId,
  armIds: z.array(BenchmarkId),
  rows: z.array(BenchmarkReportRow),
  totals: z.record(BenchmarkId, BenchmarkArmScore),
});
export type BenchmarkReport = z.infer<typeof BenchmarkReport>;

export const BenchmarkAction = z.enum(['mine', 'run', 'cancel']);
export type BenchmarkAction = z.infer<typeof BenchmarkAction>;

export const BenchmarkActionRequest = z.object({
  suiteId: BenchmarkId,
  action: BenchmarkAction,
});
export type BenchmarkActionRequest = z.infer<typeof BenchmarkActionRequest>;

export const BenchmarkActionResult = z.object({
  suiteId: BenchmarkId,
  action: BenchmarkAction,
  ok: z.boolean(),
  error: z.string().optional(),
  runId: BenchmarkId.optional(),
});
export type BenchmarkActionResult = z.infer<typeof BenchmarkActionResult>;

export const BenchmarkCellPhase = z.enum(['setup', 'preflight', 'workspace', 'subject', 'judge']);
export type BenchmarkCellPhase = z.infer<typeof BenchmarkCellPhase>;

export const BenchmarkInFlightCell = z.object({
  suiteId: BenchmarkId,
  runId: BenchmarkId,
  caseId: BenchmarkId.nullable(),
  armId: BenchmarkId,
  trial: z.number().int().min(1),
  phase: BenchmarkCellPhase,
  cellIndex: z.number().int().nonnegative(),
  cellCount: z.number().int().positive(),
  startedAt: timestamp,
});
export type BenchmarkInFlightCell = z.infer<typeof BenchmarkInFlightCell>;

export const BenchmarkSuiteSummary = z.object({
  id: BenchmarkId,
  title: z.string(),
  error: z.string().nullable(),
  caseCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  armIds: z.array(BenchmarkId),
  baselineArm: BenchmarkId.nullable(),
  latestReport: BenchmarkReport.nullable(),
});
export type BenchmarkSuiteSummary = z.infer<typeof BenchmarkSuiteSummary>;

export const BenchmarkStatus = z.object({
  type: z.literal('benchmark-status'),
  ts: timestamp,
  configured: z.boolean(),
  reason: z.string().nullable(),
  suites: z.array(BenchmarkSuiteSummary),
  inFlight: BenchmarkInFlightCell.nullable(),
}).passthrough();
export type BenchmarkStatus = z.infer<typeof BenchmarkStatus>;

const githubAuthor = z.object({ __typename: z.string(), login: z.string() }).nullable();

export const MergedPrListing = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: nonEmptyText,
  mergedAt: z.string().nullable(),
  reviewThreads: z.object({ totalCount: z.number().int().nonnegative() }),
  reviews: z.object({ totalCount: z.number().int().nonnegative() }),
});
export type MergedPrListing = z.infer<typeof MergedPrListing>;

export const MinedReviewThread = z.object({
  path: z.string(),
  line: z.number().int().positive().nullable(),
  originalLine: z.number().int().positive().nullable(),
  comments: z.object({
    nodes: z.array(z.object({
      databaseId: z.number().int().positive(),
      author: githubAuthor,
      body: z.string(),
      createdAt: z.string(),
      originalCommit: z.object({ oid: CommitSha }).nullable(),
    })),
  }),
});
export type MinedReviewThread = z.infer<typeof MinedReviewThread>;

export const MinedReview = z.object({
  databaseId: z.number().int().positive(),
  author: githubAuthor,
  body: z.string(),
  submittedAt: z.string().nullable(),
  commit: z.object({ oid: CommitSha }).nullable(),
});
export type MinedReview = z.infer<typeof MinedReview>;

export const MinedBaseEvent = z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('BaseRefChangedEvent'), createdAt: z.string() }),
  z.object({
    __typename: z.literal('BaseRefForcePushedEvent'),
    createdAt: z.string(),
    beforeCommit: z.object({ oid: CommitSha }).nullable(),
  }),
]);
export type MinedBaseEvent = z.infer<typeof MinedBaseEvent>;

export const MinedPrReviewData = z.object({
  author: githubAuthor,
  baseRefOid: CommitSha,
  reviewThreads: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(MinedReviewThread) }),
  reviews: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(MinedReview) }),
  timelineItems: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(MinedBaseEvent) }),
});
export type MinedPrReviewData = z.infer<typeof MinedPrReviewData>;

export const CommitComparison = z.object({
  mergeBaseSha: CommitSha,
  changedFiles: z.array(nonEmptyText),
  isFileListComplete: z.boolean(),
});
export type CommitComparison = z.infer<typeof CommitComparison>;
