import type { GithubPr } from '#shared/contracts/github-prs.ts';
import type { MyPrStage } from '#shared/contracts/my-prs.ts';
import { myPrFromGithubPr } from '#shared/my-pr-merge.ts';
import { canApproveAfterComment, decisionAsIfApprovalRequired, DECIDING_REVIEW_STATES, type FindingSeverity, hasStandingViewerApproval } from '#shared/contracts/team-review.ts';
import type {
  DraftComment, EarlierReview, GithubReview, GithubReviewState, InFlightReview, PostedReviewEvent, QueuedReview, ReviewAssessment, ReviewChecksState, ReviewComment, ReviewDraft, ReviewProgressPhase, TeamReviewAction, TeamReviewActionRequest, TeamReviewStatus, TeamReviewThread, ViewerThreadTally,
} from '#shared/contracts/team-review.ts';
import { shortSha } from '#shared/git-text.ts';
import { AUTOMATED_REVIEW_NOTE, findingSeveritiesIn, generalFindingsOf, generalPreambleOf, parseLeadingFindingHeader, strongestFindingSeverity, withoutAutomatedNote } from '#shared/team-review-markdown.ts';
import type { GeneralFinding } from '#shared/team-review-markdown.ts';
import { formatClockOffset } from '../radar/radar-core.ts';
import { stageIcon, stageLabel, stageTone } from './my-prs-view-core.ts';
import type { PrStatusIcon } from './pr-status-icon-core.ts';
import type { StateTone } from '../state-tone-core.ts';

export { generalFindingsOf } from '#shared/team-review-markdown.ts';
export type { GeneralFinding } from '#shared/team-review-markdown.ts';

type TeamReviewPrView<Review> = Review & { prStage?: MyPrStage };

export function joinTeamReviews(status: TeamReviewStatus | null, findGithubPr: (key: string) => GithubPr | undefined) {
  if (!status) return null;
  const joinReview = <Review extends ReviewDraft | InFlightReview | QueuedReview>(review: Review) => {
    const pr = findGithubPr(review.key);
    if (!pr) return review;
    return {
      ...review,
      checksState: pr.rollupState,
      reviewDecision: decisionAsIfApprovalRequired(pr.reviewDecision, pr.opinionatedWriterReviewStates),
      isDraft: pr.isDraft,
      liveHead: pr.headRefOid,
      prStage: myPrFromGithubPr(pr).stage,
    };
  };
  return {
    ...status,
    drafts: status.drafts.map(joinReview),
    inFlight: status.inFlight.map(joinReview),
    queued: status.queued.map(joinReview),
  };
}

export type QueueRowKind = 'ready' | 'settled' | 'inReview' | 'queued' | 'attention' | 'posted' | 'discarded';

type ReviewPriorityBand = 'blocking-others' | 'actionable' | 'waiting-on-author' | 'not-ready';
type ReviewPriorityReason = 'direct-request' | 'team-request' | 'changes-requested' | 'checks-failing' | 'checks-pending' | 'draft' | 'review-available' | 'approved';

const REVIEW_PRIORITY_REASON_TEXT: Readonly<Record<ReviewPriorityReason, string>> = {
  'direct-request': 'Needs you', 'team-request': 'Ready',
  'changes-requested': 'Author to fix', 'checks-failing': 'Checks failing', 'checks-pending': 'Checks running', draft: 'Draft', 'review-available': 'Ready', approved: 'Approved',
};

export function classifyReviewPriority(review: Pick<QueuedReview, 'requestSource' | 'isDraft' | 'checksState' | 'reviewDecision'>): { band: ReviewPriorityBand; reason: ReviewPriorityReason } {
  if (review.isDraft) return { band: 'not-ready', reason: 'draft' };
  if (review.reviewDecision === 'CHANGES_REQUESTED') return { band: 'waiting-on-author', reason: 'changes-requested' };
  if (review.checksState === 'FAILURE' || review.checksState === 'ERROR') return { band: 'waiting-on-author', reason: 'checks-failing' };
  if (review.checksState === 'PENDING' || review.checksState === 'EXPECTED') return { band: 'not-ready', reason: 'checks-pending' };
  if (review.requestSource === 'direct' && review.reviewDecision === 'REVIEW_REQUIRED') return { band: 'blocking-others', reason: 'direct-request' };
  if (review.reviewDecision === 'APPROVED') return { band: 'actionable', reason: 'approved' };
  return { band: 'actionable', reason: review.requestSource === 'direct' ? 'review-available' : 'team-request' };
}

