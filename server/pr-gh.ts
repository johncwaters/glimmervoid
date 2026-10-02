import { execFileAsync } from './child-process-safe.ts';
import { z } from 'zod';
import { CommitSha, PrDetail, ReviewComment, SearchedPr } from '../shared/contracts/team-review.ts';
import { MyPrSearchNode, MyPrSearchResponse, MyPrThreadNode, MyPrThreadsResponse } from '../shared/contracts/my-prs.ts';
import type { MyPrSearchNode as MyPrSearchNodeType, MyPrThreadNode as MyPrThreadNodeType } from '../shared/contracts/my-prs.ts';
import type { PostedReviewEvent, PrDetail as PrDetailType, ReviewComment as ReviewCommentType, SearchedPr as SearchedPrType, TeamReviewStatus } from '../shared/contracts/team-review.ts';


interface CommandResult {
  ok: boolean;
  out: string;
  err: string;
}

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

type GithubIssueWithoutBody = Omit<GithubIssue, 'body'>;

interface PrSearchResult {
  items: SearchedPrType[];
  complete: boolean;
}

interface PrReviewSnapshot {
  head: string;
  reviews: { login: string; state: string; commit: string | null; submittedAt?: string | null }[];
}

interface PrReference {
  repo: string;
  number: number;
}

interface GithubIssueList {
  ok: boolean;
  issues: GithubIssueWithoutBody[];
  error: string;
}

interface GithubIssueDetail {
  ok: boolean;
  issue: GithubIssue | null;
  error: string;
}

interface PrGh {
  searchMyPrs(org: string, mergedSince: string): Promise<{ ok: boolean; items: MyPrSearchNodeType[]; totalCount: number; error: string }>;
  behindBy(repo: string, base: string, headSha: string): Promise<number | null>;
  reviewThreads(repo: string, number: number): Promise<MyPrThreadNodeType[]>;
  repoSlug(): Promise<string | null>;
  listIssues(): Promise<GithubIssueList>;
  viewIssue(issueNumber: number | string): Promise<GithubIssueDetail>;
  viewer(): Promise<string | null>;
  teamMembers(org: string, team: string): Promise<string[]>;
  teamProfile(org: string, team: string): Promise<NonNullable<TeamReviewStatus['team']> | null>;
  searchTeamRequested(org: string, team: string): Promise<PrSearchResult>;
  searchAuthoredBy(org: string, logins: string[]): Promise<PrSearchResult>;
  viewPr(repo: string, number: number): Promise<PrDetailType | null>;
  prDiff(repo: string, number: number): Promise<string | null>;
  prHead(repo: string, number: number): Promise<string | null>;
  prReviewSnapshots(prs: readonly PrReference[]): Promise<Map<string, PrReviewSnapshot>>;
  postReview(review: { repo: string; number: number; commitId: string; event: PostedReviewEvent; body: string; comments: ReviewCommentType[] }): Promise<PostedReview>;
  dismissReview(dismissal: { repo: string; number: number; reviewId: number; message: string }): Promise<{ ok: boolean; err: string }>;
}

interface PostedReview {
  ok: boolean;
  err: string;
  reviewId: number | null;
}

async function run(cmd: string, args: string[], cwd: string, input?: string, preserveOutput = false): Promise<CommandResult> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 + 1, input });
    return { ok: true, out: preserveOutput ? stdout : stdout.trim(), err: '' };
  } catch (err) {
    const failure = (err ?? {}) as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return { ok: false, out: String(failure.stdout || '').trim(), err: String(failure.stderr || failure.message || '') };
  }
}

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; }
  catch { return fallback; }
}

