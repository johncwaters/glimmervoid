import { comparablePrKey } from '../../shared/contracts/github-prs.ts';
import type { GithubPrDetailNode as GithubPrDetailNodeType, GithubPrLightSearchNode as GithubPrLightSearchNodeType } from '../../shared/contracts/github-prs.ts';
import { runCommand } from '../git/git-exec.ts';
import { GH_LOGIN_SOURCE, NO_GITHUB_SOURCE_TEXT } from './github-source.ts';
import type { GithubSource, GithubSourceKind, GithubSourceReader } from './github-source.ts';
import type { CommandResult } from '../git/git-exec.ts';
import { GH_SEGMENT, NODE_ID_RE, repoParts } from '../../shared/contracts/github-ids.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

import { GithubRateLimitResources, REFUSAL_RETRY_ATTEMPTS, githubRateLimitWaitMs, githubRefusalOf, isGraphqlMutation, refusalRetryDelayMs } from './core/github-rate-limit-core.ts';
import { setTimeout as waitFor } from 'node:timers/promises';
import { UNATTRIBUTED_OPERATION, githubCallPoints, githubCallResources, isNotModifiedResponse, withRateLimitCost } from './core/github-usage-core.ts';
import type { GithubUsageRecorder } from './core/github-usage-core.ts';
import { z } from 'zod';
import { CommitSha, TeamReviewThreadCommentsResponse, TeamReviewThreadsRepository, TeamReviewResolveResponse, ReviewThreadId, TeamReviewCompareFiles, PrDetail, PostedReviewEvent, ReviewComment } from '../../shared/contracts/team-review.ts';
import { CommitComparison, MergedPrListing, MinedPrReviewData } from '../../shared/contracts/review-case.ts';
import type { CommitComparison as CommitComparisonType, MergedPrListing as MergedPrListingType, MinedPrReviewData as MinedPrReviewDataType } from '../../shared/contracts/review-case.ts';
import { PrThreadReplyResponse, PrThreadUnresolveResponse } from '../../shared/contracts/pr-flows.ts';
import { MyPrCheckContext, MyPrCheckContextsResponse, MyPrMergeMethod, MyPrThreadNode, MyPrThreadsResponse } from '../../shared/contracts/my-prs.ts';
import type { MyPrMergeKind, MyPrMergeMethod as MyPrMergeMethodType, MyPrSearchNode as MyPrSearchNodeType, MyPrThreadNode as MyPrThreadNodeType } from '../../shared/contracts/my-prs.ts';
import { WorkflowCommentBody, WorkflowLabelName } from '../../shared/contracts/workflows.ts';
import type { PrDetail as PrDetailType, ReviewComment as ReviewCommentType, TeamReviewStatus } from '../../shared/contracts/team-review.ts';
import type { TeamReviewThreadNode as ThreadNode, TeamReviewCompareFiles as CompareFiles } from '../../shared/contracts/team-review.ts';
import { errorMessage } from '../../shared/text.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { notificationSubjectPrKey } from './core/github-store-core.ts';
import type { GithubTeam } from '../../shared/contracts/control-messages.ts';
import { MERGED_PRS_QUERY, MY_PR_CHECK_CONTEXTS_QUERY, MY_PR_MERGE_STATE_QUERY, MY_PR_THREADS_QUERY, REBASE_PR_MUTATION, REPLY_THREAD_MUTATION, RESOLVE_THREAD_MUTATION, REVIEW_THREAD_FIELDS, TEAM_PROFILE_QUERY, UNRESOLVE_THREAD_MUTATION, TEAM_THREAD_COMMENT_FIELDS, TEAM_THREAD_FIELDS, behindCountsQuery, reviewCaseDataQuery, githubPrDetailsQuery, githubPrsLightByKeyQuery, githubPrsLightSearchQuery, reviewThreadsBatchQuery, teamThreadsQuery } from './pr-gh/pr-gh-queries.ts';
import type { PrHeadReference, PrReference } from './pr-gh/pr-gh-queries.ts';
import { COMPARE_RESPONSE, CREATED_REVIEW, GH_LOGIN, GH_MEMBERS, GH_TEAMS, GITHUB_NOTIFICATIONS, GITHUB_PRS_LIGHT_RESPONSE, GITHUB_PR_DETAIL_REPOSITORY, GITHUB_PR_LIGHT_REPOSITORY, GRAPHQL_BEHIND_REPOSITORY, GRAPHQL_RESPONSE, GRAPHQL_THREADS_REPOSITORY, MERGED_PRS_RESPONSE, PR_DIFF, TEAM_PROFILE } from './pr-gh/pr-gh-responses.ts';
import { aliasesOfErrors, aliasesReportedGone, conditionalGetResult, ghHttpResponseOf, isPrNumber, mergeKindFromPrState, reviewSnapshotKey, uniqueValidPrs } from './pr-gh/pr-gh-parsing.ts';
import type { ConditionalGetResult, RestValidators } from './pr-gh/pr-gh-parsing.ts';

