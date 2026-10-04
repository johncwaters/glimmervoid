import test from 'node:test';
import assert from 'node:assert/strict';
import { createMyPrsPoller } from '../server/my-prs-poller.ts';
import type { MyPr, MyPrSearchNode, MyPrsState, MyPrsStatus } from '../shared/contracts/my-prs.ts';

const NOW = Date.parse('2026-09-28T12:00:00Z');
function node(state: 'OPEN' | 'MERGED'): MyPrSearchNode {
  return {
    __typename: 'PullRequest', id: 'PR_node', number: state === 'OPEN' ? 1 : 2, title: 'Fix', url: `https://github.com/Acme/app/pull/${state === 'OPEN' ? 1 : 2}`,
    isDraft: false, state, createdAt: '2026-09-25T00:00:00Z', mergedAt: state === 'MERGED' ? '2026-09-28T10:00:00Z' : null,
    updatedAt: '2026-09-28T11:00:00Z', baseRefName: 'main', headRefName: 'feature', isCrossRepository: false, headRefOid: 'a'.repeat(40), isInMergeQueue: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app', viewerDefaultMergeMethod: 'SQUASH' },
    commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
  };
}

function keepMergeableHarness({ savedState = { keepMergeableKeys: [], keepMergeableAttemptKeys: [] }, fixMergeability = async () => {}, beforeAttemptWrite = async () => {}, beforeStart }: {
  savedState?: MyPrsState;
  fixMergeability?: (pr: MyPr, signal: AbortSignal, onPushStarted: () => void) => Promise<void>;
  beforeAttemptWrite?: () => Promise<void>;
  beforeStart?: () => Promise<void>;
} = {}) {
  let items: MyPrSearchNode[] = [{ ...node('OPEN'), mergeable: 'CONFLICTING' }];
  let isSearchFailing = false;
  let unreturnedResultCount = 0;
  let saved = savedState;
  const statuses: MyPrsStatus[] = [];
  const fixes: string[] = [];
  const warnings: string[] = [];
  const github = {
    async viewer() { return 'alice'; },
    async searchMyPrs() {
      if (isSearchFailing) return { ok: false as const, items: [], totalCount: 0, error: 'offline' };
      return { ok: true as const, items, totalCount: items.length + unreturnedResultCount, error: '' };
    },
    async behindCounts() { return new Map(); },
    async reviewThreadsBatch() { return new Map(); },
    async rebasePr() { throw new Error('The keep mergeable path must not rebase'); },
    async rateLimitWaitMs() { return null; },
  };
  function createPoller() {
    return createMyPrsPoller({
      org: 'Acme', now: () => NOW, github, onTickComplete: (status) => { statuses.push(status); },
      log: { warn: (message: string) => { warnings.push(message); } },
      setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {}, beforeStart,
      readState: async () => saved,
      writeState: async (state) => {
        if (state.keepMergeableAttemptKeys.length > 0) await beforeAttemptWrite();
        saved = state;
      },
      fixMergeability: async (pr, signal, onPushStarted) => {
        assert.ok(saved.keepMergeableAttemptKeys.includes(`${pr.key}@${pr.headRefOid}`));
        fixes.push(`${pr.key}@${pr.headRefOid}`);
        await fixMergeability(pr, signal, onPushStarted);
      },
    });
  }
  return {
    createPoller, fixes, statuses, warnings, savedState: () => saved,
    setItems: (nextItems: MyPrSearchNode[]) => { items = nextItems; },
    failSearch: () => { isSearchFailing = true; },
    truncateSearch: (unreturnedCount: number) => { unreturnedResultCount = unreturnedCount; },
  };
}

test('keep mergeable toggles, dispatches once per head even after failure, survives restart, and retries a new head', async () => {
  const harness = keepMergeableHarness({ fixMergeability: async () => { throw new Error('Repair failed'); } });
  const poller = harness.createPoller();
  await poller.tick();
  assert.deepEqual(harness.fixes, []);
  assert.equal((await poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: true })).ok, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await poller.tick();
  assert.equal(harness.fixes.length, 1);
  assert.ok(harness.warnings.some((warning) => warning.includes('Repair failed')));
  assert.equal(harness.statuses.at(-1)?.prs[0]?.keepMergeable, true);
  await poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: false });
  await poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: true });
  assert.equal(harness.fixes.length, 1);
  await poller.stop();
  const restarted = harness.createPoller();
  await restarted.tick();
  assert.equal(harness.fixes.length, 1);
  assert.equal(harness.statuses.at(-1)?.prs[0]?.keepMergeable, true);
  harness.setItems([{ ...node('OPEN'), mergeable: 'CONFLICTING', headRefOid: 'b'.repeat(40) }]);
  await restarted.tick();
  assert.equal(harness.fixes.length, 2);
  await restarted.stop();
});

