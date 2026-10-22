import type { PrGh } from '../server/github/pr-gh.ts';
import test from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';

import { threadNode, THREAD_BASE } from './helpers/team-review-thread-fixture.ts';
import { THREAD_PLACEHOLDER_ERROR } from '../server/github/core/team-review-threads-core.ts';
import { DEFAULT_RE_REVIEW_AFTER_HOURS, DEFAULT_SKIP_IDLE_AFTER_DAYS, MAX_ASKED_FOR_REVIEWS, MAX_REVIEW_ATTEMPTS, POSTED_RETENTION_MS, errorDraft, readyDraft } from '../server/github/core/team-review-core.ts';
import { createTeamReviewPoller as createLanePoller } from '../server/github/team-review-poller.ts';
import type { reviewSnapshotFromGithubPr } from '../server/github/core/team-review-core.ts';
import { createGithubStorePoller } from '../server/github/github-store-poller.ts';
import { createSerialQueue } from '../server/spawn-gate.ts';
import { comparablePrKey, GithubPrDetailNode, GithubPrLightSearchNode } from '../shared/contracts/github-prs.ts';
import type { SpawnReviewArgs, TeamReviewGithub, TeamReviewPollerDependencies } from '../server/github/team-review-poller.ts';
import { PrDetail, TeamReviewStateEntry, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import type { ReviewDraft, TeamReviewState, TeamReviewStatus as TeamReviewStatusType } from '../shared/contracts/team-review.ts';

const SearchedPr = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  draft: z.boolean().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  repository_url: z.string(),
  user: z.object({ login: z.string(), type: z.enum(['User', 'Bot']) }).passthrough(),
  pull_request: z.object({}).passthrough(),
}).passthrough();
type SearchedPr = z.infer<typeof SearchedPr>;

const REPO = 'Acme/app';
const HEAD_ONE = '1'.repeat(40);
const HEAD_TWO = '2'.repeat(40);
const RESUMABLE = { sessionId: 'claude-1', workDir: '/work', worktreePath: '/tree', head: HEAD_ONE, deadlineAt: 9000, savedAt: 1000 };

function searchItem(number: number, author: string, overrides: Record<string, unknown> = {}) {
  return SearchedPr.parse({
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    repository_url: `https://api.github.com/repos/${REPO}`,
    user: { login: author, type: 'User' },
    pull_request: {},
    ...overrides,
  });
}

function prDetail(number: number, head: string, overrides: Record<string, unknown> = {}) {
  return PrDetail.parse({
    number, title: `PR ${number}`, body: 'Change', url: `https://github.com/${REPO}/pull/${number}`,
    author: { login: 'teammate' }, isDraft: false, isCrossRepository: false,
    baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefOid: head,
    additions: 3, deletions: 1, files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }],
    ...overrides,
  });
}

function draftFor({ candidate, detail, tier, reasons }: SpawnReviewArgs): ReviewDraft {
  return readyDraft({
    candidate, tier, reasons,
    result: { verdict: 'APPROVE', head: detail.headRefOid, summary: 'fine', assessment: null, findings: [] },
  });
}

interface FakeGithub extends TeamReviewGithub, Pick<Parameters<typeof createGithubStorePoller>[0]['github'], 'searchPrsLight' | 'prsLightByKey' | 'prDetails' | 'viewPr' | 'prHead' | 'rateLimitWaitMs'>, Pick<PrGh, 'viewer' | 'teamProfile' | 'teamMembers'>, Partial<Pick<Parameters<typeof createGithubStorePoller>[0]['github'], 'teamReviewThreads' | 'teamReviewCompare'>> {
  readTeamRequested(org: string, team: string): Promise<{ items: SearchedPr[]; complete: boolean }>;
  readDirectRequested(org: string): Promise<{ items: SearchedPr[]; complete: boolean }>;
  readAuthoredBy(org: string, logins: string[]): Promise<{ items: SearchedPr[]; complete: boolean }>;
  checksStates: Map<number, 'FAILURE' | 'SUCCESS' | 'PENDING'>;
  directRequested: SearchedPr[];
  isDirectRequestedComplete: boolean;
  requested: SearchedPr[];
  authored: SearchedPr[];
  isRequestedComplete: boolean;
  isAuthoredComplete: boolean;
  heads: Map<number, string>;
  reviews: Map<number, (Omit<ReturnType<typeof reviewSnapshotFromGithubPr>['reviews'][number], 'submittedAt'> & { submittedAt?: string | null })[]>;
  decisions: Map<number, NonNullable<ReturnType<typeof reviewSnapshotFromGithubPr>['reviewDecision']>>;
  snapshotBatches: number[][];
  closedNumbers: Set<number>;
  authoredQueries: string[][];
  failViewer: boolean;
  rateLimitWait: number | null;
}

function fakeGithub(): FakeGithub {
  const github: FakeGithub = {
    checksStates: new Map(),
    directRequested: [],
    isDirectRequestedComplete: true,
    requested: [],
    authored: [],
    isRequestedComplete: true,
    isAuthoredComplete: true,
    heads: new Map(),
    reviews: new Map(),
    decisions: new Map(),
    snapshotBatches: [],
    closedNumbers: new Set(),
    authoredQueries: [],
    failViewer: false,
    rateLimitWait: null,
    rateLimitWaitMs: async () => github.rateLimitWait,
    viewer: async () => (github.failViewer ? null : 'me'),
    teamProfile: async () => ({ org: 'Acme', slug: 'core', name: 'Core', avatarUrl: 'https://avatars.githubusercontent.com/t/1' }),
    teamMembers: async () => ['me', 'teammate', 'other'],
    readDirectRequested: async () => ({ items: github.directRequested, complete: github.isDirectRequestedComplete }),
    readTeamRequested: async () => ({ items: github.requested, complete: github.isRequestedComplete }),
    readAuthoredBy: async (_org, logins) => {
      github.authoredQueries.push(logins);
      return { items: github.authored, complete: github.isAuthoredComplete };
    },
    viewPr: async (_repo, number) => {
      const head = github.heads.get(number);
      return head ? prDetail(number, head) : null;
    },
    prHead: async (_repo, number) => github.heads.get(number) ?? null,
    searchPrsLight: async (qualifiers) => {
      const org = qualifiers.match(/(?:^| )org:(\S+)/)?.[1] ?? '';
      const team = qualifiers.match(/team-review-requested:[^/]+\/(\S+)/)?.[1];
      const authors = [...qualifiers.matchAll(/(?:^| )author:(\S+)/g)].map((match) => match[1]);
      if (qualifiers.startsWith('repo:')) {
        const number = Number(qualifiers.split(' ')[1]);
        return { ok: true, items: github.heads.has(number) ? [GithubPrLightSearchNode.parse(storeNode(searchItem(number, 'teammate')))] : [], isComplete: true, error: '' };
      }
      const search = await (team ? github.readTeamRequested(org, team) : authors.length > 0 ? github.readAuthoredBy(org, authors) : github.readDirectRequested(org));
      return { ok: true, items: search.items.map((item) => GithubPrLightSearchNode.parse(storeNode(item))), isComplete: search.complete, error: '' };
    },
    prsLightByKey: async (references) => {
      const itemsByNumber = new Map([...github.directRequested, ...github.requested, ...github.authored].map((item) => [item.number, item]));
      return new Map(references.flatMap((reference) => {
        if (!github.heads.has(reference.number) && !itemsByNumber.has(reference.number)) return [];
        const node = storeNode(itemsByNumber.get(reference.number) ?? searchItem(reference.number, 'teammate'));
        return [[comparablePrKey(reference), GithubPrLightSearchNode.parse(node)] as const];
      }));
    },
    prDetails: async (references) => {
      github.snapshotBatches.push(references.map((reference) => reference.number));
      const itemsByKey = new Map([...github.directRequested, ...github.requested, ...github.authored].map((item) => [item.number, item]));
      return new Map(references.flatMap((reference) => {
        if (!github.heads.has(reference.number)) return [];
        const node = storeNode(itemsByKey.get(reference.number) ?? searchItem(reference.number, 'teammate'));
        return [[comparablePrKey(reference), node] as const];
      }));
    },
  };
  let searchSequence = 0;
  function storeNode(item: SearchedPr): GithubPrDetailNode {
    searchSequence += 1;
    const reviews = github.reviews.get(item.number) ?? [];
    const repo = new URL(item.repository_url).pathname.replace('/repos/', '');
    return GithubPrDetailNode.parse({
      __typename: 'PullRequest', id: `PR_${item.number}`, number: item.number, title: item.title, url: item.html_url,
      author: { login: item.user.login, __typename: item.user.type }, labels: { nodes: [] }, comments: { totalCount: 0 },
      isDraft: item.draft ?? false, state: github.closedNumbers.has(item.number) ? 'CLOSED' : 'OPEN',
      createdAt: item.created_at ?? '', updatedAt: item.updated_at ?? new Date(searchSequence).toISOString(), mergedAt: null,
      baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefName: 'feature', headRefOid: github.heads.get(item.number) ?? HEAD_ONE,
      isCrossRepository: false, isInMergeQueue: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      repository: { nameWithOwner: repo, viewerDefaultMergeMethod: 'SQUASH' }, reviewDecision: github.decisions.get(item.number) ?? null,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: github.checksStates.get(item.number) ?? null, contexts: { nodes: [] } } } }] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] },
      latestReviews: { nodes: reviews.map((review) => ({ author: { login: review.login }, state: review.state, submittedAt: review.submittedAt ?? null, commit: review.commit ? { oid: review.commit } : null })) },
      latestOpinionatedReviews: { nodes: [] }, writerOpinionatedReviews: { nodes: [] },
    });
  }
  return github;
}

function setup(overrides: Partial<Omit<TeamReviewPollerDependencies, 'github' | 'store'>> & { github?: FakeGithub } = {}) {
  const github = overrides.github ?? fakeGithub();
  const writes: TeamReviewState[] = [];
  const statuses: TeamReviewStatusType[] = [];
  const spawned: SpawnReviewArgs[] = [];
  let nowMs = 1000;
  const queue = createSerialQueue();
  const storePoller = createGithubStorePoller({
    now: () => nowMs, isDashboardConnected: () => true, exclusive: (work) => queue.run(work),
    setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout, log: { warn() {} },
    github: {
      ...github,
      viewer: () => github.viewer(),
      teamProfile: (org, slug) => github.teamProfile(org, slug),
      teamMembers: (org, slug) => github.teamMembers(org, slug),
      searchPrsLight: (qualifiers) => github.searchPrsLight(qualifiers),
      prsLightByKey: (references) => github.prsLightByKey(references),
      prDetails: (references) => github.prDetails(references),
      async notificationsSince() { return { kind: 'unchanged' }; },
      async behindCounts() { return new Map(); },
      async reviewThreadsBatch() { return new Map(); },
      viewPr: (repo, number) => github.viewPr(repo, number),
      async prDiff() { assert.fail('Unexpected store PR diff'); },
      prHead: (repo, number) => github.prHead(repo, number),
      teamReviewThreads: (prs) => github.teamReviewThreads?.(prs) ?? Promise.resolve(new Map()),
      teamReviewCompare: (repo, base, head) => github.teamReviewCompare?.(repo, base, head) ?? Promise.resolve({ ok: true, comparison: null }),
    },
  });
  const registeredWatches: Parameters<typeof storePoller.registerWatch>[0][] = [];
  const unregisteredWatches: string[] = [];
  const store: TeamReviewPollerDependencies['store'] = {
    ...storePoller,
    requestTeamMembers: async (org, slug, mode) => {
      if (org === dependencies.teams[0]?.org && slug === dependencies.teams[0]?.slug) await refreshStore();
      return storePoller.requestTeamMembers(org, slug, mode);
    },
    registerWatch: (watch) => { registeredWatches.push(watch); storePoller.registerWatch(watch); },
    unregisterWatch: (name) => { unregisteredWatches.push(name); storePoller.unregisterWatch(name); },
    subscribe: (event, listener) => {
      storePoller.events.on(event, listener);
      return () => { storePoller.events.off(event, listener); };
    },
  };
  const refreshStore = () => store.refreshWatches(Object.keys(store.getSnapshot().watches));
  const dependencies: TeamReviewPollerDependencies = {
    org: 'Acme', store,
    clock: { exclusive: (work) => queue.run(work), schedule: () => () => {} },
    teams: [{ org: 'Acme', slug: 'core' }],
    github,
    spawnReview: async (args) => { spawned.push(args); return draftFor(args); },
    writeState: async (state) => { writes.push(structuredClone(state)); },
    onTickComplete: (status) => { statuses.push(status); },
    now: () => nowMs,
    setIntervalFn: () => ({}) as NodeJS.Timeout,
    clearIntervalFn: () => {},
    log: { warn: () => {} },
    ...overrides,
  };
  const lane = createLanePoller(dependencies);
  const poller = {
    ...lane,
    start: async () => { await lane.start(); await lane.tick(); },
  };
  return { poller, store, storePoller, registeredWatches, unregisteredWatches, github, writes, statuses, spawned, setNow: (value: number) => { nowMs = value; } };
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('requested and authored PRs are deduped and self, bots and drafts never reach a review', async () => {
  const { poller, github, spawned, statuses } = setup();
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'me'), searchItem(3, 'automation', { user: { login: 'automation', type: 'Bot' } })];
  github.authored = [searchItem(1, 'teammate'), searchItem(4, 'other', { draft: true })];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.key), [`${REPO}#1`]);
  assert.deepEqual(github.authoredQueries, [['teammate', 'other']], 'the operator is not searched as a teammate');
  assert.equal(spawned[0].tier, 'stamp');
  const latest = statuses.at(-1);
  assert.equal(latest?.type, 'team-review-status');
  assert.deepEqual(latest?.team, { org: 'Acme', slug: 'core', name: 'Core', avatarUrl: 'https://avatars.githubusercontent.com/t/1' });
  assert.deepEqual(latest?.drafts.map((draft) => [draft.key, draft.status]), [[`${REPO}#1`, 'ready']]);
  assert.deepEqual(latest?.inFlight, []);
  for (const status of statuses) assert.equal(TeamReviewStatus.safeParse(status).success, true);
  await poller.stop();
});

