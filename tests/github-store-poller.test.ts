import { createPrGh } from '../server/github/pr-gh.ts';
import { normalizeGithubPr } from '../server/github/core/github-store-core.ts';
import { reviewSnapshotFromGithubPr } from '../server/github/core/team-review-core.ts';
import { myPrFromGithubPr } from '../shared/my-pr-merge.ts';
import { toMyPr } from '../server/github/core/my-prs-core.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubStorePoller } from '../server/github/github-store-poller.ts';
import { TRANSIENT_BACKOFF_MAX_MS } from '../server/lanes/core/lane-backoff.ts';
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
  let searchNodeNumbers: ReadonlySet<number> | undefined;
  let lightFailureMessage: string | null = null;
  let behindBy = 2;
  let notificationResponse: Awaited<ReturnType<PrGh['notificationsSince']>> = { kind: 'unchanged' };
  const queue = createSerialQueue();
  const timers = manualTimers();
  const searches: string[] = [];
  const membershipCaps: (number | undefined)[] = [];
  const lightCalls: string[][] = [];
  const detailCalls: string[][] = [];
  const behindCalls: string[][] = [];
  const threadCalls: string[][] = [];
  const notificationCalls: (string | undefined)[] = [];
  const diffCalls: string[] = [];
  const rateLimitCalls: number[] = [];
  const warnings: string[] = [];
  const rateLimitResources: (readonly string[])[] = [];
  let rateLimitedResource: string | null = null;
  const repoIssueCalls: Parameters<PrGh['listRepoIssues']>[] = [];
  const issueSearchCalls: string[] = [];
  const issueLinkedPrCalls: (readonly string[])[] = [];
  let hasIssueReadFailure = false;
  let viewerLogin: string | null = null;
  let viewerCalls = 0;
  const issueFetch = { ok: true, items: [], isComplete: true, error: '' };

  const github: Parameters<typeof createGithubStorePoller>[0]['github'] = {
    async viewer() {
      assert.equal(isExclusive, true);
      viewerCalls += 1;
      return viewerLogin;
    },
    async listRepoIssues(...args) {
      assert.equal(isExclusive, true);
      repoIssueCalls.push(args);
      if (hasIssueReadFailure) throw new Error('Issue read offline');
      return issueFetch;
    },
    async searchIssues(query) {
      assert.equal(isExclusive, true);
      issueSearchCalls.push(query);
      if (hasIssueReadFailure) throw new Error('Issue read offline');
      return issueFetch;
    },
    async issueLinkedPullRequests(keys) {
      assert.equal(isExclusive, true);
      issueLinkedPrCalls.push(keys);
      if (hasIssueReadFailure) throw new Error('Issue read offline');
      return new Map(keys.map((key) => [key, [{ number: 12, url: 'https://github.com/other/lib/pull/12', title: 'Fix', state: 'open' as const }]]));
    },
    async searchPrsLight(qualifiers, maxMembers) {
      assert.equal(isExclusive, true);
      searches.push(qualifiers);
      membershipCaps.push(maxMembers);
      timestamp += ghCallDurationMs;
      const matchingNodes = nodes.filter((node) => !searchNodeNumbers || searchNodeNumbers.has(node.number));
      return { ok: true, items: matchingNodes.slice(0, maxMembers).map((node) => GithubPrLightSearchNode.parse(node)), totalCount: matchingNodes.length, isComplete: maxMembers === undefined || matchingNodes.length <= maxMembers, error: '' };
    },
    async prsLightByKey(references) {
      assert.equal(isExclusive, true);
      lightCalls.push(references.map(comparablePrKey));
      timestamp += ghCallDurationMs;
      if (lightFailureMessage) throw new Error(lightFailureMessage);
      const keys = new Set(references.map(comparablePrKey));
      return new Map(nodes.filter((node) => keys.has(comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number })))
        .map((node) => [comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number }), GithubPrLightSearchNode.parse(node)]));
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
    async rateLimitWaitMs(_now, resources) {
      assert.equal(isExclusive, true);
      rateLimitCalls.push(timestamp);
      rateLimitResources.push(resources);
      return rateLimitedResource && resources.includes(rateLimitedResource) ? 120000 : null;
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
    poller, timers, searches, membershipCaps, lightCalls, detailCalls, behindCalls, threadCalls, notificationCalls, diffCalls, rateLimitCalls, warnings,
    rateLimitResources, repoIssueCalls, issueSearchCalls, issueLinkedPrCalls, issueFetch,
    limitResource: (resource: string | null) => { rateLimitedResource = resource; },
    setViewer: (login: string) => { viewerLogin = login; },
    viewerCalls: () => viewerCalls,
    failIssueReads: () => { hasIssueReadFailure = true; },
    idle: queue.idle,
    advance: (milliseconds: number) => { timestamp += milliseconds; },
    setConnected: (connected: boolean) => { isDashboardConnected = connected; },
    setNodes: (nextNodes: GithubPrDetailNode[]) => { nodes = nextNodes; },
    setSearchNodeNumbers: (numbers: readonly number[]) => { searchNodeNumbers = new Set(numbers); },
    setLightFailure: (message: string | null) => { lightFailureMessage = message; },
    setBehindBy: (count: number) => { behindBy = count; },
    setNotifications: (response: Awaited<ReturnType<PrGh['notificationsSince']>>) => { notificationResponse = response; },
    cleanup: () => { for (const timer of timers.pending) timers.clearTimeoutFn(timer.handle); },
  };
}

