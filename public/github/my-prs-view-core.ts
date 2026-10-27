import { githubPollingErrorNotice } from './github-polling-retry-core.ts';
import { MyPrMergeResult } from '#shared/contracts/my-prs.ts';
import { mergeMethodLabel, myPrMergeBlocker } from '#shared/my-pr-merge.ts';
import type { MyPr, MyPrMergeKind, MyPrsStatus as MyPrsStatusType, MyPrThread } from '#shared/contracts/my-prs.ts';
import type { PrStatusIcon } from './pr-status-icon-core.ts';
import type { StateTone } from '../state-tone-core.ts';

export { stageIcon, stageLabel, stageTone } from './github-store-core.ts';
export type { LinkedLiveSession, MergeCelebrationText } from './github-store-core.ts';

interface ThreadRow {
  location: string; url: string; author: string; excerpt: string; replySummary: string; lastActivityAt: string;
  waiting: { tone: StateTone; icon: PrStatusIcon; text: string } | null;
  isWaitingOnYou: boolean;
}
interface ReviewRow { reviewer: string; text: string; tone: StateTone; icon: PrStatusIcon; submittedAt: string | null }
interface ReadinessRow { label: 'Checks' | 'Review' | 'Threads' | 'Conflicts' | 'Base' | 'Auto-rebase' | 'Merge when ready'; tone: StateTone; icon: PrStatusIcon; text: string; items?: readonly string[] }

export interface ToggleControlState { isVisible: boolean; isPressed: boolean; isDisabled: boolean; statusText: string; tone: 'busy' | 'error' | null }

function toggleControlState(pr: MyPr, isOn: boolean, isPending: boolean, errorText: string, settledText: string, isFeatureEnabled: boolean): ToggleControlState {
  return {
    isVisible: isFeatureEnabled && (pr.state === 'OPEN' || isOn),
    isPressed: isOn,
    isDisabled: isPending,
    statusText: errorText || (isPending ? 'Saving' : settledText),
    tone: errorText ? 'error' : isPending ? 'busy' : null,
  };
}

export function keepMergeableRowLabel(pr: MyPr, isFeatureEnabled: boolean, attemptAgeText = ''): { text: string; tone: 'warn' | 'danger'; title: string } | null {
  if (!isFeatureEnabled || !pr.keepMergeable) return null;
  const title = keepMergeableControlState(pr, false, '', true, attemptAgeText).statusText;
  if (pr.isKeepMergeableFixInFlight) return { text: 'Repairing', tone: 'warn', title };
  const attempt = pr.keepMergeableAttempt;
  if (!attempt || attempt.outcome === 'pushed' || attempt.outcome === 'stopped') return null;
  return { text: 'Repair failed', tone: 'danger', title };
}

export function keepMergeableControlState(pr: MyPr, isPending: boolean, errorText = '', isFeatureEnabled = true, attemptAgeText = ''): ToggleControlState {
  const attempt = pr.keepMergeableAttempt;
  let settledText = pr.keepMergeable ? 'On' : 'Off';
  if (pr.keepMergeable && attempt && attempt.outcome !== 'pushed' && attempt.outcome !== 'stopped') {
    const age = attemptAgeText ? ` (${attemptAgeText})` : '';
    settledText = `Keep mergeable failed: ${attempt.reason ?? 'The attempt produced no repair'}${age}`;
  }
  if (pr.isKeepMergeableFixInFlight) settledText = 'Keep mergeable is running';
  return toggleControlState(pr, !!pr.keepMergeable, isPending, errorText, settledText, isFeatureEnabled);
}

export function isKeepMergeableFeatureEnabled(status: MyPrsStatusType | null): boolean {
  return status?.isKeepMergeableEnabled !== false;
}

export function isMergeQueueFeatureEnabled(status: MyPrsStatusType | null): boolean {
  return status?.isMergeQueueEnabled !== false;
}

function mergeQueueStatusText(isQueued: boolean, isHeldForRepairPush: boolean, hasMergeFailed: boolean): string {
  if (!isQueued) return 'Not queued';
  if (isHeldForRepairPush) return 'Repair pushed, waiting for you';
  if (hasMergeFailed) return 'On, the last merge failed and retries an hour later once it is ready';
  return 'On, merges as soon as it is ready';
}

export function mergeWhenReadyControlState(pr: MyPr, isPending: boolean, errorText = '', isFeatureEnabled = true): ToggleControlState {
  const isQueued = pr.mergeQueuePosition !== null && pr.mergeQueuePosition !== undefined;
  return toggleControlState(pr, isQueued, isPending, errorText, mergeQueueStatusText(isQueued, !!pr.isMergeQueueHeldForRepairPush, !!pr.mergeQueueFailure), isFeatureEnabled);
}

