import { GithubIssueResponse, IssueUpdate } from '../../../shared/contracts/issues.ts';
import type { CommandResult } from '../../git/git-exec.ts';
import { repoParts } from '../../../shared/contracts/github-ids.ts';
import { secondaryRateLimitWaitMs } from '../../lanes/core/lane-backoff.ts';
import { z } from 'zod';
import { MyPrMergeStateResponse } from '../../../shared/contracts/my-prs.ts';
import type { MyPrMergeKind } from '../../../shared/contracts/my-prs.ts';
import { errorMessage } from '../../../shared/text.ts';
import { parseJsonOrNull } from '../../core/json-core.ts';
import { isOrgMemberAssociation } from '../core/github-store-core.ts';
import type { PrReference } from './pr-gh-queries.ts';
import { GRAPHQL_ALIAS_NOT_FOUND_ERROR, GRAPHQL_ERROR_ALIAS } from './pr-gh-responses.ts';

interface GithubIssueLabelRow {
  name?: unknown;
  color?: unknown;
}

interface GithubIssueRow {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  url?: unknown;
  updatedAt?: unknown;
}

interface GithubIssueLabel {
  name: string;
  color: string;
}

interface GithubIssue {
  number: number;
  title: string;
  body: string;
  labels: GithubIssueLabel[];
  url: string;
  updatedAt: string;
}

interface RestValidators {
  etag?: string;
  lastModified?: string;
}

type RestMetadata = RestValidators & { pollIntervalSeconds?: number };

type ConditionalGetResult =
  | ({ kind: 'unchanged' } & RestMetadata)
  | ({ kind: 'ok'; body: unknown } & RestMetadata)
  | { kind: 'forbidden'; message: string }
  | { kind: 'error'; message: string };

function mergeKindFromPrState(prStateJson: string): MyPrMergeKind {
  const parsed = MyPrMergeStateResponse.safeParse(parseJsonOrNull(prStateJson));
  if (!parsed.success || parsed.data.errors?.length) return 'unconfirmed';
  const pullRequest = parsed.data.data.repository?.pullRequest;
  if (!pullRequest) return 'unconfirmed';
  if (pullRequest.state === 'MERGED') return 'merged';
  if (pullRequest.state !== 'OPEN') return 'unconfirmed';
  if (pullRequest.isInMergeQueue) return 'queued';
  if (pullRequest.autoMergeRequest !== null) return 'auto-merge';
  return 'unconfirmed';
}

const HEX_LABEL_COLOR = /^[0-9a-f]{6}$/i;

function aliasesOfErrors(errors: readonly unknown[]): Set<string> | null {
  const aliases = new Set<string>();
  for (const error of errors) {
    const parsed = GRAPHQL_ERROR_ALIAS.safeParse(error);
    if (!parsed.success) return null;
    if (isWorkflowRunPath(parsed.data.path)) continue;
    aliases.add(parsed.data.path[0]);
  }
  return aliases;
}

function isWorkflowRunPath(path: readonly (string | number)[]): boolean {
  return path.some((segment, index) => segment === 'checkSuite' && path[index + 1] === 'workflowRun');
}

function aliasesReportedGone(errors: readonly unknown[]): Set<string> {
  return new Set(errors.flatMap((error) => {
    const parsed = GRAPHQL_ALIAS_NOT_FOUND_ERROR.safeParse(error);
    return parsed.success ? [parsed.data.path[0]] : [];
  }));
}

function isPrNumber(number: number): boolean {
  return Number.isSafeInteger(number) && number > 0;
}

function reviewSnapshotKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function uniqueValidPrs(prs: readonly PrReference[]): PrReference[] {
  const byKey = new Map<string, PrReference>();
  for (const pr of prs) {
    if (!repoParts(pr.repo) || !isPrNumber(pr.number)) continue;
    byKey.set(reviewSnapshotKey(pr.repo, pr.number), { repo: pr.repo, number: pr.number });
  }
  return [...byKey.values()];
}

function isPullRequest(candidate: unknown): boolean {
  const parsed = z.object({ pull_request: z.unknown().optional() }).safeParse(candidate);
  return parsed.success && parsed.data.pull_request !== undefined;
}

