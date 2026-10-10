import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WORKFLOW_BOOTSTRAP_PROMPT, WORKFLOW_PROMPT_FILENAME } from '../server/core/workflows-core.ts';
import type { PlannedWorkflowAction } from '../server/core/workflows-core.ts';
import { createWorkflowSpawn, createWorkflowsWiring } from '../server/workflows-wiring.ts';
import type { WorkflowsPollerDependencies } from '../server/workflows-poller.ts';
import type { WorkflowPr } from '../shared/contracts/workflows.ts';

const OPENED_PR: WorkflowPr = {
  repo: 'Acme/app', number: 7, title: 'Fix', url: 'https://github.com/Acme/app/pull/7', author: 'alice', state: 'OPEN',
  createdAt: '2026-10-04T12:00:00Z', mergedAt: null, isDraft: false, isCrossRepository: false, baseRefName: 'main', headRefName: 'fix', headRefOid: 'a'.repeat(40), labels: [], commentCount: 0, reviewRequests: [], checksState: null, reviewDecision: null,
};

function spawnAction(): PlannedWorkflowAction & { action: { type: 'spawn'; promptTemplate: string } } {
  return { rule: { id: 'triage', name: 'Triage' }, action: { type: 'spawn', promptTemplate: 'Triage {{url}}' }, event: { trigger: 'opened', pr: OPENED_PR, addedReviewRequests: [] } };
}

