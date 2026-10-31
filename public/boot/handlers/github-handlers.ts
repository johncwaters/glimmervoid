import { applyGithubPrsFrame } from '../../github/github-prs-store.ts';
import { applyIssueDetailResult, applyIssuesStatus, applyOpenIssueSessionResult, applySetIssueStateResult } from '../../github/issues-store.ts';
import { applyMyPrMergeResult, applyMyPrsStatus } from '../../github/my-prs-store.ts';
import { applyOpenTeamReviewSessionResult, applyTeamReviewActionResult, applyTeamReviewStatus } from '../../github/team-review-store.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';

const messageHandlers = {
  'team-review-status': (msg) => applyTeamReviewStatus(msg),
  'github-prs': (msg) => applyGithubPrsFrame(msg),
  'my-prs-status': applyMyPrsStatus,
  'my-pr-merge-result': (msg) => applyMyPrMergeResult(msg),
  'team-review-action-result': (msg) => applyTeamReviewActionResult(msg),
  'open-team-review-session-result': (msg) => applyOpenTeamReviewSessionResult(msg),
  'issues-status':      (msg) => applyIssuesStatus(msg),
  'issue-detail-result': (msg) => applyIssueDetailResult(msg),
  'open-issue-session-result': (msg) => applyOpenIssueSessionResult(msg),
  'set-issue-state-result': (msg) => applySetIssueStateResult(msg),
} satisfies DashboardHandlerTable;

export { messageHandlers as githubHandlers };
