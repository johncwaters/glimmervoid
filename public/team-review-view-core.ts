import { canApproveAfterComment, DECIDING_REVIEW_STATES, FindingSeverity } from '#shared/contracts/team-review.ts';
import type {
  DraftComment, GithubReview, GithubReviewState, InFlightReview, QueuedReview, ReviewAssessment, ReviewComment, ReviewDraft, ReviewProgressPhase, TeamReviewAction, TeamReviewActionRequest, TeamReviewStatus,
} from '#shared/contracts/team-review.ts';
import { findingSeveritiesIn, parseLeadingFindingHeader, withoutAutomatedNote } from '#shared/team-review-markdown.ts';
import { attentionSignature } from './attention-ack-core.ts';
import { formatClockOffset } from './radar-core.ts';
import type { StateTone } from './state-tone-core.ts';

export type QueueRowKind = 'ready' | 'settled' | 'inReview' | 'queued' | 'attention' | 'posted' | 'discarded';

export function queueRowTone(kind: QueueRowKind, status: ReviewDraft['status'] | null): StateTone {
  if (kind === 'ready') return 'warn';
  if (kind === 'settled') return 'ok';
  if (kind === 'inReview' || kind === 'queued') return 'wait';
  if (kind === 'attention') return status === 'error' ? 'danger' : 'warn';
  return 'muted';
}

const QUEUE_ROW_STATE_LABELS: Readonly<Record<QueueRowKind, string>> = {
  ready: 'Ready', settled: 'No review needed', inReview: 'In review', queued: 'Queued', attention: 'Needs attention', posted: 'Posted', discarded: 'Discarded',
};

export function queueRowStateLabel(kind: QueueRowKind, status: ReviewDraft['status'] | null): string {
  if (kind === 'attention' && status) return attentionStatusLabel(status);
  return QUEUE_ROW_STATE_LABELS[kind];
}

export interface QueueRowAges {
  opened?: string | null;
  reviewed?: string | null;
  posted?: string | null;
  githubReviews?: readonly (string | null)[];
}

export function queueRowTitle(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind, ages: QueueRowAges): string {
  const status = 'status' in review ? review.status : null;
  const lines = [`${pullRequestLabel(review.repo, review.number)}: ${review.title}`, queueRowStateLabel(kind, status)];
  if (ages.opened) lines.push(`Opened ${ages.opened}`);
  if (ages.reviewed) lines.push(`Reviewed ${ages.reviewed}`);
  if (ages.posted) lines.push(`Posted ${ages.posted}`);
  if (!('reviewedHead' in review)) return lines.join('\n');
  if (kind === 'attention' || kind === 'discarded') lines.push(attentionDetail(review));
  const githubReviews = githubReviewItems(review, { isViewerShown: kind !== 'posted' });
  for (const [index, githubReview] of githubReviews.entries()) lines.push(githubReviewTitle(githubReview.text, ages.githubReviews?.[index] ?? null));
  return lines.join('\n');
}

export interface TeamReviewSections {
  ready: ReviewDraft[];
  noReviewNeeded: ReviewDraft[];
  inReview: InFlightReview[];
  queued: QueuedReview[];
  attention: ReviewDraft[];
  posted: ReviewDraft[];
  discarded: ReviewDraft[];
}

export interface ReviewInlineSegment {
  text: string;
  kind: 'text' | 'code' | 'citation';
}

