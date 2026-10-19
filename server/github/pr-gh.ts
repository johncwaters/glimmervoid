import { GithubIssueResponse, GithubIssuePullRequestsRepository, IssueKey, IssueUpdate, IssuesSearchResponse } from '../../shared/contracts/issues.ts';
import type { IssuePullRequest, IssuesFetchResult } from '../../shared/contracts/issues.ts';
import { comparablePrKey, GithubPrDetailNode, GithubPrLightSearchNode } from '../../shared/contracts/github-prs.ts';
import type { GithubPrDetailNode as GithubPrDetailNodeType, GithubPrLightSearchNode as GithubPrLightSearchNodeType } from '../../shared/contracts/github-prs.ts';
import { runCommand } from '../git/git-exec.ts';
import type { CommandResult } from '../git/git-exec.ts';
import { GH_SEGMENT, NODE_ID_RE, repoParts } from '../../shared/contracts/github-ids.ts';
import { GithubRateLimitResources, githubRateLimitWaitMs } from './core/github-rate-limit-core.ts';
import { secondaryRateLimitWaitMs } from '../lanes/core/lane-backoff.ts';
import { z } from 'zod';
import { CommitSha, TeamReviewThreadCommentsResponse, TeamReviewThreadsRepository, TeamReviewResolveResponse, ReviewThreadId, TeamReviewCompareFiles, PrDetail, ReviewComment } from '../../shared/contracts/team-review.ts';
import { CommitComparison, MergedPrListing, MinedPrReviewData } from '../../shared/contracts/benchmark.ts';
import type { CommitComparison as CommitComparisonType, MergedPrListing as MergedPrListingType, MinedPrReviewData as MinedPrReviewDataType } from '../../shared/contracts/benchmark.ts';
import { MyPrCheckContext, MyPrCheckContextsResponse, MyPrMergeMethod, MyPrMergeStateResponse, MyPrSearchResponse, MyPrThreadNode, MyPrThreadsResponse } from '../../shared/contracts/my-prs.ts';
import type { MyPrMergeKind, MyPrMergeMethod as MyPrMergeMethodType, MyPrSearchNode as MyPrSearchNodeType, MyPrThreadNode as MyPrThreadNodeType } from '../../shared/contracts/my-prs.ts';
import { WorkflowCommentBody, WorkflowLabelName, WorkflowSearchNode } from '../../shared/contracts/workflows.ts';
import type { WorkflowSearchNode as WorkflowSearchNodeType } from '../../shared/contracts/workflows.ts';
import type { PostedReviewEvent, PrDetail as PrDetailType, ReviewComment as ReviewCommentType, TeamReviewStatus } from '../../shared/contracts/team-review.ts';

import type { TeamReviewThreadNode as ThreadNode, TeamReviewCompareFiles as CompareFiles } from '../../shared/contracts/team-review.ts';
import { errorMessage } from '../../shared/text.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { notificationSubjectPrKey } from './core/github-store-core.ts';

type GhMergeFlag = '--merge' | '--squash' | '--rebase';

const GH_MERGE_FLAGS: Readonly<Record<MyPrMergeMethodType, GhMergeFlag>> = { MERGE: '--merge', SQUASH: '--squash', REBASE: '--rebase' };

