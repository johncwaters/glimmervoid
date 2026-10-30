import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIssuesPoller } from '../server/github/issues-poller.ts';
import { createIssuesStateIo, createIssuesWiring } from '../server/github/issues-wiring.ts';
import { emptyIssuesState } from '../server/github/core/issues-core.ts';
import { createGithubClock } from '../server/github/github-clock.ts';
import { createGithubStoreWiring } from '../server/github/github-store-wiring.ts';
import { createPrGh } from '../server/github/pr-gh.ts';
import type { CachedIssueRow, IssuePullRequest, IssueUpdate, IssuesFetchResult, IssuesState, IssuesStatus } from '../shared/contracts/issues.ts';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const cached: CachedIssueRow = {
  key: 'acme/app#1', repo: 'acme/app', number: 1, title: 'Fix reconnect', url: 'https://github.com/acme/app/issues/1',
  labels: [], assignees: ['alice'], author: 'bob', comments: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
  sources: ['team'], teams: ['acme/core'], projectId: null, pullRequests: [],
};
const { sources: _sources, teams: _teams, projectId: _projectId, ...issueFields } = cached;
const issue: IssueUpdate = { ...issueFields, state: 'open' };
const complete = (items: IssueUpdate[] = []): IssuesFetchResult => ({ ok: true, items, isComplete: true, error: '' });
const timer = () => ({ unref() {} }) as NodeJS.Timeout;

function harness(savedState: IssuesState = emptyIssuesState()) {
  let saved = savedState;
  const statuses: IssuesStatus[] = [];
  const repoCalls: (string | null)[] = [];
  const queries: string[] = [];
  let timestamp = NOW;
  let teamFailure = false;
  let repoResponse = complete([issue]);
  let teamResponse = complete([issue]);
  const pullRequestCalls: string[][] = [];
  let pullRequestsByIssue: Map<string, IssuePullRequest[]> | null = new Map();
  let hasPullRequestFailure = false;
  let rateLimitedRead: 'repo' | 'search' | 'linked' | null = null;
  const watchedKeys: { owner: string; keys: readonly string[] }[] = [];
  const poller = createIssuesPoller({
    teams: ['acme/core'], now: () => timestamp,
    resolveProjects: async () => [{ repo: 'acme/app', projectId: 'project-1' }],
    readState: async () => saved,
    writeState: async (state) => { saved = state; },
    onTickComplete: (status) => { statuses.push(status); },
    setIntervalFn: timer, clearIntervalFn: () => {}, setTimeoutFn: timer, clearTimeoutFn: () => {}, log: { warn() {} },
    store: {
      requestViewer: async () => {
        assert.equal(statuses[0]?.issues[0]?.key, savedState.issues[0]?.key);
        return { isRateLimited: false, value: 'alice' };
      },
      rateLimitWaitMs: async () => null,
      setWatchedKeys: (owner, keys) => { watchedKeys.push({ owner, keys }); },
      requestIssueLinkedPullRequests: async (keys, mode) => {
        assert.equal(mode, 'no-wait');
        if (rateLimitedRead === 'linked') return { isRateLimited: true, waitMs: 120000 };
        pullRequestCalls.push([...keys]);
        if (hasPullRequestFailure) throw new Error('PR fetch offline');
        if (!pullRequestsByIssue) return { isRateLimited: false, value: new Map() };
        const cachedPullRequests = pullRequestsByIssue;
        return { isRateLimited: false, value: new Map(keys.map((key) => [key, cachedPullRequests.get(key) ?? []])) };
      },
      requestRepoIssues: async (_repo, since, maxIssues, mode) => {
        assert.equal(mode, 'no-wait');
        assert.equal(maxIssues, 300);
        repoCalls.push(since);
        if (rateLimitedRead === 'repo') return { isRateLimited: true, waitMs: 120000 };
        return { isRateLimited: false, value: repoResponse };
      },
      requestIssueSearch: async (query, mode) => {
        assert.equal(mode, 'no-wait');
        queries.push(query);
        if (rateLimitedRead === 'search') return { isRateLimited: true, waitMs: 120000 };
        if (query.includes('team:') && teamFailure) return { isRateLimited: false, value: { ok: false, items: [], isComplete: false, error: 'team offline' } };
        return { isRateLimited: false, value: query.includes('team:') ? teamResponse : complete() };
      },
    },
  });
  return {
    poller, statuses, repoCalls, queries, pullRequestCalls, watchedKeys,
    limitRead: (read: typeof rateLimitedRead) => { rateLimitedRead = read; },
    saved: () => saved,
    setPullRequests: (pullRequests: Map<string, IssuePullRequest[]> | null) => { pullRequestsByIssue = pullRequests; },
    failPullRequests: (shouldFail: boolean) => { hasPullRequestFailure = shouldFail; },
    advance: () => { timestamp += 5 * 60000; },
    failTeam: () => { teamFailure = true; },
    setRepoResponse: (response: IssuesFetchResult) => { repoResponse = response; },
    setTeamResponse: (response: IssuesFetchResult) => { teamResponse = response; },
  };
}

