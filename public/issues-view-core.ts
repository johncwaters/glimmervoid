import type { GithubIssueRow } from '#shared/contracts/control-messages.ts';

export type IssueRow = GithubIssueRow;
export type IssueLabel = GithubIssueRow['labels'][number];

export function summarizeIssues(issues: IssueRow[]) {
  return { open: issues.length, labeled: issues.filter((issue) => issue.labels.length > 0).length };
}

export function issuesPlaceholder({ hasProjects }: { hasProjects: boolean }): string {
  if (!hasProjects) return 'No projects configured. Add a project in Settings.';
  return 'Press Refresh to load open issues.';
}
