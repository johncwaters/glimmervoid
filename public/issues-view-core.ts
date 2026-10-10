import type { IssueRow, IssuesStatus } from '#shared/contracts/issues.ts';

export type { IssueRow };

export function summarizeIssues(issues: IssueRow[]) {
  return { open: issues.length, labeled: issues.filter((issue) => issue.labels.length > 0).length };
}

export function issuesPlaceholder(status: Pick<IssuesStatus, 'configured' | 'reason'> | null): string {
  if (!status) return 'Loading issues.';
  if (!status.configured) return status.reason ?? 'Loading issues.';
  return 'No open issues.';
}
