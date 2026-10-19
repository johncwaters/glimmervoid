import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubStorePoller } from '../server/github/github-store-poller.ts';
import { createSerialQueue } from '../server/spawn-gate.ts';
import { comparablePrKey, GithubPrDetailNode, GithubPrLightSearchNode, GithubPrsFrame } from '../shared/contracts/github-prs.ts';
import type { MyPrThreadNode } from '../shared/contracts/my-prs.ts';
import type { PrGh } from '../server/github/pr-gh.ts';
import { manualTimers } from './helpers/manual-timers.ts';

const HEAD_SHA = 'a'.repeat(40);
const FIRST_TICK_AT = Date.parse('2026-10-19T12:00:00Z');

function detailNode(number: number, checksState: 'PENDING' | 'SUCCESS' = 'PENDING'): GithubPrDetailNode {
  return GithubPrDetailNode.parse({
    __typename: 'PullRequest', id: `PR_${number}`, number, title: 'Fix', url: `https://github.com/Acme/app/pull/${number}`,
    author: { login: 'alice' }, labels: { nodes: [{ name: 'bug' }] }, comments: { totalCount: 3 },
    isDraft: false, state: 'OPEN', createdAt: '2026-10-18T00:00:00Z', mergedAt: null, updatedAt: '2026-10-19T11:00:00Z',
    baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefName: 'feature', headRefOid: HEAD_SHA,
    isCrossRepository: false, isInMergeQueue: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    repository: { nameWithOwner: 'Acme/app', viewerDefaultMergeMethod: 'SQUASH' },
    commits: { nodes: [{ commit: { statusCheckRollup: {
      state: checksState, contexts: { nodes: [{ __typename: 'CheckRun', name: 'CI', conclusion: checksState === 'SUCCESS' ? 'SUCCESS' : null, status: checksState === 'SUCCESS' ? 'COMPLETED' : 'IN_PROGRESS' }] },
    } } }] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false }] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'docs', avatarUrl: null, organization: { login: 'Acme' } } }] },
    latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
  });
}

const unresolvedThread: MyPrThreadNode = {
  isResolved: false, isOutdated: false, path: 'app.ts', line: 3,
  firstComment: { totalCount: 1, nodes: [{ author: { login: 'bob' }, bodyText: 'Please check this', url: 'https://github.com/Acme/app/pull/1#discussion_r1', createdAt: '2026-10-19T11:00:00Z' }] },
  lastComment: { nodes: [{ author: { login: 'bob' }, createdAt: '2026-10-19T11:00:00Z' }] },
};

