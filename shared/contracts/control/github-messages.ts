import { IssueRepoSlug, IssuesStatus } from '../issues.ts';
import { GithubPollingRefreshRequest, GithubPollingRefreshResult } from '../github-polling.ts';
import { z } from 'zod';
import { TeamReviewActionRequest, TeamReviewActionResult, TeamReviewStatus, hasRequiredActionHead } from '../team-review.ts';
import { MyPrKeepMergeableRequest, MyPrKeepMergeableResult, MyPrMergeRequest, MyPrMergeResult, MyPrMergeWhenReadyRequest, MyPrMergeWhenReadyResult, MyPrsStatus } from '../my-prs.ts';
import { GithubPrsFrame } from '../github-prs.ts';
import { PrActionRunRequest, PrFlowApproveRequest, PrFlowDisposeRequest, PrFlowDisposeResult, PrFlowItemRequest, PrFlowSaveRuleRequest, PrFlowsStatus } from '../pr-flows.ts';
import { requestId, GithubTeam, PullRequestKey, loose, optionalError } from './control-fields.ts';

export const githubClientVariants = [
  loose('list-github-teams', { requestId }),
  loose('issue-detail', { requestId: z.string().min(1), repo: IssueRepoSlug, issueNumber: z.number().int().positive() }),
  loose('open-issue-session', { requestId, projectId: z.string(), repo: IssueRepoSlug, issueNumber: z.number().int().positive() }),
  loose('set-issue-state', { requestId: z.string().min(1), repo: IssueRepoSlug, issueNumber: z.number().int().positive(), state: z.enum(['closed', 'open']) }),
  loose('open-team-review-session', { requestId, key: PullRequestKey }),
  loose('team-review-action', { ...TeamReviewActionRequest.shape, requestId }).refine(hasRequiredActionHead, { message: 'only discard may omit head', path: ['head'] }),
  loose('my-pr-merge', { ...MyPrMergeRequest.shape, requestId }),
  loose('my-pr-keep-mergeable', { ...MyPrKeepMergeableRequest.shape, requestId }),
  loose('my-pr-merge-when-ready', { ...MyPrMergeWhenReadyRequest.shape, requestId }),
  loose('github-polling-refresh', { ...GithubPollingRefreshRequest.shape, requestId }),
  loose('pr-flow-dispose', { ...PrFlowDisposeRequest.shape, requestId }),
  loose('pr-flow-undo', { ...PrFlowItemRequest.shape, requestId }),
  loose('pr-flow-save-rule', { ...PrFlowSaveRuleRequest.shape, requestId }),
  loose('pr-flow-approve', { ...PrFlowApproveRequest.shape, requestId }),
  loose('pr-action-run', { ...PrActionRunRequest.shape, requestId }),
] as const;

export const githubServerVariants = [
  loose('github-teams-listed', { requestId, viewer: z.string().nullable(), teams: z.array(GithubTeam), orgs: z.array(z.string()), error: z.string().nullable() }),
  loose('issue-detail-result', { requestId: z.string().min(1), ok: z.boolean(), body: z.string().nullable(), error: z.string().nullable() }),
  loose('set-issue-state-result', { requestId: z.string().min(1), ok: z.boolean(), error: optionalError }),
  loose('open-issue-session-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    sessionId: z.string().optional(),
    sessionName: z.string().optional(),
    pending: z.boolean().optional(),
    existing: z.boolean().optional(),
  }),
  loose('open-team-review-session-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    key: PullRequestKey.optional(),
    sessionId: z.string().optional(),
    sessionName: z.string().optional(),
    pending: z.boolean().optional(),
    existing: z.boolean().optional(),
  }),
  loose('team-review-action-result', { ...TeamReviewActionResult.shape, requestId }),
  loose('my-pr-merge-result', { ...MyPrMergeResult.shape, requestId }),
  loose('my-pr-keep-mergeable-result', { ...MyPrKeepMergeableResult.shape, requestId }),
  loose('my-pr-merge-when-ready-result', { ...MyPrMergeWhenReadyResult.shape, requestId }),
  loose('github-polling-refresh-result', { ...GithubPollingRefreshResult.shape, requestId }),
  loose('pr-flow-dispose-result', { ...PrFlowDisposeResult.shape, requestId }),
  TeamReviewStatus,
  MyPrsStatus,
  PrFlowsStatus,
  GithubPrsFrame,
  IssuesStatus,
] as const;
