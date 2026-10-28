import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFeatureHintsWiring } from '../server/feature-hints-wiring.ts';
import type { HintableSession } from '../server/feature-hints-wiring.ts';
import type { FeatureHint, HintFeature } from '../shared/contracts/feature-hints.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function hookSession(id: string) {
  const emitter = new EventEmitter();
  const session: HintableSession = Object.assign(emitter, { id });
  return {
    session,
    runBash: (command: string) => emitter.emit('hook-event', { event: 'PostToolUse', payload: { tool_name: 'Bash', tool_input: { command } } }),
    submitPrompt: (prompt: string) => emitter.emit('hook-event', { event: 'UserPromptSubmit', payload: { prompt } }),
  };
}

function startHints(statePath: string, clock: { nowMs: number }) {
  const broadcastHints: FeatureHint[] = [];
  const featureHints = createFeatureHintsWiring({
    statePath, log: { warn: () => {} }, now: () => clock.nowMs,
    broadcast: (message) => { broadcastHints.push(message.hint); },
  });
  return { featureHints, broadcastHints };
}

function tempStatePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feature-hints-')), 'feature-hints.json');
}

test('reviewing three distinct PRs raises one Reviews hint that a settle silences across a restart', async () => {
  const statePath = tempStatePath();
  const clock = { nowMs: 100 * DAY_MS };
  const firstRun = startHints(statePath, clock);
  const agent = hookSession('session-a');
  firstRun.featureHints.attachSession(agent.session);

  agent.runBash('gh pr diff 412 | head -50');
  agent.runBash('gh pr diff 412');
  agent.runBash('cd repo && gh pr checkout 418');
  await firstRun.featureHints.idle();
  assert.deepEqual(firstRun.broadcastHints, []);

  agent.runBash('gh pr view --json title 420');
  await firstRun.featureHints.idle();
  assert.deepEqual(firstRun.broadcastHints, [{ feature: 'teamReview', distinctTargetCount: 3, raisedAt: 100 * DAY_MS }]);
  assert.deepEqual(firstRun.featureHints.pendingHintMessage()?.hint, { feature: 'teamReview', distinctTargetCount: 3, raisedAt: 100 * DAY_MS });

  await firstRun.featureHints.settle('teamReview', 'dismissed');
  await firstRun.featureHints.idle();

  const restarted = startHints(statePath, clock);
  const agentAfterRestart = hookSession('session-b');
  restarted.featureHints.attachSession(agentAfterRestart.session);
  for (const prNumber of [501, 502, 503, 504]) agentAfterRestart.runBash(`gh pr review ${prNumber} --approve`);
  await restarted.featureHints.idle();
  assert.equal(restarted.featureHints.pendingHintMessage(), null);
  assert.deepEqual(restarted.broadcastHints, []);
});

test('a tab shown within 14 days holds its hint back until the view ages out', async () => {
  const clock = { nowMs: 100 * DAY_MS };
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock);
  const agent = hookSession('session-a');
  featureHints.attachSession(agent.session);

  await featureHints.noteViewShown('issues');
  for (const issueNumber of [7, 8, 9]) agent.runBash(`gh issue view ${issueNumber}`);
  await featureHints.idle();
  assert.deepEqual(broadcastHints, []);

  clock.nowMs += 15 * DAY_MS;
  agent.runBash('gh issue comment 10 --body done');
  agent.runBash('gh issue view 11');
  agent.runBash('gh issue view 12');
  await featureHints.idle();
  assert.deepEqual(broadcastHints, [{ feature: 'issues', distinctTargetCount: 3, raisedAt: 115 * DAY_MS }]);
});

test('opening the hinted tab settles its hint so the next feature can surface', async () => {
  const { featureHints, broadcastHints } = startHints(tempStatePath(), { nowMs: 100 * DAY_MS });
  const agent = hookSession('session-a');
  featureHints.attachSession(agent.session);
  for (const prNumber of [1, 2, 3]) agent.runBash(`gh pr view ${prNumber}`);
  await featureHints.idle();
  await featureHints.noteViewShown('prs');
  assert.equal(featureHints.pendingHintMessage(), null);

  for (const issueNumber of [1, 2, 3]) agent.runBash(`gh issue view ${issueNumber}`);
  await featureHints.idle();
  assert.deepEqual(broadcastHints.map((hint) => hint.feature), ['teamReview', 'issues']);
});

const PROMPT_TRIGGERS: readonly { feature: HintFeature; prompts: readonly string[] }[] = [
  { feature: 'teamReview', prompts: ['review PR 12 please', '/code-review 13', 'look at https://github.com/acme/app/pull/14'] },
  { feature: 'issues', prompts: ['fix issue #3', 'see https://github.com/acme/app/issues/4', 'then issue #5'] },
  { feature: 'usage', prompts: ['/cost', 'am I near the rate limit?'] },
  { feature: 'posthog', prompts: ["what's broken in prod today?", 'check error tracking for spikes'] },
  { feature: 'visions', prompts: ['the thing in my editor is wrong', 'this file is off at src/app.ts:42', 'also in my editor, line 9'] },
  { feature: 'benchmarks', prompts: ['benchmark these two prompts', 'compare claude and codex on this refactor'] },
];

for (const { feature, prompts } of PROMPT_TRIGGERS) {
  test(`Claude prompts alone trip the ${feature} hint`, async () => {
    const { featureHints, broadcastHints } = startHints(tempStatePath(), { nowMs: 100 * DAY_MS });
    const agent = hookSession('session-a');
    featureHints.attachSession(agent.session);
    for (const prompt of prompts) agent.submitPrompt(prompt);
    await featureHints.idle();
    assert.deepEqual(broadcastHints.map((hint) => hint.feature), [feature]);
  });
}

test('one prompt sent to two sessions within an hour counts toward Bench', async () => {
  const clock = { nowMs: 100 * DAY_MS };
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock);
  const firstAgent = hookSession('session-a');
  const secondAgent = hookSession('session-b');
  featureHints.attachSession(firstAgent.session);
  featureHints.attachSession(secondAgent.session);
  for (const prompt of ['Refactor the parser into two modules', 'Add retries to the uploader client']) {
    firstAgent.submitPrompt(prompt);
    clock.nowMs += 1000;
    secondAgent.submitPrompt(prompt);
  }
  await featureHints.idle();
  assert.deepEqual(broadcastHints.map((hint) => hint.feature), ['benchmarks']);
});
