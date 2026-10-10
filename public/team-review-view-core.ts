import { canApproveAfterComment, DECIDING_REVIEW_STATES, FindingSeverity, hasStandingViewerApproval } from '#shared/contracts/team-review.ts';
import type {
  DraftComment, GithubReview, GithubReviewState, InFlightReview, PostedReviewEvent, QueuedReview, ReviewAssessment, ReviewComment, ReviewDraft, ReviewProgressPhase, TeamReviewAction, TeamReviewActionRequest, TeamReviewStatus, TeamReviewThread, ViewerThreadTally,
} from '#shared/contracts/team-review.ts';
import { shortSha } from '#shared/git-text.ts';
import { findingSeveritiesIn, parseLeadingFindingHeader, withoutAutomatedNote } from '#shared/team-review-markdown.ts';
import { attentionSignature } from './attention-ack-core.ts';
import { formatClockOffset } from './radar-core.ts';
import type { PrStatusIcon } from './pr-status-icon-core.ts';
import type { StateTone } from './state-tone-core.ts';

export type QueueRowKind = 'ready' | 'settled' | 'inReview' | 'queued' | 'attention' | 'posted' | 'discarded' | 'handReview';

type ReviewPriorityBand = 'blocking-others' | 'actionable' | 'waiting-on-author' | 'not-ready';
type ReviewPriorityReason = 'direct-request' | 'team-request' | 'changes-requested' | 'checks-failing' | 'checks-pending' | 'draft' | 'review-available' | 'approved';