interface QueueRowAges {
  opened?: string | null;
  reviewed?: string | null;
  posted?: string | null;
  githubReviews?: readonly (string | null)[];
  viewerApproval?: string | null;
}

interface PostedOutcome {
  label: string;
  tone: StateTone;
  icon: PrStatusIcon;
}

const POSTED_EVENT_OUTCOMES: Readonly<Record<PostedReviewEvent, PostedOutcome>> = {
  APPROVE: { label: 'You approved', tone: 'ok', icon: 'passed' },
  COMMENT: { label: 'You commented', tone: 'muted', icon: 'thread' },
  REQUEST_CHANGES: { label: 'You requested changes', tone: 'wait', icon: 'changes-requested' },
};

const VIEWER_REVIEW_OUTCOMES: Readonly<Record<GithubReviewState, PostedOutcome>> = {
  APPROVED: { label: 'You approved', tone: 'ok', icon: 'passed' },
  CHANGES_REQUESTED: { label: 'You requested changes', tone: 'wait', icon: 'changes-requested' },
  COMMENTED: { label: 'You commented', tone: 'muted', icon: 'thread' },
};

function postedOutcome(draft: ReviewDraft): PostedOutcome | null {
  const viewerReviews = (draft.githubReviews ?? []).filter((review) => review.isViewer);
  const latestViewerReview = viewerReviews.sort((left, right) => (Date.parse(right.submittedAt ?? '') || 0) - (Date.parse(left.submittedAt ?? '') || 0)).at(0);
  if (!draft.postedEvent) return latestViewerReview ? VIEWER_REVIEW_OUTCOMES[latestViewerReview.state] : null;
  if (!latestViewerReview) return POSTED_EVENT_OUTCOMES[draft.postedEvent];
  const latestViewerReviewAtMs = Date.parse(latestViewerReview.submittedAt ?? '');
  const isPostedEventNewer = Number.isNaN(latestViewerReviewAtMs) || (draft.postedAt !== undefined && draft.postedAt > latestViewerReviewAtMs);
  if (isPostedEventNewer) return POSTED_EVENT_OUTCOMES[draft.postedEvent];
  return VIEWER_REVIEW_OUTCOMES[latestViewerReview.state];
}

interface QueueRowGlyph {
  tone: StateTone;
  icon: PrStatusIcon;
  meaning: string;
}

const EXCEPTION_REASON_ICONS: Readonly<Partial<Record<ReviewPriorityReason, PrStatusIcon>>> = {
  'changes-requested': 'changes-requested', 'checks-failing': 'failed', 'checks-pending': 'running', draft: 'draft',
};

type ExceptionReviewFields = Pick<QueuedReview, 'requestSource' | 'isDraft' | 'checksState' | 'reviewDecision'>;

function queueRowException(review: ExceptionReviewFields): { text: string; icon: PrStatusIcon } | null {
  const { reason } = classifyReviewPriority(review);
  const icon = EXCEPTION_REASON_ICONS[reason];
  return icon ? { text: REVIEW_PRIORITY_REASON_TEXT[reason], icon } : null;
}

function queueRowExceptionReason(review: ExceptionReviewFields): string | null {
  return queueRowException(review)?.text ?? null;
}

const FIXED_ROW_GLYPHS: Readonly<Partial<Record<QueueRowKind, QueueRowGlyph>>> = {
  discarded: { tone: 'muted', icon: 'discarded', meaning: 'Not mine' },
};

function withExceptionReason(stateWord: string, review: Parameters<typeof queueRowExceptionReason>[0]): string {
  const exceptionReason = queueRowExceptionReason(review);
  return exceptionReason ? `${stateWord}, ${exceptionReason}` : stateWord;
}

function isViewerOutcomeCurrent(draft: ReviewDraft): boolean {
  if (hasStandingViewerApproval(draft)) return true;
  const viewerReviews = (draft.githubReviews ?? []).filter((review) => review.isViewer);
  if (viewerReviews.length === 0) return true;
  return viewerReviews.some((review) => review.commit === currentHead(draft));
}

const COMMENTS_RESOLVED_GLYPH: QueueRowGlyph = { tone: 'warn', icon: 'your-turn', meaning: 'Comments resolved' };

