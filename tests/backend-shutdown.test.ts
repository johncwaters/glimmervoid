import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackendShutdown } from '../server/backend-shutdown.ts';
import type { BackendShutdownDependencies } from '../server/backend-shutdown.ts';

function shutdownDependencies(stoppedLanes: string[], overrides: Partial<BackendShutdownDependencies> = {}): BackendShutdownDependencies {
  const idle = { stop: () => {} };
  const lane = (name: string) => ({ stopPoller: () => { stoppedLanes.push(name); } });
  return {
    cancelAutoResume: () => {},
    healthInterval: setInterval(() => {}, 60000),
    getStopConfigWatch: () => null,
    remoteAuth: null,
    stopUpdateCheck: () => {},
    notificationManager: { destroy: () => {} },
    telegramChannel: { destroy: () => {} },
    sessions: new Map(), agentSessions: new Map(), reviewSessions: new Map(), investigationSessions: new Map(), visionsSessions: new Map(), changeMapSessions: new Map(),
    branchGc: idle,
    coderActivity: idle,
    posthog: lane('posthog'),
    teamReview: lane('team-review'),
    myPrs: lane('my-prs'),
    workflows: lane('workflows'),
    usage: idle,
    getIngestLane: () => null,
    getVisionsLane: () => null,
    telegramOutbox: { idle: () => {} },
    heartbeat: idle,
    controlWss: { close: () => {} },
    dataWss: { close: () => {} },
    ...overrides,
  };
}

test('shutdown stops the workflows lane alongside the my PRs and team review lanes and awaits it as a named stopper', async () => {
  const stoppedLanes: string[] = [];
  const outcome = createBackendShutdown(shutdownDependencies(stoppedLanes))();
  await Promise.all(outcome.stoppers.map((entry) => entry.promise));
  assert.deepEqual(stoppedLanes, ['posthog', 'team-review', 'my-prs', 'workflows']);
  assert.ok(outcome.stoppers.some((entry) => entry.name === 'workflows'));
});

test('shutdown without a workflows lane registers no workflows stopper', () => {
  const outcome = createBackendShutdown(shutdownDependencies([], { workflows: null }))();
  assert.equal(outcome.stoppers.some((entry) => entry.name === 'workflows'), false);
});

test('shutdown aborts and awaits title refinement and destroys its ephemeral sessions', async () => {
  let hasStopped = false;
  let hasDestroyed = false;
  const outcome = createBackendShutdown(shutdownDependencies([], {
    taskTitleRefiner: { stop: async () => { await Promise.resolve(); hasStopped = true; } },
    taskTitleSessions: new Map([['title-lane', { destroy: () => { hasDestroyed = true; } }]]),
  }))();
  await Promise.all(outcome.stoppers.map((entry) => entry.promise));
  assert.equal(hasStopped, true);
  assert.equal(hasDestroyed, true);
  assert.ok(outcome.stoppers.some((entry) => entry.name === 'task-title'));
});

test('shutdown stops and awaits coder activity as a named stopper', async () => {
  let hasStopped = false;
  const outcome = createBackendShutdown(shutdownDependencies([], {
    coderActivity: { stop: async () => { await Promise.resolve(); hasStopped = true; } },
  }))();
  await Promise.all(outcome.stoppers.map((entry) => entry.promise));
  assert.equal(hasStopped, true);
  assert.ok(outcome.stoppers.some((entry) => entry.name === 'coder-activity'));
});

test('shutdown awaits config persistence queued by session teardown', async () => {
  let hasDrained = false;
  let hasDestroyed = false;
  const outcome = createBackendShutdown(shutdownDependencies([], {
    sessions: new Map([['session', { destroy: () => { hasDestroyed = true; } }]]),
    configStore: { idle: async () => { assert.equal(hasDestroyed, true); await Promise.resolve(); hasDrained = true; } },
  }))();
  await Promise.all(outcome.stoppers.map((entry) => entry.promise));
  assert.equal(hasDrained, true);
  assert.ok(outcome.stoppers.some((entry) => entry.name === 'config-store'));
});