test('a pull request outside every team search that an agent asks for is reviewed and stays a draft for the operator', async () => {
  const { poller, github, spawned } = setup();
  github.heads.set(9, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(spawned.length, 0);
  assert.deepEqual(await poller.requestReview({ repo: REPO.toLowerCase(), number: 9 }), { ok: true, key: `${REPO}#9`, status: 'queued' });
  await poller.tick();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.key), [`${REPO}#9`]);
  assert.equal(poller.getDraft(`${REPO}#9`)?.status, 'ready');
  await poller.tick();
  await settle();
  assert.equal(poller.getDraft(`${REPO}#9`)?.status, 'ready', 'a later tick keeps the asked-for draft instead of pruning it');
  assert.equal(spawned.length, 1);
  await poller.stop();
});

test('a posted asked-for review and a requeued team pull request leave the asked-for cap free', async () => {
  const { poller, github } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.heads.set(9, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'ready');
  assert.deepEqual(await poller.requestReview({ repo: REPO, number: 1 }), { ok: true, key: `${REPO}#1`, status: 'queued' });
  assert.equal(poller._state()[`${REPO}#1`]?.requestedAt, undefined);
  await poller.requestReview({ repo: REPO, number: 9 });
  await poller.tick();
  await settle();
  assert.ok(await poller.updateDraft(`${REPO}#9`, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' }));
  for (let number = 10; number < 10 + MAX_ASKED_FOR_REVIEWS; number += 1) {
    github.heads.set(number, HEAD_ONE);
    assert.deepEqual(await poller.requestReview({ repo: REPO, number }), { ok: true, key: `${REPO}#${number}`, status: 'queued' });
  }
  github.heads.set(99, HEAD_ONE);
  assert.equal((await poller.requestReview({ repo: REPO, number: 99 })).ok, false);
  await poller.stop();
});

test('two configured teams are searched and their members unioned with the first team profile', async () => {
  const teams = [{ org: 'Acme', slug: 'core' }, { org: 'Other', slug: 'tools' }];
  const { poller, store, github, spawned, statuses, registeredWatches, unregisteredWatches } = setup({ teams });
  const memberQueries: string[] = [];
  const teamQueries: string[] = [];
  const profileQueries: string[] = [];
  const directQueries: string[] = [];
  const authoredByOrg: [string, string[]][] = [];
  github.readDirectRequested = async (org) => {
    directQueries.push(org);
    return { items: [], complete: true };
  };
  github.readAuthoredBy = async (org, logins) => {
    authoredByOrg.push([org, logins]);
    return { items: [], complete: true };
  };
  github.teamProfile = async (org, slug) => {
    profileQueries.push(`${org}/${slug}`);
    return { org, slug, name: 'Core', avatarUrl: 'https://avatars.githubusercontent.com/t/1' };
  };
  github.teamMembers = async (org, slug) => {
    memberQueries.push(`${org}/${slug}`);
    if (slug === 'core') return ['me', 'teammate', 'shared'];
    return ['ME', 'SHARED', 'other'];
  };
  github.readTeamRequested = async (org, slug) => {
    teamQueries.push(`${org}/${slug}`);
    if (slug === 'core') return { items: [searchItem(1, 'teammate')], complete: true };
    return { items: [searchItem(1, 'teammate'), searchItem(2, 'other')], complete: false };
  };
  github.heads.set(1, HEAD_ONE);
  github.heads.set(2, HEAD_TWO);
  try {
    await poller.start();
    await settle();
    assert.deepEqual(memberQueries, ['Acme/core', 'Other/tools', 'Acme/core', 'Other/tools']);
    assert.deepEqual(teamQueries, ['Acme/core', 'Other/tools']);
    assert.deepEqual(profileQueries, ['Acme/core']);
    assert.deepEqual(directQueries, ['Acme', 'Other']);
    assert.deepEqual(authoredByOrg, [['Acme', ['teammate', 'shared']], ['Other', ['SHARED', 'other']]]);
    assert.deepEqual(registeredWatches, [
      { name: 'team-review-direct:acme', qualifiers: 'is:open draft:false org:Acme user-review-requested:@me', needsDetail: true },
      { name: 'team-review-authored:acme:0', qualifiers: 'is:open draft:false org:Acme author:teammate author:shared', needsDetail: true },
      { name: 'team-review-direct:other', qualifiers: 'is:open draft:false org:Other user-review-requested:@me', needsDetail: true },
      { name: 'team-review-authored:other:0', qualifiers: 'is:open draft:false org:Other author:SHARED author:other', needsDetail: true },
      { name: 'team-review-team:acme/core', qualifiers: 'is:open draft:false org:Acme team-review-requested:Acme/core', needsDetail: true },
      { name: 'team-review-team:other/tools', qualifiers: 'is:open draft:false org:Other team-review-requested:Other/tools', needsDetail: true },
    ]);
    assert.deepEqual(spawned.map((args) => args.candidate.key), [`${REPO}#1`, `${REPO}#2`]);
    assert.equal(statuses.at(-1)?.team?.slug, 'core');
    github.readTeamRequested = async (_org, slug) => ({ items: [], complete: slug === 'core' });
    await poller.tick();
    assert.ok(poller.getDraft(`${REPO}#1`));
    assert.ok(poller.getDraft(`${REPO}#2`));
    github.readTeamRequested = async () => ({ items: [], complete: true });
    await poller.tick();
    assert.equal(poller.getDraft(`${REPO}#1`), null);
    assert.equal(poller.getDraft(`${REPO}#2`), null);
    const authors = Array.from({ length: 12 }, (_unused, index) => `member${index}`);
    github.teamMembers = async () => ['me', ...authors];
    await poller.tick();
    assert.deepEqual(registeredWatches.filter((watch) => watch.name.startsWith('team-review-authored:acme:')).slice(-3).map((watch) => watch.qualifiers), [
      'is:open draft:false org:Acme author:member0 author:member1 author:member2 author:member3 author:member4',
      'is:open draft:false org:Acme author:member5 author:member6 author:member7 author:member8 author:member9',
      'is:open draft:false org:Acme author:member10 author:member11',
    ]);
    github.teamMembers = async () => ['me', 'member0'];
    await poller.tick();
    assert.ok(unregisteredWatches.includes('team-review-authored:acme:1'));
    assert.ok(unregisteredWatches.includes('team-review-authored:acme:2'));
    assert.equal(store.getSnapshot().watches['team-review-authored:acme:0'].isLoaded, false);
    github.teamMembers = async () => [];
    await poller.tick();
    assert.deepEqual(store.getSnapshot().watches, {});
  } finally {
    await poller.stop();
    assert.deepEqual(store.getSnapshot().watches, {});
  }
});

test('a failed member fetch for one team keeps the drafts and resumable reviews of that team', async () => {
  const teams = [{ org: 'Acme', slug: 'core' }, { org: 'Acme', slug: 'tools' }];
  const discarded: string[] = [];
  const { poller, github } = setup({ teams, discardResumable: async (record) => { discarded.push(record.sessionId); } });
  let isToolsFetchFailing = false;
  github.teamMembers = async (_org, slug) => {
    if (slug === 'core') return ['me', 'teammate'];
    return isToolsFetchFailing ? null : ['other'];
  };
  github.readAuthoredBy = async (_org, logins) => ({ items: logins.includes('other') ? [searchItem(2, 'other')] : [], complete: true });
  github.heads.set(2, HEAD_TWO);
  try {
    await poller.start();
    await settle();
    assert.ok(poller.getDraft(`${REPO}#2`));
    const entry = poller._state()[`${REPO}#2`];
    assert.ok(entry);
    entry.resumable = { ...RESUMABLE, head: HEAD_TWO };
    isToolsFetchFailing = true;
    await poller.tick();
    assert.ok(poller.getDraft(`${REPO}#2`));
    assert.deepEqual(discarded, []);
  } finally {
    await poller.stop();
  }
});

test('team profile is cached after success and retried after null', async () => {
  const github = fakeGithub();
  let profileCalls = 0;
  github.teamProfile = async () => {
    profileCalls += 1;
    if (profileCalls === 1) return null;
    return { org: 'Acme', slug: 'core', name: 'Core', avatarUrl: 'https://avatars.githubusercontent.com/t/1' };
  };
  const { poller, statuses } = setup({ github });
  await poller.start();
  await poller.tick();
  await poller.tick();
  assert.equal(profileCalls, 2);
  assert.equal(statuses[0]?.team, null);
  assert.equal(statuses.at(-1)?.team?.name, 'Core');
  await poller.stop();
});

test('a PR the operator already reviewed on GitHub at its head is never auto-reviewed', async () => {
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.heads.set(2, HEAD_ONE);
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  github.reviews.set(2, [{ login: 'me', state: 'APPROVED', commit: HEAD_TWO }]);
  await poller.start();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.key), [`${REPO}#2`]);
  await poller.stop();
});

test('an approval GitHub still counts after new commits keeps the pull request out of review', async () => {
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate')];
  github.heads.set(1, HEAD_TWO);
  github.heads.set(2, HEAD_TWO);
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  github.reviews.set(2, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  github.decisions.set(1, 'APPROVED');
  github.decisions.set(2, 'REVIEW_REQUIRED');
  await poller.start();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.key), [`${REPO}#2`]);
  await poller.stop();
});

test('a reviewed pull request whose earlier approval still counts after new commits is not reviewed again', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned, statuses, setNow } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(spawned.length, 1);
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  github.heads.set(1, HEAD_TWO);
  github.decisions.set(1, 'APPROVED');
  setNow(1000 + DEFAULT_RE_REVIEW_AFTER_HOURS * 3600000);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  const presented = statuses.at(-1)?.drafts.find((row) => row.key === key);
  assert.equal(presented?.reviewDecision, 'APPROVED');
  assert.equal(presented?.reviewedHead, HEAD_ONE);
  await poller.stop();
});

test('a queued review overrides an approval that still counts and its draft records the requeued head', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned, statuses } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_TWO);
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  github.decisions.set(1, 'REVIEW_REQUIRED');
  await poller.start();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(poller.getDraft(key)?.requeuedHead, undefined);
  github.decisions.set(1, 'APPROVED');
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(await poller.requeue(key, HEAD_TWO), true);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  const presented = statuses.at(-1)?.drafts.find((row) => row.key === key);
  assert.equal(presented?.status, 'ready');
  assert.equal(presented?.reviewedHead, HEAD_TWO);
  assert.equal(presented?.requeuedHead, HEAD_TWO);
  assert.equal(presented?.reviewDecision, 'APPROVED');
  await poller.stop();
});

test('a review queued on a draft whose approval still counts after new commits reviews the live head', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned, statuses } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(spawned.length, 1);
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  github.heads.set(1, HEAD_TWO);
  github.decisions.set(1, 'APPROVED');
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(spawned.at(-1)?.detail.headRefOid, HEAD_TWO);
  const presented = statuses.at(-1)?.drafts.find((row) => row.key === key);
  assert.equal(presented?.reviewedHead, HEAD_TWO);
  assert.equal(presented?.requeuedHead, HEAD_TWO);
  await poller.stop();
});