const MY_PR_MERGE_STATE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { state isInMergeQueue autoMergeRequest { enabledAt } } }
}`;

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


interface PrReference {
  repo: string;
  number: number;
}

type PrHeadReference = PrReference & { headSha: string };

interface GithubIssueDetail {
  ok: boolean;
  issue: GithubIssue | null;
  error: string;
}

interface RepoPrSearch {
  ok: boolean;
  items: WorkflowSearchNodeType[];
  isComplete: boolean;
  error: string;
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
type NotificationsSinceResult = Exclude<ConditionalGetResult, { kind: 'ok' }>
  | { kind: 'ok'; prKeys: string[]; lastModified?: string; pollIntervalSeconds?: number };

interface PrGh {
  conditionalGet(path: string, validators?: RestValidators): Promise<ConditionalGetResult>;
  searchPrsLight(qualifiers: string): Promise<{ ok: boolean; items: GithubPrLightSearchNodeType[]; isComplete: boolean; totalCount?: number; error: string }>;
  prsLightByKey(prs: readonly PrReference[]): Promise<Map<string, GithubPrLightSearchNodeType>>;
  prDetails(prs: readonly PrReference[]): Promise<Map<string, GithubPrDetailNodeType>>;
  notificationsSince(lastModified?: string): Promise<NotificationsSinceResult>;
  searchRepoPrs(repo: string, mergedSince: string): Promise<RepoPrSearch>;
  addPrLabel(label: { repo: string; number: number; name: string }): Promise<{ ok: boolean; err: string }>;
  commentOnPr(comment: { repo: string; number: number; body: string }): Promise<{ ok: boolean; err: string }>;
  behindCounts(prs: readonly PrHeadReference[]): Promise<Map<string, number>>;
  rebasePr(pullRequestId: string, expectedHeadSha: string): Promise<{ ok: boolean; err: string }>;
  mergePr(merge: { repo: string; number: number; headSha: string; method: MyPrMergeMethodType }): Promise<{ ok: true; kind: MyPrMergeKind } | { ok: false; err: string }>;
  rateLimitWaitMs(nowMs: number, resourceNames: readonly string[]): Promise<number | null>;
  teamReviewThreads(prs: readonly PrReference[]): Promise<Map<string, ThreadNode[]>>;
  resolveReviewThread(threadId: string): Promise<{ ok: boolean; err: string }>;
  teamReviewCompare(repo: string, base: string, head: string): Promise<{ ok: true; comparison: CompareFiles | null } | { ok: false; err: string }>;
  reviewThreads(repo: string, number: number): Promise<MyPrThreadNodeType[]>;
  reviewThreadsBatch(prs: readonly PrReference[]): Promise<Map<string, MyPrThreadNodeType[]>>;
  listMergedPrs(repo: string, limit: number): Promise<{ ok: true; prs: MergedPrListingType[] } | { ok: false; reason: string }>;
  benchmarkReviewData(repo: string, numbers: readonly number[]): Promise<Map<number, MinedPrReviewDataType>>;
  compareCommits(repo: string, base: string, head: string): Promise<CommitComparisonType | null>;
  repoSlug(): Promise<string | null>;
  searchIssues(query: string): Promise<IssuesFetchResult>;
  listRepoIssues(repo: string, since: string | null, maxIssues: number): Promise<IssuesFetchResult>;
  issueLinkedPullRequests(keys: readonly string[]): Promise<Map<string, IssuePullRequest[]>>;
  viewIssue(issueNumber: number | string, repo?: string): Promise<GithubIssueDetail>;
  viewer(): Promise<string | null>;
  teamMembers(org: string, team: string): Promise<string[] | null>;
  teamProfile(org: string, team: string): Promise<NonNullable<TeamReviewStatus['team']> | null>;
  viewPr(repo: string, number: number): Promise<PrDetailType | null>;
  prDiff(repo: string, number: number): Promise<string | null>;
  prHead(repo: string, number: number): Promise<string | null>;
  postReview(review: { repo: string; number: number; commitId: string; event: PostedReviewEvent; body: string; comments: ReviewCommentType[] }): Promise<PostedReview>;
  dismissReview(dismissal: { repo: string; number: number; reviewId: number; message: string }): Promise<{ ok: boolean; err: string }>;
}

interface PostedReview {
  ok: boolean;
  err: string;
  reviewId: number | null;
}

const GH_TIMEOUT_MS = 30000;
const GH_MAX_BUFFER_BYTES = 2 * 1024 * 1024 + 1;

function run(cmd: string, args: string[], cwd: string, input?: string, preserveOutput = false): Promise<CommandResult> {
  return runCommand(cmd, args, {
    cwd, input, timeoutMs: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER_BYTES, trim: !preserveOutput, keepStdoutOnFailure: true, preferStderr: true,
  });
}

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
const MERGED_SINCE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CHECK_CONTEXT_FIELDS = '__typename ... on CheckRun { name conclusion status startedAt checkSuite { app { databaseId } workflowRun { workflow { databaseId } } } } ... on StatusContext { context state }';
const MY_PR_CHECK_CONTEXTS_QUERY = `query($id: ID!, $cursor: String!) { node(id: $id) { ... on StatusCheckRollup { contexts(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${CHECK_CONTEXT_FIELDS} } } } } }`;
const MAX_CHECK_CONTEXT_PAGES = 10;
const MY_PR_FIELDS_FRAGMENT = `fragment myPrFields on PullRequest {
  __typename id number title url isDraft state createdAt mergedAt updatedAt baseRefName baseRefOid headRefName isCrossRepository headRefOid isInMergeQueue mergeable mergeStateStatus reviewDecision
  repository { nameWithOwner viewerDefaultMergeMethod }
  commits(last: 1) { nodes { commit { statusCheckRollup { id state contexts(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${CHECK_CONTEXT_FIELDS} } } } } } }
  reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug avatarUrl organization { login } } } } }
  latestOpinionatedReviews(first: 20) { nodes { state } }
  latestReviews(first: 20) { nodes { state submittedAt author { login } } }
}`;
const WORKFLOW_PR_FIELDS_FRAGMENT = `fragment workflowPrFields on PullRequest {
  author { login } labels(first: 50) { nodes { name } } comments { totalCount }
}`;

function prSearchConnection(nodeFields: string, queryVariable: string, cursorVariable?: string): string {
  const paginationArgument = cursorVariable ? `, after: $${cursorVariable}` : '';
  const pageInfo = cursorVariable ? 'pageInfo { hasNextPage endCursor } ' : '';
  return `search(type: ISSUE, first: 50, query: $${queryVariable}${paginationArgument}) { issueCount ${pageInfo}nodes { ${nodeFields} } }`;
}

function openAndMergedSearchQuery(nodeFields: string, fragments: string): string {
  return `query($openQuery: String!, $mergedQuery: String!) {
  open: ${prSearchConnection(nodeFields, 'openQuery')}
  merged: ${prSearchConnection(nodeFields, 'mergedQuery')}
}
${fragments}`;
}

function paginatedPrSearchQuery(nodeFields: string, fragments: string): string {
  return `query($searchQuery: String!, $cursor: String) {
  ${prSearchConnection(nodeFields, 'searchQuery', 'cursor')}
}
${fragments}`;
}

const GITHUB_PR_LIGHT_FIELDS = `
  repository { nameWithOwner } number updatedAt headRefOid state
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewDecision mergeable`;
const GITHUB_PRS_LIGHT_QUERY = paginatedPrSearchQuery(`... on PullRequest { ${GITHUB_PR_LIGHT_FIELDS} }`, '');
const GITHUB_PR_LIGHT_REPOSITORY = z.object({ pullRequest: GithubPrLightSearchNode.nullable() }).nullable();
const GITHUB_PRS_LIGHT_RESPONSE = z.object({ data: z.object({ search: z.object({
  issueCount: z.number().int().nonnegative(),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  nodes: z.array(GithubPrLightSearchNode),
}) }), errors: z.array(z.unknown()).optional() });
const GITHUB_PR_REVIEW_FIELDS = `author { __typename login }
  latestReviews(first: 20) { nodes { state submittedAt author { login } commit { oid } } }
  writerOpinionatedReviews: latestOpinionatedReviews(first: 20, writersOnly: true) { nodes { state } }`;
const GITHUB_PR_DETAIL_REPOSITORY = z.object({ pullRequest: GithubPrDetailNode.nullable() }).nullable();
const GITHUB_NOTIFICATIONS = z.array(z.object({ subject: z.object({ type: z.string(), url: z.string().nullable() }) }));
const MAX_GITHUB_PR_SEARCH_PAGES = 20;

function githubPrsLightByKeyQuery(prs: readonly PrReference[]): string {
  const fields = prs.map((pr, index) => {
    const [owner, name] = repoParts(pr.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) { ${GITHUB_PR_LIGHT_FIELDS} } }`;
  });
  return `query { ${fields.join(' ')} }`;
}

function githubPrDetailsQuery(prs: readonly PrReference[]): string {
  const fields = prs.map((pr, index) => {
    const [owner, name] = repoParts(pr.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) { ...myPrFields ...workflowPrFields ${GITHUB_PR_REVIEW_FIELDS} } }`;
  });
  return `query { ${fields.join(' ')} }\n${MY_PR_FIELDS_FRAGMENT}\n${WORKFLOW_PR_FIELDS_FRAGMENT}`;
}

const WORKFLOW_PRS_QUERY = openAndMergedSearchQuery('...myPrFields ...workflowPrFields', `${MY_PR_FIELDS_FRAGMENT}\n${WORKFLOW_PR_FIELDS_FRAGMENT}`);
const REBASE_PR_MUTATION = `mutation($id: ID!, $head: GitObjectID!) {
  updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $head, updateMethod: REBASE }) { pullRequest { headRefOid } }
}`;
const RESOLVE_THREAD_MUTATION = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;
const TEAM_THREAD_COMMENT_FIELDS = `pageInfo { hasNextPage endCursor } nodes { body author { login } viewerDidAuthor createdAt url originalCommit { oid } }`;
const TEAM_THREAD_FIELDS = `id path line isResolved viewerCanResolve comments(first: 100) { ${TEAM_THREAD_COMMENT_FIELDS} }`;

function teamThreadsQuery(prs: readonly PrReference[]): string {
  return reviewThreadsBatchQuery(prs).replaceAll(REVIEW_THREAD_FIELDS, TEAM_THREAD_FIELDS).replaceAll('pageInfo { hasNextPage }', 'pageInfo { hasNextPage endCursor }');
}

const REVIEW_THREAD_FIELDS = `isResolved isOutdated path line
    firstComment: comments(first: 1) { totalCount nodes { author { login } bodyText url createdAt } }
    lastComment: comments(last: 1) { nodes { author { login } createdAt } }`;
const MY_PR_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes {
    ${REVIEW_THREAD_FIELDS}
  } } } }
}`;
const GRAPHQL_THREADS_REPOSITORY = z.object({ pullRequest: z.object({
  reviewThreads: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(z.unknown()) }),
}).nullable() });