function storeHarness(ghCallDurationMs = 0) {
  let timestamp = FIRST_TICK_AT;
  let isDashboardConnected = true;
  let isExclusive = false;
  let nodes = [detailNode(1), detailNode(2)];
  let behindBy = 2;
  let notificationResponse: Awaited<ReturnType<PrGh['notificationsSince']>> = { kind: 'unchanged' };
  const queue = createSerialQueue();
  const timers = manualTimers();
  const searches: string[] = [];
  const detailCalls: string[][] = [];
  const behindCalls: string[][] = [];
  const threadCalls: string[][] = [];
  const notificationCalls: (string | undefined)[] = [];
  const diffCalls: string[] = [];
  const rateLimitCalls: number[] = [];
  const warnings: string[] = [];
  const github: Parameters<typeof createGithubStorePoller>[0]['github'] = {
    async searchPrsLight(qualifiers) {
      assert.equal(isExclusive, true);
      searches.push(qualifiers);
      timestamp += ghCallDurationMs;
      return { ok: true, items: nodes.map((node) => GithubPrLightSearchNode.parse(node)), isComplete: true, error: '' };
    },
    async prDetails(references) {
      assert.equal(isExclusive, true);
      detailCalls.push(references.map(comparablePrKey));
      return new Map(nodes.filter((node) => references.some((reference) => reference.number === node.number)).map((node) => [comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number }), node]));
    },
    async behindCounts(references) {
      assert.equal(isExclusive, true);
      behindCalls.push(references.map(comparablePrKey));
      return new Map(references.map((reference) => [`Acme/app#${reference.number}`, behindBy]));
    },
    async reviewThreadsBatch(references) {
      assert.equal(isExclusive, true);
      threadCalls.push(references.map(comparablePrKey));
      return new Map(references.map((reference) => [`Acme/app#${reference.number}`, [unresolvedThread]]));
    },
    async notificationsSince(lastModified) {
      assert.equal(isExclusive, true);
      notificationCalls.push(lastModified);
      timestamp += ghCallDurationMs;
      return notificationResponse;
    },
    async rateLimitWaitMs() {
      assert.equal(isExclusive, true);
      rateLimitCalls.push(timestamp);
      return null;
    },
    async viewPr() { assert.fail('This scenario does not request a PR view'); },
    async prDiff(repo, number) {
      assert.equal(isExclusive, true);
      diffCalls.push(comparablePrKey({ repo, number }));
      return 'diff --git a/app.ts b/app.ts\n';
    },
    async prHead() {
      assert.equal(isExclusive, true);
      return nodes[0].headRefOid;
    },
    async reviewThreads() {
      assert.equal(isExclusive, true);
      return [unresolvedThread];
    },
    async compareCommits() { assert.fail('This scenario does not request a comparison'); },
  };
  const poller = createGithubStorePoller({
    github, now: () => timestamp, isDashboardConnected: () => isDashboardConnected,
    exclusive: (work) => queue.run(async () => {
      assert.equal(isExclusive, false);
      isExclusive = true;
      try {
        return await work();
      } finally {
        isExclusive = false;
      }
    }),
    setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    log: { warn: (warning: string) => { warnings.push(warning); } },
  });
  return {
    poller, timers, searches, detailCalls, behindCalls, threadCalls, notificationCalls, diffCalls, rateLimitCalls, warnings,
    idle: queue.idle,
    advance: (milliseconds: number) => { timestamp += milliseconds; },
    setConnected: (connected: boolean) => { isDashboardConnected = connected; },
    setNodes: (nextNodes: GithubPrDetailNode[]) => { nodes = nextNodes; },
    setBehindBy: (count: number) => { behindBy = count; },
    setNotifications: (response: Awaited<ReturnType<PrGh['notificationsSince']>>) => { notificationResponse = response; },
    cleanup: () => { for (const timer of timers.pending) timers.clearTimeoutFn(timer.handle); },
  };
}

