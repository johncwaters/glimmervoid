import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_WORKFLOW_MAX_CONCURRENT_SESSIONS, MAX_DEFERRED_WORKFLOW_SPAWNS } from '../server/core/workflows-core.ts';
import { createWorkflowSessionQueue, createWorkflowsPoller } from '../server/workflows-poller.ts';
import type { SpawnPlannedAction, SpawnSession } from '../server/workflows-poller.ts';
import { createWorkflowsStateIo } from '../server/workflows-wiring.ts';
import { WorkflowRule } from '../shared/contracts/workflows.ts';
import type { WorkflowSearchNode, WorkflowsState } from '../shared/contracts/workflows.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const CREATED_AFTER_NOW = '2026-10-04T12:01:00Z';

function searchNode(number: number, overrides: Partial<WorkflowSearchNode> = {}): WorkflowSearchNode {
  return {
    __typename: 'PullRequest', id: `PR_${number}`, number, title: `PR ${number}`, url: `https://github.com/Acme/app/pull/${number}`, isDraft: false, state: 'OPEN',
    createdAt: CREATED_AFTER_NOW, mergedAt: null, updatedAt: '', baseRefName: 'main', baseRefOid: 'c'.repeat(40), headRefName: `branch-${number}`, isCrossRepository: false, headRefOid: 'a'.repeat(40),
    isInMergeQueue: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    repository: { nameWithOwner: 'Acme/app', viewerDefaultMergeMethod: 'SQUASH' },
    commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
    author: { login: 'alice' }, labels: { nodes: [] }, comments: { totalCount: 0 },
    ...overrides,
  };
}

const ALL_ACTIONS = [
  { type: 'notify' },
  { type: 'label', name: 'triage' },
  { type: 'comment', body: 'Thanks for opening this' },
  { type: 'spawn', promptTemplate: 'Look at {{url}}' },
];

function harness({ savedState = null, actions = ALL_ACTIONS, filters = {}, trigger = 'opened', isCommentPosted = false, spawnSession }: {
  savedState?: WorkflowsState | null; actions?: unknown[]; filters?: Record<string, unknown>; trigger?: string; isCommentPosted?: boolean; spawnSession?: SpawnSession;
} = {}) {
  let items: WorkflowSearchNode[] = [searchNode(1)];
  let isSearchFailing = false;
  let saved = savedState;
  const steps: string[] = [];
  const warnings: string[] = [];
  const searchedRepos: string[] = [];
  let viewerLookups = 0;
  const github = {
    async viewer() {
      viewerLookups += 1;
      return 'alice';
    },
    async searchRepoPrs(repo: string, mergedSince: string) {
      searchedRepos.push(`${repo} ${mergedSince}`);
      if (isSearchFailing) return { ok: false, items: [], isComplete: false, error: 'offline' };
      return { ok: true, items, isComplete: true, error: '' };
    },
    async addPrLabel(label: { repo: string; number: number; name: string }) {
      steps.push(`label ${label.repo}#${label.number} ${label.name}`);
      return { ok: true, err: '' };
    },
    async commentOnPr(comment: { repo: string; number: number; body: string }) {
      steps.push(`comment ${comment.repo}#${comment.number} ${comment.body}`);
      return isCommentPosted ? { ok: true, err: '' } : { ok: false, err: 'HTTP 403' };
    },
    async rateLimitWaitMs() { return null; },
  };
  const rules = [WorkflowRule.parse({ id: 'greet', name: 'Greet', enabled: true, repos: ['acme/app'], trigger, filters, actions })];
  const log = { warn: (message: string) => { warnings.push(message); } };
  const sessions = createWorkflowSessionQueue({ spawnSession: spawnSession ?? (async ({ event }) => { steps.push(`spawn ${event.pr.repo}#${event.pr.number}`); }), log });
  const poller = createWorkflowsPoller({
    rules, teamName: null, github, now: () => NOW,
    readState: async () => saved,
    writeState: async (state) => {
      steps.push('save');
      saved = state;
    },
    notify: ({ sessionName, message }) => { steps.push(`notify ${sessionName} ${message}`); },
    startSession: sessions.enqueue,
    onTickComplete: () => {},
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
    log,
  });
  return {
    poller, sessions, steps, warnings, searchedRepos, savedState: () => saved, viewerLookups: () => viewerLookups,
    setItems: (nextItems: WorkflowSearchNode[]) => { items = nextItems; },
    failSearch: () => { isSearchFailing = true; },
  };
}

