import { createGithubStoreWiring } from '../server/github/github-store-wiring.ts';
import type { SharedClock } from '../server/lanes/lane-runner.ts';
import { createGithubStorePoller } from '../server/github/github-store-poller.ts';
import { createSerialQueue } from '../server/spawn-gate.ts';
import { GithubPrDetailNode, GithubPrLightSearchNode, comparablePrKey } from '../shared/contracts/github-prs.ts';
import type { PrGh } from '../server/github/pr-gh.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMyPrsWiring } from '../server/github/my-prs-wiring.ts';
import { createMyPrsPoller } from '../server/github/my-prs-poller.ts';
import { createPrGh } from '../server/github/pr-gh.ts';
import type { CommandResult } from '../server/github/pr-gh.ts';
import { myPrsStatus, toMyPr } from '../server/github/core/my-prs-core.ts';
import type { MyPr, MyPrSearchNode } from '../shared/contracts/my-prs.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

const SEEN_HEAD = 'a'.repeat(40);
const NEWER_HEAD = 'b'.repeat(40);
const KEY = 'Acme/app#7';

interface MergeFrame {
  type: string;
  requestId?: string | null;
  key?: string;
  ok?: boolean;
  kind?: string;
  error?: string;
}

function readyNode(overrides: Partial<MyPrSearchNode> = {}): MyPrSearchNode {
  return {
    __typename: 'PullRequest', id: 'PR_node', number: 7, title: 'Fix', url: 'https://github.com/Acme/app/pull/7', isDraft: false,
    state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T11:00:00Z', baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefName: 'feature', isCrossRepository: false, headRefOid: SEEN_HEAD, isInMergeQueue: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app', viewerDefaultMergeMethod: 'SQUASH' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } } }] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [{ state: 'APPROVED' }] },
    latestReviews: { nodes: [] },
    ...overrides,
  };
}

function storeReads(readNodes: () => MyPrSearchNode[]): Pick<PrGh, 'searchPrsLight' | 'prDetails' | 'notificationsSince'> {
  return {
    async searchPrsLight(qualifiers) {
      const items = readNodes().filter((pr) => (pr.state === 'MERGED') === qualifiers.startsWith('is:merged'));
      return { ok: true, items: items.map((pr) => GithubPrLightSearchNode.parse(pr)), isComplete: true, totalCount: items.length, error: '' };
    },
    async prDetails(references) {
      return new Map(readNodes().filter((pr) => references.some((reference) => comparablePrKey(reference) === comparablePrKey({ repo: pr.repository.nameWithOwner, number: pr.number })))
        .map((pr) => [comparablePrKey({ repo: pr.repository.nameWithOwner, number: pr.number }), GithubPrDetailNode.parse({ ...pr, author: { login: 'me' }, labels: { nodes: [] }, comments: { totalCount: 0 } })]));
    },
    async notificationsSince() { return { kind: 'unchanged' }; },
  };
}

function createTestStore(github: PrGh) {
  const queue = createSerialQueue();
  const poller = createGithubStorePoller({
    github, now: Date.now, isDashboardConnected: () => true, exclusive: queue.run,
    setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout, log: { warn() {} },
  });
  return {
    ...poller,
    subscribe: <Event extends 'snapshot-changed' | 'change'>(event: Event, listener: Parameters<typeof poller.events.on<Event>>[1]) => {
      poller.events.on(event, listener);
      return () => { poller.events.off(event, listener); };
    },
  };
}

function mergeStateResponse(state: string, isInMergeQueue: boolean): CommandResult {
  return { ok: true, out: JSON.stringify({ data: { repository: { pullRequest: { state, isInMergeQueue, autoMergeRequest: null } } } }), err: '' };
}

const MERGED_STATE = mergeStateResponse('MERGED', false);

