import type { PrDetail, ReviewDraft, SearchedPr } from '../../shared/contracts/team-review.ts';

const STAMP_MODEL = 'sonnet';
const FULL_MODEL = 'opus';
const STAMP_MAX_LINES = 200;
const STAMP_MAX_FILES = 10;
const MAX_CONCURRENT_REVIEWS = 2;
const REVIEW_TIMEOUT_SECONDS = 900;
const POLL_INTERVAL_MINUTES = 15;

const BOT_LOGINS = new Set(['dependabot[bot]', 'renovate[bot]']);

const TEAM_REVIEW_LANE_ID = 'team-review';
const TEAM_REVIEW_STATE_FILENAME = `${TEAM_REVIEW_LANE_ID}-state.json`;
const TEAM_REVIEW_BRANCH_PREFIX = `glimmervoid/${TEAM_REVIEW_LANE_ID}/`;

const ERROR_PHASE = 'error';
const PHASE_BY_VERDICT: Readonly<Record<string, string>> = Object.freeze({
  CLEAN: 'clean',
  RESOLVED: 'clean',
  CHANGES: 'changes-requested',
  ERROR: ERROR_PHASE,
});

export interface PullRequestCandidate {
  isDraft?: boolean;
  isCrossRepository?: boolean;
  headOwner?: string | null;
  key?: string;
  headRefOid?: string;
  author: { isBot?: boolean; login: string };
}

export interface PullRequestFilterOptions {
  repoOwner?: string;
  allowForks?: boolean;
  includeBots?: boolean;
}

export interface ReviewStateEntry {
  inFlight?: boolean;
  reviewedHead?: string;
  phase?: string;
}

function phaseForVerdict(verdict: string): string {
  return PHASE_BY_VERDICT[verdict] ?? ERROR_PHASE;
}

function prKey(repoSlug: string, prNumber: number | string): string {
  return `${repoSlug}#${prNumber}`;
}

function repoFromSearchItem(item: SearchedPr): string | null {
  if (!URL.canParse(item.repository_url)) return null;
  const repositoryPath = new URL(item.repository_url).pathname;
  const match = /\/repos\/([^/]+\/[^/]+)\/?$/.exec(repositoryPath);
  if (!match) return null;
  return match[1];
}

function selectCandidates(teamRequested: SearchedPr[], authored: SearchedPr[], { self }: { self: string }) {
  const candidates = [];
  const seenKeys = new Set<string>();
  for (const item of [...teamRequested, ...authored]) {
    if (item.user.login.toLowerCase() === self.toLowerCase()) continue;
    if (item.draft === true) continue;
    if (item.user.type === 'Bot' || item.user.login.toLowerCase().endsWith('[bot]')) continue;
    const repo = repoFromSearchItem(item);
    if (repo === null) continue;
    const key = prKey(repo, item.number);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    candidates.push({ key, repo, number: item.number, title: item.title, url: item.html_url, author: item.user.login });
  }
  return candidates;
}

