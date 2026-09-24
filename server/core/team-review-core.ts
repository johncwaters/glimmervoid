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
  ERROR_PHASE, TEAM_REVIEW_BRANCH_PREFIX, TEAM_REVIEW_LANE_ID, TEAM_REVIEW_STATE_FILENAME,
  filterActionablePrs, phaseForVerdict, planReviews, prKey,
};