test('a store rollup change broadcasts my-prs status without a lane tick and Refresh polls its watches', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-my-pr-store-'));
  let nowMs = Date.now();
  let checksState: 'PENDING' | 'SUCCESS' = 'PENDING';
  let laneTicks = 0;
  const searches: string[] = [];
  const statuses: ReturnType<typeof myPrsStatus>[] = [];
  const reads = storeReads(() => [readyNode({ commits: { nodes: [{ commit: { statusCheckRollup: { state: checksState, contexts: { nodes: [] } } } }] } })]);
  const github = {
    ...createPrGh(homeDir), ...reads,
    viewer: async () => 'me', behindCounts: async () => new Map<string, number>(), reviewThreadsBatch: async () => new Map(), rateLimitWaitMs: async () => null,
    searchPrsLight: async (qualifiers: string) => { searches.push(qualifiers); return reads.searchPrsLight(qualifiers); },
  };
  const queue = createSerialQueue();
  let storeTick = async () => {};
  const clock: SharedClock = {
    exclusive: queue.run,
    schedule: (run, intervalMs) => {
      if (intervalMs === 60_000) storeTick = run;
      return () => {};
    },
  };
  const githubStore = createGithubStoreWiring({ github, clock, now: () => nowMs, isDashboardConnected: () => true, broadcast: () => {}, log: { warn() {} } });
  const store = githubStore.laneStore;
  let markFirstStatus = () => {};
  const firstStatus = new Promise<void>((resolve) => { markFirstStatus = resolve; });
  const wiring = createMyPrsWiring({
    homeDir, config: { teamReview: { enabled: true, org: 'Acme' } }, github, store, clock, log: { warn() {} },
    broadcast: (status) => { statuses.push(status); if (status.prs.length > 0 && !status.isRefreshing) markFirstStatus(); },
    createPoller: (dependencies) => {
      const poller = createMyPrsPoller({ ...dependencies, firstTickDelayMs: () => 0, setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {} });
      return { ...poller, tick: async () => { laneTicks += 1; await poller.tick(); } };
    },
  });
  try {
    wiring.startPoller();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await storeTick();
    await firstStatus;
    assert.equal(statuses.at(-1)?.prs[0]?.stage, 'checks-pending');
    const updatedAt = statuses.at(-1)?.prs[0]?.updatedAt;
    checksState = 'SUCCESS';
    nowMs += 60_000;
    const broadcastCount = statuses.length;
    await storeTick();
    assert.equal(laneTicks, 0);
    assert.equal(statuses.length, broadcastCount + 1);
    assert.equal(statuses.at(-1)?.prs[0]?.checks.state, 'SUCCESS');
    assert.equal(statuses.at(-1)?.prs[0]?.stage, 'ready');
    assert.equal(statuses.at(-1)?.prs[0]?.updatedAt, updatedAt);
    assert.deepEqual(searches.slice(0, 2), [
      'is:open author:@me org:Acme sort:updated-desc',
      `is:merged author:@me org:Acme merged:>=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)} sort:updated-desc`,
    ]);
    const connection = connectControl<MergeFrame & { freshness?: { lastRefreshedAt: number | null; error: string | null } }>(createControlServer(controlDeps({ projects: [] }, {
      myPrs: wiring, githubStore,
    })));
    const searchCount = searches.length;
    await connection.send({ type: 'github-polling-refresh', requestId: 'refresh-my-prs', lane: 'my-prs' });
    assert.equal(searches.length, searchCount + 2);
    assert.equal(connection.sent.at(-1)?.ok, true);
    assert.deepEqual(connection.sent.at(-1)?.freshness, store.getSnapshot().freshness);
  } finally {
    await wiring.stopPoller();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('keep mergeable control reaches the real lane, persists across restarts, and does not dispatch the same head again', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-my-pr-keep-mergeable-'));
  const fixes: string[] = [];
  const statuses: ReturnType<typeof myPrsStatus>[] = [];
  let markRepairFinished = () => {};
  const repairFinished = new Promise<void>((resolve) => { markRepairFinished = resolve; });
  const github = {
    ...createPrGh(homeDir),
    viewer: async () => 'me',
    ...storeReads(() => [readyNode({ mergeable: 'CONFLICTING' })]),
    behindCounts: async () => new Map<string, number>(),
    reviewThreadsBatch: async () => new Map(),
    rateLimitWaitMs: async () => null,
  };
  async function startWiring() {
    let markPolled: () => void = () => {};
    const firstPoll = new Promise<void>((resolve) => { markPolled = resolve; });
    const store = createTestStore(github);
    const wiring = createMyPrsWiring({
      store, homeDir, config: { teamReview: { enabled: true, org: 'Acme' } }, github,
      log: { warn() {} },
      broadcast: (status) => { statuses.push(status); if (status.prs[0]?.keepMergeableAttempt?.outcome === 'pushed' && !status.prs[0]?.isKeepMergeableFixInFlight) markRepairFinished(); if (status.prs.length > 0 && !status.isRefreshing) markPolled(); },
      createPoller: (dependencies) => createMyPrsPoller({
        ...dependencies, firstTickDelayMs: () => 0,
        setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
      }),
      fixMergeability: async (pr) => { fixes.push(`${pr.key}@${pr.headRefOid}`); return { outcome: 'pushed' }; },
    });
    wiring.startPoller();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await store.refreshWatches(['my-prs-open', 'my-prs-merged']);
    await firstPoll;
    return wiring;
  }
  const wiring = await startWiring();
  try {
    const server = createControlServer(controlDeps({ projects: [] }, { myPrs: wiring }));
    const connection = connectControl<MergeFrame>(server);
    connection.sent.length = 0;
    const request = { type: 'my-pr-keep-mergeable', requestId: 'toggle-1', repo: 'Acme/app', number: 7, keepMergeable: true };
    await connection.send(request);
    assert.deepEqual(connection.sent.at(-1), { type: 'my-pr-keep-mergeable-result', requestId: 'toggle-1', key: KEY, ok: true });
    assert.equal(statuses.at(-1)?.prs[0]?.keepMergeable, true);
    assert.deepEqual(fixes, [`${KEY}@${SEEN_HEAD}`]);
    await repairFinished;
    const savedState = JSON.parse(await fs.readFile(path.join(homeDir, 'my-prs-state.json'), 'utf8'));
    assert.deepEqual(savedState, { keepMergeableKeys: [KEY], keepMergeableAttemptKeys: [`${KEY}@${SEEN_HEAD}`], mergeQueueKeys: [], keepMergeablePushedHeadKeys: [], keepMergeableAttempts: [{ key: KEY, headRefOid: SEEN_HEAD, baseRefOid: 'b'.repeat(40), outcome: 'pushed', at: statuses.at(-1)?.prs[0]?.keepMergeableAttempt?.at, consecutiveAttempts: 1 }] });
    await wiring.stopPoller();
    const restarted = await startWiring();
    try {
      assert.equal(statuses.at(-1)?.prs[0]?.keepMergeable, true);
      assert.equal(fixes.length, 1);
      const restartedServer = createControlServer(controlDeps({ projects: [] }, { myPrs: restarted }));
      const restartedConnection = connectControl<MergeFrame>(restartedServer);
      await restartedConnection.send({ ...request, requestId: 'toggle-off', keepMergeable: false });
      assert.equal(restartedConnection.sent.at(-1)?.ok, true);
      assert.equal(statuses.at(-1)?.prs[0]?.keepMergeable, false);
      await restartedConnection.send({ ...request, requestId: 'unknown', number: 8 });
      assert.equal(restartedConnection.sent.at(-1)?.ok, false);
      assert.match(restartedConnection.sent.at(-1)?.error ?? '', /tracked/);
      for (const keepMergeable of ['true', null, undefined]) {
        await restartedConnection.send({ ...request, requestId: 'malformed', keepMergeable });
        assert.equal(restartedConnection.sent.at(-1)?.type, 'my-pr-keep-mergeable-result');
        assert.equal(restartedConnection.sent.at(-1)?.requestId, 'malformed');
        assert.equal(restartedConnection.sent.at(-1)?.ok, false);
      }
      assert.equal(statuses.at(-1)?.prs[0]?.keepMergeable, false);
      assert.equal(fixes.length, 1);
    } finally {
      await restarted.stopPoller();
    }
  } finally {
    await wiring.stopPoller();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('keep mergeable control replies with its request ID when the lane is unavailable', async () => {
  const server = createControlServer(controlDeps({ projects: [] }));
  const connection = connectControl<MergeFrame>(server);
  await connection.send({ type: 'my-pr-keep-mergeable', requestId: 'unavailable', repo: 'Acme/app', number: 7, keepMergeable: true });
  assert.deepEqual(connection.sent.at(-1), { type: 'my-pr-keep-mergeable-result', requestId: 'unavailable', key: KEY, ok: false, error: 'My pull requests is not running' });
});

test('merge when ready control replies with its request ID when the lane is unavailable or the toggle is malformed', async () => {
  const server = createControlServer(controlDeps({ projects: [] }));
  const connection = connectControl<MergeFrame>(server);
  await connection.send({ type: 'my-pr-merge-when-ready', requestId: 'unavailable', repo: 'Acme/app', number: 7, mergeWhenReady: true });
  assert.deepEqual(connection.sent.at(-1), { type: 'my-pr-merge-when-ready-result', requestId: 'unavailable', key: KEY, ok: false, error: 'My pull requests is not running' });
  await connection.send({ type: 'my-pr-merge-when-ready', requestId: 'malformed', repo: 'Acme/app', number: 7, mergeWhenReady: 'yes' });
  assert.equal(connection.sent.at(-1)?.type, 'my-pr-merge-when-ready-result');
  assert.equal(connection.sent.at(-1)?.requestId, 'malformed');
  assert.equal(connection.sent.at(-1)?.ok, false);
});

test('merge when ready control reaches the real lane and persists the queue', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-my-pr-merge-when-ready-'));
  let markPolled: () => void = () => {};
  const firstPoll = new Promise<void>((resolve) => { markPolled = resolve; });
  const statuses: ReturnType<typeof myPrsStatus>[] = [];
  const github = {
    ...createPrGh(homeDir),
    viewer: async () => 'me',
    ...storeReads(() => [readyNode({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { nodes: [] } } } }] } })]),
    behindCounts: async () => new Map<string, number>(),
    reviewThreadsBatch: async () => new Map(),
    rateLimitWaitMs: async () => null,
  };
  const store = createTestStore(github);
  const wiring = createMyPrsWiring({
    store, homeDir, config: { teamReview: { enabled: true, org: 'Acme' } }, github, log: { warn() {} },
    broadcast: (status) => { statuses.push(status); if (status.prs.length > 0 && !status.isRefreshing) markPolled(); },
    createPoller: (dependencies) => createMyPrsPoller({ ...dependencies, firstTickDelayMs: () => 0, setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {} }),
  });
  wiring.startPoller();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await store.refreshWatches(['my-prs-open', 'my-prs-merged']);
    await firstPoll;
    const connection = connectControl<MergeFrame>(createControlServer(controlDeps({ projects: [] }, { myPrs: wiring })));
    await connection.send({ type: 'my-pr-merge-when-ready', requestId: 'queue-1', repo: 'Acme/app', number: 7, mergeWhenReady: true });
    assert.deepEqual(connection.sent.at(-1), { type: 'my-pr-merge-when-ready-result', requestId: 'queue-1', key: KEY, ok: true });
    assert.equal(statuses.at(-1)?.prs[0]?.mergeQueuePosition, 1);
    const savedState = JSON.parse(await fs.readFile(path.join(homeDir, 'my-prs-state.json'), 'utf8'));
    assert.deepEqual(savedState, { keepMergeableKeys: [], keepMergeableAttemptKeys: [], mergeQueueKeys: [KEY], keepMergeablePushedHeadKeys: [], keepMergeableAttempts: [] });
  } finally {
    await wiring.stopPoller();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

async function harness({ trackedPrs = [toMyPr(readyNode(), 0)], ghOutcome = { ok: true, out: '', err: '' }, prStateAfterMerge = MERGED_STATE }: { trackedPrs?: MyPr[]; ghOutcome?: CommandResult; prStateAfterMerge?: CommandResult } = {}) {
  const ghCalls: { command: string; args: string[] }[] = [];
  let refreshCount = 0;
  const requestedPrRefreshes: string[] = [];
  const github = createPrGh('/home', async (command, args) => {
    ghCalls.push({ command, args });
    return args[1] === 'graphql' ? prStateAfterMerge : ghOutcome;
  });
  const myPrs = createMyPrsWiring({
    store: { ...createTestStore(github), requestRefresh: (key: string) => { requestedPrRefreshes.push(key); } },
    config: { teamReview: { enabled: true, org: 'Acme' } },
    broadcast: () => {},
    log: { warn() {} },
    github,
    createPoller: ({ onTickComplete }) => ({
      start: async () => { onTickComplete(myPrsStatus({ ts: 1, configured: true, viewer: 'me', prs: trackedPrs })); },
      stop: async () => {},
      tick: async () => { refreshCount += 1; },
      rebuild: () => {},
      refresh: async () => { refreshCount += 1; return { ok: true }; },
      setKeepMergeable: async () => ({ ok: false, error: 'Not available in this merge fixture' }),
      setMergeWhenReady: async () => ({ ok: false, error: 'Not available in this merge fixture' }),
    }),
  });
  myPrs.startPoller();
  await new Promise((resolve) => setImmediate(resolve));
  const server = createControlServer(controlDeps({ projects: [] }, { myPrs }));
  const connection = connectControl<MergeFrame>(server);
  connection.sent.length = 0;
  return {
    send: (message: Record<string, unknown> = {}) => Promise.resolve(connection.send({
      type: 'my-pr-merge', requestId: 'merge-1', repo: 'Acme/app', number: 7, headRefOid: SEEN_HEAD, ...message,
    })),
    results: () => connection.sent.filter((frame) => frame.type === 'my-pr-merge-result'),
    ghCalls,
    requestedPrRefreshes,
    refreshCount: () => refreshCount,
  };
}

test('a ready pull request at the seen head is merged with the repository default method and pinned to that head', async () => {
  const h = await harness();
  await h.send();
  assert.deepEqual(h.ghCalls[0], { command: 'gh', args: ['pr', 'merge', '7', '--repo', 'Acme/app', '--squash', '--match-head-commit', SEEN_HEAD] });
  assert.deepEqual(h.results(), [{ type: 'my-pr-merge-result', requestId: 'merge-1', key: KEY, ok: true, kind: 'merged' }]);
  assert.equal(h.refreshCount(), 1);
  assert.deepEqual(h.requestedPrRefreshes, ['acme/app#7']);
});

test('a merge that GitHub only queues is reported as queued, not merged', async () => {
  const h = await harness({ prStateAfterMerge: mergeStateResponse('OPEN', true) });
  await h.send();
  assert.deepEqual(h.results(), [{ type: 'my-pr-merge-result', requestId: 'merge-1', key: KEY, ok: true, kind: 'queued' }]);
  assert.equal(h.refreshCount(), 1);
});

test('a merge for a head the poll no longer sees is refused without calling gh', async () => {
  const h = await harness({ trackedPrs: [toMyPr(readyNode({ headRefOid: NEWER_HEAD }), 0)] });
  await h.send();
  assert.deepEqual(h.ghCalls, []);
  assert.equal(h.results()[0]?.ok, false);
  assert.match(String(h.results()[0]?.error), /new commits/);
  assert.equal(h.refreshCount(), 0);
});

test('a pull request that is not ready is refused without calling gh', async () => {
  const failing = readyNode({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [] } } } }] } });
  const h = await harness({ trackedPrs: [toMyPr(failing, 0)] });
  await h.send();
  assert.deepEqual(h.ghCalls, []);
  assert.deepEqual(h.results(), [{ type: 'my-pr-merge-result', requestId: 'merge-1', key: KEY, ok: false, error: 'Checks are failing' }]);
});