export function queueRowGlyph(review: TeamReviewPrView<ReviewDraft | InFlightReview | QueuedReview>, kind: QueueRowKind): QueueRowGlyph {
  if (review.prStage) return { tone: stageTone(review.prStage), icon: stageIcon(review.prStage), meaning: stageLabel(review.prStage) };
  const fixedGlyph = FIXED_ROW_GLYPHS[kind];
  if (fixedGlyph) return fixedGlyph;
  if (kind === 'inReview') return { tone: 'wait', icon: 'running', meaning: withExceptionReason('In review', review) };
  if (kind === 'queued') return { tone: 'muted', icon: 'queued', meaning: withExceptionReason('Queued', review) };
  if (kind === 'settled' && 'reviewedHead' in review) {
    const outcome = isViewerOutcomeCurrent(review) ? postedOutcome(review) : null;
    return outcome ? { tone: outcome.tone, icon: outcome.icon, meaning: outcome.label } : { tone: 'ok', icon: 'passed', meaning: 'Others reviewed' };
  }
  if (kind === 'posted' && 'reviewedHead' in review) {
    const outcome = postedOutcome(review);
    return outcome ? { tone: outcome.tone, icon: outcome.icon, meaning: outcome.label } : { tone: 'muted', icon: 'none', meaning: 'Posted' };
  }
  if (kind === 'attention' && 'status' in review) return review.status === 'error' ? { tone: 'danger', icon: 'failed', meaning: 'Review failed' } : { tone: 'warn', icon: 'stale', meaning: 'Out of date' };
  const exception = queueRowException(review);
  if (exception) return { tone: 'wait', icon: exception.icon, meaning: exception.text };
  if (kind === 'ready' && 'reviewedHead' in review && isAwaitingViewerAfterResolvedComments(review)) return COMMENTS_RESOLVED_GLYPH;
  return { tone: 'warn', icon: 'your-turn', meaning: 'Waits on you' };
}

export function hasAllViewerThreadsResolved(draft: Pick<ReviewDraft, 'viewerThreads'>): boolean {
  const tally = draft.viewerThreads;
  return tally !== undefined && tally.total > 0 && tally.resolved === tally.total;
}

export function isPostedAwaitingViewer(draft: ReviewDraft): boolean {
  return draft.status === 'posted' && isAwaitingViewerAfterResolvedComments(draft);
}

function isAwaitingViewerAfterResolvedComments(draft: ReviewDraft): boolean {
  if (!hasAllViewerThreadsResolved(draft)) return false;
  if (hasStandingViewerApproval(draft)) return false;
  const head = currentHead(draft);
  if (draft.status === 'posted' && draft.postedEvent === 'APPROVE' && draft.reviewedHead === head) return false;
  return !(draft.githubReviews ?? []).some((review) => review.isViewer && review.state === 'APPROVED' && review.commit === head);
}

export function viewerThreadsText(tally: ViewerThreadTally | undefined): string | null {
  if (!tally || tally.total === 0) return null;
  if (tally.total === 1) return tally.resolved === 1 ? 'Your 1 comment resolved' : 'Your 1 comment unresolved';
  if (tally.resolved === tally.total) return `All ${tally.total} of your comments resolved`;
  return `${tally.resolved} of ${tally.total} of your comments resolved`;
}

export function commentCountText(count: number): string {
  return `${count} ${count === 1 ? 'comment' : 'comments'}`;
}

