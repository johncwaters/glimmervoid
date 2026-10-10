import test from 'node:test';
import assert from 'node:assert/strict';
import type { IssueRow } from '../public/issues-view-core.ts';
import { issuesPlaceholder, summarizeIssues } from '../public/issues-view-core.ts';

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
