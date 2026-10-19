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
import type { GlimmervoidConfig } from '../server/config-store.ts';
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

test('repo checkpoints drive incremental closes, sixth-tick reconciliation and a manual full refresh', async () => {
  const tested = harness();
  try {
    await tested.poller.tick();
    tested.setRepoResponse(complete([{ ...issue, state: 'closed' }]));
    tested.advance();
    await tested.poller.tick();
    assert.deepEqual(tested.statuses.at(-1)?.issues, []);
    tested.setRepoResponse(complete([issue]));
    for (let tick = 3; tick <= 6; tick += 1) { tested.advance(); await tested.poller.tick(); }
    assert.deepEqual(tested.repoCalls, [null, new Date(NOW).toISOString(), new Date(NOW + 300000).toISOString(), new Date(NOW + 600000).toISOString(), new Date(NOW + 900000).toISOString(), null]);
    assert.deepEqual(await tested.poller.refresh(), { ok: true });
    assert.equal(tested.repoCalls.at(-1), null);
    assert.ok(tested.queries.includes('is:issue is:open assignee:@me archived:false'));
    assert.ok(tested.queries.includes('is:issue is:open team:acme/core archived:false'));
    for (const read of ['repo', 'search', 'linked'] as const) {
      const savedBeforeLimit = structuredClone(tested.saved());
      tested.setRepoResponse(complete([{ ...issue, updatedAt: new Date((savedBeforeLimit.lastSyncAt ?? NOW) + 1000).toISOString() }]));
      tested.limitRead(read);
      assert.deepEqual(await tested.poller.refresh(), { ok: false, error: 'Could not refresh from GitHub.' });
      const limitedStatus = tested.statuses.at(-1);
      assert.ok(limitedStatus);
      assert.equal(limitedStatus.nextAttemptAt, limitedStatus.ts + 120000);
      assert.deepEqual(tested.saved(), savedBeforeLimit);
      tested.limitRead(null);
      tested.advance();
      assert.deepEqual(await tested.poller.refresh(), { ok: true });
      assert.equal(tested.repoCalls.at(-1), null);
    }

  } finally {
    await tested.poller.stop();
  }
});

