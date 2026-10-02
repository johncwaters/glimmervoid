import { MyPrMergeResult, MyPrsStatus } from '#shared/contracts/my-prs.ts';
import { mergeMethodLabel, myPrMergeBlocker } from '#shared/my-pr-merge.ts';
import type { MyPr, MyPrMergeKind, MyPrStage, MyPrsStatus as MyPrsStatusType, MyPrThread } from '#shared/contracts/my-prs.ts';
import type { StateTone } from './state-tone-core.ts';

export interface MyPrSection { title: string; prs: MyPr[] }
export interface ThreadRow {
  location: string; url: string; author: string; excerpt: string; replySummary: string; lastActivityAt: string;
  waiting: { tone: StateTone; text: string } | null;
}
export interface ReviewRow { reviewer: string; text: string; tone: StateTone; submittedAt: string | null }
export interface ReadinessRow { label: 'Checks' | 'Review' | 'Threads' | 'Conflicts' | 'Base' | 'Auto-rebase'; tone: StateTone; text: string }

const SECTION_TITLES = ['Needs you', 'Waiting', 'Ready to merge', 'Drafts', 'Merged today'] as const;
type SectionTitle = typeof SECTION_TITLES[number];
const SECTION_BY_STAGE: Record<MyPrStage, SectionTitle> = {
  conflicts: 'Needs you', behind: 'Needs you', 'checks-failing': 'Needs you', 'changes-requested': 'Needs you', 'unresolved-threads': 'Needs you',
  'checks-pending': 'Waiting', 'needs-approval': 'Waiting', unknown: 'Waiting',
  ready: 'Ready to merge', draft: 'Drafts', merged: 'Merged today',
};

const STAGE_LABELS: Record<MyPrStage, string> = {
  merged: 'Merged', draft: 'Draft', conflicts: 'Merge conflicts', behind: 'Behind base',
  'checks-failing': 'Checks failing', 'changes-requested': 'Changes requested',
  'unresolved-threads': 'Unresolved threads', 'checks-pending': 'Checks running',
  'needs-approval': 'Needs approval', ready: 'Ready to merge', unknown: 'Status unknown',
};
const STAGE_TONES: Record<MyPrStage, StateTone> = {
  merged: 'muted', draft: 'muted', conflicts: 'danger', behind: 'warn', 'checks-failing': 'danger',
  'changes-requested': 'warn', 'unresolved-threads': 'warn', 'checks-pending': 'wait',
  'needs-approval': 'wait', ready: 'ok', unknown: 'muted',
};

export function parseMyPrsStatus(message: unknown): MyPrsStatusType | null {
  const parsed = MyPrsStatus.safeParse(message);
  return parsed.success ? parsed.data : null;
}

export function groupMyPrs(prs: readonly MyPr[]): MyPrSection[] {
  return SECTION_TITLES.map((title) => ({ title, prs: prs.filter((pr) => SECTION_BY_STAGE[pr.stage] === title) }));
}

export function stageLabel(stage: MyPrStage): string { return STAGE_LABELS[stage]; }
export function stageTone(stage: MyPrStage): StateTone { return STAGE_TONES[stage]; }

function checksReadiness(pr: MyPr): ReadinessRow {
  if (pr.checks.failing.length > 0) {
    const extra = pr.checks.failing.length - 3;
    return { label: 'Checks', tone: 'danger', text: `${pr.checks.failing.length} failing: ${pr.checks.failing.slice(0, 3).join(', ')}${extra > 0 ? ` and ${extra} more` : ''}` };
  }
  if (pr.checks.state === 'FAILURE' || pr.checks.state === 'ERROR') return { label: 'Checks', tone: 'danger', text: 'Failing' };
  if (pr.checks.pendingCount > 0) return { label: 'Checks', tone: 'wait', text: `${pr.checks.pendingCount} running` };
  if (pr.checks.state === 'PENDING' || pr.checks.state === 'EXPECTED') return { label: 'Checks', tone: 'wait', text: 'Running' };
  if (pr.checks.state === 'SUCCESS') return { label: 'Checks', tone: 'ok', text: 'Passing' };
  return { label: 'Checks', tone: 'muted', text: 'No checks' };
}

function approvalCountText(approvals: number): string {
  return `${approvals} ${approvals === 1 ? 'approval' : 'approvals'}`;
}

function requestedReviewerNames(pr: MyPr): string {
  return pr.reviewRequests.map((request) => request.name).join(', ');
}

function approvalRequiredText(pr: MyPr): string {
  const requestText = pr.reviewRequests.length > 0 ? `Requested: ${requestedReviewerNames(pr)}` : 'Approval required';
  return pr.approvals > 0 ? `${requestText}, ${approvalCountText(pr.approvals)}` : requestText;
}