export function queueRowTitle(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind, ages: QueueRowAges): string {
  const lines = [`${pullRequestLabel(review.repo, review.number)}: ${review.title}`];
  const goal = 'reviewedHead' in review ? review.assessment?.goal.trim() : '';
  if (goal) lines.push(goal);
  lines.push(queueRowGlyph(review, kind).meaning);
  if (ages.opened) lines.push(`Opened ${ages.opened}`);
  if (ages.reviewed) lines.push(`Reviewed ${ages.reviewed}`);
  if (ages.posted) lines.push(`Posted ${ages.posted}`);
  if (!('reviewedHead' in review)) return lines.join('\n');
  const viewerThreadText = viewerThreadsText(review.viewerThreads);
  if (viewerThreadText) lines.push(viewerThreadText);
  const commentCount = review.comments.length;
  if (review.status !== 'error') lines.push(`Automated review: ${queueRowVerdictLabel(review.verdict)}, ${commentCountText(commentCount)}`);
  const approvalContext = viewerApprovalContext(review);
  if (approvalContext) lines.push(`You ${GITHUB_REVIEW_VERBS[approvalContext.state]} at ${shortSha(approvalContext.approvedCommit)}${ages.viewerApproval ? ` ${ages.viewerApproval}` : ''}; new commits since.`);
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

interface ActionReplyPlan {
  statusText: string;
  tone: 'ok' | 'error';
  shouldAdvance: boolean;
  receipt: string | null;
}

function asSentence(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
}

const POSTING_ACTIONS: ReadonlySet<TeamReviewAction> = new Set(['approve', 'approve-only', 'comment', 'request-changes']);

export function planActionReply({ action, outcomeText, pullRequest, warning, isActedSelected }: { action: TeamReviewAction; outcomeText: string; pullRequest: string; warning: string; isActedSelected: boolean }): ActionReplyPlan {
  if (warning.trim()) return { statusText: `${asSentence(outcomeText)} ${asSentence(warning)}`, tone: 'error', shouldAdvance: false, receipt: null };
  const isPostAdvance = isActedSelected && POSTING_ACTIONS.has(action);
  return { statusText: outcomeText, tone: 'ok', shouldAdvance: isActedSelected, receipt: isPostAdvance ? `Posted to ${pullRequest}: ${asSentence(outcomeText)}` : null };
}

export function queueRowRefLabel(repo: string, number: number, hasMultipleRepos: boolean): string {
  if (hasMultipleRepos) return pullRequestLabel(repo, number);
  return `#${number}`;
}

interface ReviewInlineSegment {
  text: string;
  kind: 'text' | 'code' | 'citation';
}

type ReviewParagraph = {
  kind: 'prose';
  lead: string;
  leadKind: 'fix' | 'question' | null;
  segments: ReviewInlineSegment[];
} | {
  kind: 'code';
  language: string | null;
  code: string;
};

interface ParsedReviewComment {
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

const QUEUE_ROW_VERDICT_LABELS: Readonly<Record<ReviewDraft['verdict'], string>> = {
  APPROVE: 'Approve',
  'APPROVE WITH NITS': 'Nits',
  'REQUEST CHANGES': 'Changes',
  BLOCKED: 'Blocked',
};

function queueRowVerdictLabel(verdict: ReviewDraft['verdict']): string {
  return QUEUE_ROW_VERDICT_LABELS[verdict];
}

const VERDICT_TONES: Readonly<Record<ReviewDraft['verdict'], string>> = Object.freeze({
  APPROVE: 'ok',
  'APPROVE WITH NITS': 'info',
  'REQUEST CHANGES': 'warn',
  BLOCKED: 'crit',
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
  'approve-only': 'Approved on GitHub',
  comment: 'Comment posted on GitHub',
  'request-changes': 'Changes requested on GitHub',
  discard: 'Marked not mine. Not reviewed again until you re-run it.',
  requeue: 'Queued. The review starts as soon as a slot is free.',
  'resolve-thread': 'Thread resolved on GitHub',
});

const ACTION_PROGRESS_TEXT: Readonly<Record<TeamReviewAction, string>> = Object.freeze({
  approve: 'Posting the approval',
  'approve-only': 'Posting the approval',
  comment: 'Posting the comment',
  'request-changes': 'Requesting changes',
  discard: 'Marking not mine',
  requeue: 'Queueing the review',
  'resolve-thread': 'Resolving thread',
});

export function groupDrafts(status: TeamReviewStatus | null | undefined): TeamReviewSections {
  const sections: TeamReviewSections = { ready: [], noReviewNeeded: [], inReview: [], queued: [], attention: [], posted: [], discarded: [] };
  if (!status) return sections;
  const readyByBand: Record<ReviewPriorityBand, ReviewDraft[]> = { 'blocking-others': [], actionable: [], 'waiting-on-author': [], 'not-ready': [] };
  const queuedByBand: Record<ReviewPriorityBand, QueuedReview[]> = { 'blocking-others': [], actionable: [], 'waiting-on-author': [], 'not-ready': [] };
  const bandOrder: ReviewPriorityBand[] = ['blocking-others', 'actionable', 'waiting-on-author', 'not-ready'];
  const inFlightKeys = new Set(status.inFlight.map((review) => review.key));
  sections.inReview.push(...status.inFlight);
  for (const review of status.queued) {
    if (inFlightKeys.has(review.key)) continue;
    queuedByBand[classifyReviewPriority(review).band].push(review);
  }
  for (const band of bandOrder) sections.queued.push(...queuedByBand[band]);
  const queuedKeys = new Set(sections.queued.map((review) => review.key));
  for (const draft of status.drafts) {
    if (inFlightKeys.has(draft.key) || queuedKeys.has(draft.key)) continue;
    if (answeredNonNitThreads(draft).length > 0 || isPostedAwaitingViewer(draft)) {
      readyByBand.actionable.push(draft);
      continue;
    }
    const isSettled = (draft.status === 'ready' || draft.status === 'stale' || draft.status === 'error') && !isReviewNeeded(draft);
    if (isSettled) sections.noReviewNeeded.push(draft);
    if (draft.status === 'ready' && !isSettled) readyByBand[classifyReviewPriority(draft).band].push(draft);
    if ((draft.status === 'stale' || draft.status === 'error') && !isSettled) sections.attention.push(draft);
    if (draft.status === 'posted') sections.posted.push(draft);
    if (draft.status === 'discarded') sections.discarded.push(draft);
  }
  for (const band of bandOrder) sections.ready.push(...readyByBand[band]);
  return sections;
}

function settlesReview(review: GithubReview, head: string): boolean {
  if (review.commit !== head) return false;
  return review.isViewer || DECIDING_REVIEW_STATES.has(review.state);
}

function currentHead(draft: ReviewDraft): string {
  return draft.liveHead ?? draft.reviewedHead;
}

export function answeredNonNitThreads(draft: Pick<ReviewDraft, 'threads'>): TeamReviewThread[] {
  return (draft.threads ?? []).filter((thread) => !thread.isNit && !thread.isResolved);
}

function threadJudgement(thread: TeamReviewThread, head: string): { label: string; reason: string; tone: 'ok' | 'warn' | 'muted' } {
  if (thread.isNit) return { label: 'Automatic resolution failed', reason: '', tone: 'warn' };
  const judgement = thread.judgement?.head === head && thread.judgement.lastReplyAt === thread.lastReplyAt ? thread.judgement : undefined;
  if (judgement) return { label: judgement.addressed ? 'Addressed' : 'Not addressed', reason: judgement.reason, tone: judgement.addressed ? 'ok' : 'warn' };
  const unjudgeable = thread.unjudgeable?.head === head && thread.unjudgeable.lastReplyAt === thread.lastReplyAt ? thread.unjudgeable : undefined;
  if (unjudgeable) return { label: 'Auto-check skipped', reason: unjudgeable.reason, tone: 'muted' };
  return { label: 'Auto-check pending', reason: '', tone: 'muted' };
}

export function detailThreadItems(draft: ReviewDraft) {
  return (draft.threads ?? []).filter((thread) => !thread.isResolved && (!thread.isNit || thread.resolveError)).map((thread) => {
    const judgement = threadJudgement(thread, currentHead(draft));
    return {
      thread, location: thread.line === null ? thread.path : `${thread.path}:${thread.line}`,
      judgementLabel: judgement.label, judgementReason: judgement.reason, judgementTone: judgement.tone,
      judgementText: judgement.reason ? `${judgement.label}: ${judgement.reason}` : judgement.label,
      canResolve: thread.viewerCanResolve,
    };
  });
}

export const THREAD_REPLY_PREVIEW_LINES = 8;
export const THREAD_COMMENT_PREVIEW_LINES = 3;
const NARROWEST_THREAD_LINE_CHARS = 40;

export function threadBodyOverflowsPreview(body: string, previewLines: number): boolean {
  const wrappedLineCount = body.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / NARROWEST_THREAD_LINE_CHARS)), 0);
  return wrappedLineCount > previewLines;
}