test('a rollup change without an updatedAt change fetches only that PR and emits one canonical change', async (context) => {
  const harness = storeHarness();
  context.after(harness.cleanup);
  const { poller } = harness;
  const changedKeys: string[] = [];
  const snapshots: ReturnType<typeof poller.getSnapshot>[] = [];
  poller.events.on('change', (key) => { changedKeys.push(key); });
  poller.events.on('snapshot-changed', (snapshot) => { snapshots.push(snapshot); });
  poller.registerWatch({ name: 'my-prs', qualifiers: 'author:@me', needsDetail: true });
  poller.registerWatch({ name: 'workflow', qualifiers: 'repo:Acme/app', needsDetail: true });
  poller.setWatchedKeys('session', ['ACME/APP#2']);
  assert.deepEqual(await poller.tick(), { failed: false });
  assert.deepEqual(harness.detailCalls.map((keys) => new Set(keys)), [new Set(['acme/app#1', 'acme/app#2'])]);
  const previousPrs = poller.getSnapshot().prs;
  changedKeys.length = 0;
  snapshots.length = 0;
  harness.setNodes([detailNode(1, 'SUCCESS'), detailNode(2)]);
  harness.advance(59_999);
  await poller.tick();
  assert.equal(harness.searches.length, 2);
  harness.advance(1);
  await poller.tick();
  assert.deepEqual(harness.detailCalls.at(-1), ['acme/app#1']);
  assert.deepEqual(harness.behindCalls.at(-1), ['acme/app#1']);
  assert.deepEqual(harness.threadCalls.at(-1), ['acme/app#1']);
  assert.deepEqual(changedKeys, ['acme/app#1']);
  assert.equal(snapshots.length, 1);
  assert.equal(poller.getSnapshot().prs['acme/app#2'], previousPrs['acme/app#2']);
  const changedPr = poller.getSnapshot().prs['acme/app#1'];
  assert.equal(changedPr.updatedAt, previousPrs['acme/app#1'].updatedAt);
  assert.equal(changedPr.checks.state, 'SUCCESS');
  assert.equal(changedPr.behindBy, 2);
  assert.equal(changedPr.threads[0].excerpt, 'Please check this');
  assert.deepEqual(changedPr.reviewRequests, [{ name: 'Acme/docs', isTeam: true, avatarUrl: null }]);
  GithubPrsFrame.parse({ type: 'github-prs', ts: FIRST_TICK_AT + 60_000, ...poller.getSnapshot() });
  harness.setConnected(false);
  harness.advance(299_999);
  await poller.tick();
  assert.equal(harness.searches.length, 4);
  harness.advance(1);
  await poller.tick();
  assert.equal(harness.searches.length, 6);
  assert.equal(harness.detailCalls.length, 2);
  harness.setNodes([detailNode(1), detailNode(2)]);
  const searchCountBeforeRefresh = harness.searches.length;
  assert.deepEqual(await poller.refreshWatches(['my-prs']), { ok: true });
  assert.deepEqual(harness.searches.slice(searchCountBeforeRefresh), ['author:@me']);
  assert.equal(poller.getSnapshot().prs['acme/app#1'].checks.state, 'PENDING');
  assert.deepEqual(poller.getSnapshot().watches['my-prs'].keys, ['acme/app#1', 'acme/app#2']);
  poller.unregisterWatch('my-prs');
  poller.unregisterWatch('workflow');
  poller.setWatchedKeys('session', []);
  await poller.tick();
  assert.deepEqual(poller.getSnapshot().prs, {});
});

test('a base branch moving with no light change refreshes behind counts every five minutes without refetching details', async (context) => {
  const harness = storeHarness();
  context.after(harness.cleanup);
  const { poller } = harness;
  const changedKeys: string[] = [];
  let snapshotCount = 0;
  poller.events.on('change', (key) => { changedKeys.push(key); });
  poller.events.on('snapshot-changed', () => { snapshotCount += 1; });
  poller.registerWatch({ name: 'my-prs', qualifiers: 'author:@me', needsDetail: true });
  await poller.tick();
  assert.equal(harness.behindCalls.length, 1);
  changedKeys.length = 0;
  snapshotCount = 0;
  harness.setBehindBy(5);
  harness.advance(299_999);
  await poller.tick();
  assert.equal(harness.behindCalls.length, 1);
  harness.advance(1);
  await poller.tick();
  assert.equal(harness.detailCalls.length, 1);
  assert.deepEqual(harness.behindCalls.at(-1), ['acme/app#1', 'acme/app#2']);
  assert.deepEqual(changedKeys, ['acme/app#1', 'acme/app#2']);
  assert.equal(snapshotCount, 1);
  assert.equal(poller.getSnapshot().prs['acme/app#1'].behindBy, 5);
});

test('forbidden notifications disable once while light polling continues and 304 preserves health and poll spacing', async (context) => {
  const forbidden = storeHarness();
  const unchanged = storeHarness();
  context.after(forbidden.cleanup);
  context.after(unchanged.cleanup);
  forbidden.setNotifications({ kind: 'forbidden', message: 'HTTP 403' });
  forbidden.poller.registerWatch({ name: 'my-prs', qualifiers: 'author:@me', needsDetail: true });
  for (let tickIndex = 0; tickIndex < 3; tickIndex += 1) {
    assert.deepEqual(await forbidden.poller.tick(), { failed: false });
    forbidden.advance(60_000);
  }
  assert.equal(forbidden.notificationCalls.length, 1);
  assert.equal(forbidden.warnings.length, 1);
  assert.match(forbidden.warnings[0], /disabled until restart/);
  assert.equal(forbidden.searches.length, 3);
  assert.equal(forbidden.poller.getSnapshot().freshness.error, null);
  unchanged.setNotifications({ kind: 'unchanged', lastModified: 'Mon, 19 Oct 2026 11:00:00 GMT', pollIntervalSeconds: 120 });
  unchanged.poller.registerWatch({ name: 'my-prs', qualifiers: 'author:@me', needsDetail: true });
  assert.deepEqual(await unchanged.poller.tick(), { failed: false });
  unchanged.advance(60_000);
  assert.deepEqual(await unchanged.poller.tick(), { failed: false });
  assert.equal(unchanged.notificationCalls.length, 1);
  unchanged.advance(60_000);
  assert.deepEqual(await unchanged.poller.tick(), { failed: false });
  assert.deepEqual(unchanged.notificationCalls, [undefined, 'Mon, 19 Oct 2026 11:00:00 GMT']);
  assert.equal(unchanged.searches.length, 3);
  assert.equal(unchanged.poller.getSnapshot().freshness.error, null);
  assert.deepEqual(unchanged.warnings, []);
});