const HEX_LABEL_COLOR = /^[0-9a-f]{6}$/i;
const GH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*\s)[A-Za-z0-9_./-]+$/;
const MERGED_SINCE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MY_PRS_QUERY = `query($openQuery: String!, $mergedQuery: String!) {
  open: search(type: ISSUE, first: 50, query: $openQuery) { issueCount nodes { ...myPrFields } }
  merged: search(type: ISSUE, first: 50, query: $mergedQuery) { issueCount nodes { ...myPrFields } }
}
fragment myPrFields on PullRequest {
  __typename number title url isDraft state createdAt mergedAt updatedAt baseRefName headRefOid mergeable mergeStateStatus reviewDecision
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes {
    __typename ... on CheckRun { name conclusion status } ... on StatusContext { context state }
  } } } } } }
  reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug avatarUrl organization { login } } } } }
  latestOpinionatedReviews(first: 20) { nodes { state } }
  latestReviews(first: 20) { nodes { state submittedAt author { login } } }
}`;
const MY_PR_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes {
    isResolved isOutdated path line
    firstComment: comments(first: 1) { totalCount nodes { author { login } bodyText url createdAt } }
    lastComment: comments(last: 1) { nodes { author { login } createdAt } }
  } } } }
}`;
const GH_LOGIN = z.string().regex(GH_SEGMENT);
const GH_MEMBERS = z.array(GH_LOGIN);
const TEAM_PROFILE = z.object({ data: z.object({ organization: z.object({ team: z.object({ name: z.string(), avatarUrl: z.string().url() }).nullable() }).nullable() }), errors: z.array(z.unknown()).optional() });
const TEAM_PROFILE_QUERY = 'query($org: String!, $slug: String!) { organization(login: $org) { team(slug: $slug) { name avatarUrl } } }';
const SEARCH_RESPONSE = z.object({ items: z.array(SearchedPr) });
const SEARCH_PAGE_SIZE = 100;
const MAX_SEARCH_PAGES = 5;
const MAX_REVIEW_THREAD_PAGES = 5;
const PR_DIFF_MAX_BYTES = 2 * 1024 * 1024;
const CREATED_REVIEW = z.object({ id: z.number().int().positive() }).passthrough();
const REVIEW_SNAPSHOT_BATCH_SIZE = 25;
const LATEST_REVIEWS_PER_PR = 20;
const GRAPHQL_REVIEW_REPOSITORY = z.object({
  pullRequest: z.object({
    headRefOid: CommitSha,
    latestReviews: z.object({
      nodes: z.array(z.object({
        author: z.object({ login: z.string() }).passthrough().nullable(),
        state: z.string(),
        submittedAt: z.string().nullable().optional(),
        commit: z.object({ oid: z.string() }).passthrough().nullable().optional(),
      }).passthrough().nullable()),
    }).passthrough(),
  }).passthrough().nullable(),
}).passthrough().nullable();
const GRAPHQL_RESPONSE = z.object({ data: z.record(z.string(), z.unknown()).nullable() }).passthrough();
const PR_DIFF = z.string().refine((diff) => Buffer.byteLength(diff, 'utf8') <= PR_DIFF_MAX_BYTES);

function repoParts(repo: string): [string, string] | null {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts.every((part) => GH_SEGMENT.test(part))) return null;
  return [parts[0], parts[1]];
}

function isPrNumber(number: number): boolean {
  return Number.isSafeInteger(number) && number > 0;
}

function reviewSnapshotKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function reviewSnapshotQuery(prs: readonly PrReference[]): string {
  const fields = prs.map((pr, index) => {
    const [owner, name] = repoParts(pr.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) { headRefOid latestReviews(first: ${LATEST_REVIEWS_PER_PR}) { nodes { author { login } state submittedAt commit { oid } } } } }`;
  });
  return `query { ${fields.join(' ')} }`;
}

function reviewSnapshotFrom(repository: unknown): PrReviewSnapshot | null {
  const parsed = GRAPHQL_REVIEW_REPOSITORY.safeParse(repository);
  const pullRequest = parsed.success ? parsed.data?.pullRequest : null;
  if (!pullRequest) return null;
  const reviews = pullRequest.latestReviews.nodes.flatMap((review) => (review?.author
    ? [{ login: review.author.login, state: review.state, commit: CommitSha.safeParse(review.commit?.oid).data ?? null, ...(review.submittedAt !== undefined ? { submittedAt: review.submittedAt } : {}) }]
    : []));
  return { head: pullRequest.headRefOid, reviews };
}

