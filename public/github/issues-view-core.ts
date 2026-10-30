import { pullRequestKeyFromReference } from '#shared/contracts/control-messages.ts';
import type { GithubPr } from '#shared/contracts/github-prs.ts';
import { issuePullRequestStateFromGithub } from '#shared/contracts/issues.ts';
import type { IssuePullRequest, IssueRow, IssuesStatus } from '#shared/contracts/issues.ts';
import { STATES } from '#shared/states.ts';
import { sessionAttentionTier } from '../focus-view/attention-core.ts';

export type { IssueRow };
export type IssueStep = 'triage' | 'shape' | 'running' | 'review' | 'close';
export type IssueTier = 'needs' | 'failed' | 'close' | 'review' | 'working' | 'shape' | 'triage';
export const ISSUE_STEPS: readonly IssueStep[] = ['triage', 'shape', 'running', 'review', 'close'];
const ISSUE_TIER_ORDER: readonly IssueTier[] = ['needs', 'failed', 'close', 'review', 'working', 'shape', 'triage'];

interface IssueLinkedSession { state: string; stateSince: number }
export interface IssueStepInput { issue: IssueRow; session: IssueLinkedSession | null; pullRequestStates: readonly IssuePullRequest['state'][] }
interface IssueTierGroup { tier: IssueTier; inputs: IssueStepInput[] }
interface IssueQuery { steps: string[]; sources: string[]; repos: string[]; labels: string[]; has: string[]; isUnassignedOnly: boolean; text: string[] }

export function summarizeIssues(issues: IssueRow[]) {
  return { open: issues.length, labeled: issues.filter((issue) => issue.labels.length > 0).length };
}

export function issuesPlaceholder(status: Pick<IssuesStatus, 'configured' | 'reason'> | null): string {
  if (!status) return 'Loading issues.';
  if (!status.configured) return status.reason ?? 'Loading issues.';
  return 'No open issues.';
}

export function issueStepOf({ issue, session, pullRequestStates }: IssueStepInput): IssueStep {
  if (pullRequestStates.some((state) => state === 'open' || state === 'draft')) return 'review';
  if (pullRequestStates.includes('merged')) return 'close';
  if (session) return 'running';
  if (issue.sources.includes('me')) return 'shape';
  return 'triage';
}

export function issueTierOf(input: IssueStepInput): IssueTier {
  const step = issueStepOf(input);
  if (step !== 'running') return step;
  if (!input.session) return 'working';
  if (sessionAttentionTier({ state: input.session.state }) === 'now') return 'needs';
  if (input.session.state === STATES.FAILED) return 'failed';
  return 'working';
}

export function issueWaitStartMs({ issue, session }: IssueStepInput): number {
  if (session) return session.stateSince;
  return Date.parse(issue.updatedAt) || 0;
}

export function tierIssues(inputs: readonly IssueStepInput[]): IssueTierGroup[] {
  const inputsByTier = new Map<IssueTier, IssueStepInput[]>(ISSUE_TIER_ORDER.map((tier) => [tier, []]));
  for (const input of inputs) inputsByTier.get(issueTierOf(input))?.push(input);
  return ISSUE_TIER_ORDER
    .map((tier) => ({ tier, inputs: (inputsByTier.get(tier) ?? []).sort((first, second) => issueWaitStartMs(first) - issueWaitStartMs(second) || first.issue.key.localeCompare(second.issue.key)) }))
    .filter((group) => group.inputs.length > 0);
}

export function issueStepCounts(inputs: readonly IssueStepInput[]): { byStep: Record<IssueStep, number>; needsYou: number } {
  const byStep: Record<IssueStep, number> = { triage: 0, shape: 0, running: 0, review: 0, close: 0 };
  let needsYou = 0;
  for (const input of inputs) {
    byStep[issueStepOf(input)] += 1;
    if (issueTierOf(input) === 'needs') needsYou += 1;
  }
  return { byStep, needsYou };
}

const SOURCE_BY_IS_VALUE: ReadonlyMap<string, string> = new Map([['mine', 'me'], ['team', 'team'], ['project', 'project']]);
const STEP_OR_TIER_VALUES: ReadonlySet<string> = new Set([...ISSUE_STEPS, ...ISSUE_TIER_ORDER]);

function addQueryTerm(query: IssueQuery, term: string): void {
  const separatorIndex = term.indexOf(':');
  const qualifier = separatorIndex > 0 ? term.slice(0, separatorIndex) : '';
  const value = term.slice(separatorIndex + 1);
  if (qualifier === 'is' && value === 'unassigned') { query.isUnassignedOnly = true; return; }
  if (qualifier === 'is' && SOURCE_BY_IS_VALUE.has(value)) { query.sources.push(SOURCE_BY_IS_VALUE.get(value) ?? value); return; }
  if (qualifier === 'is' && STEP_OR_TIER_VALUES.has(value)) { query.steps.push(value); return; }
  if (qualifier === 'repo' && value) { query.repos.push(value); return; }
  if (qualifier === 'label' && value) { query.labels.push(value); return; }
  if (qualifier === 'has' && (value === 'session' || value === 'pr')) { query.has.push(value); return; }
  query.text.push(term);
}

export function parseIssueQuery(raw: string): IssueQuery {
  const query: IssueQuery = { steps: [], sources: [], repos: [], labels: [], has: [], isUnassignedOnly: false, text: [] };
  for (const term of raw.trim().toLowerCase().split(/\s+/).filter(Boolean)) addQueryTerm(query, term);
  return query;
}

export function matchesIssueQuery(input: IssueStepInput, query: IssueQuery): boolean {
  const { issue } = input;
  if (query.steps.length > 0 && !query.steps.some((value) => value === issueStepOf(input) || value === issueTierOf(input))) return false;
  if (query.sources.length > 0 && !query.sources.some((source) => issue.sources.some((issueSource) => issueSource === source))) return false;
  if (query.repos.length > 0 && !query.repos.some((repo) => issue.repo.toLowerCase().includes(repo))) return false;
  if (query.labels.length > 0 && !query.labels.every((label) => issue.labels.some((issueLabel) => issueLabel.toLowerCase() === label))) return false;
  if (query.has.includes('session') && !input.session) return false;
  if (query.has.includes('pr') && issue.pullRequests.length === 0) return false;
  if (query.isUnassignedOnly && issue.assignees.length > 0) return false;
  const searchableText = [issue.title, `#${issue.number}`, issue.repo, issue.author, ...issue.labels, ...issue.assignees, ...issue.teams].join(' ').toLowerCase();
  return query.text.every((term) => searchableText.includes(term));
}

export function isIssueQueryActive(query: IssueQuery): boolean {
  return query.steps.length + query.sources.length + query.repos.length + query.labels.length + query.has.length + query.text.length > 0 || query.isUnassignedOnly;
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

export function issuePullRequestState(pullRequest: IssuePullRequest, githubPrByKey: (key: string) => GithubPr | undefined): IssuePullRequest['state'] {
  const key = pullRequestKeyFromReference(pullRequest.url);
  const pr = key ? githubPrByKey(key.toLowerCase()) : undefined;
  if (!pr) return pullRequest.state;
  return issuePullRequestStateFromGithub(pr);
}
