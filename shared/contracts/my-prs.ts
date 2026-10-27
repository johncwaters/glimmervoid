import { githubPollingShape } from './github-polling.ts';
import { z } from 'zod';
import { CommitSha } from './team-review.ts';
import { NODE_ID_RE, REPO_SLUG_RE } from './github-ids.ts';

export const MyPrStage = z.enum(['merged', 'draft', 'conflicts', 'behind', 'checks-failing', 'changes-requested', 'unresolved-threads', 'checks-pending', 'needs-approval', 'ready', 'unknown']);
export type MyPrStage = z.infer<typeof MyPrStage>;

const nonnegativeInteger = z.number().int().nonnegative();
export const repositoryName = z.string().regex(REPO_SLUG_RE);
const pullRequestNumberText = z.string().regex(/^[1-9][0-9]*$/);
export const pullRequestKeyFormat = z.templateLiteral([repositoryName, '#', pullRequestNumberText]);
const keepMergeableAttemptKeyFormat = z.templateLiteral([pullRequestKeyFormat, '@', CommitSha]);
const pullRequestKey = z.string().refine((value) => pullRequestKeyFormat.safeParse(value).success);
const keepMergeableAttemptKey = z.string().refine((value) => keepMergeableAttemptKeyFormat.safeParse(value).success);

export const MyPrMergeabilityFixResult = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('pushed') }),
  z.strictObject({ outcome: z.enum(['no-change', 'failed', 'stopped', 'timed-out']), reason: z.string().min(1) }),
]);
export type MyPrMergeabilityFixResult = z.infer<typeof MyPrMergeabilityFixResult>;

const MyPrKeepMergeableAttempt = z.strictObject({
  outcome: z.enum(['pushed', 'no-change', 'failed', 'stopped', 'timed-out']), reason: z.string().min(1).optional(), at: z.number().finite(),
});

export const MyPrKeepMergeableAttemptRecord = MyPrKeepMergeableAttempt.extend({ key: pullRequestKey, headRefOid: CommitSha, baseRefOid: CommitSha, consecutiveAttempts: z.number().int().min(1).optional() });
export type MyPrKeepMergeableAttemptRecord = z.infer<typeof MyPrKeepMergeableAttemptRecord>;

export const MyPrsState = z.strictObject({
  keepMergeableKeys: z.array(pullRequestKey),
  keepMergeableAttemptKeys: z.array(keepMergeableAttemptKey),
  keepMergeableAttempts: z.array(MyPrKeepMergeableAttemptRecord).default([]),
  mergeQueueKeys: z.array(pullRequestKey).default([]),
  keepMergeablePushedHeadKeys: z.array(keepMergeableAttemptKey).default([]),
});
export type MyPrsState = z.infer<typeof MyPrsState>;

export const SESSION_PR_LINKS_MAX = 20;

export const LinkedPr = z.strictObject({
  repo: repositoryName, number: z.number().int().positive(), url: z.url(), source: z.enum(['hook', 'sha', 'manual']), linkedAt: z.number().finite(),
});
export type LinkedPr = z.infer<typeof LinkedPr>;

export const SessionPrLinks = z.strictObject({
  links: z.array(LinkedPr).max(SESSION_PR_LINKS_MAX),
  unlinkedKeys: z.array(pullRequestKey).default([]),
});
export type SessionPrLinks = z.infer<typeof SessionPrLinks>;

export const MyPrKeepMergeableRequest = z.object({ repo: repositoryName, number: z.number().int().positive(), keepMergeable: z.boolean() });
export type MyPrKeepMergeableRequest = z.infer<typeof MyPrKeepMergeableRequest>;

const MyPrToggleResult = z.object({ key: z.string(), ok: z.boolean(), error: z.string().optional() });

export const MyPrKeepMergeableResult = MyPrToggleResult;
export type MyPrKeepMergeableResult = z.infer<typeof MyPrKeepMergeableResult>;

export const MyPrMergeWhenReadyRequest = z.object({ repo: repositoryName, number: z.number().int().positive(), mergeWhenReady: z.boolean() });
export type MyPrMergeWhenReadyRequest = z.infer<typeof MyPrMergeWhenReadyRequest>;

export const MyPrMergeWhenReadyResult = MyPrToggleResult;
export type MyPrMergeWhenReadyResult = z.infer<typeof MyPrMergeWhenReadyResult>;

export const MyPrMergeMethod = z.enum(['MERGE', 'SQUASH', 'REBASE']);
export type MyPrMergeMethod = z.infer<typeof MyPrMergeMethod>;

export const MyPrThread = z.object({
  path: z.string(), line: z.number().int().positive().nullable(), isOutdated: z.boolean(), url: z.url(),
  author: z.string().nullable(), excerpt: z.string(), commentCount: z.number().int().positive(),
  lastAuthor: z.string().nullable(), lastActivityAt: z.string(),
});
export type MyPrThread = z.infer<typeof MyPrThread>;

const MyPrReview = z.object({ reviewer: z.string().nullable(), state: z.string(), submittedAt: z.string().nullable() });

export const MyPrAutoRebase = z.object({ outcome: z.enum(['rebased', 'failed']), at: z.number().finite(), message: z.string() });
export type MyPrAutoRebase = z.infer<typeof MyPrAutoRebase>;

export const MyPrMergeQueueFailure = z.object({ at: z.number().finite(), message: z.string() });
export type MyPrMergeQueueFailure = z.infer<typeof MyPrMergeQueueFailure>;

