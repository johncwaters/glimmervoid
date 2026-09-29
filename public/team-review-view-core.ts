import { DECIDING_REVIEW_STATES, FindingSeverity } from '#shared/contracts/team-review.ts';
import type {
  GithubReview, GithubReviewState, InFlightReview, ReviewComment, ReviewDraft, ReviewProgressPhase, TeamReviewAction, TeamReviewActionRequest, TeamReviewStatus,
} from '#shared/contracts/team-review.ts';
import { findingSeveritiesIn, parseLeadingFindingHeader, withoutAutomatedNote } from '#shared/team-review-markdown.ts';
import { attentionSignature } from './attention-ack-core.ts';
import { formatClockOffset } from './radar-core.ts';
import type { StateTone } from './state-tone-core.ts';

export type QueueRowKind = 'ready' | 'settled' | 'inReview' | 'attention' | 'posted' | 'discarded';

export function queueRowTone(kind: QueueRowKind, status: ReviewDraft['status'] | null): StateTone {
  if (kind === 'ready') return 'warn';
  if (kind === 'settled') return 'ok';
  if (kind === 'inReview') return 'wait';
  if (kind === 'attention') return status === 'error' ? 'danger' : 'warn';
  return 'muted';
}

const QUEUE_ROW_STATE_LABELS: Readonly<Record<QueueRowKind, string>> = {
  ready: 'Ready', settled: 'No review needed', inReview: 'In review', attention: 'Needs attention', posted: 'Posted', discarded: 'Discarded',
};

export function queueRowStateLabel(kind: QueueRowKind, status: ReviewDraft['status'] | null): string {
  if (kind === 'attention' && status) return attentionStatusLabel(status);
  return QUEUE_ROW_STATE_LABELS[kind];
}

export interface TeamReviewSections {
  ready: ReviewDraft[];
  noReviewNeeded: ReviewDraft[];
  inReview: InFlightReview[];
  attention: ReviewDraft[];
  posted: ReviewDraft[];
  discarded: ReviewDraft[];
}

export interface ReviewParagraph {
  lead: string;
  leadKind: 'fix' | 'question' | null;
  segments: { text: string; isCode: boolean }[];
}

export interface ParsedReviewComment {
  tag: string | null;
  severity: FindingSeverity | null;
  paragraphs: ReviewParagraph[];
}

const SEVERITY_PRESENTATION: Readonly<Record<FindingSeverity, { filledCount: number; colorToken: string }>> = {
  CRITICAL: { filledCount: 3, colorToken: '--state-failed' },
  HIGH: { filledCount: 3, colorToken: '--state-waiting' },
  MEDIUM: { filledCount: 2, colorToken: '--accent' },
  LOW: { filledCount: 1, colorToken: '--text-dim' },
};

const VERDICT_SEALS: Readonly<Record<ReviewDraft['verdict'], 'check' | 'dot' | 'bar' | 'cross'>> = {
  APPROVE: 'check',
  'APPROVE WITH NITS': 'dot',
  'REQUEST CHANGES': 'bar',
  BLOCKED: 'cross',
};

export const TEAM_REVIEW_SETTINGS_SECTION_ID = 'lanes-team-review';
export const TEAM_REVIEW_SETTINGS_SETTING_ID = 'team-review-enabled';

const VERDICT_LABELS: Readonly<Record<ReviewDraft['verdict'], string>> = Object.freeze({
  APPROVE: 'approve',
  'APPROVE WITH NITS': 'approve with nits',
  'REQUEST CHANGES': 'request changes',
  BLOCKED: 'blocked',
});

const VERDICT_RECOMMENDATIONS: Readonly<Record<ReviewDraft['verdict'], string>> = Object.freeze({
  APPROVE: 'suggests approve',
  'APPROVE WITH NITS': 'suggests approve with nits',
  'REQUEST CHANGES': 'suggests changes',
  BLOCKED: 'review blocked',
});

const VERDICT_TONES: Readonly<Record<ReviewDraft['verdict'], string>> = Object.freeze({
  APPROVE: 'ok',
  'APPROVE WITH NITS': 'info',
  'REQUEST CHANGES': 'warn',
  BLOCKED: 'crit',
});

const ATTENTION_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  stale: 'stale',
  error: 'error',
  discarded: 'discarded',
});

const GITHUB_REVIEW_VERBS: Readonly<Record<GithubReviewState, string>> = Object.freeze({
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'commented',
});

const PHASE_LABELS: Readonly<Record<ReviewProgressPhase, string>> = Object.freeze({
  preparing: 'fetching the diff',
  checkout: 'checking out the head',
  reviewing: 'agent reviewing',
});

const ACTION_OUTCOME_TEXT: Readonly<Record<TeamReviewAction, string>> = Object.freeze({
  approve: 'Approved on GitHub',
  comment: 'Comment posted on GitHub',
  discard: 'Draft discarded',
  requeue: 'Queued. The next poll reviews it again.',
});