test('repeated transient failures retry within five minutes and success resets quick retries', async (context) => {
  const harness = storeHarness();
  context.after(harness.cleanup);
  harness.poller.registerWatch({ name: 'my-prs', qualifiers: 'author:@me', needsDetail: true });
  harness.setLightFailure('gh: HTTP 504');
  const retryWaits: number[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const outcome = await harness.poller.tick();
    assert.equal(outcome.failed, true);
    assert.equal(outcome.error, 'gh: HTTP 504');
    const waitMs = outcome.retryAfterMs;
    assert.ok(waitMs !== undefined && waitMs > 0 && waitMs <= TRANSIENT_BACKOFF_MAX_MS);
    retryWaits.push(waitMs);
    harness.advance(waitMs);
  }
  assert.deepEqual(retryWaits.slice(0, 3), [10_000, 30_000, 90_000]);
  assert.equal(harness.lightCalls.length, 20);
  harness.setLightFailure(null);
  assert.deepEqual(await harness.poller.tick(), { failed: false });
  harness.advance(60_000);
  harness.setLightFailure('gh: HTTP 504');
  assert.equal((await harness.poller.tick()).retryAfterMs, 10_000);
});

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
  assert.equal(harness.searches.length, 2);
  harness.advance(1);
  await poller.tick();
  assert.equal(harness.searches.length, 2);
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

test('a base branch moving with no light change refreshes behind counts every five minutes and refetches details of PRs whose count changed', async (context) => {
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
  harness.setNodes([{ ...detailNode(1), mergeStateStatus: 'BEHIND' }, { ...detailNode(2), mergeStateStatus: 'BEHIND' }]);
  harness.advance(299_999);
  await poller.tick();
  assert.equal(harness.behindCalls.length, 1);
  harness.advance(1);
  await poller.tick();
  assert.deepEqual(harness.detailCalls.at(-1), ['acme/app#1', 'acme/app#2']);
  assert.deepEqual(harness.behindCalls.at(-1), ['acme/app#1', 'acme/app#2']);
  assert.deepEqual(changedKeys, ['acme/app#1', 'acme/app#2']);
  assert.equal(snapshotCount, 1);
  assert.equal(poller.getSnapshot().prs['acme/app#1'].behindBy, 5);
  assert.equal(poller.getSnapshot().prs['acme/app#1'].mergeStateStatus, 'BEHIND');
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
  assert.equal(forbidden.searches.length, 1);
  assert.equal(forbidden.lightCalls.length, 3);
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
  assert.equal(unchanged.searches.length, 1);
  assert.equal(unchanged.lightCalls.length, 3);
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
  assert.deepEqual(harness.lightCalls, [['acme/app#1']]);
  assert.deepEqual(harness.searches, []);
  assert.deepEqual(harness.detailCalls, [['acme/app#1']]);
  assert.equal(harness.poller.getSnapshot().prs['acme/app#1'].headRefOid, HEAD_SHA);
  assert.equal(harness.poller.getSnapshot().freshness.lastRefreshedAt, FIRST_TICK_AT + 6_000);
});