test('a spawn action stages the pull request, writes the filled prompt, runs one sandboxed session and cleans up', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflows-spawn-'));
  const calls: string[] = [];
  let promptText = '';
  let cleanedUp = false;
  try {
    const spawn = createWorkflowSpawn({
      workRoot: root,
      log: { warn: (message) => { calls.push(`warn ${message}`); } },
      makeWorkDir: async () => {
        const dir = await fs.mkdtemp(path.join(root, 'work-'));
        return { dir, cleanup: async () => { cleanedUp = true; } };
      },
      staging: {
        stageCheckout: async (pr) => {
          calls.push(`stage ${pr.key} ${pr.baseRefName} ${pr.headRefOid}`);
          return { projectPath: '/cache/acme-app', baseSha: 'b'.repeat(40) };
        },
        runSession: async ({ idPrefix, name, workDir, cachedClone, initialPrompt }) => {
          promptText = await fs.readFile(path.join(workDir, WORKFLOW_PROMPT_FILENAME), 'utf8');
          calls.push(`run ${idPrefix} ${name} ${cachedClone} ${initialPrompt}`);
          return 'finished';
        },
      },
    });
    await spawn(spawnAction(), new AbortController().signal);
    assert.deepEqual(calls, [
      `stage Acme/app#7 main ${'a'.repeat(40)}`,
      `run workflows Workflow Triage Acme/app#7 /cache/acme-app ${WORKFLOW_BOOTSTRAP_PROMPT}`,
    ]);
    assert.match(promptText, /^Triage https:\/\/github\.com\/Acme\/app\/pull\/7\n/);
    assert.equal(cleanedUp, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a spawn action whose checkout cannot be staged never starts a session', async () => {
  const warnings: string[] = [];
  let sessions = 0;
  let cleanedUp = false;
  const spawn = createWorkflowSpawn({
    workRoot: '/unused',
    log: { warn: (message) => { warnings.push(message); } },
    makeWorkDir: async () => ({ dir: '/unused/work', cleanup: async () => { cleanedUp = true; } }),
    staging: {
      stageCheckout: async () => ({ error: 'could not clone Acme/app' }),
      runSession: async () => {
        sessions += 1;
        return 'finished';
      },
    },
  });
  await spawn(spawnAction(), new AbortController().signal);
  assert.equal(sessions, 0);
  assert.equal(cleanedUp, true);
  assert.deepEqual(warnings, ['[workflows] triage session for Acme/app#7: not started: could not clone Acme/app']);
});

test('the lane starts only with an enabled rule and passes only enabled rules and the team to the poller', async () => {
  const created: WorkflowsPollerDependencies[] = [];
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflows-wiring-'));
  try {
    const config: { workflows?: unknown; teamReview?: Record<string, unknown> | null } = {
      teamReview: { org: 'Acme', team: 'core' },
      workflows: { rules: [{ id: 'off', name: 'Off', repos: ['Acme/app'], trigger: 'opened', actions: [{ type: 'notify' }] }] },
    };
    const triggered: string[] = [];
    const wiring = createWorkflowsWiring({
      config, homeDir, log: { warn: () => {} },
      notificationManager: { trigger: (sessionName, category, message) => { triggered.push(`${sessionName} ${category} ${message}`); } },
      spawnSession: async () => {},
      createPoller: (dependencies) => {
        created.push(dependencies);
        return { start: async () => {}, stop: async () => {}, tick: async () => {} };
      },
    });
    wiring.startPoller();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(created.length, 0);
    config.workflows = { rules: [
      { id: 'off', name: 'Off', repos: ['Acme/app'], trigger: 'opened', actions: [{ type: 'notify' }] },
      { id: 'on', name: 'On', enabled: true, repos: ['Acme/app'], trigger: 'merged', actions: [{ type: 'notify' }] },
    ] };
    wiring.restartIfConfigChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(created.length, 1);
    assert.deepEqual(created[0]?.rules.map((rule) => rule.id), ['on']);
    assert.equal(created[0]?.teamName, 'Acme/core');
    created[0]?.notify({ sessionName: 'workflows:on:Acme/app#1', message: 'On: merged Acme/app#1 Fix' });
    assert.deepEqual(triggered, ['workflows:on:Acme/app#1 workflow On: merged Acme/app#1 Fix']);
    config.workflows = { rules: [{ id: 'on', name: 'On', enabled: true, repos: ['Acme/app'], trigger: 'pushed', actions: [{ type: 'notify' }] }] };
    wiring.restartIfConfigChanged();
    await wiring.stopPoller();
    assert.equal(created.length, 1);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('workflows.enabled false keeps the lane from polling, and the per-poll action limit reaches the poller from config', async () => {
  const created: WorkflowsPollerDependencies[] = [];
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflows-wiring-'));
  try {
    const rule = { id: 'on', name: 'On', enabled: true, repos: ['Acme/app'], trigger: 'merged', actions: [{ type: 'notify' }] };
    const config: { workflows?: unknown; teamReview?: Record<string, unknown> | null } = { workflows: { enabled: false, maxActionsPerPoll: 7, rules: [rule] } };
    const wiring = createWorkflowsWiring({
      config, homeDir, log: { warn: () => {} },
      notificationManager: { trigger: () => {} },
      spawnSession: async () => {},
      createPoller: (dependencies) => {
        created.push(dependencies);
        return { start: async () => {}, stop: async () => {}, tick: async () => {} };
      },
    });
    wiring.startPoller();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(created.length, 0);
    config.workflows = { enabled: true, maxActionsPerPoll: 7, rules: [rule] };
    wiring.restartIfConfigChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(created.length, 1);
    assert.equal(created[0]?.maxActionsPerPoll, 7);
    await wiring.stopPoller();
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

function enabledRule(id: string) {
  return { id, name: id, enabled: true, repos: ['Acme/app'], trigger: 'opened', actions: [{ type: 'spawn', promptTemplate: 'Look at {{url}}' }] };
}

test('turning the master switch off aborts active workflow sessions and clears queued spawns, and enabling it permits new sessions', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflows-off-'));
  const created: WorkflowsPollerDependencies[] = [];
  const started: number[] = [];
  const signals: AbortSignal[] = [];
  const config: { workflows?: unknown } = { workflows: { maxConcurrentSessions: 1, rules: [enabledRule('triage')] } };
  const wiring = createWorkflowsWiring({
    config, homeDir, log: { warn: () => {} }, notificationManager: { trigger: () => {} },
    spawnSession: ({ event }, signal) => new Promise<void>((resolve) => {
      started.push(event.pr.number);
      signals.push(signal);
      signal.addEventListener('abort', () => resolve(), { once: true });
    }),
    createPoller: (dependencies) => {
      created.push(dependencies);
      return { start: async () => {}, stop: async () => {}, tick: async () => {} };
    },
  });
  try {
    wiring.startPoller();
    await new Promise<void>((resolve) => setImmediate(resolve));
    created[0]?.startSession(spawnActionFor(1));
    created[0]?.startSession(spawnActionFor(2));
    assert.deepEqual(started, [1]);
    config.workflows = { enabled: false, maxConcurrentSessions: 1, rules: [enabledRule('triage')] };
    wiring.restartIfConfigChanged();
    assert.equal(signals[0]?.aborted, true);
    assert.equal(created[0]?.areActionsEnabled?.(), false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [1]);
    config.workflows = { enabled: true, maxConcurrentSessions: 1, rules: [enabledRule('triage')] };
    wiring.restartIfConfigChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
    created.at(-1)?.startSession(spawnActionFor(3));
    assert.deepEqual(started, [1, 3]);
    assert.equal(signals[1]?.aborted, false);
  } finally {
    await wiring.stopPoller();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

function spawnActionFor(number: number): PlannedWorkflowAction & { action: { type: 'spawn'; promptTemplate: string } } {
  return { ...spawnAction(), event: { trigger: 'opened', pr: { ...OPENED_PR, number }, addedReviewRequests: [] } };
}

test('a rule edit restart keeps running workflow sessions and queued spawns and sweeps leftovers only once, while shutdown aborts them', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflows-wiring-'));
  try {
    const created: WorkflowsPollerDependencies[] = [];
    const started: number[] = [];
    const signals: AbortSignal[] = [];
    const finishers: (() => void)[] = [];
    let sweeps = 0;
    const config: { workflows?: unknown; teamReview?: Record<string, unknown> | null } = { workflows: { rules: [enabledRule('triage')] } };
    const wiring = createWorkflowsWiring({
      config, homeDir, log: { warn: () => {} },
      notificationManager: { trigger: () => {} },
      sweepLeftovers: async () => { sweeps += 1; },
      spawnSession: ({ event }, signal) => new Promise<void>((resolve) => {
        started.push(event.pr.number);
        signals.push(signal);
        finishers.push(resolve);
      }),
      createPoller: (dependencies) => {
        created.push(dependencies);
        return { start: async () => { await dependencies.beforeStart?.(); }, stop: async () => {}, tick: async () => {} };
      },
    });
    wiring.startPoller();
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const number of [1, 2, 3]) created[0]?.startSession(spawnActionFor(number));
    assert.deepEqual(started, [1, 2]);
    config.workflows = { rules: [enabledRule('triage'), enabledRule('second')] };
    wiring.restartIfConfigChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(created.length, 2);
    assert.equal(sweeps, 1);
    assert.ok(signals.every((signal) => !signal.aborted));
    finishers.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [1, 2, 3]);
    const stopped = wiring.stopPoller();
    assert.ok(signals.every((signal) => signal.aborted));
    for (const finish of finishers) finish();
    await stopped;
    created[1]?.startSession(spawnActionFor(4));
    assert.deepEqual(started, [1, 2, 3]);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('queued workflow spawns launch only while workflows and their rule stay on, and running sessions keep running', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflows-wiring-'));
  try {
    const created: WorkflowsPollerDependencies[] = [];
    const started: number[] = [];
    const signals: AbortSignal[] = [];
    const finishers: (() => void)[] = [];
    const warnings: string[] = [];
    const config: { workflows?: unknown; teamReview?: Record<string, unknown> | null } = { workflows: { maxConcurrentSessions: 1, rules: [enabledRule('triage')] } };
    const wiring = createWorkflowsWiring({
      config, homeDir, log: { warn: (message) => { warnings.push(message); } },
      notificationManager: { trigger: () => {} },
      spawnSession: ({ event }, signal) => new Promise<void>((resolve) => {
        started.push(event.pr.number);
        signals.push(signal);
        finishers.push(resolve);
      }),
      createPoller: (dependencies) => {
        created.push(dependencies);
        return { start: async () => {}, stop: async () => {}, tick: async () => {} };
      },
    });
    const finishOldestSession = async () => {
      finishers.shift()?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    wiring.startPoller();
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const number of [1, 2, 3, 4]) created[0]?.startSession(spawnActionFor(number));
    assert.deepEqual(started, [1]);
    await finishOldestSession();
    assert.deepEqual(started, [1, 2]);
    config.workflows = { enabled: false, maxConcurrentSessions: 1, rules: [enabledRule('triage')] };
    await finishOldestSession();
    assert.deepEqual(started, [1, 2]);
    assert.ok(signals.every((signal) => !signal.aborted));
    assert.ok(warnings.some((warning) => warning.includes('triage session for Acme/app#3 was discarded because workflows or its rule are turned off')));
    config.workflows = { maxConcurrentSessions: 1, rules: [enabledRule('triage')] };
    for (const number of [5, 6]) created[0]?.startSession(spawnActionFor(number));
    assert.deepEqual(started, [1, 2, 5]);
    config.workflows = { maxConcurrentSessions: 1, rules: [{ ...enabledRule('triage'), enabled: false }] };
    await finishOldestSession();
    assert.deepEqual(started, [1, 2, 5]);
    assert.ok(warnings.some((warning) => warning.includes('triage session for Acme/app#6 was discarded')));
    await wiring.stopPoller();
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('a spawn action refuses with the sandbox reason in the workflows log before staging when the cached sandbox probe found binaries missing', async () => {
  const warnings: string[] = [];
  const calls: string[] = [];
  const spawn = createWorkflowSpawn({
    workRoot: '/unused',
    log: { warn: (message) => { warnings.push(message); } },
    sandboxRefusal: () => 'not started: the Claude Code sandbox needs bwrap and socat, and bwrap is not on PATH. Install bubblewrap and socat',
    makeWorkDir: async () => { calls.push('workdir'); return { dir: '/unused/work', cleanup: async () => {} }; },
    staging: {
      stageCheckout: async () => { calls.push('stage'); return { projectPath: '/cache/acme-app', baseSha: 'b'.repeat(40) }; },
      runSession: async () => { calls.push('run'); return 'finished'; },
    },
  });
  await spawn(spawnAction(), new AbortController().signal);
  assert.deepEqual(calls, []);
  assert.deepEqual(warnings, ['[workflows] triage session for Acme/app#7: not started: the Claude Code sandbox needs bwrap and socat, and bwrap is not on PATH. Install bubblewrap and socat']);
});