type GhMergeFlag = '--merge' | '--squash' | '--rebase';

const GH_MERGE_FLAGS: Readonly<Record<MyPrMergeMethodType, GhMergeFlag>> = { MERGE: '--merge', SQUASH: '--squash', REBASE: '--rebase' };

type NotificationsSinceResult = Exclude<ConditionalGetResult, { kind: 'ok' }>
  | { kind: 'ok'; prKeys: string[]; lastModified?: string; pollIntervalSeconds?: number };

interface PrGh {
  conditionalGet(path: string, validators?: RestValidators): Promise<ConditionalGetResult>;
  searchPrsLight(qualifiers: string, maxMembers?: number): Promise<{ ok: boolean; items: GithubPrLightSearchNodeType[]; isComplete: boolean; totalCount?: number; error: string }>;
  prsLightByKey(prs: readonly PrReference[]): Promise<GithubBatchRead<GithubPrLightSearchNodeType>>;
  prDetails(prs: readonly PrReference[]): Promise<GithubBatchRead<GithubPrDetailNodeType>>;
  notificationsSince(lastModified?: string): Promise<NotificationsSinceResult>;
  addPrLabel(label: { repo: string; number: number; name: string }): Promise<{ ok: boolean; err: string }>;
  commentOnPr(comment: { repo: string; number: number; body: string }): Promise<{ ok: boolean; err: string }>;
  behindCounts(prs: readonly PrHeadReference[]): Promise<Map<string, number | null>>;
  rebasePr(pullRequestId: string, expectedHeadSha: string): Promise<{ ok: boolean; err: string }>;
  mergePr(merge: { repo: string; number: number; headSha: string; method: MyPrMergeMethodType }): Promise<{ ok: true; kind: MyPrMergeKind } | { ok: false; err: string }>;
  rateLimitResources(): Promise<GithubRateLimitResources | null>;
  rateLimitWaitMs(nowMs: number, resourceNames: readonly string[]): Promise<number | null>;
  teamReviewThreads(prs: readonly PrReference[]): Promise<Map<string, ThreadNode[]>>;
  resolveReviewThread(threadId: string): Promise<{ ok: boolean; err: string }>;
  replyToReviewThread(threadId: string, body: string): Promise<{ ok: boolean; err: string }>;
  unresolveReviewThread(threadId: string): Promise<{ ok: boolean; err: string }>;
  teamReviewCompare(repo: string, base: string, head: string): Promise<{ ok: true; comparison: CompareFiles | null } | { ok: false; err: string }>;
  reviewThreadsBatch(prs: readonly PrReference[]): Promise<Map<string, MyPrThreadNodeType[]>>;
  listMergedPrs(repo: string, limit: number): Promise<{ ok: true; prs: MergedPrListingType[] } | { ok: false; reason: string }>;
  reviewCaseData(repo: string, numbers: readonly number[]): Promise<Map<number, MinedPrReviewDataType>>;
  compareCommits(repo: string, base: string, head: string): Promise<CommitComparisonType | null>;
  viewer(): Promise<string | null>;
  viewerTeams(): Promise<{ teams: GithubTeam[]; orgs: string[] } | null>;
  teamMembers(org: string, team: string): Promise<string[] | null>;
  teamProfile(org: string, team: string): Promise<NonNullable<TeamReviewStatus['team']> | null>;
  viewPr(repo: string, number: number): Promise<PrDetailType | null>;
  prDiff(repo: string, number: number): Promise<string | null>;
  prHead(repo: string, number: number): Promise<string | null>;
  postReview(review: { repo: string; number: number; commitId: string; event: PostedReviewEvent; body: string; comments: ReviewCommentType[] }): Promise<PostedReview>;
  dismissReview(dismissal: { repo: string; number: number; reviewId: number; message: string }): Promise<{ ok: boolean; err: string }>;
  sourceKind(): Promise<GithubSourceKind>;
}

