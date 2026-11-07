import { MAX_REPO_ISSUES } from '../../../server/github/core/issues-core.ts';
import type { createGithubStorePoller } from '../../../server/github/github-store-poller.ts';
import type { IssuesListingPayload } from '../../../shared/contracts/issues-listing.ts';
import type { IssuePullRequest, IssueUpdate, ListedIssue } from '../../../shared/contracts/issues.ts';
import type { IssuesWatcheeSettings } from '../../../shared/contracts/watchee-settings.ts';

const PAGE_SIZE = 100;
const MAX_LISTED_PAGES = Math.ceil(MAX_REPO_ISSUES / PAGE_SIZE);
const PENDING_PULL_REQUEST_RECHECK_EVERY_LISTS = 6;

type IssuesStore = Pick<ReturnType<typeof createGithubStorePoller>, 'requestViewer' | 'requestIssuePage' | 'requestIssueSearch' | 'requestIssueLinkedPullRequests'>;
type ListedSource = { source: 'project'; repo: string } | { source: 'me' } | { source: 'team'; team: string };
type SourceListing =
  | { kind: 'listed'; issues: IssueUpdate[]; isComplete: boolean }
  | { kind: 'needs-search' }
  | { kind: 'failed'; reason: string }
  | { kind: 'rate-limited'; waitMs: number };
type ListingOutcome = { ok: true; payloads: IssuesListingPayload[] } | { ok: false; reason: string; retryAfterMs?: number };
interface CachedPage { etag: string; issues: IssueUpdate[]; nextPath: string | null }
interface CachedPullRequests { updatedAt: string; pullRequests: IssuePullRequest[] }

function hasPendingPullRequest(pullRequests: readonly IssuePullRequest[]): boolean {
  return pullRequests.some((pullRequest) => pullRequest.state === 'open' || pullRequest.state === 'draft');
}

