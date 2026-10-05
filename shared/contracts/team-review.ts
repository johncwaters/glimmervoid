import { reviewsPollingShape } from './reviews.ts';
import { z } from 'zod';

export const CommitSha = z.string().regex(/^[0-9a-f]{40}$/);
const repoSlug = z.string().regex(/^[^/]+\/[^/]+$/);

export const SearchedPr = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  draft: z.boolean().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
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

const LEGACY_VERDICTS: Readonly<Record<string, string>> = Object.freeze({
  STAMP: 'APPROVE',
  COMMENT: 'APPROVE WITH NITS',
  NEEDS_YOU: 'REQUEST CHANGES',
});

export const ReviewVerdict = z.enum(['APPROVE', 'APPROVE WITH NITS', 'REQUEST CHANGES', 'BLOCKED']);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

const storedVerdict = z.preprocess(
  (verdict) => (typeof verdict === 'string' && Object.hasOwn(LEGACY_VERDICTS, verdict) ? LEGACY_VERDICTS[verdict] : verdict),
  ReviewVerdict,
);

export const FindingSeverity = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const DraftComment = ReviewComment.extend({ severity: FindingSeverity.optional() });
export type DraftComment = z.infer<typeof DraftComment>;

export const ReviewFinding = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().nullable(),
  side: z.enum(['RIGHT', 'LEFT']),
  severity: FindingSeverity,
  reviewer: z.string().min(1),
  disposition: z.enum(['ACTIONABLE', 'NIT', 'AMBIGUOUS']).nullable(),
  body: z.string().min(1),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const ReviewAssessment = z.object({
  goal: z.string().default(''),
  change: z.string(),
  checked: z.array(z.string()),
  gaps: z.array(z.string()),
});
export type ReviewAssessment = z.infer<typeof ReviewAssessment>;

export const ReviewResult = z.object({
  verdict: ReviewVerdict,
  head: CommitSha,
  summary: z.string(),
  assessment: ReviewAssessment.nullable(),
  findings: z.array(ReviewFinding),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

export const PostingPlan = z.object({
  body: z.string(),
  commit_id: CommitSha,
  comments: z.array(z.object({
    path: z.string().min(1),
    line: z.number().int().positive(),
    side: z.enum(['RIGHT', 'LEFT']).default('RIGHT'),
    body: z.string().min(1),
  })),
});
export type PostingPlan = z.infer<typeof PostingPlan>;

export const PostedReviewEvent = z.enum(['APPROVE', 'COMMENT']);
export type PostedReviewEvent = z.infer<typeof PostedReviewEvent>;

export const GithubReviewState = z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);
export type GithubReviewState = z.infer<typeof GithubReviewState>;
export const DECIDING_REVIEW_STATES: ReadonlySet<GithubReviewState> = new Set(['APPROVED', 'CHANGES_REQUESTED']);

export const GithubReviewDecision = z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
export type GithubReviewDecision = z.infer<typeof GithubReviewDecision>;

export const ReviewChecksState = z.enum(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']);
export type ReviewChecksState = z.infer<typeof ReviewChecksState>;

const reviewPriorityShape = {
  requestSource: z.enum(['direct', 'team']).default('team'),
  isDraft: z.boolean().optional(),
  checksState: ReviewChecksState.nullable().optional(),
};

export const GithubReview = z.object({
  login: z.string().min(1),
  state: GithubReviewState,
  commit: CommitSha.nullable(),
  isViewer: z.boolean(),
  submittedAt: z.string().nullable().optional(),
});
export type GithubReview = z.infer<typeof GithubReview>;

export function hasStandingViewerApproval(draft: { githubReviews?: readonly GithubReview[]; reviewDecision?: GithubReviewDecision | null; reviewedHead?: string; liveHead?: string; requeuedHead?: string }): boolean {
  if (draft.reviewDecision !== 'APPROVED') return false;
  if (draft.requeuedHead !== undefined && draft.requeuedHead === (draft.liveHead ?? draft.reviewedHead)) return false;
  return (draft.githubReviews ?? []).some((review) => review.isViewer && review.state === 'APPROVED');
}

export const PrReviewState = z.object({
  head: CommitSha,
  reviews: z.array(GithubReview),
});
export type PrReviewState = z.infer<typeof PrReviewState>;

export const PriorReview = z.object({
  head: CommitSha,
  verdict: ReviewVerdict,
  summary: z.string(),
  body: z.string(),
  comments: z.array(ReviewComment),
  wasPosted: z.boolean(),
});
export type PriorReview = z.infer<typeof PriorReview>;

export const ReviewThreadId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_=-]+$/);
export const TeamReviewThreadResult = z.object({ addressed: z.boolean(), reason: z.string().trim().min(1).max(4000) }).strict();
export type TeamReviewThreadResult = z.infer<typeof TeamReviewThreadResult>;

