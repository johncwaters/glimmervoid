import { MyPrsStatus } from '#shared/contracts/my-prs.ts';
import type { MyPr, MyPrStage, MyPrsStatus as MyPrsStatusType } from '#shared/contracts/my-prs.ts';
import type { StateTone } from './state-tone-core.ts';

export interface MyPrSection { title: string; prs: MyPr[] }
export interface ReadinessRow { label: 'Checks' | 'Review' | 'Threads' | 'Conflicts' | 'Base'; tone: StateTone; text: string }

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

function approvalRequiredText(pr: MyPr): string {
  const requestText = pr.reviewRequests.length > 0 ? `Requested: ${pr.reviewRequests.join(', ')}` : 'Approval required';
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
  if (pr.reviewRequests.length > 0) return { label: 'Review', tone: 'wait', text: `Requested: ${pr.reviewRequests.join(', ')}` };
  return { label: 'Review', tone: 'muted', text: 'No review requested' };
}

function threadsReadiness(pr: MyPr): ReadinessRow {
  if (pr.unresolvedThreads > 0) return { label: 'Threads', tone: 'warn', text: `${pr.unresolvedThreads} unresolved` };
  return { label: 'Threads', tone: 'ok', text: 'None open' };
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

export function readinessRows(pr: MyPr): ReadinessRow[] {
  if (pr.state === 'MERGED') return [];
  return [checksReadiness(pr), reviewReadiness(pr), threadsReadiness(pr), conflictsReadiness(pr), baseReadiness(pr)];
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