function checksReadiness(pr: MyPr): ReadinessRow {
  if (pr.checks.failing.length > 0) return { label: 'Checks', tone: 'danger', icon: 'failed', text: `${pr.checks.failing.length} failing`, items: pr.checks.failing };
  if (pr.checks.state === 'FAILURE' || pr.checks.state === 'ERROR') return { label: 'Checks', tone: 'danger', icon: 'failed', text: 'Failing' };
  if (pr.checks.pendingCount > 0) return { label: 'Checks', tone: 'wait', icon: 'running', text: `${pr.checks.pendingCount} running` };
  if (pr.checks.state === 'PENDING' || pr.checks.state === 'EXPECTED') return { label: 'Checks', tone: 'wait', icon: 'running', text: 'Running' };
  if (pr.checks.state === 'SUCCESS') return { label: 'Checks', tone: 'ok', icon: 'passed', text: 'Passing' };
  return { label: 'Checks', tone: 'muted', icon: 'none', text: 'No checks' };
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
  if (pr.mergeStateStatus === 'BLOCKED') return { label: 'Review', tone: 'wait', icon: 'reviewer', text: `${approvedText}, merge blocked` };
  return { label: 'Review', tone: 'ok', icon: 'passed', text: approvedText };
}

function reviewReadiness(pr: MyPr): ReadinessRow {
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { label: 'Review', tone: 'warn', icon: 'changes-requested', text: 'Changes requested' };
  if (pr.reviewDecision === 'APPROVED') return approvedReadiness(pr);
  if (pr.reviewDecision === 'REVIEW_REQUIRED' || pr.mergeStateStatus === 'BLOCKED') return { label: 'Review', tone: 'wait', icon: 'reviewer', text: approvalRequiredText(pr) };
  if (pr.reviewRequests.length > 0) return { label: 'Review', tone: 'wait', icon: 'reviewer', text: `Requested: ${requestedReviewerNames(pr)}` };
  return { label: 'Review', tone: 'muted', icon: 'none', text: 'No review requested' };
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
  return isWaiting ? { tone: 'warn', icon: 'your-turn', text: 'Waiting on you' } : { tone: 'wait', icon: 'reviewer', text: 'Waiting on reviewer' };
}

export function threadRows(pr: MyPr, viewer: string | null): ThreadRow[] {
  return [...pr.threads].sort((left, right) => {
    const waitingDifference = Number(isWaitingOnViewer(right, viewer) === true) - Number(isWaitingOnViewer(left, viewer) === true);
    if (waitingDifference !== 0) return waitingDifference;
    return (Date.parse(right.lastActivityAt) || 0) - (Date.parse(left.lastActivityAt) || 0);
  }).map((thread) => ({
    location: threadLocation(thread), url: thread.url, author: thread.author ?? 'a deleted account',
    excerpt: thread.excerpt, replySummary: replySummary(thread), lastActivityAt: thread.lastActivityAt,
    waiting: waitingBadge(thread, viewer), isWaitingOnYou: isWaitingOnViewer(thread, viewer) === true,
  }));
}

function threadsReadiness(pr: MyPr, viewer: string | null): ReadinessRow {
  if (pr.unresolvedThreads === 0) return { label: 'Threads', tone: 'ok', icon: 'passed', text: 'None open' };
  const unresolvedText = `${pr.unresolvedThreads} unresolved`;
  if (!viewer || pr.threads.length === 0) return { label: 'Threads', tone: 'warn', icon: 'thread', text: unresolvedText };
  const waitingOnViewerCount = pr.threads.filter((thread) => isWaitingOnViewer(thread, viewer)).length;
  if (waitingOnViewerCount === 0) return { label: 'Threads', tone: 'wait', icon: 'thread', text: `${unresolvedText}, all waiting on reviewers` };
  return { label: 'Threads', tone: 'warn', icon: 'your-turn', text: `${unresolvedText}, ${waitingOnViewerCount} waiting on you` };
}

function conflictsReadiness(pr: MyPr): ReadinessRow {
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return { label: 'Conflicts', tone: 'danger', icon: 'conflict', text: `Conflicts with ${pr.baseRefName}` };
  if (pr.mergeable === 'MERGEABLE') return { label: 'Conflicts', tone: 'ok', icon: 'passed', text: 'None' };
  return { label: 'Conflicts', tone: 'muted', icon: 'unknown', text: 'Not computed yet' };
}