test('a pull request outside the tracked list is refused without calling gh', async () => {
  const h = await harness();
  await h.send({ repo: 'Acme/other' });
  assert.deepEqual(h.ghCalls, []);
  assert.equal(h.results()[0]?.key, 'Acme/other#7');
  assert.match(String(h.results()[0]?.error), /not one of your tracked/);
});

test('a malformed merge request is answered with a failed result and never reaches gh', async () => {
  const h = await harness();
  await h.send({ headRefOid: 'main' });
  assert.deepEqual(h.ghCalls, []);
  assert.equal(h.results()[0]?.ok, false);
  assert.equal(h.results()[0]?.key, KEY);
});

test('a refused gh merge replies with its first error line and skips the refresh', async () => {
  const h = await harness({ ghOutcome: { ok: false, out: '', err: '\nX Pull request Acme/app#7 is not mergeable: the head commit changed.\nmore detail\n' } });
  await h.send();
  assert.equal(h.ghCalls.length, 1);
  assert.deepEqual(h.results(), [{ type: 'my-pr-merge-result', requestId: 'merge-1', key: KEY, ok: false, error: 'X Pull request Acme/app#7 is not mergeable: the head commit changed.' }]);
  assert.equal(h.refreshCount(), 0);
  assert.deepEqual(h.requestedPrRefreshes, []);
});

