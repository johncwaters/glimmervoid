import './helpers/isolate-home.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { STATES } from '../shared/states.ts';
import { TraceRecord } from '../shared/contracts/trace.ts';
import { parseAntigravityUsageLine } from '../server/usage/core/usage-antigravity-core.ts';
import { createCodexUsageState, parseCodexUsageLine } from '../server/usage/core/usage-codex-core.ts';
import { parseUsageLine } from '../server/usage/core/usage-entry-core.ts';
import { parseKimiUsageLine } from '../server/usage/core/usage-kimi-core.ts';
import { applyPiHeaderLine, createPiUsageState, parsePiUsageLine } from '../server/usage/core/usage-pi-core.ts';
import type { UsageEntry } from '../server/usage/core/usage-entry-core.ts';
import { relaySourceOf, transcriptSourceOf } from '../server/trace/conversation-sources.ts';
import type { SessionState } from '../shared/states.ts';
import { replayThroughSession } from './helpers/session-replay.ts';
import { getAdapter, hookProfileOf } from '../session/adapters/index.ts';
import { Session } from '../session/sessions.ts';
import { permissionReplyFor } from '../session/core/claude-approval-core.ts';
import { openCodePluginFiles } from '../session/core/opencode-plugin-core.ts';
import { CONVERSATION_PERMISSION_HOOK_EVENT } from '../shared/contracts/session.ts';
import type { HookPayload, PermissionDecision } from '../shared/contracts/index.ts';
import { capturingPty } from './helpers/fake-pty.ts';

type FirstClassAgent = 'claude-code' | 'codex' | 'kimi' | 'opencode' | 'pi' | 'antigravity';
type WaitingExpectation = 'required' | 'forbidden' | 'allowed';

interface UnproducibleScenario {
  unproducible: string;
}

interface ParityScenario {
  name: string;
  expectedFinalState: SessionState;
  expectedCompleteNotifications: number;
  expectedCompleteTransitions?: number;
  waitingNotification: WaitingExpectation;
  fixtureByAgent: Record<FirstClassAgent, string | UnproducibleScenario>;
  additionalFixtures?: readonly string[];
  requiresCompactionWindow?: boolean;
  requiresClearReset?: boolean;
  requiredSignalsByAgent?: Partial<Record<FirstClassAgent, readonly string[]>>;
}

interface ConversationFixture {
  file: string;
  vendorSessionId: string;
}

