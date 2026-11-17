import { z } from 'zod';

export const GithubIssue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
});

export type GithubIssue = z.infer<typeof GithubIssue>;