test('cached issues broadcast before first fetch and a failing team search retains team membership on disk', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'issues-poller-'));
  const stateIo = createIssuesStateIo(path.join(directory, 'issues-cache.json'), { warn() {} });
  try {
    await stateIo.writeState({ ...emptyIssuesState(), issues: [cached], lastSyncAt: NOW - 300000, perRepoSync: {} });
    const saved = await createIssuesStateIo(path.join(directory, 'issues-cache.json'), { warn() {} }).readState();
    const tested = harness(saved);
    tested.failTeam();
    await tested.poller.start();
    assert.deepEqual(tested.statuses[0].issues, [{ ...cached, sessionId: null }]);
    assert.equal(tested.statuses.at(-1)?.issues[0].teams[0], 'acme/core');
    assert.deepEqual(tested.statuses.at(-1)?.issues[0].sources, ['team', 'project']);
    assert.match(tested.statuses.at(-1)?.error ?? '', /team offline/);
    assert.equal(tested.saved().lastSyncAt, saved.lastSyncAt);
    await stateIo.writeState(tested.saved());
    assert.deepEqual((await createIssuesStateIo(path.join(directory, 'issues-cache.json'), { warn() {} }).readState()).issues, tested.saved().issues);
    await tested.poller.stop();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('issues wiring retries an unreadable cache and keeps links made while it was unreadable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'issues-wiring-retry-'));
  const statePath = path.join(directory, 'issues-cache.json');
  const wiring = createIssuesWiring({
    config: { projects: [] }, homeDir: directory, hasSession: () => true, broadcast: () => {},
    gitWorkspace: { originUrl: async () => null }, log: { warn() {} }, github: { setIssueState: async () => ({ ok: true, err: '' }) },
    store: {
      requestViewer: async () => ({ isRateLimited: false, value: null }),
      rateLimitWaitMs: async () => null,
      setWatchedKeys: () => {},
      requestIssueLinkedPullRequests: async () => ({ isRateLimited: false, value: new Map() }),
      requestRepoIssues: async () => ({ isRateLimited: false, value: complete() }),
      requestIssueSearch: async () => ({ isRateLimited: false, value: complete() }),
    },
  });
  try {
    await fs.mkdir(statePath);
    await wiring.linkSession('acme/app#1', 'session-made-while-unreadable');
    await fs.rm(statePath, { recursive: true });
    await createIssuesStateIo(statePath, { warn() {} }).writeState({ ...emptyIssuesState(), sessionLinks: { 'acme/app#2': 'session-on-disk' } });
    assert.equal(await wiring.getLinkedSessionId('acme/app#2'), 'session-on-disk');
    assert.equal(await wiring.getLinkedSessionId('acme/app#1'), 'session-made-while-unreadable');
    assert.deepEqual((await createIssuesStateIo(statePath, { warn() {} }).readState()).sessionLinks, {
      'acme/app#1': 'session-made-while-unreadable', 'acme/app#2': 'session-on-disk',
    });
  } finally {
    await wiring.stopPoller();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a tick on the shared GitHub clock reads through the gated store without deadlocking the clock', async () => {
  const listedRepos: string[] = [];
  const github = {
    ...createPrGh(os.tmpdir(), async () => ({ ok: false, out: '', err: 'unexpected gh call' })),
    viewer: async () => 'alice', rateLimitWaitMs: async () => null,
    listRepoIssues: async (repo: string) => { listedRepos.push(repo); return complete([issue]); },
    searchIssues: async () => complete(), issueLinkedPullRequests: async () => new Map<string, IssuePullRequest[]>(),
  };
  const clock = createGithubClock({ baseIntervalMs: 60000, setIntervalFn: timer, clearIntervalFn: () => {}, log: { warn() {} } });
  const githubStore = createGithubStoreWiring({ github, clock, isDashboardConnected: () => false, broadcast: () => {}, log: { warn() {} } });
  const poller = createIssuesPoller({
    teams: [], resolveProjects: async () => [{ repo: 'acme/app', projectId: 'project-1' }], store: githubStore.laneStore, clock,
    readState: async () => emptyIssuesState(), writeState: async () => {}, onTickComplete: () => {},
    setIntervalFn: timer, clearIntervalFn: () => {}, setTimeoutFn: timer, clearTimeoutFn: () => {}, log: { warn() {} },
  });
  const deadlockTimeoutMs = 2000;
  let deadlockTimer: NodeJS.Timeout | undefined;
  const deadlocked = new Promise<string>((resolve) => { deadlockTimer = setTimeout(() => resolve('deadlocked'), deadlockTimeoutMs); });
  try {
    assert.equal(await Promise.race([poller.tick().then(() => 'resolved'), deadlocked]), 'resolved');
    assert.equal(await Promise.race([clock.exclusive(async () => 'resolved'), deadlocked]), 'resolved');
    assert.deepEqual(listedRepos, ['acme/app']);
  } finally {
    clearTimeout(deadlockTimer);
    await poller.stop();
  }
});