test('queue review on an out of date draft starts the review without waiting for the next poll and keeps the earlier review', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned, statuses } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  github.heads.set(1, HEAD_TWO);
  await poller.tick();
  await settle();
  assert.equal(poller.getDraft(key)?.status, 'stale');
  assert.equal(statuses.at(-1)?.drafts.find((row) => row.key === key)?.earlierReview?.head, HEAD_ONE);
  assert.equal(spawned.length, 1);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(spawned.at(-1)?.detail.headRefOid, HEAD_TWO);
  assert.equal(poller.getDraft(key)?.status, 'ready');
  assert.equal(statuses.at(-1)?.drafts.find((row) => row.key === key)?.earlierReview?.head, HEAD_ONE);
  await poller.stop();
});

test('a review queued under a standing approval follows a head pushed before the next tick', async () => {
  const key = `${REPO}#1`;
  const headThree = '3'.repeat(40);
  const { poller, github, spawned, statuses } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(spawned.length, 1);
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  github.heads.set(1, HEAD_TWO);
  github.decisions.set(1, 'APPROVED');
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  assert.equal(poller._state()[key]?.requeuedHead, HEAD_TWO);
  github.heads.set(1, headThree);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(spawned.at(-1)?.detail.headRefOid, headThree);
  const presented = statuses.at(-1)?.drafts.find((row) => row.key === key);
  assert.equal(presented?.status, 'ready');
  assert.equal(presented?.reviewedHead, headThree);
  assert.equal(presented?.requeuedHead, headThree);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  await poller.stop();
});

test('a ready draft picks up the GitHub reviews on the next tick', async () => {
  const { poller, github, statuses } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }, { login: 'sarah', state: 'COMMENTED', commit: HEAD_ONE }]);
  await poller.tick();
  const draft = statuses.at(-1)?.drafts[0];
  assert.equal(draft?.status, 'ready');
  assert.deepEqual(draft?.githubReviews, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE, isViewer: true, submittedAt: null }]);
  await poller.stop();
});

test('review snapshots load in one batch per tick and a PR without one waits for the next tick', async () => {
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.deepEqual(github.snapshotBatches, [[1, 2]]);
  assert.deepEqual(spawned.map((args) => args.candidate.key), [`${REPO}#1`]);
  assert.equal(poller._state()[`${REPO}#2`], undefined);
  github.heads.set(2, HEAD_TWO);
  await poller.tick();
  await settle();
  assert.deepEqual(github.snapshotBatches.at(-1), [1, 2]);
  assert.deepEqual(spawned.map((args) => args.candidate.key), [`${REPO}#1`, `${REPO}#2`]);
  await poller.stop();
});

test('a draft carries the live head once the PR moves past the reviewed head', async () => {
  const { poller, github, statuses, writes } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  await poller.tick();
  assert.equal(statuses.at(-1)?.drafts[0].liveHead, HEAD_ONE);
  const writesBefore = writes.length;
  await poller.tick();
  assert.equal(writes.length, writesBefore, 'an unchanged live head is not persisted again');
  github.heads.set(1, HEAD_TWO);
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_TWO }]);
  await poller.tick();
  const draft = statuses.at(-1)?.drafts[0];
  assert.equal(draft?.status, 'stale');
  assert.equal(draft?.reviewedHead, HEAD_ONE);
  assert.equal(draft?.liveHead, HEAD_TWO);
  await poller.stop();
});

test('a later search fills the opening time on a persisted draft without rerunning its review', async () => {
  const { poller, github, spawned, statuses } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(statuses.at(-1)?.drafts[0]?.prCreatedAt, undefined);
  github.requested = [searchItem(1, 'teammate', { created_at: '2026-09-26T12:00:00Z' })];
  await poller.tick();
  assert.equal(statuses.at(-1)?.drafts[0]?.prCreatedAt, '2026-09-26T12:00:00Z');
  assert.equal(spawned.length, 1);
  await poller.stop();
});

test('posting a draft records when it was posted and later ticks leave that time alone', async () => {
  const { poller, github, statuses, setNow } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  setNow(5000);
  const posted = await poller.updateDraft(`${REPO}#1`, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' });
  assert.equal(posted?.postedAt, 5000);
  setNow(9000);
  await poller.tick();
  assert.equal(statuses.at(-1)?.drafts[0].postedAt, 5000);
  await poller.stop();
});

test('start reads state before sweeping and passes the saved paths', async () => {
  const order: string[] = [];
  const { poller } = setup({
    beforeStart: async (keepPaths) => { order.push(`sweep:${[...keepPaths].sort().join(',')}`); },
    readState: async () => { order.push('read'); return { [`${REPO}#1`]: { draft: null, reviewedHead: null, inFlight: false, skipReason: null, reviewAttempts: 0, updatedAt: 1, resumable: { sessionId: 'abc', workDir: '/work', worktreePath: '/tree', head: HEAD_ONE, deadlineAt: 9000, savedAt: 1000 } } }; },
  });
  await poller.start();
  await settle();
  assert.deepEqual(order, ['read', 'sweep:/tree,/work']);
  await poller.stop();
});

test('a draft at the same head is never reviewed again, whatever its status', async () => {
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  await poller.updateDraft(`${REPO}#1`, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'discarded' });
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'discarded');
  await poller.stop();
});

test('discarded draft stays settled after a new head until manually queued', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned, statuses } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(spawned.length, 1);
  assert.ok(await poller.updateDraft(key, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'discarded' }));
  github.heads.set(1, HEAD_TWO);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(poller.getDraft(key)?.status, 'discarded');
  assert.equal(await poller.requeue(key, HEAD_TWO), false);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  assert.equal(poller.getDraft(key)?.status, 'stale');
  assert.equal(poller._state()[key]?.reviewedHead, null);
  assert.equal(poller._state()[key]?.reviewAttempts, 0);
  assert.equal(statuses.at(-1)?.drafts[0]?.status, 'stale');
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(poller.getDraft(key)?.status, 'ready');
  assert.equal(poller.getDraft(key)?.reviewedHead, HEAD_TWO);
  await poller.stop();
});

test('not mine cancels a running review, drops a waiting one before it spawns, and neither is reviewed again on a new head', async () => {
  const runningKey = `${REPO}#1`;
  const waitingKey = `${REPO}#2`;
  const { poller, github, spawned, statuses } = setup({
    maxConcurrentReviews: 1,
    spawnReview: async (args) => {
      spawned.push(args);
      await new Promise<void>((resolve) => args.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return errorDraft({ candidate: args.candidate, tier: args.tier, reasons: args.reasons, reviewedHead: args.detail.headRefOid, error: 'review ended without a result' });
    },
  });
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.heads.set(2, HEAD_ONE);
  await poller.start();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.key), [runningKey]);
  assert.deepEqual(statuses.at(-1)?.queued.map((queued) => queued.key), [waitingKey]);
  assert.deepEqual(await poller.markNotMine(waitingKey), { ok: true });
  assert.deepEqual(await poller.markNotMine(runningKey), { ok: true });
  await settle();
  assert.equal(spawned[0]?.signal?.aborted, true);
  assert.equal(poller.getDraft(runningKey)?.status, 'discarded');
  assert.equal(poller.getDraft(waitingKey)?.status, 'discarded');
  github.heads.set(1, HEAD_TWO);
  github.heads.set(2, HEAD_TWO);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  assert.deepEqual(statuses.at(-1)?.queued, []);
  assert.deepEqual(await poller.markNotMine(`${REPO}#9`), { ok: false, error: 'That pull request is no longer in the review queue' });
  await poller.stop();
});

test('not mine on a pull request still waiting behind an earlier dispatch drops it instead of failing', async () => {
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.heads.set(2, HEAD_ONE);
  let releaseFirstView = () => {};
  const firstViewGate = new Promise<void>((resolve) => { releaseFirstView = resolve; });
  const viewPr = github.viewPr;
  github.viewPr = async (repo, number) => {
    if (number === 1) await firstViewGate;
    return viewPr(repo, number);
  };
  void poller.start();
  await settle();
  assert.deepEqual(await poller.markNotMine(`${REPO}#2`), { ok: true });
  releaseFirstView();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.key), [`${REPO}#1`]);
  assert.equal(poller.getDraft(`${REPO}#2`)?.status, 'discarded');
  await poller.stop();
});

test('a fork marked not mine and requeued returns to hand review without an empty draft', async () => {
  const key = `${REPO}#5`;
  const { poller, github, spawned, statuses } = setup();
  github.requested = [searchItem(5, 'teammate')];
  github.heads.set(5, HEAD_ONE);
  github.viewPr = async (_repo, number) => prDetail(number, HEAD_ONE, { isCrossRepository: true });
  await poller.start();
  await settle();
  assert.deepEqual(await poller.markNotMine(key), { ok: true });
  assert.deepEqual(statuses.at(-1)?.handReview, []);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 0);
  assert.deepEqual(statuses.at(-1)?.drafts.filter((draft) => draft.key === key), []);
  assert.deepEqual(statuses.at(-1)?.handReview.map((queued) => queued.key), [key]);
  await poller.stop();
});

test('saved drafts are published at start before the first GitHub search finishes', async () => {
  const key = `${REPO}#1`;
  const candidate = { key, repo: REPO, number: 1, title: 'PR 1', url: `https://github.com/${REPO}/pull/1`, author: 'teammate', requestSource: 'team' as const };
  const draft = errorDraft({ candidate, tier: 'stamp', reasons: [], reviewedHead: HEAD_ONE, error: 'timed out' });
  const savedState: TeamReviewState = {
    [key]: { draft, reviewedHead: HEAD_ONE, inFlight: false, skipReason: null, reviewAttempts: MAX_REVIEW_ATTEMPTS, updatedAt: 1 },
  };
  const { poller, github, statuses } = setup({
    readState: async () => structuredClone(savedState),
    beforeStart: () => new Promise(() => {}),
  });
  github.readTeamRequested = () => new Promise(() => {});
  void poller.start();
  await settle();
  assert.deepEqual(statuses[0]?.drafts.map((published) => published.key), [key], 'the saved draft is published even while beforeStart is still sweeping');
});

test('requeue resets a failed review at its attempt limit and the next tick reviews it again', async () => {
  const key = `${REPO}#1`;
  const candidate = { key, repo: REPO, number: 1, title: 'PR 1', url: `https://github.com/${REPO}/pull/1`, author: 'teammate', requestSource: 'team' as const };
  const draft = errorDraft({ candidate, tier: 'stamp', reasons: [], reviewedHead: HEAD_ONE, error: 'timed out' });
  const savedState: TeamReviewState = {
    [key]: { draft, reviewedHead: HEAD_ONE, inFlight: false, skipReason: null, reviewAttempts: MAX_REVIEW_ATTEMPTS, updatedAt: 1 },
  };
  const { poller, github, spawned, writes, statuses, setNow } = setup({ readState: async () => structuredClone(savedState) });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(spawned.length, 0);
  assert.equal(await poller.requeue(key, HEAD_TWO), false);
  setNow(2000);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  assert.equal(poller._state()[key]?.reviewAttempts, 0);
  assert.equal(poller._state()[key]?.updatedAt, 2000);
  assert.equal(writes.at(-1)?.[key]?.reviewAttempts, 0);
  assert.equal(statuses.at(-1)?.drafts[0]?.status, 'error');
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(poller.getDraft(key)?.status, 'ready');
  await poller.stop();
});