const FIRST_CLASS_AGENTS: readonly FirstClassAgent[] = ['claude-code', 'codex', 'kimi', 'opencode', 'pi', 'antigravity'];
const FIXTURE_DIRECTORY = path.join(import.meta.dirname, 'fixtures');
const CONVERSATION_FIXTURE_DIRECTORY = path.join(FIXTURE_DIRECTORY, 'conversation');
const REQUIRED_CONVERSATION_KINDS = ['prompt', 'assistant', 'tool_call', 'tool_result'] as const;
const CONVERSATION_FIXTURE_BY_AGENT: Record<FirstClassAgent, ConversationFixture | UnproducibleScenario> = {
  'claude-code': { file: 'claude-transcript.jsonl', vendorSessionId: 'd52a3005-05a6-48f3-a913-180b01ff3daf' },
  codex: { file: 'codex-rollout.jsonl', vendorSessionId: '01a1ea8d-3204-7bf3-a022-1aedf182e1dc' },
  kimi: { file: 'kimi-wire.jsonl', vendorSessionId: 'session_2c2d0092-eee8-4450-a133-5c9887f826b3' },
  opencode: { file: 'opencode-relay.jsonl', vendorSessionId: 'ses_e154ce321ffeFtygutuOR5lLPD' },
  pi: { file: 'pi-session.jsonl', vendorSessionId: '01a1eaa3-6a11-745a-8f7a-862a3b0fdbe9' },
  antigravity: { file: 'antigravity-transcript.jsonl', vendorSessionId: 'e49c4f93-2b16-498c-ac66-a509a837905c' },
};
const SPILLED_OUTPUT_FIXTURE_BY_AGENT: Record<FirstClassAgent, ConversationFixture | UnproducibleScenario> = {
  'claude-code': { file: 'claude-spill.jsonl', vendorSessionId: 'b26ac462-dd87-4b37-bc79-319e6210fc72' },
  codex: { unproducible: 'Codex converts CommandExecution.aggregated_output, the raw command output, which Codex never wraps; its truncation note lives only in the model-facing tool output' },
  kimi: { file: 'kimi-spill.jsonl', vendorSessionId: 'session_4c392ca0-0483-4142-93eb-2c1724240a36' },
  opencode: { unproducible: 'OpenCode is not installed on the capture host and its truncation note is not yet known, so no spilled relay event exists to capture' },
  pi: { file: 'pi-spill.jsonl', vendorSessionId: '01a1eb36-5519-75b2-ad2e-f67b52e126e9' },
  antigravity: { file: 'antigravity-spill.jsonl', vendorSessionId: '36aa83a7-4886-494b-80f8-9aafc4c7c16a' },
};
const USAGE_FIXTURE_BY_AGENT: Record<FirstClassAgent, ConversationFixture | UnproducibleScenario> = {
  'claude-code': CONVERSATION_FIXTURE_BY_AGENT['claude-code'],
  codex: CONVERSATION_FIXTURE_BY_AGENT.codex,
  kimi: CONVERSATION_FIXTURE_BY_AGENT.kimi,
  opencode: { unproducible: 'OpenCode is not installed on the capture host, so no live usage fixture can be captured' },
  pi: CONVERSATION_FIXTURE_BY_AGENT.pi,
  antigravity: CONVERSATION_FIXTURE_BY_AGENT.antigravity,
};
const STARTUP_READY_FIXTURE_BY_AGENT: Record<FirstClassAgent, string | UnproducibleScenario> = {
  'claude-code': { unproducible: 'Claude Code reports input readiness through its SessionStart hook, not its terminal output, which the control-chat startup hook tests pin' },
  codex: 'v2-codex-startup-ready.jsonl',
  kimi: 'v2-kimi-startup-ready.jsonl',
  opencode: { unproducible: 'the operator left OpenCode at the first-output default, so no startup capture was taken' },
  pi: { unproducible: 'the operator left pi at the first-output default, so no startup capture was taken' },
  antigravity: 'v2-antigravity-startup-ready.jsonl',
};
const STARTUP_READY_RECORD_BY_FIXTURE: Readonly<Record<string, number>> = {
  'v2-codex-startup-ready.jsonl': 0,
  'v2-kimi-startup-ready.jsonl': 15,
  'v2-antigravity-startup-ready.jsonl': 13,
};
const SPILL_WRAPPER_TEXT = /persisted-output|Output too large|output_path|\[preview: chars \[0,|Full output:|truncated due to being too long/;
const PROBE_FIXTURE_RECORD_SPACING_MS = 1000;
const HEADER_READ_BYTES = 4096;

const PARITY_SCENARIOS: readonly ParityScenario[] = [
  {
    name: 'turn-complete',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'forbidden',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-turn-complete.jsonl', codex: 'v2-codex-turn-complete.jsonl', kimi: 'v2-kimi-turn-complete.jsonl', opencode: 'v2-opencode-turn-complete.jsonl', pi: 'v2-pi-turn-complete.jsonl', antigravity: 'v2-antigravity-turn-complete.jsonl' },
    additionalFixtures: ['v2-codex-posttooluse-bash.jsonl'],
  },
  {
    name: 'permission-wait',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'required',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-permission-wait.jsonl', codex: 'v2-codex-permission-wait.jsonl', kimi: 'v2-kimi-approval-turn.jsonl', opencode: 'v2-opencode-approval-turn.jsonl', pi: 'v2-pi-approval-turn.jsonl', antigravity: 'v2-antigravity-approval-turn.jsonl' },
    additionalFixtures: ['v2-antigravity-mcp-tool.jsonl'],
  },
  {
    name: 'plan-wait',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'required',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-plan-wait.jsonl', codex: 'v2-codex-plan-wait.jsonl', kimi: 'v2-kimi-plan-wait.jsonl', opencode: 'v2-opencode-plan-wait.jsonl', pi: 'v2-pi-plan-wait.jsonl', antigravity: 'v2-antigravity-plan-wait.jsonl' },
  },
  {
    name: 'sign-in-wait',
    expectedFinalState: STATES.WAITING,
    expectedCompleteNotifications: 0,
    waitingNotification: 'required',
    fixtureByAgent: {
      'claude-code': 'v2-claude-code-sign-in-wait.jsonl',
      codex: { unproducible: 'Codex 0.169.0 has no hook that reports a failed login, and its terminal text may not be read' },
      kimi: { unproducible: 'Kimi 2.7.0 signed out fails before any turn starts, so no hook fires, and an expired token needs its credentials copied, which Safety Net forbids' },
      opencode: { unproducible: 'OpenCode is not installed on the recording machine, and its credential store may not be read to expire a login' },
      pi: { unproducible: 'pi is not installed on the recording machine, and its auth file may not be read to expire a login' },
      antigravity: { unproducible: 'Antigravity agy 1.5.12 has no login command and no hook that reports a failed login' },
    },
  },
  {
    name: 'rate-limit-wait',
    expectedFinalState: STATES.WAITING,
    expectedCompleteNotifications: 0,
    waitingNotification: 'required',
    fixtureByAgent: {
      'claude-code': 'v2-claude-code-rate-limit-wait.jsonl',
      codex: { unproducible: 'Codex 0.169.0 has no hook that reports a stop on a rate or plan limit, no rollout on the recording machine carries a non-null rate_limit_reached_type, and a rate or plan limit cannot be reached on demand' },
      kimi: { unproducible: 'Kimi 2.7.0 has no hook that reports a stop on a rate or plan limit, and a rate or plan limit cannot be reached on demand' },
      opencode: { unproducible: 'OpenCode is not installed on the recording machine, and a rate or plan limit cannot be reached on demand' },
      pi: { unproducible: 'pi is not installed on the recording machine, and a rate or plan limit cannot be reached on demand' },
      antigravity: { unproducible: 'Antigravity agy 1.5.12 has no hook that reports a stop on a rate or plan limit, and a rate or plan limit cannot be reached on demand' },
    },
  },
  {
    name: 'background-stall-wait',
    expectedFinalState: STATES.WAITING,
    expectedCompleteNotifications: 0,
    waitingNotification: 'required',
    fixtureByAgent: {
      'claude-code': 'v2-claude-code-background-stall-wait.jsonl',
      codex: { unproducible: 'Codex 0.169.0: a background agent that never reports its stop cannot be produced on demand, and the one recorded case came from a Claude Code usage dialog' },
      kimi: { unproducible: 'Kimi 2.7.0: a background agent that never reports its stop cannot be produced on demand, and the one recorded case came from a Claude Code usage dialog' },
      opencode: { unproducible: 'OpenCode is not installed on the recording machine, and a background agent that never reports its stop cannot be produced on demand, and the one recorded case came from a Claude Code usage dialog' },
      pi: { unproducible: 'pi is not installed on the recording machine, and a background agent that never reports its stop cannot be produced on demand, and the one recorded case came from a Claude Code usage dialog' },
      antigravity: { unproducible: 'Antigravity agy 1.5.12: a background agent that never reports its stop cannot be produced on demand, and the one recorded case came from a Claude Code usage dialog' },
    },
  },
  {
    name: 'structured-question-answered',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'required',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-structured-question-answered.jsonl', codex: 'v2-codex-request-user-input.jsonl', kimi: 'v2-kimi-ask-question.jsonl', opencode: 'v2-opencode-ask-question.jsonl', pi: 'v2-pi-ask-question.jsonl', antigravity: 'v2-antigravity-ask-question.jsonl' },
  },
  {
    name: 'idle-compaction',
    expectedFinalState: STATES.IDLE,
    expectedCompleteNotifications: 0,
    waitingNotification: 'forbidden',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-idle-compaction.jsonl', codex: 'v2-codex-compaction.jsonl', kimi: 'v2-kimi-idle-compaction.jsonl', opencode: 'v2-opencode-idle-compaction.jsonl', pi: 'v2-pi-idle-compaction.jsonl', antigravity: { unproducible: 'agy has no compaction command and emits no hook when it compacts on its own' } },
    requiresCompactionWindow: true,
  },
  {
    name: 'subagent-gates-completion',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'allowed',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-subagent-gates-completion.jsonl', codex: 'v2-codex-subagent.jsonl', kimi: 'v2-kimi-subagent.jsonl', opencode: 'v2-opencode-subagent.jsonl', pi: 'v2-pi-subagent.jsonl', antigravity: 'v2-antigravity-subagent.jsonl' },
    requiredSignalsByAgent: { 'claude-code': ['subagent-start', 'subagent-stop'], codex: ['subagent-start', 'subagent-stop'], opencode: ['subagent-start', 'subagent-stop'], antigravity: ['subagent-start', 'subagent-stop'] },
  },
  {
    name: 'session-clear',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 2,
    waitingNotification: 'forbidden',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-session-clear.jsonl', codex: 'v2-codex-session-clear.jsonl', kimi: 'v2-kimi-session-clear.jsonl', opencode: 'v2-opencode-session-clear.jsonl', pi: 'v2-pi-session-clear.jsonl', antigravity: 'v2-antigravity-session-clear.jsonl' },
    requiresClearReset: true,
  },
  {
    name: 'model-setup-turn',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'forbidden',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-model-setup-turn.jsonl', codex: 'v2-codex-model-setup-turn.jsonl', kimi: 'v2-kimi-model-setup-turn.jsonl', opencode: 'v2-opencode-model-setup-turn.jsonl', pi: 'v2-pi-model-setup-turn.jsonl', antigravity: 'v2-antigravity-model-setup-turn.jsonl' },
  },
  {
    name: 'whiteboard-prompt-context',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'forbidden',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-whiteboard-prompt-context.jsonl', codex: 'v2-codex-whiteboard-prompt-context.jsonl', kimi: 'v2-kimi-whiteboard-prompt-context.jsonl', opencode: 'v2-opencode-whiteboard-prompt-context.jsonl', pi: 'v2-pi-whiteboard-prompt-context.jsonl', antigravity: 'v2-antigravity-whiteboard-prompt-context.jsonl' },
  },
  {
    name: 'background-self-wake',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    expectedCompleteTransitions: 1,
    waitingNotification: 'allowed',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-background-self-wake.jsonl', codex: 'v2-codex-background-self-wake.jsonl', kimi: 'v2-kimi-background-self-wake.jsonl', opencode: 'v2-opencode-background-self-wake.jsonl', pi: 'v2-pi-background-self-wake.jsonl', antigravity: 'v2-antigravity-background-self-wake.jsonl' },
  },
  {
    name: 'pack-agent-context-skills',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'allowed',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-pack-agent-context-skills.jsonl', codex: 'v2-codex-pack-agent-context-skills.jsonl', kimi: 'v2-kimi-pack-agent-context-skills.jsonl', opencode: 'v2-opencode-pack-agent-context-skills.jsonl', pi: 'v2-pi-pack-agent-context-skills.jsonl', antigravity: 'v2-antigravity-pack-agent-context-skills.jsonl' },
  },
  {
    name: 'pack-mcp-servers',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'allowed',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-pack-mcp-servers.jsonl', codex: 'v2-codex-pack-mcp-servers.jsonl', kimi: 'v2-kimi-pack-mcp-servers.jsonl', opencode: 'v2-opencode-pack-mcp-servers.jsonl', pi: { unproducible: 'no pi model provider is available on the capture host: OpenCode Zen free models refuse pi with 429 FreeUsageLimitError and there is no OpenRouter key, so the pi path is covered by the generated-extension and secret-leak tests only' }, antigravity: 'v2-antigravity-pack-mcp-servers.jsonl' },
  },
  {
    name: 'resume-continue',
    expectedFinalState: STATES.COMPLETE,
    expectedCompleteNotifications: 1,
    waitingNotification: 'forbidden',
    fixtureByAgent: { 'claude-code': 'v2-claude-code-resume-continue.jsonl', codex: 'v2-codex-resume-continue.jsonl', kimi: 'v2-kimi-resume-continue.jsonl', opencode: 'v2-opencode-resume-continue.jsonl', pi: 'v2-pi-resume-continue.jsonl', antigravity: 'v2-antigravity-resume-continue.jsonl' },
  },
];

const FIXTURES_PINNED_ELSEWHERE: ReadonlySet<string> = new Set([
  'v2-codex-approval-turn.jsonl',
  'v2-claude-code-command-hint.jsonl',
  'v2-codex-command-hint.jsonl',
  'v2-kimi-command-hint.jsonl',
  'v2-kimi-command-hint-delivery.jsonl',
  'v2-complete-stop.jsonl',
  'v2-conflict-stop-then-notify.jsonl',
  'v2-background-monitor-stop.jsonl',
  'v2-waiting-permission.jsonl',
  'v2-waiting-plan.jsonl',
  'v2-question-answered.jsonl',
  'v2-idle-compaction.jsonl',
  'v2-mid-turn-compaction.jsonl',
  'v2-mid-turn-compaction-interrupt.jsonl',
  'v2-mid-turn-compaction-then-interrupt.jsonl',
  'v2-sessionstart-clear.jsonl',
]);

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
    for (const fixture of Object.values(scenario.fixtureByAgent)) if (typeof fixture === 'string') replayedFixtures.add(fixture);
    for (const fixture of scenario.additionalFixtures ?? []) replayedFixtures.add(fixture);
  }
  for (const fixture of Object.values(STARTUP_READY_FIXTURE_BY_AGENT)) if (typeof fixture === 'string') replayedFixtures.add(fixture);
  return replayedFixtures;
}

