import { reviewsErrorNotice } from './reviews-retry-core.ts';
import { MyPrMergeResult, MyPrsStatus } from '#shared/contracts/my-prs.ts';
import { mergeMethodLabel, myPrMergeBlocker } from '#shared/my-pr-merge.ts';
import type { MyPr, MyPrMergeKind, MyPrStage, MyPrsStatus as MyPrsStatusType, MyPrThread } from '#shared/contracts/my-prs.ts';
import type { PrStatusIcon } from './pr-status-icon-core.ts';
import type { StateTone } from './state-tone-core.ts';

export interface MyPrSection { title: string; prs: MyPr[] }
export interface ThreadRow {
  location: string; url: string; author: string; excerpt: string; replySummary: string; lastActivityAt: string;
  waiting: { tone: StateTone; icon: PrStatusIcon; text: string } | null;
}
export interface ReviewRow { reviewer: string; text: string; tone: StateTone; icon: PrStatusIcon; submittedAt: string | null }
export interface ReadinessRow { label: 'Checks' | 'Review' | 'Threads' | 'Conflicts' | 'Base' | 'Auto-rebase'; tone: StateTone; icon: PrStatusIcon; text: string }

export interface ToggleControlState { isVisible: boolean; isPressed: boolean; isDisabled: boolean; statusText: string }

