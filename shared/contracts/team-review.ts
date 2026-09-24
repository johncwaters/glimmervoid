import { z } from 'zod';

export const CommitSha = z.string().regex(/^[0-9a-f]{40}$/);
const repoSlug = z.string().regex(/^[^/]+\/[^/]+$/);

export const SearchedPr = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  draft: z.boolean().optional(),
  repository_url: z.string(),
  user: z.object({ login: z.string(), type: z.enum(['User', 'Bot']) }).passthrough(),
  pull_request: z.object({}).passthrough(),
}).passthrough();
export type SearchedPr = z.infer<typeof SearchedPr>;

export const PrDetail = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  author: z.object({ login: z.string(), is_bot: z.boolean().optional() }).passthrough(),
  isDraft: z.boolean(),
  isCrossRepository: z.boolean(),
  baseRefName: z.string(),
  baseRefOid: CommitSha,
  headRefOid: CommitSha,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  files: z.array(z.object({
    path: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }).passthrough()),
}).passthrough();
export type PrDetail = z.infer<typeof PrDetail>;

export const ReviewComment = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  side: z.enum(['RIGHT', 'LEFT']).default('RIGHT'),
  body: z.string(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

const reviewVerdict = z.enum(['STAMP', 'COMMENT', 'NEEDS_YOU']);

export const ReviewResult = z.object({
  verdict: reviewVerdict,
  head: CommitSha,
  summary: z.string(),
  body: z.string(),
  comments: z.array(ReviewComment),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

export const ReviewDraft = z.object({
  key: z.string(),
  repo: repoSlug,
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  tier: z.enum(['stamp', 'full']),
  reasons: z.array(z.string()),
  reviewedHead: CommitSha,
  verdict: reviewVerdict,
  summary: z.string(),
  body: z.string(),
  comments: z.array(ReviewComment),
  status: z.enum(['ready', 'stale', 'posted', 'discarded', 'error']),
  error: z.string().optional(),
});
export type ReviewDraft = z.infer<typeof ReviewDraft>;

export const TeamReviewAction = z.enum(['approve', 'comment', 'discard']);
export type TeamReviewAction = z.infer<typeof TeamReviewAction>;

export const TeamReviewActionRequest = z.object({
  key: z.string().min(1),
  head: CommitSha,
  action: TeamReviewAction,
  body: z.string(),
  comments: z.array(ReviewComment),
});
export type TeamReviewActionRequest = z.infer<typeof TeamReviewActionRequest>;

export const TeamReviewActionResult = z.object({
  key: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  warning: z.string().optional(),
});
export type TeamReviewActionResult = z.infer<typeof TeamReviewActionResult>;

export const TeamReviewStateEntry = z.object({
  draft: ReviewDraft.nullable(),
  reviewedHead: CommitSha.nullable(),
  inFlight: z.boolean(),
  skipReason: z.string().nullable(),
  reviewAttempts: z.number().int().nonnegative().default(0),
  updatedAt: z.number().finite(),
});
export type TeamReviewStateEntry = z.infer<typeof TeamReviewStateEntry>;

export const TeamReviewState = z.record(z.string(), TeamReviewStateEntry);
export type TeamReviewState = z.infer<typeof TeamReviewState>;

export const TeamReviewStatus = z.object({
  type: z.literal('team-review-status'),
  ts: z.number().finite(),
  configured: z.boolean(),
  reason: z.string().nullable().optional(),
  drafts: z.array(ReviewDraft),
  inFlight: z.array(z.string()),
}).passthrough();
export type TeamReviewStatus = z.infer<typeof TeamReviewStatus>;