function assertScenarioOutcome(scenario: ParityScenario, fixture: string, t: TestContext, agent?: FirstClassAgent): void {
  const outcome = replayThroughSession(fixture, t, { minimumGapMs: PROBE_FIXTURE_RECORD_SPACING_MS });
  const completeNotifications = outcome.notifications.filter((category) => category === 'complete').length;
  const hasWaitingNotification = outcome.notifications.includes('waiting');
  assert.equal(outcome.finalState, scenario.expectedFinalState, `notifications: ${outcome.notifications.join(', ')}`);
  assert.equal(completeNotifications, scenario.expectedCompleteNotifications, `notifications: ${outcome.notifications.join(', ')}`);
  if (scenario.expectedCompleteTransitions !== undefined) {
    const completeTransitions = outcome.transitions.filter((state) => state === STATES.COMPLETE).length;
    assert.equal(completeTransitions, scenario.expectedCompleteTransitions, `transitions: ${outcome.transitions.join(', ')}`);
  }
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
    const fixture = scenario.fixtureByAgent[agent];
    if (typeof fixture !== 'string') {
      test(`${scenario.name} on ${agent}`, { skip: fixture.unproducible }, () => {});
      continue;
    }
    test(`${scenario.name} on ${agent}`, (t) => {
      assert.equal(readFixtureHeader(fixture).agent, agent, `${fixture} header names another agent`);
      assertScenarioOutcome(scenario, fixture, t, agent);
    });
  }
  for (const fixture of scenario.additionalFixtures ?? []) {
    test(`${scenario.name} on ${fixture}`, (t) => assertScenarioOutcome(scenario, fixture, t));
  }
}

