import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubPr, GithubPrDetailNode } from '../shared/contracts/github-prs.ts';
import type { MyPrThreadNode } from '../shared/contracts/my-prs.ts';
import { normalizeGithubPr } from '../server/github/core/github-store-core.ts';
import { myPrFromGithubPr } from '../shared/my-pr-merge.ts';

function openPr(): GithubPrDetailNode {
  return GithubPrDetailNode.parse({
    __typename: 'PullRequest', id: 'PR_1', number: 1, title: 'PR 1', url: 'https://github.com/acme/app/pull/1',
    repository: { nameWithOwner: 'acme/app', viewerDefaultMergeMethod: 'SQUASH' },
    author: { login: 'operator' }, labels: { nodes: [] }, comments: { totalCount: 0 },
    isDraft: false, state: 'OPEN', createdAt: '', mergedAt: null, updatedAt: '',
    baseRefName: 'main', baseRefOid: 'a'.repeat(40), headRefName: 'feature-1', isCrossRepository: false, headRefOid: 'b'.repeat(40),
    isInMergeQueue: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false }] },
    reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
  });
}

function threadNode(id: string, path: string, line: number | null, author: string, bodyText: string, isResolved = false): MyPrThreadNode {
  const comment = { author: { login: author }, bodyText, url: `https://github.com/acme/app/pull/1#${id}`, createdAt: '2026-11-01T00:00:00Z' };
  return { id, isResolved, isOutdated: false, path, line, firstComment: { totalCount: 1, nodes: [comment] }, lastComment: { nodes: [comment] } };
}

test('a store PR reaches My PRs with unresolved threads merged by path and nearby lines, unlined ones by body prefix', () => {
  const storePr = GithubPr.parse(normalizeGithubPr(openPr(), 0, [
    threadNode('t1', 'src/a.ts', 10, 'greptile[bot]', 'Null name writes undefined'),
    threadNode('t2', 'src/a.ts', 13, 'copilot[bot]', 'Guard the name'),
    threadNode('t3', 'src/a.ts', 30, 'copilot[bot]', 'Unrelated'),
    threadNode('t4', 'src/b.ts', 10, 'greptile[bot]', 'Other file'),
    threadNode('t5', 'docs/x.md', null, 'a', 'Typo  in Title'),
    threadNode('t6', 'docs/x.md', null, 'b', 'typo in title'),
    threadNode('t7', 'src/a.ts', 11, 'c', 'Already handled', true),
  ]));
  const items = myPrFromGithubPr(storePr).reviewItems;
  assert.deepEqual(items.map((item) => [item.path, item.lineStart, item.lineEnd, item.sources.map((source) => source.threadId)]), [
    ['docs/x.md', null, null, ['t5', 't6']],
    ['src/a.ts', 10, 13, ['t1', 't2']],
    ['src/a.ts', 30, 30, ['t3']],
    ['src/b.ts', 10, 10, ['t4']],
  ]);
  assert.ok(items.every((item) => item.priority === 'unknown'));
});
