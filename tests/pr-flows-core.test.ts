import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubPr, GithubPrDetailNode } from '../shared/contracts/github-prs.ts';
import type { MyPrThreadNode } from '../shared/contracts/my-prs.ts';
import { normalizeGithubPr } from '../server/github/core/github-store-core.ts';
import { myPrFromGithubPr } from '../shared/my-pr-merge.ts';
import type { PrFlowsStatus } from '../shared/contracts/pr-flows.ts';
import { createPrFlowsWiring } from '../server/github/pr-flows-wiring.ts';
import { prFlowRules, teammateThreadItems } from '../server/github/core/pr-flows-core.ts';
import { draftsNewestFirst } from '../server/github/core/team-review-core.ts';
import { ReviewDraft, TeamReviewThreadNode } from '../shared/contracts/team-review.ts';
import { isIncludedByDefault, otherReviewRows } from '../public/github/team-review-view-core.ts';
import { DEFAULT_CONFIG, validateConfig } from '../server/config-store.ts';
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
    linkedSession: () => null, readConfigFile: async () => ({}), appendRule: async () => true,
    github: {
      unresolveReviewThread: async () => ({ ok: true, err: '' }),
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
  assert.deepEqual(await prFlows.dispose(dismissal), { ok: false, error: 'Replied, but could not resolve the thread: HTTP 502' });
  assert.deepEqual(await prFlows.dispose(dismissal), { ok: true });
  assert.deepEqual(githubCalls, ['reply PRRT_1 Names are validated upstream', 'resolve PRRT_1', 'reply PRRT_2 Names are validated upstream', 'resolve PRRT_2', 'resolve PRRT_2']);
  const handled = frames.at(-1)?.handledByPr['acme/app#1'] ?? [];
  threads = [threadNode('PRRT_9', 'src/a.ts', 14, 'greptile[bot]', 'Null name writes undefined')];
  assert.deepEqual(threadRows(myPr(), 'operator', handled), []);
  threads = [threadNode('PRRT_9', 'src/a.ts', 14, 'greptile[bot]', 'Null name writes undefined'), threadNode('PRRT_10', 'src/a.ts', 15, 'alice', 'This also leaks the token')];
  assert.equal(threadRows(myPr(), 'operator', handled).length, 1);
  threads = [threadNode('PRRT_9', 'src/a.ts', 14, 'greptile[bot]', 'Null name now crashes the export')];
  assert.equal(threadRows(myPr(), 'operator', handled).length, 1);
  assert.deepEqual(await prFlows.dispose({ prKey: 'acme/app#1', itemKey: myPr().reviewItems[0]?.key ?? '', action: 'fix-local' }), { ok: false, error: 'No live session is linked to this pull request.' });
});

test('a matching rule dismisses an item on the next poll and records it, Undo reopens its thread for good, and Save as rule appends a rule', async () => {
  let threads = [threadNode('PRRT_1', 'dist/app.js', 3, 'copilot[bot]', 'Minified line is long'), threadNode('PRRT_2', 'src/a.ts', 10, 'alice', 'Rename this')];
  const myPr = () => myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(openPr(), 0, threads)));
  const githubCalls: string[] = [];
  const savedRules: unknown[] = [];
  const frames: PrFlowsStatus[] = [];
  const configFile = { prFlows: {
    repoRules: { 'acme/app': [{ name: 'generated', paths: ['dist/'], action: 'dismiss', reason: 'Generated output' }] },
    rules: [{ name: 'broken', action: 'dismiss' }, { name: 'resolve bots', source: 'alice', action: 'run:resolve' }],
  } };
  const prFlows = createPrFlowsWiring({
    statePath: null, openPrs: () => [myPr()], broadcast: (frame) => frames.push(frame), log: console,
    linkedSession: () => null, readConfigFile: async () => configFile, appendRule: async (rule) => { savedRules.push(rule); return true; },
    github: {
      replyToReviewThread: async (threadId, body) => { githubCalls.push(`reply ${threadId} ${body}`); return { ok: true, err: '' }; },
      resolveReviewThread: async (threadId) => { githubCalls.push(`resolve ${threadId}`); return { ok: true, err: '' }; },
      unresolveReviewThread: async (threadId) => { githubCalls.push(`unresolve ${threadId}`); return { ok: true, err: '' }; },
    },
  });
  await prFlows.applyRules();
  assert.deepEqual(githubCalls, ['reply PRRT_1 Generated output', 'resolve PRRT_1']);
  const status = frames.at(-1);
  assert.deepEqual(status?.handledByPr['acme/app#1']?.map((entry) => [entry.ruleName, entry.location]), [['generated', 'dist/app.js:3']]);
  assert.deepEqual(status?.warnings, [
    "prFlows.rules[0] was skipped: a dismiss rule needs a reason",
    "Rule 'resolve bots' names run:resolve, which no entry in prFlows.actions defines, so its items wait for you.",
  ]);
  const handledItemKey = status?.handledByPr['acme/app#1']?.[0]?.itemKey ?? '';
  assert.deepEqual(await prFlows.undo({ prKey: 'acme/app#1', itemKey: handledItemKey }), { ok: true });
  await prFlows.applyRules();
  assert.deepEqual(githubCalls, ['reply PRRT_1 Generated output', 'resolve PRRT_1', 'unresolve PRRT_1']);
  assert.equal(threadRows(myPr(), 'operator', frames.at(-1)?.handledByPr['acme/app#1'] ?? []).length, 2);
  threads = [...threads, threadNode('PRRT_3', 'dist/app.js', 4, 'bob', 'Also generated')];
  await prFlows.applyRules();
  assert.deepEqual(githubCalls, ['reply PRRT_1 Generated output', 'resolve PRRT_1', 'unresolve PRRT_1']);
  const aliceItem = myPr().reviewItems.find((item) => item.path === 'src/a.ts');
  assert.deepEqual(await prFlows.saveRule({ prKey: 'acme/app#1', itemKey: aliceItem?.key ?? '', reason: 'Names are settled' }), { ok: true });
  assert.deepEqual(savedRules, [{ name: 'Dismiss alice on src/a.ts', source: 'alice', paths: ['src/a.ts'], scope: 'mine', action: 'dismiss', reason: 'Names are settled' }]);
  threads = [threadNode('PRRT_4', 'frontend/src/scenes/session-recordings/player/inspector/PlayerInspectorList.tsx', 5, 'greptile-apps[bot]', 'Long path')];
  assert.deepEqual(await prFlows.saveRule({ prKey: 'acme/app#1', itemKey: myPr().reviewItems[0]?.key ?? '', reason: 'Fine' }), { ok: true });
  assert.equal(prFlowRules({ prFlows: { rules: savedRules.slice(1) } }, 'acme/app').rules.length, 1);
});