function approvedReadiness(pr: MyPr): ReadinessRow {
  const approvedText = pr.approvals > 0 ? approvalCountText(pr.approvals) : 'Approved';
  if (pr.mergeStateStatus === 'BLOCKED') return { label: 'Review', tone: 'wait', text: `${approvedText}, merge blocked` };
  return { label: 'Review', tone: 'ok', text: approvedText };
}

function reviewReadiness(pr: MyPr): ReadinessRow {
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { label: 'Review', tone: 'warn', text: 'Changes requested' };
  if (pr.reviewDecision === 'APPROVED') return approvedReadiness(pr);
  if (pr.reviewDecision === 'REVIEW_REQUIRED' || pr.mergeStateStatus === 'BLOCKED') return { label: 'Review', tone: 'wait', text: approvalRequiredText(pr) };
  if (pr.reviewRequests.length > 0) return { label: 'Review', tone: 'wait', text: `Requested: ${requestedReviewerNames(pr)}` };
  return { label: 'Review', tone: 'muted', text: 'No review requested' };
}

function isWaitingOnViewer(thread: MyPrThread, viewer: string | null): boolean | null {
  if (!viewer) return null;
  return thread.lastAuthor !== viewer;
}

function threadLocation(thread: MyPrThread): string {
  const place = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
  return thread.isOutdated ? `${place} (outdated)` : place;
}

function replySummary(thread: MyPrThread): string {
  const replyCount = thread.commentCount - 1;
  if (replyCount === 0) return 'No replies';
  return `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}, last by ${thread.lastAuthor ?? 'a deleted account'}`;
}

function waitingBadge(thread: MyPrThread, viewer: string | null): ThreadRow['waiting'] {
  const isWaiting = isWaitingOnViewer(thread, viewer);
  if (isWaiting === null) return null;
  return isWaiting ? { tone: 'warn', text: 'Waiting on you' } : { tone: 'wait', text: 'Waiting on reviewer' };
}

export function threadRows(pr: MyPr, viewer: string | null): ThreadRow[] {
  return [...pr.threads].sort((left, right) => {
    const waitingDifference = Number(isWaitingOnViewer(right, viewer) === true) - Number(isWaitingOnViewer(left, viewer) === true);
    if (waitingDifference !== 0) return waitingDifference;
    return (Date.parse(right.lastActivityAt) || 0) - (Date.parse(left.lastActivityAt) || 0);
  }).map((thread) => ({
    location: threadLocation(thread), url: thread.url, author: thread.author ?? 'a deleted account',
    excerpt: thread.excerpt, replySummary: replySummary(thread), lastActivityAt: thread.lastActivityAt,
    waiting: waitingBadge(thread, viewer),
  }));
}

function threadsReadiness(pr: MyPr, viewer: string | null): ReadinessRow {
  if (pr.unresolvedThreads === 0) return { label: 'Threads', tone: 'ok', text: 'None open' };
  const unresolvedText = `${pr.unresolvedThreads} unresolved`;
  if (!viewer || pr.threads.length === 0) return { label: 'Threads', tone: 'warn', text: unresolvedText };
  const waitingOnViewerCount = pr.threads.filter((thread) => isWaitingOnViewer(thread, viewer)).length;
  if (waitingOnViewerCount === 0) return { label: 'Threads', tone: 'wait', text: `${unresolvedText}, all waiting on reviewers` };
  return { label: 'Threads', tone: 'warn', text: `${unresolvedText}, ${waitingOnViewerCount} waiting on you` };
}

function conflictsReadiness(pr: MyPr): ReadinessRow {
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return { label: 'Conflicts', tone: 'danger', text: `Conflicts with ${pr.baseRefName}` };
  if (pr.mergeable === 'MERGEABLE') return { label: 'Conflicts', tone: 'ok', text: 'None' };
  return { label: 'Conflicts', tone: 'muted', text: 'Not computed yet' };
}

function baseReadiness(pr: MyPr): ReadinessRow {
  const hasBehindCount = pr.behindBy !== null && pr.behindBy > 0;
  if (pr.mergeStateStatus === 'BEHIND') return { label: 'Base', tone: 'warn', text: hasBehindCount ? `${pr.behindBy} behind ${pr.baseRefName}` : `Behind ${pr.baseRefName}` };
  if (pr.behindBy === null) return { label: 'Base', tone: 'muted', text: 'Unknown' };
  if (hasBehindCount) return { label: 'Base', tone: 'muted', text: `${pr.behindBy} behind ${pr.baseRefName}, update not required` };
  return { label: 'Base', tone: 'ok', text: `Up to date with ${pr.baseRefName}` };
}

const REVIEW_STATES: Record<string, { text: string; tone: StateTone }> = {
  APPROVED: { text: 'Approved', tone: 'ok' }, CHANGES_REQUESTED: { text: 'Requested changes', tone: 'warn' },
  COMMENTED: { text: 'Commented', tone: 'muted' }, DISMISSED: { text: 'Dismissed', tone: 'muted' }, PENDING: { text: 'Pending', tone: 'wait' },
};