const ACTION_PROGRESS_TEXT: Readonly<Record<TeamReviewAction, string>> = Object.freeze({
  approve: 'Posting the approval',
  comment: 'Posting the comment',
  discard: 'Discarding the draft',
  requeue: 'Queueing the review',
});

export function groupDrafts(status: TeamReviewStatus | null | undefined): TeamReviewSections {
  const sections: TeamReviewSections = { ready: [], noReviewNeeded: [], inReview: [], attention: [], posted: [], discarded: [] };
  if (!status) return sections;
  const inFlightKeys = new Set(status.inFlight.map((review) => review.key));
  sections.inReview.push(...status.inFlight);
  for (const draft of status.drafts) {
    if (inFlightKeys.has(draft.key)) continue;
    const isSettled = (draft.status === 'ready' || draft.status === 'stale') && !isReviewNeeded(draft);
    if (isSettled) sections.noReviewNeeded.push(draft);
    if (draft.status === 'ready' && !isSettled) sections.ready.push(draft);
    if ((draft.status === 'stale' && !isSettled) || draft.status === 'error') sections.attention.push(draft);
    if (draft.status === 'posted') sections.posted.push(draft);
    if (draft.status === 'discarded') sections.discarded.push(draft);
  }
  return sections;
}

function settlesReview(review: GithubReview, head: string): boolean {
  if (review.commit !== head) return false;
  return review.isViewer || DECIDING_REVIEW_STATES.has(review.state);
}

function currentHead(draft: ReviewDraft): string {
  return draft.liveHead ?? draft.reviewedHead;
}

export function isReviewNeeded(draft: ReviewDraft): boolean {
  return !(draft.githubReviews ?? []).some((review) => settlesReview(review, currentHead(draft)));
}

function describeGithubReview(review: GithubReview, head: string): string {
  const verb = GITHUB_REVIEW_VERBS[review.state];
  if (!review.isViewer) return `${verb} by ${review.login}`;
  if (review.commit === head) return `you ${verb}`;
  return `you ${verb} (older commit)`;
}

export function githubReviewSummary(draft: ReviewDraft, { isViewerShown = true }: { isViewerShown?: boolean } = {}): string {
  const reviews = (draft.githubReviews ?? []).filter((review) => isViewerShown || !review.isViewer).sort((left, right) => Number(right.isViewer) - Number(left.isViewer));
  return reviews.map((review) => describeGithubReview(review, currentHead(draft))).join(', ');
}