test('one-shot reads cache successful viewers and diffs by PR and head SHA without a second gh call', async (context) => {
  const harness = storeHarness();
  context.after(harness.cleanup);
  assert.deepEqual(await harness.poller.requestViewer('no-wait'), { isRateLimited: false, value: null });
  harness.setViewer('alice');
  assert.deepEqual(await harness.poller.requestViewer('no-wait'), { isRateLimited: false, value: 'alice' });
  harness.limitResource('core');
  assert.deepEqual(await harness.poller.requestViewer('no-wait'), { isRateLimited: false, value: 'alice' });
  assert.equal(harness.viewerCalls(), 2);
  harness.limitResource(null);
  const firstDiff = await harness.poller.requestPrDiff('Acme/app', 1, HEAD_SHA);
  const rateLimitCallCount = harness.rateLimitCalls.length;
  assert.deepEqual(await harness.poller.requestPrDiff('acme/app', 1, HEAD_SHA), firstDiff);
  assert.equal(harness.diffCalls.length, 1);
  assert.equal(harness.rateLimitCalls.length, rateLimitCallCount);
  const nextHeadSha = 'c'.repeat(40);
  harness.setNodes([{ ...detailNode(1), headRefOid: nextHeadSha }]);
  assert.deepEqual(await harness.poller.requestPrDiff('Acme/app', 1, nextHeadSha), firstDiff);
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
    harness.advance(60_000 - (clockTick === 0 ? 2_100 : 1_400));
  }
  assert.equal(harness.searches.length, 1);
  assert.equal(harness.lightCalls.length, 5);
  assert.equal(harness.notificationCalls.length, 5);
});

test('canonical detail reads preserve review commits and writer decisions without changing My PRs derivations', async () => {
  const node = {
    ...detailNode(7), reviewDecision: null, author: { login: 'automation', __typename: 'Bot' },
    latestOpinionatedReviews: { nodes: [{ state: 'APPROVED' }, { state: 'APPROVED' }] },
    writerOpinionatedReviews: { nodes: [{ state: 'CHANGES_REQUESTED' }] },
    latestReviews: { nodes: [
      { state: 'COMMENTED', submittedAt: '2026-10-19T11:00:00Z', author: { login: 'writer' }, commit: { oid: HEAD_SHA } },
      { state: 'APPROVED', submittedAt: null, author: { login: 'outsider' }, commit: { oid: '' } },
      { state: 'APPROVED', submittedAt: null, author: null, commit: null },
    ] },
  };
  const github = createPrGh('/repo', async (_command, args) => {
    const query = args.find((argument) => argument.startsWith('query=')) ?? '';
    assert.match(query, /latestReviews\(first: 20\).*commit \{ oid \}/);
    assert.match(query, /writerOpinionatedReviews: latestOpinionatedReviews\(first: 20, writersOnly: true\)/);
    assert.match(query, /author \{ __typename login \}/);
    return { ok: true, out: JSON.stringify({ data: { pr0: { pullRequest: node } } }), err: '' };
  });
  const details = await github.prDetails([{ repo: 'Acme/app', number: 7 }]);
  const detail = details.get('acme/app#7');
  assert.ok(detail);
  const pr = normalizeGithubPr(detail);
  assert.equal(pr.reviewDecision, null);
  assert.equal(pr.isAuthorBot, true);
  assert.deepEqual(pr.reviews.map((review) => review.commit), [HEAD_SHA, null, null]);
  const snapshot = reviewSnapshotFromGithubPr(pr);
  assert.equal(snapshot.reviewDecision, 'CHANGES_REQUESTED');
  assert.deepEqual(snapshot.reviews, [
    { login: 'writer', state: 'COMMENTED', commit: HEAD_SHA, submittedAt: '2026-10-19T11:00:00Z' },
    { login: 'outsider', state: 'APPROVED', commit: null, submittedAt: null },
  ]);
  for (const [opinionatedWriterReviewStates, expectedDecision] of [[[], 'REVIEW_REQUIRED'], [['APPROVED'], 'APPROVED'], [['APPROVED', 'CHANGES_REQUESTED'], 'CHANGES_REQUESTED']] as const) {
    assert.equal(reviewSnapshotFromGithubPr({ ...pr, opinionatedWriterReviewStates: [...opinionatedWriterReviewStates] }).reviewDecision, expectedDecision);
  }
  assert.equal(reviewSnapshotFromGithubPr({ ...pr, reviewDecision: 'REVIEW_REQUIRED' }).reviewDecision, 'REVIEW_REQUIRED');
  assert.deepEqual(myPrFromGithubPr(pr), toMyPr(detail, null));
  GithubPrsFrame.parse({ type: 'github-prs', ts: FIRST_TICK_AT, prs: { [pr.key]: pr }, freshness: { lastRefreshedAt: FIRST_TICK_AT, error: null } });
});