test('keep mergeable dispatches failing and error checks and leaves a merely behind PR alone', async () => {
  const harness = keepMergeableHarness({ savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] } });
  const poller = harness.createPoller();
  harness.setItems([{ ...node('OPEN'), mergeStateStatus: 'BEHIND' }]);
  await poller.tick();
  assert.deepEqual(harness.fixes, []);
  for (const state of ['FAILURE', 'ERROR'] as const) {
    harness.setItems([{ ...node('OPEN'), headRefOid: (state === 'FAILURE' ? 'b' : 'c').repeat(40), commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes: [] } } } }] } }]);
    await poller.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(harness.fixes.length, 2);
  await poller.stop();
});

test('keep mergeable retains saved flags during failed searches and prunes flags and attempts outside the displayed list', async () => {
  const harness = keepMergeableHarness({ savedState: { keepMergeableKeys: ['Acme/app#1', 'Acme/app#9'], keepMergeableAttemptKeys: [`Acme/app#9@${'a'.repeat(40)}`] } });
  const poller = harness.createPoller();
  await poller.tick();
  assert.deepEqual(harness.savedState().keepMergeableKeys, ['Acme/app#1']);
  assert.deepEqual(harness.savedState().keepMergeableAttemptKeys, [`Acme/app#1@${'a'.repeat(40)}`]);
  harness.setItems([]);
  await poller.tick();
  assert.deepEqual(harness.savedState(), { keepMergeableKeys: [], keepMergeableAttemptKeys: [] });
  harness.setItems([{ ...node('OPEN'), mergeable: 'CONFLICTING' }]);
  await poller.tick();
  await poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: true });
  harness.failSearch();
  await poller.refresh();
  assert.deepEqual(harness.savedState().keepMergeableKeys, ['Acme/app#1']);
  assert.equal(harness.statuses.at(-1)?.prs[0]?.keepMergeable, true);
  await poller.stop();
});

test('keep mergeable keeps flags and head attempts for PRs cut from a truncated search', async () => {
  const unlistedAttemptKey = `Acme/app#9@${'b'.repeat(40)}`;
  const harness = keepMergeableHarness({ savedState: { keepMergeableKeys: ['Acme/app#9'], keepMergeableAttemptKeys: [unlistedAttemptKey] } });
  harness.truncateSearch(60);
  const poller = harness.createPoller();
  await poller.tick();
  assert.deepEqual(harness.savedState(), { keepMergeableKeys: ['Acme/app#9'], keepMergeableAttemptKeys: [unlistedAttemptKey] });
  harness.truncateSearch(0);
  await poller.tick();
  assert.deepEqual(harness.savedState(), { keepMergeableKeys: [], keepMergeableAttemptKeys: [] });
  await poller.stop();
});

test('keep mergeable does not overlap a repair when a new head arrives and stop aborts the session', async () => {
  let repairSignal: AbortSignal | null = null;
  const harness = keepMergeableHarness({
    savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] },
    fixMergeability: async (_pr, signal) => {
      repairSignal = signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  });
  const poller = harness.createPoller();
  await poller.tick();
  harness.setItems([{ ...node('OPEN'), mergeable: 'CONFLICTING', headRefOid: 'b'.repeat(40) }]);
  await poller.tick();
  assert.equal(harness.fixes.length, 1);
  await poller.stop();
  assert.ok(repairSignal);
  assert.equal((repairSignal as AbortSignal).aborted, true);
});

test('stop returns within the drain cap even when a repair ignores its abort and never settles', async () => {
  const harness = keepMergeableHarness({
    savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] },
    fixMergeability: () => new Promise<void>(() => {}),
  });
  const poller = harness.createPoller();
  await poller.tick();
  await settleRepairs();
  assert.equal(harness.fixes.length, 1);
  const stopStartedAt = Date.now();
  await poller.stop();
  assert.ok(Date.now() - stopStartedAt < 10000);
});