function createIssuesListing({ store, now }: { store: IssuesStore; now: () => number }) {
  const pagesByPath = new Map<string, CachedPage>();
  const pullRequestsByIssueKey = new Map<string, CachedPullRequests>();
  let viewer: string | null = null;
  const searchedSourceKeys = new Set<string>();
  let listCount = 0;

  async function readPage(pagePath: string): Promise<CachedPage | Exclude<SourceListing, { kind: 'listed' }>> {
    const cachedPage = pagesByPath.get(pagePath);
    const response = await store.requestIssuePage(pagePath, cachedPage?.etag ?? null, 'no-wait');
    if (response.isRateLimited) return { kind: 'rate-limited', waitMs: response.waitMs };
    const page = response.value;
    if (page.kind === 'unchanged' && cachedPage) return cachedPage;
    if (page.kind === 'error') return { kind: 'failed', reason: page.message };
    if (page.kind !== 'ok') return { kind: 'failed', reason: `GitHub answered an unasked-for 304 for ${pagePath}` };
    const readPage = { etag: page.etag ?? '', issues: page.issues, nextPath: page.nextPath };
    if (page.etag) pagesByPath.set(pagePath, readPage);
    return readPage;
  }

  async function listPages(firstPath: string): Promise<SourceListing> {
    const issues: IssueUpdate[] = [];
    let pagePath: string | null = firstPath;
    for (let pageCount = 0; pagePath !== null && pageCount < MAX_LISTED_PAGES && issues.length < MAX_REPO_ISSUES; pageCount += 1) {
      const page = await readPage(pagePath);
      if ('kind' in page) return page;
      issues.push(...page.issues);
      pagePath = page.nextPath;
    }
    const isWindowFull = pagePath === null || issues.length >= MAX_REPO_ISSUES;
    if (!isWindowFull) return { kind: 'needs-search' };
    return { kind: 'listed', issues: issues.slice(0, MAX_REPO_ISSUES), isComplete: true };
  }

  async function searchSource(query: string, isCapAuthoritative: boolean): Promise<SourceListing> {
    const response = await store.requestIssueSearch(query, 'no-wait');
    if (response.isRateLimited) return { kind: 'rate-limited', waitMs: response.waitMs };
    const searched = response.value;
    if (!searched.ok) return { kind: 'failed', reason: searched.error || 'issue search failed' };
    const issues = searched.items.filter((issue) => issue.state === 'open');
    const isComplete = isCapAuthoritative || (searched.isComplete && issues.length <= MAX_REPO_ISSUES);
    return { kind: 'listed', issues: issues.slice(0, MAX_REPO_ISSUES), isComplete };
  }

  async function listOrSearch(sourceKey: string, firstPath: string, searchQuery: string, isCapAuthoritative: boolean): Promise<SourceListing> {
    if (!searchedSourceKeys.has(sourceKey)) {
      const listing = await listPages(firstPath);
      if (listing.kind !== 'needs-search') return listing;
      searchedSourceKeys.add(sourceKey);
    }
    return searchSource(searchQuery, isCapAuthoritative);
  }

  async function listSource(listed: ListedSource): Promise<SourceListing> {
    if (listed.source === 'project') {
      return listOrSearch(`project:${listed.repo.toLowerCase()}`, `repos/${listed.repo}/issues?state=open&sort=updated&direction=desc&per_page=${PAGE_SIZE}`, `repo:${listed.repo} is:issue is:open`, true);
    }
    if (listed.source === 'me') {
      return listOrSearch('me', `issues?filter=assigned&state=open&sort=updated&direction=desc&per_page=${PAGE_SIZE}`, 'is:issue is:open assignee:@me archived:false', false);
    }
    return searchSource(`is:issue is:open team:${listed.team} archived:false`, false);
  }

  async function refreshPullRequests(issues: readonly IssueUpdate[]): Promise<void> {
    const isPendingRecheck = listCount % PENDING_PULL_REQUEST_RECHECK_EVERY_LISTS === 0;
    const listedKeys = new Set(issues.map((issue) => issue.key.toLowerCase()));
    for (const issueKey of pullRequestsByIssueKey.keys()) {
      if (!listedKeys.has(issueKey)) pullRequestsByIssueKey.delete(issueKey);
    }
    const dueIssues = issues.filter((issue) => {
      const cached = pullRequestsByIssueKey.get(issue.key.toLowerCase());
      return !cached || cached.updatedAt !== issue.updatedAt || (isPendingRecheck && hasPendingPullRequest(cached.pullRequests));
    });
    if (dueIssues.length === 0) return;
    const response = await store.requestIssueLinkedPullRequests(dueIssues.map((issue) => issue.key), 'no-wait');
    if (response.isRateLimited) return;
    for (const issue of dueIssues) {
      const pullRequests = response.value.get(issue.key);
      if (pullRequests) pullRequestsByIssueKey.set(issue.key.toLowerCase(), { updatedAt: issue.updatedAt, pullRequests });
    }
  }

  function listedIssue({ state: _state, ...issue }: IssueUpdate): ListedIssue {
    const cached = pullRequestsByIssueKey.get(issue.key.toLowerCase());
    return cached ? { ...issue, pullRequests: cached.pullRequests } : issue;
  }

  async function list(settings: IssuesWatcheeSettings): Promise<ListingOutcome> {
    const viewerRead = viewer === null ? await store.requestViewer('no-wait') : { isRateLimited: false as const, value: viewer };
    if (viewerRead.isRateLimited) return { ok: false, reason: 'GitHub rate limit', retryAfterMs: viewerRead.waitMs };
    viewer = viewerRead.value;
    if (viewer === null) return { ok: false, reason: 'gh is not signed in' };
    const listedViewer = viewer;
    const sources: ListedSource[] = [
      ...settings.projectRepos.map((repo) => ({ source: 'project' as const, repo })),
      { source: 'me' },
      ...settings.teams.map((team) => ({ source: 'team' as const, team })),
    ];
    const listings: { listed: ListedSource; issues: IssueUpdate[]; isComplete: boolean; error: string | null }[] = [];
    for (const listed of sources) {
      const listing = await listSource(listed);
      if (listing.kind === 'rate-limited') return { ok: false, reason: 'GitHub rate limit', retryAfterMs: listing.waitMs };
      if (listing.kind === 'failed') listings.push({ listed, issues: [], isComplete: false, error: listing.reason });
      if (listing.kind === 'listed') listings.push({ listed, issues: listing.issues, isComplete: listing.isComplete, error: null });
    }
    listCount += 1;
    await refreshPullRequests(listings.flatMap((listing) => listing.issues));
    const observedAt = new Date(now()).toISOString();
    return {
      ok: true,
      payloads: listings.map(({ listed, issues, isComplete, error }) => ({ ...listed, observedAt, viewer: listedViewer, isComplete, error, issues: issues.map(listedIssue) })),
    };
  }

  return { list };
}

export { createIssuesListing };
