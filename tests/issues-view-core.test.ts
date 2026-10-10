import test from 'node:test';
import assert from 'node:assert/strict';
import type { IssueFilters, IssueRow } from '../public/issues-view-core.ts';
import { filterIssues, groupIssuesByRepo, issueFilterOptions, issueFilterSummary, issueAgo, issueRelativeAge, issueScopeCounts, matchesIssueScope, issuesPlaceholder, summarizeIssues } from '../public/issues-view-core.ts';

const issueWithLabels = (number: number, labels: string[]): IssueRow => ({
  key: `acme/app#${number}`, repo: 'acme/app', number, title: 'Issue', labels,
  url: `https://github.com/acme/app/issues/${number}`, updatedAt: '2026-10-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z',
  author: 'alice', assignees: [], comments: 0, sessionId: null, pullRequests: [], sources: ['project'], teams: [], projectId: 'project',
});

test('summarizeIssues counts the labeled issues among the open ones', () => {
  assert.deepEqual(summarizeIssues([
    issueWithLabels(1, ['bug']), issueWithLabels(2, []), issueWithLabels(3, []),
  ]), { open: 3, labeled: 1 });
});

test('issuesPlaceholder waits for status and displays the server configuration reason', () => {
  assert.equal(issuesPlaceholder(null), 'Loading issues.');
  assert.equal(issuesPlaceholder({ configured: false, reason: null }), 'Loading issues.');
  assert.equal(issuesPlaceholder({ configured: false, reason: 'Sign in with gh.' }), 'Sign in with gh.');
  assert.equal(issuesPlaceholder({ configured: true, reason: null }), 'No open issues.');
});

test('scope counts overlap and remain independent of queue filters', () => {
  const issues: IssueRow[] = [
    { ...issueWithLabels(1, ['bug']), sources: ['project', 'me', 'team'] },
    { ...issueWithLabels(2, []), sources: ['team'] },
  ];
  assert.deepEqual(issueScopeCounts(issues), { all: 2, me: 1, team: 2, project: 1 });
  assert.equal(matchesIssueScope(issues[0], 'me'), true);
  assert.equal(matchesIssueScope(issues[1], 'project'), false);
});

const baseFilters: IssueFilters = { scope: 'all', repo: '', label: '', sort: 'updated', query: '', hasSession: false, hasPr: false, isUnassignedOnly: false };

test('issue filters intersect scope repo label search assignment and live session requirements', () => {
  const liveIssue = { ...issueWithLabels(1, ['bug']), title: 'Reconnect Socket', sessionId: 'live', sources: ['me', 'team'] as const, teams: ['acme/platform'], pullRequests: [{ number: 9, url: 'https://github.com/acme/app/pull/9', title: 'Fix', state: 'draft' as const }] };
  const issues: IssueRow[] = [{ ...liveIssue, sources: [...liveIssue.sources] }, { ...issueWithLabels(2, ['bug']), sessionId: 'gone', assignees: ['alice'] }, issueWithLabels(3, [])];
  const allFilters = { ...baseFilters, scope: 'me' as const, repo: 'acme/app', label: 'bug', query: 'SOCKET #1 platform', hasSession: true, hasPr: true, isUnassignedOnly: true };
  assert.deepEqual(filterIssues(issues, allFilters, new Set(['live'])).map((issue) => issue.number), [1]);
  assert.deepEqual(filterIssues(issues, { ...baseFilters, hasSession: true }, new Set()).map((issue) => issue.number), []);
  assert.deepEqual(filterIssues(issues, { ...baseFilters, query: 'alice bug' }, new Set()).map((issue) => issue.number), [1, 2]);
  assert.deepEqual(filterIssues(issues, { ...allFilters, label: 'enhancement' }, new Set(['live'])), []);
  assert.equal(issues.length, 3);
});

test('sorts issue activity before grouping repositories and deduplicates filter options', () => {
  const issues = [
    { ...issueWithLabels(1, ['bug', 'docs']), comments: 10, createdAt: '2026-09-01T00:00:00Z' },
    { ...issueWithLabels(2, ['bug']), updatedAt: '2026-10-03T00:00:00Z', comments: 1 },
    { ...issueWithLabels(3, []), repo: 'acme/other', key: 'acme/other#3', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', comments: 5 },
  ];
  const sorted = filterIssues(issues, baseFilters, new Set());
  assert.deepEqual(sorted.map((issue) => issue.number), [2, 3, 1]);
  assert.deepEqual([...groupIssuesByRepo(sorted)].map(([repo, rows]) => [repo, rows.map((issue) => issue.number)]), [['acme/app', [2, 1]], ['acme/other', [3]]]);
  assert.deepEqual(filterIssues(issues, { ...baseFilters, sort: 'created' }, new Set()).map((issue) => issue.number), [3, 2, 1]);
  assert.deepEqual(filterIssues(issues, { ...baseFilters, sort: 'comments' }, new Set()).map((issue) => issue.number), [1, 3, 2]);
  assert.deepEqual(issueFilterOptions(issues), { repos: ['acme/app', 'acme/other'], labels: ['bug', 'docs'] });
  assert.deepEqual(issues.map((issue) => issue.number), [1, 2, 3]);
});

test('filter summary exposes active constraints and relative ages handle future and invalid times', () => {
  assert.equal(issueFilterSummary(baseFilters), '');
  assert.equal(issueFilterSummary({ ...baseFilters, query: ' socket ', hasSession: true, hasPr: true, isUnassignedOnly: true }), 'Filtered by search "socket", has session, has PR, unassigned.');
  const nowMs = Date.parse('2026-10-10T12:00:00Z');
  assert.equal(issueRelativeAge('2026-10-10T11:54:00Z', nowMs), '6m');
  assert.equal(issueRelativeAge(nowMs - 3600000, nowMs), '1h');
  assert.equal(issueRelativeAge(nowMs - 172800000, nowMs), '2d');
  assert.equal(issueRelativeAge(nowMs + 60000, nowMs), 'now');
  assert.equal(issueRelativeAge('invalid', nowMs), 'unknown');
  assert.equal(issueAgo(nowMs, nowMs), 'just now');
  assert.equal(issueAgo(nowMs - 3600000, nowMs), '1h ago');
});