test('membership searches and batched state reads stay within the viewed and unviewed light budget', async (context) => {
  const harness = storeHarness();
  context.after(harness.cleanup);
  const { poller } = harness;
  for (const name of ['direct', 'team', 'authored']) poller.registerWatch({ name, qualifiers: `watch:${name}`, needsDetail: true });
  poller.setWatchedKeys('sessions', ['ACME/APP#2', 'acme/app#3', 'acme/app#4']);
  harness.setNodes([detailNode(1), detailNode(2), detailNode(3), detailNode(4)]);
  harness.setSearchNodeNumbers([1, 2, 5]);
  for (let tickIndex = 0; tickIndex < 10; tickIndex += 1) {
    assert.deepEqual(await poller.tick(), { failed: false });
    harness.advance(60_000);
  }
  assert.deepEqual(harness.searches, ['watch:direct', 'watch:team', 'watch:authored', 'watch:direct', 'watch:team', 'watch:authored']);
  assert.equal(harness.lightCalls.length, 10);
  assert.ok(harness.lightCalls.every((keys) => keys.length === 4 && new Set(keys).size === 4));
  assert.equal(harness.detailCalls.length, 1);
  harness.setConnected(false);
  for (let tickIndex = 0; tickIndex < 2; tickIndex += 1) {
    await poller.tick();
    harness.advance(300_000);
  }
  assert.equal(harness.searches.length, 6);
  assert.equal(harness.lightCalls.length, 11);
  await poller.tick();
  assert.equal(harness.searches.length, 9);
  assert.equal(harness.lightCalls.length, 12);
  poller.registerWatch({ name: 'direct', qualifiers: 'watch:changed', needsDetail: true });
  await poller.tick();
  assert.equal(harness.searches.at(-1), 'watch:changed');
  assert.equal(harness.searches.length, 10);
  assert.deepEqual(await poller.refreshWatches(['team']), { ok: true });
  assert.equal(harness.searches.at(-1), 'watch:team');
  assert.equal(harness.searches.length, 11);
  harness.setNodes([detailNode(1, 'SUCCESS'), detailNode(3), detailNode(4)]);
  harness.advance(300_000);
  await poller.tick();
  assert.equal(poller.getSnapshot().prs['acme/app#2'], undefined);
  assert.deepEqual(poller.getSnapshot().watches.team.keys, ['acme/app#1', 'acme/app#2']);
  harness.setNodes([detailNode(1, 'SUCCESS'), detailNode(2), detailNode(3), detailNode(4), detailNode(5)]);
  harness.setNotifications({ kind: 'ok', prKeys: ['acme/app#5'] });
  harness.advance(60_000);
  await poller.tick();
  const searchesBeforeNotificationTick = harness.searches.length;
  await poller.tick();
  assert.equal(harness.searches.length, searchesBeforeNotificationTick + 3);
  assert.ok(poller.getSnapshot().watches.team.keys.includes('acme/app#5'));
  const previousPrs = poller.getSnapshot().prs;
  harness.setLightFailure('light batch failed');
  harness.advance(300_000);
  const failedTick = await poller.tick();
  assert.equal(failedTick.failed, true);
  assert.equal(poller.getSnapshot().prs, previousPrs);
  assert.equal(poller.getSnapshot().freshness.error, 'light batch failed');
  assert.deepEqual(await poller.requestViewer('no-wait'), { isRateLimited: false, value: null });
  assert.equal(harness.viewerCalls(), 1);
  harness.setLightFailure(null);
  harness.advance(failedTick.retryAfterMs ?? 0);
  assert.deepEqual(await poller.tick(), { failed: false });
  assert.equal(poller.getSnapshot().freshness.error, null);
  const searchesBeforeDetailChange = harness.searches.length;
  const previousWatchKeys = poller.getSnapshot().watches.direct.keys;
  poller.registerWatch({ name: 'direct', qualifiers: 'watch:changed', needsDetail: false });
  assert.deepEqual(await poller.tick(), { failed: false });
  assert.equal(harness.searches.length, searchesBeforeDetailChange);
  assert.deepEqual(poller.getSnapshot().watches.direct.keys, previousWatchKeys);
});


