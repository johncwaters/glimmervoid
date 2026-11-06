import { z } from 'zod';
import { AgentSetup } from './agent-models.ts';

const RACE_MIN_CONTESTANTS = 2;
export const RACE_MAX_CONTESTANTS = 5;
export const RACE_JUDGE_AGENT = 'claude-code';

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

export const RaceSpec = z.strictObject({
  version: z.literal(1),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(20000),
  repoPath: z.string().trim().min(1),
  contestants: z.array(RaceContestant).min(RACE_MIN_CONTESTANTS).max(RACE_MAX_CONTESTANTS),
  judge: z.strictObject({ setup: AgentSetup }).nullable(),
  check: RaceCheck.nullable().default(null),
}).refine((spec) => new Set(spec.contestants.map((contestant) => contestant.id)).size === spec.contestants.length, {
  error: 'contestant ids must be unique',
  path: ['contestants'],
});
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

export const JudgeResult = z.strictObject({
  ranking: z.array(z.strictObject({
    contestantId: RaceId,
    rank: z.number().int().min(1),
    reason: z.string().trim().min(1).max(300),
  })).min(1),
  notes: z.record(RaceId, z.string().max(4000)),
});
export type JudgeResult = z.infer<typeof JudgeResult>;

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
  judge: JudgeResult.nullable().default(null),
  judgeError: z.string().nullable().default(null),
  winnerContestantId: RaceId.nullable().default(null),
});
export type RaceRecord = z.infer<typeof RaceRecord>;
