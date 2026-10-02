import test from 'node:test';
import assert from 'node:assert/strict';
import { createMyPrsPoller } from '../server/my-prs-poller.ts';
import type { MyPrSearchNode, MyPrsStatus } from '../shared/contracts/my-prs.ts';

const NOW = Date.parse('2026-09-28T12:00:00Z');
function node(state: 'OPEN' | 'MERGED'): MyPrSearchNode {
  return {
    __typename: 'PullRequest', id: 'PR_node', number: state === 'OPEN' ? 1 : 2, title: 'Fix', url: `https://github.com/Acme/app/pull/${state === 'OPEN' ? 1 : 2}`,
    isDraft: false, state, createdAt: '2026-09-25T00:00:00Z', mergedAt: state === 'MERGED' ? '2026-09-28T10:00:00Z' : null,
    updatedAt: '2026-09-28T11:00:00Z', baseRefName: 'main', headRefOid: 'a'.repeat(40), isInMergeQueue: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app', viewerDefaultMergeMethod: 'SQUASH' },
    commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
  };
}

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