export type ReviewParagraph = {
  kind: 'prose';
  lead: string;
  leadKind: 'fix' | 'question' | null;
  segments: ReviewInlineSegment[];
} | {
  kind: 'code';
  language: string | null;
  code: string;
};

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
  const sections: TeamReviewSections = { ready: [], noReviewNeeded: [], inReview: [], queued: [], attention: [], posted: [], discarded: [] };
  if (!status) return sections;
  const inFlightKeys = new Set(status.inFlight.map((review) => review.key));
  sections.inReview.push(...status.inFlight);
  sections.queued.push(...status.queued.filter((review) => !inFlightKeys.has(review.key)));
  const queuedKeys = new Set(sections.queued.map((review) => review.key));
  for (const draft of status.drafts) {
    if (inFlightKeys.has(draft.key) || queuedKeys.has(draft.key)) continue;
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

export function githubReviewTone(state: GithubReviewState): StateTone {
  if (state === 'APPROVED') return 'ok';
  if (state === 'CHANGES_REQUESTED') return 'warn';
  return 'muted';
}

export function githubReviewTitle(text: string, age: string | null): string {
  return age ? `${text}, ${age}` : text;
}

export function githubReviewItems(draft: ReviewDraft, { isViewerShown = true }: { isViewerShown?: boolean } = {}): { login: string; tone: StateTone; text: string; submittedAt?: string | null }[] {
  const reviews = (draft.githubReviews ?? []).filter((review) => isViewerShown || !review.isViewer).sort((left, right) => Number(right.isViewer) - Number(left.isViewer));
  return reviews.map((review) => ({ login: review.login, tone: githubReviewTone(review.state), text: describeGithubReview(review, currentHead(draft)), submittedAt: review.submittedAt }));
}

export function hasAnyRow(sections: TeamReviewSections): boolean {
  return sections.ready.length + sections.noReviewNeeded.length + sections.inReview.length + sections.queued.length + sections.attention.length + sections.posted.length + sections.discarded.length > 0;
}

export function chooseSelectedReviewKey(sections: TeamReviewSections, selectedKey: string | null): string | null {
  const rows = [...sections.ready, ...sections.inReview, ...sections.queued, ...sections.noReviewNeeded, ...sections.attention, ...sections.posted, ...sections.discarded];
  if (selectedKey && rows.some((row) => row.key === selectedKey)) return selectedKey;
  return rows[0]?.key ?? null;
}

export function severityPresentation(severity: FindingSeverity): { filledCount: number; colorToken: string } {
  return SEVERITY_PRESENTATION[severity];
}

export function verdictSealKind(verdict: ReviewDraft['verdict']): 'check' | 'dot' | 'bar' | 'cross' {
  return VERDICT_SEALS[verdict];
}

function commentSeverities(comment: Pick<DraftComment, 'body' | 'severity'>): FindingSeverity[] {
  const headerSeverities = findingSeveritiesIn(comment.body);
  if (headerSeverities.length > 0) return headerSeverities;
  return comment.severity ? [comment.severity] : [];
}

export function commentSeverity(comment: Pick<DraftComment, 'body' | 'severity'>): FindingSeverity | null {
  const severities = commentSeverities(comment);
  return FindingSeverity.options.find((severity) => severities.includes(severity)) ?? null;
}

export function isIncludedByDefault(comment: Pick<DraftComment, 'body' | 'severity'>): boolean {
  return commentSeverity(comment) !== 'LOW';
}

export function severityCounts(draft: Pick<ReviewDraft, 'body' | 'comments'>): { severity: FindingSeverity; count: number }[] {
  const counts = new Map<FindingSeverity, number>();
  for (const severity of findingSeveritiesIn(draft.body)) counts.set(severity, (counts.get(severity) ?? 0) + 1);
  for (const comment of draft.comments) {
    for (const severity of commentSeverities(comment)) counts.set(severity, (counts.get(severity) ?? 0) + 1);
  }
  return FindingSeverity.options.flatMap((severity) => {
    const count = counts.get(severity) ?? 0;
    return count > 0 ? [{ severity, count }] : [];
  });
}

const CITABLE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'css', 'scss', 'less', 'html', 'md', 'mdx',
  'py', 'go', 'rs', 'rb', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'sql', 'vue', 'svelte', 'astro', 'lock', 'txt',
  'ex', 'exs', 'erl', 'scala', 'dart', 'lua', 'tf', 'proto', 'graphql', 'gql', 'xml', 'gradle',
]);
const PATH_WITH_LINE_RANGE = /^([\w.@~/-]+):\d+(?:-\d+)?$/;

function isCodeCitation(text: string): boolean {
  const path = PATH_WITH_LINE_RANGE.exec(text)?.[1];
  if (path === undefined) return false;
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  const extensionStart = fileName.lastIndexOf('.');
  if (extensionStart < 0) return false;
  return CITABLE_FILE_EXTENSIONS.has(fileName.slice(extensionStart + 1).toLowerCase());
}
const FENCED_CODE_BLOCK = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*(?=\r?$)/gm;

