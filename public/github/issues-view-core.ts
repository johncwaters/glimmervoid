import type { IssueRow, IssuesStatus } from '#shared/contracts/issues.ts';

export type { IssueRow };
export type IssueScope = 'all' | 'me' | 'team' | 'project';
export type IssueSort = 'updated' | 'created' | 'comments';

export interface IssueFilters {
  scope: IssueScope;
  repo: string;
  label: string;
  sort: IssueSort;
  query: string;
  hasSession: boolean;
  hasPr: boolean;
  isUnassignedOnly: boolean;
}

export function summarizeIssues(issues: IssueRow[]) {
  return { open: issues.length, labeled: issues.filter((issue) => issue.labels.length > 0).length };
}

export function issuesPlaceholder(status: Pick<IssuesStatus, 'configured' | 'reason'> | null): string {
  if (!status) return 'Loading issues.';
  if (!status.configured) return status.reason ?? 'Loading issues.';
  return 'No open issues.';
}

export function matchesIssueScope(issue: IssueRow, scope: IssueScope): boolean {
  return scope === 'all' || issue.sources.includes(scope);
}

export function issueScopeCounts(issues: readonly IssueRow[]): Record<IssueScope, number> {
  return {
    all: issues.length,
    me: issues.filter((issue) => matchesIssueScope(issue, 'me')).length,
    team: issues.filter((issue) => matchesIssueScope(issue, 'team')).length,
    project: issues.filter((issue) => matchesIssueScope(issue, 'project')).length,
  };
}

export function filterIssues(issues: readonly IssueRow[], filters: IssueFilters, liveSessionIds: ReadonlySet<string>): IssueRow[] {
  const searchTerms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = issues.filter((issue) => {
    if (!matchesIssueScope(issue, filters.scope)) return false;
    if (filters.repo && issue.repo !== filters.repo) return false;
    if (filters.label && !issue.labels.includes(filters.label)) return false;
    if (filters.hasSession && (!issue.sessionId || !liveSessionIds.has(issue.sessionId))) return false;
    if (filters.hasPr && issue.pullRequests.length === 0) return false;
    if (filters.isUnassignedOnly && issue.assignees.length > 0) return false;
    const searchableText = [issue.title, `#${issue.number}`, issue.repo, issue.author, ...issue.labels, ...issue.assignees, ...issue.teams].join(' ').toLowerCase();
    return searchTerms.every((term) => searchableText.includes(term));
  });
  const timestamp = (value: string): number => Date.parse(value) || 0;
  const sortValue = (issue: IssueRow): number => {
    if (filters.sort === 'comments') return issue.comments;
    if (filters.sort === 'created') return timestamp(issue.createdAt);
    return timestamp(issue.updatedAt);
  };
  return visible.sort((first, second) => sortValue(second) - sortValue(first) || first.key.localeCompare(second.key));
}

export function groupIssuesByRepo(issues: readonly IssueRow[]): Map<string, IssueRow[]> {
  const issuesByRepo = new Map<string, IssueRow[]>();
  for (const issue of issues) {
    const repoIssues = issuesByRepo.get(issue.repo) ?? [];
    repoIssues.push(issue);
    issuesByRepo.set(issue.repo, repoIssues);
  }
  return issuesByRepo;
}

export function issueFilterOptions(issues: readonly IssueRow[]): { repos: string[]; labels: string[] } {
  return {
    repos: [...new Set(issues.map((issue) => issue.repo))].sort(),
    labels: [...new Set(issues.flatMap((issue) => issue.labels))].sort(),
  };
}

export function issueFilterSummary(filters: IssueFilters): string {
  const active = [filters.query.trim() && `search "${filters.query.trim()}"`, filters.repo, filters.label, filters.hasSession && 'has session', filters.hasPr && 'has PR', filters.isUnassignedOnly && 'unassigned'].filter(Boolean);
  return active.length === 0 ? '' : `Filtered by ${active.join(', ')}.`;
}

export function issueRelativeAge(timestamp: string | number, nowMs: number): string {
  const timestampMs = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return 'unknown';
  const minutes = Math.round(Math.max(0, nowMs - timestampMs) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function issueAgo(timestamp: string | number, nowMs: number): string {
  const age = issueRelativeAge(timestamp, nowMs);
  if (age === 'now') return 'just now';
  if (age === 'unknown') return 'at an unknown time';
  return `${age} ago`;
}