export const TeamReviewThreadNode = z.object({
  id: ReviewThreadId,
  path: z.string(),
  line: z.number().int().positive().nullable(),
  isResolved: z.boolean(),
  viewerCanResolve: z.boolean(),
  comments: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable().optional() }),
    nodes: z.array(z.object({
      body: z.string(),
      author: z.object({ login: z.string() }).nullable(),
      viewerDidAuthor: z.boolean(),
      createdAt: z.string().datetime(),
      url: z.string().url(),
      originalCommit: z.object({ oid: CommitSha }).nullable(),
    })),
  }),
});
export type TeamReviewThreadNode = z.infer<typeof TeamReviewThreadNode>;

export const TeamReviewThreadCommentsResponse = z.object({ data: z.object({ node: z.object({ comments: TeamReviewThreadNode.shape.comments }).nullable() }).nullable() });

export const TeamReviewThreadsRepository = z.object({ pullRequest: z.object({ reviewThreads: z.object({
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable().optional() }),
  nodes: z.array(TeamReviewThreadNode),
}) }).nullable() });
export const TeamReviewResolveResponse = z.object({
  data: z.object({ resolveReviewThread: z.object({ thread: z.object({ id: ReviewThreadId, isResolved: z.literal(true) }) }) }).nullable(),
  errors: z.array(z.unknown()).optional(),
});

export const TeamReviewThread = z.object({
  id: ReviewThreadId,
  path: z.string(),
  line: z.number().int().positive().nullable(),
  isResolved: z.boolean(),
  viewerCanResolve: z.boolean(),
  isNit: z.boolean(),
  url: z.string().url(),
  lastReplyAuthor: z.string(),
  lastReplyAt: z.string().datetime(),
  judgement: TeamReviewThreadResult.extend({ head: CommitSha, judgedAt: z.number().finite(), lastReplyAt: z.string().datetime() }).optional(),
  resolveError: z.string().optional(),
  resolveAttemptReplyAt: z.string().optional(),
  judgeAttempt: z.object({ head: CommitSha, lastReplyAt: z.string(), retryAt: z.number().finite() }).optional(),
  unjudgeable: z.object({ head: CommitSha, lastReplyAt: z.string(), reason: z.string().min(1) }).optional(),
});
export type TeamReviewThread = z.infer<typeof TeamReviewThread>;
export const TeamReviewCompareFiles = z.object({
  merge_base_commit: z.object({ sha: CommitSha }),
  files: z.array(z.object({ filename: z.string(), previous_filename: z.string().optional(), patch: z.string().optional() })).max(300),
});
export type TeamReviewCompareFiles = z.infer<typeof TeamReviewCompareFiles>;

export const ReviewDraft = z.object({
  ...reviewPriorityShape,
  key: z.string(),
  repo: repoSlug,
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  tier: z.enum(['stamp', 'full']),
  reasons: z.array(z.string()),
  reviewedHead: CommitSha,
  verdict: storedVerdict,
  summary: z.string(),
  assessment: ReviewAssessment.optional(),
  body: z.string(),
  comments: z.array(DraftComment),
  status: z.enum(['ready', 'stale', 'posted', 'discarded', 'error']),
  error: z.string().optional(),
  threads: z.array(TeamReviewThread).optional(),
  githubReviews: z.array(GithubReview).optional(),
  reviewDecision: GithubReviewDecision.nullable().optional(),
  liveHead: CommitSha.optional(),
  prCreatedAt: z.string().optional(),
  reviewedAt: z.number().finite().optional(),
  postedAt: z.number().finite().optional(),
  postedEvent: PostedReviewEvent.optional(),
  priorReviewedHead: CommitSha.optional(),
  requeuedHead: CommitSha.optional(),
});
export type ReviewDraft = z.infer<typeof ReviewDraft>;

export function canApproveAfterComment(draft: Pick<ReviewDraft, 'status' | 'postedEvent'>): boolean {
  return draft.status === 'posted' && draft.postedEvent === 'COMMENT';
}

