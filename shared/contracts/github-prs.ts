import { z } from 'zod';
import { CommitSha, GithubReviewDecision, ReviewChecksState } from './team-review.ts';
import { GithubPrsFreshness } from './github-polling.ts';
import { MyPr, MyPrSearchNode, pullRequestKeyFormat } from './my-prs.ts';
import { WorkflowPr, WorkflowSearchNode } from './workflows.ts';

export const GithubPrKey = z.string().refine((key) => pullRequestKeyFormat.safeParse(key).success
  && key === key.toLowerCase() && Number.isSafeInteger(Number(key.slice(key.lastIndexOf('#') + 1))));
export type GithubPrKey = z.infer<typeof GithubPrKey>;

export function comparablePrKey(pr: { repo: string; number: number }): string {
  return `${pr.repo}#${pr.number}`.toLowerCase();
}

export const GithubPrLightSearchNode = z.object({
  repository: MyPrSearchNode.shape.repository.pick({ nameWithOwner: true }),
  number: MyPrSearchNode.shape.number,
  updatedAt: MyPrSearchNode.shape.updatedAt,
  headRefOid: MyPrSearchNode.shape.headRefOid,
  state: MyPrSearchNode.shape.state,
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({
    statusCheckRollup: z.object({ state: MyPr.shape.checks.shape.state }).nullable(),
  }) })) }),
  reviewDecision: MyPrSearchNode.shape.reviewDecision,
  mergeStateStatus: MyPrSearchNode.shape.mergeStateStatus,
});
export type GithubPrLightSearchNode = z.infer<typeof GithubPrLightSearchNode>;

export const GithubPrDetailNode = MyPrSearchNode.extend({
  author: WorkflowSearchNode.shape.author.unwrap().extend({ __typename: z.string().optional() }).nullable(),
  labels: WorkflowSearchNode.shape.labels,
  comments: WorkflowSearchNode.shape.comments,
  latestReviews: z.object({ nodes: z.array(MyPrSearchNode.shape.latestReviews.shape.nodes.element.extend({
    commit: z.object({ oid: z.string() }).nullable().optional(),
  })) }),
  writerOpinionatedReviews: MyPrSearchNode.shape.latestOpinionatedReviews.optional(),
});
export type GithubPrDetailNode = z.infer<typeof GithubPrDetailNode>;

export const GithubPr = z.strictObject({
  key: GithubPrKey, id: MyPrSearchNode.shape.id,
  repo: MyPr.shape.repo, number: MyPr.shape.number, title: MyPr.shape.title, url: MyPr.shape.url,
  author: WorkflowPr.shape.author, isAuthorBot: z.boolean(), labels: WorkflowPr.shape.labels, commentCount: WorkflowPr.shape.commentCount,
  isDraft: MyPr.shape.isDraft, state: MyPr.shape.state,
  createdAt: MyPr.shape.createdAt, mergedAt: MyPr.shape.mergedAt, updatedAt: MyPr.shape.updatedAt,
  baseRefName: MyPr.shape.baseRefName, baseRefOid: MyPr.shape.baseRefOid,
  headRefName: MyPr.shape.headRefName, headRefOid: MyPr.shape.headRefOid,
  isCrossRepository: MyPr.shape.isCrossRepository, isInMergeQueue: MyPr.shape.isInMergeQueue,
  mergeMethod: MyPr.shape.mergeMethod, mergeable: MyPr.shape.mergeable, mergeStateStatus: MyPr.shape.mergeStateStatus,
  reviewDecision: GithubReviewDecision.nullable(), checks: MyPr.shape.checks.strict(), rollupState: ReviewChecksState.nullable(),
  unresolvedThreads: MyPr.shape.unresolvedThreads, threads: z.array(MyPr.shape.threads.element.strict()),
  behindBy: MyPr.shape.behindBy, reviewRequests: z.array(MyPr.shape.reviewRequests.element.strict()),
  approvals: MyPr.shape.approvals, reviews: z.array(MyPr.shape.reviews.element.extend({ commit: CommitSha.nullable() }).strict()),
  opinionatedWriterReviewStates: z.array(z.string()),
}).refine((pr) => pr.key === comparablePrKey(pr));
export type GithubPr = z.infer<typeof GithubPr>;

export const GithubPrsFrame = z.looseObject({
  type: z.literal('github-prs'),
  ts: z.number().finite().nonnegative(),
  prs: z.record(GithubPrKey, GithubPr).refine((prs) => Object.entries(prs).every(([key, pr]) => key === pr.key)),
  freshness: GithubPrsFreshness,
});
export type GithubPrsFrame = z.infer<typeof GithubPrsFrame>;
