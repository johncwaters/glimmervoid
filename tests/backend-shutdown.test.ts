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