test('linked PR enrichment fetches only changed issues, retains failures, resumes from persisted checkpoints and rechecks pending PRs on reconcile ticks', async () => {
  const tested = harness();
  const pullRequest: IssuePullRequest = { number: 9, url: 'https://github.com/acme/app/pull/9', title: 'Fix reconnect', state: 'draft' };
  const secondIssue = { ...issue, key: 'acme/app#2', number: 2, url: 'https://github.com/acme/app/issues/2' };
  tested.setRepoResponse(complete([issue, secondIssue]));
  tested.setPullRequests(new Map([[issue.key, [pullRequest]]]));
  try {
    const crossRepoOpen: IssuePullRequest = { ...pullRequest, number: 10, url: 'https://github.com/Other/Library/pull/10', state: 'open' };
    tested.setPullRequests(new Map([[issue.key, [pullRequest]], [secondIssue.key, [
      crossRepoOpen,
      { ...pullRequest, number: 11, url: 'https://github.com/acme/app/pull/11', state: 'merged' },
      { ...pullRequest, number: 12, url: 'https://github.com/acme/app/pull/12', state: 'closed' },
      { ...pullRequest, url: 'https://example.com/acme/app/pull/9' },
    ]]]));
    await tested.poller.tick();
    await tested.poller.tick();
    assert.deepEqual(tested.watchedKeys.at(-1), { owner: 'issues-linked-prs', keys: ['acme/app#9', 'other/library#10'] });
    assert.deepEqual(tested.pullRequestCalls, [[issue.key, secondIssue.key]]);
    const changed = { ...issue, updatedAt: '2026-10-10T01:00:00Z' };
    tested.setRepoResponse(complete([changed, secondIssue]));
    tested.failPullRequests(true);
    await tested.poller.tick();
    assert.deepEqual(tested.pullRequestCalls.at(-1), [issue.key]);
    assert.deepEqual(tested.statuses.at(-1)?.issues[0].pullRequests, [pullRequest]);
    assert.equal(tested.saved().pullRequestsFetchedAt[issue.key], issue.updatedAt);
    assert.equal(tested.statuses.at(-1)?.error, null);
    assert.equal(tested.statuses.at(-1)?.retry, null);
    tested.failPullRequests(false);
    tested.setPullRequests(null);
    await tested.poller.tick();
    assert.deepEqual(tested.saved().issues[0].pullRequests, [pullRequest]);
    assert.equal(tested.saved().pullRequestsFetchedAt[issue.key], issue.updatedAt);
    assert.equal(tested.statuses.at(-1)?.error, null);
    tested.setPullRequests(new Map([[issue.key, []]]));
    await tested.poller.tick();
    assert.deepEqual(tested.saved().issues[0].pullRequests, []);
    assert.equal(tested.saved().pullRequestsFetchedAt[issue.key], changed.updatedAt);
    const restarted = harness(tested.saved());
    restarted.setRepoResponse(complete([changed, secondIssue]));
    try {
      await restarted.poller.tick();
      assert.deepEqual(restarted.pullRequestCalls, []);
    } finally {
      await restarted.poller.stop();
    }
    const savedWithDraft = { ...tested.saved(), issues: tested.saved().issues.map((row) => ({ ...row, pullRequests: row.key === issue.key ? [pullRequest] : [] })) };
    const reconciled = harness(savedWithDraft);
    reconciled.setRepoResponse(complete([changed, secondIssue]));
    try {
      await reconciled.poller.start();
      await reconciled.poller.tick();
      assert.deepEqual(reconciled.pullRequestCalls, [[issue.key]]);
      await reconciled.poller.refresh();
      assert.deepEqual(reconciled.pullRequestCalls.at(-1), [issue.key]);
    } finally {
      await reconciled.poller.stop();
    }
    const teamOnlyIssue = { ...issue, key: 'other/lib#5', repo: 'other/lib', number: 5, url: 'https://github.com/other/lib/issues/5' };
    const teamOnlyRow: CachedIssueRow = { ...cached, ...teamOnlyIssue, pullRequests: [pullRequest] };
    const teamOnly = harness({ ...emptyIssuesState(), issues: [teamOnlyRow], pullRequestsFetchedAt: { [teamOnlyIssue.key]: teamOnlyIssue.updatedAt } });
    teamOnly.setRepoResponse(complete());
    teamOnly.setTeamResponse(complete([teamOnlyIssue]));
    try {
      await teamOnly.poller.start();
      for (let tick = 2; tick <= 5; tick += 1) await teamOnly.poller.tick();
      assert.deepEqual(teamOnly.pullRequestCalls, []);
      await teamOnly.poller.tick();
      assert.deepEqual(teamOnly.pullRequestCalls, [[teamOnlyIssue.key]]);
    } finally {
      await teamOnly.poller.stop();
    }
  } finally {
    await tested.poller.stop();
  }
});

test('cap-limited repo and team fetches preserve rows and the repo checkpoint without failing the tick, then self-heal with a full fetch next tick', async () => {
  const tested = harness();
  try {
    await tested.poller.tick();
    const capLimited = { ...complete(), isComplete: false, error: 'GitHub issue search reached its pagination limit.' };
    tested.setRepoResponse(capLimited);
    tested.setTeamResponse(capLimited);
    tested.advance();
    await tested.poller.tick();
    assert.equal(tested.saved().perRepoSync['acme/app'].lastSyncAt, NOW);
    assert.deepEqual(tested.saved().issues[0].teams, ['acme/core']);
    assert.equal(tested.statuses.at(-1)?.error, null);
    assert.equal(tested.saved().lastSyncAt, NOW + 300000);
    assert.equal(tested.statuses.at(-1)?.retry ?? null, null);
    tested.setRepoResponse(complete([issue]));
    tested.advance();
    await tested.poller.tick();
    assert.deepEqual(tested.repoCalls, [null, new Date(NOW).toISOString(), null]);
    assert.equal(tested.saved().perRepoSync['acme/app'].needsFullReconcile, false);
    assert.equal(tested.statuses.at(-1)?.error, null);
  } finally {
    await tested.poller.stop();
  }
});

