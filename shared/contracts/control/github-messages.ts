import { GithubPollingRefreshRequest, GithubPollingRefreshResult } from '../github-polling.ts';
import { z } from 'zod';
import { TeamReviewActionRequest, TeamReviewActionResult, TeamReviewStatus, hasRequiredActionHead } from '../team-review.ts';
import { MyPrKeepMergeableRequest, MyPrKeepMergeableResult, MyPrMergeRequest, MyPrMergeResult, MyPrMergeWhenReadyRequest, MyPrMergeWhenReadyResult, MyPrsStatus } from '../my-prs.ts';
import { GithubPrsFrame } from '../github-prs.ts';
import { GithubConnection, GithubConnectionAction } from '../watcher-link.ts';
import { CommitSigningAction, CommitSigningStatus } from '../commit-signing.ts';
import { PrActionRunRequest, PrFlowApproveRequest, PrFlowDisposeRequest, PrFlowDisposeResult, PrFlowItemRequest, PrFlowSaveRuleRequest, PrFlowsStatus } from '../pr-flows.ts';
import { requestId, GithubTeam, PullRequestKey, loose, optionalError } from './control-fields.ts';

export const githubClientVariants = [
  loose('list-github-teams', { requestId }),
  loose('open-team-review-session', { requestId, key: PullRequestKey }),
  loose('team-review-action', { ...TeamReviewActionRequest.shape, requestId }).refine(hasRequiredActionHead, { message: 'only discard may omit head', path: ['head'] }),
  loose('team-review-refresh-threads', { requestId, key: PullRequestKey }),
  loose('my-pr-merge', { ...MyPrMergeRequest.shape, requestId }),
  loose('my-pr-keep-mergeable', { ...MyPrKeepMergeableRequest.shape, requestId }),
  loose('my-pr-merge-when-ready', { ...MyPrMergeWhenReadyRequest.shape, requestId }),
  loose('github-polling-refresh', { ...GithubPollingRefreshRequest.shape, requestId }),
  loose('pr-flow-dispose', { ...PrFlowDisposeRequest.shape, requestId }),
  loose('pr-flow-undo', { ...PrFlowItemRequest.shape, requestId }),
  loose('pr-flow-save-rule', { ...PrFlowSaveRuleRequest.shape, requestId }),
  loose('pr-flow-approve', { ...PrFlowApproveRequest.shape, requestId }),
  loose('pr-action-run', { ...PrActionRunRequest.shape, requestId }),
  loose('github-connection', { requestId, action: GithubConnectionAction }),
  loose('commit-signing', { requestId, action: CommitSigningAction }),
] as const;

export const githubServerVariants = [
  loose('github-teams-listed', { requestId, viewer: z.string().nullable(), teams: z.array(GithubTeam), orgs: z.array(z.string()), error: z.string().nullable() }),
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
  loose('github-connection-result', { requestId, connection: GithubConnection.nullable() }),
  loose('commit-signing-result', { requestId, status: CommitSigningStatus.nullable() }),
  TeamReviewStatus,
  MyPrsStatus,
  PrFlowsStatus,
  GithubPrsFrame,
] as const;
