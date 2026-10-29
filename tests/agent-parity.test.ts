import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { STATES } from '../shared/states.ts';
import type { SessionState } from '../shared/states.ts';
import { replayThroughSession } from './helpers/session-replay.ts';

type FirstClassAgent = 'claude-code' | 'codex' | 'kimi';
type WaitingExpectation = 'required' | 'forbidden' | 'allowed';

interface ParityScenario {
  name: string;
  expectedFinalState: SessionState;
  expectedCompleteNotifications: number;
  waitingNotification: WaitingExpectation;
  fixtureByAgent: Record<FirstClassAgent, string>;
  additionalFixtures?: readonly string[];
  requiresCompactionWindow?: boolean;
  requiresClearReset?: boolean;
  requiredSignalsByAgent?: Partial<Record<FirstClassAgent, readonly string[]>>;
}

const FIRST_CLASS_AGENTS: readonly FirstClassAgent[] = ['claude-code', 'codex', 'kimi'];
const FIXTURE_DIRECTORY = path.join(import.meta.dirname, 'fixtures');
const PROBE_FIXTURE_RECORD_SPACING_MS = 1000;
const HEADER_READ_BYTES = 4096;

const PARITY_SCENARIOS: readonly ParityScenario[] = [
  {
    name: 'turn-complete',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'forbidden',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-turn-complete.jsonl', codex: 'v2-codex-turn-complete.jsonl', kimi: 'v2-kimi-turn-complete.jsonl' },
    additionalFixtures: ['v2-codex-posttooluse-bash.jsonl'],
  },
  {
    name: 'permission-wait',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'required',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-permission-wait.jsonl', codex: 'v2-codex-approval-turn.jsonl', kimi: 'v2-kimi-approval-turn.jsonl' },
  },
  {
    name: 'plan-wait',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'required',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-plan-wait.jsonl', codex: 'v2-codex-plan-wait.jsonl', kimi: 'v2-kimi-plan-wait.jsonl' },
  },
  {
    name: 'structured-question-answered',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'required',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-structured-question-answered.jsonl', codex: 'v2-codex-request-user-input.jsonl', kimi: 'v2-kimi-ask-question.jsonl' },
  },
  {
    name: 'idle-compaction',
    expectedFinalState: STATES.IDLE,
    expectedCompleteNotifications: 0,
    waitingNotification: 'forbidden',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-idle-compaction.jsonl', codex: 'v2-codex-compaction.jsonl', kimi: 'v2-kimi-idle-compaction.jsonl' },
    requiresCompactionWindow: true,
  },
  {
    name: 'subagent-gates-completion',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'allowed',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-subagent-gates-completion.jsonl', codex: 'v2-codex-subagent.jsonl', kimi: 'v2-kimi-subagent.jsonl' },
    requiredSignalsByAgent: { 'claude-code': ['subagent-start', 'subagent-stop'], codex: ['subagent-start', 'subagent-stop'] },
  },
  {
    name: 'session-clear',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 2,
    waitingNotification: 'forbidden',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-session-clear.jsonl', codex: 'v2-codex-session-clear.jsonl', kimi: 'v2-kimi-session-clear.jsonl' },
    requiresClearReset: true,
  },
];

const REPLAY_HARNESS_TEST = 'replay-harness.test.ts';
const FIXTURES_PINNED_ELSEWHERE: Readonly<Record<string, string>> = {
  'v2-complete-stop.jsonl': REPLAY_HARNESS_TEST,
  'v2-conflict-stop-then-notify.jsonl': REPLAY_HARNESS_TEST,
  'v2-background-monitor-stop.jsonl': REPLAY_HARNESS_TEST,
  'v2-waiting-permission.jsonl': REPLAY_HARNESS_TEST,
  'v2-waiting-plan.jsonl': REPLAY_HARNESS_TEST,
  'v2-question-answered.jsonl': REPLAY_HARNESS_TEST,
  'v2-idle-compaction.jsonl': REPLAY_HARNESS_TEST,
  'v2-mid-turn-compaction.jsonl': REPLAY_HARNESS_TEST,
  'v2-sessionstart-clear.jsonl': REPLAY_HARNESS_TEST,
};

interface FixtureHeader {
  isRecording: boolean;
  agent: string | null;
}