function baseReadiness(pr: MyPr): ReadinessRow {
  const hasBehindCount = pr.behindBy !== null && pr.behindBy > 0;
  if (pr.mergeStateStatus === 'BEHIND') return { label: 'Base', tone: 'warn', icon: 'behind', text: hasBehindCount ? `${pr.behindBy} behind ${pr.baseRefName}` : `Behind ${pr.baseRefName}` };
  if (pr.behindBy === null) return { label: 'Base', tone: 'muted', icon: 'unknown', text: 'Unknown' };
  if (hasBehindCount) return { label: 'Base', tone: 'muted', icon: 'behind', text: `${pr.behindBy} behind ${pr.baseRefName}, update not required` };
  return { label: 'Base', tone: 'ok', icon: 'passed', text: `Up to date with ${pr.baseRefName}` };
}

const REVIEW_STATES: Record<string, { text: string; tone: StateTone; icon: PrStatusIcon }> = {
  APPROVED: { text: 'Approved', tone: 'ok', icon: 'passed' }, CHANGES_REQUESTED: { text: 'Requested changes', tone: 'warn', icon: 'changes-requested' },
  COMMENTED: { text: 'Commented', tone: 'muted', icon: 'thread' }, DISMISSED: { text: 'Dismissed', tone: 'muted', icon: 'discarded' }, PENDING: { text: 'Pending', tone: 'wait', icon: 'running' },
};

export function reviewRows(pr: MyPr): ReviewRow[] {
  return [...pr.reviews].sort((left, right) => (Date.parse(right.submittedAt ?? '') || 0) - (Date.parse(left.submittedAt ?? '') || 0)).map((review) => {
    const described = REVIEW_STATES[review.state] ?? { text: review.state.toLowerCase().replaceAll('_', ' '), tone: 'muted' as const, icon: 'unknown' as const };
    return { reviewer: review.reviewer ?? 'a deleted account', text: described.text, tone: described.tone, icon: described.icon, submittedAt: review.submittedAt };
  });
}

const READINESS_TONE_RANK: Readonly<Record<StateTone, number>> = { danger: 0, warn: 1, wait: 2, muted: 3, ok: 4 };

export function readinessRows(pr: MyPr, viewer: string | null = null): ReadinessRow[] {
  if (pr.state === 'MERGED') return [];
  const rows = [checksReadiness(pr), reviewReadiness(pr), threadsReadiness(pr, viewer), conflictsReadiness(pr), baseReadiness(pr)];
  const autoRebaseRows = pr.autoRebase ? [autoRebaseReadiness(pr, pr.autoRebase)] : [];
  const mergeFailureRows: ReadinessRow[] = pr.mergeQueueFailure ? [{ label: 'Merge when ready', tone: 'danger', icon: 'failed', text: `Merge failed: ${pr.mergeQueueFailure.message}` }] : [];
  return [...rows, ...autoRebaseRows, ...mergeFailureRows].toSorted((first, second) => READINESS_TONE_RANK[first.tone] - READINESS_TONE_RANK[second.tone]);
}

function autoRebaseReadiness(pr: MyPr, autoRebase: NonNullable<MyPr['autoRebase']>): ReadinessRow {
  if (autoRebase.outcome === 'rebased') return { label: 'Auto-rebase', tone: 'ok', icon: 'passed', text: autoRebase.message };
  const isUpdateRequired = pr.mergeStateStatus === 'BEHIND';
  return { label: 'Auto-rebase', tone: isUpdateRequired ? 'danger' : 'warn', icon: 'failed', text: autoRebase.message };
}

export function emptyStateText(status: MyPrsStatusType | null): string {
  if (!status) return 'Waiting for your pull requests.';
  if (!status.configured) return 'Enable Team review and set its GitHub organization in settings to see your pull requests.';
  if (status.error && status.prs.length === 0) return 'Pull requests will show here once GitHub answers.';
  return 'No open or recently merged pull requests found.';
}

interface QueueNotice { text: string; tone: 'error' | 'info' }

export function queueNotices(status: MyPrsStatusType | null, nowMs = 0): QueueNotice[] {
  if (!status) return [];
  const errorNotice = githubPollingErrorNotice(status, nowMs);
  const notices: QueueNotice[] = errorNotice ? [{ text: errorNotice, tone: 'error' }] : [];
  return status.truncatedNote ? [...notices, { text: status.truncatedNote, tone: 'info' }] : notices;
}

export interface MergeAttempt { head: string; phase: 'pending' | 'failed' | MyPrMergeKind; text: string }
interface MergeControlState { isVisible: boolean; isDisabled: boolean; statusText: string; tone: 'ok' | 'error' | 'busy' | null }

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