function reviewThreadsBatchQuery(prs: readonly PrReference[]): string {
  const fields = prs.map((pr, index) => {
    const [owner, name] = repoParts(pr.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) { reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { ${REVIEW_THREAD_FIELDS} } } } }`;
  });
  return `query { ${fields.join(' ')} }`;
}
const MERGED_PRS_PAGE_SIZE = 50;
const MERGED_PRS_QUERY = `query($searchQuery: String!, $first: Int!, $cursor: String) {
  search(type: ISSUE, query: $searchQuery, first: $first, after: $cursor) { pageInfo { hasNextPage endCursor } nodes {
    ... on PullRequest { number title url mergedAt reviewThreads { totalCount } reviews { totalCount } }
  } }
}`;
const MERGED_PRS_RESPONSE = z.object({ data: z.object({ search: z.object({
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  nodes: z.array(z.unknown()),
}) }) });
const BENCHMARK_REVIEW_BATCH_SIZE = 10;
const COMPARE_FILE_LIST_CAP = 300;
const COMPARE_RESPONSE = z.object({ mergeBaseSha: CommitSha, changedFiles: z.array(z.string().min(1)), fileCount: z.number().int().nonnegative() });

function benchmarkReviewDataQuery(prs: readonly PrReference[]): string {
  const fields = prs.map((pr, index) => {
    const [owner, name] = repoParts(pr.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) {
      author { __typename login } baseRefOid
      reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { path line originalLine
        comments(first: 1) { nodes { databaseId author { __typename login } body createdAt originalCommit { oid } } } } }
      reviews(first: 100) { pageInfo { hasNextPage } nodes { databaseId author { __typename login } body submittedAt commit { oid } } }
      timelineItems(first: 100, itemTypes: [BASE_REF_CHANGED_EVENT, BASE_REF_FORCE_PUSHED_EVENT]) { pageInfo { hasNextPage } nodes {
        __typename ... on BaseRefChangedEvent { createdAt } ... on BaseRefForcePushedEvent { createdAt beforeCommit { oid } } } }
    } }`;
  });
  return `query { ${fields.join(' ')} }`;
}
const GH_LOGIN = z.string().regex(GH_SEGMENT);
const GH_MEMBERS = z.array(GH_LOGIN);
const TEAM_PROFILE = z.object({ data: z.object({ organization: z.object({ team: z.object({ name: z.string(), avatarUrl: z.string().url() }).nullable() }).nullable() }), errors: z.array(z.unknown()).optional() });
const TEAM_PROFILE_QUERY = 'query($org: String!, $slug: String!) { organization(login: $org) { team(slug: $slug) { name avatarUrl } } }';
const SEARCH_PAGE_SIZE = 100;
const MAX_SEARCH_PAGES = 5;
const MAX_REVIEW_THREAD_PAGES = 5;
const PR_DIFF_MAX_BYTES = 2 * 1024 * 1024;
const CREATED_REVIEW = z.object({ id: z.number().int().positive() }).passthrough();
const REVIEW_SNAPSHOT_BATCH_SIZE = 25;
const GRAPHQL_BEHIND_REPOSITORY = z.object({
  pullRequest: z.object({ baseRef: z.object({ compare: z.object({ behindBy: z.number().int().nonnegative() }).nullable() }).nullable() }).nullable(),
});
const GRAPHQL_RESPONSE = z.object({ data: z.record(z.string(), z.unknown()).nullable(), errors: z.array(z.unknown()).optional() }).passthrough();
const GRAPHQL_ERROR_ALIAS = z.object({ path: z.tuple([z.string()]).rest(z.union([z.string(), z.number()])) });
const GRAPHQL_NOT_FOUND_ERROR = GRAPHQL_ERROR_ALIAS.extend({ type: z.literal('NOT_FOUND') });
const PR_DIFF = z.string().refine((diff) => Buffer.byteLength(diff, 'utf8') <= PR_DIFF_MAX_BYTES);

function aliasesOfErrors(errors: readonly unknown[]): Set<string> | null {
  const aliases = new Set<string>();
  for (const error of errors) {
    const parsed = GRAPHQL_ERROR_ALIAS.safeParse(error);
    if (!parsed.success) return null;
    aliases.add(parsed.data.path[0]);
  }
  return aliases;
}

function isPrNumber(number: number): boolean {
  return Number.isSafeInteger(number) && number > 0;
}

function reviewSnapshotKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function issueLinkedPullRequestsQuery(issues: readonly PrReference[]): string {
  const fields = issues.map((issue, index) => {
    const [owner, name] = repoParts(issue.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { issue(number: ${issue.number}) { closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number url title state isDraft } } } }`;
  });
  return `query { ${fields.join(' ')} }`;
}

function behindCountsQuery(prs: readonly PrHeadReference[]): string {
  const fields = prs.map((pr, index) => {
    const [owner, name] = repoParts(pr.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) { baseRef { compare(headRef: "${pr.headSha}") { behindBy } } } }`;
  });
  return `query { ${fields.join(' ')} }`;
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
    assignees: issue.assignees.map((assignee) => assignee.login), author: issue.user?.login ?? '', comments: issue.comments,
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