test('requeue of a posted draft reviews it again even though the viewer reviewed that head', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.ok(await poller.updateDraft(key, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' }));
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  assert.equal(poller.getDraft(key)?.status, 'posted');
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(poller.getDraft(key)?.status, 'ready');
  assert.equal(poller._state()[key]?.requeuedHead, undefined);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  await poller.stop();
});

test('a requeued posted draft whose one review crashes is retried even though the viewer reviewed that head', async () => {
  const key = `${REPO}#1`;
  let isSpawnFailing = false;
  const { poller, github, spawned } = setup({
    spawnReview: async (args) => {
      spawned.push(args);
      if (isSpawnFailing) throw new Error('pty exploded');
      return draftFor(args);
    },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.ok(await poller.updateDraft(key, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' }));
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  isSpawnFailing = true;
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(poller.getDraft(key)?.status, 'error');
  isSpawnFailing = false;
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 3);
  assert.equal(poller.getDraft(key)?.status, 'ready');
  assert.equal(poller._state()[key]?.requeuedHead, undefined);
  await poller.stop();
});

test('a requeue left at an exhausted head does not auto-review a moved head the viewer already reviewed', async () => {
  const key = `${REPO}#1`;
  let isSpawnFailing = false;
  const { poller, github, spawned, setNow } = setup({
    spawnReview: async (args) => {
      spawned.push(args);
      if (isSpawnFailing) throw new Error('pty exploded');
      return draftFor(args);
    },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.ok(await poller.updateDraft(key, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' }));
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  isSpawnFailing = true;
  for (let tick = 0; tick < MAX_REVIEW_ATTEMPTS + 1; tick += 1) {
    await poller.tick();
    await settle();
  }
  const spawnedAtExhaustion = spawned.length;
  assert.equal(poller.getDraft(key)?.status, 'error');
  assert.equal(poller._state()[key]?.requeuedHead, HEAD_ONE);
  isSpawnFailing = false;
  github.heads.set(1, HEAD_TWO);
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_TWO }]);
  setNow(1000 + DEFAULT_RE_REVIEW_AFTER_HOURS * 3600000);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, spawnedAtExhaustion);
  await poller.stop();
});

test('a requeued posted draft whose PR departed keeps posted retention', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.ok(await poller.updateDraft(key, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' }));
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  github.requested = [];
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(poller.getDraft(key)?.status, 'posted');
  await poller.stop();
});

test('requeue of a ready draft marks it stale at once and the next tick reviews it again', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(poller.getDraft(key)?.status, 'ready');
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  assert.equal(poller.getDraft(key)?.status, 'stale');
  assert.equal(poller._state()[key]?.reviewAttempts, 0);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(poller.getDraft(key)?.status, 'ready');
  assert.equal(poller._state()[key]?.reviewAttempts, 1);
  await poller.stop();
});

test('a moved head marks the ready draft stale and waits until the review interval passes', async () => {
  const release: { resolve?: () => void } = {};
  const gate = new Promise<void>((resolve) => { release.resolve = resolve; });
  let spawnCount = 0;
  const { poller, github, statuses, writes, setNow } = setup({
    spawnReview: async (args) => {
      spawnCount += 1;
      if (spawnCount === 2) await gate;
      return draftFor(args);
    },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(poller._state()[`${REPO}#1`]?.reviewedAt, 1000);
  github.heads.set(1, HEAD_TWO);
  await poller.tick();
  await settle();
  assert.equal(spawnCount, 1);
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'stale');
  assert.equal(writes.at(-1)?.[`${REPO}#1`]?.draft?.status, 'stale');
  assert.deepEqual(statuses.at(-1)?.inFlight, []);
  setNow(1000 + DEFAULT_RE_REVIEW_AFTER_HOURS * 3600000 - 1);
  await poller.tick();
  assert.equal(spawnCount, 1);
  setNow(1000 + DEFAULT_RE_REVIEW_AFTER_HOURS * 3600000);
  await poller.tick();
  await settle();
  assert.deepEqual(statuses.at(-1)?.inFlight.map((review) => review.key), [`${REPO}#1`]);
  release.resolve?.();
  await settle();
  assert.equal(spawnCount, 2);
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'ready');
  assert.equal(poller.getDraft(`${REPO}#1`)?.reviewedHead, HEAD_TWO);
  assert.equal(poller._state()[`${REPO}#1`]?.reviewedAt, 1000 + DEFAULT_RE_REVIEW_AFTER_HOURS * 3600000);
  await poller.stop();
});

test('a head that returns to the last reviewed head within the wait restores the stale draft to ready without spawning', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned, setNow } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(spawned.length, 1);
  github.heads.set(1, HEAD_TWO);
  await poller.tick();
  await settle();
  assert.equal(poller.getDraft(key)?.status, 'stale');
  github.heads.set(1, HEAD_ONE);
  setNow(1000 + DEFAULT_RE_REVIEW_AFTER_HOURS * 3600000 - 1);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(poller.getDraft(key)?.status, 'ready');
  assert.equal(poller.getDraft(key)?.reviewedHead, HEAD_ONE);
  await poller.stop();
});

test('a stale draft can be manually queued inside the review interval', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  github.heads.set(1, HEAD_TWO);
  await poller.tick();
  assert.equal(poller.getDraft(key)?.status, 'stale');
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  assert.equal(poller._state()[key]?.reviewedHead, null);
  assert.equal(poller._state()[key]?.reviewAttempts, 0);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(poller.getDraft(key)?.reviewedHead, HEAD_TWO);
  await poller.stop();
});

test('a legacy ready draft keeps its original review time after becoming stale', async () => {
  const key = `${REPO}#1`;
  const candidate = { key, repo: REPO, number: 1, title: 'PR 1', url: `https://github.com/${REPO}/pull/1`, author: 'teammate', requestSource: 'team' as const };
  const draft = readyDraft({ candidate, tier: 'stamp', reasons: [], result: { verdict: 'APPROVE', head: HEAD_ONE, summary: 'fine', assessment: null, findings: [] } });
  const savedState: TeamReviewState = { [key]: { draft, reviewedHead: HEAD_ONE, inFlight: false, skipReason: null, reviewAttempts: 1, updatedAt: 1000 } };
  const { poller, github, spawned, setNow } = setup({ readState: async () => structuredClone(savedState) });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_TWO);
  setNow(2000);
  await poller.start();
  await settle();
  assert.equal(poller.getDraft(key)?.status, 'stale');
  assert.equal(poller._state()[key]?.reviewedAt, 1000);
  assert.equal(poller._state()[key]?.updatedAt, 2000);
  assert.equal(spawned.length, 0);
  setNow(1000 + DEFAULT_RE_REVIEW_AFTER_HOURS * 3600000);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  await poller.stop();
});

test('an error draft below the attempt limit retries at the same head without waiting', async () => {
  let attempts = 0;
  const { poller, github } = setup({
    spawnReview: async (args) => {
      attempts += 1;
      if (attempts === 1) return errorDraft({ candidate: args.candidate, tier: args.tier, reasons: args.reasons, reviewedHead: args.detail.headRefOid, error: 'failed' });
      return draftFor(args);
    },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'error');
  assert.equal(poller._state()[`${REPO}#1`]?.reviewedAt, 1000);
  await poller.tick();
  await settle();
  assert.equal(attempts, 2);
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'ready');
  await poller.stop();
});

test('an idle PR is omitted from review and pruned from the visible drafts', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned, statuses, setNow } = setup();
  github.requested = [searchItem(1, 'teammate', { updated_at: new Date(1000).toISOString() })];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(spawned.length, 1);
  setNow(1000 + DEFAULT_SKIP_IDLE_AFTER_DAYS * 86400000 + 1);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(poller._state()[key], undefined);
  assert.deepEqual(statuses.at(-1)?.drafts, []);
  await poller.stop();
});

test('a PR already idle on first search is never reviewed or shown', async () => {
  const nowMs = 1000 + DEFAULT_SKIP_IDLE_AFTER_DAYS * 86400000 + 1;
  const { poller, github, spawned, statuses, setNow } = setup();
  setNow(nowMs);
  github.requested = [searchItem(1, 'teammate', { updated_at: new Date(1000).toISOString() })];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.deepEqual(spawned, []);
  assert.deepEqual(statuses.at(-1)?.drafts, []);
  assert.deepEqual(poller._state(), {});
  await poller.stop();
});

test('the concurrency cap leaves the rest queued for a later tick', async () => {
  const release: { resolve?: () => void } = {};
  const gate = new Promise<void>((resolve) => { release.resolve = resolve; });
  const { poller, github, spawned } = setup({
    maxConcurrentReviews: 2,
    spawnReview: async (args) => { spawned.push(args); await gate; return draftFor(args); },
  });
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate'), searchItem(3, 'teammate')];
  for (const number of [1, 2, 3]) github.heads.set(number, HEAD_ONE);
  await poller.start();
  await poller.tick();
  assert.deepEqual(spawned.map((args) => args.candidate.number), [1, 2]);
  assert.equal(poller._state()[`${REPO}#3`], undefined);
  release.resolve?.();
  await settle();
  await poller.tick();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.number), [1, 2, 3]);
  await poller.stop();
});

test('a review that finishes while a tick is still starting reviews frees its slot for the queued one without waiting for the poll', async () => {
  const finishReviewByNumber = new Map<number, () => void>();
  const secondDetailGate: { release?: () => void } = {};
  const secondDetailReleased = new Promise<void>((resolve) => { secondDetailGate.release = resolve; });
  const scheduledCallbacks: Array<() => void> = [];
  const { poller, github, spawned } = setup({
    maxConcurrentReviews: 2,
    setTimeoutFn: (fn) => { scheduledCallbacks.push(fn); return {} as NodeJS.Timeout; },
    spawnReview: async (args) => {
      spawned.push(args);
      await new Promise<void>((resolve) => { finishReviewByNumber.set(args.candidate.number, resolve); });
      return draftFor(args);
    },
  });
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate'), searchItem(3, 'teammate')];
  for (const number of [1, 2, 3]) github.heads.set(number, HEAD_ONE);
  const viewPr = github.viewPr;
  github.viewPr = async (repo, number) => {
    if (number === 2) await secondDetailReleased;
    return viewPr(repo, number);
  };
  const started = poller.start();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.number), [1]);
  finishReviewByNumber.get(1)?.();
  await settle();
  secondDetailGate.release?.();
  await started;
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.number), [1, 2]);
  for (const scheduledCallback of scheduledCallbacks.splice(0)) scheduledCallback();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.number), [1, 2, 3]);
  for (const finishReview of finishReviewByNumber.values()) finishReview();
  await poller.stop();
});

test('a fork appears for hand review and drops after the viewer reviews its head', async () => {
  const { poller, github, spawned, statuses } = setup();
  github.requested = [searchItem(5, 'teammate')];
  github.heads.set(5, HEAD_ONE);
  github.viewPr = async (_repo, number) => prDetail(number, HEAD_ONE, { isCrossRepository: true });
  await poller.start();
  await settle();
  assert.equal(statuses.at(-1)?.handReview[0]?.key, `${REPO}#5`);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 0);
  const handReview = statuses.at(-1)?.handReview;
  assert.equal(handReview?.length, 1);
  assert.equal(handReview?.[0].key, `${REPO}#5`);
  assert.equal(poller._state()[`${REPO}#5`]?.skipReason, 'fork');
  github.reviews.set(5, [{ state: 'COMMENTED', commit: HEAD_ONE, login: 'me' }]);
  await poller.tick();
  await settle();
  assert.deepEqual(statuses.at(-1)?.handReview, []);
  assert.equal(spawned.length, 0);
  await poller.stop();
});

test('legacy skipped forks gain hand review rows without another triage and settle on standing approval', async () => {
  const key = `${REPO}#5`;
  const { poller, github, spawned, statuses } = setup({
    readState: async () => ({ [key]: { draft: null, reviewedHead: HEAD_ONE, inFlight: false, skipReason: 'fork', reviewAttempts: 0, liveHead: HEAD_ONE, updatedAt: 1000 } }),
  });
  github.requested = [searchItem(5, 'teammate')];
  github.heads.set(5, HEAD_ONE);
  let viewPrCalls = 0;
  github.viewPr = async (_repo, number) => { viewPrCalls += 1; return prDetail(number, HEAD_ONE, { isCrossRepository: true }); };
  await poller.start();
  await settle();
  assert.equal(statuses.at(-1)?.handReview[0]?.key, key);
  assert.equal(viewPrCalls, 0);
  github.reviews.set(5, [{ state: 'APPROVED', commit: HEAD_TWO, login: 'me' }]);
  github.decisions.set(5, 'APPROVED');
  await poller.tick();
  await settle();
  assert.deepEqual(statuses.at(-1)?.handReview, []);
  assert.equal(viewPrCalls, 0);
  assert.equal(spawned.length, 0);
  await poller.stop();
});

test('a saved hand review row survives the state schema round trip without being rewritten each poll', async () => {
  const key = `${REPO}#5`;
  const first = setup();
  first.github.requested = [searchItem(5, 'teammate')];
  first.github.heads.set(5, HEAD_ONE);
  first.github.viewPr = async (_repo, number) => prDetail(number, HEAD_ONE, { isCrossRepository: true });
  await first.poller.start();
  await settle();
  await first.poller.stop();
  const savedEntry = TeamReviewStateEntry.parse(JSON.parse(JSON.stringify(first.writes.at(-1)?.[key])));
  assert.equal(savedEntry.handReview?.key, key);
  const { poller, github, writes, statuses } = setup({ readState: async () => ({ [key]: savedEntry }) });
  github.requested = [searchItem(5, 'teammate')];
  github.heads.set(5, HEAD_ONE);
  await poller.start();
  await settle();
  await poller.tick();
  await settle();
  assert.equal(statuses.at(-1)?.handReview[0]?.key, key);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.[key]?.reviewDecision, 'REVIEW_REQUIRED');
  const writesAfterMigration = writes.length;
  await poller.tick();
  assert.equal(writes.length, writesAfterMigration);
  await poller.stop();
});

