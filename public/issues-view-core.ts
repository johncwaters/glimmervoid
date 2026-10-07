import type { GithubIssueRow } from '#shared/contracts/control-messages.ts';

export type IssueRow = GithubIssueRow;
export type IssueLabel = GithubIssueRow['labels'][number];
export type LabelMatch = 'any' | 'all';

export const ISSUE_ASSIGNEE_ANYONE = '';
export const ISSUE_ASSIGNEE_NONE = ':unassigned';
export const ISSUES_SEARCH_PLACEHOLDER = 'Search title, #number, label or assignee';
export const ISSUES_NO_MATCH_TEXT = 'No issues match these filters.';
export const LABEL_MATCH_TITLES: Record<LabelMatch, string> = {
  any: 'Show issues with any selected label (OR)',
  all: 'Show issues with every selected label (AND)',
};

export interface IssueFilter {
  text: string;
  labels: string[];
  labelMatch: LabelMatch;
  assignee: string;
}

export interface LabelFacetEntry {
  name: string;
  shortName: string;
  color: string;
  count: number;
}

export interface LabelFacet {
  group: string;
  title: string;
  labels: LabelFacetEntry[];
}

export interface AssigneeOption {
  value: string;
  label: string;
  count: number;
}

const PRIORITY_LABEL = /^p\d+$/i;
const ISSUE_NUMBER_TERM = /^#(\d+)$/;
const PRIORITY_GROUP = 'priority';
const OTHER_GROUP = 'other';

export function summarizeIssues(issues: IssueRow[]) {
  return { open: issues.length, labeled: issues.filter((issue) => issue.labels.length > 0).length };
}

export function issuesPlaceholder({ hasProjects }: { hasProjects: boolean }): string {
  if (!hasProjects) return 'No projects configured. Add a project in Settings.';
  return 'Press Refresh to load open issues.';
}

export function emptyIssueFilter(): IssueFilter {
  return { text: '', labels: [], labelMatch: 'any', assignee: ISSUE_ASSIGNEE_ANYONE };
}

export function searchTerms(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
}

export function isIssueFilterActive(filter: IssueFilter): boolean {
  return searchTerms(filter.text).length > 0 || filter.labels.length > 0 || filter.assignee !== ISSUE_ASSIGNEE_ANYONE;
}

export function toggleIssueLabel(filter: IssueFilter, name: string): IssueFilter {
  const labels = filter.labels.includes(name)
    ? filter.labels.filter((label) => label !== name)
    : [...filter.labels, name];
  return { ...filter, labels };
}

function assigneesOf(issue: IssueRow): string[] {
  return issue.assignees ?? [];
}

function searchableText(issue: IssueRow): string {
  return [`#${issue.number}`, issue.title, ...issue.labels.map((label) => label.name), ...assigneesOf(issue)].join(' ').toLowerCase();
}

function matchesTerm(issue: IssueRow, text: string, term: string): boolean {
  const numberTerm = ISSUE_NUMBER_TERM.exec(term);
  if (numberTerm) return issue.number === Number(numberTerm[1]);
  return text.includes(term);
}

function matchesLabels(issue: IssueRow, filter: IssueFilter): boolean {
  if (filter.labels.length === 0) return true;
  const names = new Set(issue.labels.map((label) => label.name));
  if (filter.labelMatch === 'all') return filter.labels.every((name) => names.has(name));
  return filter.labels.some((name) => names.has(name));
}

function matchesAssignee(issue: IssueRow, assignee: string): boolean {
  if (assignee === ISSUE_ASSIGNEE_ANYONE) return true;
  const assignees = assigneesOf(issue);
  if (assignee === ISSUE_ASSIGNEE_NONE) return assignees.length === 0;
  return assignees.includes(assignee);
}

export function filterIssues(issues: IssueRow[], filter: IssueFilter): IssueRow[] {
  const terms = searchTerms(filter.text);
  return issues.filter((issue) => {
    if (!matchesLabels(issue, filter)) return false;
    if (!matchesAssignee(issue, filter.assignee)) return false;
    if (terms.length === 0) return true;
    const text = searchableText(issue);
    return terms.every((term) => matchesTerm(issue, text, term));
  });
}

export function labelGroupOf(name: string): string {
  if (PRIORITY_LABEL.test(name)) return PRIORITY_GROUP;
  const slash = name.indexOf('/');
  if (slash > 0) return name.slice(0, slash).toLowerCase();
  return OTHER_GROUP;
}

function shortLabelName(name: string, group: string): string {
  const prefix = `${group}/`;
  if (name.toLowerCase().startsWith(prefix) && name.length > prefix.length) return name.slice(prefix.length);
  return name;
}

function groupRank(group: string): number {
  if (group === PRIORITY_GROUP) return 0;
  if (group === OTHER_GROUP) return 2;
  return 1;
}

function facetTitle(group: string): string {
  if (group === PRIORITY_GROUP) return 'Priority';
  if (group === OTHER_GROUP) return 'Other';
  return group;
}

export function labelFacets(issues: IssueRow[], selected: string[] = []): LabelFacet[] {
  const entries = new Map<string, LabelFacetEntry>();
  for (const issue of issues) {
    for (const label of issue.labels) {
      const entry = entries.get(label.name) ?? { name: label.name, shortName: '', color: label.color, count: 0 };
      entry.count += 1;
      entries.set(label.name, entry);
    }
  }
  for (const name of selected) {
    if (!entries.has(name)) entries.set(name, { name, shortName: '', color: '', count: 0 });
  }
  const groups = new Map<string, LabelFacetEntry[]>();
  for (const entry of entries.values()) {
    const group = labelGroupOf(entry.name);
    groups.set(group, [...(groups.get(group) ?? []), { ...entry, shortName: shortLabelName(entry.name, group) }]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => groupRank(left) - groupRank(right) || left.localeCompare(right))
    .map(([group, labels]) => ({
      group,
      title: facetTitle(group),
      labels: labels.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true })),
    }));
}

export function assigneeOptions(issues: IssueRow[]): AssigneeOption[] {
  const counts = new Map<string, number>();
  let unassigned = 0;
  for (const issue of issues) {
    const assignees = assigneesOf(issue);
    if (assignees.length === 0) unassigned += 1;
    for (const login of assignees) counts.set(login, (counts.get(login) ?? 0) + 1);
  }
  return [
    { value: ISSUE_ASSIGNEE_ANYONE, label: 'Anyone', count: issues.length },
    { value: ISSUE_ASSIGNEE_NONE, label: 'Unassigned', count: unassigned },
    ...[...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([login, count]) => ({ value: login, label: login, count })),
  ];
}

export function issuesShownText(shown: number, total: number): string {
  if (shown === total) return `${total} ${total === 1 ? 'issue' : 'issues'}`;
  return `Showing ${shown} of ${total}`;
}
