import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIssuesPoller } from '../server/issues-poller.ts';
import { createIssuesStateIo, createIssuesWiring } from '../server/issues-wiring.ts';
import { emptyIssuesState } from '../server/core/issues-core.ts';
import type { GlimmervoidConfig } from '../server/config-store.ts';
import type { IssueRow, IssueUpdate, IssuesFetchResult, IssuesState, IssuesStatus } from '../shared/contracts/issues.ts';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const cached: IssueRow = {
  key: 'acme/app#1', repo: 'acme/app', number: 1, title: 'Fix reconnect', url: 'https://github.com/acme/app/issues/1',
  labels: [], assignees: ['alice'], author: 'bob', comments: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
  sources: ['team'], teams: ['acme/core'], projectId: null,
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
  const poller = createIssuesPoller({
    teams: ['acme/core'], now: () => timestamp,
    resolveProjects: async () => [{ repo: 'acme/app', projectId: 'project-1' }],
    readState: async () => saved,
    writeState: async (state) => { saved = state; },
    onTickComplete: (status) => { statuses.push(status); },
    setIntervalFn: timer, clearIntervalFn: () => {}, setTimeoutFn: timer, clearTimeoutFn: () => {}, log: { warn() {} },
    github: {
      viewer: async () => {
        assert.equal(statuses[0]?.issues[0]?.key, savedState.issues[0]?.key);
        return 'alice';
      },
      rateLimitWaitMs: async () => null,
      listRepoIssues: async (_repo, since) => { repoCalls.push(since); return repoResponse; },
      searchIssues: async (query) => {
        queries.push(query);
        if (query.includes('team:') && teamFailure) return { ok: false, items: [], isComplete: false, error: 'team offline' };
        return query.includes('team:') ? teamResponse : complete();
      },
    },
  });
  return {
    poller, statuses, repoCalls, queries, saved: () => saved,
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
    await stateIo.writeState({ issues: [cached], lastSyncAt: NOW - 300000, perRepoSync: {} });
    const saved = await createIssuesStateIo(path.join(directory, 'issues-cache.json'), { warn() {} }).readState();
    const tested = harness(saved);
    tested.failTeam();
    await tested.poller.start();
    assert.deepEqual(tested.statuses[0].issues, [cached]);
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
  const config: GlimmervoidConfig = { projects: [{ id: 'workspace', name: 'workspace', path: '/workspace', repos: ['/repo/app', '/repo/docs'] }], github: { teams: ['acme/core'] } };
  const wiring = createIssuesWiring({
    config,
    homeDir: directory, broadcast: (status) => { statuses.push(status); },
    gitWorkspace: { originUrl: async ({ projectPath }) => { resolvedPaths.push(projectPath); return `git@github.com:acme/${path.basename(projectPath)}.git`; } },
    github: {
      viewer: async () => viewer, rateLimitWaitMs: async () => null,
      listRepoIssues: async (repo) => { fetchedRepos.push(repo); return complete(repo === 'acme/app' ? [issue] : []); },
      searchIssues: async () => complete(),
    },
  });
  try {
    await createIssuesStateIo(path.join(directory, 'issues-cache.json'), { warn() {} }).writeState({ issues: [cached], lastSyncAt: NOW, perRepoSync: {} });
    await wiring.startPoller();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await wiring.refresh(), { ok: true });
    assert.deepEqual(resolvedPaths, ['/repo/app', '/repo/docs']);
    assert.deepEqual(fetchedRepos, ['acme/app', 'acme/docs']);
    assert.equal(wiring.getStatus().issues[0].projectId, 'workspace');
    assert.equal(statuses[0].lastSyncAt, NOW);
    assert.equal(statuses[0].issues[0].key, cached.key);
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