export function parseInlineSegments(value: string): ReviewInlineSegment[] {
  const segments: ReviewInlineSegment[] = [];
  let offset = 0;
  for (const match of value.matchAll(/`([^`\n]+)`/g)) {
    const matchOffset = match.index ?? 0;
    if (matchOffset > offset) segments.push({ text: value.slice(offset, matchOffset), kind: 'text' });
    const text = match[1] ?? '';
    segments.push({ text, kind: isCodeCitation(text) ? 'citation' : 'code' });
    offset = matchOffset + match[0].length;
  }
  if (offset < value.length) segments.push({ text: value.slice(offset), kind: 'text' });
  return segments;
}

function parseProseParagraphs(content: string): ReviewParagraph[] {
  return content.split(/\r?\n\s*\r?\n/).filter(Boolean).map((paragraph): ReviewParagraph => {
    const leadMatch = paragraph.match(/^(Suggested fix:|Fix:|Open question[.,:])\s*/);
    const lead = leadMatch?.[1] ?? '';
    const leadKind = lead.startsWith('Open question') ? 'question' : lead ? 'fix' : null;
    return { kind: 'prose', lead, leadKind, segments: parseInlineSegments(paragraph.slice(leadMatch?.[0].length ?? 0)) };
  });
}

export function parseReviewComment(body: string): ParsedReviewComment {
  const withoutNote = withoutAutomatedNote(body);
  const header = parseLeadingFindingHeader(withoutNote);
  const content = header ? withoutNote.slice(header.length).trim() : withoutNote;
  const paragraphs: ReviewParagraph[] = [];
  let offset = 0;
  for (const match of content.matchAll(FENCED_CODE_BLOCK)) {
    const matchOffset = match.index ?? 0;
    paragraphs.push(...parseProseParagraphs(content.slice(offset, matchOffset).trim()));
    const fenceLanguage = (match[1] ?? '').trim().split(/\s+/)[0] || null;
    paragraphs.push({ kind: 'code', language: fenceLanguage, code: (match[2] ?? '').replace(/\r?\n$/, '') });
    offset = matchOffset + match[0].length;
  }
  paragraphs.push(...parseProseParagraphs(content.slice(offset).trim()));
  return { tag: header?.reviewer ?? null, severity: header?.severity ?? null, paragraphs };
}

export function reviewCommentPreview(paragraphs: readonly ReviewParagraph[]): string {
  const firstProseParagraph = paragraphs.find((paragraph) => paragraph.kind === 'prose');
  if (!firstProseParagraph) return 'Open comment';
  const firstParagraphText = `${firstProseParagraph.lead} ${firstProseParagraph.segments.map((segment) => segment.text).join('')}`.trim();
  const sentenceEnd = firstParagraphText.search(/[.!?](?=\s|$)/);
  const preview = sentenceEnd < 0 ? firstParagraphText : firstParagraphText.slice(0, sentenceEnd + 1);
  return preview || 'Open comment';
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

export function detailMetaText(review: Pick<ReviewDraft, 'tier' | 'priorReviewedHead'>): string {
  if (review.priorReviewedHead) return `${tierLabel(review.tier)} re-review since ${review.priorReviewedHead.slice(0, 7)}`;
  return `${tierLabel(review.tier)} review`;
}

export function reviewScopeTitle(review: Pick<ReviewDraft, 'reasons'>): string {
  return review.reasons.join(', ');
}

export function coverageSummaryText(assessment: ReviewAssessment | null | undefined): string {
  if (!assessment) return 'No coverage notes';
  const checks = assessment.checked.length;
  const gaps = assessment.gaps.length;
  const parts: string[] = [];
  if (checks > 0) parts.push(`${checks} ${checks === 1 ? 'check' : 'checks'}`);
  if (gaps > 0) parts.push(`${gaps} not covered`);
  return parts.join(', ') || 'No coverage notes';
}

export function coverageDisclosureHeading(assessment: ReviewAssessment | null | undefined): { label: string; preview: string } {
  if (!assessment) return { label: 'Review audit', preview: '' };
  return { label: 'Coverage', preview: coverageSummaryText(assessment) };
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

function locationOf(path: string, comment: Pick<ReviewComment, 'line' | 'side'>): string {
  const sideSuffix = comment.side === 'LEFT' ? ' (old)' : '';
  return `${path}:${comment.line}${sideSuffix}`;
}

export function commentLocation(comment: Pick<ReviewComment, 'path' | 'line' | 'side'>): string {
  return locationOf(comment.path, comment);
}

export function shortCommentLocation(comment: Pick<ReviewComment, 'path' | 'line' | 'side'>): string {
  const fileName = comment.path.split('/').filter(Boolean).at(-1) ?? comment.path;
  return locationOf(fileName, comment);
}

export function withoutComment(comments: readonly ReviewComment[], removedIndex: number): ReviewComment[] {
  return comments.filter((_comment, index) => index !== removedIndex);
}

export function withReviewerNote(reviewerNote: string, reviewBody: string): string {
  const trimmedNote = reviewerNote.trim();
  if (!trimmedNote) return reviewBody;
  if (!reviewBody.trim()) return trimmedNote;
  return `${trimmedNote}\n\n${reviewBody}`;
}

export function buildActionRequest(draft: ReviewDraft, action: TeamReviewAction, body: string, comments: readonly ReviewComment[]): TeamReviewActionRequest {
  return { key: draft.key, head: draft.reviewedHead, action, body, comments: comments.map(({ path, line, side, body: commentBody }) => ({ path, line, side, body: commentBody })) };
}

const ACTION_LABELS: Readonly<Record<TeamReviewAction, string>> = Object.freeze({
  approve: 'Approve and comment',
  comment: 'Comment',
  discard: 'Discard',
  requeue: 'Queue review',
});

const FOLLOW_UP_APPROVE_LABEL = 'Approve';

export interface DetailActionLayout {
  footer: readonly TeamReviewAction[];
  more: readonly TeamReviewAction[];
}

export function actionLabel(draft: Pick<ReviewDraft, 'status'>, action: TeamReviewAction): string {
  if (action === 'approve' && draft.status !== 'ready') return FOLLOW_UP_APPROVE_LABEL;
  return ACTION_LABELS[action];
}

export function detailActionLayout(draft: Pick<ReviewDraft, 'status' | 'postedEvent'>): DetailActionLayout {
  if (draft.status === 'ready') return { footer: ['comment', 'approve'], more: ['requeue', 'discard'] };
  if (canApproveAfterComment(draft)) return { footer: ['approve'], more: ['requeue'] };
  if (hasRequeueFooter(draft.status)) return { footer: ['requeue'], more: [] };
  return { footer: [], more: [] };
}

export function actionProgressText(action: TeamReviewAction): string {
  return ACTION_PROGRESS_TEXT[action];
}

export function actionOutcomeText(action: TeamReviewAction): string {
  return ACTION_OUTCOME_TEXT[action];
}

export function queuedDetailText(runningCount: number): string {
  if (runningCount === 0) return 'Picked for review. It starts on the next poll.';
  const reviews = runningCount === 1 ? 'the review' : `one of the ${runningCount} reviews`;
  return `Waiting for a free review slot. It starts as soon as ${reviews} in progress finishes.`;
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
  return `${draft.key}@${draft.reviewedHead}:${draft.status}:${draft.summary}:${githubReviewItems(draft).map((review) => review.text).join(', ')}`;
}

export function detailHeadingSignature(review: ReviewDraft | InFlightReview): string {
  if (!('reviewedHead' in review)) return JSON.stringify([review.prCreatedAt, review.priorReviewedHead]);
  return JSON.stringify([review.prCreatedAt, review.reviewedAt, review.postedAt, review.githubReviews, review.liveHead, review.priorReviewedHead]);
}

export function isInFlightProgressOnlyChange(previous: TeamReviewStatus | null | undefined, next: TeamReviewStatus): boolean {
  if (!previous) return false;
  if (JSON.stringify(previous.team) !== JSON.stringify(next.team)) return false;
  if (previous.configured !== next.configured || previous.reason !== next.reason) return false;
  const previousKeys = previous.inFlight.map((review) => review.key).join('\n');
  const nextKeys = next.inFlight.map((review) => review.key).join('\n');
  if (previousKeys !== nextKeys) return false;
  if (JSON.stringify(previous.queued) !== JSON.stringify(next.queued)) return false;
  return JSON.stringify(previous.drafts) === JSON.stringify(next.drafts);
}