function recordedTerminalOutput(fixtureFile: string): string[] {
  return fs.readFileSync(path.join(FIXTURE_DIRECTORY, fixtureFile), 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line)).filter((record) => record.type === 'data').map((record) => record.data);
}

async function settleChatDelivery(t: TestContext): Promise<void> {
  t.mock.timers.tick(0);
  for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
}

for (const agent of FIRST_CLASS_AGENTS) {
  const fixture = STARTUP_READY_FIXTURE_BY_AGENT[agent];
  if (typeof fixture !== 'string') {
    test(`a Chat message to a starting session waits until the agent can take input on ${agent}`, { skip: fixture.unproducible }, () => {});
    continue;
  }
  test(`a Chat message to a starting session waits until the agent can take input on ${agent}`, async (t) => {
    assert.equal(readFixtureHeader(fixture).agent, agent, `${fixture} header names another agent`);
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-startup-ready-'));
    const ptyWrites: string[] = [];
    const session = new Session({ id: `startup-ready-${agent}`, name: agent, path: projectPath, agent, ptySpawn: () => capturingPty(ptyWrites) });
    t.after(() => {
      session.destroy();
      fs.rmSync(projectPath, { recursive: true, force: true });
    });
    await session.start();
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    session.queueChatMessage('Sent while the agent was starting');
    const readyRecord = STARTUP_READY_RECORD_BY_FIXTURE[fixture];
    for (const [recordIndex, output] of recordedTerminalOutput(fixture).entries()) {
      session._handlePtyData(output);
      await settleChatDelivery(t);
      const hasTypedMessage = ptyWrites.some((write) => write.includes('Sent while the agent was starting'));
      if (recordIndex < (readyRecord ?? 0)) {
        assert.equal(session.state, STATES.STARTING, `left starting at record ${recordIndex}, before the agent could take input`);
        assert.ok(!hasTypedMessage, `typed the message at record ${recordIndex}, before the agent could take input`);
        continue;
      }
      if (recordIndex !== readyRecord) continue;
      assert.notEqual(session.state, STATES.STARTING, `still starting at record ${recordIndex}, where the agent takes input`);
      assert.ok(hasTypedMessage, `held the message past record ${recordIndex}, where the agent takes input`);
    }
    for (let elapsedMs = 0; elapsedMs < 2000; elapsedMs += 100) {
      t.mock.timers.tick(100);
      await settleChatDelivery(t);
    }
    assert.ok(ptyWrites.some((write) => write.includes('Sent while the agent was starting')), 'the message never reached the agent');
  });
}

