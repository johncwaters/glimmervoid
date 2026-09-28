import { MyPrsStatus } from '#shared/contracts/my-prs.ts';
import type { MyPr, MyPrStage, MyPrsStatus as MyPrsStatusType } from '#shared/contracts/my-prs.ts';

export interface MyPrSection { title: string; prs: MyPr[] }
type StageTone = 'danger' | 'warn' | 'wait' | 'ok' | 'muted';

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
const STAGE_TONES: Record<MyPrStage, StageTone> = {
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
export function stageTone(stage: MyPrStage): StageTone { return STAGE_TONES[stage]; }

export function factLines(pr: MyPr): string[] {
  const lines: string[] = [];
  if (pr.behindBy !== null && pr.behindBy > 0) lines.push(`${pr.behindBy} behind ${pr.baseRefName}`);
  if (pr.unresolvedThreads > 0) lines.push(`${pr.unresolvedThreads} unresolved ${pr.unresolvedThreads === 1 ? 'thread' : 'threads'}`);
  if (pr.checks.failing.length > 0) {
    const extra = pr.checks.failing.length - 3;
    lines.push(`Failing: ${pr.checks.failing.slice(0, 3).join(', ')}${extra > 0 ? ` and ${extra} more` : ''}`);
  }
  if (pr.checks.pendingCount > 0) lines.push(`${pr.checks.pendingCount} ${pr.checks.pendingCount === 1 ? 'check' : 'checks'} running`);
  if (pr.reviewRequests.length > 0) lines.push(`Review requested: ${pr.reviewRequests.join(', ')}`);
  if (pr.approvals > 0) lines.push(`${pr.approvals} ${pr.approvals === 1 ? 'approval' : 'approvals'}`);
  if (pr.mergeable === 'MERGEABLE') lines.push('No conflicts');
  return lines;
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