function queueMergeHarness(trackedPr: MyPr) {
  const mergeCommands: string[][] = [];
  let releaseManualMerge: () => void = () => {};
  const manualMergeReleased = new Promise<void>((resolve) => { releaseManualMerge = resolve; });
  let queueMerge: ((pr: MyPr) => Promise<{ ok: boolean; error?: string }>) | undefined;
  const github = createPrGh('/home', async (_command, args) => {
    if (args[1] === 'graphql') return MERGED_STATE;
    mergeCommands.push(args);
    await manualMergeReleased;
    return { ok: true, out: '', err: '' };
  });
  const myPrs = createMyPrsWiring({
    store: { ...createTestStore(github), requestRefresh: () => {} },
    config: { teamReview: { enabled: true, org: 'Acme' } }, broadcast: () => {}, log: { warn() {} }, github,
    createPoller: ({ onTickComplete, mergePr }) => {
      queueMerge = mergePr;
      return {
        start: async () => { onTickComplete(myPrsStatus({ ts: 1, configured: true, viewer: 'me', prs: [trackedPr] })); },
        stop: async () => {}, tick: async () => {}, rebuild: () => {}, refresh: async () => ({ ok: true }),
        setKeepMergeable: async () => ({ ok: false, error: 'Not available in this merge fixture' }),
        setMergeWhenReady: async () => ({ ok: false, error: 'Not available in this merge fixture' }),
      };
    },
  });
  myPrs.startPoller();
  return { myPrs, mergeCommands, releaseManualMerge, queueMerge: (pr: MyPr) => queueMerge?.(pr) };
}

