import { z } from 'zod';
import { GithubPr } from './github-prs.ts';

export const TeamReviewCandidatesPayload = z.object({
  observedAt: z.iso.datetime(),
  viewer: z.string().min(1),
  isComplete: z.boolean(),
  directRequested: z.array(GithubPr),
  teamRequested: z.array(GithubPr),
  authored: z.array(GithubPr),
}).strict();

export type TeamReviewCandidatesPayload = z.infer<typeof TeamReviewCandidatesPayload>;
