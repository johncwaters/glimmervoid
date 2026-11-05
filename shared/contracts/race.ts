import { z } from 'zod';
import { AgentSetup } from './agent-models.ts';

const RACE_MIN_CONTESTANTS = 2;
export const RACE_MAX_CONTESTANTS = 5;

export const GitObjectSha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

export const RaceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export type RaceId = z.infer<typeof RaceId>;

export const RaceContestant = z.strictObject({
  id: RaceId,
  label: z.string().trim().min(1).max(60),
  setup: AgentSetup,
});
export type RaceContestant = z.infer<typeof RaceContestant>;

export const RaceSpec = z.strictObject({
  version: z.literal(1),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(20000),
  repoPath: z.string().trim().min(1),
  contestants: z.array(RaceContestant).min(RACE_MIN_CONTESTANTS).max(RACE_MAX_CONTESTANTS),
  judge: z.strictObject({ setup: AgentSetup }).nullable(),
}).refine((spec) => new Set(spec.contestants.map((contestant) => contestant.id)).size === spec.contestants.length, {
  error: 'contestant ids must be unique',
  path: ['contestants'],
});
export type RaceSpec = z.infer<typeof RaceSpec>;

export const RaceRecord = z.strictObject({
  id: RaceId,
  spec: RaceSpec,
  startSha: GitObjectSha,
  baseBranch: z.string().min(1),
  createdAt: z.number().finite(),
  sessionIdByContestant: z.record(RaceId, z.string().min(1)),
});
export type RaceRecord = z.infer<typeof RaceRecord>;