test('the first poll of a repo seeds the snapshot and fires nothing', async () => {
  const lane = harness();
  await lane.poller.tick();
  assert.deepEqual(lane.steps, ['save']);
  assert.deepEqual(lane.savedState()?.repos['acme/app']?.prs.map((pr) => pr.number), [1]);
  assert.deepEqual(lane.searchedRepos, ['acme/app 2026-10-03']);
  assert.equal(lane.savedState()?.repos['acme/app']?.polledAtMs, NOW);
  await lane.poller.stop();
});

test('a new pull request runs every action once, then the snapshot is saved, and the next poll fires nothing again', async () => {
  const lane = harness();
  await lane.poller.tick();
  lane.setItems([searchNode(1), searchNode(2)]);
  await lane.poller.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(lane.steps, [
    'save',
    'notify workflows:greet:Acme/app#2 Greet: opened Acme/app#2 PR 2',
    'label Acme/app#2 triage',
    'comment Acme/app#2 Thanks for opening this',
    'spawn Acme/app#2',
    'save',
  ]);
  assert.ok(lane.warnings.some((warning) => warning.includes('could not comment Acme/app#2: HTTP 403')));
  await lane.poller.tick();
  assert.equal(lane.steps.filter((step) => step !== 'save').length, 4);
  await lane.poller.stop();
});

test('a saved snapshot survives a restart, so a pull request already seen does not fire again', async () => {
  const first = harness();
  await first.poller.tick();
  await first.poller.stop();
  const restarted = harness({ savedState: first.savedState() });
  restarted.setItems([searchNode(1)]);
  await restarted.poller.tick();
  assert.deepEqual(restarted.steps, ['save']);
  restarted.setItems([searchNode(1), searchNode(3)]);
  await restarted.poller.tick();
  assert.ok(restarted.steps.includes('notify workflows:greet:Acme/app#3 Greet: opened Acme/app#3 PR 3'));
  await restarted.poller.stop();
});

test('a failed search keeps the previous snapshot and backs off without firing', async () => {
  const lane = harness();
  await lane.poller.tick();
  lane.failSearch();
  await lane.poller.tick();
  assert.deepEqual(lane.steps, ['save', 'save']);
  assert.deepEqual(lane.savedState()?.repos['acme/app']?.prs.map((pr) => pr.number), [1]);
  assert.ok(lane.warnings.some((warning) => warning.includes('poll failed')));
  await lane.poller.stop();
});

test('the viewer is looked up once and only when a rule filters on your own pull requests', async () => {
  const anyAuthor = harness();
  await anyAuthor.poller.tick();
  assert.equal(anyAuthor.viewerLookups(), 0);
  await anyAuthor.poller.stop();
  const mine = harness({ filters: { mine: true }, actions: [{ type: 'notify' }] });
  await mine.poller.tick();
  mine.setItems([searchNode(1), searchNode(2, { author: { login: 'bob' } }), searchNode(3)]);
  await mine.poller.tick();
  assert.equal(mine.viewerLookups(), 1);
  assert.deepEqual(mine.steps.filter((step) => step.startsWith('notify')), ['notify workflows:greet:Acme/app#3 Greet: opened Acme/app#3 PR 3']);
  await mine.poller.stop();
});