test('capped workflow watches keep exclusive keys on their fixed cadence while shared keys follow default watches and explicit owners', async (context) => {
  const harness = storeHarness();
  context.after(harness.cleanup);
  const { poller } = harness;
  harness.setNodes(Array.from({ length: 51 }, (_, index) => detailNode(index + 1)));
  poller.registerWatch({ name: 'workflows-open:acme/app', qualifiers: 'is:open repo:Acme/app', needsDetail: true, maxMembers: 50, intervalMs: 300_000 });
  await poller.tick();
  assert.deepEqual(harness.membershipCaps, [50]);
  assert.equal(poller.getSnapshot().watches['workflows-open:acme/app'].isComplete, false);
  assert.equal(harness.lightCalls[0].length, 50);
  const firstPrs = poller.getSnapshot().prs;
  harness.advance(60_000);
  await poller.tick();
  assert.equal(harness.searches.length, 1);
  assert.equal(harness.lightCalls.length, 1);
  assert.equal(poller.getSnapshot().prs, firstPrs);
  harness.advance(240_000);
  await poller.tick();
  assert.deepEqual(harness.membershipCaps, [50, 50]);
  assert.equal(harness.lightCalls.length, 2);
  assert.equal(harness.lightCalls[1].length, 50);
  harness.setSearchNodeNumbers([1]);
  poller.registerWatch({ name: 'my-prs', qualifiers: 'author:@me', needsDetail: true });
  await poller.tick();
  assert.deepEqual(harness.lightCalls.at(-1), ['acme/app#1']);
  harness.advance(60_000);
  await poller.tick();
  assert.deepEqual(harness.lightCalls.at(-1), ['acme/app#1']);
  poller.setWatchedKeys('session', ['acme/app#2']);
  await poller.tick();
  assert.deepEqual(new Set(harness.lightCalls.at(-1)), new Set(['acme/app#1', 'acme/app#2']));
  poller.unregisterWatch('my-prs');
  poller.setWatchedKeys('session', []);
  harness.setConnected(false);
  harness.setSearchNodeNumbers(Array.from({ length: 50 }, (_, index) => index + 2));
  harness.setNodes(Array.from({ length: 51 }, (_, index) => detailNode(index + 1, index === 1 ? 'SUCCESS' : 'PENDING')));
  harness.advance(240_000);
  await poller.tick();
  assert.equal(harness.searches.at(-1), 'is:open repo:Acme/app');
  assert.equal(harness.membershipCaps.at(-1), 50);
  assert.equal(poller.getSnapshot().watches['workflows-open:acme/app'].keys.length, 50);
  assert.equal(poller.getSnapshot().prs['acme/app#1'], undefined);
  assert.equal(harness.lightCalls.at(-1)?.includes('acme/app#51'), true);
  assert.equal(harness.lightCalls.at(-1)?.includes('acme/app#2'), false);
  assert.equal(poller.getSnapshot().prs['acme/app#2'].checks.state, 'SUCCESS');
  const lightCallCount = harness.lightCalls.length;
  harness.advance(60_000);
  await poller.tick();
  assert.equal(harness.lightCalls.length, lightCallCount);
});