function abortableRepair(signals: AbortSignal[]) {
  return async (_pr: MyPr, signal: AbortSignal) => {
    signals.push(signal);
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  };
}

async function settleRepairs(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('keep mergeable flag off cancels the running session, forgets its head attempt, and flag on repairs that same head again', async () => {
  const signals: AbortSignal[] = [];
  const headA = `Acme/app#1@${'a'.repeat(40)}`;
  const harness = keepMergeableHarness({ savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] }, fixMergeability: abortableRepair(signals) });
  const poller = harness.createPoller();
  await poller.tick();
  await settleRepairs();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  await poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: false });
  assert.equal(signals[0].aborted, true);
  await settleRepairs();
  assert.deepEqual(harness.savedState().keepMergeableAttemptKeys, []);
  await poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: true });
  await settleRepairs();
  assert.deepEqual(harness.fixes, [headA, headA]);
  assert.equal(signals[1].aborted, false);
  await poller.stop();
});

test('a repair stopped by shutdown forgets its head attempt so the next poller repairs that head', async () => {
  const signals: AbortSignal[] = [];
  const headA = `Acme/app#1@${'a'.repeat(40)}`;
  const harness = keepMergeableHarness({ savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] }, fixMergeability: abortableRepair(signals) });
  const poller = harness.createPoller();
  await poller.tick();
  await settleRepairs();
  assert.deepEqual(harness.savedState().keepMergeableAttemptKeys, [headA]);
  await poller.stop();
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(harness.savedState(), { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] });
  const restarted = harness.createPoller();
  await restarted.tick();
  await settleRepairs();
  assert.deepEqual(harness.fixes, [headA, headA]);
  await restarted.stop();
});

function repairAbortedAfterThePushStarted(signals: AbortSignal[]) {
  return async (_pr: MyPr, signal: AbortSignal, onPushStarted: () => void) => {
    signals.push(signal);
    onPushStarted();
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  };
}

test('a flag turned off after the hand-off push started keeps the head attempt so the same head is not repaired again', async () => {
  const signals: AbortSignal[] = [];
  const headA = `Acme/app#1@${'a'.repeat(40)}`;
  const harness = keepMergeableHarness({ savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] }, fixMergeability: repairAbortedAfterThePushStarted(signals) });
  const poller = harness.createPoller();
  await poller.tick();
  await settleRepairs();
  await poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: false });
  assert.equal(signals[0].aborted, true);
  await settleRepairs();
  assert.deepEqual(harness.savedState().keepMergeableAttemptKeys, [headA]);
  await poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: true });
  await settleRepairs();
  assert.deepEqual(harness.fixes, [headA]);
  await poller.stop();
});

test('a shutdown during the hand-off push keeps the head attempt so the next poller does not repair that head again', async () => {
  const signals: AbortSignal[] = [];
  const headA = `Acme/app#1@${'a'.repeat(40)}`;
  const harness = keepMergeableHarness({ savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] }, fixMergeability: repairAbortedAfterThePushStarted(signals) });
  const poller = harness.createPoller();
  await poller.tick();
  await settleRepairs();
  await poller.stop();
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(harness.savedState(), { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [headA] });
  const restarted = harness.createPoller();
  await restarted.tick();
  await settleRepairs();
  assert.deepEqual(harness.fixes, [headA]);
  await restarted.stop();
});

test('a repair whose cleanup outlasts the stop drain cap has its head attempt forgotten before stop returns', async () => {
  let finishSlowCleanup: () => void = () => {};
  const slowCleanupFinished = new Promise<void>((resolve) => { finishSlowCleanup = resolve; });
  const harness = keepMergeableHarness({
    savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] },
    fixMergeability: async (_pr, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 4500));
      finishSlowCleanup();
    },
  });
  const poller = harness.createPoller();
  await poller.tick();
  await settleRepairs();
  assert.equal(harness.fixes.length, 1);
  await poller.stop();
  assert.deepEqual(harness.savedState(), { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] });
  await slowCleanupFinished;
  await settleRepairs();
  assert.deepEqual(harness.savedState(), { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] });
});

