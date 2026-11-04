import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubPr, GithubPrDetailNode } from '../shared/contracts/github-prs.ts';
import type { MyPrThreadNode } from '../shared/contracts/my-prs.ts';
import { normalizeGithubPr } from '../server/github/core/github-store-core.ts';
import { myPrFromGithubPr } from '../shared/my-pr-merge.ts';
import type { PrFlowsStatus } from '../shared/contracts/pr-flows.ts';
import { createPrFlowsWiring } from '../server/github/pr-flows-wiring.ts';
import { threadRows } from '../public/github/my-prs-view-core.ts';

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

test('dismissing an item replies and resolves each of its threads once, and the dismissal hides it after a push until a comment changes or a new one joins it', async () => {
  let threads = [threadNode('PRRT_1', 'src/a.ts', 10, 'greptile[bot]', 'Null name writes undefined'), threadNode('PRRT_2', 'src/a.ts', 12, 'copilot[bot]', 'Guard the name')];
  const myPr = () => myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(openPr(), 0, threads)));
  const githubCalls: string[] = [];
  let failNextResolve = true;
  const frames: PrFlowsStatus[] = [];
  const prFlows = createPrFlowsWiring({
    statePath: null, openPrs: () => [myPr()], broadcast: (frame) => frames.push(frame), log: console,
    github: {
      replyToReviewThread: async (threadId, body) => { githubCalls.push(`reply ${threadId} ${body}`); return { ok: true, err: '' }; },
      resolveReviewThread: async (threadId) => {
        githubCalls.push(`resolve ${threadId}`);
        if (threadId === 'PRRT_2' && failNextResolve) {
          failNextResolve = false;
          return { ok: false, err: 'HTTP 502' };
        }
        return { ok: true, err: '' };
      },
    },
  });
  const [item] = myPr().reviewItems;
  assert.ok(item);
  const dismissal = { prKey: 'acme/app#1', itemKey: item.key, action: 'dismiss', reason: 'Names are validated upstream' } as const;
  assert.deepEqual(await prFlows.dispose(dismissal, null), { ok: false, error: 'Replied, but could not resolve the thread: HTTP 502' });
  assert.deepEqual(await prFlows.dispose(dismissal, null), { ok: true });
  assert.deepEqual(githubCalls, ['reply PRRT_1 Names are validated upstream', 'resolve PRRT_1', 'reply PRRT_2 Names are validated upstream', 'resolve PRRT_2', 'resolve PRRT_2']);
  const handled = frames.at(-1)?.handledByPr['acme/app#1'] ?? [];
  threads = [threadNode('PRRT_9', 'src/a.ts', 14, 'greptile[bot]', 'Null name writes undefined')];
  assert.deepEqual(threadRows(myPr(), 'operator', handled), []);
  threads = [threadNode('PRRT_9', 'src/a.ts', 14, 'greptile[bot]', 'Null name writes undefined'), threadNode('PRRT_10', 'src/a.ts', 15, 'alice', 'This also leaks the token')];
  assert.equal(threadRows(myPr(), 'operator', handled).length, 1);
  threads = [threadNode('PRRT_9', 'src/a.ts', 14, 'greptile[bot]', 'Null name now crashes the export')];
  assert.equal(threadRows(myPr(), 'operator', handled).length, 1);
  assert.deepEqual(await prFlows.dispose({ prKey: 'acme/app#1', itemKey: myPr().reviewItems[0]?.key ?? '', action: 'fix-local' }, null), { ok: false, error: 'No live session is linked to this pull request.' });
});