test('issue reads share the store gate, honor search and GraphQL limits and retain failed-read fallbacks', async (context) => {
  const harness = storeHarness();
  context.after(harness.cleanup);
  const { poller } = harness;
  const since = '2026-10-19T12:00:00Z';
  const query = 'is:issue is:open assignee:@me';
  for (const resource of ['core', 'search']) {
    harness.limitResource(resource);
    assert.deepEqual(await poller.requestRepoIssues('acme/app', since, 300, 'no-wait'), { isRateLimited: true, waitMs: 120000 });
    assert.deepEqual(await poller.requestIssueSearch(query, 'no-wait'), { isRateLimited: true, waitMs: 120000 });
    assert.deepEqual(await poller.requestIssueLinkedPullRequests(['acme/app#1'], 'no-wait'), { isRateLimited: true, waitMs: 120000 });
  }
  harness.limitResource('graphql');
  assert.deepEqual(await poller.requestIssueLinkedPullRequests(['acme/app#1'], 'no-wait'), { isRateLimited: true, waitMs: 120000 });
  assert.deepEqual(harness.repoIssueCalls, []);
  assert.deepEqual(harness.issueSearchCalls, []);
  assert.deepEqual(harness.issueLinkedPrCalls, []);
  assert.equal(harness.timers.pending.length, 0);
  assert.deepEqual(await poller.requestRepoIssues('acme/app', since, 300, 'no-wait'), { isRateLimited: false, value: harness.issueFetch });
  assert.deepEqual(await poller.requestIssueSearch(query, 'no-wait'), { isRateLimited: false, value: harness.issueFetch });
  harness.limitResource(null);
  const linked = await poller.requestIssueLinkedPullRequests(['acme/app#1'], 'no-wait');
  assert.equal(linked.isRateLimited, false);
  if (linked.isRateLimited) assert.fail('Linked pull requests should be available');
  assert.equal(linked.value.get('acme/app#1')?.[0].state, 'open');
  assert.deepEqual(harness.repoIssueCalls, [['acme/app', since, 300]]);
  assert.deepEqual(harness.issueSearchCalls, [query]);
  assert.deepEqual(harness.issueLinkedPrCalls, [['acme/app#1']]);
  assert.deepEqual(harness.rateLimitResources.slice(-3), [['core', 'search'], ['core', 'search'], ['graphql', 'core', 'search']]);
  harness.limitResource('search');
  const waiting = poller.requestIssueSearch(query);
  await harness.idle();
  assert.equal(harness.timers.pending.at(-1)?.ms, 120000);
  assert.equal(harness.issueSearchCalls.length, 1);
  harness.limitResource(null);
  harness.timers.fireAll();
  assert.deepEqual(await waiting, { isRateLimited: false, value: harness.issueFetch });
  assert.equal(harness.issueSearchCalls.length, 2);
  harness.failIssueReads();
  assert.deepEqual(await poller.requestRepoIssues('acme/app', null, 300), { isRateLimited: false, value: { ok: false, items: [], isComplete: false, error: 'Issue listing failed.' } });
  assert.deepEqual(await poller.requestIssueSearch(query), { isRateLimited: false, value: { ok: false, items: [], isComplete: false, error: 'Issue search failed.' } });
  assert.deepEqual(await poller.requestIssueLinkedPullRequests(['acme/app#1']), { isRateLimited: false, value: new Map() });
  assert.equal(harness.warnings.filter((warning) => warning.includes('Issue read offline')).length, 3);
});
