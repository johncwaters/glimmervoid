import type {
  ReviewComment, ReviewDraft, TeamReviewAction, TeamReviewActionRequest, TeamReviewStatus,
} from '#shared/contracts/team-review.ts';
import { attentionSignature } from './attention-ack-core.ts';

export interface InReviewRow {
  key: string;
  draft: ReviewDraft | null;
}

export interface TeamReviewSections {
  ready: ReviewDraft[];
  inReview: InReviewRow[];
  attention: ReviewDraft[];
  posted: ReviewDraft[];
}

export const TEAM_REVIEW_SETTINGS_SECTION_ID = 'lanes-team-review';
export const TEAM_REVIEW_SETTINGS_SETTING_ID = 'team-review-enabled';

const VERDICT_LABELS: Readonly<Record<ReviewDraft['verdict'], string>> = Object.freeze({
  STAMP: 'stamp',
  COMMENT: 'comment',
  NEEDS_YOU: 'needs you',
});

const VERDICT_TONES: Readonly<Record<ReviewDraft['verdict'], string>> = Object.freeze({
  STAMP: 'ok',
  COMMENT: 'info',
  NEEDS_YOU: 'warn',
});

const ATTENTION_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  stale: 'stale',
  error: 'error',
});

const ACTION_OUTCOME_TEXT: Readonly<Record<TeamReviewAction, string>> = Object.freeze({
  approve: 'Approved on GitHub',
  comment: 'Comment posted on GitHub',
  discard: 'Draft discarded',
});

const ACTION_PROGRESS_TEXT: Readonly<Record<TeamReviewAction, string>> = Object.freeze({
  approve: 'Posting the approval',
  comment: 'Posting the comment',
  discard: 'Discarding the draft',
});

export function groupDrafts(status: TeamReviewStatus | null | undefined): TeamReviewSections {
  const sections: TeamReviewSections = { ready: [], inReview: [], attention: [], posted: [] };
  if (!status) return sections;
  const inFlightKeys = new Set(status.inFlight);
  const draftsByKey = new Map(status.drafts.map((draft) => [draft.key, draft]));
  for (const key of status.inFlight) sections.inReview.push({ key, draft: draftsByKey.get(key) ?? null });
  for (const draft of status.drafts) {
    if (inFlightKeys.has(draft.key)) continue;
    if (draft.status === 'ready') sections.ready.push(draft);
    if (draft.status === 'stale' || draft.status === 'error') sections.attention.push(draft);
    if (draft.status === 'posted') sections.posted.push(draft);
  }
  return sections;
}

export function hasAnyRow(sections: TeamReviewSections): boolean {
  return sections.ready.length + sections.inReview.length + sections.attention.length + sections.posted.length > 0;
}

export function pullRequestLabel(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function tierLabel(tier: ReviewDraft['tier']): string {
  return tier === 'full' ? 'full' : 'stamp';
}

export function verdictLabel(verdict: ReviewDraft['verdict']): string {
  return VERDICT_LABELS[verdict] ?? String(verdict).toLowerCase();
}

export function verdictTone(verdict: ReviewDraft['verdict']): string {
  return VERDICT_TONES[verdict] ?? 'dim';
}

export function attentionStatusLabel(status: ReviewDraft['status']): string {
  return ATTENTION_STATUS_LABELS[status] ?? status;
}

export function attentionDetail(draft: ReviewDraft): string {
  if (draft.status === 'stale') return 'The pull request moved after this review. It will be reviewed again at the new head.';
  return draft.error || draft.summary || 'The review failed.';
}

export function commentLocation(comment: ReviewComment): string {
  const sideSuffix = comment.side === 'LEFT' ? ' (old)' : '';
  return `${comment.path}:${comment.line}${sideSuffix}`;
}

export function withoutComment(comments: readonly ReviewComment[], removedIndex: number): ReviewComment[] {
  return comments.filter((_comment, index) => index !== removedIndex);
}

export function buildActionRequest(draft: ReviewDraft, action: TeamReviewAction, body: string, comments: readonly ReviewComment[]): TeamReviewActionRequest {
  return { key: draft.key, head: draft.reviewedHead, action, body, comments: [...comments] };
}

export function actionProgressText(action: TeamReviewAction): string {
  return ACTION_PROGRESS_TEXT[action];
}

export function actionOutcomeText(action: TeamReviewAction): string {
  return ACTION_OUTCOME_TEXT[action];
}

export function emptyStateText(status: TeamReviewStatus | null | undefined): string {
  if (!status) return 'Waiting for the team review lane.';
  if (!status.configured) return status.reason ? `Team review is not running: ${status.reason}.` : 'Team review is off.';
  return 'No review drafts yet. New teammate pull requests show up here after the next poll.';
}

export function readyAttentionSignature(status: TeamReviewStatus | null | undefined): string {
  return attentionSignature(groupDrafts(status).ready.map((draft) => `${draft.key}@${draft.reviewedHead}`));
}

export function readyRowSignature(draft: ReviewDraft): string {
  return `${draft.key}@${draft.reviewedHead}:${draft.status}`;
}
