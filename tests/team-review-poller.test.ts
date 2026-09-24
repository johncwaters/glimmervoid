import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_REVIEW_ATTEMPTS, POSTED_RETENTION_MS, errorDraft, readyDraft } from '../server/core/team-review-core.ts';
import { createTeamReviewPoller } from '../server/team-review-poller.ts';
import type { SpawnReviewArgs, TeamReviewGithub, TeamReviewPollerDependencies } from '../server/team-review-poller.ts';
import { PrDetail, SearchedPr, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import type { ReviewDraft, TeamReviewState, TeamReviewStatus as TeamReviewStatusType } from '../shared/contracts/team-review.ts';

const REPO = 'Acme/app';
const HEAD_ONE = '1'.repeat(40);
const HEAD_TWO = '2'.repeat(40);

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
    result: { verdict: 'STAMP', head: detail.headRefOid, summary: 'fine', body: 'Looks right.', comments: [] },
  });
}

interface FakeGithub extends TeamReviewGithub {
  requested: SearchedPr[];
  authored: SearchedPr[];
  isRequestedComplete: boolean;
  isAuthoredComplete: boolean;
  heads: Map<number, string>;
  authoredQueries: string[][];
  failViewer: boolean;
}

function fakeGithub(): FakeGithub {
  const github: FakeGithub = {
    requested: [],
    authored: [],
    isRequestedComplete: true,
    isAuthoredComplete: true,
    heads: new Map(),
    authoredQueries: [],
    failViewer: false,
    viewer: async () => (github.failViewer ? null : 'me'),
    teamMembers: async () => ['me', 'teammate', 'other'],
    searchTeamRequested: async () => ({ items: github.requested, complete: github.isRequestedComplete }),
    searchAuthoredBy: async (_org, logins) => {
      github.authoredQueries.push(logins);
      return { items: github.authored, complete: github.isAuthoredComplete };
    },
    viewPr: async (_repo, number) => {
      const head = github.heads.get(number);
      return head ? prDetail(number, head) : null;
    },
    prHead: async (_repo, number) => github.heads.get(number) ?? null,
  };
  return github;
}

function setup(overrides: Partial<TeamReviewPollerDependencies> = {}) {
  const github = fakeGithub();
  const writes: TeamReviewState[] = [];
  const statuses: TeamReviewStatusType[] = [];
  const spawned: SpawnReviewArgs[] = [];
  let nowMs = 1000;
  const dependencies: TeamReviewPollerDependencies = {
    org: 'Acme',
    team: 'core',
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
  const poller = createTeamReviewPoller(dependencies);
  return { poller, github, writes, statuses, spawned, setNow: (value: number) => { nowMs = value; } };
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('requested and authored PRs are deduped and self, bots and drafts never reach a review', async () => {
  const { poller, github, spawned, statuses } = setup();
  github.requested = [searchItem(1, 'teammate'), searchItem(2, 'me'), searchItem(3, 'dependabot[bot]', { user: { login: 'dependabot[bot]', type: 'Bot' } })];
  github.authored = [searchItem(1, 'teammate'), searchItem(4, 'other', { draft: true })];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.deepEqual(spawned.map((args) => args.candidate.key), [`${REPO}#1`]);
  assert.deepEqual(github.authoredQueries, [['teammate', 'other']], 'the operator is not searched as a teammate');
  assert.equal(spawned[0].tier, 'stamp');
  const latest = statuses.at(-1);
  assert.equal(latest?.type, 'team-review-status');
  assert.deepEqual(latest?.drafts.map((draft) => [draft.key, draft.status]), [[`${REPO}#1`, 'ready']]);
  assert.deepEqual(latest?.inFlight, []);
  for (const status of statuses) assert.equal(TeamReviewStatus.safeParse(status).success, true);
  await poller.stop();
});

test('start runs the leftover sweep before it reads state or ticks', async () => {
  const order: string[] = [];
  const { poller } = setup({
    beforeStart: async () => { order.push('sweep'); },
    readState: async () => { order.push('read'); return {}; },
  });
  await poller.start();
  await settle();
  assert.deepEqual(order, ['sweep', 'read']);
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

test('a moved head marks the ready draft stale and queues a fresh review', async () => {
  const release: { resolve?: () => void } = {};
  const gate = new Promise<void>((resolve) => { release.resolve = resolve; });
  let spawnCount = 0;
  const { poller, github, statuses } = setup({
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
  github.heads.set(1, HEAD_TWO);
  await poller.tick();
  await settle();
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'stale', 'the old draft is stale while the new review runs');
  assert.deepEqual(statuses.at(-1)?.inFlight, [`${REPO}#1`]);
  release.resolve?.();
  await settle();
  assert.equal(spawnCount, 2);
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'ready');
  assert.equal(poller.getDraft(`${REPO}#1`)?.reviewedHead, HEAD_TWO);
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

test('a skip-tier PR is recorded with its reason and never spawned', async () => {
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(5, 'teammate')];
  github.heads.set(5, HEAD_ONE);
  github.viewPr = async (_repo, number) => prDetail(number, HEAD_ONE, { isCrossRepository: true });
  await poller.start();
  await settle();
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 0);
  assert.deepEqual(poller._state()[`${REPO}#5`], { draft: null, reviewedHead: HEAD_ONE, inFlight: false, skipReason: 'fork', reviewAttempts: 0, updatedAt: 1000 });
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
    spawnReview: async (args) => { spawned.push(args); return isShuttingDown ? null : draftFor(args); },
  });
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.equal(poller.getDraft(`${REPO}#1`), null);
  assert.equal(poller._state()[`${REPO}#1`]?.inFlight, false);
  assert.equal(poller._state()[`${REPO}#1`]?.reviewAttempts, 0);
  isShuttingDown = false;
  await poller.tick();
  await settle();
  assert.equal(spawned.length, 2);
  assert.equal(poller.getDraft(`${REPO}#1`)?.status, 'ready');
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

test('a moved head resets the attempt count and reviews the new head', async () => {
  const { poller, github, spawned } = setup({
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
