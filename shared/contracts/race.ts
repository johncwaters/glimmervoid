import { z } from 'zod';
import { AgentSetup } from './agent-models.ts';

const RACE_MIN_CONTESTANTS = 2;
export const RACE_MAX_CONTESTANTS = 5;
export const RACE_JUDGE_AGENT = 'claude-code';
export const RACE_MAX_JUDGES = 3;
export const RACE_CRITERIA = ['correctness', 'completeness', 'scope', 'quality'] as const;
export const RaceCriterion = z.enum(RACE_CRITERIA);
export type RaceCriterion = z.infer<typeof RaceCriterion>;

export const GitObjectSha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

export const RaceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export type RaceId = z.infer<typeof RaceId>;

export const RaceContestant = z.strictObject({
  id: RaceId,
  label: z.string().trim().min(1).max(60),
  setup: AgentSetup,
});
export type RaceContestant = z.infer<typeof RaceContestant>;

export const RaceCheck = z.strictObject({
  program: z.string().trim().min(1).max(200),
  args: z.array(z.string().max(2000)).max(40).default([]),
  timeoutSeconds: z.number().int().min(5).max(3600).default(600),
});
export type RaceCheck = z.infer<typeof RaceCheck>;

export const RaceJudge = z.strictObject({ setup: AgentSetup });
export type RaceJudge = z.infer<typeof RaceJudge>;

function foldLegacyJudge(spec: unknown): unknown {
  if (typeof spec !== 'object' || spec === null || !('judge' in spec) || 'judges' in spec) return spec;
  const { judge, ...rest } = spec;
  return { ...rest, judges: judge === null ? [] : [judge] };
}

export const RaceSpec = z.preprocess(foldLegacyJudge, z.strictObject({
  version: z.literal(1),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(20000),
  repoPath: z.string().trim().min(1),
  contestants: z.array(RaceContestant).min(RACE_MIN_CONTESTANTS).max(RACE_MAX_CONTESTANTS),
  judges: z.array(RaceJudge).max(RACE_MAX_JUDGES).default([]),
  check: RaceCheck.nullable().default(null),
  timeLimitMinutes: z.number().int().min(1).max(720).nullable().default(null),
}).refine((spec) => new Set(spec.contestants.map((contestant) => contestant.id)).size === spec.contestants.length, {
  error: 'contestant ids must be unique',
  path: ['contestants'],
}));
export type RaceSpec = z.infer<typeof RaceSpec>;

const RACE_PHASES = ['running', 'judging', 'judged'] as const;

export const DiffStats = z.strictObject({
  filesChanged: z.number().int().min(0),
  linesAdded: z.number().int().min(0),
  linesRemoved: z.number().int().min(0),
});
export type DiffStats = z.infer<typeof DiffStats>;

export const CheckOutcome = z.strictObject({
  status: z.enum(['passed', 'failed', 'unavailable']),
  exitCode: z.number().int().nullable(),
  reason: z.string().max(400).nullable(),
  durationMs: z.number().int().min(0),
  outputTail: z.string().max(4000),
});
export type CheckOutcome = z.infer<typeof CheckOutcome>;

export const ContestantMetrics = z.strictObject({
  elapsedMs: z.number().int().min(0).nullable(),
  tokens: z.number().int().min(0).nullable(),
  costUSD: z.number().min(0).nullable(),
  waits: z.number().int().min(0),
});
export type ContestantMetrics = z.infer<typeof ContestantMetrics>;

export const ContestantFinish = z.strictObject({
  status: z.enum(['finished', 'did-not-finish']),
  reason: z.string().max(400).nullable(),
});
export type ContestantFinish = z.infer<typeof ContestantFinish>;

const JudgeResult = z.strictObject({
  ranking: z.array(z.strictObject({
    contestantId: RaceId,
    rank: z.number().int().min(1),
    reason: z.string().trim().min(1).max(300),
  })).min(1),
  notes: z.record(RaceId, z.string().max(4000)),
});

const CriterionVerdict = z.strictObject({
  reason: z.string().trim().min(1).max(300),
  pass: z.boolean(),
});

export const ContestantVerdict = z.strictObject({
  criteria: z.record(RaceCriterion, CriterionVerdict),
  tier: z.number().int().min(1),
  notes: z.string().max(4000),
});
export type ContestantVerdict = z.infer<typeof ContestantVerdict>;

export const JudgeVerdict = z.strictObject({
  judge: z.strictObject({ agent: z.string().min(1), model: z.string().nullable(), label: z.string().max(60) }),
  contestants: z.record(RaceId, ContestantVerdict),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

export const CriterionStanding = z.enum(['pass', 'fail', 'split']);
export type CriterionStanding = z.infer<typeof CriterionStanding>;

export const PanelStanding = z.strictObject({
  contestantId: RaceId,
  rank: z.number().int().min(1),
  criteriaPassed: z.number().min(0).max(RACE_CRITERIA.length),
  criteria: z.record(RaceCriterion, CriterionStanding),
  meanTier: z.number().min(1),
  summary: z.string().max(300),
});
export type PanelStanding = z.infer<typeof PanelStanding>;

export const PanelResult = z.strictObject({
  verdicts: z.array(JudgeVerdict),
  failures: z.array(z.strictObject({ label: z.string().max(60), reason: z.string().max(400) })),
  standing: z.array(PanelStanding),
  firstPlaceAgreement: z.strictObject({ agreeing: z.number().int().min(0), judges: z.number().int().min(0) }),
});
export type PanelResult = z.infer<typeof PanelResult>;

export const RaceRecord = z.strictObject({
  id: RaceId,
  spec: RaceSpec,
  startSha: GitObjectSha,
  baseBranch: z.string().min(1),
  createdAt: z.number().finite(),
  sessionIdByContestant: z.record(RaceId, z.string().min(1)),
  phase: z.enum(RACE_PHASES).default('running'),
  diffStatsByContestant: z.record(RaceId, DiffStats).default({}),
  checkByContestant: z.record(RaceId, CheckOutcome).default({}),
  metricsByContestant: z.record(RaceId, ContestantMetrics).default({}),
  finishByContestant: z.record(RaceId, ContestantFinish).default({}),
  judge: JudgeResult.nullable().default(null),
  panel: PanelResult.nullable().default(null),
  judgeError: z.string().nullable().default(null),
  winnerContestantId: RaceId.nullable().default(null),
});
export type RaceRecord = z.infer<typeof RaceRecord>;