function isReviewNeeded(draft: ReviewDraft): boolean {
  if (answeredNonNitThreads(draft).length > 0) return true;
  if (hasStandingViewerApproval(draft)) return false;
  if (isAwaitingViewerAfterResolvedComments(draft)) return true;
  return !(draft.githubReviews ?? []).some((review) => settlesReview(review, currentHead(draft)));
}

function describeGithubReview(review: GithubReview, head: string): string {
  const verb = GITHUB_REVIEW_VERBS[review.state];
  if (!review.isViewer) return `${verb} by ${review.login}`;
  if (review.commit === head) return `you ${verb}`;
  return `you ${verb} (older commit)`;
}

interface ViewerApprovalContext {
  approvedCommit: string;
  submittedAt: GithubReview['submittedAt'];
  state: 'APPROVED' | 'CHANGES_REQUESTED';
  isReviewScopeSinceDecision: boolean;
}

export function viewerApprovalContext(draft: ReviewDraft): ViewerApprovalContext | null {
  if (hasStandingViewerApproval(draft)) return null;
  const decidingReviews = (draft.githubReviews ?? []).filter((review) => review.isViewer && DECIDING_REVIEW_STATES.has(review.state));
  const latestReview = decidingReviews.sort((left, right) => (Date.parse(right.submittedAt ?? '') || 0) - (Date.parse(left.submittedAt ?? '') || 0)).at(0);
  if (!latestReview?.commit || latestReview.commit === currentHead(draft)) return null;
  if (latestReview.state === 'COMMENTED') return null;
  const decidedAtMs = Date.parse(latestReview.submittedAt ?? '');
  if (draft.reviewedAt !== undefined && decidedAtMs > draft.reviewedAt) return null;
  return { approvedCommit: latestReview.commit, submittedAt: latestReview.submittedAt, state: latestReview.state, isReviewScopeSinceDecision: draft.priorReviewedHead === latestReview.commit };
}