test('every fixture pinned elsewhere still exists', () => {
  for (const fixture of FIXTURES_PINNED_ELSEWHERE) assert.ok(fs.existsSync(path.join(FIXTURE_DIRECTORY, fixture)), `${fixture} is missing`);
});

test('every first-class v2 recording sits in a parity row or a test that asserts it', () => {
  const replayedFixtures = fixturesReplayedByMatrix();
  const unplacedFixtures = fs.readdirSync(FIXTURE_DIRECTORY)
    .filter((fixture) => fixture.startsWith('v2-') && fixture.endsWith('.jsonl'))
    .filter((fixture) => !replayedFixtures.has(fixture) && !FIXTURES_PINNED_ELSEWHERE.has(fixture))
    .filter((fixture) => {
      const header = readFixtureHeader(fixture);
      return header.isRecording && (header.agent === null || isFirstClassAgent(header.agent));
    });
  assert.deepEqual(unplacedFixtures, []);
});

function convertedConversation(agent: FirstClassAgent, fixture: ConversationFixture): unknown[] {
  const lines = fs.readFileSync(path.join(CONVERSATION_FIXTURE_DIRECTORY, fixture.file), 'utf8').split('\n').filter((line) => line.length > 0);
  const transcriptSource = transcriptSourceOf(agent);
  if (transcriptSource) return lines.flatMap((line) => transcriptSource.recordsFromLine(line, { vendorSessionId: fixture.vendorSessionId, now: 0 }));
  const relaySource = relaySourceOf(agent);
  assert.ok(relaySource, `${agent} has no conversation source`);
  return lines.map((line) => JSON.parse(line)).filter((relay) => relay.event === relaySource.hookEvent).flatMap((relay) => relaySource.recordsFromPayload(relay.body, 0));
}