test('a fork head change refreshes its hand review row and a non-fork head clears it before spawning', async () => {
  const key = `${REPO}#5`;
  const { poller, github, spawned, statuses } = setup({
    spawnReview: async (args) => {
      assert.equal(poller._state()[key]?.handReview, undefined);
      assert.equal(poller._state()[key]?.skipReason, null);
      spawned.push(args);
      return draftFor(args);
    },
  });
  github.requested = [searchItem(5, 'teammate')];
  github.heads.set(5, HEAD_ONE);
  github.viewPr = async (_repo, number) => prDetail(number, github.heads.get(number) ?? HEAD_ONE, { isCrossRepository: true });
  await poller.start();
  await settle();
  github.heads.set(5, HEAD_TWO);
  github.requested = [searchItem(5, 'teammate', { title: 'Updated fork' })];
  await poller.tick();
  assert.equal(statuses.at(-1)?.handReview[0]?.title, 'Updated fork');
  assert.equal(poller._state()[key]?.reviewedHead, HEAD_TWO);
  assert.equal(spawned.length, 0);
  github.heads.set(5, '3'.repeat(40));
  github.viewPr = async (_repo, number) => prDetail(number, '3'.repeat(40));
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 1);
  assert.deepEqual(statuses.at(-1)?.handReview, []);
  assert.equal(poller._state()[key]?.handReview, undefined);
  await poller.stop();
});

test('a changed fork head does not retain a hand review row when fresh triage is unavailable', async () => {
  const key = `${REPO}#5`;
  const { poller, github, statuses } = setup();
  github.requested = [searchItem(5, 'teammate')];
  github.heads.set(5, HEAD_ONE);
  github.viewPr = async (_repo, number) => prDetail(number, HEAD_ONE, { isCrossRepository: true });
  await poller.start();
  await settle();
  github.heads.set(5, HEAD_TWO);
  github.viewPr = async () => null;
  await poller.tick();
  assert.deepEqual(statuses.at(-1)?.handReview, []);
  assert.equal(poller._state()[key]?.handReview, undefined);
  await poller.stop();
});

test('a skip-tier PR is not re-fetched with viewPr on a second tick at the same head', async () => {
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(5, 'teammate')];
  github.heads.set(5, HEAD_ONE);
  let viewPrCalls = 0;
  github.viewPr = async (_repo, number) => { viewPrCalls += 1; return prDetail(number, HEAD_ONE, { isCrossRepository: true }); };
  await poller.start();
  await settle();
  assert.equal(viewPrCalls, 1);
  await poller.tick();
  await settle();
  assert.equal(viewPrCalls, 1);
  assert.equal(spawned.length, 0);
  await poller.stop();
});

test('a gh failure leaves the state untouched and backs off to the next tick', async () => {
  const { poller, github, writes, spawned } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  const before = structuredClone(poller._state());
  const writeCount = writes.length;
  github.requested = [];
  github.teamMembers = async () => [];
  github.heads.set(1, HEAD_TWO);
  await poller.tick();
  await settle();
  assert.deepEqual(poller._state(), before);
  assert.equal(writes.length, writeCount);
  assert.equal(spawned.length, 1);
  await poller.stop();
});

test('a failed viewer lookup is retried rather than cached', async () => {
  const { poller, github, spawned } = setup();
  github.failViewer = true;
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(spawned.length, 0);
  await poller.stop();
  github.failViewer = false;
  await poller.start();
  await settle();
  assert.equal(spawned.length, 1);
  await poller.stop();
});