function uniqueValidPrs(prs: readonly PrReference[]): PrReference[] {
  const byKey = new Map<string, PrReference>();
  for (const pr of prs) {
    if (!repoParts(pr.repo) || !isPrNumber(pr.number)) continue;
    byKey.set(reviewSnapshotKey(pr.repo, pr.number), { repo: pr.repo, number: pr.number });
  }
  return [...byKey.values()];
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

function issueWithoutBody(issue: GithubIssue): GithubIssueWithoutBody {
  return {
    number: issue.number,
    title: issue.title,
    labels: issue.labels,
    url: issue.url,
    updatedAt: issue.updatedAt,
  };
}

function createPrGh(cwd: string, commandRunner: typeof run = run): PrGh {
  async function runGh(args: string[], input?: string, preserveOutput = false): Promise<CommandResult> {
    try {
      return await commandRunner('gh', args, cwd, input, preserveOutput);
    } catch (error) {
      return { ok: false, out: '', err: error instanceof Error ? error.message : String(error) };
    }
  }

  async function searchPage(query: string, page: number): Promise<SearchedPrType[] | null> {
    const response = await runGh(['api', '-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', `per_page=${SEARCH_PAGE_SIZE}`, '-f', `page=${page}`]);
    if (!response.ok) return null;
    const parsed = SEARCH_RESPONSE.safeParse(parseJson<unknown>(response.out, null));
    return parsed.success ? parsed.data.items : null;
  }

  async function search(query: string): Promise<PrSearchResult> {
    const items: SearchedPrType[] = [];
    for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
      const pageItems = await searchPage(query, page);
      if (!pageItems) return { items, complete: false };
      items.push(...pageItems);
      if (pageItems.length < SEARCH_PAGE_SIZE) return { items, complete: true };
    }
    return { items, complete: false };
  }

  return {
    async searchMyPrs(org, mergedSince) {
      if (!GH_SEGMENT.test(org) || !MERGED_SINCE_DATE.test(mergedSince)) return { ok: false, items: [], totalCount: 0, error: 'invalid organization or date' };
      const response = await runGh(['api', 'graphql', '-H', 'Accept: application/vnd.github.merge-info-preview+json', '-f', `query=${MY_PRS_QUERY}`, '-f', `openQuery=is:pr is:open author:@me org:${org} sort:updated-desc`, '-f', `mergedQuery=is:pr is:merged author:@me org:${org} merged:>=${mergedSince} sort:updated-desc`]);
      if (!response.ok) return { ok: false, items: [], totalCount: 0, error: response.err.trim() || 'gh graphql search failed' };
      const parsed = MyPrSearchResponse.safeParse(parseJson<unknown>(response.out, null));
      if (!parsed.success) return { ok: false, items: [], totalCount: 0, error: 'invalid gh graphql response' };
      if (parsed.data.errors?.length) return { ok: false, items: [], totalCount: 0, error: 'gh graphql returned errors' };
      const items = [...parsed.data.data.open.nodes, ...parsed.data.data.merged.nodes].flatMap((node) => {
        const valid = MyPrSearchNode.safeParse(node);
        return valid.success ? [valid.data] : [];
      });
      const { open, merged } = parsed.data.data;
      return { ok: true, items, totalCount: open.issueCount + merged.issueCount, error: '' };
    },

    async reviewThreads(repo, number) {
      const parts = repoParts(repo);
      if (!parts || !isPrNumber(number)) return [];
      const threads: MyPrThreadNodeType[] = [];
      let cursor: string | null = null;
      for (let page = 1; page <= MAX_REVIEW_THREAD_PAGES; page += 1) {
        const cursorArgs = cursor === null ? [] : ['-f', `cursor=${cursor}`];
        const response = await runGh(['api', 'graphql', '-f', `query=${MY_PR_THREADS_QUERY}`, '-f', `owner=${parts[0]}`, '-f', `name=${parts[1]}`, '-F', `number=${number}`, ...cursorArgs]);
        if (!response.ok) return [];
        const parsed = MyPrThreadsResponse.safeParse(parseJson<unknown>(response.out, null));
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
    },

    async behindBy(repo, base, headSha) {
      const parts = repoParts(repo);
      if (!parts || !SAFE_REF.test(base) || !CommitSha.safeParse(headSha).success) return null;
      const response = await runGh(['api', `repos/${parts[0]}/${parts[1]}/compare/${base}...${headSha}`, '--jq', '.behind_by']);
      if (!response.ok || !/^\d+$/.test(response.out)) return null;
      return Number(response.out);
    },
    async repoSlug() {
      const r = await commandRunner('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd);
      return r.ok ? r.out : null;
    },

    async listIssues() {
      const r = await commandRunner('gh', ['issue', 'list', '--state', 'open', '-L', '50', '--search', 'sort:updated-desc', '--json', 'number,title,labels,url,updatedAt'], cwd);
      if (!r.ok) return { ok: false, issues: [], error: r.err.trim() || 'gh issue list failed' };
      const rows = parseJson<GithubIssueRow[]>(r.out, []);
      const issues = Array.isArray(rows)
        ? rows.map(normalizeIssue).filter((issue): issue is GithubIssue => issue !== null).map(issueWithoutBody)
        : [];
      return { ok: true, issues, error: '' };
    },

    async viewIssue(issueNumber) {
      const r = await commandRunner('gh', ['issue', 'view', String(issueNumber), '--json', 'number,title,body,labels,url,updatedAt'], cwd);
      if (!r.ok) return { ok: false, issue: null, error: r.err.trim() || 'gh issue view failed' };
      const issue = normalizeIssue(parseJson<GithubIssueRow>(r.out, {}));
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
      if (!response.ok) return [];
      const members = response.out ? response.out.split(/\r?\n/) : [];
      const parsed = GH_MEMBERS.safeParse(members);
      return parsed.success ? parsed.data : [];
    },

    async teamProfile(org, team) {
      if (!GH_SEGMENT.test(org) || !GH_SEGMENT.test(team)) return null;
      const response = await runGh(['api', 'graphql', '-f', `query=${TEAM_PROFILE_QUERY}`, '-f', `org=${org}`, '-f', `slug=${team}`]);
      if (!response.ok) return null;
      const parsed = TEAM_PROFILE.safeParse(parseJson(response.out, null));
      if (!parsed.success || parsed.data.errors?.length || !parsed.data.data.organization?.team) return null;
      const profile = parsed.data.data.organization.team;
      return { org, slug: team, name: profile.name, avatarUrl: profile.avatarUrl };
    },

    async searchTeamRequested(org, team) {
      if (!GH_SEGMENT.test(org) || !GH_SEGMENT.test(team)) return { items: [], complete: false };
      return search(`is:pr is:open draft:false org:${org} team-review-requested:${org}/${team}`);
    },

    async searchAuthoredBy(org, logins) {
      if (!GH_SEGMENT.test(org) || !logins.every((login) => GH_SEGMENT.test(login))) return { items: [], complete: false };
      const items: SearchedPrType[] = [];
      let complete = true;
      for (let index = 0; index < logins.length; index += 5) {
        const authors = logins.slice(index, index + 5).map((login) => `author:${login}`).join(' ');
        const chunk = await search(`is:pr is:open draft:false org:${org} ${authors}`);
        items.push(...chunk.items);
        complete = complete && chunk.complete;
      }
      return { items, complete };
    },

    async viewPr(repo, number) {
      if (!repoParts(repo) || !isPrNumber(number)) return null;
      const response = await runGh(['pr', 'view', String(number), '-R', repo, '--json', 'number,title,body,url,author,isDraft,isCrossRepository,baseRefName,baseRefOid,headRefOid,additions,deletions,files']);
      if (!response.ok) return null;
      const parsed = PrDetail.safeParse(parseJson<unknown>(response.out, null));
      return parsed.success ? parsed.data : null;
    },

    async prDiff(repo, number) {
      if (!repoParts(repo) || !isPrNumber(number)) return null;
      const response = await runGh(['pr', 'diff', String(number), '-R', repo], undefined, true);
      if (!response.ok) return null;
      const parsed = PR_DIFF.safeParse(response.out);
      return parsed.success ? parsed.data : null;
    },

    async prReviewSnapshots(prs) {
      const snapshots = new Map<string, PrReviewSnapshot>();
      const validPrs = uniqueValidPrs(prs);
      for (let index = 0; index < validPrs.length; index += REVIEW_SNAPSHOT_BATCH_SIZE) {
        const batch = validPrs.slice(index, index + REVIEW_SNAPSHOT_BATCH_SIZE);
        const response = await runGh(['api', 'graphql', '-f', `query=${reviewSnapshotQuery(batch)}`]);
        const parsed = GRAPHQL_RESPONSE.safeParse(parseJson<unknown>(response.out, null));
        const data = parsed.success ? parsed.data.data : null;
        if (!data) continue;
        batch.forEach((pr, position) => {
          const snapshot = reviewSnapshotFrom(data[`pr${position}`]);
          if (snapshot) snapshots.set(reviewSnapshotKey(pr.repo, pr.number), snapshot);
        });
      }
      return snapshots;
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
      const created = CREATED_REVIEW.safeParse(parseJson<unknown>(response.out, null));
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

export { createPrGh, normalizeIssue };
export type { CommandResult, GithubIssue, GithubIssueDetail, GithubIssueLabel, GithubIssueList, GithubIssueWithoutBody, PostedReview, PrGh, PrReference, PrReviewSnapshot, PrSearchResult };
