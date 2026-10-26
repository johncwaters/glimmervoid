import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { TeamReviewStatus } from '#shared/contracts/team-review.ts';
import type { TeamReviewStatus as TeamReviewStatusType } from '#shared/contracts/team-review.ts';
import { describeSchemaIssues } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';
import { githubPrByKey, subscribeGithubPrs } from './github-prs-store.ts';
import { groupDrafts, joinTeamReviews } from './team-review-view-core.ts';
import type { TeamReviewSections } from './team-review-view-core.ts';

export type TeamReviewChange =
  | { kind: 'status' }
  | { kind: 'action-result'; message: unknown }
  | { kind: 'open-session-result'; message: ServerMessageOf<'open-team-review-session-result'> }
  | { kind: 'connection'; isConnected: boolean };

let latest: TeamReviewStatusType | null = null;
let joinedStatus: TeamReviewStatusType | null = null;
const listeners = new Set<(change: TeamReviewChange) => void>();

function notify(change: TeamReviewChange): void {
  for (const listener of listeners) listener(change);
}

function rejoinAndNotify(): void {
  joinedStatus = joinTeamReviews(latest, githubPrByKey);
  notify({ kind: 'status' });
}

export function subscribeTeamReview(listener: (change: TeamReviewChange) => void): void {
  listeners.add(listener);
}

export function teamReviewStatusView(): TeamReviewStatusType | null {
  return joinedStatus;
}

export function teamReviewSections(): TeamReviewSections {
  return groupDrafts(joinedStatus);
}

export function applyTeamReviewStatus(message: unknown): void {
  const parsed = TeamReviewStatus.safeParse(message);
  if (!parsed.success) {
    reportToServerLog('reviews', `dropped team-review-status: ${describeSchemaIssues(parsed.error.issues)}`);
    return;
  }
  latest = parsed.data;
  rejoinAndNotify();
}

export function applyTeamReviewActionResult(message: unknown): void {
  notify({ kind: 'action-result', message });
}

export function applyOpenTeamReviewSessionResult(message: ServerMessageOf<'open-team-review-session-result'>): void {
  notify({ kind: 'open-session-result', message });
}

export function applyTeamReviewConnectionState(isConnected: boolean): void {
  notify({ kind: 'connection', isConnected });
}

subscribeGithubPrs(rejoinAndNotify);
