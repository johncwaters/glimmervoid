import { z } from 'zod';
import { GithubPr } from './github-prs.ts';

export const MyPrsCandidatesPayload = z.object({
  observedAt: z.iso.datetime(),
  viewer: z.string().min(1),
  isComplete: z.boolean(),
  returnedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  open: z.array(GithubPr),
  merged: z.array(GithubPr),
}).strict();

export type MyPrsCandidatesPayload = z.infer<typeof MyPrsCandidatesPayload>;