interface PostedReview {
  ok: boolean;
  err: string;
  reviewId: number | null;
}

const GH_READ_TIMEOUT_MS = 15000;
const GH_WRITE_TIMEOUT_MS = 30000;
const GH_MAX_BUFFER_BYTES = 2 * 1024 * 1024 + 1;

function run(cmd: string, args: string[], cwd: string, input?: string, preserveOutput = false, timeoutMs = GH_READ_TIMEOUT_MS, env?: Record<string, string>): Promise<CommandResult> {
  return runCommand(cmd, args, {
    cwd, input, timeoutMs, env, maxBuffer: GH_MAX_BUFFER_BYTES, trim: !preserveOutput, keepStdoutOnFailure: true, preferStderr: true,
  });
}

const MAX_CHECK_CONTEXT_PAGES = 10;

const MAX_GITHUB_PR_SEARCH_PAGES = 20;

const MERGED_PRS_PAGE_SIZE = 50;
const REVIEW_CASE_BATCH_SIZE = 10;
const COMPARE_FILE_LIST_CAP = 300;

const MAX_REVIEW_THREAD_PAGES = 5;
const REVIEW_SNAPSHOT_BATCH_SIZE = 25;

type AliasedBatchFailurePolicy = 'skip-failed-batch' | 'throw-on-batch-failure';
type AliasOutcome = 'found' | 'gone' | 'unreadable';
type GithubBatchRead<Value> = { byKey: Map<string, Value>; goneKeys: Set<string> };

function aliasedBatchFailure(response: CommandResult, errorCount: number, hasData: boolean, hasUnattributedError: boolean, isStrict: boolean): string | null {
  if (isStrict && !response.ok && errorCount === 0) return response.err.trim() || 'gh graphql batch failed';
  if (!hasData) return 'invalid gh graphql response';
  if (isStrict && hasUnattributedError) return response.err.trim() || 'gh graphql returned an error outside any pull request';
  return null;
}

interface PrRepositorySchema<PrNode> {
  safeParse(repository: unknown): { success: true; data: { pullRequest: PrNode | null } | null } | { success: false };
}

const operationScope = new AsyncLocalStorage<string>();

function scopedToOperations(methods: PrGh): PrGh {
  const scopedMethods: Record<string, unknown> = {};
  const methodsByOperation: ReadonlyMap<string, unknown> = new Map(Object.entries(methods));
  for (const [operation, method] of methodsByOperation) {
    scopedMethods[operation] = typeof method === 'function' ? (...args: unknown[]) => operationScope.run(operation, () => method(...args)) : method;
  }
  return Object.assign({}, methods, scopedMethods);
}

const GH_SERVER_CALLER = 'server';

function ghFailure(error: unknown): CommandResult {
  return { ok: false, out: '', err: errorMessage(error) };
}

const NEVER_SENT_WITHOUT_SOURCE: CommandResult = Object.freeze({ ok: false, out: '', err: NO_GITHUB_SOURCE_TEXT });