test('a finished repair keeps its head attempt so the same head is not repaired again', async () => {
  const headA = `Acme/app#1@${'a'.repeat(40)}`;
  const harness = keepMergeableHarness({ savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] } });
  const poller = harness.createPoller();
  await poller.tick();
  await settleRepairs();
  await poller.tick();
  await settleRepairs();
  assert.deepEqual(harness.fixes, [headA]);
  await poller.stop();
  assert.deepEqual(harness.savedState().keepMergeableAttemptKeys, [headA]);
});

function heldAttemptWrite() {
  let markStarted: () => void = () => {};
  let release: () => void = () => {};
  let isHeld = true;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return {
    started,
    release: () => { isHeld = false; release(); },
    beforeAttemptWrite: async () => {
      if (!isHeld) return;
      markStarted();
      await released;
    },
  };
}

test('a flag turned off while the attempt save is in flight never starts the repair and forgets the attempt', async () => {
  const held = heldAttemptWrite();
  const headA = `Acme/app#1@${'a'.repeat(40)}`;
  const harness = keepMergeableHarness({ savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] }, beforeAttemptWrite: held.beforeAttemptWrite });
  const poller = harness.createPoller();
  const ticking = poller.tick();
  await held.started;
  const turnedOff = poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: false });
  held.release();
  await ticking;
  await turnedOff;
  await settleRepairs();
  assert.deepEqual(harness.fixes, []);
  assert.deepEqual(harness.savedState(), { keepMergeableKeys: [], keepMergeableAttemptKeys: [] });
  await poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: true });
  await settleRepairs();
  assert.deepEqual(harness.fixes, [headA]);
  await poller.stop();
});

test('a flag turned off and on while the attempt save is in flight still repairs that head', async () => {
  const held = heldAttemptWrite();
  const headA = `Acme/app#1@${'a'.repeat(40)}`;
  const harness = keepMergeableHarness({ savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] }, beforeAttemptWrite: held.beforeAttemptWrite });
  const poller = harness.createPoller();
  const ticking = poller.tick();
  await held.started;
  const turnedOff = poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: false });
  const turnedOn = poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: true });
  held.release();
  await ticking;
  await Promise.all([turnedOff, turnedOn]);
  await settleRepairs();
  await poller.tick();
  await settleRepairs();
  assert.deepEqual(harness.fixes, [headA]);
  assert.deepEqual(harness.savedState().keepMergeableAttemptKeys, [headA]);
  await poller.stop();
});

test('start runs the leftover sweep before the first poll', async () => {
  const order: string[] = [];
  const { github } = viewerLookupGithub(['alice']);
  const poller = createMyPrsPoller({
    org: 'Acme', now: () => NOW, onTickComplete: () => {}, log: { warn() {} },
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    github: { ...github, viewer: async () => { order.push('poll'); return 'alice'; } },
    beforeStart: async () => { order.push('sweep'); },
  });
  await poller.start();
  assert.deepEqual(order, ['sweep', 'poll']);
  await poller.stop();
});

test('a refresh or flag change during the leftover sweep starts no repair until the sweep finishes', async () => {
  let finishSweep = () => {};
  const sweepFinished = new Promise<void>((resolve) => { finishSweep = resolve; });
  const harness = keepMergeableHarness({ savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] }, beforeStart: () => sweepFinished });
  const poller = harness.createPoller();
  const started = poller.start();
  await poller.refresh();
  await poller.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.fixes, []);
  finishSweep();
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.fixes, [`Acme/app#1@${'a'.repeat(40)}`]);
  await poller.stop();
});

test('keep mergeable cancels the running session when its PR is pruned from the list or merged', async () => {
  for (const nextItems of [[], [{ ...node('MERGED'), number: 1 }]]) {
    const signals: AbortSignal[] = [];
    const harness = keepMergeableHarness({ savedState: { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [] }, fixMergeability: abortableRepair(signals) });
    const poller = harness.createPoller();
    await poller.tick();
    await settleRepairs();
    assert.equal(signals[0]?.aborted, false);
    harness.setItems(nextItems);
    await poller.tick();
    assert.equal(signals[0].aborted, true);
    await poller.stop();
  }
});

