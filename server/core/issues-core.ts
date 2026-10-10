import { IssuesStatus } from '../../shared/contracts/issues.ts';
import type { CachedIssueRow, IssueSource, IssuesFetchResult, IssuesState, IssuesStatus as IssuesStatusType } from '../../shared/contracts/issues.ts';
import { githubRepoSlugFromRemote } from './team-review-core.ts';

export const ISSUES_LANE_ID = 'issues';
export const ISSUES_STATE_FILENAME = 'issues-cache.json';
export const POLL_INTERVAL_MINUTES = 5;
export const MAX_REPO_ISSUES = 300;
export const MAX_TOTAL_ISSUES = 1000;

export interface IssuesProjectRepo { repo: string; projectId: string }
export interface IssuesProjectConfig { id?: string; path: string; repos?: readonly string[] }
export interface IssuesSourceBatch {
  source: IssueSource;
  repo?: string;
  team?: string;
  isIncremental?: boolean;
  fetched: IssuesFetchResult;
}

export function emptyIssuesState(): IssuesState {
  return { issues: [], lastSyncAt: null, perRepoSync: {}, sessionLinks: {}, pullRequestsFetchedAt: {} };
}

export function issuesSettingsGate(projects: readonly IssuesProjectRepo[], teams: readonly string[], viewer: string | null) {
  if (projects.length > 0 || teams.length > 0 || viewer) return { configured: true, reason: null };
  return { configured: false, reason: 'No GitHub sources available. Configure a GitHub project or team, or sign in with gh.' };
}

export function issuesCachedSourcesGate(cachedIssues: readonly CachedIssueRow[], teams: readonly string[]) {
  return { configured: cachedIssues.length > 0 || teams.length > 0, reason: null };
}

export function issuesRepoPaths(project: IssuesProjectConfig): string[] {
  return project.repos?.length ? [...project.repos] : [project.path];
}

export function resolveIssuesProjects(projects: readonly IssuesProjectConfig[], originUrlByRepoPath: ReadonlyMap<string, string | null>, cachedIssues: readonly CachedIssueRow[]): IssuesProjectRepo[] {
  const projectsByRepo = new Map<string, IssuesProjectRepo>();
  const addRepo = (repo: string, projectId: string) => {
    const key = repo.toLowerCase();
    if (!projectsByRepo.has(key)) projectsByRepo.set(key, { repo, projectId });
  };
  for (const project of projects) {
    const projectId = project.id;
    if (!projectId) continue;
    for (const repoPath of issuesRepoPaths(project)) {
      const origin = originUrlByRepoPath.get(repoPath) ?? null;
      const repo = origin ? githubRepoSlugFromRemote(origin) : null;
      if (repo) {
        addRepo(repo, projectId);
        continue;
      }
      if (origin !== null) continue;
      for (const cached of cachedIssues) {
        if (cached.projectId === projectId) addRepo(cached.repo, projectId);
      }
    }
  }
  return [...projectsByRepo.values()];
}

function matchesSource(issue: CachedIssueRow, batch: IssuesSourceBatch): boolean {
  if (batch.source === 'team') return issue.teams.includes(batch.team ?? '');
  if (batch.source === 'project') return issue.repo.toLowerCase() === batch.repo?.toLowerCase() && issue.sources.includes('project');
  return issue.sources.includes('me');
}

export function mergeIssues(previous: readonly CachedIssueRow[], batches: readonly IssuesSourceBatch[], projects: readonly IssuesProjectRepo[], activeTeams?: readonly string[]): CachedIssueRow[] {
  const projectByRepo = new Map(projects.map((project) => [project.repo.toLowerCase(), project]));
  const issuesByKey = new Map<string, CachedIssueRow>();
  for (const issue of previous) {
    const project = projectByRepo.get(issue.repo.toLowerCase());
    const teams = issue.teams.filter((team) => activeTeams === undefined || activeTeams.includes(team));
    const sources = issue.sources.filter((source) => (source !== 'project' || project !== undefined) && (source !== 'team' || teams.length > 0));
    if (sources.length === 0) continue;
    issuesByKey.set(issue.key.toLowerCase(), { ...issue, sources, teams, projectId: project?.projectId ?? null });
  }
  const closedKeys = new Set<string>();
  for (const batch of batches) {
    if (!batch.fetched.ok) continue;
    if (batch.fetched.isComplete && !batch.isIncremental) {
      for (const [key, issue] of issuesByKey) {
        if (!matchesSource(issue, batch)) continue;
        const teams = issue.teams.filter((team) => team !== batch.team);
        const sources = issue.sources.filter((source) => source !== batch.source || (source === 'team' && teams.length > 0));
        issuesByKey.set(key, { ...issue, sources, teams });
      }
    }
    for (const update of batch.fetched.items) {
      const key = update.key.toLowerCase();
      if (update.state === 'closed') {
        closedKeys.add(key);
        issuesByKey.delete(key);
        continue;
      }
      const existing = issuesByKey.get(key);
      const project = projectByRepo.get(update.repo.toLowerCase());
      const sources = new Set(existing?.sources ?? []);
      sources.add(batch.source);
      if (project) sources.add('project');
      const teams = new Set(existing?.teams ?? []);
      if (batch.team) teams.add(batch.team);
      const { state: _state, ...fields } = update;
      const newest = existing && Date.parse(existing.updatedAt) > Date.parse(update.updatedAt) ? existing : fields;
      issuesByKey.set(key, { ...newest, sources: [...sources], teams: [...teams], projectId: project?.projectId ?? null, pullRequests: existing?.pullRequests ?? [] });
    }
  }
  const repoCounts = new Map<string, number>();
  return [...issuesByKey.values()]
    .filter((issue) => issue.sources.length > 0 && !closedKeys.has(issue.key.toLowerCase()))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.key.localeCompare(right.key))
    .filter((issue) => {
      if (issue.sources.some((source) => source !== 'project')) return true;
      const repo = issue.repo.toLowerCase();
      const count = repoCounts.get(repo) ?? 0;
      repoCounts.set(repo, count + 1);
      return count < MAX_REPO_ISSUES;
    }).slice(0, MAX_TOTAL_ISSUES);
}

export function pruneIssueSessionLinks(sessionLinks: Readonly<Record<string, string>>, sessionIds: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(sessionLinks).filter(([, sessionId]) => sessionIds.has(sessionId)).map(([issueKey, sessionId]) => [issueKey.toLowerCase(), sessionId]));
}

export function issuesStatus({ ts, configured, reason = null, issues = [], lastSyncAt = null, sessionLinks = {}, ...polling }: Omit<IssuesStatusType, 'type' | 'reason' | 'issues' | 'lastSyncAt'> & { reason?: string | null; issues?: readonly CachedIssueRow[]; lastSyncAt?: number | null; sessionLinks?: Readonly<Record<string, string>> }): IssuesStatusType {
  const rows = issues.map((issue) => ({ ...issue, sessionId: sessionLinks[issue.key.toLowerCase()] ?? null }));
  return IssuesStatus.parse({ type: 'issues-status', ts, configured, reason, issues: rows, lastSyncAt, ...polling });
}
