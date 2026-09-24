import { execFileAsync } from './child-process-safe.ts';


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
}

async function run(cmd: string, args: string[], cwd: string): Promise<CommandResult> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, encoding: 'utf8', timeout: 30000 });
    return { ok: true, out: String(stdout || '').trim(), err: '' };
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
  };
}

export { createPrGh, normalizeIssue };
export type { CommandResult, GithubIssue, GithubIssueDetail, GithubIssueLabel, GithubIssueList, GithubIssueWithoutBody, PrGh };