export const REVIEW_PRIORITY_REASON_TEXT: Readonly<Record<ReviewPriorityReason, string>> = {
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

export interface QueueRowAges {
  opened?: string | null;
  reviewed?: string | null;
  posted?: string | null;
  githubReviews?: readonly (string | null)[];
  viewerApproval?: string | null;
}

export interface PostedOutcome {
  label: string;
  tone: StateTone;
  icon: PrStatusIcon;
}

const POSTED_EVENT_OUTCOMES: Readonly<Record<PostedReviewEvent, PostedOutcome>> = {
  APPROVE: { label: 'You approved', tone: 'ok', icon: 'passed' },
  COMMENT: { label: 'You commented', tone: 'muted', icon: 'thread' },
};

const VIEWER_REVIEW_OUTCOMES: Readonly<Record<GithubReviewState, PostedOutcome>> = {
  APPROVED: { label: 'You approved', tone: 'ok', icon: 'passed' },
  CHANGES_REQUESTED: { label: 'You requested changes', tone: 'wait', icon: 'changes-requested' },
  COMMENTED: { label: 'You commented', tone: 'muted', icon: 'thread' },
};

export function postedOutcome(draft: ReviewDraft): PostedOutcome | null {
  const viewerReviews = (draft.githubReviews ?? []).filter((review) => review.isViewer);
  const latestViewerReview = viewerReviews.sort((left, right) => (Date.parse(right.submittedAt ?? '') || 0) - (Date.parse(left.submittedAt ?? '') || 0)).at(0);
  if (!draft.postedEvent) return latestViewerReview ? VIEWER_REVIEW_OUTCOMES[latestViewerReview.state] : null;
  if (!latestViewerReview) return POSTED_EVENT_OUTCOMES[draft.postedEvent];
  const latestViewerReviewAtMs = Date.parse(latestViewerReview.submittedAt ?? '');
  const isPostedEventNewer = Number.isNaN(latestViewerReviewAtMs) || (draft.postedAt !== undefined && draft.postedAt > latestViewerReviewAtMs);
  if (isPostedEventNewer) return POSTED_EVENT_OUTCOMES[draft.postedEvent];
  return VIEWER_REVIEW_OUTCOMES[latestViewerReview.state];
}

export interface QueueRowGlyph {
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

export function queueRowExceptionReason(review: ExceptionReviewFields): string | null {
  return queueRowException(review)?.text ?? null;
}

const FIXED_ROW_GLYPHS: Readonly<Partial<Record<QueueRowKind, QueueRowGlyph>>> = {
  discarded: { tone: 'muted', icon: 'discarded', meaning: 'Discarded' },
  handReview: { tone: 'warn', icon: 'fork', meaning: 'From a fork' },
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

export function queueRowGlyph(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind): QueueRowGlyph {
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

export function isAwaitingViewerAfterResolvedComments(draft: ReviewDraft): boolean {
  if (!hasAllViewerThreadsResolved(draft)) return false;
  if (hasStandingViewerApproval(draft)) return false;
  const head = currentHead(draft);
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
  handReview: QueuedReview[];
  attention: ReviewDraft[];
  posted: ReviewDraft[];
  discarded: ReviewDraft[];
}

export function caughtUpDetail(sections: TeamReviewSections): string | null {
  if (sections.ready.length + sections.attention.length + sections.handReview.length > 0) return null;
  const runningCount = sections.inReview.length + sections.queued.length;
  if (runningCount === 0) return 'Nothing needs you right now.';
  return `Nothing needs you right now. ${runningCount} ${runningCount === 1 ? 'review is' : 'reviews are'} still running.`;
}

export interface CaughtUpSelectionView {
  title: string;
  detail: string;
}

export function caughtUpSelectionView(sections: TeamReviewSections, actedKey: string | null): CaughtUpSelectionView {
  const waitingCount = [...sections.ready, ...sections.attention].filter((review) => review.key !== actedKey).length;
  if (waitingCount > 0) return { title: 'New pull requests need you', detail: 'Pick one from the queue.' };
  const handReviewCount = sections.handReview.length;
  if (handReviewCount > 0) return { title: 'Drafts all handled', detail: `${handReviewCount} ${handReviewCount === 1 ? 'pull request needs' : 'pull requests need'} review by hand.` };
  return { title: 'All caught up', detail: caughtUpDetail({ ...sections, ready: [], attention: [] }) ?? '' };
}

export interface ActionReplyNotice {
  text: string;
  tone: 'ok' | 'error';
}

export interface ActionReplyPlan {
  statusText: string;
  shouldAdvance: boolean;
  notice: ActionReplyNotice | null;
}

function asSentence(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
}

export function planActionReply({ action, pullRequest, warning, isActedSelected }: { action: TeamReviewAction; pullRequest: string; warning: string; isActedSelected: boolean }): ActionReplyPlan {
  const statusText = actionOutcomeText(action);
  const outcome = `${pullRequest}: ${asSentence(statusText)}`;
  if (warning.trim()) return { statusText, shouldAdvance: false, notice: { text: `${outcome} ${asSentence(warning)}`, tone: 'error' } };
  if (!isActedSelected) return { statusText, shouldAdvance: false, notice: null };
  return { statusText, shouldAdvance: true, notice: { text: outcome, tone: 'ok' } };
}

export function hasMultipleQueueRepos(sections: TeamReviewSections): boolean {
  const reviews = [...sections.ready, ...sections.noReviewNeeded, ...sections.inReview, ...sections.queued, ...sections.handReview, ...sections.attention, ...sections.posted, ...sections.discarded];
  const repos = new Set(reviews.map((review) => review.repo));
  return repos.size > 1;
}

export function queueRowRefLabel(repo: string, number: number, hasMultipleRepos: boolean): string {
  if (hasMultipleRepos) return pullRequestLabel(repo, number);
  return `#${number}`;
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

const QUEUE_ROW_VERDICT_LABELS: Readonly<Record<ReviewDraft['verdict'], string>> = {
  APPROVE: 'Approve',
  'APPROVE WITH NITS': 'Nits',
  'REQUEST CHANGES': 'Changes',
  BLOCKED: 'Blocked',
};

export function queueRowVerdictLabel(verdict: ReviewDraft['verdict']): string {
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
  discard: 'Draft discarded',
  requeue: 'Queued. The next poll reviews it again.',
  'resolve-thread': 'Thread resolved on GitHub',
});

const ACTION_PROGRESS_TEXT: Readonly<Record<TeamReviewAction, string>> = Object.freeze({
  approve: 'Posting the approval',
  'approve-only': 'Posting the approval',
  comment: 'Posting the comment',
  discard: 'Discarding the draft',
  requeue: 'Queueing the review',
  'resolve-thread': 'Resolving thread',
});

export function groupDrafts(status: TeamReviewStatus | null | undefined): TeamReviewSections {
  const sections: TeamReviewSections = { ready: [], noReviewNeeded: [], inReview: [], queued: [], handReview: [], attention: [], posted: [], discarded: [] };
  if (!status) return sections;
  const readyByBand: Record<ReviewPriorityBand, ReviewDraft[]> = { 'blocking-others': [], actionable: [], 'waiting-on-author': [], 'not-ready': [] };
  const queuedByBand: Record<ReviewPriorityBand, QueuedReview[]> = { 'blocking-others': [], actionable: [], 'waiting-on-author': [], 'not-ready': [] };
  const bandOrder: ReviewPriorityBand[] = ['blocking-others', 'actionable', 'waiting-on-author', 'not-ready'];
  const inFlightKeys = new Set(status.inFlight.map((review) => review.key));
  sections.inReview.push(...status.inFlight);
  const answeredThreadDraftKeys = new Set(status.drafts.filter((draft) => answeredNonNitThreads(draft).length > 0).map((draft) => draft.key));
  sections.handReview.push(...status.handReview.filter((review) => !inFlightKeys.has(review.key) && !answeredThreadDraftKeys.has(review.key)));
  const handReviewKeys = new Set(sections.handReview.map((review) => review.key));
  for (const review of status.queued) {
    if (inFlightKeys.has(review.key) || handReviewKeys.has(review.key)) continue;
    queuedByBand[classifyReviewPriority(review).band].push(review);
  }
  for (const band of bandOrder) sections.queued.push(...queuedByBand[band]);
  const queuedKeys = new Set(sections.queued.map((review) => review.key));
  for (const draft of status.drafts) {
    if (inFlightKeys.has(draft.key) || queuedKeys.has(draft.key) || handReviewKeys.has(draft.key)) continue;
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

export function isReviewNeeded(draft: ReviewDraft): boolean {
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

export interface ViewerApprovalContext {
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
  return sections.ready.length + sections.noReviewNeeded.length + sections.inReview.length + sections.queued.length + sections.handReview.length + sections.attention.length + sections.posted.length + sections.discarded.length > 0;
}

export function attentionOrder(sections: TeamReviewSections): string[] {
  return [...sections.ready, ...sections.attention].map((review) => review.key);
}

export function nextAttentionKey({ capturedOrder, actedKey, groups }: { capturedOrder: readonly string[]; actedKey: string; groups: TeamReviewSections }): string | null {
  const remainingKeys = attentionOrder(groups).filter((key) => key !== actedKey);
  const remainingKeySet = new Set(remainingKeys);
  const nextKey = capturedOrder.slice(capturedOrder.indexOf(actedKey) + 1).find((key) => remainingKeySet.has(key));
  if (nextKey) return nextKey;
  return capturedOrder.find((key) => remainingKeySet.has(key)) ?? remainingKeys[0] ?? null;
}

export function chooseSelectedReviewKey(sections: TeamReviewSections, selectedKey: string | null, isCaughtUp = false): string | null {
  if (isCaughtUp && selectedKey === null) return null;
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

export const LEGACY_SUMMARY_HINT = 'This review ran before plain summaries existed, so only its verdict and findings remain. The audit log shows what it checked. Queue review to get a plain summary.';

const REQUEUEABLE_STATUSES: ReadonlySet<ReviewDraft['status']> = new Set(['error', 'stale', 'discarded', 'posted']);

export function hasRequeueFooter(status: ReviewDraft['status']): boolean {
  return REQUEUEABLE_STATUSES.has(status);
}

export function verdictHeading(verdict: ReviewDraft['verdict']): string {
  const label = verdictLabel(verdict);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
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
  const remainingMs = review.deadlineAt === null ? 0 : review.deadlineAt - nowMs;
  if (remainingMs > 0) parts.push(`times out in ${formatClockOffset(remainingMs)}`);
  if (review.phase === 'reviewing') parts.push(`${review.toolCalls} ${review.toolCalls === 1 ? 'tool call' : 'tool calls'}`);
  return parts.join(', ');
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

export function withReviewerNote(reviewerNote: string, reviewBody: string): string {
  const trimmedNote = reviewerNote.trim();
  if (!trimmedNote) return reviewBody;
  if (!reviewBody.trim()) return trimmedNote;
  return `${trimmedNote}\n\n${reviewBody}`;
}

export function buildActionRequest(draft: ReviewDraft, action: TeamReviewAction, body: string, comments: readonly ReviewComment[], threadId?: string): TeamReviewActionRequest {
  if (action === 'approve-only') return { key: draft.key, head: draft.reviewedHead, action, body: '', comments: [] };
  return { key: draft.key, head: draft.reviewedHead, action, body, ...(threadId ? { threadId } : {}), comments: comments.map(({ path, line, side, body: commentBody }) => ({ path, line, side, body: commentBody })) };
}

const ACTION_LABELS: Readonly<Record<TeamReviewAction, string>> = Object.freeze({
  approve: 'Approve and comment',
  'approve-only': 'Approve',
  comment: 'Comment',
  discard: 'Discard',
  requeue: 'Queue review',
  'resolve-thread': 'Resolve',
});

export interface DetailActionLayout {
  footer: readonly TeamReviewAction[];
  more: readonly TeamReviewAction[];
}

export function actionLabel(action: TeamReviewAction): string {
  return ACTION_LABELS[action];
}

export function detailActionLayout(draft: Pick<ReviewDraft, 'status' | 'postedEvent'>): DetailActionLayout {
  if (draft.status === 'ready') return { footer: ['comment', 'approve-only', 'approve'], more: ['requeue', 'discard'] };
  if (canApproveAfterComment(draft)) return { footer: ['approve-only'], more: ['requeue'] };
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
  if (status.error) return 'Review drafts will show here once GitHub answers.';
  return 'No review drafts yet. New teammate pull requests show up here after the next poll.';
}

export function laneNotice(status: TeamReviewStatus | null | undefined): string | null {
  if (!status?.configured) return null;
  return status.reason || null;
}

export function readyAttentionSignature(status: TeamReviewStatus | null | undefined): string {
  return attentionSignature(groupDrafts(status).ready.map((draft) => `${draft.key}@${draft.reviewedHead}`));
}

export function readyRowSignature(draft: ReviewDraft): string {
  return `${draft.key}@${draft.reviewedHead}:${draft.status}:${draft.summary}:${githubReviewItems(draft).map((review) => review.text).join(', ')}`;
}

export function detailHeadingSignature(review: ReviewDraft | InFlightReview): string {
  if (!('reviewedHead' in review)) return JSON.stringify([review.prCreatedAt, review.priorReviewedHead]);
  return JSON.stringify([review.prCreatedAt, review.reviewedAt, review.postedAt, review.githubReviews, review.liveHead, review.priorReviewedHead, review.viewerThreads]);
}

export function isInFlightProgressOnlyChange(previous: TeamReviewStatus | null | undefined, next: TeamReviewStatus): boolean {
  if (!previous) return false;
  if (previous.error !== next.error || previous.nextAttemptAt !== next.nextAttemptAt || JSON.stringify(previous.retry) !== JSON.stringify(next.retry)) return false;
  if (previous.isRefreshing !== next.isRefreshing || previous.refreshNotice !== next.refreshNotice) return false;
  if (JSON.stringify(previous.team) !== JSON.stringify(next.team)) return false;
  if (previous.configured !== next.configured || previous.reason !== next.reason) return false;
  const previousKeys = previous.inFlight.map((review) => review.key).join('\n');
  const nextKeys = next.inFlight.map((review) => review.key).join('\n');
  if (previousKeys !== nextKeys) return false;
  if (JSON.stringify(previous.handReview) !== JSON.stringify(next.handReview)) return false;
  if (JSON.stringify(previous.queued) !== JSON.stringify(next.queued)) return false;
  return JSON.stringify(previous.drafts) === JSON.stringify(next.drafts);
}