test('departed PRs are pruned, posted ones only after seven days', async () => {
  const { poller, github, setNow } = setup();
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate'), searchItem(3, 'teammate')];
  for (const number of [1, 2, 3]) github.heads.set(number, HEAD_ONE);
  await poller.start();
  await settle();
  await poller.updateDraft(`${REPO}#2`, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' });
  github.requested = [searchItem(3, 'teammate')];
  await poller.tick();
  await settle();
  assert.deepEqual(Object.keys(poller._state()).sort(), [`${REPO}#2`, `${REPO}#3`]);
  setNow(1000 + POSTED_RETENTION_MS + 1);
  await poller.tick();
  await settle();
  assert.deepEqual(Object.keys(poller._state()), [`${REPO}#3`]);
  await poller.stop();
});

test('a posted review of a merged or closed PR leaves the list without waiting out retention', async () => {
  const { poller, github } = setup();
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate')];
  for (const number of [1, 2]) github.heads.set(number, HEAD_ONE);
  await poller.start();
  await settle();
  for (const number of [1, 2]) await poller.updateDraft(`${REPO}#${number}`, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' });
  github.requested = [];
  github.closedNumbers.add(1);
  await poller.tick();
  assert.ok(poller.getDraft(`${REPO}#1`), 'the departed PR is unknown until the store fetches its watched key');
  await poller.tick();
  await settle();
  assert.deepEqual(Object.keys(poller._state()), [`${REPO}#2`]);
  await poller.stop();
});

test('an unposted draft of a merged or closed PR leaves the list even while the search is incomplete', async () => {
  const { poller, github } = setup();
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate')];
  for (const number of [1, 2]) github.heads.set(number, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'ready');
  github.requested = [];
  github.isRequestedComplete = false;
  github.closedNumbers.add(1);
  await poller.tick();
  await poller.tick();
  await settle();
  assert.deepEqual(Object.keys(poller._state()), [`${REPO}#2`]);
  await poller.stop();
});

test('an incomplete requested search prunes nothing but still reviews the candidates it returned', async () => {
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.heads.set(2, HEAD_ONE);
  await poller.start();
  await settle();
  github.requested = [searchItem(2, 'teammate')];
  github.isRequestedComplete = false;
  await poller.tick();
  await settle();
  assert.deepEqual(Object.keys(poller._state()).sort(), [`${REPO}#1`, `${REPO}#2`]);
  assert.deepEqual(spawned.map((args) => args.candidate.number), [1, 2]);
  await poller.stop();
});

test('an incomplete authored search prunes nothing', async () => {
  const { poller, github } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  github.requested = [];
  github.isAuthoredComplete = false;
  await poller.tick();
  await settle();
  assert.deepEqual(Object.keys(poller._state()), [`${REPO}#1`]);
  await poller.stop();
});

test('a complete empty search prunes departed drafts', async () => {
  const { poller, github } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  github.requested = [];
  await poller.tick();
  await settle();
  assert.deepEqual(Object.keys(poller._state()), []);
  await poller.stop();
});

test('a crashed spawn becomes an error draft, and restart clears stale in-flight marks', async () => {
  const persisted: TeamReviewState = {
    [`${REPO}#9`]: { draft: null, reviewedHead: null, inFlight: true, skipReason: null, reviewAttempts: 0, updatedAt: 1 },
  };
  const { poller, github } = setup({
    readState: async () => structuredClone(persisted),
    spawnReview: async () => { throw new Error('pty exploded'); },
  });
  github.requested = [searchItem(9, 'teammate')];
  github.heads.set(9, HEAD_ONE);
  await poller.start();
  await settle();
  const draft = poller.getDraft(`${REPO}#9`);
  assert.equal(draft?.status, 'error');
  assert.equal(draft?.error, 'pty exploded');
  assert.equal(poller._state()[`${REPO}#9`]?.inFlight, false);
  await poller.stop();
});

test('a review aborted by shutdown leaves no draft and is queued again on the next tick', async () => {
  let isShuttingDown = true;
  const { poller, github, spawned } = setup({
    spawnReview: async (args) => { spawned.push(args); return isShuttingDown ? { kind: 'stopped', resumable: null } : draftFor(args); },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(poller.getDraft(`${REPO}#1`), null);
  assert.equal(poller._state()[`${REPO}#1`]?.inFlight, false);
  assert.equal(poller._state()[`${REPO}#1`]?.reviewAttempts, 0);
  assert.equal(poller._state()[`${REPO}#1`]?.reviewedAt, undefined);
  isShuttingDown = false;
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'ready');
  await poller.stop();
});

test('a stopped review saves its resume record without changing the prior draft or attempts', async () => {
  const key = `${REPO}#1`;
  const previousDraft = errorDraft({
    candidate: { key, repo: REPO, number: 1, title: 'PR 1', url: `https://github.com/${REPO}/pull/1`, author: 'teammate', requestSource: 'team' as const },
    tier: 'stamp', reasons: [], reviewedHead: HEAD_ONE, error: 'previous failure',
  });
  const { poller, github, writes } = setup({
    readState: async () => ({ [key]: { draft: previousDraft, reviewedHead: HEAD_ONE, inFlight: false, skipReason: null, reviewAttempts: 1, updatedAt: 1000 } }),
    spawnReview: async () => ({ kind: 'stopped', resumable: RESUMABLE }),
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  const entry = poller._state()[key];
  assert.equal(entry?.inFlight, false);
  assert.deepEqual(entry?.draft, { ...previousDraft, isDraft: false, checksState: null, reviewDecision: 'REVIEW_REQUIRED' });
  assert.equal(entry?.reviewAttempts, 1);
  assert.equal(entry?.reviewedHead, HEAD_ONE);
  assert.equal(entry?.reviewedAt, undefined);
  assert.deepEqual(entry?.resumable, RESUMABLE);
  assert.deepEqual(writes.at(-1)?.[key]?.resumable, RESUMABLE);
  await poller.stop();
});

test('the next tick consumes a saved resume record before spawning', async () => {
  const key = `${REPO}#1`;
  const spawned: SpawnReviewArgs[] = [];
  const { poller, github, writes } = setup({
    readState: async () => ({ [key]: { draft: null, reviewedHead: null, inFlight: false, skipReason: null, reviewAttempts: 0, updatedAt: 1000, resumable: RESUMABLE } }),
    spawnReview: async (args) => { spawned.push(args); return draftFor(args); },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.deepEqual(spawned[0]?.resume, RESUMABLE);
  assert.equal(writes.some((state) => state[key]?.resumable === null && state[key]?.inFlight === false), true);
  assert.equal(poller._state()[key]?.resumable, null);
  assert.equal(poller.getDraft(key)?.status, 'ready');
  await poller.stop();
});

test('a moved head discards the saved review and starts fresh', async () => {
  const key = `${REPO}#1`;
  const discarded: string[] = [];
  const spawned: SpawnReviewArgs[] = [];
  const { poller, github } = setup({
    readState: async () => ({ [key]: { draft: null, reviewedHead: null, inFlight: false, skipReason: null, reviewAttempts: 0, updatedAt: 1000, resumable: RESUMABLE } }),
    discardResumable: async (record) => { discarded.push(record.sessionId); },
    spawnReview: async (args) => { spawned.push(args); return draftFor(args); },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_TWO);
  await poller.start();
  await settle();
  assert.deepEqual(discarded, ['claude-1']);
  assert.equal(spawned[0]?.resume, undefined);
  assert.equal(spawned[0]?.detail.headRefOid, HEAD_TWO);
  assert.equal(poller._state()[key]?.resumable, null);
  await poller.stop();
});

test('a resumed review that now triages as skipped discards its checkout', async () => {
  const key = `${REPO}#1`;
  const discarded: string[] = [];
  const spawned: SpawnReviewArgs[] = [];
  const { poller, github } = setup({
    readState: async () => ({ [key]: { draft: null, reviewedHead: null, inFlight: false, skipReason: null, reviewAttempts: 0, updatedAt: 1000, resumable: RESUMABLE } }),
    discardResumable: async (record) => { discarded.push(record.sessionId); },
    spawnReview: async (args) => { spawned.push(args); return draftFor(args); },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.viewPr = async () => prDetail(1, HEAD_ONE, { isCrossRepository: true });
  await poller.start();
  await settle();
  assert.deepEqual(discarded, ['claude-1']);
  assert.deepEqual(spawned, []);
  assert.equal(poller._state()[key]?.resumable, null);
  assert.equal(poller._state()[key]?.skipReason, 'fork');
  await poller.stop();
});

test('a departed PR discards its saved checkout while retaining a posted draft', async () => {
  const key = `${REPO}#1`;
  const postedDraft = { ...draftFor({
    candidate: { key, repo: REPO, number: 1, title: 'PR 1', url: `https://github.com/${REPO}/pull/1`, author: 'teammate', requestSource: 'team' as const },
    detail: prDetail(1, HEAD_ONE), tier: 'stamp', reasons: [],
  }), status: 'posted' as const };
  const discarded: string[] = [];
  const { poller } = setup({
    readState: async () => ({ [key]: { draft: postedDraft, reviewedHead: HEAD_ONE, inFlight: false, skipReason: null, reviewAttempts: 1, updatedAt: 1000, resumable: RESUMABLE } }),
    discardResumable: async (record) => { discarded.push(record.sessionId); },
  });
  await poller.start();
  await settle();
  assert.deepEqual(discarded, ['claude-1']);
  assert.equal(poller._state()[key]?.resumable, null);
  assert.equal(poller._state()[key]?.draft?.status, 'posted');
  await poller.stop();
});

test('an error draft is retried until the attempt budget for its head is spent, then settles', async () => {
  const { poller, github, spawned } = setup({
    spawnReview: async (args) => {
      spawned.push(args);
      return errorDraft({ candidate: args.candidate, tier: args.tier, reasons: args.reasons, reviewedHead: args.detail.headRefOid, error: 'clone failed' });
    },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  for (let tick = 0; tick < MAX_REVIEW_ATTEMPTS + 1; tick += 1) {
    await poller.tick();
    await settle();
  }
  assert.equal(spawned.length, MAX_REVIEW_ATTEMPTS);
  assert.equal(poller._state()[`${REPO}#1`]?.reviewAttempts, MAX_REVIEW_ATTEMPTS);
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'error');
  await poller.stop();
});

test('a moved head waits after exhausted errors, then resets the attempt count', async () => {
  const { poller, github, spawned, setNow } = setup({
    spawnReview: async (args) => {
      spawned.push(args);
      return errorDraft({ candidate: args.candidate, tier: args.tier, reasons: args.reasons, reviewedHead: args.detail.headRefOid, error: 'timed out' });
    },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  for (let tick = 0; tick < MAX_REVIEW_ATTEMPTS; tick += 1) {
    await poller.tick();
    await settle();
  }
  assert.equal(poller._state()[`${REPO}#1`]?.reviewAttempts, MAX_REVIEW_ATTEMPTS);
  github.heads.set(1, HEAD_TWO);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, MAX_REVIEW_ATTEMPTS);
  setNow(1000 + DEFAULT_RE_REVIEW_AFTER_HOURS * 3600000);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, MAX_REVIEW_ATTEMPTS + 1);
  assert.equal(spawned.at(-1)?.detail.headRefOid, HEAD_TWO);
  assert.equal(poller._state()[`${REPO}#1`]?.reviewAttempts, 1);
  await poller.stop();
});

test('updateDraft rejects a patch that breaks the draft schema and keeps identity fields', async () => {
  const { poller, github } = setup({
    spawnReview: async ({ candidate, tier, reasons, detail }) => errorDraft({ candidate, tier, reasons, reviewedHead: detail.headRefOid, error: 'x' }),
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  const expected = { reviewedHead: HEAD_ONE, status: 'error' } as const;
  assert.equal(await poller.updateDraft(`${REPO}#1`, expected, { reviewedHead: 'nope' }), null);
  assert.equal(await poller.updateDraft('Acme/other#1', expected, { status: 'posted' }), null);
  const updated = await poller.updateDraft(`${REPO}#1`, expected, { body: 'edited' });
  assert.equal(updated?.body, 'edited');
  assert.equal(updated?.key, `${REPO}#1`);
  await poller.stop();
});

test('updateDraft is a compare-and-set that leaves a draft alone when its head or status moved', async () => {
  const { poller, github } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(await poller.updateDraft(`${REPO}#1`, { reviewedHead: HEAD_TWO, status: 'ready' }, { status: 'posted' }), null);
  assert.equal(await poller.updateDraft(`${REPO}#1`, { reviewedHead: HEAD_ONE, status: 'stale' }, { status: 'posted' }), null);
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'ready');
  const posted = await poller.updateDraft(`${REPO}#1`, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' });
  assert.equal(posted?.status, 'posted');
  await poller.stop();
});

test('a running review reports its PR, tier, phase and tool steps in the status until it finishes', async () => {
  const release: { resolve?: () => void } = {};
  const gate = new Promise<void>((resolve) => { release.resolve = resolve; });
  const { poller, github, statuses, setNow } = setup({
    spawnReview: async (args) => {
      args.reportProgress?.({ kind: 'phase', phase: 'reviewing', tier: args.tier, reasons: args.reasons, timeoutSeconds: 60 });
      args.reportProgress?.({ kind: 'step', tool: 'Read', detail: 'pr.diff' });
      await gate;
      return draftFor(args);
    },
  });
  github.requested = [searchItem(1, 'teammate', { created_at: '2026-09-26T12:00:00Z' })];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  const running = statuses.at(-1)?.inFlight[0];
  assert.equal(running?.title, 'PR 1');
  assert.equal(running?.tier, 'stamp');
  assert.equal(running?.phase, 'reviewing');
  assert.equal(running?.startedAt, 1000);
  assert.equal(running?.prCreatedAt, '2026-09-26T12:00:00Z');
  assert.equal(running?.deadlineAt, 61000);
  assert.equal(running?.toolCalls, 1);
  assert.deepEqual(running?.recentSteps, [{ at: 1000, tool: 'Read', detail: 'pr.diff' }]);
  for (const status of statuses) assert.equal(TeamReviewStatus.safeParse(status).success, true);
  setNow(5000);
  release.resolve?.();
  await settle();
  assert.deepEqual(statuses.at(-1)?.inFlight, []);
  assert.equal(statuses.at(-1)?.drafts[0]?.prCreatedAt, '2026-09-26T12:00:00Z');
  assert.equal(statuses.at(-1)?.drafts[0]?.reviewedAt, 5000);
  await poller.stop();
});

test('progress reported after a review finishes is ignored', async () => {
  let lateReport: SpawnReviewArgs['reportProgress'];
  const { poller, github, statuses } = setup({
    spawnReview: async (args) => { lateReport = args.reportProgress; return draftFor(args); },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  const statusCount = statuses.length;
  lateReport?.({ kind: 'step', tool: 'Read', detail: 'late' });
  assert.equal(statuses.length, statusCount);
  assert.deepEqual(statuses.at(-1)?.inFlight, []);
  await poller.stop();
});

test('tool steps inside the emit interval coalesce into one trailing status that the finished review supersedes', async () => {
  const release: { resolve?: () => void } = {};
  const gate = new Promise<void>((resolve) => { release.resolve = resolve; });
  const report: { progress?: SpawnReviewArgs['reportProgress'] } = {};
  const timers: { fn: () => void; ms: number; isCleared: boolean }[] = [];
  const timerByHandle = new Map<NodeJS.Timeout, { fn: () => void; ms: number; isCleared: boolean }>();
  const { poller, github, statuses, setNow } = setup({
    spawnReview: async (args) => { report.progress = args.reportProgress; await gate; return draftFor(args); },
    setTimeoutFn: (fn, ms) => {
      const timer = { fn, ms, isCleared: false };
      const handle = ({}) as NodeJS.Timeout;
      timers.push(timer);
      timerByHandle.set(handle, timer);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      const timer = timerByHandle.get(handle);
      if (timer) timer.isCleared = true;
    },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  const statusCountAfterTick = statuses.length;
  setNow(1400);
  report.progress?.({ kind: 'step', tool: 'Read', detail: 'one' });
  report.progress?.({ kind: 'step', tool: 'Grep', detail: 'two' });
  assert.equal(statuses.length, statusCountAfterTick);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.ms, 600);
  setNow(2000);
  timers[0]?.fn();
  assert.equal(statuses.length, statusCountAfterTick + 1);
  assert.equal(statuses.at(-1)?.inFlight[0]?.toolCalls, 2);
  setNow(3500);
  report.progress?.({ kind: 'step', tool: 'Read', detail: 'three' });
  assert.equal(statuses.length, statusCountAfterTick + 2);
  report.progress?.({ kind: 'step', tool: 'Read', detail: 'four' });
  assert.equal(timers.length, 2);
  release.resolve?.();
  await poller.stop();
  assert.equal(timers[1]?.isCleared, true);
  assert.deepEqual(statuses.at(-1)?.inFlight, []);
});

test('a requeued posted review whose PR moved reviews the new head as a re-review of the posted one', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.ok(await poller.updateDraft(key, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' }));
  github.heads.set(1, HEAD_TWO);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].priorReview?.head, HEAD_ONE);
  assert.equal(spawned[1].priorReview?.wasPosted, true);
  assert.equal(poller.getDraft(key)?.reviewedHead, HEAD_TWO);
  assert.equal(poller.getDraft(key)?.priorReviewedHead, HEAD_ONE);
  await poller.stop();
});

test('a requeued discard whose PR moved reviews the new head from scratch, not as a re-review of the rejected one', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned, statuses } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.ok(await poller.updateDraft(key, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'discarded' }));
  github.heads.set(1, HEAD_TWO);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  assert.equal(poller._state()[key]?.discardedReviewHead, HEAD_ONE);
  const requeuedDraft = statuses.at(-1)?.drafts.find((row) => row.key === key);
  assert.deepEqual({ status: requeuedDraft?.status, earlierReview: requeuedDraft?.earlierReview }, { status: 'stale', earlierReview: undefined });
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].priorReview, undefined);
  assert.equal(poller.getDraft(key)?.reviewedHead, HEAD_TWO);
  assert.equal(poller.getDraft(key)?.priorReviewedHead, undefined);
  assert.equal(poller._state()[key]?.discardedReviewHead, undefined);
  await poller.stop();
});

test('a requeue at the head of a re-review redoes it from scratch instead of reusing the older earlier review', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.ok(await poller.updateDraft(key, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' }));
  github.heads.set(1, HEAD_TWO);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  await poller.tick();
  await settle();
  assert.equal(spawned[1].priorReview?.head, HEAD_ONE);
  assert.ok(await poller.updateDraft(key, { reviewedHead: HEAD_TWO, status: 'ready' }, { status: 'posted' }));
  assert.equal(await poller.requeue(key, HEAD_TWO), true);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 3);
  assert.equal(spawned[2].priorReview, undefined);
  assert.equal(poller.getDraft(key)?.priorReviewedHead, undefined);
  await poller.stop();
});

test('a from-scratch redo at the head of a re-review that crashes retries from scratch', async () => {
  const key = `${REPO}#1`;
  let isSpawnFailing = false;
  const { poller, github, spawned } = setup({
    spawnReview: async (args) => {
      spawned.push(args);
      if (isSpawnFailing) throw new Error('pty exploded');
      return draftFor(args);
    },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.ok(await poller.updateDraft(key, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' }));
  github.heads.set(1, HEAD_TWO);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  await poller.tick();
  await settle();
  assert.equal(spawned[1].priorReview?.head, HEAD_ONE);
  assert.equal(await poller.requeue(key, HEAD_TWO), true);
  isSpawnFailing = true;
  await poller.tick();
  await settle();
  assert.equal(spawned[2].priorReview, undefined);
  assert.equal(poller.getDraft(key)?.status, 'error');
  isSpawnFailing = false;
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 4);
  assert.equal(spawned[3].priorReview, undefined);
  assert.equal(poller.getDraft(key)?.priorReviewedHead, undefined);
  await poller.stop();
});

test('a crashed same-head redo of a posted review still hands the posted review to the next head', async () => {
  const key = `${REPO}#1`;
  let isSpawnFailing = false;
  const { poller, github, spawned, setNow } = setup({
    spawnReview: async (args) => {
      spawned.push(args);
      if (isSpawnFailing) throw new Error('pty exploded');
      return draftFor(args);
    },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.ok(await poller.updateDraft(key, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'posted' }));
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  isSpawnFailing = true;
  await poller.tick();
  await settle();
  assert.equal(spawned[1].priorReview, undefined);
  assert.equal(poller.getDraft(key)?.status, 'error');
  isSpawnFailing = false;
  github.heads.set(1, HEAD_TWO);
  setNow(1000 + DEFAULT_RE_REVIEW_AFTER_HOURS * 3600000);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 3);
  assert.equal(spawned[2].priorReview?.head, HEAD_ONE);
  assert.equal(spawned[2].priorReview?.wasPosted, true);
  await poller.stop();
});

test('a requeue at an unchanged head reviews again from scratch', async () => {
  const key = `${REPO}#1`;
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].priorReview, undefined);
  assert.equal(poller.getDraft(key)?.priorReviewedHead, undefined);
  await poller.stop();
});

test('a re-review that crashes keeps the earlier review for its retry', async () => {
  const key = `${REPO}#1`;
  let isSpawnFailing = false;
  const { poller, github, spawned } = setup({
    spawnReview: async (args) => {
      spawned.push(args);
      if (isSpawnFailing) throw new Error('pty exploded');
      return draftFor(args);
    },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  github.heads.set(1, HEAD_TWO);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  isSpawnFailing = true;
  await poller.tick();
  await settle();
  assert.equal(poller.getDraft(key)?.status, 'error');
  isSpawnFailing = false;
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 3);
  assert.equal(spawned[2].priorReview?.head, HEAD_ONE);
  assert.equal(spawned[2].priorReview?.wasPosted, false);
  assert.equal(poller.getDraft(key)?.status, 'ready');
  assert.equal(poller.getDraft(key)?.priorReviewedHead, HEAD_ONE);
  await poller.stop();
});

test('pull requests beyond the free review slots are reported as queued until a slot frees', async () => {
  const pending: Array<() => void> = [];
  const { poller, github, spawned, statuses } = setup({
    maxConcurrentReviews: 1,
    spawnReview: async (args) => {
      spawned.push(args);
      await new Promise<void>((resolve) => { pending.push(resolve); });
      return draftFor(args);
    },
  });
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate'), searchItem(3, 'teammate')];
  for (const number of [1, 2, 3]) github.heads.set(number, HEAD_ONE);
  await poller.start();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.number), [1]);
  assert.deepEqual(statuses.at(-1)?.queued.map((review) => review.number), [2, 3]);
  pending.shift()?.();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.number), [1, 2], 'a finished review starts the next queued one without waiting for the poll');
  assert.deepEqual(statuses.at(-1)?.queued.map((review) => review.number), [3]);
  pending.shift()?.();
  await settle();
  pending.shift()?.();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.number), [1, 2, 3]);
  assert.deepEqual(statuses.at(-1)?.queued, []);
  await poller.stop();
});

test('an incomplete search with an exhausted GitHub rate limit backs off until the reset and starts no review', async () => {
  const warnings: string[] = [];
  const { poller, github, spawned } = setup({ log: { warn: (message: string) => { warnings.push(message); } } });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, 'a'.repeat(40));
  github.isRequestedComplete = false;
  github.rateLimitWait = 120_000;
  await poller.start();
  await settle();
  assert.equal(spawned.length, 0);
  assert.ok(warnings.some((message) => /backing off 120s/.test(message)), warnings.join('\n'));
  await poller.stop();
});

test('an incomplete search without an exhausted rate limit still reviews what it found', async () => {
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, 'a'.repeat(40));
  github.isRequestedComplete = false;
  await poller.start();
  await settle();
  assert.equal(spawned.length, 1);
  await poller.stop();
});

test('a candidate search failure reports its error and schedule without losing the last good drafts', async () => {
  const { poller, github, statuses, setNow } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  const lastGoodDrafts = statuses.at(-1)?.drafts;
  assert.equal(lastGoodDrafts?.length, 1);
  const successfulSearch = github.readTeamRequested;
  github.readTeamRequested = async () => { throw new Error('offline'); };
  await poller.tick();
  assert.equal(statuses.at(-1)?.error, 'offline');
  assert.equal(statuses.at(-1)?.nextAttemptAt, 11_000);
  assert.deepEqual(statuses.at(-1)?.retry, { attempt: 1, limit: 3 });
  assert.deepEqual(statuses.at(-1)?.drafts, lastGoodDrafts);
  github.readTeamRequested = successfulSearch;
  setNow(61_000);
  assert.equal((await poller.refresh()).ok, true);
  assert.equal(statuses.at(-1)?.error, null);
  assert.equal(statuses.at(-1)?.nextAttemptAt, null);
  assert.equal(statuses.at(-1)?.retry, null);
  await poller.stop();
});

test('a GitHub secondary rate limit on the candidate search waits a minute with no quick retries and refuses refresh', async () => {
  const { poller, github, statuses } = setup();
  let searchCount = 0;
  github.readTeamRequested = async () => {
    searchCount += 1;
    throw new Error('gh: You have triggered an abuse detection mechanism. Please wait a few minutes before you try again. (HTTP 403)');
  };
  await poller.start();
  assert.equal(statuses.at(-1)?.retry, null);
  assert.equal(statuses.at(-1)?.nextAttemptAt, 61_000);
  assert.equal((await poller.refresh()).ok, false);
  assert.equal(searchCount, 1);
  await poller.stop();
});

test('direct requests reach review once and survive an incomplete direct search', async () => {
  const { poller, github, spawned, statuses } = setup();
  github.directRequested = [searchItem(1, 'outside-team')];
  github.requested = [searchItem(1, 'outside-team')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.candidate.requestSource, 'direct');
  assert.equal(statuses.at(-1)?.drafts[0]?.requestSource, 'direct');
  github.directRequested = [];
  github.requested = [];
  github.isDirectRequestedComplete = false;
  await poller.tick();
  assert.ok(poller.getDraft(`${REPO}#1`));
  github.isDirectRequestedComplete = true;
  await poller.tick();
  assert.equal(poller.getDraft(`${REPO}#1`), null);
  await poller.stop();
});

test('existing draft priority refreshes when direct requests and CI change', async () => {
  const { poller, store, github, spawned, statuses } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  github.directRequested = [searchItem(1, 'teammate')];
  github.decisions.set(1, 'REVIEW_REQUIRED');
  github.checksStates.set(1, 'FAILURE');
  const unsubscribe = store.subscribe('snapshot-changed', poller.rebuild);
  await store.refreshWatches(Object.keys(store.getSnapshot().watches));
  unsubscribe();
  const review = statuses.at(-1)?.drafts[0];
  assert.equal(review?.requestSource, 'direct');
  assert.equal(review?.checksState, 'FAILURE');
  assert.equal(review?.reviewDecision, 'REVIEW_REQUIRED');
  assert.equal(spawned.length, 1);
  await poller.stop();
});

const GUARDRAILS_REFUSAL = 'not started: the Claude Code sandbox needs bwrap and socat, and socat is not on PATH. Install bubblewrap and socat';

function savedResumableState(): TeamReviewState {
  return { [`${REPO}#1`]: { draft: null, reviewedHead: null, inFlight: false, skipReason: null, reviewAttempts: 0, updatedAt: 1000, resumable: RESUMABLE } };
}

test('a refused guardrails probe starts no review, counts no attempt, writes no draft, keeps the saved resume record and reports the reason', async () => {
  const discarded: string[] = [];
  const { poller, github, spawned, statuses } = setup({
    readState: async () => savedResumableState(),
    discardResumable: async (record) => { discarded.push(record.sessionId); },
    guardrailsRefusal: () => GUARDRAILS_REFUSAL,
  });
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.heads.set(2, HEAD_TWO);
  await poller.start();
  await settle();
  for (let tickNumber = 0; tickNumber < MAX_REVIEW_ATTEMPTS + 1; tickNumber += 1) await poller.tick();
  await settle();
  assert.equal(spawned.length, 0);
  assert.deepEqual(discarded, []);
  assert.deepEqual(poller._state()[`${REPO}#1`]?.resumable, RESUMABLE);
  assert.equal(poller._state()[`${REPO}#1`]?.reviewAttempts, 0);
  assert.equal(poller.getDraft(`${REPO}#1`), null);
  assert.equal(poller._state()[`${REPO}#2`], undefined);
  const latest = TeamReviewStatus.parse(statuses.at(-1));
  assert.equal(latest.reason, GUARDRAILS_REFUSAL);
  assert.equal(latest.error, null);
  assert.deepEqual(latest.queued, []);
  assert.deepEqual(latest.drafts, []);
  await poller.stop();
});

test('after a boot whose guardrails probe passes, held reviews start and the saved one resumes', async () => {
  const { poller, github, spawned, statuses } = setup({ readState: async () => savedResumableState() });
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.heads.set(2, HEAD_TWO);
  await poller.start();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.key).sort(), [`${REPO}#1`, `${REPO}#2`]);
  assert.deepEqual(spawned.find((args) => args.candidate.key === `${REPO}#1`)?.resume, RESUMABLE);
  assert.equal(poller.getDraft(`${REPO}#2`)?.status, 'ready');
  assert.equal(statuses.at(-1)?.reason, null);
  await poller.stop();
});


async function answeredThreadHarness(severity: string, isResolveSuccessful = true, isJudgeSuccessful = true) {
  let node = threadNode(severity);
  let judgeCalls = 0;
  let resolveCalls = 0;
  let compareCalls = 0;
  const harness = setup({ judgeThread: async () => { judgeCalls += 1; return isJudgeSuccessful ? { addressed: true, reason: 'Guard added' } : null; } });
  harness.github.requested = [searchItem(1, 'teammate')];
  harness.github.heads.set(1, HEAD_ONE);
  await harness.poller.start();
  await settle();
  harness.github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  harness.github.decisions.set(1, 'APPROVED');
  harness.github.teamReviewThreads = async (prs) => {
    assert.deepEqual(prs.map((pr) => pr.number), [1]);
    return new Map([[`${REPO}#1`, [structuredClone(node)]]]);
  };
  harness.github.resolveReviewThread = async () => {
    resolveCalls += 1;
    if (isResolveSuccessful) node.isResolved = true;
    return { ok: isResolveSuccessful, err: isResolveSuccessful ? '' : 'denied' };
  };
  harness.github.teamReviewCompare = async (_repo, base, head) => {
    assert.equal(base, THREAD_BASE);
    assert.equal(head, harness.github.heads.get(1));
    compareCalls += 1;
    return { ok: true, comparison: { merge_base_commit: { sha: THREAD_BASE }, files: [{ filename: 'src/app.ts', patch: '@@ -1 +1 @@\n+guard' }] } };
  };
  await harness.poller.tick();
  return { ...harness, counts: () => ({ judgeCalls, resolveCalls, compareCalls }), replaceNode: (replacement: typeof node) => { node = replacement; } };
}

test('answered nit is automatically resolved once without invoking a judge', async () => {
  const harness = await answeredThreadHarness('LOW');
  try {
    await harness.poller.tick();
    assert.deepEqual(harness.counts(), { judgeCalls: 0, resolveCalls: 1, compareCalls: 0 });
    assert.ok(harness.writes.some((state) => state[`${REPO}#1`]?.threads?.[0]?.resolveAttemptReplyAt));
  } finally { await harness.poller.stop(); }
});

test('automatic resolve failure persists and does not repeat until a new reply', async () => {
  const harness = await answeredThreadHarness('LOW', false);
  try {
    await harness.poller.tick();
    assert.equal(harness.counts().resolveCalls, 1);
    assert.equal(harness.poller._state()[`${REPO}#1`].threads?.[0].resolveError, 'denied');
    const updated = threadNode('LOW');
    updated.comments.nodes[1].createdAt = '2026-10-02T12:00:00Z';
    harness.replaceNode(updated);
    await harness.poller.tick();
    assert.equal(harness.counts().resolveCalls, 2);
  } finally { await harness.poller.stop(); }
});

test('non-nit judgement is reused only for the same head and reply and never resolves automatically', async () => {
  const harness = await answeredThreadHarness('MEDIUM');
  try {
    await harness.poller.tick();
    assert.deepEqual(harness.counts(), { judgeCalls: 1, resolveCalls: 0, compareCalls: 1 });
    assert.equal(harness.statuses.at(-1)?.drafts[0].threads?.[0].judgement?.addressed, true);
    harness.github.heads.set(1, HEAD_TWO);
    await harness.poller.tick();
    assert.equal(harness.counts().judgeCalls, 2);
    const updated = threadNode();
    updated.comments.nodes[1].createdAt = '2026-10-02T12:00:00Z';
    harness.replaceNode(updated);
    await harness.poller.tick();
    assert.equal(harness.counts().judgeCalls, 3);
    assert.equal(harness.counts().resolveCalls, 0);
  } finally { await harness.poller.stop(); }
});

test('judge failure produces no judgement or resolution and backs off before trying again', async () => {
  const harness = await answeredThreadHarness('HIGH', true, false);
  try {
    await harness.poller.tick();
    assert.equal(harness.counts().judgeCalls, 1);
    assert.equal(harness.poller._state()[`${REPO}#1`].threads?.[0].judgement, undefined);
    harness.setNow(1000 + 15 * 60 * 1000);
    await harness.poller.tick();
    assert.equal(harness.counts().judgeCalls, 2);
    assert.equal(harness.counts().resolveCalls, 0);
  } finally { await harness.poller.stop(); }
});


test('viewer threads are presented even when GitHub approval predates any local draft', async () => {
  const github = fakeGithub();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  github.decisions.set(1, 'APPROVED');
  github.teamReviewThreads = async () => new Map([[`${REPO}#1`, [threadNode()]]]);
  github.resolveReviewThread = async () => { throw new Error('non-nit must not auto resolve'); };
  const harness = setup({ github });
  try {
    await harness.poller.start();
    await settle();
    assert.equal(harness.spawned.length, 0);
    assert.equal(harness.statuses.at(-1)?.drafts[0].threads?.length, 1);
  } finally { await harness.poller.stop(); }
});

test('a thread with no new hunks is judged with empty patch evidence and unavailable comparisons back off', async () => {
  for (const comparison of [{ merge_base_commit: { sha: THREAD_BASE }, files: [] }, null]) {
    let judgeCalls = 0;
    const harness = await answeredThreadHarness('MEDIUM');
    try {
      harness.github.heads.set(1, HEAD_TWO);
      harness.github.teamReviewCompare = async () => ({ ok: true, comparison });
      const node = threadNode();
      node.comments.nodes[1].createdAt = '2026-10-02T12:00:00Z';
      harness.replaceNode(node);
      const priorCalls = harness.counts().judgeCalls;
      await harness.poller.tick();
      judgeCalls = harness.counts().judgeCalls - priorCalls;
      assert.equal(judgeCalls, comparison === null ? 0 : 1);
      await harness.poller.tick();
      assert.equal(harness.counts().judgeCalls - priorCalls, judgeCalls);
    } finally { await harness.poller.stop(); }
  }
});

test('threads sharing an original commit use one comparison and run judges serially', async () => {
  const github = fakeGithub();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  github.decisions.set(1, 'APPROVED');
  const nodes = [threadNode(), threadNode('HIGH', { id: 'PRRT_acme_2' })];
  github.teamReviewThreads = async () => new Map([[`${REPO}#1`, nodes]]);
  github.resolveReviewThread = async () => { throw new Error('non-nit must not resolve automatically'); };
  let comparisons = 0;
  github.teamReviewCompare = async () => { comparisons += 1; return { ok: true, comparison: { merge_base_commit: { sha: THREAD_BASE }, files: [{ filename: 'src/app.ts', patch: '+guard' }] } }; };
  let activeJudges = 0;
  let judgeCalls = 0;
  const harness = setup({ github, judgeThread: async () => {
    activeJudges += 1;
    judgeCalls += 1;
    assert.equal(activeJudges, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    activeJudges -= 1;
    return { addressed: false, reason: 'Guard is insufficient' };
  } });
  try {
    await harness.poller.start();
    await settle();
    assert.equal(comparisons, 1);
    assert.equal(judgeCalls, 2);
    assert.equal(harness.poller._state()[`${REPO}#1`].threads?.length, 2);
    await harness.poller.tick();
    assert.equal(comparisons, 1);
    assert.equal(judgeCalls, 2);
  } finally { await harness.poller.stop(); }
});

test('a failed commit group cannot starve threads from another original commit', async () => {
  const github = fakeGithub();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  const secondBase = 'c'.repeat(40);
  const second = threadNode('HIGH', { id: 'PRRT_acme_2' });
  second.comments.nodes[0].originalCommit = { oid: secondBase };
  github.teamReviewThreads = async () => new Map([[`${REPO}#1`, [threadNode(), second]]]);
  github.resolveReviewThread = async () => { throw new Error('must not resolve'); };
  const bases: string[] = [];
  github.teamReviewCompare = async (_repo, base) => {
    bases.push(base);
    if (base === THREAD_BASE) return { ok: true, comparison: null };
    return { ok: true, comparison: { merge_base_commit: { sha: base }, files: [{ filename: 'src/renamed.ts', previous_filename: 'src/app.ts', patch: '+guard' }] } };
  };
  let judgeCalls = 0;
  const harness = setup({ github, judgeThread: async (prompt) => {
    judgeCalls += 1;
    assert.match(prompt, /\+guard/);
    return { addressed: true, reason: 'Guard added in renamed file' };
  } });
  try {
    await harness.poller.start();
    await settle();
    assert.deepEqual(bases, [THREAD_BASE]);
    harness.setNow(1000 + 15 * 60 * 1000);
    await harness.poller.tick();
    assert.deepEqual(bases, [THREAD_BASE, secondBase]);
    assert.equal(judgeCalls, 1);
    assert.equal(harness.poller._state()[`${REPO}#1`].threads?.[1].judgement?.addressed, true);
  } finally { await harness.poller.stop(); }
});

test('viewer reviews at an older head qualify for thread handling before a new local review', async () => {
  const github = fakeGithub();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_TWO);
  github.reviews.set(1, [{ login: 'me', state: 'COMMENTED', commit: HEAD_ONE }]);
  github.teamReviewThreads = async () => new Map([[`${REPO}#1`, [threadNode('LOW')]]]);
  let resolveCalls = 0;
  github.resolveReviewThread = async () => { resolveCalls += 1; return { ok: true, err: '' }; };
  const harness = setup({ github });
  try {
    await harness.poller.start();
    await settle();
    assert.equal(resolveCalls, 1);
    assert.equal(harness.spawned.length, 1);
  } finally { await harness.poller.stop(); }
});

function approvedWithoutDraft(nodes: () => ReturnType<typeof threadNode>[]) {
  const github = fakeGithub();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.reviews.set(1, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE }]);
  github.decisions.set(1, 'APPROVED');
  github.teamReviewThreads = async () => new Map([[`${REPO}#1`, nodes()]]);
  return github;
}

