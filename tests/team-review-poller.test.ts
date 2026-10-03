import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_RE_REVIEW_AFTER_HOURS, DEFAULT_SKIP_IDLE_AFTER_DAYS, MAX_REVIEW_ATTEMPTS, POSTED_RETENTION_MS, errorDraft, readyDraft } from '../server/core/team-review-core.ts';
import { createTeamReviewPoller } from '../server/team-review-poller.ts';
import type { PrReviewSnapshot } from '../server/pr-gh.ts';
import type { SpawnReviewArgs, TeamReviewGithub, TeamReviewPollerDependencies } from '../server/team-review-poller.ts';
import { PrDetail, SearchedPr, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import type { ReviewDraft, TeamReviewState, TeamReviewStatus as TeamReviewStatusType } from '../shared/contracts/team-review.ts';

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

interface FakeGithub extends TeamReviewGithub {
  requested: SearchedPr[];
  authored: SearchedPr[];
  isRequestedComplete: boolean;
  isAuthoredComplete: boolean;
  heads: Map<number, string>;
  reviews: Map<number, PrReviewSnapshot['reviews']>;
  decisions: Map<number, NonNullable<PrReviewSnapshot['reviewDecision']>>;
  snapshotBatches: number[][];
  authoredQueries: string[][];
  failViewer: boolean;
  rateLimitWait: number | null;
}

function fakeGithub(): FakeGithub {
  const github: FakeGithub = {
    requested: [],
    authored: [],
    isRequestedComplete: true,
    isAuthoredComplete: true,
    heads: new Map(),
    reviews: new Map(),
    decisions: new Map(),
    snapshotBatches: [],
    authoredQueries: [],
    failViewer: false,
    rateLimitWait: null,
    rateLimitWaitMs: async () => github.rateLimitWait,
    viewer: async () => (github.failViewer ? null : 'me'),
    teamProfile: async () => ({ org: 'Acme', slug: 'core', name: 'Core', avatarUrl: 'https://avatars.githubusercontent.com/t/1' }),
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
    prReviewSnapshots: async (prs) => {
      github.snapshotBatches.push(prs.map((pr) => pr.number));
      return new Map(prs.flatMap((pr) => {
        const head = github.heads.get(pr.number);
        return head ? [[`${pr.repo}#${pr.number}`, { head, reviewDecision: github.decisions.get(pr.number) ?? null, reviews: github.reviews.get(pr.number) ?? [] }] as const] : [];
      }));
    },
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
  assert.deepEqual(latest?.team, { org: 'Acme', slug: 'core', name: 'Core', avatarUrl: 'https://avatars.githubusercontent.com/t/1' });
  assert.deepEqual(latest?.drafts.map((draft) => [draft.key, draft.status]), [[`${REPO}#1`, 'ready']]);
  assert.deepEqual(latest?.inFlight, []);
  for (const status of statuses) assert.equal(TeamReviewStatus.safeParse(status).success, true);
  await poller.stop();
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
  assert.deepEqual(draft?.githubReviews, [{ login: 'me', state: 'APPROVED', commit: HEAD_ONE, isViewer: true }]);
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

test('saved drafts are published at start before the first GitHub search finishes', async () => {
  const key = `${REPO}#1`;
  const candidate = { key, repo: REPO, number: 1, title: 'PR 1', url: `https://github.com/${REPO}/pull/1`, author: 'teammate' };
  const draft = errorDraft({ candidate, tier: 'stamp', reasons: [], reviewedHead: HEAD_ONE, error: 'timed out' });
  const savedState: TeamReviewState = {
    [key]: { draft, reviewedHead: HEAD_ONE, inFlight: false, skipReason: null, reviewAttempts: MAX_REVIEW_ATTEMPTS, updatedAt: 1 },
  };
  const { poller, github, statuses } = setup({
    readState: async () => structuredClone(savedState),
    beforeStart: () => new Promise(() => {}),
  });
  github.searchTeamRequested = () => new Promise(() => {});
  void poller.start();
  await settle();
  assert.deepEqual(statuses[0]?.drafts.map((published) => published.key), [key], 'the saved draft is published even while beforeStart is still sweeping');
});

test('requeue resets a failed review at its attempt limit and the next tick reviews it again', async () => {
  const key = `${REPO}#1`;
  const candidate = { key, repo: REPO, number: 1, title: 'PR 1', url: `https://github.com/${REPO}/pull/1`, author: 'teammate' };
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
  const candidate = { key, repo: REPO, number: 1, title: 'PR 1', url: `https://github.com/${REPO}/pull/1`, author: 'teammate' };
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
  assert.deepEqual(poller._state()[`${REPO}#5`], { draft: null, reviewedHead: HEAD_ONE, inFlight: false, skipReason: 'fork', reviewAttempts: 0, liveHead: HEAD_ONE, updatedAt: 1000 });
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
    candidate: { key, repo: REPO, number: 1, title: 'PR 1', url: `https://github.com/${REPO}/pull/1`, author: 'teammate' },
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
  assert.deepEqual(entry?.draft, previousDraft);
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
    candidate: { key, repo: REPO, number: 1, title: 'PR 1', url: `https://github.com/${REPO}/pull/1`, author: 'teammate' },
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
  const { poller, github, spawned } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  assert.ok(await poller.updateDraft(key, { reviewedHead: HEAD_ONE, status: 'ready' }, { status: 'discarded' }));
  github.heads.set(1, HEAD_TWO);
  assert.equal(await poller.requeue(key, HEAD_ONE), true);
  assert.equal(poller._state()[key]?.discardedReviewHead, HEAD_ONE);
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
  const { poller, github, statuses } = setup();
  github.requested = [searchItem(1, 'teammate')];
  github.heads.set(1, HEAD_ONE);
  await poller.start();
  await settle();
  const lastGoodDrafts = statuses.at(-1)?.drafts;
  assert.equal(lastGoodDrafts?.length, 1);
  const successfulSearch = github.searchTeamRequested;
  github.searchTeamRequested = async () => { throw new Error('offline'); };
  await poller.tick();
  assert.equal(statuses.at(-1)?.error, 'offline');
  assert.equal(statuses.at(-1)?.nextAttemptAt, 11_000);
  assert.deepEqual(statuses.at(-1)?.retry, { attempt: 1, limit: 3 });
  assert.deepEqual(statuses.at(-1)?.drafts, lastGoodDrafts);
  github.searchTeamRequested = successfulSearch;
  assert.equal((await poller.refresh()).ok, true);
  assert.equal(statuses.at(-1)?.error, null);
  assert.equal(statuses.at(-1)?.nextAttemptAt, null);
  assert.equal(statuses.at(-1)?.retry, null);
  await poller.stop();
});

test('a GitHub secondary rate limit on the candidate search waits a minute with no quick retries and refuses refresh', async () => {
  const { poller, github, statuses } = setup();
  let searchCount = 0;
  github.searchTeamRequested = async () => {
    searchCount += 1;
    throw new Error('gh: You have triggered an abuse detection mechanism. Please wait a few minutes before you try again. (HTTP 403)');
  };
  await poller.tick();
  assert.equal(statuses.at(-1)?.retry, null);
  assert.equal(statuses.at(-1)?.nextAttemptAt, 61_000);
  assert.equal((await poller.refresh()).ok, false);
  assert.equal(searchCount, 1);
  await poller.stop();
});