test('a malformed prFlows rule leaves config.json valid and shows as a warning instead', () => {
  const loneRule = { repoRules: { 'acme/app': { name: 'one', action: 'ask' } }, rules: [{ name: 'no action' }] };
  for (const prFlows of [null, loneRule, { rules: {} }]) assert.equal(validateConfig({ ...DEFAULT_CONFIG, prFlows }).ok, true);
  assert.equal(prFlowRules({ prFlows: loneRule }, 'acme/app').warnings.length, 2);
});

test('a fix-local rule pastes the comment without submitting it', async () => {
  const threads = [threadNode('PRRT_1', 'src/a.ts', 3, 'outsider', 'nit: run this')];
  const myPr = () => myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(openPr(), 0, threads)));
  const pastes: boolean[] = [];
  const session = { pasteTextWhenReady: (_text: string, options: { submit: boolean }) => { pastes.push(options.submit); return { ok: true }; }, hasPendingPaste: () => false };
  const prFlows = createPrFlowsWiring({
    statePath: null, openPrs: () => [myPr()], broadcast: () => {}, log: console,
    linkedSession: () => session, readConfigFile: async () => ({ prFlows: { rules: [{ name: 'nits', text: 'nit', action: 'fix-local' }] } }), appendRule: async () => true,
    github: { replyToReviewThread: async () => ({ ok: true, err: '' }), resolveReviewThread: async () => ({ ok: true, err: '' }), unresolveReviewThread: async () => ({ ok: true, err: '' }) },
  });
  await prFlows.applyRules();
  assert.deepEqual(pastes, [false]);
});

function teammateThread(id: string, line: number, login: string, extra: { isResolved?: boolean; viewerDidAuthor?: boolean; diffSide?: 'LEFT' | 'RIGHT' } = {}) {
  return TeamReviewThreadNode.parse({
    id, path: 'src/a.ts', line, diffSide: extra.diffSide ?? 'RIGHT', isResolved: extra.isResolved ?? false, viewerCanResolve: false,
    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { body: `${login} says line ${line} is wrong`, author: { login }, viewerDidAuthor: extra.viewerDidAuthor ?? false, createdAt: '2026-11-01T10:00:00Z', url: `https://github.com/acme/app/pull/7#discussion_${id}`, originalCommit: null },
    ] },
  });
}

test('on a teammate PR an own finding near a bot thread is marked already flagged and left out of the posting plan', () => {
  const otherReviewItems = teammateThreadItems([
    teammateThread('PRRT_bot', 10, 'greptile[bot]'),
    teammateThread('PRRT_mine', 30, 'operator', { viewerDidAuthor: true }),
    teammateThread('PRRT_done', 50, 'copilot[bot]', { isResolved: true }),
    teammateThread('PRRT_deleted', 29, 'coderabbitai[bot]', { diffSide: 'LEFT' }),
  ]);
  const draft = ReviewDraft.parse({
    key: 'acme/app#7', repo: 'acme/app', number: 7, title: 'PR 7', url: 'https://github.com/acme/app/pull/7', author: 'teammate', tier: 'full', reasons: [],
    reviewedHead: 'c'.repeat(40), verdict: 'COMMENT', summary: '', body: '', status: 'ready',
    comments: [
      { path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'Off by one', severity: 'HIGH' },
      { path: 'src/a.ts', line: 30, side: 'RIGHT', body: 'Unrelated', severity: 'HIGH' },
    ],
  });

  const [presented] = draftsNewestFirst({ 'acme/app#7': { draft, reviewedHead: draft.reviewedHead, inFlight: false, reviewAttempts: 1, updatedAt: 1, otherReviewItems } });
  assert.ok(presented);

  assert.deepEqual(otherReviewRows(presented).map((row) => `${row.location} ${row.reviewers}`), ['src/a.ts coderabbitai[bot]', 'src/a.ts:10 greptile[bot]']);
  assert.deepEqual(presented.comments.map((comment) => comment.flaggedBy ?? []), [['greptile[bot]'], []]);
  assert.deepEqual(presented.comments.map(isIncludedByDefault), [false, true]);
});
