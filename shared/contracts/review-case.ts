import { z } from 'zod';
import { CommitSha } from './team-review.ts';

export const repoSlug = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const timestamp = z.number().finite();
const nonEmptyText = z.string().min(1);

export const ReviewCaseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export type ReviewCaseId = z.infer<typeof ReviewCaseId>;

function hasUniqueIds(entries: readonly { id: string }[]): boolean {
  return new Set(entries.map((entry) => entry.id)).size === entries.length;
}

export const ReviewReference = z.strictObject({
  id: ReviewCaseId,
  text: nonEmptyText,
  tags: z.array(ReviewCaseId),
  path: nonEmptyText.optional(),
  line: z.number().int().positive().optional(),
});
export type ReviewReference = z.infer<typeof ReviewReference>;

const ReviewCaseOrigin = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({
    kind: z.literal('github-pr'),
    repo: repoSlug,
    number: z.number().int().positive(),
    url: nonEmptyText,
    minedAt: timestamp,
  }),
]);

export const ReviewCase = z.strictObject({
  id: ReviewCaseId,
  input: z.record(z.string(), z.unknown()),
  references: z.array(ReviewReference).min(1).refine(hasUniqueIds, { message: 'reference ids must be unique' }),
  source: ReviewCaseOrigin,
});
export type ReviewCase = z.infer<typeof ReviewCase>;

export const PrCheckoutCaseInput = z.object({
  repo: repoSlug,
  number: z.number().int().positive(),
  reviewedSha: CommitSha,
  baseSha: CommitSha,
  changedFiles: z.array(nonEmptyText),
});
export type PrCheckoutCaseInput = z.infer<typeof PrCheckoutCaseInput>;

export const MatchVerdict = z.enum(['found', 'partial', 'missed']);
export type MatchVerdict = z.infer<typeof MatchVerdict>;

export const Judgement = z.strictObject({
  referenceId: ReviewCaseId,
  verdict: MatchVerdict,
  findingIndexes: z.array(z.number().int().nonnegative()),
});
export type Judgement = z.infer<typeof Judgement>;

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

const MinedReview = z.object({
  databaseId: z.number().int().positive(),
  author: githubAuthor,
  body: z.string(),
  submittedAt: z.string().nullable(),
  commit: z.object({ oid: CommitSha }).nullable(),
});

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
