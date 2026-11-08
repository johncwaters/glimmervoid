import crypto from 'node:crypto';
import { githubApiOrigin } from '../../shared/contracts/watcher-link.ts';
import type { Probe } from '../../shared/contracts/watcher-link.ts';
import { ISSUES_LANE_ID } from './core/issues-core.ts';

interface IssuesProbeInputs {
  projectRepos: readonly string[];
  teams: readonly string[];
  viewerLogin: string | null;
}

const REPO_LISTING_EVERY_MS = 60_000;
const SEARCH_EVERY_MS = 120_000;

function probeIdFor(kind: 'repo' | 'search', subject: string): string {
  return `${ISSUES_LANE_ID}:${kind}:${crypto.createHash('sha256').update(subject.toLowerCase()).digest('hex').slice(0, 24)}`;
}

function getProbe(id: string, everyMs: number, url: URL): Probe {
  return { id, laneId: ISSUES_LANE_ID, everyMs, method: 'GET', url: url.toString(), body: null, credential: 'github' };
}

function repoListingProbe(repo: string): Probe {
  const url = new URL(`/repos/${repo}/issues`, githubApiOrigin(process.env));
  for (const [name, value] of [['state', 'all'], ['sort', 'updated'], ['direction', 'desc'], ['per_page', '1']]) url.searchParams.set(name, value);
  return getProbe(probeIdFor('repo', repo), REPO_LISTING_EVERY_MS, url);
}

function searchProbe(query: string): Probe {
  const url = new URL('/search/issues', githubApiOrigin(process.env));
  for (const [name, value] of [['q', query], ['sort', 'updated'], ['order', 'desc'], ['per_page', '1']]) url.searchParams.set(name, value);
  return getProbe(probeIdFor('search', query), SEARCH_EVERY_MS, url);
}

function issuesProbes({ projectRepos, teams, viewerLogin }: IssuesProbeInputs): Probe[] {
  const uniqueRepos = [...new Map(projectRepos.map((repo) => [repo.toLowerCase(), repo])).values()];
  const searchQueries = [
    ...(viewerLogin === null ? [] : [`is:issue is:open assignee:${viewerLogin} archived:false`]),
    ...teams.map((team) => `is:issue is:open team:${team} archived:false`),
  ];
  return [...uniqueRepos.map(repoListingProbe), ...searchQueries.map(searchProbe)];
}

export { issuesProbes };
export type { IssuesProbeInputs };