for (const agent of FIRST_CLASS_AGENTS) {
  const fixture = CONVERSATION_FIXTURE_BY_AGENT[agent];
  if ('unproducible' in fixture) {
    test(`conversation records on ${agent}`, { skip: fixture.unproducible }, () => {});
    continue;
  }
  test(`conversation records on ${agent}`, () => {
    const records = convertedConversation(agent, fixture).map((record) => TraceRecord.parse(record));
    const kinds = new Set(records.map((record) => record.kind));
    for (const kind of REQUIRED_CONVERSATION_KINDS) assert.ok(kinds.has(kind), `${agent} produced no ${kind} record`);
    const toolCallIds = new Set(records.flatMap((record) => record.kind === 'tool_call' ? [record.toolUseId] : []));
    assert.ok(records.some((record) => record.kind === 'tool_result' && toolCallIds.has(record.toolUseId)), `${agent} paired no tool_result to a tool_call`);
  });
}

function parsedUsageEntries(agent: FirstClassAgent, fixture: ConversationFixture): UsageEntry[] {
  const fixturePath = path.join(CONVERSATION_FIXTURE_DIRECTORY, fixture.file);
  const lines = fs.readFileSync(fixturePath, 'utf8').split('\n').filter((line) => line.length > 0);
  const entries: UsageEntry[] = [];
  const codexState = createCodexUsageState();
  const piState = createPiUsageState();
  const syntheticKimiPath = path.join('sessions', fixture.vendorSessionId, 'agents', 'main', 'wire.jsonl');
  const syntheticAntigravityPath = path.join('brain', fixture.vendorSessionId, '.system_generated', 'logs', 'transcript.jsonl');
  for (const line of lines) {
    if (agent === 'claude-code') {
      const entry = parseUsageLine(line);
      if (entry) entries.push(entry);
      continue;
    }
    if (agent === 'codex') {
      const entry = parseCodexUsageLine(line, codexState);
      if (entry) entries.push({ ...entry, sessionId: fixture.vendorSessionId });
      continue;
    }
    if (agent === 'kimi') {
      const entry = parseKimiUsageLine(line, syntheticKimiPath);
      if (entry) entries.push(entry);
      continue;
    }
    if (agent === 'pi') {
      if (applyPiHeaderLine(line, piState)) continue;
      const entry = parsePiUsageLine(line, fixturePath, piState);
      if (entry) entries.push(entry);
      continue;
    }
    if (agent === 'antigravity') {
      const entry = parseAntigravityUsageLine(line, syntheticAntigravityPath);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

test('usage parsing covers every first-class agent', () => {
  for (const agent of FIRST_CLASS_AGENTS) {
    const fixture = USAGE_FIXTURE_BY_AGENT[agent];
    if ('unproducible' in fixture) {
      assert.ok(fixture.unproducible.trim().length > 0, `${agent} unproducible reason is empty`);
      continue;
    }
    const entries = parsedUsageEntries(agent, fixture);
    assert.ok(entries.length > 0, `${agent} fixture produced no usage entries`);
    for (const entry of entries) {
      assert.ok(Number.isFinite(entry.timestampMs), `${agent} entry missing timestampMs`);
      assert.ok(entry.input + entry.output + entry.cacheRead + entry.cacheCreate > 0, `${agent} entry has zero tokens`);
      if (agent !== 'codex') assert.ok(entry.model, `${agent} entry missing model`);
    }
  }
});

for (const agent of FIRST_CLASS_AGENTS) {
  const fixture = SPILLED_OUTPUT_FIXTURE_BY_AGENT[agent];
  if ('unproducible' in fixture) {
    test(`a spilled tool output keeps what the tool printed, not the save-to-file wrapper, on ${agent}`, { skip: fixture.unproducible }, () => {});
    continue;
  }
  test(`a spilled tool output keeps what the tool printed, not the save-to-file wrapper, on ${agent}`, () => {
    const toolResults = convertedConversation(agent, fixture).map((record) => TraceRecord.parse(record)).flatMap((record) => record.kind === 'tool_result' ? [record] : []);
    assert.equal(toolResults.length, 1, `${agent} produced no tool_result from its spilled output`);
    const [toolResult] = toolResults;
    assert.doesNotMatch(toolResult?.content ?? '', SPILL_WRAPPER_TEXT);
    assert.match(toolResult?.content ?? '', /\d+\r?\n\d+\r?\n/);
    assert.equal(toolResult?.truncated, true);
  });
}

function firstHookPayload(fixtureFile: string, event: string): HookPayload {
  const record = fs.readFileSync(path.join(FIXTURE_DIRECTORY, fixtureFile), 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line)).find((line) => line.type === 'hook' && line.event === event);
  assert.ok(record, `${fixtureFile} has no ${event} record`);
  return record.payload;
}

function openCodeHeldRequest(): HookPayload {
  const { props } = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIRECTORY, 'opencode-permission-asked.json'), 'utf8'));
  return { tool_name: props.action, tool_input: { resources: props.resources } };
}