test('keep mergeable refuses untracked or merged PRs and malformed persisted state fails closed', async () => {
  const harness = keepMergeableHarness();
  harness.setItems([node('MERGED')]);
  const poller = harness.createPoller();
  await poller.tick();
  assert.equal((await poller.setKeepMergeable({ repo: 'Acme/app', number: 9, keepMergeable: true })).ok, false);
  assert.equal((await poller.setKeepMergeable({ repo: 'Acme/app', number: 2, keepMergeable: true })).ok, false);
  assert.deepEqual(harness.savedState().keepMergeableKeys, []);
  await poller.stop();
  const { github } = viewerLookupGithub(['alice']);
  const invalid = createMyPrsPoller({ org: 'Acme', github, readState: async () => ({ keepMergeableKeys: ['bad'] }), onTickComplete: () => {}, log: { warn() {} } });
  await invalid.tick();
  await assert.rejects(invalid.setKeepMergeable({ repo: 'Acme/app', number: 1, keepMergeable: true }));
  await invalid.stop();
});

test('polls viewer once, compares open PRs sequentially, and keeps the last report on failure', async () => {
  const calls: string[] = [];
  const statuses: MyPrsStatus[] = [];
  let shouldFail = false;
  const poller = createMyPrsPoller({
    org: 'Acme', now: () => NOW, intervalMinutes: 1, onTickComplete: (status) => { if (!status.isRefreshing) statuses.push(status); },
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log: { warn() {} },
    github: {
      async viewer() { calls.push('viewer'); return 'alice'; },
      async searchMyPrs(org, mergedSince) {
        calls.push(`search:${org}:${mergedSince}`);
        if (shouldFail) return { ok: false, items: [], totalCount: 0, error: 'offline' };
        return { ok: true, items: [node('OPEN'), node('MERGED')], totalCount: 2, error: '' };
      },
      async behindCounts(prs) {
        calls.push(`compare:${prs.map((pr) => `${pr.repo}#${pr.number}@${pr.headSha}`).join(',')}`);
        return new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, 3]));
      },
      async reviewThreadsBatch(prs) {
        calls.push(`threads:${prs.map((pr) => `${pr.repo}#${pr.number}`).join(',')}`);
        return new Map();
      },
      async rebasePr() { calls.push('rebase'); return { ok: true, err: '' }; },
      async rateLimitWaitMs() { return null; },
    },
  });
  await poller.start();
  assert.deepEqual(calls, ['viewer', 'search:Acme:2026-09-27', `compare:Acme/app#1@${'a'.repeat(40)}`]);
  assert.equal(statuses[0].viewer, 'alice');
  assert.equal(statuses[0].truncatedNote, null);
  assert.deepEqual(statuses[0].prs.map((pr) => [pr.number, pr.behindBy]), [[1, 3], [2, null]]);
  shouldFail = true;
  await poller.tick();
  assert.equal(statuses[1].error, 'offline');
  assert.deepEqual(statuses[1].prs, statuses[0].prs);
  assert.equal(calls.filter((call) => call === 'viewer').length, 1);
  await poller.stop();
});

test('a stop during an in-flight tick emits no status afterward', async () => {
  const statuses: MyPrsStatus[] = [];
  let releaseCompare: (counts: Map<string, number>) => void = () => {};
  let signalCompareStarted: () => void = () => {};
  const compareStarted = new Promise<void>((resolve) => { signalCompareStarted = resolve; });
  const poller = createMyPrsPoller({
    org: 'Acme', now: () => NOW, intervalMinutes: 1, onTickComplete: (status) => { if (!status.isRefreshing) statuses.push(status); },
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log: { warn() {} },
    github: {
      async viewer() { return 'alice'; },
      async searchMyPrs() { return { ok: true, items: [node('OPEN')], totalCount: 1, error: '' }; },
      behindCounts() {
        signalCompareStarted();
        return new Promise<Map<string, number>>((resolve) => { releaseCompare = resolve; });
      },
      async reviewThreadsBatch() { return new Map(); },
      async rebasePr() { return { ok: true, err: '' }; },
      async rateLimitWaitMs() { return null; },
    },
  });
  const started = poller.start();
  await compareStarted;
  await poller.stop();
  releaseCompare(new Map([['Acme/app#1', 3]]));
  await started;
  assert.deepEqual(statuses, []);
});