function parseGithubIssue(candidate: unknown, repository?: string): IssueUpdate | null {
  const parsed = GithubIssueResponse.safeParse(candidate);
  if (!parsed.success) return null;
  const issue = parsed.data;
  const repo = repository ?? (issue.repository_url ? new URL(issue.repository_url).pathname.replace(/^\/repos\//, '') : '');
  if (!repoParts(repo)) return null;
  return IssueUpdate.parse({
    key: `${repo}#${issue.number}`, repo, number: issue.number, title: issue.title, url: issue.html_url,
    labels: issue.labels.map((label) => typeof label === 'string' ? label : label.name),
    assignees: issue.assignees.map((assignee) => assignee.login), author: issue.user?.login ?? '', isAuthorOrgMember: isOrgMemberAssociation(issue.author_association), comments: issue.comments,
    createdAt: issue.created_at, updatedAt: issue.updated_at, state: issue.state,
  });
}

function normalizeIssueLabel(candidate: unknown): GithubIssueLabel | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const label = candidate as GithubIssueLabelRow;
  const name = typeof label.name === 'string' ? label.name.trim() : '';
  if (!name) return null;
  const color = typeof label.color === 'string' ? label.color.trim() : '';
  return { name, color: HEX_LABEL_COLOR.test(color) ? color : '' };
}

function normalizeIssue(row: GithubIssueRow): GithubIssue | null {
  const number = typeof row.number === 'number' && Number.isInteger(row.number) && row.number > 0 ? row.number : 0;
  if (number === 0) return null;
  const labels = Array.isArray(row.labels)
    ? row.labels.map(normalizeIssueLabel).filter((label): label is GithubIssueLabel => label !== null)
    : [];
  return {
    number,
    title: typeof row.title === 'string' ? row.title.trim() : '',
    body: typeof row.body === 'string' ? row.body : '',
    labels,
    url: typeof row.url === 'string' ? row.url : '',
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
  };
}

function conditionalGetResult(response: CommandResult): ConditionalGetResult {
  const statusLine = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s|$)/.exec(response.out);
  if (!statusLine) return { kind: 'error', message: response.err.trim() || 'invalid gh HTTP response' };
  const status = Number(statusLine[1]);
  const headerBoundary = /\r?\n\r?\n/.exec(response.out);
  const headerText = headerBoundary ? response.out.slice(0, headerBoundary.index) : response.out;
  const headers = new Map<string, string>();
  for (const line of headerText.split(/\r?\n/).slice(1)) {
    const colonIndex = line.indexOf(':');
    if (colonIndex < 1) continue;
    headers.set(line.slice(0, colonIndex).trim().toLowerCase(), line.slice(colonIndex + 1).trim());
  }
  const etag = headers.get('etag');
  const lastModified = headers.get('last-modified');
  const pollInterval = headers.get('x-poll-interval');
  const pollIntervalSeconds = pollInterval && /^\d+$/.test(pollInterval) ? Number(pollInterval) : NaN;
  const metadata: RestMetadata = {
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
    ...(Number.isSafeInteger(pollIntervalSeconds) ? { pollIntervalSeconds } : {}),
  };
  if (status === 304) return { kind: 'unchanged', ...metadata };
  const message = response.err.trim() || `gh HTTP ${status}`;
  const isRateLimited = headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after') || secondaryRateLimitWaitMs(message) !== null;
  if (status === 401 || (status === 403 && !isRateLimited)) return { kind: 'forbidden', message };
  if (status !== 200 || !response.ok) return { kind: 'error', message };
  if (!headerBoundary) return { kind: 'error', message: 'invalid gh HTTP response' };
  try {
    const body: unknown = JSON.parse(response.out.slice(headerBoundary.index + headerBoundary[0].length));
    return { kind: 'ok', body, ...metadata };
  } catch (error) {
    return { kind: 'error', message: errorMessage(error) };
  }
}

export { aliasesOfErrors, aliasesReportedGone, conditionalGetResult, isPrNumber, isPullRequest, mergeKindFromPrState, normalizeIssue, parseGithubIssue, reviewSnapshotKey, uniqueValidPrs };
export type { ConditionalGetResult, GithubIssue, GithubIssueRow, RestValidators };