function antigravityHeldRequest(): HookPayload {
  const adapter = getAdapter('antigravity');
  assert.ok(adapter, 'Antigravity has no adapter');
  const enrich = hookProfileOf(adapter)?.createPayloadEnricher?.();
  assert.ok(enrich, 'Antigravity has no payload enricher');
  return enrich(CONVERSATION_PERMISSION_HOOK_EVENT, firstHookPayload('v2-antigravity-approval-turn.jsonl', 'pretooluse'));
}

type ReplyPath = readonly string[];
const PERMISSION_REQUEST_BEHAVIOR: ReplyPath = ['hookSpecificOutput', 'decision', 'behavior'];
const PERMISSION_REQUEST_MESSAGE: ReplyPath = ['hookSpecificOutput', 'decision', 'message'];
const CHAT_PERMISSION_BY_AGENT: Record<FirstClassAgent, { heldRequest: () => HookPayload; decisionAt: ReplyPath; reasonAt: ReplyPath }> = {
  'claude-code': { heldRequest: () => firstHookPayload('v2-claude-code-permission-wait.jsonl', 'permissionrequest'), decisionAt: PERMISSION_REQUEST_BEHAVIOR, reasonAt: PERMISSION_REQUEST_MESSAGE },
  codex: { heldRequest: () => firstHookPayload('v2-codex-permission-wait.jsonl', 'permissionrequest'), decisionAt: PERMISSION_REQUEST_BEHAVIOR, reasonAt: PERMISSION_REQUEST_MESSAGE },
  kimi: { heldRequest: () => firstHookPayload('v2-kimi-approval-turn.jsonl', 'permissionrequest'), decisionAt: ['hookSpecificOutput', 'permissionDecision'], reasonAt: ['hookSpecificOutput', 'permissionDecisionReason'] },
  opencode: { heldRequest: openCodeHeldRequest, decisionAt: PERMISSION_REQUEST_BEHAVIOR, reasonAt: PERMISSION_REQUEST_MESSAGE },
  pi: { heldRequest: () => firstHookPayload('v2-pi-approval-turn.jsonl', 'permissionrequest'), decisionAt: PERMISSION_REQUEST_BEHAVIOR, reasonAt: PERMISSION_REQUEST_MESSAGE },
  antigravity: { heldRequest: antigravityHeldRequest, decisionAt: ['decision'], reasonAt: ['reason'] },
};