test('a search cut short reports a truncation note that survives a failed refresh', async () => {
  const statuses: MyPrsStatus[] = [];
  let shouldFail = false;
  const poller = createMyPrsPoller({
    org: 'Acme', now: () => NOW, intervalMinutes: 1, onTickComplete: (status) => { if (!status.isRefreshing) statuses.push(status); },
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log: { warn() {} },
    github: {
      async viewer() { return 'alice'; },
      async searchMyPrs() {
        if (shouldFail) return { ok: false, items: [], totalCount: 0, error: 'offline' };
        return { ok: true, items: [node('OPEN'), node('MERGED')], totalCount: 73, error: '' };
      },
      async behindCounts(prs) { return new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, 0])); },
      async reviewThreadsBatch() { return new Map(); },
      async rebasePr() { return { ok: true, err: '' }; },
      async rateLimitWaitMs() { return null; },
    },
  });
  await poller.start();
  assert.equal(statuses[0].truncatedNote, 'Showing the 2 most recently updated of 73 pull requests.');
  shouldFail = true;
  await poller.tick();
  assert.equal(statuses[1].truncatedNote, statuses[0].truncatedNote);
  await poller.stop();
});

test('fetches thread detail only for open pull requests with unresolved threads', async () => {
  const threadRequests: string[] = [];
  const statuses: MyPrsStatus[] = [];
  const openWithThread = { ...node('OPEN'), reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false }] } };
  const openResolved = { ...node('OPEN'), number: 3, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: true }] } };
  const mergedWithThread = { ...node('MERGED'), reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false }] } };
  const poller = createMyPrsPoller({
    org: 'Acme', now: () => NOW, intervalMinutes: 1, onTickComplete: (status) => { if (!status.isRefreshing) statuses.push(status); },
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log: { warn() {} },
    github: {
      async viewer() { return 'alice'; },
      async searchMyPrs() { return { ok: true, items: [openWithThread, openResolved, mergedWithThread], totalCount: 3, error: '' }; },
      async behindCounts(prs) { return new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, 0])); },
      async rebasePr() { return { ok: true, err: '' }; },
      async rateLimitWaitMs() { return null; },
      async reviewThreadsBatch(prs) {
        threadRequests.push(...prs.map((pr) => `${pr.repo}#${pr.number}`));
        return new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, [{
          isResolved: false, isOutdated: false, path: 'src/app.ts', line: 4,
          firstComment: { totalCount: 1, nodes: [{ author: { login: 'bob' }, bodyText: 'Rename this', url: 'https://github.com/Acme/app/pull/1#discussion_r1', createdAt: '2026-09-28T10:00:00Z' }] },
          lastComment: { nodes: [{ author: { login: 'bob' }, createdAt: '2026-09-28T10:00:00Z' }] },
        }]]));
      },
    },
  });
  await poller.start();
  assert.deepEqual(threadRequests, ['Acme/app#1']);
  const withThread = statuses[0].prs.find((pr) => pr.number === 1);
  assert.deepEqual(withThread?.threads.map((thread) => [thread.path, thread.author]), [['src/app.ts', 'bob']]);
  await poller.stop();
});

function autoRebaseHarness({ shouldAutoRebase, rebaseResult }: { shouldAutoRebase: boolean; rebaseResult: { ok: boolean; err: string } }) {
  const rebases: string[] = [];
  const statuses: MyPrsStatus[] = [];
  const poller = createMyPrsPoller({
    org: 'Acme', shouldAutoRebase, now: () => NOW, intervalMinutes: 1, onTickComplete: (status) => { if (!status.isRefreshing) statuses.push(status); },
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log: { warn() {} },
    github: {
      async viewer() { return 'alice'; },
      async searchMyPrs() { return { ok: true, items: [node('OPEN'), node('MERGED')], totalCount: 2, error: '' }; },
      async behindCounts(prs) { return new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, 4])); },
      async reviewThreadsBatch() { return new Map(); },
      async rebasePr(pullRequestId, expectedHeadSha) {
        rebases.push(`${pullRequestId}@${expectedHeadSha}`);
        return rebaseResult;
      },
      async rateLimitWaitMs() { return null; },
    },
  });
  return { poller, rebases, statuses };
}

test('auto-rebase rebases a behind open pull request pinned to its polled head and reports it', async () => {
  const { poller, rebases, statuses } = autoRebaseHarness({ shouldAutoRebase: true, rebaseResult: { ok: true, err: '' } });
  await poller.start();
  assert.deepEqual(rebases, [`PR_node@${'a'.repeat(40)}`]);
  assert.deepEqual(statuses[0].prs.map((pr) => [pr.number, pr.autoRebase?.outcome ?? null]), [[1, 'rebased'], [2, null]]);
  assert.equal(statuses[0].prs[0]?.autoRebase?.message, 'Rebased onto main');
  await poller.stop();
});

