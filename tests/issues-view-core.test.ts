import test from 'node:test';
import assert from 'node:assert/strict';

import type { IssueLabel, IssueRow } from '../public/issues-view-core.ts';
import { issuesPlaceholder, summarizeIssues } from '../public/issues-view-core.ts';

const issueWithLabels = (number: number, labels: IssueLabel[]): IssueRow => ({ number, title: 'Issue', labels, url: '', updatedAt: '' });

test('summarizeIssues counts the labeled issues among the open ones', () => {
  assert.deepEqual(summarizeIssues([
    issueWithLabels(1, [{ name: 'bug', color: '' }]),
    issueWithLabels(2, []),
    issueWithLabels(3, []),
  ]), { open: 3, labeled: 1 });
});

test('issuesPlaceholder asks for a refresh instead of waiting on a poll', () => {
  assert.equal(issuesPlaceholder({ hasProjects: true }), 'Press Refresh to load open issues.');
  assert.equal(issuesPlaceholder({ hasProjects: false }), 'No projects configured. Add a project in Settings.');
});