test('a placeholder draft exists only while an answered thread needs the operator', async () => {
  const github = approvedWithoutDraft(() => [threadNode()]);
  github.resolveReviewThread = async () => { throw new Error('non-nit must not auto resolve'); };
  const harness = setup({ github });
  try {
    await harness.poller.start();
    await settle();
    const entry = () => harness.poller._state()[`${REPO}#1`];
    assert.equal(harness.spawned.length, 0);
    assert.equal(entry().draft?.error, THREAD_PLACEHOLDER_ERROR);
    assert.equal(harness.statuses.at(-1)?.drafts[0].threads?.length, 1);
    assert.equal(await harness.poller.updateThread(`${REPO}#1`, 'PRRT_acme_1', { isResolved: true }), true);
    assert.equal(entry().draft, null);
    assert.equal(harness.statuses.at(-1)?.drafts.length, 0);
  } finally { await harness.poller.stop(); }
});

test('an operator resolve of a nit whose automatic resolve failed clears its error and the placeholder draft', async () => {
  const github = approvedWithoutDraft(() => [threadNode('LOW')]);
  github.resolveReviewThread = async () => ({ ok: false, err: 'denied' });
  const harness = setup({ github });
  try {
    await harness.poller.start();
    await settle();
    const entry = () => harness.poller._state()[`${REPO}#1`];
    assert.equal(entry().threads?.[0].resolveError, 'denied');
    assert.equal(entry().draft?.error, THREAD_PLACEHOLDER_ERROR);
    assert.equal(await harness.poller.updateThread(`${REPO}#1`, 'PRRT_acme_1', { isResolved: true }), true);
    assert.equal(entry().threads?.[0].resolveError, undefined);
    assert.equal(entry().draft, null);
  } finally { await harness.poller.stop(); }
});