export function postedAgeText(postedAt: number | undefined, nowMs: number): string {
  if (postedAt === undefined) return '';
  const minutes = Math.floor(Math.max(0, nowMs - postedAt) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function hasAnyRow(sections: TeamReviewSections): boolean {
  return sections.ready.length + sections.noReviewNeeded.length + sections.inReview.length + sections.attention.length + sections.posted.length + sections.discarded.length > 0;
}

export function chooseSelectedReviewKey(sections: TeamReviewSections, selectedKey: string | null): string | null {
  const rows = [...sections.ready, ...sections.noReviewNeeded, ...sections.inReview, ...sections.attention, ...sections.posted, ...sections.discarded];
  if (selectedKey && rows.some((row) => row.key === selectedKey)) return selectedKey;
  return rows[0]?.key ?? null;
}

export function severityPresentation(severity: FindingSeverity): { filledCount: number; colorToken: string } {
  return SEVERITY_PRESENTATION[severity];
}

export function verdictSealKind(verdict: ReviewDraft['verdict']): 'check' | 'dot' | 'bar' | 'cross' {
  return VERDICT_SEALS[verdict];
}

export function severityCounts(draft: Pick<ReviewDraft, 'body' | 'comments'>): { severity: FindingSeverity; count: number }[] {
  const counts = new Map<FindingSeverity, number>();
  for (const body of [draft.body, ...draft.comments.map((comment) => comment.body)]) {
    for (const severity of findingSeveritiesIn(body)) counts.set(severity, (counts.get(severity) ?? 0) + 1);
  }
  return FindingSeverity.options.flatMap((severity) => {
    const count = counts.get(severity) ?? 0;
    return count > 0 ? [{ severity, count }] : [];
  });
}

export function parseInlineSegments(value: string): ReviewParagraph['segments'] {
  const segments: ReviewParagraph['segments'] = [];
  let offset = 0;
  for (const match of value.matchAll(/`([^`\n]+)`/g)) {
    const matchOffset = match.index ?? 0;
    if (matchOffset > offset) segments.push({ text: value.slice(offset, matchOffset), isCode: false });
    segments.push({ text: match[1] ?? '', isCode: true });
    offset = matchOffset + match[0].length;
  }
  if (offset < value.length) segments.push({ text: value.slice(offset), isCode: false });
  return segments;
}

export function parseReviewComment(body: string): ParsedReviewComment {
  const withoutNote = withoutAutomatedNote(body);
  const header = parseLeadingFindingHeader(withoutNote);
  const content = header ? withoutNote.slice(header.length).trim() : withoutNote;
  const paragraphs = content.split(/\r?\n\s*\r?\n/).filter(Boolean).map((paragraph): ReviewParagraph => {
    const leadMatch = paragraph.match(/^(Suggested fix:|Fix:|Open question[.,:])\s*/);
    const lead = leadMatch?.[1] ?? '';
    const leadKind = lead.startsWith('Open question') ? 'question' : lead ? 'fix' : null;
    return { lead, leadKind, segments: parseInlineSegments(paragraph.slice(leadMatch?.[0].length ?? 0)) };
  });
  return { tag: header?.reviewer ?? null, severity: header?.severity ?? null, paragraphs };
}

export function reviewFooterText(reviewedHead: string, includedComments: number): string {
  const commentLabel = includedComments === 1 ? 'inline comment' : 'inline comments';
  return `Posts 1 review on ${reviewedHead.slice(0, 7)}: the body plus ${includedComments} ${commentLabel}`;
}

export function reviewProgressSteps(phase: ReviewProgressPhase): { label: string; state: 'done' | 'active' | 'todo' }[] {
  const labels = ['Fetch the diff', 'Check out the head', 'Review', 'Draft ready'];
  const activeIndex = { preparing: 0, checkout: 1, reviewing: 2 }[phase];
  return labels.map((label, index) => ({ label, state: index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'todo' }));
}

export function pullRequestLabel(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function tierLabel(tier: ReviewDraft['tier']): string {
  return tier === 'full' ? 'full' : 'light';
}

export function verdictRecommendation(verdict: ReviewDraft['verdict']): string {
  return VERDICT_RECOMMENDATIONS[verdict] ?? verdictLabel(verdict);
}

export function verdictSealText(draft: Pick<ReviewDraft, 'verdict' | 'status'>): string {
  return draft.status === 'posted' ? verdictLabel(draft.verdict) : verdictRecommendation(draft.verdict);
}

export const LEGACY_SUMMARY_HINT = 'This review ran before plain summaries existed, so only its verdict and findings remain. The audit log shows what it checked. Queue review to get a plain summary.';

const REQUEUEABLE_STATUSES: ReadonlySet<ReviewDraft['status']> = new Set(['error', 'stale', 'discarded', 'posted']);

export function hasRequeueFooter(status: ReviewDraft['status']): boolean {
  return REQUEUEABLE_STATUSES.has(status);
}

export function verdictLabel(verdict: ReviewDraft['verdict']): string {
  return VERDICT_LABELS[verdict] ?? String(verdict).toLowerCase();
}

export function verdictTone(verdict: ReviewDraft['verdict']): string {
  return VERDICT_TONES[verdict] ?? 'dim';
}

export function phaseLabel(phase: ReviewProgressPhase): string {
  return PHASE_LABELS[phase] ?? phase;
}

export function inFlightElapsedText(review: InFlightReview, nowMs: number): string {
  return `${formatClockOffset(nowMs - review.startedAt)} elapsed`;
}

export function inFlightProgressText(review: InFlightReview, nowMs: number): string {
  const parts = [inFlightElapsedText(review, nowMs)];
  if (review.deadlineAt !== null) parts.push(`times out in ${formatClockOffset(review.deadlineAt - nowMs)}`);
  if (review.phase === 'reviewing') parts.push(`${review.toolCalls} ${review.toolCalls === 1 ? 'tool call' : 'tool calls'}`);
  return parts.join(', ');
}

export function attentionStatusLabel(status: ReviewDraft['status']): string {
  return ATTENTION_STATUS_LABELS[status] ?? status;
}

export function attentionDetail(draft: ReviewDraft): string {
  if (draft.status === 'stale') return 'Out of date. Automatic review runs at the next poll after the configured wait. Queue review bypasses the wait.';
  if (draft.status === 'discarded') return 'Not reviewed again until queued.';
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
  return `${draft.key}@${draft.reviewedHead}:${draft.status}:${draft.summary}:${githubReviewSummary(draft)}`;
}

export function isInFlightProgressOnlyChange(previous: TeamReviewStatus | null | undefined, next: TeamReviewStatus): boolean {
  if (!previous) return false;
  if (previous.configured !== next.configured || previous.reason !== next.reason) return false;
  const previousKeys = previous.inFlight.map((review) => review.key).join('\n');
  const nextKeys = next.inFlight.map((review) => review.key).join('\n');
  if (previousKeys !== nextKeys) return false;
  return JSON.stringify(previous.drafts) === JSON.stringify(next.drafts);
}
