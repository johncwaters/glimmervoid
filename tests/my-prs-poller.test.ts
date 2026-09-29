import test from 'node:test';
import assert from 'node:assert/strict';
import { createMyPrsPoller } from '../server/my-prs-poller.ts';
import type { MyPrSearchNode, MyPrsStatus } from '../shared/contracts/my-prs.ts';

const NOW = Date.parse('2026-09-28T12:00:00Z');
function node(state: 'OPEN' | 'MERGED'): MyPrSearchNode {
  return {
    __typename: 'PullRequest', number: state === 'OPEN' ? 1 : 2, title: 'Fix', url: `https://github.com/Acme/app/pull/${state === 'OPEN' ? 1 : 2}`,
    isDraft: false, state, createdAt: '2026-09-25T00:00:00Z', mergedAt: state === 'MERGED' ? '2026-09-28T10:00:00Z' : null,
    updatedAt: '2026-09-28T11:00:00Z', baseRefName: 'main', headRefOid: 'a'.repeat(40),
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app' },
    commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
  };
}

test('polls viewer once, compares open PRs sequentially, and keeps the last report on failure', async () => {
  const calls: string[] = [];
  const statuses: MyPrsStatus[] = [];
  let shouldFail = false;
  const poller = createMyPrsPoller({
    org: 'Acme', now: () => NOW, intervalMinutes: 1, onTickComplete: (status) => statuses.push(status),
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log: { warn() {} },
    github: {
      async viewer() { calls.push('viewer'); return 'alice'; },
      async searchMyPrs(org, mergedSince) {
        calls.push(`search:${org}:${mergedSince}`);
        if (shouldFail) return { ok: false, items: [], totalCount: 0, error: 'offline' };
        return { ok: true, items: [node('OPEN'), node('MERGED')], totalCount: 2, error: '' };
      },
      async behindBy(repo, base, headSha) {
        calls.push(`compare:${repo}:${base}:${headSha}`);
        return 3;
      },
      async reviewThreads(repo, number) {
        calls.push(`threads:${repo}#${number}`);
        return [];
      },
    },
  });
  await poller.start();
  assert.deepEqual(calls, ['viewer', 'search:Acme:2026-09-27', `compare:Acme/app:main:${'a'.repeat(40)}`]);
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
  let releaseCompare: (behindBy: number) => void = () => {};
  let signalCompareStarted: () => void = () => {};
  const compareStarted = new Promise<void>((resolve) => { signalCompareStarted = resolve; });
  const poller = createMyPrsPoller({
    org: 'Acme', now: () => NOW, intervalMinutes: 1, onTickComplete: (status) => statuses.push(status),
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log: { warn() {} },
    github: {
      async viewer() { return 'alice'; },
      async searchMyPrs() { return { ok: true, items: [node('OPEN')], totalCount: 1, error: '' }; },
      behindBy() {
        signalCompareStarted();
        return new Promise<number>((resolve) => { releaseCompare = resolve; });
      },
      async reviewThreads() { return []; },
    },
  });
  const started = poller.start();
  await compareStarted;
  await poller.stop();
  releaseCompare(3);
  await started;
  assert.deepEqual(statuses, []);
});

test('a search cut short reports a truncation note that survives a failed refresh', async () => {
  const statuses: MyPrsStatus[] = [];
  let shouldFail = false;
  const poller = createMyPrsPoller({
    org: 'Acme', now: () => NOW, intervalMinutes: 1, onTickComplete: (status) => statuses.push(status),
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log: { warn() {} },
    github: {
      async viewer() { return 'alice'; },
      async searchMyPrs() {
        if (shouldFail) return { ok: false, items: [], totalCount: 0, error: 'offline' };
        return { ok: true, items: [node('OPEN'), node('MERGED')], totalCount: 73, error: '' };
      },
      async behindBy() { return 0; },
      async reviewThreads() { return []; },
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
    org: 'Acme', now: () => NOW, intervalMinutes: 1, onTickComplete: (status) => statuses.push(status),
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log: { warn() {} },
    github: {
      async viewer() { return 'alice'; },
      async searchMyPrs() { return { ok: true, items: [openWithThread, openResolved, mergedWithThread], totalCount: 3, error: '' }; },
      async behindBy() { return 0; },
      async reviewThreads(repo, number) {
        threadRequests.push(`${repo}#${number}`);
        return [{
          isResolved: false, isOutdated: false, path: 'src/app.ts', line: 4,
          firstComment: { totalCount: 1, nodes: [{ author: { login: 'bob' }, bodyText: 'Rename this', url: 'https://github.com/Acme/app/pull/1#discussion_r1', createdAt: '2026-09-28T10:00:00Z' }] },
          lastComment: { nodes: [{ author: { login: 'bob' }, createdAt: '2026-09-28T10:00:00Z' }] },
        }];
      },
    },
  });
  await poller.start();
  assert.deepEqual(threadRequests, ['Acme/app#1']);
  const withThread = statuses[0].prs.find((pr) => pr.number === 1);
  assert.deepEqual(withThread?.threads.map((thread) => [thread.path, thread.author]), [['src/app.ts', 'bob']]);
  await poller.stop();
});
