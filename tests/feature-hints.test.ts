import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFeatureHintsWiring } from '../server/feature-hints-wiring.ts';
import type { FeatureHint, HintFeature } from '../shared/contracts/feature-hints.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 9, 1);

type Clock = { nowMs: number };

interface HookedSession extends EventEmitter {
  readonly id: string;
  readonly ephemeral: boolean;
  runCommand: (command: string) => void;
  runTool: (toolName: string, toolInput: Record<string, unknown>) => void;
  submitPrompt: (prompt: string) => void;
}

function hookedSession(id: string, { ephemeral = false }: { ephemeral?: boolean } = {}): HookedSession {
  const emitter = new EventEmitter();
  const runTool = (toolName: string, toolInput: Record<string, unknown>) => {
    emitter.emit('hook-event', { event: 'posttooluse', payload: { tool_name: toolName, tool_input: toolInput, tool_response: {} } });
  };
  return Object.assign(emitter, {
    id,
    ephemeral,
    runTool,
    runCommand: (command: string) => runTool('Bash', { command }),
    submitPrompt: (prompt: string) => { emitter.emit('hook-event', { event: 'userpromptsubmit', payload: { prompt } }); },
  });
}

function startHints(statePath: string, clock: Clock) {
  const broadcastHints: FeatureHint[] = [];
  const featureHints = createFeatureHintsWiring({
    statePath, log: { warn: () => {} }, now: () => clock.nowMs,
    broadcast: (message) => { broadcastHints.push(message.hint); },
  });
  test.after(() => featureHints.stop());
  return { featureHints, broadcastHints };
}

function attachedSession(featureHints: { attachSession: (session: HookedSession) => void }, id: string, options: { ephemeral?: boolean } = {}): HookedSession {
  const session = hookedSession(id, options);
  featureHints.attachSession(session);
  return session;
}

function tempStatePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feature-hints-')), 'feature-hints.json');
}

test('Bash commands reviewing three distinct PRs raise one Reviews hint that a settle silences across a restart', async () => {
  const statePath = tempStatePath();
  const clock = { nowMs: START_MS };
  const firstRun = startHints(statePath, clock);
  const codex = attachedSession(firstRun.featureHints, 'session-a');

  codex.runCommand('gh pr diff 412 | head -50');
  codex.runCommand('gh pr diff 412');
  codex.runCommand('cd repo && gh pr checkout 418');
  await firstRun.featureHints.idle();
  assert.deepEqual(firstRun.broadcastHints, []);

  codex.runCommand('gh pr view --json title 420');
  await firstRun.featureHints.idle();
  assert.deepEqual(firstRun.broadcastHints, [{ feature: 'teamReview', distinctTargetCount: 3, raisedAt: START_MS }]);
  assert.deepEqual(firstRun.featureHints.pendingHintMessage()?.hint, { feature: 'teamReview', distinctTargetCount: 3, raisedAt: START_MS });

  await firstRun.featureHints.settle('teamReview', 'dismissed');
  await firstRun.featureHints.stop();

  const restarted = startHints(statePath, clock);
  const claude = attachedSession(restarted.featureHints, 'session-b');
  for (const prNumber of [501, 502, 503, 504]) claude.runCommand(`gh pr review ${prNumber} --approve`);
  await restarted.featureHints.idle();
  assert.equal(restarted.featureHints.pendingHintMessage(), null);
  assert.deepEqual(restarted.broadcastHints, []);
});

test('only the Bash tool counts, and a torn-down session stops counting', async () => {
  const clock = { nowMs: START_MS };
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock);
  const session = attachedSession(featureHints, 'session-a');
  session.runTool('Read', { command: 'gh pr view 1' });
  session.runCommand('gh pr view 2');
  session.runCommand('gh pr view 3');
  session.emit('teardown');
  session.runCommand('gh pr view 4');
  await featureHints.idle();
  assert.deepEqual(broadcastHints, []);
});