function sensitivePathReason(filePath: string): string | null {
  const normalizedPath = filePath.toLowerCase();
  if (/(?:auth|login|oauth|session_token|permission)/.test(normalizedPath)) return `touches ${filePath}`;
  if (/(?:secret|credential|\.env|\.pem|api_key)/.test(normalizedPath)) return `touches ${filePath}`;
  if (/(?:^|\/)migrations\//.test(normalizedPath)) return `touches ${filePath}`;
  if (/(?:^|\/)\.github\/workflows\//.test(normalizedPath)) return `touches ${filePath}`;
  if (/(?:^|\/)(?:dockerfile|docker-compose)(?:\.|$)/.test(normalizedPath)) return `touches ${filePath}`;
  if (/(?:^|\/)terraform(?:\/|$)|\.tf$/.test(normalizedPath)) return `touches ${filePath}`;
  if (/(?:^|\/)(?:k8s|helm)(?:\/|$)/.test(normalizedPath)) return `touches ${filePath}`;
  return null;
}

function isExcludedFromSize(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  const fileName = normalizedPath.split('/').at(-1) ?? '';
  if (isDocsOrTests(filePath)) return true;
  if (['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'uv.lock', 'cargo.lock', 'go.sum'].includes(fileName) || fileName.endsWith('.lock')) return true;
  if (fileName.endsWith('.snap') || /(?:^|\/)__snapshots__\//.test(normalizedPath)) return true;
  if (/(?:^|\/)(?:fixtures|__fixtures__|generated|dist|build)\//.test(normalizedPath)) return true;
  return fileName.endsWith('.min.js');
}

function isDocsOrTests(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  const fileName = normalizedPath.split('/').at(-1) ?? '';
  if (/\.(?:md|mdx|txt|rst)$/.test(fileName) || /(?:^|\/)docs\//.test(normalizedPath)) return true;
  return /(?:^|\/)(?:test|tests|__tests__|spec)\//.test(normalizedPath) || /(?:\.test\.|\.spec\.|_test\.)/.test(fileName);
}

function triagePr(detail: PrDetail): { tier: 'skip' | 'stamp' | 'full'; reasons: string[] } {
  if (detail.isCrossRepository) return { tier: 'skip', reasons: ['fork'] };
  for (const file of detail.files) {
    const reason = sensitivePathReason(file.path);
    if (reason) return { tier: 'full', reasons: [reason] };
  }
  const countedFiles = detail.files.filter((file) => !isExcludedFromSize(file.path));
  const countedLines = countedFiles.reduce((total, file) => total + file.additions + file.deletions, 0);
  if (countedLines > STAMP_MAX_LINES) return { tier: 'full', reasons: [`${countedLines} counted lines over ${STAMP_MAX_LINES}`] };
  if (countedFiles.length > STAMP_MAX_FILES) return { tier: 'full', reasons: [`${countedFiles.length} counted files over ${STAMP_MAX_FILES}`] };
  if (countedFiles.length === 0 && detail.files.length > 0 && detail.files.every((file) => isDocsOrTests(file.path))) return { tier: 'stamp', reasons: ['docs and tests only'] };
  if (countedFiles.length === 0) return { tier: 'stamp', reasons: ['no counted source files'] };
  return { tier: 'stamp', reasons: [`${countedLines} counted lines in ${countedFiles.length} files`] };
}

function canPost(draft: ReviewDraft, clickedHead: string, currentHead: string): boolean {
  return draft.status === 'ready' && draft.reviewedHead === clickedHead && draft.reviewedHead === currentHead;
}

function eventForAction(action: string): 'APPROVE' | 'COMMENT' | null {
  if (action === 'approve') return 'APPROVE';
  if (action === 'comment') return 'COMMENT';
  return null;
}

function isFork(pr: PullRequestCandidate, opts: PullRequestFilterOptions): boolean {
  if (pr.isCrossRepository === true) return true;
  if (opts.repoOwner && pr.headOwner !== opts.repoOwner) return true;
  return false;
}

function isBotAuthor(pr: PullRequestCandidate): boolean {
  if (pr.author.isBot === true) return true;
  return BOT_LOGINS.has(pr.author.login);
}

function filterActionablePrs<T extends PullRequestCandidate>(prs: T[], opts: PullRequestFilterOptions = {}): T[] {
  return prs.filter((pr) => {
    if (pr.isDraft) return false;
    if (isFork(pr, opts) && !opts.allowForks) return false;
    if (isBotAuthor(pr) && !opts.includeBots) return false;
    return true;
  });
}

function planReviews<T extends { key?: string; headRefOid?: string }>(
  prs: T[],
  state: Record<string, ReviewStateEntry | undefined>,
): T[] {
  return prs.filter((pr) => {
    const entry = state[pr.key ?? ''];
    if (!entry) return true;
    if (entry.inFlight) return false;
    return entry.reviewedHead !== pr.headRefOid;
  });
}

export {
  STAMP_MODEL, FULL_MODEL, STAMP_MAX_LINES, STAMP_MAX_FILES, MAX_CONCURRENT_REVIEWS,
  REVIEW_TIMEOUT_SECONDS, POLL_INTERVAL_MINUTES,
  ERROR_PHASE, TEAM_REVIEW_BRANCH_PREFIX, TEAM_REVIEW_LANE_ID, TEAM_REVIEW_STATE_FILENAME,
  canPost, eventForAction, filterActionablePrs, phaseForVerdict, planReviews, prKey,
  repoFromSearchItem, selectCandidates, triagePr,
};