test('a failed auto-rebase is reported and not retried at the same head', async () => {
  const { poller, rebases, statuses } = autoRebaseHarness({ shouldAutoRebase: true, rebaseResult: { ok: false, err: 'gh: Protected branch update failed\nmore' } });
  await poller.start();
  await poller.tick();
  assert.equal(rebases.length, 1);
  assert.deepEqual(statuses.map((status) => status.prs[0]?.autoRebase), [
    { outcome: 'failed', at: NOW, message: 'gh: Protected branch update failed' },
    { outcome: 'failed', at: NOW, message: 'gh: Protected branch update failed' },
  ]);
  await poller.stop();
});

test('a failed auto-rebase record is dropped once a new head no longer needs a rebase', async () => {
  const statuses: MyPrsStatus[] = [];
  let currentHead = 'a'.repeat(40);
  const poller = createMyPrsPoller({
    org: 'Acme', shouldAutoRebase: true, now: () => NOW, intervalMinutes: 1, onTickComplete: (status) => { if (!status.isRefreshing) statuses.push(status); },
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log: { warn() {} },
    github: {
      async viewer() { return 'alice'; },
      async searchMyPrs() { return { ok: true, items: [{ ...node('OPEN'), headRefOid: currentHead }], totalCount: 1, error: '' }; },
      async behindCounts(prs) { return new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, pr.headSha === 'a'.repeat(40) ? 4 : 0])); },
      async reviewThreadsBatch() { return new Map(); },
      async rebasePr() { return { ok: false, err: 'gh: Protected branch update failed' }; },
      async rateLimitWaitMs() { return null; },
    },
  });
  await poller.start();
  currentHead = 'c'.repeat(40);
  await poller.tick();
  assert.deepEqual(statuses.map((status) => status.prs[0]?.autoRebase?.outcome ?? null), ['failed', null]);
  await poller.stop();
});

test('auto-rebase off never rebases', async () => {
  const { poller, rebases, statuses } = autoRebaseHarness({ shouldAutoRebase: false, rebaseResult: { ok: true, err: '' } });
  await poller.start();
  assert.deepEqual(rebases, []);
  assert.equal(statuses[0].prs[0]?.autoRebase, undefined);
  await poller.stop();
});

test('a failed search during an exhausted GitHub rate limit backs off until the reset', async () => {
  const warnings: string[] = [];
  const poller = createMyPrsPoller({
    org: 'Acme', now: () => NOW, intervalMinutes: 1, onTickComplete: () => {},
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log: { warn: (message: string) => { warnings.push(message); } },
    github: {
      async viewer() { return 'alice'; },
      async searchMyPrs() { return { ok: false, items: [], totalCount: 0, error: 'API rate limit exceeded' }; },
      async behindCounts() { return new Map(); },
      async reviewThreadsBatch() { return new Map(); },
      async rebasePr() { return { ok: true, err: '' }; },
      async rateLimitWaitMs(nowMs) { return nowMs === NOW ? 900_000 : null; },
    },
  });
  await poller.start();
  assert.ok(warnings.some((message) => /backing off 900s/.test(message)), warnings.join('\n'));
  await poller.stop();
});

test('a reported wait of a full hour backs off for the whole GitHub rate-limit window', async () => {
  const warnings: string[] = [];
  const poller = createMyPrsPoller({
    org: 'Acme', now: () => NOW, intervalMinutes: 1, onTickComplete: () => {},
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log: { warn: (message: string) => { warnings.push(message); } },
    github: {
      async viewer() { return 'alice'; },
      async searchMyPrs() { return { ok: false, items: [], totalCount: 0, error: 'API rate limit exceeded' }; },
      async behindCounts() { return new Map(); },
      async reviewThreadsBatch() { return new Map(); },
      async rebasePr() { return { ok: true, err: '' }; },
      async rateLimitWaitMs() { return 60 * 60_000; },
    },
  });
  await poller.start();
  assert.ok(warnings.some((message) => /backing off 3600s/.test(message)), warnings.join('\n'));
  await poller.stop();
});