test('a tab shown within 14 days holds its hint back until the view ages out', async () => {
  const clock = { nowMs: START_MS };
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock);
  const session = attachedSession(featureHints, 'session-a');

  await featureHints.noteViewShown('prs');
  for (const prNumber of [7, 8, 9]) session.runCommand(`gh pr view ${prNumber}`);
  await featureHints.idle();
  assert.deepEqual(broadcastHints, []);

  clock.nowMs += 15 * DAY_MS;
  session.runCommand('gh pr diff 10');
  session.runCommand('gh pr view 11');
  session.runCommand('gh pr view 12');
  await featureHints.idle();
  assert.deepEqual(broadcastHints, [{ feature: 'teamReview', distinctTargetCount: 3, raisedAt: START_MS + 15 * DAY_MS }]);
});

test('opening the hinted tab settles its hint so the next feature can surface', async () => {
  const clock = { nowMs: START_MS };
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock);
  const session = attachedSession(featureHints, 'session-a');
  for (const prNumber of [1, 2, 3]) session.runCommand(`gh pr view ${prNumber}`);
  await featureHints.idle();
  await featureHints.noteViewShown('prs');
  assert.equal(featureHints.pendingHintMessage(), null);

  session.runCommand('ccusage daily');
  session.runCommand('ccusage monthly');
  await featureHints.idle();
  assert.deepEqual(broadcastHints.map((hint) => hint.feature), ['teamReview', 'usage']);
});

test('hook events from a lane session never count', async () => {
  const clock = { nowMs: START_MS };
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock);
  const laneSession = attachedSession(featureHints, 'lane-session', { ephemeral: true });
  for (const prNumber of [1, 2, 3]) laneSession.runCommand(`gh pr view ${prNumber}`);
  await featureHints.idle();
  assert.deepEqual(broadcastHints, []);
});

const PROMPT_TRIGGERS: readonly { feature: HintFeature; prompts: readonly string[] }[] = [
  { feature: 'teamReview', prompts: ['review PR 12 please', '/code-review 13', 'look at https://github.com/acme/app/pull/14'] },
  { feature: 'usage', prompts: ['/cost', 'am I near the rate limit?'] },
  { feature: 'posthog', prompts: ["what's broken in prod today?", 'check error tracking for spikes'] },
  { feature: 'benchmarks', prompts: ['benchmark these two prompts', 'compare claude and codex on this refactor'] },
];

for (const { feature, prompts } of PROMPT_TRIGGERS) {
  test(`prompts alone trip the ${feature} hint`, async () => {
    const clock = { nowMs: START_MS };
    const { featureHints, broadcastHints } = startHints(tempStatePath(), clock);
    const session = attachedSession(featureHints, 'session-a');
    for (const prompt of prompts) session.submitPrompt(prompt);
    await featureHints.idle();
    assert.deepEqual(broadcastHints.map((hint) => hint.feature), [feature]);
  });
}

test('prompts matching the experimental issues feature never raise a hint', async () => {
  const clock = { nowMs: START_MS };
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock);
  const session = attachedSession(featureHints, 'session-a');
  for (const prompt of ['fix issue #3', 'see https://github.com/acme/app/issues/4', 'then issue #5']) session.submitPrompt(prompt);
  await featureHints.idle();
  assert.deepEqual(broadcastHints, []);
});

test('one prompt sent to two sessions counts toward Bench', async () => {
  const clock = { nowMs: START_MS };
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock);
  const firstSession = attachedSession(featureHints, 'session-a');
  const secondSession = attachedSession(featureHints, 'session-b');
  for (const prompt of ['Refactor the parser into two modules', 'Add retries to the uploader client']) {
    firstSession.submitPrompt(prompt);
    clock.nowMs += 1000;
    secondSession.submitPrompt(prompt);
  }
  await featureHints.idle();
  assert.deepEqual(broadcastHints.map((hint) => hint.feature), ['benchmarks']);
});

test('an Issues hint saved before it went experimental never replays after a restart', async () => {
  const clock = { nowMs: START_MS };
  const statePath = tempStatePath();
  const savedIssuesHint: FeatureHint = { feature: 'issues', distinctTargetCount: 3, raisedAt: START_MS - DAY_MS };
  fs.writeFileSync(statePath, JSON.stringify({ signalsByFeature: {}, settledByFeature: {}, lastShownAtByView: {}, pendingHint: savedIssuesHint }));
  const { featureHints } = startHints(statePath, clock);
  await featureHints.idle();
  assert.equal(featureHints.pendingHintMessage(), null);
});
