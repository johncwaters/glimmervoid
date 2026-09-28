import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyStateText, factLines, groupMyPrs, chooseSelectedKey, parseMyPrsStatus, queueNotices, stageLabel, stageTone } from '../public/my-prs-view-core.ts';
import { toMyPr } from '../server/core/my-prs-core.ts';
import type { MyPr, MyPrSearchNode } from '../shared/contracts/my-prs.ts';

const node: MyPrSearchNode = {
  __typename: 'PullRequest', number: 1, title: 'Fix', url: 'https://github.com/Acme/app/pull/1', isDraft: false,
  state: 'OPEN', mergedAt: null, updatedAt: '2026-09-28T00:00:00Z', baseRefName: 'main', headRefOid: 'a'.repeat(40),
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app' },
  commits: { nodes: [] }, reviewThreads: { nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] },
};
const base = toMyPr(node, 0);
const pr = (stage: MyPr['stage'], number: number): MyPr => ({ ...base, stage, number, key: `Acme/app#${number}` });

test('groups every stage in fixed section order and preserves selection', () => {
  const sections = groupMyPrs([pr('merged', 5), pr('draft', 4), pr('ready', 3), pr('unknown', 2), pr('conflicts', 1)]);
  assert.deepEqual(sections.map((section) => [section.title, section.prs.map((item) => item.number)]), [
    ['Needs you', [1]], ['Waiting', [2]], ['Ready to merge', [3]], ['Drafts', [4]], ['Merged today', [5]],
  ]);
  assert.equal(chooseSelectedKey(sections, 'Acme/app#3'), 'Acme/app#3');
  assert.equal(chooseSelectedKey(sections, 'gone'), 'Acme/app#1');
});

test('labels, tones, facts and empty messages reflect status', () => {
  assert.equal(stageLabel('conflicts'), 'Merge conflicts');
  assert.equal(stageTone('conflicts'), 'danger');
  assert.deepEqual(factLines({ ...base, behindBy: 343, unresolvedThreads: 2, checks: { state: 'FAILURE', failing: ['a', 'b', 'c', 'd'], pendingCount: 3 }, reviewRequests: ['Acme/docs'], approvals: 1 }), [
    '343 behind main', '2 unresolved threads', 'Failing: a, b, c and 1 more', '3 checks running', 'Review requested: Acme/docs', '1 approval', 'No conflicts',
  ]);
  const status = parseMyPrsStatus({ type: 'my-prs-status', ts: 1, configured: true, viewer: 'alice', prs: [] });
  assert.ok(status);
  assert.match(emptyStateText(status), /No open/);
  assert.match(emptyStateText({ ...status, configured: false }), /Team review/);
  assert.match(emptyStateText({ ...status, error: 'offline' }), /offline/);
  assert.equal(parseMyPrsStatus({ type: 'my-prs-status', ts: 1, configured: true, viewer: null, prs: [{}] }), null);
});

test('queue notices list the refresh error before the truncation note', () => {
  const status = parseMyPrsStatus({ type: 'my-prs-status', ts: 1, configured: true, viewer: 'alice', prs: [base] });
  assert.ok(status);
  const truncatedNote = 'Showing the 50 most recently updated of 73 pull requests.';
  assert.deepEqual(queueNotices(null), []);
  assert.deepEqual(queueNotices(status), []);
  assert.deepEqual(queueNotices({ ...status, truncatedNote }), [{ text: truncatedNote, tone: 'info' }]);
  assert.deepEqual(queueNotices({ ...status, error: 'offline', truncatedNote }), [{ text: 'Could not refresh your pull requests: offline', tone: 'error' }, { text: truncatedNote, tone: 'info' }]);
});