test('a rejected viewer lookup publishes its error and schedule, then manual refresh recovers', async () => {
  const statuses: MyPrsStatus[] = [];
  let viewerCalls = 0;
  let searchCalls = 0;
  const poller = createMyPrsPoller({
    org: 'Acme', now: () => NOW, onTickComplete: (status) => statuses.push(status),
    log: { warn() {} },
    github: {
      viewer: async () => {
        viewerCalls += 1;
        if (viewerCalls === 1) throw new Error('error connecting to api.github.com');
        return 'alice';
      },
      searchMyPrs: async () => { searchCalls += 1; return { ok: true, items: [node('OPEN')], totalCount: 1, error: '' }; },
      behindCounts: async () => new Map(), reviewThreadsBatch: async () => new Map(),
      rebasePr: async () => ({ ok: true, err: '' }), rateLimitWaitMs: async () => null,
    },
  });
  await poller.tick();
  assert.equal(searchCalls, 0);
  assert.equal(statuses[0]?.isRefreshing, true);
  assert.equal(statuses.at(-1)?.error, 'error connecting to api.github.com');
  assert.equal(statuses.at(-1)?.nextAttemptAt, NOW + 10_000);
  assert.deepEqual(statuses.at(-1)?.retry, { attempt: 1, limit: 3 });
  assert.equal((await poller.refresh()).ok, true);
  assert.equal(viewerCalls, 2);
  assert.equal(statuses.at(-1)?.error, null);
  assert.equal(statuses.at(-1)?.nextAttemptAt, null);
  assert.equal(statuses.at(-1)?.retry, null);
  assert.equal(statuses.at(-1)?.prs.length, 1);
  await poller.stop();
});

function viewerLookupGithub(viewerLogins: (string | null)[], searchError = '') {
  const calls = { viewer: 0, search: 0 };
  const github = {
    viewer: async () => { calls.viewer += 1; return viewerLogins.shift() ?? null; },
    searchMyPrs: async () => {
      calls.search += 1;
      if (searchError) return { ok: false as const, items: [], totalCount: 0, error: searchError };
      return { ok: true as const, items: [node('OPEN')], totalCount: 1, error: '' };
    },
    behindCounts: async () => new Map<string, number>(), reviewThreadsBatch: async () => new Map(),
    rebasePr: async () => ({ ok: true, err: '' }), rateLimitWaitMs: async () => null,
  };
  return { calls, github };
}

test('a viewer lookup that resolves to nothing reports an error and is looked up again on refresh', async () => {
  const statuses: MyPrsStatus[] = [];
  const { calls, github } = viewerLookupGithub([null, 'alice']);
  const poller = createMyPrsPoller({ org: 'Acme', now: () => NOW, onTickComplete: (status) => statuses.push(status), log: { warn() {} }, github });
  await poller.tick();
  assert.equal(calls.search, 0);
  assert.equal(statuses.at(-1)?.error, 'Could not look up your GitHub account.');
  assert.deepEqual(statuses.at(-1)?.retry, { attempt: 1, limit: 3 });
  assert.equal((await poller.refresh()).ok, true);
  assert.equal(calls.viewer, 2);
  assert.equal(statuses.at(-1)?.viewer, 'alice');
  assert.equal(statuses.at(-1)?.error, null);
  await poller.stop();
});

test('a viewer lookup that resolves to a login is not repeated on later ticks', async () => {
  const { calls, github } = viewerLookupGithub(['alice']);
  const poller = createMyPrsPoller({ org: 'Acme', now: () => NOW, onTickComplete: () => {}, log: { warn() {} }, github });
  await poller.tick();
  assert.equal((await poller.refresh()).ok, true);
  assert.equal(calls.viewer, 1);
  assert.equal(calls.search, 2);
  await poller.stop();
});

test('a GitHub secondary rate limit on search waits a minute with no quick retries and refuses refresh', async () => {
  const statuses: MyPrsStatus[] = [];
  const { calls, github } = viewerLookupGithub(['alice'], 'HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.');
  const poller = createMyPrsPoller({ org: 'Acme', now: () => NOW, onTickComplete: (status) => statuses.push(status), log: { warn() {} }, github });
  await poller.tick();
  assert.equal(statuses.at(-1)?.retry, null);
  assert.equal(statuses.at(-1)?.nextAttemptAt, NOW + 60_000);
  assert.equal((await poller.refresh()).ok, false);
  assert.equal(calls.search, 1);
  await poller.stop();
});
