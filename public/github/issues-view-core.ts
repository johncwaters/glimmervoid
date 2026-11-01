import { pullRequestKeyFromReference } from '#shared/contracts/control-messages.ts';
import type { GithubPr } from '#shared/contracts/github-prs.ts';
import { issuePullRequestStateFromGithub } from '#shared/contracts/issues.ts';
import type { IssuePullRequest, IssueRow, IssuesStatus } from '#shared/contracts/issues.ts';
import { STATE_ICONS } from '#shared/state-icons.ts';
import type { StatusIcon } from '#shared/state-icons.ts';
import { BADGE_LABELS, STATES } from '#shared/states.ts';
import type { PrStatusIcon } from './pr-status-icon-core.ts';
import { sessionAttentionTier } from '../focus-view/attention-core.ts';

export type { IssueRow };
export type IssueStep = 'triage' | 'shape' | 'running' | 'review' | 'close';
type IssueGroup = 'failed' | 'waiting' | 'review' | 'close' | 'shape' | 'triage' | 'running';
export type IssueList = 'needs-you' | 'everything-else';
export const ISSUE_STEPS: readonly IssueStep[] = ['triage', 'shape', 'running', 'review', 'close'];
const ISSUE_GROUP_ORDER: readonly IssueGroup[] = ['failed', 'waiting', 'review', 'close', 'shape', 'triage', 'running'];

interface IssueLinkedSession { state: string; stateSince: number; isMonitoring?: boolean }
export interface IssueStepInput { issue: IssueRow; session: IssueLinkedSession | null; pullRequestStates: readonly IssuePullRequest['state'][] }
interface IssueQuery { steps: string[]; sources: string[]; repos: string[]; labels: string[]; has: string[]; isUnassignedOnly: boolean; text: string[] }
type IssueStatusIcon = { kind: 'session'; icon: StatusIcon } | { kind: 'pr'; icon: PrStatusIcon };
export interface IssueStatus { group: IssueGroup; icon: IssueStatusIcon; text: string }

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

export function issueGroupOf(input: IssueStepInput): IssueGroup {
  const step = issueStepOf(input);
  if (step !== 'running' || !input.session) return step;
  if (input.session.state === STATES.FAILED) return 'failed';
  if (sessionAttentionTier({ state: input.session.state }) === 'now') return 'waiting';
  return 'running';
}

function issueListOf(input: IssueStepInput): IssueList {
  return issueGroupOf(input) === 'running' ? 'everything-else' : 'needs-you';
}

export function issueWaitStartMs({ issue, session }: IssueStepInput): number {
  if (session) return session.stateSince;
  return Date.parse(issue.updatedAt) || 0;
}

export function orderedIssuesIn(list: IssueList, inputs: readonly IssueStepInput[]): IssueStepInput[] {
  const rankByGroup = new Map(ISSUE_GROUP_ORDER.map((group, rank) => [group, rank]));
  return inputs
    .filter((input) => issueListOf(input) === list)
    .map((input) => ({ input, rank: rankByGroup.get(issueGroupOf(input)) ?? ISSUE_GROUP_ORDER.length, waitStartMs: issueWaitStartMs(input) }))
    .sort((first, second) => first.rank - second.rank || first.waitStartMs - second.waitStartMs || first.input.issue.key.localeCompare(second.input.issue.key))
    .map(({ input }) => input);
}

function pullRequestAt(input: IssueStepInput, wantedStates: readonly IssuePullRequest['state'][]): { number: number; state: IssuePullRequest['state'] } | null {
  const index = input.pullRequestStates.findIndex((state) => wantedStates.includes(state));
  const pullRequest = index === -1 ? undefined : input.issue.pullRequests[index];
  const state = input.pullRequestStates[index];
  if (!pullRequest || !state) return null;
  return { number: pullRequest.number, state };
}

function reviewStatus(input: IssueStepInput): IssueStatus {
  const pullRequest = pullRequestAt(input, ['open', 'draft']);
  if (pullRequest?.state === 'draft') return { group: 'review', icon: { kind: 'pr', icon: 'draft' }, text: `PR #${pullRequest.number} is a draft` };
  return { group: 'review', icon: { kind: 'pr', icon: 'ready' }, text: pullRequest ? `PR #${pullRequest.number} ready for review` : 'PR ready for review' };
}

const statusIconByState: ReadonlyMap<string, StatusIcon> = new Map(Object.entries(STATE_ICONS));
const badgeLabelByState: ReadonlyMap<string, string> = new Map(Object.entries(BADGE_LABELS));

function runningIcon(session: IssueLinkedSession | null): StatusIcon {
  if (!session) return 'working';
  if (session.isMonitoring) return 'monitoring';
  return statusIconByState.get(session.state) ?? 'working';
}

function runningText(session: IssueLinkedSession | null): string {
  if (!session) return 'Working';
  if (session.isMonitoring) return 'Monitoring';
  return badgeLabelByState.get(session.state) ?? 'Working';
}

export function issueStatusOf(input: IssueStepInput): IssueStatus {
  const group = issueGroupOf(input);
  if (group === 'failed') return { group, icon: { kind: 'session', icon: 'failed' }, text: 'Session failed' };
  if (group === 'waiting') return { group, icon: { kind: 'session', icon: 'needs-input' }, text: 'Waiting on you' };
  if (group === 'review') return reviewStatus(input);
  if (group === 'close') return { group, icon: { kind: 'pr', icon: 'merged' }, text: 'PR merged, issue open' };
  if (group === 'shape') return { group, icon: { kind: 'session', icon: 'not-started' }, text: 'Assigned to you' };
  if (group === 'triage') return { group, icon: { kind: 'session', icon: 'not-started' }, text: 'New to you' };
  return { group, icon: { kind: 'session', icon: runningIcon(input.session) }, text: runningText(input.session) };
}

const SOURCE_BY_IS_VALUE: ReadonlyMap<string, string> = new Map([['mine', 'me'], ['team', 'team'], ['project', 'project']]);
const STEP_OR_GROUP_VALUES: ReadonlySet<string> = new Set([...ISSUE_STEPS, ...ISSUE_GROUP_ORDER]);

function addQueryTerm(query: IssueQuery, term: string): void {
  const separatorIndex = term.indexOf(':');
  const qualifier = separatorIndex > 0 ? term.slice(0, separatorIndex) : '';
  const value = term.slice(separatorIndex + 1);
  if (qualifier === 'is' && value === 'unassigned') { query.isUnassignedOnly = true; return; }
  if (qualifier === 'is' && SOURCE_BY_IS_VALUE.has(value)) { query.sources.push(SOURCE_BY_IS_VALUE.get(value) ?? value); return; }
  if (qualifier === 'is' && STEP_OR_GROUP_VALUES.has(value)) { query.steps.push(value); return; }
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
  if (query.steps.length > 0 && !query.steps.some((value) => value === issueStepOf(input) || value === issueGroupOf(input))) return false;
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