function createPrGh(cwd: string, commandRunner: typeof run = run): PrGh {
  async function runGh(args: string[], input?: string, preserveOutput = false): Promise<CommandResult> {
    try {
      return await commandRunner('gh', args, cwd, input, preserveOutput);
    } catch (error) {
      return { ok: false, out: '', err: errorMessage(error) };
    }
  }

  async function conditionalGet(path: string, validators: RestValidators = {}): Promise<ConditionalGetResult> {
    const args = ['api', '-i', '-X', 'GET'];
    if (validators.etag !== undefined) args.push('-H', `If-None-Match: ${validators.etag}`);
    if (validators.lastModified !== undefined) args.push('-H', `If-Modified-Since: ${validators.lastModified}`);
    const response = await runGh([...args, path], undefined, true);
    return conditionalGetResult(response);
  }

  async function forEachAliasedPr<Pr extends PrReference>(prs: readonly Pr[], buildQuery: (batch: readonly Pr[]) => string, visit: (pr: Pr, aliasValue: unknown) => void, batchSize = REVIEW_SNAPSHOT_BATCH_SIZE, requireComplete = false, shouldFailOnError = false): Promise<void> {
    for (let index = 0; index < prs.length; index += batchSize) {
      const batch = prs.slice(index, index + batchSize);
      const response = await runGh(['api', 'graphql', '-f', `query=${buildQuery(batch)}`]);
      const parsed = GRAPHQL_RESPONSE.safeParse(parseJsonOrNull(response.out));
      const errors = parsed.success ? parsed.data.errors ?? [] : [];
      const areAllErrorsNotFound = errors.every((error) => GRAPHQL_NOT_FOUND_ERROR.safeParse(error).success);
      if (shouldFailOnError && !response.ok && (errors.length === 0 || !areAllErrorsNotFound)) throw new Error(response.err.trim() || 'gh graphql batch failed');
      if (shouldFailOnError && (!parsed.success || !parsed.data.data)) throw new Error('invalid gh graphql response');
      if (shouldFailOnError && !areAllErrorsNotFound) throw new Error('gh graphql returned errors');
      const erroredAliases = requireComplete ? aliasesOfErrors(errors) : new Set<string>();
      if (erroredAliases === null) continue;
      if (requireComplete && !response.ok && errors.length === 0) continue;
      const data = parsed.success ? parsed.data.data : null;
      if (!data) continue;
      for (const [position, pr] of batch.entries()) {
        if (erroredAliases.has(`pr${position}`)) continue;
        visit(pr, data[`pr${position}`]);
      }
    }
  }

  async function pagedReviewThreads(repo: string, number: number): Promise<MyPrThreadNodeType[]> {
    const parts = repoParts(repo);
    if (!parts || !isPrNumber(number)) return [];
    const threads: MyPrThreadNodeType[] = [];
    let cursor: string | null = null;
    for (let page = 1; page <= MAX_REVIEW_THREAD_PAGES; page += 1) {
      const cursorArgs = cursor === null ? [] : ['-f', `cursor=${cursor}`];
      const response = await runGh(['api', 'graphql', '-f', `query=${MY_PR_THREADS_QUERY}`, '-f', `owner=${parts[0]}`, '-f', `name=${parts[1]}`, '-F', `number=${number}`, ...cursorArgs]);
      if (!response.ok) return [];
      const parsed = MyPrThreadsResponse.safeParse(parseJsonOrNull(response.out));
      if (!parsed.success || parsed.data.errors?.length) return [];
      const reviewThreads = parsed.data.data.repository?.pullRequest?.reviewThreads;
      if (!reviewThreads) return threads;
      for (const thread of reviewThreads.nodes) {
        const valid = MyPrThreadNode.safeParse(thread);
        if (valid.success) threads.push(valid.data);
      }
      if (!reviewThreads.pageInfo.hasNextPage || !reviewThreads.pageInfo.endCursor) return threads;
      cursor = reviewThreads.pageInfo.endCursor;
    }
    return threads;
  }

  async function completeTeamThreadComments(thread: ThreadNode): Promise<ThreadNode> {
    if (thread.isResolved || !thread.comments.nodes[0]?.viewerDidAuthor) return thread;
    for (let page = 1; page < MAX_REVIEW_THREAD_PAGES && thread.comments.pageInfo.hasNextPage; page += 1) {
      const cursor = thread.comments.pageInfo.endCursor;
      if (!cursor) break;
      const query = `query($id: ID!, $cursor: String!) { node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { ${TEAM_THREAD_COMMENT_FIELDS} } } } }`;
      const response = await runGh(['api', 'graphql', '-f', `query=${query}`, '-f', `id=${thread.id}`, '-f', `cursor=${cursor}`]);
      const raw: unknown = parseJsonOrNull(response.out);
      const graphql = GRAPHQL_RESPONSE.safeParse(raw);
      const parsed = TeamReviewThreadCommentsResponse.safeParse(raw);
      const comments = parsed.success ? parsed.data.data?.node?.comments : null;
      if (!response.ok || !comments || (graphql.success && graphql.data.errors?.length)) break;
      thread.comments.nodes.push(...comments.nodes);
      thread.comments.pageInfo = comments.pageInfo;
    }
    return thread;
  }

  async function completeCheckContexts(node: MyPrSearchNodeType): Promise<void> {
    const rollup = node.commits.nodes.at(-1)?.commit.statusCheckRollup;
    if (node.state !== 'OPEN' || !rollup?.id || rollup.state === 'SUCCESS') return;
    const contexts = rollup.contexts;
    for (let page = 1; page <= MAX_CHECK_CONTEXT_PAGES; page += 1) {
      const cursor = contexts.pageInfo?.hasNextPage ? contexts.pageInfo.endCursor : null;
      if (!cursor) return;
      const response = await runGh(['api', 'graphql', '-f', `query=${MY_PR_CHECK_CONTEXTS_QUERY}`, '-f', `id=${rollup.id}`, '-f', `cursor=${cursor}`]);
      const parsed = MyPrCheckContextsResponse.safeParse(parseJsonOrNull(response.out));
      const nextPage = parsed.success && !parsed.data.errors?.length ? parsed.data.data?.node?.contexts : null;
      if (!response.ok || !nextPage) return;
      for (const check of nextPage.nodes) {
        const valid = MyPrCheckContext.safeParse(check);
        if (valid.success) contexts.nodes.push(valid.data);
      }
      contexts.pageInfo = nextPage.pageInfo;
    }
  }

  async function searchIssuePages(query: string, maxPages: number, isCapAuthoritative = false): Promise<IssuesFetchResult> {
    const references = query.matchAll(/(?:^|\s)(?:repo|team):([^\s]+)/g);
    for (const reference of references) {
      if (!repoParts(reference[1])) return { ok: false, items: [], isComplete: false, error: 'invalid repository or team' };
    }
    const items: IssueUpdate[] = [];
    let isComplete = true;
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await runGh(['api', '-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'sort=updated', '-f', 'order=desc', '-f', `per_page=${SEARCH_PAGE_SIZE}`, '-f', `page=${page}`]);
      if (!response.ok) return { ok: false, items, isComplete: false, error: response.err.trim() || 'gh issue search failed' };
      const parsed = IssuesSearchResponse.safeParse(parseJsonOrNull(response.out));
      if (!parsed.success) return { ok: false, items, isComplete: false, error: 'invalid gh issue search response' };
      isComplete = isComplete && !parsed.data.incomplete_results;
      for (const candidate of parsed.data.items) {
        if (isPullRequest(candidate)) continue;
        const issue = parseGithubIssue(candidate);
        if (!issue) { isComplete = false; continue; }
        items.push(issue);
      }
      if (page * SEARCH_PAGE_SIZE >= parsed.data.total_count) return { ok: true, items, isComplete, error: isComplete ? '' : 'GitHub issue search returned incomplete results.' };
      if (parsed.data.items.length < SEARCH_PAGE_SIZE) break;
    }
    if (isCapAuthoritative) return { ok: true, items, isComplete, error: isComplete ? '' : 'GitHub issue search returned incomplete results.' };
    return { ok: true, items, isComplete: false, error: 'GitHub issue search reached its pagination limit.' };
  }

  return {
    conditionalGet,

    async searchPrsLight(qualifiers) {
      const items: GithubPrLightSearchNodeType[] = [];
      let cursor: string | null = null;
      let totalCount = 0;
      for (let page = 1; page <= MAX_GITHUB_PR_SEARCH_PAGES; page += 1) {
        const cursorArgs = cursor === null ? [] : ['-f', `cursor=${cursor}`];
        const response = await runGh(['api', 'graphql', '-f', `query=${GITHUB_PRS_LIGHT_QUERY}`, '-f', `searchQuery=is:pr ${qualifiers}`, ...cursorArgs]);
        if (!response.ok) return { ok: false, items, isComplete: false, error: response.err.trim() || 'gh graphql search failed' };
        const parsed = GITHUB_PRS_LIGHT_RESPONSE.safeParse(parseJsonOrNull(response.out));
        if (!parsed.success) return { ok: false, items, isComplete: false, error: 'invalid gh graphql response' };
        if (parsed.data.errors?.length) return { ok: false, items, isComplete: false, error: 'gh graphql returned errors' };
        const search = parsed.data.data.search;
        totalCount = search.issueCount;
        items.push(...search.nodes);
        if (!search.pageInfo.hasNextPage) {
          const isComplete = items.length >= search.issueCount;
          return { ok: true, items, isComplete, totalCount, error: isComplete ? '' : 'GitHub PR search returned incomplete results.' };
        }
        if (!search.pageInfo.endCursor || search.pageInfo.endCursor === cursor) break;
        cursor = search.pageInfo.endCursor;
      }
      return { ok: true, items, isComplete: false, totalCount, error: 'GitHub PR search reached its pagination limit.' };
    },

    async prsLightByKey(prs) {
      const lightByKey = new Map<string, GithubPrLightSearchNodeType>();
      const referencesByKey = new Map(uniqueValidPrs(prs).map((pr) => [comparablePrKey(pr), pr]));
      await forEachAliasedPr([...referencesByKey.values()], githubPrsLightByKeyQuery, (pr, repository) => {
        const parsed = GITHUB_PR_LIGHT_REPOSITORY.safeParse(repository);
        if (!parsed.success) throw new Error('invalid gh graphql light PR response');
        const node = parsed.data?.pullRequest;
        if (!node) return;
        lightByKey.set(comparablePrKey(pr), node);
      }, 50, true, true);
      return lightByKey;
    },

    async prDetails(prs) {
      const detailsByKey = new Map<string, GithubPrDetailNodeType>();
      const referencesByKey = new Map(uniqueValidPrs(prs).map((pr) => [comparablePrKey(pr), pr]));
      await forEachAliasedPr([...referencesByKey.values()], githubPrDetailsQuery, (pr, repository) => {
        const parsed = GITHUB_PR_DETAIL_REPOSITORY.safeParse(repository);
        const node = parsed.success ? parsed.data?.pullRequest : null;
        if (!node) return;
        detailsByKey.set(comparablePrKey(pr), node);
      }, REVIEW_SNAPSHOT_BATCH_SIZE, true);
      for (const node of detailsByKey.values()) await completeCheckContexts(node);
      return detailsByKey;
    },

    async notificationsSince(lastModified) {
      const response = await conditionalGet('notifications', lastModified === undefined ? {} : { lastModified });
      if (response.kind !== 'ok') return response;
      const parsed = GITHUB_NOTIFICATIONS.safeParse(response.body);
      if (!parsed.success) return { kind: 'error', message: 'invalid gh notifications response' };
      const prKeys = new Set<string>();
      for (const { subject } of parsed.data) {
        if (subject.type !== 'PullRequest' || !subject.url) continue;
        const key = notificationSubjectPrKey(subject.url);
        if (key) prKeys.add(key);
      }
      return {
        kind: 'ok', prKeys: [...prKeys],
        ...(response.lastModified === undefined ? {} : { lastModified: response.lastModified }),
        ...(response.pollIntervalSeconds === undefined ? {} : { pollIntervalSeconds: response.pollIntervalSeconds }),
      };
    },

    async searchRepoPrs(repo, mergedSince) {
      if (!repoParts(repo) || !MERGED_SINCE_DATE.test(mergedSince)) return { ok: false, items: [], isComplete: false, error: 'invalid repository or date' };
      const response = await runGh(['api', 'graphql', '-H', 'Accept: application/vnd.github.merge-info-preview+json', '-f', `query=${WORKFLOW_PRS_QUERY}`, '-f', `openQuery=is:pr is:open repo:${repo} sort:updated-desc`, '-f', `mergedQuery=is:pr is:merged repo:${repo} merged:>=${mergedSince} sort:updated-desc`]);
      if (!response.ok) return { ok: false, items: [], isComplete: false, error: response.err.trim() || 'gh graphql search failed' };
      const parsed = MyPrSearchResponse.safeParse(parseJsonOrNull(response.out));
      if (!parsed.success) return { ok: false, items: [], isComplete: false, error: 'invalid gh graphql response' };
      if (parsed.data.errors?.length) return { ok: false, items: [], isComplete: false, error: 'gh graphql returned errors' };
      const { open, merged } = parsed.data.data;
      const nodes = [...open.nodes, ...merged.nodes];
      const items = nodes.flatMap((node) => {
        const valid = WorkflowSearchNode.safeParse(node);
        return valid.success ? [valid.data] : [];
      });
      const isComplete = items.length === nodes.length && open.issueCount <= open.nodes.length && merged.issueCount <= merged.nodes.length;
      return { ok: true, items, isComplete, error: '' };
    },

    async addPrLabel({ repo, number, name }) {
      if (!repoParts(repo) || !isPrNumber(number)) return { ok: false, err: 'invalid repository or pull request number' };
      const label = WorkflowLabelName.safeParse(name);
      if (!label.success) return { ok: false, err: 'invalid label name' };
      const response = await runGh(['pr', 'edit', String(number), '--repo', repo, '--add-label', label.data]);
      return { ok: response.ok, err: response.ok ? '' : response.err.trim() || 'gh pr edit failed' };
    },

    async commentOnPr({ repo, number, body }) {
      if (!repoParts(repo) || !isPrNumber(number)) return { ok: false, err: 'invalid repository or pull request number' };
      const comment = WorkflowCommentBody.safeParse(body);
      if (!comment.success) return { ok: false, err: 'invalid comment body' };
      const response = await runGh(['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'], comment.data);
      return { ok: response.ok, err: response.ok ? '' : response.err.trim() || 'gh pr comment failed' };
    },

    async teamReviewThreads(prs) {
      const threadsByPr = new Map<string, ThreadNode[]>();
      const paged: { pr: PrReference; cursor: string; threads: ThreadNode[] }[] = [];
      await forEachAliasedPr(uniqueValidPrs(prs), teamThreadsQuery, (pr, repository) => {
        const parsed = TeamReviewThreadsRepository.safeParse(repository);
        const connection = parsed.success ? parsed.data.pullRequest?.reviewThreads : null;
        if (!connection) return;
        if (!connection.pageInfo.hasNextPage) {
          threadsByPr.set(reviewSnapshotKey(pr.repo, pr.number), connection.nodes);
          return;
        }
        if (connection.pageInfo.endCursor) paged.push({ pr, cursor: connection.pageInfo.endCursor, threads: connection.nodes });
      }, REVIEW_SNAPSHOT_BATCH_SIZE, true);
      for (const pending of paged) {
        const parts = repoParts(pending.pr.repo);
        if (!parts) continue;
        let cursor = pending.cursor;
        for (let page = 1; page < MAX_REVIEW_THREAD_PAGES; page += 1) {
          const query = MY_PR_THREADS_QUERY.replace(REVIEW_THREAD_FIELDS, TEAM_THREAD_FIELDS);
          const response = await runGh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${parts[0]}`, '-f', `name=${parts[1]}`, '-F', `number=${pending.pr.number}`, '-f', `cursor=${cursor}`]);
          const parsed = GRAPHQL_RESPONSE.safeParse(parseJsonOrNull(response.out));
          const repository = TeamReviewThreadsRepository.safeParse(parsed.success ? parsed.data.data?.repository : null);
          const connection = repository.success ? repository.data.pullRequest?.reviewThreads : null;
          if (!response.ok || !connection || (parsed.success && parsed.data.errors?.length)) break;
          pending.threads.push(...connection.nodes);
          if (!connection.pageInfo.hasNextPage) {
            threadsByPr.set(reviewSnapshotKey(pending.pr.repo, pending.pr.number), pending.threads);
            break;
          }
          if (!connection.pageInfo.endCursor) break;
          cursor = connection.pageInfo.endCursor;
        }
      }
      for (const [key, threads] of threadsByPr) {
        for (const thread of threads) await completeTeamThreadComments(thread);
        if (threads.some((thread) => !thread.isResolved && thread.comments.nodes[0]?.viewerDidAuthor && thread.comments.pageInfo.hasNextPage)) threadsByPr.delete(key);
      }
      return threadsByPr;
    },

    async resolveReviewThread(threadId) {
      if (!ReviewThreadId.safeParse(threadId).success) return { ok: false, err: 'invalid review thread id' };
      const response = await runGh(['api', 'graphql', '-f', `query=${RESOLVE_THREAD_MUTATION}`, '-f', `id=${threadId}`]);
      const parsed = TeamReviewResolveResponse.safeParse(parseJsonOrNull(response.out));
      const isResolved = response.ok && parsed.success && !parsed.data.errors?.length && parsed.data.data?.resolveReviewThread.thread.id === threadId;
      return { ok: Boolean(isResolved), err: isResolved ? '' : response.err || 'GitHub did not confirm the thread was resolved' };
    },

    async teamReviewCompare(repo, base, head) {
      if (!repoParts(repo) || !CommitSha.safeParse(base).success || !CommitSha.safeParse(head).success) return { ok: true, comparison: null };
      const response = await runGh(['api', `repos/${repo}/compare/${base}...${head}`]);
      if (!response.ok && /\bHTTP 404\b/.test(response.err) && /\bNo common ancestor between\b/i.test(response.err)) return { ok: true, comparison: null };
      if (!response.ok) return { ok: false, err: response.err || 'GitHub compare failed' };
      const parsed = TeamReviewCompareFiles.safeParse(parseJsonOrNull(response.out));
      if (!parsed.success) return { ok: false, err: 'GitHub returned an unreadable comparison' };
      return { ok: true, comparison: parsed.data.merge_base_commit.sha === base ? parsed.data : null };
    },

    reviewThreads(repo, number) {
      return pagedReviewThreads(repo, number);
    },

    async reviewThreadsBatch(prs) {
      const threadsByPr = new Map<string, MyPrThreadNodeType[]>();
      const morePages: PrReference[] = [];
      await forEachAliasedPr(uniqueValidPrs(prs), reviewThreadsBatchQuery, (pr, repository) => {
        const parsed = GRAPHQL_THREADS_REPOSITORY.safeParse(repository);
        const reviewThreads = parsed.success ? parsed.data.pullRequest?.reviewThreads : undefined;
        if (!reviewThreads) return;
        if (reviewThreads.pageInfo.hasNextPage) {
          morePages.push(pr);
          return;
        }
        threadsByPr.set(reviewSnapshotKey(pr.repo, pr.number), reviewThreads.nodes.flatMap((thread) => {
          const valid = MyPrThreadNode.safeParse(thread);
          return valid.success ? [valid.data] : [];
        }));
      });
      for (const pr of morePages) threadsByPr.set(reviewSnapshotKey(pr.repo, pr.number), await pagedReviewThreads(pr.repo, pr.number));
      return threadsByPr;
    },

    async listMergedPrs(repo, limit) {
      if (!repoParts(repo)) return { ok: false, reason: 'invalid repository' };
      const prs: MergedPrListingType[] = [];
      let cursor: string | null = null;
      while (prs.length < limit) {
        const cursorArgs = cursor === null ? [] : ['-f', `cursor=${cursor}`];
        const pageSize = Math.min(MERGED_PRS_PAGE_SIZE, limit - prs.length);
        const response = await runGh(['api', 'graphql', '-f', `query=${MERGED_PRS_QUERY}`, '-f', `searchQuery=repo:${repo} is:pr is:merged sort:updated-desc`, '-F', `first=${pageSize}`, ...cursorArgs]);
        if (!response.ok) return { ok: false, reason: response.err.trim() || 'gh graphql search failed' };
        const parsed = MERGED_PRS_RESPONSE.safeParse(parseJsonOrNull(response.out));
        if (!parsed.success) return { ok: false, reason: 'invalid gh graphql search response' };
        const { pageInfo, nodes } = parsed.data.data.search;
        prs.push(...nodes.flatMap((node) => {
          const listing = MergedPrListing.safeParse(node);
          return listing.success ? [listing.data] : [];
        }));
        if (!pageInfo.hasNextPage || !pageInfo.endCursor) return { ok: true, prs };
        cursor = pageInfo.endCursor;
      }
      return { ok: true, prs: prs.slice(0, limit) };
    },

    async benchmarkReviewData(repo, numbers) {
      const dataByNumber = new Map<number, MinedPrReviewDataType>();
      const prs = uniqueValidPrs(numbers.map((number) => ({ repo, number })));
      await forEachAliasedPr(prs, benchmarkReviewDataQuery, (pr, repository) => {
        const pullRequest = z.object({ pullRequest: z.unknown() }).safeParse(repository);
        const parsed = MinedPrReviewData.safeParse(pullRequest.success ? pullRequest.data.pullRequest : null);
        if (parsed.success) dataByNumber.set(pr.number, parsed.data);
      }, BENCHMARK_REVIEW_BATCH_SIZE);
      return dataByNumber;
    },

    async compareCommits(repo, base, head) {
      const parts = repoParts(repo);
      if (!parts || !CommitSha.safeParse(base).success || !CommitSha.safeParse(head).success) return null;
      const response = await runGh(['api', `repos/${parts[0]}/${parts[1]}/compare/${base}...${head}`, '--jq', '{mergeBaseSha: .merge_base_commit.sha, changedFiles: [.files[].filename], fileCount: (.files | length)}']);
      if (!response.ok) return null;
      const parsed = COMPARE_RESPONSE.safeParse(parseJsonOrNull(response.out));
      if (!parsed.success) return null;
      return CommitComparison.parse({
        mergeBaseSha: parsed.data.mergeBaseSha,
        changedFiles: parsed.data.changedFiles,
        isFileListComplete: parsed.data.fileCount < COMPARE_FILE_LIST_CAP,
      });
    },

    async behindCounts(prs) {
      const counts = new Map<string, number>();
      const validPrs = prs.filter((pr) => repoParts(pr.repo) && isPrNumber(pr.number) && CommitSha.safeParse(pr.headSha).success);
      await forEachAliasedPr(validPrs, behindCountsQuery, (pr, repository) => {
        const comparison = GRAPHQL_BEHIND_REPOSITORY.safeParse(repository);
        const behindBy = comparison.success ? comparison.data.pullRequest?.baseRef?.compare?.behindBy : undefined;
        if (behindBy !== undefined) counts.set(reviewSnapshotKey(pr.repo, pr.number), behindBy);
      });
      return counts;
    },
    async rateLimitWaitMs(nowMs, resourceNames) {
      const response = await runGh(['api', 'rate_limit', '--jq', '.resources']);
      if (!response.ok) return null;
      const parsed = GithubRateLimitResources.safeParse(parseJsonOrNull(response.out));
      return parsed.success ? githubRateLimitWaitMs(parsed.data, nowMs, resourceNames) : null;
    },
    async rebasePr(pullRequestId, expectedHeadSha) {
      if (!NODE_ID_RE.test(pullRequestId) || !CommitSha.safeParse(expectedHeadSha).success) return { ok: false, err: 'invalid pull request id or head' };
      const response = await runGh(['api', 'graphql', '-f', `query=${REBASE_PR_MUTATION}`, '-f', `id=${pullRequestId}`, '-f', `head=${expectedHeadSha}`]);
      if (!response.ok) return { ok: false, err: response.err.trim() || 'gh graphql rebase failed' };
      const parsed = (parseJsonOrNull(response.out) ?? {}) as { errors?: { message?: unknown }[] };
      const firstError = parsed.errors?.[0]?.message;
      if (firstError !== undefined) return { ok: false, err: String(firstError) };
      return { ok: true, err: '' };
    },
    async mergePr({ repo, number, headSha, method }) {
      const parts = repoParts(repo);
      if (!parts || !isPrNumber(number)) return { ok: false, err: 'invalid repository or pull request number' };
      if (!CommitSha.safeParse(headSha).success) return { ok: false, err: 'invalid head commit' };
      const parsedMethod = MyPrMergeMethod.safeParse(method);
      if (!parsedMethod.success) return { ok: false, err: 'invalid merge method' };
      const response = await runGh(['pr', 'merge', String(number), '--repo', repo, GH_MERGE_FLAGS[parsedMethod.data], '--match-head-commit', headSha]);
      if (!response.ok) return { ok: false, err: response.err.trim() || 'gh pr merge failed' };
      const prState = await runGh(['api', 'graphql', '-f', `query=${MY_PR_MERGE_STATE_QUERY}`, '-f', `owner=${parts[0]}`, '-f', `name=${parts[1]}`, '-F', `number=${number}`]);
      return { ok: true, kind: prState.ok ? mergeKindFromPrState(prState.out) : 'unconfirmed' };
    },
    async repoSlug() {
      const r = await commandRunner('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd);
      return r.ok ? r.out : null;
    },

    async searchIssues(query) {
      return searchIssuePages(query, MAX_SEARCH_PAGES);
    },

    async issueLinkedPullRequests(keys) {
      const issues = [...new Set(keys)].flatMap((key) => {
        if (!IssueKey.safeParse(key).success) return [];
        const [repo, issueNumber] = key.split('#');
        const number = Number(issueNumber);
        if (!repoParts(repo) || !isPrNumber(number)) return [];
        return [{ repo, number }];
      });
      const pullRequestsByIssue = new Map<string, IssuePullRequest[]>();
      await forEachAliasedPr(issues, issueLinkedPullRequestsQuery, (issue, repository) => {
        const parsed = GithubIssuePullRequestsRepository.safeParse(repository);
        const connection = parsed.success ? parsed.data.issue?.closedByPullRequestsReferences : null;
        if (!connection) return;
        const pullRequests = connection.nodes.flatMap((pullRequest): IssuePullRequest[] => {
          if (!pullRequest) return [];
          const { isDraft, state, ...fields } = pullRequest;
          if (state === 'OPEN') return [{ ...fields, state: isDraft ? 'draft' : 'open' }];
          if (state === 'MERGED') return [{ ...fields, state: 'merged' }];
          return [{ ...fields, state: 'closed' }];
        });
        pullRequestsByIssue.set(reviewSnapshotKey(issue.repo, issue.number), pullRequests);
      }, 50, true);
      return pullRequestsByIssue;
    },

    async listRepoIssues(repo, since, maxIssues) {
      if (!Number.isInteger(maxIssues) || maxIssues <= 0) return { ok: false, items: [], isComplete: false, error: 'invalid issue limit' };
      if (!repoParts(repo) || (since !== null && !z.iso.datetime().safeParse(since).success)) return { ok: false, items: [], isComplete: false, error: 'invalid repository or date' };
      const query = since === null ? `repo:${repo} is:issue is:open` : `repo:${repo} is:issue updated:>=${since}`;
      return searchIssuePages(query, Math.ceil(maxIssues / SEARCH_PAGE_SIZE), since === null);
    },

    async viewIssue(issueNumber, repo) {
      if (repo !== undefined && !repoParts(repo)) return { ok: false, issue: null, error: 'invalid repository' };
      const repoArguments = repo === undefined ? [] : ['--repo', repo];
      const r = await commandRunner('gh', ['issue', 'view', String(issueNumber), ...repoArguments, '--json', 'number,title,body,labels,url,updatedAt'], cwd);
      if (!r.ok) return { ok: false, issue: null, error: r.err.trim() || 'gh issue view failed' };
      const issue = normalizeIssue((parseJsonOrNull(r.out) ?? {}) as GithubIssueRow);
      if (!issue) return { ok: false, issue: null, error: 'gh issue view returned no issue' };
      return { ok: true, issue, error: '' };
    },

    async viewer() {
      const response = await runGh(['api', 'user', '--jq', '.login']);
      if (!response.ok) return null;
      const parsed = GH_LOGIN.safeParse(response.out);
      return parsed.success ? parsed.data : null;
    },

    async teamMembers(org, team) {
      if (!GH_SEGMENT.test(org) || !GH_SEGMENT.test(team)) return [];
      const response = await runGh(['api', '--paginate', `orgs/${org}/teams/${team}/members`, '--jq', '.[].login']);
      if (!response.ok) return null;
      const members = response.out ? response.out.split(/\r?\n/) : [];
      const parsed = GH_MEMBERS.safeParse(members);
      return parsed.success ? parsed.data : null;
    },

    async teamProfile(org, team) {
      if (!GH_SEGMENT.test(org) || !GH_SEGMENT.test(team)) return null;
      const response = await runGh(['api', 'graphql', '-f', `query=${TEAM_PROFILE_QUERY}`, '-f', `org=${org}`, '-f', `slug=${team}`]);
      if (!response.ok) return null;
      const parsed = TEAM_PROFILE.safeParse(parseJsonOrNull(response.out));
      if (!parsed.success || parsed.data.errors?.length || !parsed.data.data.organization?.team) return null;
      const profile = parsed.data.data.organization.team;
      return { org, slug: team, name: profile.name, avatarUrl: profile.avatarUrl };
    },

    async viewPr(repo, number) {
      if (!repoParts(repo) || !isPrNumber(number)) return null;
      const response = await runGh(['pr', 'view', String(number), '-R', repo, '--json', 'number,title,body,url,author,isDraft,isCrossRepository,baseRefName,baseRefOid,headRefName,headRefOid,additions,deletions,files']);
      if (!response.ok) return null;
      const parsed = PrDetail.safeParse(parseJsonOrNull(response.out));
      return parsed.success ? parsed.data : null;
    },

    async prDiff(repo, number) {
      if (!repoParts(repo) || !isPrNumber(number)) return null;
      const response = await runGh(['pr', 'diff', String(number), '-R', repo], undefined, true);
      if (!response.ok) return null;
      const parsed = PR_DIFF.safeParse(response.out);
      return parsed.success ? parsed.data : null;
    },

    async prHead(repo, number) {
      if (!repoParts(repo) || !isPrNumber(number)) return null;
      const response = await runGh(['pr', 'view', String(number), '-R', repo, '--json', 'headRefOid', '--jq', '.headRefOid']);
      if (!response.ok) return null;
      const parsed = CommitSha.safeParse(response.out);
      return parsed.success ? parsed.data : null;
    },

    async postReview({ repo, number, commitId, event, body, comments }) {
      const parts = repoParts(repo);
      if (!parts || !isPrNumber(number)) return { ok: false, err: 'invalid repository or pull request number', reviewId: null };
      if (!CommitSha.safeParse(commitId).success) return { ok: false, err: 'invalid commit id', reviewId: null };
      if (event !== 'APPROVE' && event !== 'COMMENT') return { ok: false, err: 'invalid review event', reviewId: null };
      if (typeof body !== 'string' || !Array.isArray(comments)) return { ok: false, err: 'invalid review body or comments', reviewId: null };
      const parsedComments = z.array(ReviewComment).safeParse(comments);
      if (!parsedComments.success) return { ok: false, err: 'invalid review comments', reviewId: null };
      const input = JSON.stringify({ commit_id: commitId, event, body, comments: parsedComments.data });
      const response = await runGh(['api', '-X', 'POST', `repos/${parts[0]}/${parts[1]}/pulls/${number}/reviews`, '--input', '-'], input);
      if (!response.ok) return { ok: false, err: response.err.trim() || 'gh review post failed', reviewId: null };
      const created = CREATED_REVIEW.safeParse(parseJsonOrNull(response.out));
      return { ok: true, err: '', reviewId: created.success ? created.data.id : null };
    },

    async dismissReview({ repo, number, reviewId, message }) {
      const parts = repoParts(repo);
      if (!parts || !isPrNumber(number)) return { ok: false, err: 'invalid repository or pull request number' };
      if (!Number.isSafeInteger(reviewId) || reviewId <= 0) return { ok: false, err: 'invalid review id' };
      if (typeof message !== 'string' || !message.trim()) return { ok: false, err: 'a dismissal needs a message' };
      const input = JSON.stringify({ message, event: 'DISMISS' });
      const response = await runGh(['api', '-X', 'PUT', `repos/${parts[0]}/${parts[1]}/pulls/${number}/reviews/${reviewId}/dismissals`, '--input', '-'], input);
      return { ok: response.ok, err: response.ok ? '' : response.err.trim() || 'gh review dismissal failed' };
    },
  };
}

export { createPrGh };
export type { CommandResult, PostedReview, PrGh };