function toggleControlState(pr: MyPr, isOn: boolean, isPending: boolean, errorText: string, settledText: string, isFeatureEnabled: boolean): ToggleControlState {
  return {
    isVisible: isFeatureEnabled && (pr.state === 'OPEN' || isOn),
    isPressed: isOn,
    isDisabled: isPending,
    statusText: errorText || (isPending ? 'Saving...' : settledText),
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

const ORDINAL_SUFFIXES: Readonly<Record<string, string>> = { one: 'st', two: 'nd', few: 'rd', other: 'th' };
const ordinalRules = new Intl.PluralRules('en-US', { type: 'ordinal' });

function ordinal(count: number): string {
  return `${count}${ORDINAL_SUFFIXES[ordinalRules.select(count)] ?? 'th'}`;
}

function mergeQueueStatusText(position: number | null, isHeldForRepairPush: boolean): string {
  if (position === null) return 'Not queued';
  if (isHeldForRepairPush) return 'Repair pushed, waiting for you';
  return `Queued, ${ordinal(position)} in line for this repository`;
}

export function mergeWhenReadyControlState(pr: MyPr, isPending: boolean, errorText = '', isFeatureEnabled = true): ToggleControlState {
  const position = pr.mergeQueuePosition ?? null;
  return toggleControlState(pr, position !== null, isPending, errorText, mergeQueueStatusText(position, !!pr.isMergeQueueHeldForRepairPush), isFeatureEnabled);
}

const SECTION_TITLES_BY_URGENCY = ['Needs you', 'Waiting', 'Ready to merge', 'Drafts', 'Merged today'] as const;
type SectionTitle = typeof SECTION_TITLES_BY_URGENCY[number];
const SECTION_TITLES_IN_DISPLAY_ORDER: readonly SectionTitle[] = ['Ready to merge', 'Needs you', 'Waiting', 'Drafts', 'Merged today'];
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
const STAGE_ICONS: Record<MyPrStage, PrStatusIcon> = {
  merged: 'merged', draft: 'draft', conflicts: 'conflict', behind: 'behind', 'checks-failing': 'failed',
  'changes-requested': 'changes-requested', 'unresolved-threads': 'thread', 'checks-pending': 'running',
  'needs-approval': 'reviewer', ready: 'ready', unknown: 'unknown',
};

export function parseMyPrsStatus(message: unknown): MyPrsStatusType | null {
  const parsed = MyPrsStatus.safeParse(message);
  return parsed.success ? parsed.data : null;
}

export function groupMyPrs(prs: readonly MyPr[]): MyPrSection[] {
  return SECTION_TITLES_IN_DISPLAY_ORDER.map((title) => ({ title, prs: prs.filter((pr) => SECTION_BY_STAGE[pr.stage] === title) }));
}

export interface MyPrStackRow { pr: MyPr; parentKey: string | null; depth: number }
export interface MyPrStack { root: MyPr; rows: MyPrStackRow[] }

export function groupStackedMyPrs(prs: readonly MyPr[]): MyPrStack[] {
  const stackParentCandidates = prs.filter((pr) => pr.state === 'OPEN' && !pr.isCrossRepository);
  const prByHeadBranch = new Map(stackParentCandidates.map((pr) => [JSON.stringify([pr.repo.toLowerCase(), pr.headRefName]), pr]));
  const childrenByParentKey = new Map<string, MyPr[]>();
  const roots: MyPr[] = [];
  for (const pr of prs) {
    const parent = pr.state === 'OPEN' ? prByHeadBranch.get(JSON.stringify([pr.repo.toLowerCase(), pr.baseRefName])) : undefined;
    if (!parent || parent.key === pr.key) {
      roots.push(pr);
      continue;
    }
    const children = childrenByParentKey.get(parent.key) ?? [];
    children.push(pr);
    childrenByParentKey.set(parent.key, children);
  }
  const stacks: MyPrStack[] = [];
  const visitedKeys = new Set<string>();
  for (const root of [...roots, ...prs]) {
    if (visitedKeys.has(root.key)) continue;
    const rows: MyPrStackRow[] = [];
    const pendingRows: MyPrStackRow[] = [{ pr: root, parentKey: null, depth: 0 }];
    while (pendingRows.length > 0) {
      const row = pendingRows.pop();
      if (!row || visitedKeys.has(row.pr.key)) continue;
      visitedKeys.add(row.pr.key);
      rows.push(row);
      const children = childrenByParentKey.get(row.pr.key) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pendingRows.push({ pr: children[index], parentKey: row.pr.key, depth: row.depth + 1 });
      }
    }
    stacks.push({ root, rows });
  }
  return stacks;
}

export interface MyPrStackSection extends MyPrSection { rows: MyPrStackRow[] }

function mostUrgentSectionTitle(stack: MyPrStack): SectionTitle {
  const mostUrgentIndex = stack.rows.reduce((urgentIndex, { pr }) => Math.min(urgentIndex, SECTION_TITLES_BY_URGENCY.indexOf(SECTION_BY_STAGE[pr.stage])), SECTION_TITLES_BY_URGENCY.length - 1);
  return SECTION_TITLES_BY_URGENCY[mostUrgentIndex];
}

export function sectionStackedMyPrs(prs: readonly MyPr[]): MyPrStackSection[] {
  const sectionsByTitle = new Map(SECTION_TITLES_BY_URGENCY.map((title): [SectionTitle, MyPrStackSection] => [title, { title, prs: [], rows: [] }]));
  for (const stack of groupStackedMyPrs(prs)) {
    const section = sectionsByTitle.get(mostUrgentSectionTitle(stack));
    if (!section) continue;
    for (const row of stack.rows) {
      section.rows.push(row);
      section.prs.push(row.pr);
    }
  }
  return SECTION_TITLES_IN_DISPLAY_ORDER.flatMap((title) => sectionsByTitle.get(title) ?? []);
}

export function stageLabel(stage: MyPrStage): string { return STAGE_LABELS[stage]; }
export function stageTone(stage: MyPrStage): StateTone { return STAGE_TONES[stage]; }
export function stageIcon(stage: MyPrStage): PrStatusIcon { return STAGE_ICONS[stage]; }

function checksReadiness(pr: MyPr): ReadinessRow {
  if (pr.checks.failing.length > 0) {
    const extra = pr.checks.failing.length - 3;
    return { label: 'Checks', tone: 'danger', icon: 'failed', text: `${pr.checks.failing.length} failing: ${pr.checks.failing.slice(0, 3).join(', ')}${extra > 0 ? ` and ${extra} more` : ''}` };
  }
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
    waiting: waitingBadge(thread, viewer),
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

export function readinessRows(pr: MyPr, viewer: string | null = null): ReadinessRow[] {
  if (pr.state === 'MERGED') return [];
  const rows = [checksReadiness(pr), reviewReadiness(pr), threadsReadiness(pr, viewer), conflictsReadiness(pr), baseReadiness(pr)];
  if (!pr.autoRebase) return rows;
  return [...rows, pr.autoRebase.outcome === 'rebased' ? { label: 'Auto-rebase', tone: 'ok', icon: 'passed', text: pr.autoRebase.message } : { label: 'Auto-rebase', tone: 'danger', icon: 'failed', text: pr.autoRebase.message }];
}

export function emptyStateText(status: MyPrsStatusType | null): string {
  if (!status) return 'Waiting for your pull requests.';
  if (!status.configured) return 'Enable Team review and set its GitHub organization in settings to see your pull requests.';
  if (status.error && status.prs.length === 0) return 'Pull requests will show here once GitHub answers.';
  return 'No open or recently merged pull requests found.';
}

export interface QueueNotice { text: string; tone: 'error' | 'info' }

export function queueNotices(status: MyPrsStatusType | null, nowMs = 0): QueueNotice[] {
  if (!status) return [];
  const errorNotice = reviewsErrorNotice(status, nowMs);
  const notices: QueueNotice[] = errorNotice ? [{ text: errorNotice, tone: 'error' }] : [];
  return status.truncatedNote ? [...notices, { text: status.truncatedNote, tone: 'info' }] : notices;
}

export function chooseSelectedKey(sections: readonly MyPrSection[], previousKey: string | null): string | null {
  const prs = sections.flatMap((section) => section.prs);
  if (previousKey && prs.some((pr) => pr.key === previousKey)) return previousKey;
  return prs[0]?.key ?? null;
}

export function newlyMergedPrs(previous: readonly MyPr[] | null, next: readonly MyPr[]): MyPr[] {
  if (!previous) return [];
  const openKeys = new Set(previous.filter((pr) => pr.state === 'OPEN').map((pr) => pr.key));
  return next.filter((pr) => pr.state === 'MERGED' && openKeys.has(pr.key));
}

export function mergeCelebrationText(mergedPrs: readonly MyPr[]): string {
  if (mergedPrs.length === 1) return `Merged ${mergedPrs[0].key}`;
  return `Merged ${mergedPrs.length} pull requests`;
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