test('a nit resolved on its first tick never leaves a placeholder draft behind', async () => {
  const node = threadNode('LOW');
  const github = approvedWithoutDraft(() => [structuredClone(node)]);
  let resolveCalls = 0;
  github.resolveReviewThread = async () => { resolveCalls += 1; node.isResolved = true; return { ok: true, err: '' }; };
  const harness = setup({ github });
  try {
    await harness.poller.start();
    await settle();
    assert.equal(resolveCalls, 1);
    assert.equal(harness.poller._state()[`${REPO}#1`].draft, null);
    await harness.poller.tick();
    assert.equal(harness.poller._state()[`${REPO}#1`].draft, null);
    assert.equal(harness.statuses.at(-1)?.drafts.length, 0);
  } finally { await harness.poller.stop(); }
});

test('a nit reopened on GitHub after its automatic resolve is never resolved again and is handed to the operator', async () => {
  const harness = await answeredThreadHarness('LOW');
  try {
    await harness.poller.tick();
    assert.equal(harness.counts().resolveCalls, 1);
    await harness.poller.tick();
    assert.equal(harness.poller._state()[`${REPO}#1`].threads?.length, 0);
    harness.replaceNode(threadNode('LOW'));
    await harness.poller.tick();
    await harness.poller.tick();
    assert.equal(harness.counts().resolveCalls, 1);
    assert.deepEqual(harness.poller._state()[`${REPO}#1`].autoResolvedThreadIds, ['PRRT_acme_1']);
    assert.ok(harness.writes.at(-1)?.[`${REPO}#1`]?.autoResolvedThreadIds?.includes('PRRT_acme_1'));
    assert.equal(harness.statuses.at(-1)?.drafts[0].threads?.[0].isNit, false);
  } finally { await harness.poller.stop(); }
});

test('an answered thread on a PR the viewer commented on never delays reviewing a new head', async () => {
  const github = fakeGithub();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  github.reviews.set(1, [{ login: 'me', state: 'COMMENTED', commit: HEAD_ONE }]);
  github.teamReviewThreads = async () => new Map([[`${REPO}#1`, [threadNode()]]]);
  github.resolveReviewThread = async () => { throw new Error('non-nit must not auto resolve'); };
  const harness = setup({ github });
  try {
    await harness.poller.start();
    await settle();
    assert.equal(harness.spawned.length, 0);
    assert.equal(harness.poller._state()[`${REPO}#1`].draft?.error, THREAD_PLACEHOLDER_ERROR);
    github.heads.set(1, HEAD_TWO);
    await harness.poller.tick();
    await settle();
    assert.equal(harness.spawned.length, 1);
    assert.equal(harness.spawned[0].detail.headRefOid, HEAD_TWO);
  } finally { await harness.poller.stop(); }
});

test('an unjudgeable thread records its reason and is not retried until the head or reply changes, while transient compare failures back off', async () => {
  for (const failure of ['rewritten', 'thrown', 'transport'] as const) {
    const isTransient = failure !== 'rewritten';
    const github = approvedWithoutDraft(() => [threadNode()]);
    github.resolveReviewThread = async () => { throw new Error('non-nit must not auto resolve'); };
    let compareCalls = 0;
    github.teamReviewCompare = async () => {
      compareCalls += 1;
      if (failure === 'thrown') throw new Error('network down');
      if (failure === 'transport') return { ok: false, err: 'HTTP 502: Bad Gateway' };
      return { ok: true, comparison: null };
    };
    let judgeCalls = 0;
    const harness = setup({ github, judgeThread: async () => { judgeCalls += 1; return { addressed: true, reason: 'Guard added' }; } });
    try {
      await harness.poller.start();
      await settle();
      const thread = () => harness.poller._state()[`${REPO}#1`].threads?.[0];
      assert.equal(compareCalls, 1);
      assert.equal(judgeCalls, 0);
      assert.equal(thread()?.unjudgeable?.reason.startsWith('History was rewritten'), isTransient ? undefined : true);
      if (!isTransient) assert.equal(harness.statuses.at(-1)?.drafts[0].threads?.[0].unjudgeable?.head, HEAD_ONE);
      harness.setNow(1000 + 15 * 60 * 1000);
      await harness.poller.tick();
      assert.equal(compareCalls, isTransient ? 2 : 1);
      github.heads.set(1, HEAD_TWO);
      await harness.poller.tick();
      assert.equal(compareCalls, isTransient ? 3 : 2);
    } finally { await harness.poller.stop(); }
  }
});


test('viewer thread tally persists and reaches both draft paths and changes only with thread counts', async () => {
  const harness = await answeredThreadHarness('HIGH', true, false);
  try {
    const key = `${REPO}#1`;
    assert.deepEqual(harness.poller._state()[key].viewerThreads, { total: 1, resolved: 0 });
    assert.deepEqual(harness.poller.getDraft(key)?.viewerThreads, { total: 1, resolved: 0 });
    assert.deepEqual(harness.statuses.at(-1)?.drafts[0].viewerThreads, { total: 1, resolved: 0 });
    assert.ok(harness.writes.some((state) => state[key].viewerThreads?.total === 1));
    const writesBefore = harness.writes.length;
    await harness.poller.tick();
    assert.equal(harness.writes.length, writesBefore);
    harness.replaceNode(threadNode('HIGH', { isResolved: true }));
    await harness.poller.tick();
    assert.deepEqual(harness.poller._state()[key].viewerThreads, { total: 1, resolved: 1 });
    assert.deepEqual(harness.poller.getDraft(key)?.viewerThreads, { total: 1, resolved: 1 });
    assert.deepEqual(harness.statuses.at(-1)?.drafts[0].viewerThreads, { total: 1, resolved: 1 });
    assert.ok(harness.writes.length > writesBefore);
  } finally {
    await harness.poller.stop();
  }
});

test('automatic nit resolution updates viewer counts in the same poll', async () => {
  const harness = await answeredThreadHarness('LOW');
  try {
    assert.deepEqual(harness.poller.getDraft(`${REPO}#1`)?.viewerThreads, { total: 1, resolved: 1 });
    assert.deepEqual(harness.statuses.at(-1)?.drafts[0].viewerThreads, { total: 1, resolved: 1 });
  } finally {
    await harness.poller.stop();
  }
});
