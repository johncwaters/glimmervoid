import { runGit } from '../git/git-exec.ts';
import { githubRepoSlugFromRemote } from './core/team-review-core.ts';
import { githubStoreRateLimitedError } from './github-store-poller.ts';
import type { GithubLaneStore } from './github-store-wiring.ts';
import type { GithubIssue } from '../../shared/contracts/github-issue.ts';

type GithubIssueRead = { ok: true; repo: string; issue: GithubIssue } | { ok: false; error: string };
type ReadGithubIssue = (folderPath: string, issueNumber: number) => Promise<GithubIssueRead>;

function createGithubIssueReader(store: Pick<GithubLaneStore, 'requestIssueView'>): ReadGithubIssue {
  return async (folderPath, issueNumber) => {
    const remote = await runGit(['remote', 'get-url', 'origin'], { cwd: folderPath });
    const repo = remote.ok ? githubRepoSlugFromRemote(remote.out) : null;
    if (repo === null) return { ok: false, error: `${folderPath} has no GitHub origin, so it has no issues to start from` };
    const issueRead = await store.requestIssueView(repo, issueNumber, 'priority');
    if (issueRead.isRateLimited) return { ok: false, error: githubStoreRateLimitedError(issueRead.waitMs, `issue #${issueNumber}`) };
    const issue = issueRead.value;
    if (issue === null) return { ok: false, error: `Could not read issue #${issueNumber} in ${repo} with gh: it does not exist, or gh is not signed in or cannot reach GitHub` };
    if (issue.url.includes('/pull/')) return { ok: false, error: `#${issueNumber} in ${repo} is a pull request, not an issue` };
    return { ok: true, repo, issue };
  };
}

export { createGithubIssueReader };
export type { ReadGithubIssue };