test('a queue merge while a manual merge of the same pull request is in flight runs no second gh merge', async () => {
  const trackedPr = toMyPr(readyNode(), 0);
  const h = queueMergeHarness(trackedPr);
  await new Promise((resolve) => setImmediate(resolve));
  const manualMerge = h.myPrs.mergePr({ repo: 'Acme/app', number: 7, headRefOid: SEEN_HEAD });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.mergeCommands.length, 1);
  assert.deepEqual(await h.queueMerge(trackedPr), { ok: false, error: 'A merge for this pull request is already running' });
  assert.equal(h.mergeCommands.length, 1);
  h.releaseManualMerge();
  assert.deepEqual(await manualMerge, { ok: true, kind: 'merged' });
  await h.myPrs.stopPoller();
});

test('a queue merge goes through the same refusal gate as a manual merge', async () => {
  const failing = toMyPr(readyNode({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [] } } } }] } }), 0);
  const h = queueMergeHarness(failing);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await h.queueMerge(failing), { ok: false, error: 'Checks are failing' });
  assert.deepEqual(h.mergeCommands, []);
  await h.myPrs.stopPoller();
});

test('a head the queue holds for a Keep mergeable push can still be merged manually', async () => {
  const h = await harness({ trackedPrs: [{ ...toMyPr(readyNode(), 0), mergeQueuePosition: 1, isMergeQueueHeldForRepairPush: true }] });
  await h.send();
  assert.equal(h.ghCalls.filter((call) => call.args[1] === 'merge').length, 1);
  assert.deepEqual(h.results(), [{ type: 'my-pr-merge-result', requestId: 'merge-1', key: KEY, ok: true, kind: 'merged' }]);
});
