import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIssuesListing } from '../cloud/watchees/issues/issues-listing.ts';
import { createIssuesPoller } from '../server/github/issues-poller.ts';
import { createIssuesStateIo, createIssuesWiring } from '../server/github/issues-wiring.ts';
import { emptyIssuesState } from '../server/github/core/issues-core.ts';
import { createGithubClock } from '../server/github/github-clock.ts';
import { createGithubStoreWiring } from '../server/github/github-store-wiring.ts';
import { createGithubStorePoller } from '../server/github/github-store-poller.ts';
import { createPrGh } from '../server/github/pr-gh.ts';
import type { CachedIssueRow, IssuePullRequest, IssueUpdate, IssuesStatus } from '../shared/contracts/issues.ts';
import { waitFor } from './helpers/wait-for.ts';

const cached: CachedIssueRow = {
  key: 'acme/app#1', repo: 'acme/app', number: 1, title: 'Fix reconnect', url: 'https://github.com/acme/app/issues/1',
  labels: [], assignees: ['alice'], author: 'bob', isAuthorOrgMember: null, comments: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
  sources: ['team'], teams: ['acme/core'], projectId: null, pullRequests: [],
};
const timer = () => ({ unref() {} }) as NodeJS.Timeout;
const noIssueReads = {
  requestIssueLinkedPullRequests: async () => assert.fail('the server read issues of its own'),
  setWatchedKeys: () => {}, rateLimitWaitMs: async () => null,
};

function openIssue(repo: string, number: number): IssueUpdate {
  return {
    key: `${repo}#${number}`, repo, number, title: `Issue ${number}`, url: `https://github.com/${repo}/issues/${number}`, labels: [],
    assignees: ['alice'], author: 'bob', isAuthorOrgMember: null, comments: 0, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', state: 'open',
  };
}

function watcherStore(github: { issuePage: (pagePath: string, etag: string | null) => Promise<Awaited<ReturnType<ReturnType<typeof createPrGh>['issuePage']>>>; issueLinkedPullRequests: (keys: readonly string[]) => Promise<Map<string, IssuePullRequest[]>> }) {
  return createGithubStorePoller({
    github: {
      ...github,
      async viewer() { return 'alice'; },
      async searchIssues() { return { ok: true, isComplete: true, error: '', items: [openIssue('acme/infra', 3)] }; },
      async searchPrsLight() { assert.fail('Unexpected PR search'); },
      async prsLightByKey() { assert.fail('Unexpected PR read'); },
      async prDetails() { assert.fail('Unexpected PR details'); },
      async notificationsSince() { return { kind: 'unchanged' as const }; },
      async behindCounts() { return new Map(); },
      async reviewThreadsBatch() { return new Map(); },
      async rateLimitWaitMs() { return null; },
      async viewPr() { assert.fail('Unexpected PR view'); },
      async prDiff() { assert.fail('Unexpected PR diff'); },
      async prHead() { assert.fail('Unexpected PR head'); },
    },
    now: Date.now, isDashboardConnected: () => true, exclusive: (work) => work(),
    setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout, log: { warn() {} },
  });
}