export const MyPr = z.object({
  key: z.string(), repo: repositoryName, number: z.number().int().positive(), title: z.string(), url: z.url(),
  isDraft: z.boolean(), state: z.enum(['OPEN', 'MERGED', 'CLOSED']), createdAt: z.string(), mergedAt: z.string().nullable(), updatedAt: z.string(),
  baseRefName: z.string(), baseRefOid: CommitSha, headRefName: z.string().min(1), isCrossRepository: z.boolean(), headRefOid: CommitSha, isInMergeQueue: z.boolean(), mergeMethod: MyPrMergeMethod, mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']), mergeStateStatus: z.string(),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  checks: z.object({ state: z.enum(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']).nullable(), failing: z.array(z.string()), pendingCount: nonnegativeInteger }),
  unresolvedThreads: nonnegativeInteger, threads: z.array(MyPrThread), behindBy: nonnegativeInteger.nullable(),
  reviewRequests: z.array(z.object({ name: z.string(), isTeam: z.boolean(), avatarUrl: z.string().nullable() })),
  approvals: nonnegativeInteger, reviews: z.array(MyPrReview), stage: MyPrStage, autoRebase: MyPrAutoRebase.optional(), keepMergeable: z.boolean().optional(),
  keepMergeableAttempt: MyPrKeepMergeableAttempt.optional(), isKeepMergeableFixInFlight: z.boolean().optional(),
  mergeQueuePosition: z.number().int().positive().nullable().optional(), isMergeQueueHeldForRepairPush: z.boolean().optional(), mergeQueueFailure: MyPrMergeQueueFailure.optional(),
}).refine((pr) => pr.key === `${pr.repo}#${pr.number}`);
export type MyPr = z.infer<typeof MyPr>;

export const MyPrLaneEntry = z.strictObject({
  key: pullRequestKey,
  autoRebase: MyPr.shape.autoRebase, keepMergeable: MyPr.shape.keepMergeable,
  keepMergeableAttempt: MyPr.shape.keepMergeableAttempt, isKeepMergeableFixInFlight: MyPr.shape.isKeepMergeableFixInFlight,
  mergeQueuePosition: MyPr.shape.mergeQueuePosition, isMergeQueueHeldForRepairPush: MyPr.shape.isMergeQueueHeldForRepairPush,
  mergeQueueFailure: MyPr.shape.mergeQueueFailure,
});
export type MyPrLaneEntry = z.infer<typeof MyPrLaneEntry>;

export const MyPrsStatus = z.object({
  ...githubPollingShape,
  type: z.literal('my-prs-status'), ts: z.number().finite(), configured: z.boolean(), reason: z.string().nullable().optional(),
  viewer: z.string().nullable(), prs: z.array(MyPrLaneEntry), truncatedNote: z.string().nullable().optional(),
  isKeepMergeableEnabled: z.boolean().optional(), isMergeQueueEnabled: z.boolean().optional(),
}).passthrough();
export type MyPrsStatus = z.infer<typeof MyPrsStatus>;

export const MyPrsSnapshot = MyPrsStatus.extend({ prs: z.array(MyPr) });
export type MyPrsSnapshot = z.infer<typeof MyPrsSnapshot>;

export const MyPrMergeRequest = z.object({ repo: repositoryName, number: z.number().int().positive(), headRefOid: CommitSha });
export type MyPrMergeRequest = z.infer<typeof MyPrMergeRequest>;

export const MyPrMergeKind = z.enum(['merged', 'queued', 'auto-merge', 'unconfirmed']);
export type MyPrMergeKind = z.infer<typeof MyPrMergeKind>;

export const MyPrMergeResult = z.object({ key: z.string(), ok: z.boolean(), kind: MyPrMergeKind.optional(), error: z.string().optional() });
export type MyPrMergeResult = z.infer<typeof MyPrMergeResult>;

const CheckRun = z.object({ __typename: z.literal('CheckRun'), name: z.string(), conclusion: z.string().nullable(), status: z.string(), startedAt: z.string().nullish(),
  checkSuite: z.object({ app: z.object({ databaseId: z.number().int().nullish() }).nullish(), workflowRun: z.object({ workflow: z.object({ databaseId: z.number().int().nullish() }) }).nullish() }).nullish(),
});
const StatusContext = z.object({ __typename: z.literal('StatusContext'), context: z.string(), state: z.string() });
export const MyPrCheckContext = z.union([CheckRun, StatusContext]);
export type MyPrCheckContext = z.infer<typeof MyPrCheckContext>;
const CheckContextsPageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
export const MyPrSearchNode = z.object({
  __typename: z.literal('PullRequest'), id: z.string().regex(NODE_ID_RE), number: z.number().int().positive(), title: z.string(), url: z.url(), isDraft: z.boolean(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']), createdAt: z.string(), mergedAt: z.string().nullable(), updatedAt: z.string(), baseRefName: z.string(), baseRefOid: CommitSha, headRefName: z.string().min(1), isCrossRepository: z.boolean(),
  headRefOid: CommitSha, isInMergeQueue: z.boolean(), mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  mergeStateStatus: z.string(), reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  repository: z.object({ nameWithOwner: repositoryName, viewerDefaultMergeMethod: MyPrMergeMethod }),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({
    id: z.string().regex(NODE_ID_RE).optional(), state: z.enum(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']).nullable(),
    contexts: z.object({ pageInfo: CheckContextsPageInfo.optional(), nodes: z.array(MyPrCheckContext) }),
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

export const MyPrCheckContextsResponse = z.object({ data: z.object({ node: z.object({
  contexts: z.object({ pageInfo: CheckContextsPageInfo, nodes: z.array(z.unknown()) }).nullable(),
}).nullable() }).nullable(), errors: z.array(z.unknown()).optional() });

export const MyPrMergeStateResponse = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({
  state: z.string(), isInMergeQueue: z.boolean(), autoMergeRequest: z.object({ enabledAt: z.string().nullable() }).nullable(),
}).nullable() }).nullable() }), errors: z.array(z.unknown()).optional() });
