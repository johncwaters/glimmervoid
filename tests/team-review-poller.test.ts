import test from 'node:test';
import assert from 'node:assert/strict';

import { createTeamReviewPoller } from '../server/team-review-poller.ts';
import type { PrGitWorkspace, TeamReviewCandidate, TeamReviewPollerDependencies } from '../server/team-review-poller.ts';

const project = { id: 'p1', path: '/repo', slug: 'team/repo', name: 'Repo' };
const candidate: TeamReviewCandidate = {
  number: 7, headRefOid: 'sha1', headRefName: 'feature', mergeable: 'MERGEABLE',
  title: 'Fix thing', author: { login: 'teammate' },
};

function workspace(overrides: Partial<PrGitWorkspace> = {}): PrGitWorkspace {
  return {
    listWorktreeBranches: async () => [],
    create: async () => ({ cwd: '/worktree', isGit: true }),
    discard: async () => {},
    removeWorktreeByPath: async () => {},
    ...overrides,
  };
}

function setup(overrides: Partial<TeamReviewPollerDependencies> = {}) {
  const states: Record<string, unknown>[] = [];
  const statuses: Record<string, unknown>[] = [];
  let currentCandidates = [candidate];
  const dependencies: TeamReviewPollerDependencies = {
    projects: [project],
    listCandidates: async () => currentCandidates,
    gitWorkspace: workspace(),
    spawnReview: async () => ({ verdict: 'CLEAN', summary: 'clean' }),
    writeState: async (state) => { states.push(structuredClone(state)); },
    onTickComplete: (status) => { statuses.push(status); },
    now: () => 1000,
    setIntervalFn: () => ({}) as NodeJS.Timeout,
    clearIntervalFn: () => {},
    ...overrides,
  };
  const poller = createTeamReviewPoller(dependencies);
  return { poller, states, statuses, setCandidates: (candidates: TeamReviewCandidate[]) => { currentCandidates = candidates; } };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('an injected candidate is reviewed once for each head', async () => {
  let spawnCount = 0;
  const { poller, statuses } = setup({
    spawnReview: async () => { spawnCount += 1; return { verdict: 'CLEAN' }; },
  });
  await poller.start();
  await poller.tick();
  await settle();
  assert.equal(spawnCount, 1);
  assert.equal(poller._state()['team/repo#7']?.phase, 'clean');
  await poller.tick();
  await settle();
  assert.equal(spawnCount, 1);
  assert.equal(statuses.at(-1)?.type, 'team-review-status');
  await poller.stop();
});

test('a changed head starts another review', async () => {
  let spawnCount = 0;
  const { poller, setCandidates } = setup({
    spawnReview: async () => { spawnCount += 1; return { verdict: 'CHANGES' }; },
  });
  await poller.start();
  await poller.tick();
  await settle();
  setCandidates([{ ...candidate, headRefOid: 'sha2' }]);
  await poller.tick();
  await settle();
  assert.equal(spawnCount, 2);
  assert.equal(poller._state()['team/repo#7']?.reviewedHead, 'sha2');
  assert.equal(poller._state()['team/repo#7']?.phase, 'changes-requested');
  await poller.stop();
});

test('a conflicting candidate gets a disposable worktree', async () => {
  const discarded: string[] = [];
  const { poller } = setup({
    listCandidates: async () => [{ ...candidate, mergeable: 'CONFLICTING' }],
    gitWorkspace: workspace({ discard: async ({ workspace: created }) => { discarded.push(created.cwd); } }),
  });
  await poller.start();
  await poller.tick();
  await settle();
  assert.deepEqual(discarded, ['/worktree']);
  assert.equal(poller._state()['team/repo#7']?.wasConflicting, true);
  await poller.stop();
});

test('the concurrency cap keeps a second candidate queued', async () => {
  const deferred: { resolve?: (value: { verdict: string }) => void } = {};
  const pending = new Promise<{ verdict: string }>((resolve) => { deferred.resolve = resolve; });
  let spawnCount = 0;
  const { poller } = setup({
    listCandidates: async () => [candidate, { ...candidate, number: 8 }],
    maxConcurrentReviews: 1,
    spawnReview: async () => { spawnCount += 1; return pending; },
  });
  await poller.start();
  await poller.tick();
  assert.equal(spawnCount, 1);
  assert.equal(poller._state()['team/repo#8'], undefined);
  deferred.resolve?.({ verdict: 'CLEAN' });
  await settle();
  await poller.stop();
});

test('an empty project list reports an empty status', async () => {
  const { poller, statuses } = setup({ projects: [] });
  await poller.start();
  await poller.tick();
  assert.deepEqual(statuses.at(-1), { type: 'team-review-status', ts: 1000, projects: [] });
  await poller.stop();
});