function valueAt(reply: unknown, replyPath: ReplyPath): unknown {
  return replyPath.reduce<unknown>((value, key) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined), reply);
}

for (const agent of FIRST_CLASS_AGENTS) {
  test(`a permission prompt is held for Chat and answered with the agent's own reply on ${agent}`, async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-chat-permission-'));
    const session = new Session({ id: `chat-permission-${agent}`, name: agent, path: projectPath, agent, readChatApprovals: () => 'questions-and-permissions', ptySpawn: () => capturingPty([]) });
    const { heldRequest, decisionAt, reasonAt } = CHAT_PERMISSION_BY_AGENT[agent];
    try {
      for (const decision of ['allow', 'deny'] satisfies PermissionDecision[]) {
        const held = session.holdConversationPermission(heldRequest(), new AbortController().signal);
        assert.ok(held, 'the permission prompt was not held');
        const approval = session.toSnapshot().conversationApproval;
        assert.equal(approval?.kind, 'permission');
        assert.ok(approval?.toolName, 'the held approval names no tool');
        assert.ok(session.decideConversationApproval(approval.requestId, decision));
        assert.equal(valueAt(await held, decisionAt), decision);
        assert.equal(session.toSnapshot().conversationApproval, null);
      }
      const heldForMessage = session.holdConversationPermission(heldRequest(), new AbortController().signal);
      assert.ok(heldForMessage, 'the permission prompt was not held');
      const approvalForMessage = session.toSnapshot().conversationApproval;
      assert.ok(approvalForMessage);
      assert.ok(session.decideConversationApproval(approvalForMessage.requestId, 'deny', 'Run npm run clean instead'));
      const wordedDeny = await heldForMessage;
      assert.equal(valueAt(wordedDeny, decisionAt), 'deny');
      assert.equal(valueAt(wordedDeny, reasonAt), 'Run npm run clean instead');
    } finally {
      session.destroy();
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
  });
}

test('an OpenCode permission denied from Chat with a message is rejected with the operator words', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-'));
  const heldReplyText = JSON.stringify(permissionReplyFor('opencode', 'deny', 'Run npm run clean instead'));
  const previousHookUrl = process.env.GLIMMERVOID_HOOK_URL;
  process.env.GLIMMERVOID_HOOK_URL = 'http://127.0.0.1:1/hook/test';
  Reflect.set(globalThis, 'Bun', {
    spawn: (argv: string[]) => ({
      stdin: { write: () => {}, end: () => {} },
      stdout: new Response(argv.at(-1) === CONVERSATION_PERMISSION_HOOK_EVENT ? heldReplyText : '').body,
      exited: Promise.resolve(0),
      kill: () => {},
    }),
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'Bun');
    if (previousHookUrl === undefined) delete process.env.GLIMMERVOID_HOOK_URL;
    if (previousHookUrl !== undefined) process.env.GLIMMERVOID_HOOK_URL = previousHookUrl;
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const pluginFiles = openCodePluginFiles(['relay'], ['tool-relay']);
  assert.ok(pluginFiles);
  const pluginPath = path.join(folder, 'index.mjs');
  fs.writeFileSync(pluginPath, pluginFiles['index.js']);
  const { default: plugin } = await import(pathToFileURL(pluginPath).href);
  const { props } = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIRECTORY, 'opencode-permission-asked.json'), 'utf8'));
  let resolvePermissionReply: (reply: Record<string, unknown>) => void = () => {};
  const permissionReply = new Promise<Record<string, unknown>>((resolve) => {
    resolvePermissionReply = resolve;
  });
  async function* permissionAskedThenIdle({ signal }: { signal: AbortSignal }) {
    yield { type: 'permission.asked', properties: props };
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  }
  const stopPlugin = plugin.setup({
    event: { subscribe: permissionAskedThenIdle },
    session: { get: async () => ({ parentID: null }), hook: () => {} },
    tool: { hook: () => {} },
    permission: { reply: resolvePermissionReply },
  });
  t.after(stopPlugin);
  assert.deepEqual(await permissionReply, { sessionID: props.sessionID, requestID: props.id, decision: 'reject', message: 'Run npm run clean instead' });
});
