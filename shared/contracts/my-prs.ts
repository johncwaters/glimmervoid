import { z } from 'zod';

export const MyPrStage = z.enum(['merged', 'draft', 'conflicts', 'behind', 'checks-failing', 'changes-requested', 'unresolved-threads', 'checks-pending', 'needs-approval', 'ready', 'unknown']);
export type MyPrStage = z.infer<typeof MyPrStage>;

const nonnegativeInteger = z.number().int().nonnegative();
const repositoryName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const MyPrThread = z.object({
  path: z.string(), line: z.number().int().positive().nullable(), isOutdated: z.boolean(), url: z.url(),
  author: z.string().nullable(), excerpt: z.string(), commentCount: z.number().int().positive(),
  lastAuthor: z.string().nullable(), lastActivityAt: z.string(),
});
export type MyPrThread = z.infer<typeof MyPrThread>;

export const MyPrReview = z.object({ reviewer: z.string().nullable(), state: z.string(), submittedAt: z.string().nullable() });
export type MyPrReview = z.infer<typeof MyPrReview>;

export const MyPrAutoRebase = z.object({ outcome: z.enum(['rebased', 'failed']), at: z.number().finite(), message: z.string() });
export type MyPrAutoRebase = z.infer<typeof MyPrAutoRebase>;

export const MyPr = z.object({
  key: z.string(), repo: repositoryName, number: z.number().int().positive(), title: z.string(), url: z.url(),
  isDraft: z.boolean(), state: z.enum(['OPEN', 'MERGED', 'CLOSED']), createdAt: z.string(), mergedAt: z.string().nullable(), updatedAt: z.string(),
  baseRefName: z.string(), mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']), mergeStateStatus: z.string(),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  checks: z.object({ state: z.enum(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']).nullable(), failing: z.array(z.string()), pendingCount: nonnegativeInteger }),
  unresolvedThreads: nonnegativeInteger, threads: z.array(MyPrThread), behindBy: nonnegativeInteger.nullable(),
  reviewRequests: z.array(z.object({ name: z.string(), isTeam: z.boolean(), avatarUrl: z.string().nullable() })),
  approvals: nonnegativeInteger, reviews: z.array(MyPrReview), stage: MyPrStage, autoRebase: MyPrAutoRebase.optional(),
}).refine((pr) => pr.key === `${pr.repo}#${pr.number}`);
export type MyPr = z.infer<typeof MyPr>;

export const MyPrsStatus = z.object({
  type: z.literal('my-prs-status'), ts: z.number().finite(), configured: z.boolean(), reason: z.string().nullable().optional(),
  viewer: z.string().nullable(), prs: z.array(MyPr), error: z.string().nullable().optional(), truncatedNote: z.string().nullable().optional(),
}).passthrough();
export type MyPrsStatus = z.infer<typeof MyPrsStatus>;

const CheckRun = z.object({ __typename: z.literal('CheckRun'), name: z.string(), conclusion: z.string().nullable(), status: z.string() });
const StatusContext = z.object({ __typename: z.literal('StatusContext'), context: z.string(), state: z.string() });
export const MyPrSearchNode = z.object({
  __typename: z.literal('PullRequest'), id: z.string().regex(/^[A-Za-z0-9_=-]+$/), number: z.number().int().positive(), title: z.string(), url: z.url(), isDraft: z.boolean(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']), createdAt: z.string(), mergedAt: z.string().nullable(), updatedAt: z.string(), baseRefName: z.string(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/), isInMergeQueue: z.boolean(), mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  mergeStateStatus: z.string(), reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  repository: z.object({ nameWithOwner: repositoryName }),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({
    state: z.enum(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']).nullable(),
    contexts: z.object({ nodes: z.array(z.union([CheckRun, StatusContext])) }),
  }).nullable() }) })) }),
  reviewThreads: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(z.object({ isResolved: z.boolean() })) }),
  reviewRequests: z.object({ nodes: z.array(z.object({ requestedReviewer: z.discriminatedUnion('__typename', [
    z.object({ __typename: z.literal('User'), login: z.string() }),
    z.object({ __typename: z.literal('Team'), slug: z.string(), avatarUrl: z.string().nullable(), organization: z.object({ login: z.string() }) }),
    z.object({ __typename: z.enum(['Bot', 'Mannequin']) }),
  ]).nullable() })) }),
  latestOpinionatedReviews: z.object({ nodes: z.array(z.object({ state: z.string() })) }),
  latestReviews: z.object({ nodes: z.array(z.object({ state: z.string(), submittedAt: z.string().nullable(), author: z.object({ login: z.string() }).nullable() })) }),
});
export type MyPrSearchNode = z.infer<typeof MyPrSearchNode>;

const ThreadCommentAuthor = z.object({ login: z.string() }).nullable();
export const MyPrThreadNode = z.object({
  isResolved: z.boolean(), isOutdated: z.boolean(), path: z.string(), line: z.number().int().positive().nullable(),
  firstComment: z.object({ totalCount: nonnegativeInteger, nodes: z.array(z.object({ author: ThreadCommentAuthor, bodyText: z.string(), url: z.url(), createdAt: z.string() })) }),
  lastComment: z.object({ nodes: z.array(z.object({ author: ThreadCommentAuthor, createdAt: z.string() })) }),
});
export type MyPrThreadNode = z.infer<typeof MyPrThreadNode>;

export const MyPrThreadsResponse = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({
  reviewThreads: z.object({ pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }), nodes: z.array(z.unknown()) }),
}).nullable() }).nullable() }), errors: z.array(z.unknown()).optional() });

export const MyPrSearchResponse = z.object({ data: z.object({
  open: z.object({ issueCount: nonnegativeInteger, nodes: z.array(z.unknown()) }), merged: z.object({ issueCount: nonnegativeInteger, nodes: z.array(z.unknown()) }),
}), errors: z.array(z.unknown()).optional() });