export function reviewRows(pr: MyPr): ReviewRow[] {
  return [...pr.reviews].sort((left, right) => (Date.parse(right.submittedAt ?? '') || 0) - (Date.parse(left.submittedAt ?? '') || 0)).map((review) => {
    const described = REVIEW_STATES[review.state] ?? { text: review.state.toLowerCase().replaceAll('_', ' '), tone: 'muted' as const };
    return { reviewer: review.reviewer ?? 'a deleted account', text: described.text, tone: described.tone, submittedAt: review.submittedAt };
  });
}

export function readinessRows(pr: MyPr, viewer: string | null = null): ReadinessRow[] {
  if (pr.state === 'MERGED') return [];
  const rows = [checksReadiness(pr), reviewReadiness(pr), threadsReadiness(pr, viewer), conflictsReadiness(pr), baseReadiness(pr)];
  if (!pr.autoRebase) return rows;
  return [...rows, { label: 'Auto-rebase', tone: pr.autoRebase.outcome === 'rebased' ? 'ok' : 'danger', text: pr.autoRebase.message }];
}

export function emptyStateText(status: MyPrsStatusType | null): string {
  if (!status) return 'Waiting for your pull requests.';
  if (!status.configured) return 'Enable Team review and set its GitHub organization in settings to see your pull requests.';
  if (status.error) return `Could not refresh your pull requests: ${status.error}`;
  return 'No open or recently merged pull requests found.';
}

export interface QueueNotice { text: string; tone: 'error' | 'info' }

export function queueNotices(status: MyPrsStatusType | null): QueueNotice[] {
  if (!status) return [];
  const notices: QueueNotice[] = status.error ? [{ text: emptyStateText(status), tone: 'error' }] : [];
  return status.truncatedNote ? [...notices, { text: status.truncatedNote, tone: 'info' }] : notices;
}

export function chooseSelectedKey(sections: readonly MyPrSection[], previousKey: string | null): string | null {
  const prs = sections.flatMap((section) => section.prs);
  if (previousKey && prs.some((pr) => pr.key === previousKey)) return previousKey;
  return prs[0]?.key ?? null;
}

export interface MergeAttempt { head: string; phase: 'pending' | 'failed' | MyPrMergeKind; text: string }
export interface MergeControlState { isVisible: boolean; isDisabled: boolean; statusText: string; tone: 'ok' | 'error' | 'busy' | null }

const HIDDEN_MERGE_CONTROL: MergeControlState = { isVisible: false, isDisabled: true, statusText: '', tone: null };
const MERGE_KIND_STATUS: Readonly<Record<MyPrMergeKind, Pick<MergeControlState, 'statusText' | 'tone'>>> = {
  merged: { statusText: 'Merged on GitHub. Refreshing the list.', tone: 'ok' },
  queued: { statusText: 'Added to the merge queue. Refreshing the list.', tone: 'ok' },
  'auto-merge': { statusText: 'Auto-merge enabled. GitHub merges it once its requirements pass.', tone: 'ok' },
  unconfirmed: { statusText: 'GitHub accepted the request but did not confirm a merge. Check GitHub.', tone: null },
};

export function mergeControlState(pr: MyPr, attempt: MergeAttempt | undefined): MergeControlState {
  if (pr.state !== 'OPEN') return HIDDEN_MERGE_CONTROL;
  const currentAttempt = attempt?.head === pr.headRefOid ? attempt : undefined;
  if (currentAttempt?.phase === 'pending') return { isVisible: true, isDisabled: true, statusText: 'Merging on GitHub', tone: 'busy' };
  if (currentAttempt && currentAttempt.phase !== 'failed') return { isVisible: true, isDisabled: true, ...MERGE_KIND_STATUS[currentAttempt.phase] };
  const blocker = myPrMergeBlocker(pr);
  if (blocker) return { isVisible: true, isDisabled: true, statusText: blocker, tone: null };
  if (currentAttempt?.phase === 'failed') return { isVisible: true, isDisabled: false, statusText: currentAttempt.text, tone: 'error' };
  return { isVisible: true, isDisabled: false, statusText: `Merges into ${pr.baseRefName} with ${mergeMethodLabel(pr.mergeMethod)}`, tone: null };
}

export function mergeConfirmMessage(pr: MyPr): string {
  return `Merge ${pr.key} "${pr.title}" into ${pr.baseRefName} with ${mergeMethodLabel(pr.mergeMethod)}, your default for this repository. Glimmervoid does not delete the branch.`;
}

export function parseMyPrMergeResult(message: unknown): (MyPrMergeResult & { requestId: string }) | null {
  const parsed = MyPrMergeResult.safeParse(message);
  if (!parsed.success) return null;
  const requestId = message && typeof message === 'object' && 'requestId' in message ? message.requestId : null;
  return typeof requestId === 'string' ? { ...parsed.data, requestId } : null;
}