function readFixtureHeader(fixtureFile: string): FixtureHeader {
  const descriptor = fs.openSync(path.join(FIXTURE_DIRECTORY, fixtureFile), 'r');
  const buffer = Buffer.alloc(HEADER_READ_BYTES);
  const bytesRead = fs.readSync(descriptor, buffer, 0, HEADER_READ_BYTES, 0);
  fs.closeSync(descriptor);
  const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
  const header: unknown = JSON.parse(firstLine);
  if (typeof header !== 'object' || header === null || !('type' in header) || header.type !== 'header') return { isRecording: false, agent: null };
  return { isRecording: true, agent: 'agent' in header && typeof header.agent === 'string' ? header.agent : null };
}

function isFirstClassAgent(agent: string): agent is FirstClassAgent {
  return FIRST_CLASS_AGENTS.some((firstClassAgent) => firstClassAgent === agent);
}

function fixturesReplayedByMatrix(): Set<string> {
  const replayedFixtures = new Set<string>();
  for (const scenario of PARITY_SCENARIOS) {
    for (const fixture of Object.values(scenario.fixtureByAgent)) replayedFixtures.add(fixture);
    for (const fixture of scenario.additionalFixtures ?? []) replayedFixtures.add(fixture);
  }
  return replayedFixtures;
}

function assertScenarioOutcome(scenario: ParityScenario, fixture: string, t: TestContext, agent?: FirstClassAgent): void {
  const outcome = replayThroughSession(fixture, t, { minimumGapMs: PROBE_FIXTURE_RECORD_SPACING_MS });
  const completeNotifications = outcome.notifications.filter((category) => category === 'complete').length;
  const hasWaitingNotification = outcome.notifications.includes('waiting');
  assert.equal(outcome.finalState, scenario.expectedFinalState, `notifications: ${outcome.notifications.join(', ')}`);
  assert.equal(completeNotifications, scenario.expectedCompleteNotifications, `notifications: ${outcome.notifications.join(', ')}`);
  if (scenario.waitingNotification === 'required') assert.ok(hasWaitingNotification, 'the card never showed the wait');
  if (scenario.waitingNotification === 'forbidden') assert.ok(!hasWaitingNotification, 'the card showed a wait the scenario never had');
  if (scenario.requiresClearReset) assert.ok(outcome.taskTitleResets > 0, 'the clear never reset the session');
  for (const signal of agent ? scenario.requiredSignalsByAgent?.[agent] ?? [] : []) assert.ok(outcome.hookSignals.includes(signal), `no ${signal} signal reached the session`);
  if (!scenario.requiresCompactionWindow) return;
  const compactingByEvent = outcome.compactingAfterEvent.map(({ event, isCompacting }) => ({ event: event.toLowerCase(), isCompacting }));
  assert.ok(compactingByEvent.some(({ event, isCompacting }) => event === 'precompact' && isCompacting), 'PreCompact never opened the compaction window');
  assert.equal(compactingByEvent.findLast(({ event }) => event === 'postcompact')?.isCompacting, false, 'PostCompact never closed the compaction window');
}

for (const scenario of PARITY_SCENARIOS) {
  for (const agent of FIRST_CLASS_AGENTS) {
    test(`${scenario.name} on ${agent}`, (t) => {
      const fixture = scenario.fixtureByAgent[agent];
      assert.equal(readFixtureHeader(fixture).agent, agent, `${fixture} header names another agent`);
      assertScenarioOutcome(scenario, fixture, t, agent);
    });
  }
  for (const fixture of scenario.additionalFixtures ?? []) {
    test(`${scenario.name} on ${fixture}`, (t) => assertScenarioOutcome(scenario, fixture, t));
  }
}

test('every fixture pinned elsewhere is named by the test that asserts it', () => {
  for (const [fixture, assertingTest] of Object.entries(FIXTURES_PINNED_ELSEWHERE)) {
    assert.ok(fs.existsSync(path.join(FIXTURE_DIRECTORY, fixture)), `${fixture} is missing`);
    assert.ok(fs.readFileSync(path.join(import.meta.dirname, assertingTest), 'utf8').includes(fixture), `${assertingTest} never loads ${fixture}`);
  }
});

test('every first-class v2 recording sits in a parity row or a test that asserts it', () => {
  const replayedFixtures = fixturesReplayedByMatrix();
  const unplacedFixtures = fs.readdirSync(FIXTURE_DIRECTORY)
    .filter((fixture) => fixture.startsWith('v2-') && fixture.endsWith('.jsonl'))
    .filter((fixture) => !replayedFixtures.has(fixture) && !(fixture in FIXTURES_PINNED_ELSEWHERE))
    .filter((fixture) => {
      const header = readFixtureHeader(fixture);
      return header.isRecording && (header.agent === null || isFirstClassAgent(header.agent));
    });
  assert.deepEqual(unplacedFixtures, []);
});
