import { execFileAsync } from './child-process-safe.ts';
import { z } from 'zod';
import { CommitSha, PrDetail, ReviewComment, SearchedPr } from '../shared/contracts/team-review.ts';
import type { PrDetail as PrDetailType, ReviewComment as ReviewCommentType, SearchedPr as SearchedPrType } from '../shared/contracts/team-review.ts';


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
  repoSlug(): Promise<string | null>;
  listIssues(): Promise<GithubIssueList>;
  viewIssue(issueNumber: number | string): Promise<GithubIssueDetail>;
  viewer(): Promise<string | null>;
  teamMembers(org: string, team: string): Promise<string[]>;
  searchTeamRequested(org: string, team: string): Promise<SearchedPrType[]>;
  searchAuthoredBy(org: string, logins: string[]): Promise<SearchedPrType[]>;
  viewPr(repo: string, number: number): Promise<PrDetailType | null>;
  prDiff(repo: string, number: number): Promise<string | null>;
  prHead(repo: string, number: number): Promise<string | null>;
  postReview(review: { repo: string; number: number; commitId: string; event: 'APPROVE' | 'COMMENT'; body: string; comments: ReviewCommentType[] }): Promise<{ ok: boolean; err: string }>;
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
const GH_LOGIN = z.string().regex(GH_SEGMENT);
const GH_MEMBERS = z.array(GH_LOGIN);
const SEARCH_RESPONSE = z.object({ items: z.array(SearchedPr) });
const SEARCH_PAGE_SIZE = 100;
const MAX_SEARCH_PAGES = 5;
const PR_DIFF_MAX_BYTES = 2 * 1024 * 1024;
const PR_DIFF = z.string().refine((diff) => Buffer.byteLength(diff, 'utf8') <= PR_DIFF_MAX_BYTES);

function repoParts(repo: string): [string, string] | null {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts.every((part) => GH_SEGMENT.test(part))) return null;
  return [parts[0], parts[1]];
}

function isPrNumber(number: number): boolean {
  return Number.isSafeInteger(number) && number > 0;
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

  async function search(query: string): Promise<SearchedPrType[]> {
    const items: SearchedPrType[] = [];
    for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
      const pageItems = await searchPage(query, page);
      if (!pageItems) return items;
      items.push(...pageItems);
      if (pageItems.length < SEARCH_PAGE_SIZE) return items;
    }
    return items;
  }

  return {
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

    async searchTeamRequested(org, team) {
      if (!GH_SEGMENT.test(org) || !GH_SEGMENT.test(team)) return [];
      return search(`is:pr is:open draft:false org:${org} team-review-requested:${org}/${team}`);
    },

    async searchAuthoredBy(org, logins) {
      if (!GH_SEGMENT.test(org) || !logins.every((login) => GH_SEGMENT.test(login))) return [];
      const items: SearchedPrType[] = [];
      for (let index = 0; index < logins.length; index += 5) {
        const authors = logins.slice(index, index + 5).map((login) => `author:${login}`).join(' ');
        const chunk = await search(`is:pr is:open draft:false org:${org} ${authors}`);
        items.push(...chunk);
      }
      return items;
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

    async prHead(repo, number) {
      if (!repoParts(repo) || !isPrNumber(number)) return null;
      const response = await runGh(['pr', 'view', String(number), '-R', repo, '--json', 'headRefOid', '--jq', '.headRefOid']);
      if (!response.ok) return null;
      const parsed = CommitSha.safeParse(response.out);
      return parsed.success ? parsed.data : null;
    },

    async postReview({ repo, number, commitId, event, body, comments }) {
      const parts = repoParts(repo);
      if (!parts || !isPrNumber(number)) return { ok: false, err: 'invalid repository or pull request number' };
      if (!CommitSha.safeParse(commitId).success) return { ok: false, err: 'invalid commit id' };
      if (event !== 'APPROVE' && event !== 'COMMENT') return { ok: false, err: 'invalid review event' };
      if (typeof body !== 'string' || !Array.isArray(comments)) return { ok: false, err: 'invalid review body or comments' };
      const parsedComments = z.array(ReviewComment).safeParse(comments);
      if (!parsedComments.success) return { ok: false, err: 'invalid review comments' };
      const input = JSON.stringify({ commit_id: commitId, event, body, comments: parsedComments.data });
      const response = await runGh(['api', '-X', 'POST', `repos/${parts[0]}/${parts[1]}/pulls/${number}/reviews`, '--input', '-'], input);
      return { ok: response.ok, err: response.ok ? '' : response.err.trim() || 'gh review post failed' };
    },
  };
}

export { createPrGh, normalizeIssue };
export type { CommandResult, GithubIssue, GithubIssueDetail, GithubIssueLabel, GithubIssueList, GithubIssueWithoutBody, PrGh };