test('workflow state round-trips through its json store and a corrupt file reads as empty', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflows-state-'));
  try {
    const statePath = path.join(directory, 'workflows-state.json');
    const lane = harness();
    await lane.poller.tick();
    const saved = lane.savedState();
    assert.ok(saved);
    await createWorkflowsStateIo(statePath, { warn: () => {} }).writeState(saved);
    assert.deepEqual(await createWorkflowsStateIo(statePath, { warn: () => {} }).readState(), saved);
    await fs.writeFile(statePath, '{"repos":{"Acme/App":{"polledAtMs":0,"prs":[]}}}');
    const warnings: string[] = [];
    assert.equal(await createWorkflowsStateIo(statePath, { warn: (message) => { warnings.push(message); } }).readState(), null);
    assert.ok(warnings.some((warning) => warning.includes('quarantined')));
    await lane.poller.stop();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function controlledSpawns() {
  const started: string[] = [];
  const finishers = new Map<string, () => void>();
  const signals: AbortSignal[] = [];
  const spawnSession: SpawnSession = ({ event }, signal) => new Promise<void>((resolve) => {
    const key = `${event.pr.repo}#${event.pr.number}`;
    started.push(key);
    signals.push(signal);
    finishers.set(key, resolve);
  });
  return { spawnSession, started, signals, finish: (key: string) => finishers.get(key)?.() };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('spawns past the concurrent session cap wait in order and start as running sessions finish, each exactly once', async () => {
  assert.equal(DEFAULT_WORKFLOW_MAX_CONCURRENT_SESSIONS, 2);
  const spawns = controlledSpawns();
  const lane = harness({ actions: [{ type: 'spawn', promptTemplate: 'Look at {{url}}' }], spawnSession: spawns.spawnSession });
  await lane.poller.tick();
  lane.setItems([searchNode(1), searchNode(2), searchNode(3), searchNode(4)]);
  await lane.poller.tick();
  assert.deepEqual(spawns.started, ['Acme/app#2', 'Acme/app#3']);
  assert.ok(lane.warnings.some((warning) => warning.includes('Acme/app#4 waits for one of 2 running workflow sessions')));
  lane.setItems([searchNode(1), searchNode(2), searchNode(3), searchNode(4), searchNode(5)]);
  await lane.poller.tick();
  assert.deepEqual(spawns.started, ['Acme/app#2', 'Acme/app#3']);
  spawns.finish('Acme/app#2');
  await settle();
  assert.deepEqual(spawns.started, ['Acme/app#2', 'Acme/app#3', 'Acme/app#4']);
  spawns.finish('Acme/app#3');
  spawns.finish('Acme/app#4');
  await settle();
  await settle();
  assert.deepEqual(spawns.started, ['Acme/app#2', 'Acme/app#3', 'Acme/app#4', 'Acme/app#5']);
  await lane.poller.tick();
  spawns.finish('Acme/app#5');
  await settle();
  assert.deepEqual(spawns.started, ['Acme/app#2', 'Acme/app#3', 'Acme/app#4', 'Acme/app#5']);
  await lane.poller.stop();
});

test('stopping the poller leaves workflow sessions running, and stopping the session queue aborts them and never starts a waiting one', async () => {
  const spawns = controlledSpawns();
  const lane = harness({ actions: [{ type: 'spawn', promptTemplate: 'Look at {{url}}' }], spawnSession: spawns.spawnSession });
  await lane.poller.tick();
  lane.setItems([searchNode(1), searchNode(2), searchNode(3), searchNode(4)]);
  await lane.poller.tick();
  await lane.poller.stop();
  assert.ok(spawns.signals.every((signal) => !signal.aborted));
  const stopped = lane.sessions.stop();
  assert.ok(spawns.signals.every((signal) => signal.aborted));
  spawns.finish('Acme/app#2');
  spawns.finish('Acme/app#3');
  await stopped;
  assert.deepEqual(spawns.started, ['Acme/app#2', 'Acme/app#3']);
});

function plannedSpawn(ruleId: string, number: number, title = `PR ${number}`): SpawnPlannedAction {
  return {
    rule: { id: ruleId, name: ruleId }, action: { type: 'spawn', promptTemplate: 'Look at {{url}}' },
    event: { trigger: 'opened', addedReviewRequests: [], pr: {
      repo: 'Acme/app', number, title, url: `https://github.com/Acme/app/pull/${number}`, author: 'alice', state: 'OPEN', createdAt: CREATED_AFTER_NOW, mergedAt: null,
      isDraft: false, isCrossRepository: false, baseRefName: 'main', headRefName: `branch-${number}`, headRefOid: 'a'.repeat(40), labels: [], commentCount: 0,
      reviewRequests: [], checksState: null, reviewDecision: null,
    } },
  };
}

test('a newer event for the same rule and pull request replaces the queued spawn, and the queue drops spawns past its cap', async () => {
  const titlesStarted: string[] = [];
  const finishers: (() => void)[] = [];
  const warnings: string[] = [];
  const sessions = createWorkflowSessionQueue({
    spawnSession: ({ event }) => new Promise<void>((resolve) => {
      titlesStarted.push(`${event.pr.number} ${event.pr.title}`);
      finishers.push(resolve);
    }),
    log: { warn: (message) => { warnings.push(message); } },
  });
  sessions.enqueue(plannedSpawn('a', 1));
  sessions.enqueue(plannedSpawn('a', 2));
  sessions.enqueue(plannedSpawn('a', 3, 'first'));
  sessions.enqueue(plannedSpawn('a', 3, 'second'));
  for (let number = 4; number < 3 + MAX_DEFERRED_WORKFLOW_SPAWNS; number += 1) sessions.enqueue(plannedSpawn('a', number));
  sessions.enqueue(plannedSpawn('a', 3 + MAX_DEFERRED_WORKFLOW_SPAWNS));
  sessions.enqueue(plannedSpawn('a', 4, 'replaced at the cap'));
  assert.ok(warnings.some((warning) => warning.includes(`Acme/app#${3 + MAX_DEFERRED_WORKFLOW_SPAWNS} was dropped because ${MAX_DEFERRED_WORKFLOW_SPAWNS} workflow sessions already wait`)));
  finishers.shift()?.();
  await settle();
  finishers.shift()?.();
  await settle();
  assert.deepEqual(titlesStarted, ['1 PR 1', '2 PR 2', '3 second', '4 replaced at the cap']);
  const stopped = sessions.stop();
  for (const finish of finishers) finish();
  await stopped;
});

test('the session queue reads its concurrent session limit from config each time a slot frees', async () => {
  let sessionLimit = 1;
  const titlesStarted: string[] = [];
  const finishers: (() => void)[] = [];
  const sessions = createWorkflowSessionQueue({
    spawnSession: ({ event }) => new Promise<void>((resolve) => {
      titlesStarted.push(String(event.pr.number));
      finishers.push(resolve);
    }),
    log: { warn: () => {} },
    maxConcurrentSessions: () => sessionLimit,
  });
  for (const number of [1, 2, 3, 4]) sessions.enqueue(plannedSpawn('a', number));
  assert.deepEqual(titlesStarted, ['1']);
  sessionLimit = 3;
  finishers.shift()?.();
  await settle();
  assert.deepEqual(titlesStarted, ['1', '2', '3', '4']);
  const stopped = sessions.stop();
  for (const finish of finishers) finish();
  await stopped;
});

test('a commented rule that posts a comment does not re-trigger itself on the next poll', async () => {
  const lane = harness({ trigger: 'commented', isCommentPosted: true, actions: [{ type: 'comment', body: 'Seen' }] });
  await lane.poller.tick();
  lane.setItems([searchNode(1, { comments: { totalCount: 1 } })]);
  await lane.poller.tick();
  assert.deepEqual(lane.steps, ['save', 'comment Acme/app#1 Seen', 'save']);
  lane.setItems([searchNode(1, { comments: { totalCount: 2 } })]);
  await lane.poller.tick();
  await lane.poller.tick();
  assert.deepEqual(lane.steps, ['save', 'comment Acme/app#1 Seen', 'save', 'save', 'save']);
  await lane.poller.stop();
});