test('issue lists from the watcher fill the Issues tab with project, assigned and team issues, an unchanged page costs a 304 and no linked pull request read, a failed source shows its error, and a closed issue stays gone after Refresh', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'issues-watchee-'));
  const sentValidators: (string | undefined)[] = [];
  const linkedPullRequestReads: string[][] = [];
  let isAssignedListingDown = false;
  const linkedPullRequest: IssuePullRequest = { number: 9, url: 'https://github.com/acme/app/pull/9', title: 'Reconnect', state: 'open' };
  const listing = createIssuesListing({
    now: () => Date.parse('2026-11-06T12:00:00Z'),
    store: watcherStore({
      async issuePage(pagePath, etag) {
        sentValidators.push(etag ?? undefined);
        if (pagePath.startsWith('issues?') && isAssignedListingDown) return { kind: 'error', message: 'gh HTTP 502' };
        if (etag !== null) return { kind: 'unchanged' };
        if (pagePath.startsWith('repos/acme/app/issues')) return { kind: 'ok', etag: '"app"', nextPath: null, issues: [openIssue('acme/app', 1)] };
        return { kind: 'ok', etag: '"assigned"', nextPath: null, issues: [openIssue('acme/other', 2)] };
      },
      async issueLinkedPullRequests(keys) {
        linkedPullRequestReads.push([...keys]);
        return new Map(keys.map((key) => [key, key === 'acme/app#1' ? [linkedPullRequest] : []]));
      },
    }),
  });
  const statuses: IssuesStatus[] = [];
  const wiring = createIssuesWiring({
    config: { projects: [{ id: 'project-1', name: 'App', path: '/work/app' }], issues: { enabled: true }, github: { teams: ['acme/core'] } },
    homeDir, hasSession: () => true, broadcast: (status) => { statuses.push(status); },
    gitWorkspace: { originUrl: async () => 'git@github.com:acme/app.git' }, log: { warn() {} },
    github: { setIssueState: async () => ({ ok: true, err: '' }) },
    store: { ...noIssueReads, requestIssueLinkedPullRequests: async () => ({ isRateLimited: false, value: new Map() }) },
  });
  const deliverLists = async () => {
    const listed = await listing.list({ enabled: true, projectRepos: await wiring.watchedProjectRepos(), teams: ['acme/core'], intervalMinutes: 5 });
    assert.ok(listed.ok);
    for (const payload of listed.payloads) await wiring.acceptListing({ payload });
  };
  const sourcesByKey = () => Object.fromEntries((statuses.at(-1)?.issues ?? []).map((issue) => [issue.key, issue.sources]));
  try {
    await wiring.startPoller();
    await deliverLists();
    await waitFor(() => Object.keys(sourcesByKey()).length === 3, 'all three issue sources were listed', 3000);
    assert.deepEqual(sourcesByKey(), { 'acme/app#1': ['project'], 'acme/other#2': ['me'], 'acme/infra#3': ['team'] });
    assert.deepEqual(statuses.at(-1)?.issues.find((issue) => issue.key === 'acme/app#1')?.pullRequests, [linkedPullRequest]);
    assert.equal(statuses.at(-1)?.error, null);
    await deliverLists();
    assert.deepEqual(sentValidators, [undefined, undefined, '"app"', '"assigned"']);
    assert.equal(linkedPullRequestReads.length, 1);
    assert.equal(Object.keys(sourcesByKey()).length, 3);
    await wiring.setIssueState({ repo: 'acme/app', number: 1, state: 'closed' });
    await wiring.refresh();
    assert.deepEqual(Object.keys(sourcesByKey()).sort(), ['acme/infra#3', 'acme/other#2']);
    isAssignedListingDown = true;
    await deliverLists();
    await waitFor(() => /Assigned to you: gh HTTP 502/.test(statuses.at(-1)?.error ?? ''), 'the failed assigned listing was shown', 3000);
    assert.ok(sourcesByKey()['acme/other#2']);
  } finally {
    await wiring.stopPoller();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('issues wiring retries an unreadable cache and keeps links made while it was unreadable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'issues-wiring-retry-'));
  const statePath = path.join(directory, 'issues-cache.json');
  const wiring = createIssuesWiring({
    config: { projects: [] }, homeDir: directory, hasSession: () => true, broadcast: () => {},
    gitWorkspace: { originUrl: async () => null }, log: { warn() {} }, github: { setIssueState: async () => ({ ok: true, err: '' }) },
    store: noIssueReads,
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

test('a refresh on the shared GitHub clock re-reads held issues through the gated store without deadlocking the clock', async () => {
  const linkedPullRequestReads: string[][] = [];
  const github = {
    ...createPrGh(os.tmpdir(), async () => ({ ok: false, out: '', err: 'unexpected gh call' })),
    viewer: async () => 'alice', rateLimitWaitMs: async () => null,
    issueLinkedPullRequests: async (keys: readonly string[]) => { linkedPullRequestReads.push([...keys]); return new Map<string, IssuePullRequest[]>(); },
  };
  const clock = createGithubClock({ baseIntervalMs: 60000, setIntervalFn: timer, clearIntervalFn: () => {}, log: { warn() {} } });
  const githubStore = createGithubStoreWiring({ github, clock, isDashboardConnected: () => false, broadcast: () => {}, log: { warn() {} } });
  const poller = createIssuesPoller({
    teams: [], resolveProjects: async () => [], store: githubStore.laneStore, clock,
    latestListings: () => [], feedSilenceMs: () => 0,
    readState: async () => ({ ...emptyIssuesState(), issues: [cached] }), writeState: async () => {}, onTickComplete: () => {},
    setIntervalFn: timer, clearIntervalFn: () => {}, setTimeoutFn: timer, clearTimeoutFn: () => {}, log: { warn() {} },
  });
  const deadlockTimeoutMs = 2000;
  let deadlockTimer: NodeJS.Timeout | undefined;
  const deadlocked = new Promise<string>((resolve) => { deadlockTimer = setTimeout(() => resolve('deadlocked'), deadlockTimeoutMs); });
  try {
    assert.equal(await Promise.race([poller.refresh().then(() => 'resolved'), deadlocked]), 'resolved');
    assert.equal(await Promise.race([clock.exclusive(async () => 'resolved'), deadlocked]), 'resolved');
    assert.deepEqual(linkedPullRequestReads, [['acme/app#1']]);
  } finally {
    clearTimeout(deadlockTimer);
    await poller.stop();
  }
});
