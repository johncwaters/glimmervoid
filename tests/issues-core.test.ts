import test from 'node:test';
import assert from 'node:assert/strict';
import type { IssueRow, IssueUpdate, IssuesFetchResult } from '../shared/contracts/issues.ts';
import { issuesSettingsGate, mergeIssues, resolveIssuesProjects } from '../server/core/issues-core.ts';

const update = (number = 1, repo = 'acme/app'): IssueUpdate => ({
  key: `${repo}#${number}`, repo, number, title: 'Fix reconnect', url: `https://github.com/${repo}/issues/${number}`,
  labels: ['bug'], assignees: ['alice'], author: 'bob', comments: 2, createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z', state: 'open',
});
const fetched = (items: IssueUpdate[], isComplete = true): IssuesFetchResult => ({ ok: true, items, isComplete, error: '' });
const projects = [{ repo: 'acme/app', projectId: 'project-1' }];

function row(sources: IssueRow['sources'], teams: string[] = []): IssueRow {
  const { state: _state, ...fields } = update();
  return { ...fields, sources, teams, projectId: sources.includes('project') ? 'project-1' : null };
}

test('mergeIssues deduplicates every source and team and attaches configured projects to searched issues', () => {
  const issues = mergeIssues([], [
    { source: 'project', repo: 'acme/app', fetched: fetched([update()]) },
    { source: 'me', fetched: fetched([update()]) },
    { source: 'team', team: 'acme/core', fetched: fetched([update()]) },
    { source: 'team', team: 'acme/docs', fetched: fetched([update()]) },
  ], projects);
  assert.deepEqual(issues, [row(['project', 'me', 'team'], ['acme/core', 'acme/docs'])]);
  assert.deepEqual(mergeIssues([], [{ source: 'me', fetched: fetched([update()]) }], projects), [row(['me', 'project'])]);
});

test('incremental issues remove closed rows and update open rows without losing unchanged issues', () => {
  const previous = mergeIssues([], [{ source: 'project', repo: 'acme/app', fetched: fetched([update(1), update(2)]) }], projects);
  const changed = { ...update(2), title: 'Edited title', updatedAt: '2026-10-10T01:00:00Z' };
  assert.deepEqual(mergeIssues(previous, [{ source: 'project', repo: 'acme/app', isIncremental: true, fetched: fetched([{ ...update(), state: 'closed' }, changed, update(3)]) }], projects).map((issue) => [issue.number, issue.title]), [[2, 'Edited title'], [3, 'Fix reconnect']]);
});

test('failed and incomplete sources retain their rows while complete sources remove their own memberships', () => {
  const previous = [row(['me', 'team'], ['acme/core', 'acme/docs'])];
  const failure: IssuesFetchResult = { ok: false, items: [], isComplete: false, error: 'offline' };
  const batches = [
    { source: 'me' as const, fetched: fetched([]) },
    { source: 'team' as const, team: 'acme/core', fetched: failure },
    { source: 'team' as const, team: 'acme/docs', fetched: fetched([], false) },
  ];
  assert.deepEqual(mergeIssues(previous, batches, []), [row(['team'], ['acme/core', 'acme/docs'])]);
  assert.deepEqual(mergeIssues(previous, [{ source: 'team', team: 'acme/core', fetched: fetched([]) }], [], ['acme/core']), [row(['me'])]);
});

test('issues are sorted and bounded across repositories and removed projects lose their session target', () => {
  const updates = Array.from({ length: 1204 }, (_, index) => update(index + 1, `acme/repo${Math.floor(index / 301)}`));
  updates[0].updatedAt = '2026-10-10T00:00:00.500Z';
  const repos = ['acme/repo0', 'acme/repo1', 'acme/repo2', 'acme/repo3'];
  const repoProjects = repos.map((repo, index) => ({ repo, projectId: `project-${index}` }));
  const batches = repos.map((repo) => ({ source: 'project' as const, repo, fetched: fetched(updates.filter((issue) => issue.repo === repo)) }));
  const issues = mergeIssues([], batches, repoProjects);
  assert.equal(issues.length, 1000);
  assert.equal(issues[0].key, 'acme/repo0#1');
  assert.ok(repos.every((repo) => issues.filter((issue) => issue.repo === repo).length <= 300));
  assert.deepEqual(mergeIssues([row(['project', 'me'])], [], []), [row(['me'])]);
});

test('issues configuration accepts a resolved project, team or viewer', () => {
  assert.equal(issuesSettingsGate(projects, [], null).configured, true);
  assert.equal(issuesSettingsGate([], ['acme/core'], null).configured, true);
  assert.equal(issuesSettingsGate([], [], 'alice').configured, true);
  assert.equal(issuesSettingsGate([], [], null).configured, false);
  assert.ok(issuesSettingsGate([], [], null).reason);
});

test('an old team or assigned issue in a busy project repository survives the per-repository cap', () => {
  const newestProjectIssues = Array.from({ length: 300 }, (_, index) => ({ ...update(index + 1), updatedAt: '2026-10-10T00:00:00Z' }));
  const oldTeamIssue = { ...update(9001), updatedAt: '2025-01-01T00:00:00Z' };
  const oldAssignedIssue = { ...update(9002), updatedAt: '2025-01-01T00:00:00Z' };
  const issues = mergeIssues([], [
    { source: 'project', repo: 'acme/app', fetched: fetched(newestProjectIssues) },
    { source: 'me', fetched: fetched([oldAssignedIssue]) },
    { source: 'team', team: 'acme/core', fetched: fetched([oldTeamIssue]) },
  ], projects, ['acme/core']);
  assert.equal(issues.length, 302);
  assert.equal(mergeIssues([], [{ source: 'me', fetched: fetched(Array.from({ length: 1204 }, (_, index) => update(index + 1))) }], []).length, 1000);
  assert.ok(issues.some((issue) => issue.number === 9001));
  assert.ok(issues.some((issue) => issue.number === 9002));
});

test('resolveIssuesProjects maps workspace members once, drops non-GitHub remotes and reuses cached rows only for a missing origin', () => {
  const originUrlByRepoPath = new Map<string, string | null>([
    ['/repo/app', 'git@github.com:Acme/App.git'],
    ['/repo/docs', 'https://github.com/acme/docs'],
    ['/repo/mirror', 'https://gitlab.com/acme/mirror.git'],
    ['/repo/offline', null],
    ['/repo/app-clone', 'https://github.com/acme/app.git'],
  ]);
  const cachedOffline: IssueRow = { ...row(['project']), key: 'acme/offline#1', repo: 'acme/offline', url: 'https://github.com/acme/offline/issues/1', projectId: 'project-3' };
  const cachedMirror: IssueRow = { ...cachedOffline, key: 'acme/mirror#1', repo: 'acme/mirror', projectId: 'project-2' };
  const resolved = resolveIssuesProjects([
    { id: 'project-1', path: '/repo/workspace', repos: ['/repo/app', '/repo/docs'] },
    { id: 'project-2', path: '/repo/mirror' },
    { id: 'project-3', path: '/repo/offline' },
    { id: 'project-4', path: '/repo/app-clone' },
    { path: '/repo/app' },
  ], originUrlByRepoPath, [cachedOffline, cachedMirror]);
  assert.deepEqual(resolved, [
    { repo: 'Acme/App', projectId: 'project-1' },
    { repo: 'acme/docs', projectId: 'project-1' },
    { repo: 'acme/offline', projectId: 'project-3' },
  ]);
});