test('issues wiring resolves workspace members without enabling review lanes and serves its cached snapshot', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'issues-wiring-'));
  const statuses: IssuesStatus[] = [];
  const resolvedPaths: string[] = [];
  const fetchedRepos: string[] = [];
  let viewer: string | null = 'alice';
  const sessionIds = new Set(['live-session']);
  const config: GlimmervoidConfig = { projects: [{ id: 'workspace', name: 'workspace', path: '/workspace', repos: ['/repo/app', '/repo/docs'] }], github: { teams: ['acme/core'] } };
  const wiring = createIssuesWiring({
    config, hasSession: (id) => sessionIds.has(id),
    homeDir: directory, broadcast: (status) => { statuses.push(status); },
    gitWorkspace: { originUrl: async ({ projectPath }) => { resolvedPaths.push(projectPath); return `git@github.com:acme/${path.basename(projectPath)}.git`; } },
    store: {
      requestViewer: async () => ({ isRateLimited: false, value: viewer }),
      rateLimitWaitMs: async () => null,
      setWatchedKeys: () => {},
      requestIssueLinkedPullRequests: async (keys) => ({ isRateLimited: false, value: new Map(keys.map((key) => [key, []])) }),
      requestRepoIssues: async (repo) => { fetchedRepos.push(repo); return { isRateLimited: false, value: complete(repo === 'acme/app' ? [issue] : []) }; },
      requestIssueSearch: async () => ({ isRateLimited: false, value: complete() }),
    },
  });
  try {
    await createIssuesStateIo(path.join(directory, 'issues-cache.json'), { warn() {} }).writeState({ ...emptyIssuesState(), issues: [cached], lastSyncAt: NOW, perRepoSync: {} });
    await wiring.startPoller();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await wiring.refresh(), { ok: true });
    assert.deepEqual(resolvedPaths, ['/repo/app', '/repo/docs']);
    assert.deepEqual(fetchedRepos, ['acme/app', 'acme/docs']);
    assert.equal(wiring.getStatus().issues[0].projectId, 'workspace');
    assert.equal(statuses[0].lastSyncAt, NOW);
    assert.equal(statuses[0].issues[0].key, cached.key);
    await wiring.linkSession('Acme/App#1', 'live-session');
    assert.equal(statuses.at(-1)?.issues[0].sessionId, 'live-session');
    const linkedState = await createIssuesStateIo(path.join(directory, 'issues-cache.json'), { warn() {} }).readState();
    assert.deepEqual(linkedState.sessionLinks, { 'acme/app#1': 'live-session' });
    assert.equal('sessionId' in linkedState.issues[0], false);
    config.projects.push({ id: 'another-project', name: 'another', path: '/repo/app' });
    wiring.restartIfConfigChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await wiring.refresh(), { ok: true });
    assert.equal(wiring.getStatus().issues[0].sessionId, 'live-session');
    sessionIds.clear();
    assert.equal(wiring.getStatus().issues[0].sessionId, null);
    assert.equal(await wiring.getLinkedSessionId('acme/app#1'), null);
    await wiring.refresh();
    assert.deepEqual((await createIssuesStateIo(path.join(directory, 'issues-cache.json'), { warn() {} }).readState()).sessionLinks, {});
    config.projects = [];
    config.github = { teams: [] };
    viewer = null;
    wiring.restartIfConfigChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await wiring.refresh(), { ok: true });
    assert.equal(wiring.getStatus().configured, false);
    assert.match(wiring.getStatus().reason ?? '', /No GitHub sources/);
    assert.deepEqual(wiring.getStatus().issues, []);
  } finally {
    await wiring.stopPoller();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('issues wiring retries an unreadable cache and keeps links made while it was unreadable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'issues-wiring-retry-'));
  const statePath = path.join(directory, 'issues-cache.json');
  const wiring = createIssuesWiring({
    config: { projects: [] }, homeDir: directory, hasSession: () => true, broadcast: () => {},
    gitWorkspace: { originUrl: async () => null }, log: { warn() {} },
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