function createPrGh(cwd: string, commandRunner: typeof run = run, usage: GithubUsageRecorder | null = null, waitMs: (delayMs: number) => Promise<unknown> = waitFor, source: GithubSourceReader = GH_LOGIN_SOURCE): PrGh {
  function recordUsage(args: readonly string[], response: CommandResult): void {
    if (usage === null) return;
    const isOk = response.ok || isNotModifiedResponse(response.out);
    const operation = operationScope.getStore() ?? UNATTRIBUTED_OPERATION;
    for (const resource of githubCallResources(args)) usage.record({ operation, resource, points: githubCallPoints(args, resource, response.out), isOk });
  }

  async function spawnGh(args: string[], input: string | undefined, preserveOutput: boolean, timeoutMs: number, sourceAlreadyRead?: GithubSource): Promise<CommandResult | null> {
    const githubSource = sourceAlreadyRead ?? await source.current();
    if (githubSource.kind === 'none') return null;
    const tokenEnv = githubSource.kind === 'connection' ? { GH_TOKEN: githubSource.token } : undefined;
    return commandRunner('gh', args, cwd, input, preserveOutput, timeoutMs, tokenEnv).catch(ghFailure);
  }

  async function sourceKind(): Promise<GithubSourceKind> {
    return (await source.current()).kind;
  }

  async function runGh(args: string[], input?: string, preserveOutput = false, timeoutMs = GH_READ_TIMEOUT_MS, sourceAlreadyRead?: GithubSource): Promise<CommandResult> {
    const response = await spawnGh(args, input, preserveOutput, timeoutMs, sourceAlreadyRead);
    if (response === null) return NEVER_SENT_WITHOUT_SOURCE;
    recordUsage(args, response);
    return response;
  }

  async function runGraphql(query: string, fieldArgs: readonly string[], timeoutMs = GH_READ_TIMEOUT_MS, attempt = 1): Promise<CommandResult> {
    const args = ['api', 'graphql', '-i', '-f', `query=${withRateLimitCost(query)}`, ...fieldArgs];
    const response = await spawnGh(args, undefined, false, timeoutMs);
    if (response === null) return NEVER_SENT_WITHOUT_SOURCE;
    const httpResponse = ghHttpResponseOf(response.out);
    const bodyResponse = httpResponse === null ? response : { ...response, out: (httpResponse.body ?? '').trim() };
    recordUsage(args, bodyResponse);
    const refusal = httpResponse === null ? null : githubRefusalOf(httpResponse.status, httpResponse.headers, httpResponse.body ?? '');
    if (refusal === null) return bodyResponse;
    usage?.recordRefusal({ ...refusal, operation: operationScope.getStore() ?? UNATTRIBUTED_OPERATION, resource: 'graphql', caller: GH_SERVER_CALLER });
    const retryDelayMs = refusalRetryDelayMs(refusal, attempt);
    if (isGraphqlMutation(query) || attempt > REFUSAL_RETRY_ATTEMPTS || retryDelayMs === null) return bodyResponse;
    await waitMs(retryDelayMs);
    return runGraphql(query, fieldArgs, timeoutMs, attempt + 1);
  }

  async function rateLimitResources(): Promise<GithubRateLimitResources | null> {
    const response = await runGh(['api', 'rate_limit', '--jq', '.resources']);
    if (!response.ok) return null;
    const parsed = GithubRateLimitResources.safeParse(parseJsonOrNull(response.out));
    return parsed.success ? parsed.data : null;
  }

  async function conditionalGet(path: string, validators: RestValidators = {}, sourceAlreadyRead?: GithubSource): Promise<ConditionalGetResult> {
    const args = ['api', '-i', '-X', 'GET'];
    if (validators.etag !== undefined) args.push('-H', `If-None-Match: ${validators.etag}`);
    if (validators.lastModified !== undefined) args.push('-H', `If-Modified-Since: ${validators.lastModified}`);
    const response = await runGh([...args, path], undefined, true, GH_READ_TIMEOUT_MS, sourceAlreadyRead);
    return conditionalGetResult(response);
  }

  async function forEachAliasedPr<Pr extends PrReference>(prs: readonly Pr[], buildQuery: (batch: readonly Pr[]) => string, readAlias: (pr: Pr, aliasValue: unknown) => AliasOutcome, batchSize = REVIEW_SNAPSHOT_BATCH_SIZE, requireComplete = false, failurePolicy: AliasedBatchFailurePolicy = 'skip-failed-batch'): Promise<Pr[]> {
    const gonePrs: Pr[] = [];
    for (let index = 0; index < prs.length; index += batchSize) {
      const batch = prs.slice(index, index + batchSize);
      const response = await runGraphql(buildQuery(batch), []);
      const parsed = GRAPHQL_RESPONSE.safeParse(parseJsonOrNull(response.out));
      const errors = parsed.success ? parsed.data.errors ?? [] : [];
      const data = parsed.success ? parsed.data.data : null;
      const erroredAliases = aliasesOfErrors(errors);
      const isStrict = requireComplete || failurePolicy === 'throw-on-batch-failure';
      const batchFailure = aliasedBatchFailure(response, errors.length, Boolean(data), erroredAliases === null, isStrict);
      if (batchFailure !== null && failurePolicy === 'throw-on-batch-failure') throw new Error(batchFailure);
      if (batchFailure !== null || !data) continue;
      const goneAliases = aliasesReportedGone(errors);
      for (const [position, pr] of batch.entries()) {
        const alias = `pr${position}`;
        const hasAliasError = erroredAliases?.has(alias) ?? false;
        if (goneAliases.has(alias)) {
          gonePrs.push(pr);
          continue;
        }
        if (hasAliasError && requireComplete) continue;
        const outcome = readAlias(pr, data[alias]);
        if (outcome === 'gone' && !hasAliasError) gonePrs.push(pr);
      }
    }
    return gonePrs;
  }

  async function collectPrNodes<PrNode>(prs: readonly PrReference[], buildQuery: (batch: readonly PrReference[]) => string, repositorySchema: PrRepositorySchema<PrNode>, batchSize: number): Promise<{ byKey: Map<string, PrNode>; goneKeys: Set<string> }> {
    const nodesByKey = new Map<string, PrNode>();
    const referencesByKey = new Map(uniqueValidPrs(prs).map((pr) => [comparablePrKey(pr), pr]));
    const gonePrs = await forEachAliasedPr([...referencesByKey.values()], buildQuery, (pr, repository) => {
      const parsed = repositorySchema.safeParse(repository);
      if (!parsed.success) return 'unreadable';
      const node = parsed.data?.pullRequest;
      if (!node) return 'gone';
      nodesByKey.set(comparablePrKey(pr), node);
      return 'found';
    }, batchSize, true, 'throw-on-batch-failure');
    return { byKey: nodesByKey, goneKeys: new Set(gonePrs.map(comparablePrKey)) };
  }

  async function pagedReviewThreads(repo: string, number: number): Promise<MyPrThreadNodeType[] | null> {
    const parts = repoParts(repo);
    if (!parts || !isPrNumber(number)) return null;
    const threads: MyPrThreadNodeType[] = [];
    let cursor: string | null = null;
    for (let page = 1; page <= MAX_REVIEW_THREAD_PAGES; page += 1) {
      const cursorArgs = cursor === null ? [] : ['-f', `cursor=${cursor}`];
      const response = await runGraphql(MY_PR_THREADS_QUERY, ['-f', `owner=${parts[0]}`, '-f', `name=${parts[1]}`, '-F', `number=${number}`, ...cursorArgs]);
      if (!response.ok) return null;
      const parsed = MyPrThreadsResponse.safeParse(parseJsonOrNull(response.out));
      if (!parsed.success || parsed.data.errors?.length) return null;
      const reviewThreads = parsed.data.data.repository?.pullRequest?.reviewThreads;
      if (!reviewThreads) return null;
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
      const response = await runGraphql(query, ['-f', `id=${thread.id}`, '-f', `cursor=${cursor}`]);
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
      const response = await runGraphql(MY_PR_CHECK_CONTEXTS_QUERY, ['-f', `id=${rollup.id}`, '-f', `cursor=${cursor}`]);
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

  return scopedToOperations({
    conditionalGet: (path, validators) => conditionalGet(path, validators),
    sourceKind,

    async searchPrsLight(qualifiers, maxMembers) {
      if (maxMembers !== undefined && (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100)) return { ok: false, items: [], isComplete: false, error: 'invalid PR membership cap' };
      const items: GithubPrLightSearchNodeType[] = [];
      let cursor: string | null = null;
      let totalCount = 0;
      for (let page = 1; page <= (maxMembers === undefined ? MAX_GITHUB_PR_SEARCH_PAGES : 1); page += 1) {
        const cursorArgs = cursor === null ? [] : ['-f', `cursor=${cursor}`];
        const response = await runGraphql(githubPrsLightSearchQuery(maxMembers), ['-f', `searchQuery=is:pr ${qualifiers}`, ...cursorArgs]);
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
      return collectPrNodes(prs, githubPrsLightByKeyQuery, GITHUB_PR_LIGHT_REPOSITORY, 50);
    },

    async prDetails(prs) {
      const details = await collectPrNodes(prs, githubPrDetailsQuery, GITHUB_PR_DETAIL_REPOSITORY, REVIEW_SNAPSHOT_BATCH_SIZE);
      for (const node of details.byKey.values()) await completeCheckContexts(node);
      return details;
    },

    async notificationsSince(lastModified) {
      const githubSource = await source.current();
      if (githubSource.kind !== 'gh') return { kind: 'unchanged' };
      const response = await conditionalGet('notifications', lastModified === undefined ? {} : { lastModified }, githubSource);
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

    async addPrLabel({ repo, number, name }) {
      if (!repoParts(repo) || !isPrNumber(number)) return { ok: false, err: 'invalid repository or pull request number' };
      const label = WorkflowLabelName.safeParse(name);
      if (!label.success) return { ok: false, err: 'invalid label name' };
      const response = await runGh(['pr', 'edit', String(number), '--repo', repo, '--add-label', label.data], undefined, false, GH_WRITE_TIMEOUT_MS);
      return { ok: response.ok, err: response.ok ? '' : response.err.trim() || 'gh pr edit failed' };
    },

    async commentOnPr({ repo, number, body }) {
      if (!repoParts(repo) || !isPrNumber(number)) return { ok: false, err: 'invalid repository or pull request number' };
      const comment = WorkflowCommentBody.safeParse(body);
      if (!comment.success) return { ok: false, err: 'invalid comment body' };
      const response = await runGh(['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'], comment.data, false, GH_WRITE_TIMEOUT_MS);
      return { ok: response.ok, err: response.ok ? '' : response.err.trim() || 'gh pr comment failed' };
    },

    async teamReviewThreads(prs) {
      const threadsByPr = new Map<string, ThreadNode[]>();
      const paged: { pr: PrReference; cursor: string; threads: ThreadNode[] }[] = [];
      await forEachAliasedPr(uniqueValidPrs(prs), teamThreadsQuery, (pr, repository) => {
        const parsed = TeamReviewThreadsRepository.safeParse(repository);
        const connection = parsed.success ? parsed.data.pullRequest?.reviewThreads : null;
        if (!connection) return 'unreadable';
        if (!connection.pageInfo.hasNextPage) {
          threadsByPr.set(reviewSnapshotKey(pr.repo, pr.number), connection.nodes);
          return 'found';
        }
        if (connection.pageInfo.endCursor) paged.push({ pr, cursor: connection.pageInfo.endCursor, threads: connection.nodes });
        return 'found';
      }, REVIEW_SNAPSHOT_BATCH_SIZE, true);
      for (const pending of paged) {
        const parts = repoParts(pending.pr.repo);
        if (!parts) continue;
        let cursor = pending.cursor;
        for (let page = 1; page < MAX_REVIEW_THREAD_PAGES; page += 1) {
          const query = MY_PR_THREADS_QUERY.replace(REVIEW_THREAD_FIELDS, TEAM_THREAD_FIELDS);
          const response = await runGraphql(query, ['-f', `owner=${parts[0]}`, '-f', `name=${parts[1]}`, '-F', `number=${pending.pr.number}`, '-f', `cursor=${cursor}`]);
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
      const response = await runGraphql(RESOLVE_THREAD_MUTATION, ['-f', `id=${threadId}`], GH_WRITE_TIMEOUT_MS);
      const parsed = TeamReviewResolveResponse.safeParse(parseJsonOrNull(response.out));
      const isResolved = response.ok && parsed.success && !parsed.data.errors?.length && parsed.data.data?.resolveReviewThread.thread.id === threadId;
      return { ok: Boolean(isResolved), err: isResolved ? '' : response.err || 'GitHub did not confirm the thread was resolved' };
    },

    async unresolveReviewThread(threadId) {
      if (!ReviewThreadId.safeParse(threadId).success) return { ok: false, err: 'invalid review thread id' };
      const response = await runGraphql(UNRESOLVE_THREAD_MUTATION, ['-f', `id=${threadId}`], GH_WRITE_TIMEOUT_MS);
      const parsed = PrThreadUnresolveResponse.safeParse(parseJsonOrNull(response.out));
      const isReopened = response.ok && parsed.success && !parsed.data.errors?.length && parsed.data.data?.unresolveReviewThread.thread.id === threadId;
      return { ok: Boolean(isReopened), err: isReopened ? '' : response.err || 'GitHub did not confirm the thread was reopened' };
    },

    async replyToReviewThread(threadId, body) {
      if (!ReviewThreadId.safeParse(threadId).success) return { ok: false, err: 'invalid review thread id' };
      const response = await runGraphql(REPLY_THREAD_MUTATION, ['-f', `id=${threadId}`, '-f', `body=${body}`], GH_WRITE_TIMEOUT_MS);
      const parsed = PrThreadReplyResponse.safeParse(parseJsonOrNull(response.out));
      const isReplied = response.ok && parsed.success && !parsed.data.errors?.length && parsed.data.data !== null;
      return { ok: isReplied, err: isReplied ? '' : response.err || 'GitHub did not confirm the reply' };
    },

    async teamReviewCompare(repo, base, head) {
      if (!repoParts(repo) || !CommitSha.safeParse(base).success || !CommitSha.safeParse(head).success) return { ok: true, comparison: null };
      const response = await runGh(['api', `repos/${repo}/compare/${base}...${head}`]);
      if (!response.ok && /\bHTTP 404\b/.test(response.err) && /\bNo common ancestor between\b/i.test(response.err)) return { ok: true, comparison: null };
      if (!response.ok) return { ok: false, err: response.err || 'GitHub compare failed' };
      const parsed = TeamReviewCompareFiles.safeParse(parseJsonOrNull(response.out));
      if (!parsed.success) return { ok: false, err: 'GitHub returned an unreadable comparison' };
      return { ok: true, comparison: parsed.data };
    },

    async reviewThreadsBatch(prs) {
      const threadsByPr = new Map<string, MyPrThreadNodeType[]>();
      const morePages: PrReference[] = [];
      await forEachAliasedPr(uniqueValidPrs(prs), reviewThreadsBatchQuery, (pr, repository) => {
        const parsed = GRAPHQL_THREADS_REPOSITORY.safeParse(repository);
        if (!parsed.success) return 'unreadable';
        const reviewThreads = parsed.data.pullRequest?.reviewThreads;
        if (!reviewThreads) return 'gone';
        if (reviewThreads.pageInfo.hasNextPage) {
          morePages.push(pr);
          return 'found';
        }
        threadsByPr.set(reviewSnapshotKey(pr.repo, pr.number), reviewThreads.nodes.flatMap((thread) => {
          const valid = MyPrThreadNode.safeParse(thread);
          return valid.success ? [valid.data] : [];
        }));
        return 'found';
      }, REVIEW_SNAPSHOT_BATCH_SIZE, true, 'skip-failed-batch');
      for (const pr of morePages) {
        const threads = await pagedReviewThreads(pr.repo, pr.number);
        if (threads) threadsByPr.set(reviewSnapshotKey(pr.repo, pr.number), threads);
      }
      return threadsByPr;
    },

    async listMergedPrs(repo, limit) {
      if (!repoParts(repo)) return { ok: false, reason: 'invalid repository' };
      const prs: MergedPrListingType[] = [];
      let cursor: string | null = null;
      while (prs.length < limit) {
        const cursorArgs = cursor === null ? [] : ['-f', `cursor=${cursor}`];
        const pageSize = Math.min(MERGED_PRS_PAGE_SIZE, limit - prs.length);
        const response = await runGraphql(MERGED_PRS_QUERY, ['-f', `searchQuery=repo:${repo} is:pr is:merged sort:updated-desc`, '-F', `first=${pageSize}`, ...cursorArgs]);
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

    async reviewCaseData(repo, numbers) {
      const dataByNumber = new Map<number, MinedPrReviewDataType>();
      const prs = uniqueValidPrs(numbers.map((number) => ({ repo, number })));
      await forEachAliasedPr(prs, reviewCaseDataQuery, (pr, repository) => {
        const pullRequest = z.object({ pullRequest: z.unknown() }).safeParse(repository);
        const parsed = MinedPrReviewData.safeParse(pullRequest.success ? pullRequest.data.pullRequest : null);
        if (!parsed.success) return 'unreadable';
        dataByNumber.set(pr.number, parsed.data);
        return 'found';
      }, REVIEW_CASE_BATCH_SIZE);
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
      const counts = new Map<string, number | null>();
      const validPrs = prs.filter((pr) => repoParts(pr.repo) && isPrNumber(pr.number) && CommitSha.safeParse(pr.headSha).success);
      await forEachAliasedPr(validPrs, behindCountsQuery, (pr, repository) => {
        const comparison = GRAPHQL_BEHIND_REPOSITORY.safeParse(repository);
        if (!comparison.success) return 'unreadable';
        const pullRequest = comparison.data.pullRequest;
        if (!pullRequest) return 'gone';
        counts.set(reviewSnapshotKey(pr.repo, pr.number), pullRequest.baseRef?.compare?.behindBy ?? null);
        return 'found';
      }, REVIEW_SNAPSHOT_BATCH_SIZE, true, 'throw-on-batch-failure');
      return counts;
    },
    rateLimitResources,
    async rateLimitWaitMs(nowMs, resourceNames) {
      const resources = await rateLimitResources();
      return resources === null ? null : githubRateLimitWaitMs(resources, nowMs, resourceNames);
    },
    async rebasePr(pullRequestId, expectedHeadSha) {
      if (!NODE_ID_RE.test(pullRequestId) || !CommitSha.safeParse(expectedHeadSha).success) return { ok: false, err: 'invalid pull request id or head' };
      const response = await runGraphql(REBASE_PR_MUTATION, ['-f', `id=${pullRequestId}`, '-f', `head=${expectedHeadSha}`], GH_WRITE_TIMEOUT_MS);
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
      const response = await runGh(['pr', 'merge', String(number), '--repo', repo, GH_MERGE_FLAGS[parsedMethod.data], '--match-head-commit', headSha], undefined, false, GH_WRITE_TIMEOUT_MS);
      if (!response.ok) return { ok: false, err: response.err.trim() || 'gh pr merge failed' };
      const prState = await runGraphql(MY_PR_MERGE_STATE_QUERY, ['-f', `owner=${parts[0]}`, '-f', `name=${parts[1]}`, '-F', `number=${number}`]);
      return { ok: true, kind: prState.ok ? mergeKindFromPrState(prState.out) : 'unconfirmed' };
    },
    async viewer() {
      const response = await runGh(['api', 'user', '--jq', '.login']);
      if (!response.ok) return null;
      const parsed = GH_LOGIN.safeParse(response.out);
      return parsed.success ? parsed.data : null;
    },

    async viewerTeams() {
      const response = await runGh(['api', '--paginate', 'user/teams', '--jq', '.[] | {org: .organization.login, slug: .slug, name: .name}']);
      if (!response.ok) return null;
      const lines = response.out ? response.out.split(/\r?\n/).filter(Boolean) : [];
      const parsed = GH_TEAMS.safeParse(lines.map((line) => parseJsonOrNull(line)));
      if (!parsed.success) return null;
      const orgsResponse = await runGh(['api', '--paginate', 'user/orgs', '--jq', '.[].login']);
      const orgLogins = orgsResponse.ok && orgsResponse.out ? orgsResponse.out.split(/\r?\n/).filter(Boolean) : [];
      const parsedOrgs = GH_MEMBERS.safeParse(orgLogins);
      return { teams: parsed.data, orgs: parsedOrgs.success ? parsedOrgs.data : [] };
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
      const response = await runGraphql(TEAM_PROFILE_QUERY, ['-f', `org=${org}`, '-f', `slug=${team}`]);
      if (!response.ok) return null;
      const parsed = TEAM_PROFILE.safeParse(parseJsonOrNull(response.out));
      if (!parsed.success || parsed.data.errors?.length || !parsed.data.data.organization?.team) return null;
      const profile = parsed.data.data.organization.team;
      return { org, slug: team, name: profile.name, avatarUrl: profile.avatarUrl };
    },

    async viewPr(repo, number) {
      if (!repoParts(repo) || !isPrNumber(number)) return null;
      const response = await runGh(['pr', 'view', String(number), '-R', repo, '--json', 'number,title,body,url,state,author,isDraft,isCrossRepository,baseRefName,baseRefOid,headRefName,headRefOid,additions,deletions,files']);
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
      if (!PostedReviewEvent.safeParse(event).success) return { ok: false, err: 'invalid review event', reviewId: null };
      if (typeof body !== 'string' || !Array.isArray(comments)) return { ok: false, err: 'invalid review body or comments', reviewId: null };
      const parsedComments = z.array(ReviewComment).safeParse(comments);
      if (!parsedComments.success) return { ok: false, err: 'invalid review comments', reviewId: null };
      const input = JSON.stringify({ commit_id: commitId, event, body, comments: parsedComments.data });
      const response = await runGh(['api', '-X', 'POST', `repos/${parts[0]}/${parts[1]}/pulls/${number}/reviews`, '--input', '-'], input, false, GH_WRITE_TIMEOUT_MS);
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
      const response = await runGh(['api', '-X', 'PUT', `repos/${parts[0]}/${parts[1]}/pulls/${number}/reviews/${reviewId}/dismissals`, '--input', '-'], input, false, GH_WRITE_TIMEOUT_MS);
      return { ok: response.ok, err: response.ok ? '' : response.err.trim() || 'gh review dismissal failed' };
    },
  });
}

export { createPrGh };
export type { CommandResult, PrGh };