test('two refresh requests for the same comparable key debounce to one detail fetch inside the clock gate', async (context) => {
  const harness = storeHarness();
  context.after(harness.cleanup);
  harness.poller.requestRefresh('Acme/app#1');
  harness.advance(1_000);
  harness.poller.requestRefresh('acme/app#1');
  const activeTimers = harness.timers.pending.filter((timer) => !timer.cleared);
  assert.equal(activeTimers.length, 1);
  assert.equal(activeTimers[0].ms, 5_000);
  assert.deepEqual(harness.detailCalls, []);
  harness.advance(5_000);
  harness.timers.fireAll();
  await harness.idle();
  assert.deepEqual(harness.detailCalls, [['acme/app#1']]);
  assert.equal(harness.poller.getSnapshot().prs['acme/app#1'].headRefOid, HEAD_SHA);
  assert.equal(harness.poller.getSnapshot().freshness.lastRefreshedAt, FIRST_TICK_AT + 6_000);
});

test('one-shot diff reads cache by PR and head SHA without a second gh call', async (context) => {
  const harness = storeHarness();
  context.after(harness.cleanup);
  const firstDiff = await harness.poller.requestPrDiff('Acme/app', 1, HEAD_SHA);
  const rateLimitCallCount = harness.rateLimitCalls.length;
  assert.equal(await harness.poller.requestPrDiff('acme/app', 1, HEAD_SHA), firstDiff);
  assert.equal(harness.diffCalls.length, 1);
  assert.equal(harness.rateLimitCalls.length, rateLimitCallCount);
  const nextHeadSha = 'c'.repeat(40);
  harness.setNodes([{ ...detailNode(1), headRefOid: nextHeadSha }]);
  assert.equal(await harness.poller.requestPrDiff('Acme/app', 1, nextHeadSha), firstDiff);
  assert.equal(harness.diffCalls.length, 2);
});

test('a watched key GitHub cannot resolve is dropped without failing the tick or being fetched again', async (context) => {
  const harness = storeHarness();
  context.after(harness.cleanup);
  harness.poller.registerWatch({ name: 'my-prs', qualifiers: 'author:@me', needsDetail: true });
  harness.poller.setWatchedKeys('session', ['acme/app#999']);
  assert.deepEqual(await harness.poller.tick(), { failed: false });
  assert.deepEqual(Object.keys(harness.poller.getSnapshot().prs).sort(), ['acme/app#1', 'acme/app#2']);
  harness.advance(60_000);
  assert.deepEqual(await harness.poller.tick(), { failed: false });
  assert.equal(harness.detailCalls.length, 1);
  assert.equal(harness.poller.getSnapshot().freshness.error, null);
});

test('slow gh calls keep the connected light and notification polls on every one-minute clock tick', async (context) => {
  const harness = storeHarness(700);
  context.after(harness.cleanup);
  harness.poller.registerWatch({ name: 'my-prs', qualifiers: 'author:@me', needsDetail: true });
  for (let clockTick = 0; clockTick < 5; clockTick += 1) {
    assert.deepEqual(await harness.poller.tick(), { failed: false });
    harness.advance(60_000 - 1_400);
  }
  assert.equal(harness.searches.length, 5);
  assert.equal(harness.notificationCalls.length, 5);
});