export function viewerApprovalNotice(context: ViewerApprovalContext, age: string | null): string {
  const action = context.state === 'APPROVED' ? 'approved this' : 'requested changes';
  const previousReview = context.state === 'APPROVED' ? 'your approval' : 'your request for changes';
  const decision = `You ${action} at ${shortSha(context.approvedCommit)}${age ? ` ${age}` : ''}. It has new commits since`;
  if (!context.isReviewScopeSinceDecision) return `${decision}.`;
  return `${decision}, so this review covers what changed after ${previousReview}.`;
}

function githubReviewTone(state: GithubReviewState): StateTone {
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
  return strongestFindingSeverity(commentSeverities(comment));
}

export function isSeverityIncludedByDefault(severity: FindingSeverity | null): boolean {
  return severity !== 'LOW';
}

export function isIncludedByDefault(comment: Pick<DraftComment, 'body' | 'severity'>): boolean {
  return isSeverityIncludedByDefault(commentSeverity(comment));
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

export function reviewProgressSteps(phase: ReviewProgressPhase): { label: string; state: 'done' | 'active' | 'todo' }[] {
  const labels = ['Fetch the diff', 'Check out the head', 'Review', 'Draft ready'];
  const activeIndex = { preparing: 0, checkout: 1, reviewing: 2 }[phase];
  return labels.map((label, index) => ({ label, state: index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'todo' }));
}

export function pullRequestLabel(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function tierLabel(tier: ReviewDraft['tier']): string {
  return tier === 'full' ? 'full' : 'light';
}

export function detailMetaText(review: Pick<ReviewDraft, 'tier' | 'priorReviewedHead'>): string {
  if (review.priorReviewedHead) return `${tierLabel(review.tier)} review of changes since ${shortSha(review.priorReviewedHead)}`;
  return `${tierLabel(review.tier)} review`;
}

export function reviewScopeTitle(review: Pick<ReviewDraft, 'reasons'>): string {
  return review.reasons.join(', ');
}

export function aboutPrParagraphs(assessment: ReviewAssessment | null | undefined): { kind: 'goal' | 'change'; text: string }[] {
  if (!assessment) return [];
  const paragraphs: { kind: 'goal' | 'change'; text: string }[] = [];
  const goal = assessment.goal.trim();
  const change = assessment.change.trim();
  if (goal) paragraphs.push({ kind: 'goal', text: goal });
  if (change) paragraphs.push({ kind: 'change', text: change });
  return paragraphs;
}

export const LEGACY_SUMMARY_HINT = 'This review ran before plain summaries existed, so only its verdict and findings remain. Re-run review to get a plain summary.';

const REQUEUEABLE_STATUSES: ReadonlySet<ReviewDraft['status']> = new Set(['error', 'stale', 'discarded', 'posted']);

export function hasRequeueFooter(status: ReviewDraft['status']): boolean {
  return REQUEUEABLE_STATUSES.has(status);
}

function movedHead(draft: Pick<ReviewDraft, 'reviewedHead' | 'liveHead'>): string | null {
  return draft.liveHead && draft.liveHead !== draft.reviewedHead ? draft.liveHead : null;
}

export function changedSinceReviewText(draft: Pick<ReviewDraft, 'reviewedHead' | 'liveHead'>): string | null {
  const liveHead = movedHead(draft);
  return liveHead ? `Reviewed at ${shortSha(draft.reviewedHead)}. The pull request is now at ${shortSha(liveHead)}.` : null;
}

export function changedSinceReviewUrl(draft: Pick<ReviewDraft, 'repo' | 'reviewedHead' | 'liveHead'>): string | null {
  const liveHead = movedHead(draft);
  return liveHead ? `https://github.com/${draft.repo}/compare/${draft.reviewedHead}...${liveHead}` : null;
}

export function earlierReviewPreview(review: EarlierReview): string {
  const parts = [`at ${shortSha(review.head)}`, commentCountText(review.comments.length)];
  if (review.wasPosted) parts.push('posted');
  return parts.join(', ');
}

export function verdictHeading(verdict: ReviewDraft['verdict']): string {
  const label = verdictLabel(verdict);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function verdictLabel(verdict: ReviewDraft['verdict']): string {
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
  const remainingMs = review.deadlineAt === null ? 0 : review.deadlineAt - nowMs;
  if (remainingMs > 0) parts.push(`times out in ${formatClockOffset(remainingMs)}`);
  if (review.phase === 'reviewing') parts.push(`${review.toolCalls} ${review.toolCalls === 1 ? 'tool call' : 'tool calls'}`);
  return parts.join(', ');
}

export function attentionDetail(draft: ReviewDraft): string {
  if (draft.status === 'stale' && draft.earlierReview) return 'Out of date. New commits landed after this review, so its findings may not match the code any more. Automatic review runs after the configured wait; Re-run review starts it now and hands it these findings.';
  if (draft.status === 'stale') return 'Out of date. New commits landed after this review, so its findings may not match the code any more. Automatic review runs after the configured wait; Re-run review starts it now.';
  if (draft.status === 'discarded') return 'Marked not mine. Not reviewed again until you re-run it.';
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

function withReviewerNote(reviewerNote: string, reviewBody: string): string {
  const trimmedNote = reviewerNote.trim();
  if (!trimmedNote) return reviewBody;
  if (!reviewBody.trim()) return trimmedNote;
  return `${trimmedNote}\n\n${reviewBody}`;
}

export function buildNotMineRequest(key: string): TeamReviewActionRequest {
  return { key, action: 'discard', body: '', comments: [] };
}

export function buildActionRequest(draft: ReviewDraft, action: TeamReviewAction, body: string, comments: readonly ReviewComment[], threadId?: string): TeamReviewActionRequest {
  if (action === 'approve-only') return { key: draft.key, head: draft.reviewedHead, action, body: '', comments: [] };
  return { key: draft.key, head: draft.reviewedHead, action, body, ...(threadId ? { threadId } : {}), comments: comments.map(({ path, line, side, body: commentBody }) => ({ path, line, side, body: commentBody })) };
}

export interface ReviewSelection {
  note: string;
  comments: readonly DraftComment[];
  generalFindings: readonly GeneralFinding[];
}

export function hasSelection(selection: ReviewSelection): boolean {
  return selection.note.trim() !== '' || selection.comments.length > 0 || selection.generalFindings.length > 0;
}

type ReadyDecisionControl = 'approve' | 'comment' | 'request-changes';

export function buildReadyDecisionRequest(draft: ReviewDraft, control: ReadyDecisionControl, selection: ReviewSelection): TeamReviewActionRequest {
  if (control === 'approve' && !hasSelection(selection)) return buildActionRequest(draft, 'approve-only', '', []);
  const body = withReviewerNote(selection.note, [AUTOMATED_REVIEW_NOTE, generalPreambleOf(draft.body), ...selection.generalFindings.map((finding) => finding.markdown)].filter(Boolean).join('\n\n'));
  return buildActionRequest(draft, control, body, selection.comments);
}

function selectionParts(selection: ReviewSelection): string {
  const findingCount = selection.comments.length + selection.generalFindings.length;
  const parts = [selection.note.trim() ? 'your note' : '', findingCount ? `${findingCount} ${findingCount === 1 ? 'finding' : 'findings'}` : ''];
  return parts.filter(Boolean).join(' and ');
}

interface PostingPreview {
  event: string;
  detail: string;
}

function inlineCommentText(count: number): string {
  return `${count} inline ${count === 1 ? 'comment' : 'comments'}`;
}

export function postingPreview(draft: Pick<ReviewDraft, 'reviewedHead'>, selection: ReviewSelection, control: ReadyDecisionControl): PostingPreview {
  const event = actionLabel(control);
  if (!hasSelection(selection)) {
    return { event, detail: isSelectionRequired(control) ? 'Needs a ticked finding or a note.' : `A bare approval at ${shortSha(draft.reviewedHead)}, with no note or comments.` };
  }
  const parts = [
    selection.note.trim() ? 'your note' : 'no note',
    ...(selection.comments.length > 0 ? [inlineCommentText(selection.comments.length)] : []),
    ...(selection.generalFindings.length > 0 ? [`${selection.generalFindings.length} in the review body`] : []),
  ];
  return { event, detail: `${parts.join(', ')}, at ${shortSha(draft.reviewedHead)}.` };
}

export function postedOutcomeText(action: TeamReviewAction, selection: ReviewSelection): string {
  const parts = selectionParts(selection);
  if (action === 'approve' && parts) return `Approved on GitHub with ${parts}`;
  if (action === 'comment' && parts) return `Commented on GitHub with ${parts}`;
  if (action === 'request-changes' && parts) return `Requested changes on GitHub with ${parts}`;
  return actionOutcomeText(action);
}

const ACTION_LABELS: Readonly<Record<TeamReviewAction, string>> = Object.freeze({
  approve: 'Approve',
  'approve-only': 'Approve',
  comment: 'Comment',
  'request-changes': 'Request changes',
  discard: 'Not mine',
  requeue: 'Re-run review',
  'resolve-thread': 'Resolve',
});

interface DetailActionLayout {
  primary: readonly TeamReviewAction[];
  secondary: readonly TeamReviewAction[];
}

export function actionLabel(action: TeamReviewAction): string {
  return ACTION_LABELS[action];
}

const CHANGES_LEAD_VERDICTS: ReadonlySet<ReviewDraft['verdict']> = new Set(['REQUEST CHANGES', 'BLOCKED']);

function readyDecisionOrder(verdict: ReviewDraft['verdict']): readonly ReadyDecisionControl[] {
  return CHANGES_LEAD_VERDICTS.has(verdict) ? ['request-changes', 'approve', 'comment'] : ['approve', 'comment', 'request-changes'];
}

export function leadingDecision(verdict: ReviewDraft['verdict']): ReadyDecisionControl {
  return CHANGES_LEAD_VERDICTS.has(verdict) ? 'request-changes' : 'approve';
}

export function verdictRecommendation(verdict: ReviewDraft['verdict']): string {
  return `Agent recommends: ${actionLabel(leadingDecision(verdict)).toLowerCase()}`;
}

const AGENT_TEXT_SEPARATOR = ` ${String.fromCharCode(0xb7)} `;

export function queueRowAgentText(draft: Pick<ReviewDraft, 'verdict' | 'comments' | 'body'>): string {
  const action = `Agent: ${actionLabel(leadingDecision(draft.verdict)).toLowerCase()}`;
  const postedSeverities = [
    ...draft.comments.filter(isIncludedByDefault).map(commentSeverity),
    ...generalFindingsOf(draft.body).map((finding) => finding.severity).filter(isSeverityIncludedByDefault),
  ];
  if (postedSeverities.length === 0) return `${action}${AGENT_TEXT_SEPARATOR}no findings`;
  const strongest = strongestFindingSeverity(postedSeverities.flatMap((severity) => (severity ? [severity] : [])));
  const count = `${postedSeverities.length} ${postedSeverities.length === 1 ? 'finding' : 'findings'}`;
  return `${action}${AGENT_TEXT_SEPARATOR}${strongest ? `${count}, top ${strongest.toLowerCase()}` : count}`;
}

const CHECKS_TEXT: Readonly<Record<ReviewChecksState, string>> = Object.freeze({ SUCCESS: 'Passing', FAILURE: 'Failing', ERROR: 'Failing', PENDING: 'Running', EXPECTED: 'Running' });

export function checksText(checksState: ReviewDraft['checksState']): string {
  return checksState ? CHECKS_TEXT[checksState] : 'None reported';
}

export function isSelectionRequired(control: string | undefined): boolean {
  return control === 'comment' || control === 'request-changes';
}

export function detailActionLayout(draft: Pick<ReviewDraft, 'status' | 'postedEvent' | 'verdict'>): DetailActionLayout {
  if (draft.status === 'ready') return { primary: readyDecisionOrder(draft.verdict), secondary: ['requeue', 'discard'] };
  if (canApproveAfterComment(draft)) return { primary: ['approve-only'], secondary: ['requeue'] };
  if (draft.status === 'error' || draft.status === 'stale') return { primary: ['requeue'], secondary: ['discard'] };
  if (hasRequeueFooter(draft.status)) return { primary: ['requeue'], secondary: [] };
  return { primary: [], secondary: [] };
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
  if (status.error) return 'Review drafts will show here once GitHub answers.';
  return 'No review drafts yet. New teammate pull requests show up here after the next poll.';
}

export function laneNotice(status: TeamReviewStatus | null | undefined): string | null {
  if (!status?.configured) return null;
  return status.reason || null;
}

export function readyRowSignature(draft: ReviewDraft): string {
  return `${draft.key}@${draft.reviewedHead}:${draft.status}:${draft.summary}:${githubReviewItems(draft).map((review) => review.text).join(', ')}`;
}

export function detailHeadingSignature(review: ReviewDraft | InFlightReview): string {
  if (!('reviewedHead' in review)) return JSON.stringify([review.prCreatedAt, review.priorReviewedHead]);
  return JSON.stringify([review.prCreatedAt, review.reviewedAt, review.postedAt, review.githubReviews, review.liveHead, review.priorReviewedHead, review.viewerThreads]);
}

