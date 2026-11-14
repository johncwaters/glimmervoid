import { applyGithubPrsFrame } from '../../github/github-prs-store.ts';
import { applyMyPrMergeResult, applyMyPrsStatus, applyPrFlowsStatus } from '../../github/my-prs-store.ts';
import { applyOpenTeamReviewSessionResult, applyTeamReviewActionResult, applyTeamReviewStatus } from '../../github/team-review-store.ts';
import { announceHostReadyChanged } from '../../host-ready/host-ready-changes.ts';
import { applyPacksStatus } from '../../packs/packs-store.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';

const messageHandlers = {
  'team-review-status': (msg) => applyTeamReviewStatus(msg),
  'github-prs': (msg) => applyGithubPrsFrame(msg),
  'my-prs-status': applyMyPrsStatus,
  'pr-flows-status': applyPrFlowsStatus,
  'packs-status': applyPacksStatus,
  'host-ready-changed': announceHostReadyChanged,
  'my-pr-merge-result': (msg) => applyMyPrMergeResult(msg),
  'team-review-action-result': (msg) => applyTeamReviewActionResult(msg),
  'open-team-review-session-result': (msg) => applyOpenTeamReviewSessionResult(msg),
} satisfies DashboardHandlerTable;

export { messageHandlers as githubHandlers };