export const TeamReviewAction = z.enum(['approve', 'approve-only', 'comment', 'discard', 'requeue', 'resolve-thread']);
export type TeamReviewAction = z.infer<typeof TeamReviewAction>;

export const TeamReviewActionRequest = z.object({
  key: z.string().min(1),
  head: CommitSha,
  action: TeamReviewAction,
  threadId: ReviewThreadId.optional(),
  body: z.string(),
  comments: z.array(ReviewComment),
}).refine((request) => request.action !== 'resolve-thread' || request.threadId !== undefined, { message: 'resolve-thread requires threadId', path: ['threadId'] });
export type TeamReviewActionRequest = z.infer<typeof TeamReviewActionRequest>;

export const TeamReviewActionResult = z.object({
  key: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  warning: z.string().optional(),
});
export type TeamReviewActionResult = z.infer<typeof TeamReviewActionResult>;

export const ResumableReview = z.object({
  sessionId: z.string().min(1),
  workDir: z.string().min(1),
  worktreePath: z.string().min(1),
  head: CommitSha,
  deadlineAt: z.number(),
  remainingAwakeMs: z.number().nonnegative().optional(),
  savedAt: z.number(),
});
export type ResumableReview = z.infer<typeof ResumableReview>;

export const QueuedReview = z.object({
  ...reviewPriorityShape,
  reviewDecision: GithubReviewDecision.nullable().optional(),
  key: z.string(),
  repo: repoSlug,
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  prCreatedAt: z.string().optional(),
});
export type QueuedReview = z.infer<typeof QueuedReview>;

export const TeamReviewStateEntry = z.object({
  draft: ReviewDraft.nullable(),
  reviewedHead: CommitSha.nullable(),
  inFlight: z.boolean(),
  skipReason: z.string().nullable(),
  handReview: QueuedReview.optional(),
  reviewAttempts: z.number().int().nonnegative().default(0),
  resumable: ResumableReview.nullable().optional(),
  reviewedAt: z.number().optional(),
  threads: z.array(TeamReviewThread).optional(),
  autoResolvedThreadIds: z.array(ReviewThreadId).optional(),
  githubReviews: z.array(GithubReview).optional(),
  reviewDecision: GithubReviewDecision.nullable().optional(),
  liveHead: CommitSha.optional(),
  requeuedHead: CommitSha.optional(),
  priorReview: PriorReview.optional(),
  discardedReviewHead: CommitSha.optional(),
  updatedAt: z.number().finite(),
});
export type TeamReviewStateEntry = z.infer<typeof TeamReviewStateEntry>;

export const TeamReviewState = z.record(z.string(), TeamReviewStateEntry);
export type TeamReviewState = z.infer<typeof TeamReviewState>;

export const ReviewProgressPhase = z.enum(['preparing', 'checkout', 'reviewing']);
export type ReviewProgressPhase = z.infer<typeof ReviewProgressPhase>;

export const ReviewProgressStep = z.object({
  at: z.number().finite(),
  tool: z.string(),
  detail: z.string(),
});
export type ReviewProgressStep = z.infer<typeof ReviewProgressStep>;

export const InFlightReview = z.object({
  ...reviewPriorityShape,
  reviewDecision: GithubReviewDecision.nullable().optional(),
  key: z.string(),
  repo: repoSlug,
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  tier: z.enum(['stamp', 'full']),
  reasons: z.array(z.string()),
  head: CommitSha,
  phase: ReviewProgressPhase,
  startedAt: z.number().finite(),
  deadlineAt: z.number().finite().nullable(),
  toolCalls: z.number().int().nonnegative(),
  recentSteps: z.array(ReviewProgressStep),
  prCreatedAt: z.string().optional(),
  priorReviewedHead: CommitSha.optional(),
});
export type InFlightReview = z.infer<typeof InFlightReview>;


export const TeamReviewStatus = z.object({
  ...reviewsPollingShape,
  type: z.literal('team-review-status'),
  ts: z.number().finite(),
  configured: z.boolean(),
  reason: z.string().nullable().optional(),
  drafts: z.array(ReviewDraft),
  inFlight: z.array(InFlightReview),
  queued: z.array(QueuedReview).default([]),
  handReview: z.array(QueuedReview).default([]),
  team: z.object({ org: z.string(), slug: z.string(), name: z.string(), avatarUrl: z.string() }).nullable().optional(),
}).passthrough();
export type TeamReviewStatus = z.infer<typeof TeamReviewStatus>;
