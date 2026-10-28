import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFeatureHintsWiring } from '../server/feature-hints-wiring.ts';
import type { AgentLogIngestOptions } from '../server/ingest/ingest-agent-logs.ts';
import type { ShellHistoryOptions } from '../server/ingest/ingest-shell-history.ts';
import type { FeatureHint, HintFeature } from '../shared/contracts/feature-hints.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 9, 1);

type Clock = { nowMs: number };

interface TranscriptAgent {
  runCommand: (command: string) => void;
  submitPrompt: (prompt: string) => void;
}

function transcriptHomes() {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-hints-agents-'));
  const env = {
    CLAUDE_CONFIG_DIR: path.join(homeDirectory, 'claude'),
    CODEX_HOME: path.join(homeDirectory, 'codex'),
    KIMI_CODE_HOME: path.join(homeDirectory, 'kimi'),
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
  };
  return { homeDirectory, env };
}

type TranscriptHomes = ReturnType<typeof transcriptHomes>;

function appendLine(filePath: string, record: Record<string, unknown>): void {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function createTranscript(filePath: string, firstRecord: Record<string, unknown> | null): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, firstRecord ? `${JSON.stringify(firstRecord)}\n` : '', 'utf8');
  return filePath;
}

function slashCommandEnvelope(prompt: string): string {
  const [commandName, ...commandArgs] = prompt.split(' ');
  return `<command-name>${commandName}</command-name>\n<command-args>${commandArgs.join(' ')}</command-args>`;
}

function claudeProjectDir(homes: TranscriptHomes): string {
  return path.join(homes.env.CLAUDE_CONFIG_DIR, 'projects', '-work-repo');
}

function claudeAgent(homes: TranscriptHomes, sessionId: string, clock: Clock): TranscriptAgent {
  return claudeTranscriptAgent(path.join(claudeProjectDir(homes), `${sessionId}.jsonl`), sessionId, clock, false);
}

function claudeSubagent(homes: TranscriptHomes, parentSessionId: string, subagentFolders: readonly string[], clock: Clock): TranscriptAgent {
  const transcript = path.join(claudeProjectDir(homes), parentSessionId, 'subagents', ...subagentFolders, 'agent-a1b2c3.jsonl');
  return claudeTranscriptAgent(transcript, parentSessionId, clock, true);
}

function claudeTranscriptAgent(transcriptPath: string, sessionId: string, clock: Clock, isSidechain: boolean): TranscriptAgent {
  const transcript = createTranscript(transcriptPath, null);
  const line = (type: string, content: unknown) => ({ type, message: { role: type, content }, cwd: '/work/repo', sessionId, isSidechain, timestamp: new Date(clock.nowMs).toISOString() });
  return {
    runCommand: (command) => appendLine(transcript, line('assistant', [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } }])),
    submitPrompt: (prompt) => appendLine(transcript, line('user', prompt.startsWith('/') ? slashCommandEnvelope(prompt) : prompt)),
  };
}

function codexAgent(homes: TranscriptHomes, sessionId: string, clock: Clock) {
  const transcript = createTranscript(
    path.join(homes.env.CODEX_HOME, 'sessions', '2026', '10', '01', `rollout-2026-10-01T08-00-00-${sessionId}.jsonl`),
    { timestamp: new Date(clock.nowMs).toISOString(), type: 'session_meta', payload: { cwd: '/work/repo', session_id: sessionId } },
  );
  const record = (type: string, payload: Record<string, unknown>) => ({ timestamp: new Date(clock.nowMs).toISOString(), type, payload });
  return {
    runCommand: (command: string) => appendLine(transcript, record('response_item', { type: 'custom_tool_call', name: 'exec', input: `await tools.exec_command({cmd:${JSON.stringify(command)}})` })),
    submitPrompt: (prompt: string) => appendLine(transcript, record('event_msg', { type: 'user_message', message: prompt })),
    runFunctionCall: (name: string, toolArguments: Record<string, unknown>) => appendLine(transcript, record('response_item', { type: 'function_call', name, arguments: JSON.stringify(toolArguments) })),
  };
}

function kimiAgent(homes: TranscriptHomes, sessionId: string, clock: Clock): TranscriptAgent {
  const transcript = createTranscript(
    path.join(homes.env.KIMI_CODE_HOME, 'sessions', 'wd_repo_1bd23b510277', `session_${sessionId}`, 'agents', 'main', 'wire.jsonl'),
    { type: 'profile.bind', agentId: 'main', environmentDisclosure: { cwd: '/work/repo' }, time: clock.nowMs },
  );
  const message = (role: string, fields: Record<string, unknown>) => ({ type: 'agent.message.appended', time: clock.nowMs, message: { message: { role, ...fields }, meta: { origin: { kind: role } } } });
  return {
    runCommand: (command) => appendLine(transcript, message('assistant', { content: [], toolCalls: [{ name: 'Bash', arguments: JSON.stringify({ command }) }] })),
    submitPrompt: (prompt) => appendLine(transcript, message('user', { content: [{ type: 'text', text: prompt }] })),
  };
}

const AGENT_BY_VENDOR = { claude: claudeAgent, codex: codexAgent, kimi: kimiAgent };

interface HintSources {
  homes?: TranscriptHomes | null;
  laneMap?: () => Map<string, string>;
  shellHistory?: ShellHistoryOptions | null;
  maxActiveFiles?: number;
}

function agentLogOptionsFor(homes: TranscriptHomes, { laneMap, maxActiveFiles }: HintSources): Omit<AgentLogIngestOptions, 'publish'> {
  return { env: homes.env, homeDir: homes.homeDirectory, logger: null, pollIntervalMs: 20, discoverIntervalMs: 20, laneMap: laneMap ?? null, ...(maxActiveFiles ? { maxActiveFiles } : {}) };
}

function startHints(statePath: string, clock: Clock, sources: HintSources = {}) {
  const { homes = null, shellHistory = null } = sources;
  const broadcastHints: FeatureHint[] = [];
  const featureHints = createFeatureHintsWiring({
    statePath, log: { warn: () => {} }, now: () => clock.nowMs, shellHistory,
    agentLogs: homes ? agentLogOptionsFor(homes, sources) : null,
    broadcast: (message) => { broadcastHints.push(message.hint); },
  });
  test.after(() => featureHints.stop());
  return { featureHints, broadcastHints };
}

function tempStatePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feature-hints-')), 'feature-hints.json');
}

function pause(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function settled(featureHints: { idle: () => Promise<void> }): Promise<void> {
  await pause(250);
  await featureHints.idle();
}

test('Codex reviewing three distinct PRs raises one Reviews hint that a settle silences across a restart', async () => {
  const statePath = tempStatePath();
  const clock = { nowMs: START_MS };
  const homes = transcriptHomes();
  const codex = codexAgent(homes, '01a16ade-273d-7be0-9cea-423da1d1a4bb', clock);
  const firstRun = startHints(statePath, clock, { homes });
  await settled(firstRun.featureHints);

  codex.runCommand('gh pr diff 412 | head -50');
  codex.runCommand('gh pr diff 412');
  codex.runCommand('cd repo && gh pr checkout 418');
  await settled(firstRun.featureHints);
  assert.deepEqual(firstRun.broadcastHints, []);

  codex.runCommand('gh pr view --json title 420');
  await settled(firstRun.featureHints);
  assert.deepEqual(firstRun.broadcastHints, [{ feature: 'teamReview', distinctTargetCount: 3, raisedAt: START_MS }]);
  assert.deepEqual(firstRun.featureHints.pendingHintMessage()?.hint, { feature: 'teamReview', distinctTargetCount: 3, raisedAt: START_MS });

  await firstRun.featureHints.settle('teamReview', 'dismissed');
  await firstRun.featureHints.stop();

  const claude = claudeAgent(homes, 'session-b', clock);
  const restarted = startHints(statePath, clock, { homes });
  await settled(restarted.featureHints);
  for (const prNumber of [501, 502, 503, 504]) claude.runCommand(`gh pr review ${prNumber} --approve`);
  await settled(restarted.featureHints);
  assert.equal(restarted.featureHints.pendingHintMessage(), null);
  assert.deepEqual(restarted.broadcastHints, []);
});

test('a subagent started after its idle parent left the active set still counts', async () => {
  const clock = { nowMs: START_MS };
  const homes = transcriptHomes();
  const operatorAgent = claudeAgent(homes, 'operator-session', clock);
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock, { homes, maxActiveFiles: 2 });
  operatorAgent.submitPrompt('fan the review out to a workflow');
  await settled(featureHints);
  claudeSubagent(homes, 'operator-session', ['workflows', 'wf_1'], clock).runCommand('gh pr view 1');
  claudeSubagent(homes, 'operator-session', ['workflows', 'wf_2'], clock).runCommand('gh pr view 2');
  await settled(featureHints);
  claudeSubagent(homes, 'operator-session', ['workflows', 'wf_3'], clock).runCommand('gh pr view 3');
  await settled(featureHints);
  assert.deepEqual(broadcastHints.map((hint) => hint.feature), ['teamReview']);
});

test('Codex function_call exec_command and shell commands count toward a hint', async () => {
  const clock = { nowMs: START_MS };
  const homes = transcriptHomes();
  const codex = codexAgent(homes, '01a0f1a4-3c5d-4e6f-8a9b-0c1d2e3f4a5b', clock);
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock, { homes });
  await settled(featureHints);
  codex.runFunctionCall('exec_command', { cmd: 'gh pr view 412' });
  codex.runFunctionCall('shell', { command: ['bash', '-lc', 'gh pr view 418'] });
  codex.runFunctionCall('exec_command', { cmd: 'gh pr view 420' });
  await settled(featureHints);
  assert.deepEqual(broadcastHints.map((hint) => hint.feature), ['teamReview']);
});

test('a tab shown within 14 days holds its Kimi-raised hint back until the view ages out', async () => {
  const clock = { nowMs: START_MS };
  const homes = transcriptHomes();
  const kimi = kimiAgent(homes, '766a47d0-9cb9-4af9-8f5e-1eaf9374b85e', clock);
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock, { homes });
  await settled(featureHints);

  await featureHints.noteViewShown('issues');
  for (const issueNumber of [7, 8, 9]) kimi.runCommand(`gh issue view ${issueNumber}`);
  await settled(featureHints);
  assert.deepEqual(broadcastHints, []);

  clock.nowMs += 15 * DAY_MS;
  kimi.runCommand('gh issue comment 10 --body done');
  kimi.runCommand('gh issue view 11');
  kimi.runCommand('gh issue view 12');
  await settled(featureHints);
  assert.deepEqual(broadcastHints, [{ feature: 'issues', distinctTargetCount: 3, raisedAt: START_MS + 15 * DAY_MS }]);
});

test('opening the hinted tab settles its hint so the next feature can surface', async () => {
  const clock = { nowMs: START_MS };
  const homes = transcriptHomes();
  const claude = claudeAgent(homes, 'session-a', clock);
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock, { homes });
  await settled(featureHints);
  for (const prNumber of [1, 2, 3]) claude.runCommand(`gh pr view ${prNumber}`);
  await settled(featureHints);
  await featureHints.noteViewShown('prs');
  assert.equal(featureHints.pendingHintMessage(), null);

  for (const issueNumber of [1, 2, 3]) claude.runCommand(`gh issue view ${issueNumber}`);
  await settled(featureHints);
  assert.deepEqual(broadcastHints.map((hint) => hint.feature), ['teamReview', 'issues']);
});

test('subagents of an operator session count, and a lane session and its subagents never do', async () => {
  const clock = { nowMs: START_MS };
  const homes = transcriptHomes();
  const operatorAgent = claudeAgent(homes, 'operator-session', clock);
  const laneAgent = claudeAgent(homes, 'lane-session', clock);
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock, {
    homes, laneMap: () => new Map([['claude:lane-session', 'team-review']]),
  });
  operatorAgent.submitPrompt('split the review across subagents');
  await settled(featureHints);
  const laneSubagent = claudeSubagent(homes, 'lane-session', [], clock);
  const operatorSubagent = claudeSubagent(homes, 'operator-session', [], clock);
  const operatorWorkflowSubagent = claudeSubagent(homes, 'operator-session', ['workflows', 'wf_1'], clock);
  for (const prNumber of [1, 2, 3]) {
    laneAgent.runCommand(`gh pr view ${prNumber}`);
    laneSubagent.runCommand(`gh pr view ${prNumber + 10}`);
  }
  await settled(featureHints);
  assert.equal(broadcastHints.length, 0);

  operatorSubagent.runCommand('gh pr view 21');
  operatorSubagent.runCommand('gh pr view 22');
  operatorWorkflowSubagent.runCommand('gh pr view 23');
  await settled(featureHints);
  assert.deepEqual(broadcastHints.map((hint) => hint.feature), ['teamReview']);
});

const PROMPT_TRIGGERS: readonly { feature: HintFeature; vendor: keyof typeof AGENT_BY_VENDOR; prompts: readonly string[] }[] = [
  { feature: 'teamReview', vendor: 'codex', prompts: ['review PR 12 please', '/code-review 13', 'look at https://github.com/acme/app/pull/14'] },
  { feature: 'issues', vendor: 'kimi', prompts: ['fix issue #3', 'see https://github.com/acme/app/issues/4', 'then issue #5'] },
  { feature: 'usage', vendor: 'claude', prompts: ['/cost', 'am I near the rate limit?'] },
  { feature: 'posthog', vendor: 'codex', prompts: ["what's broken in prod today?", 'check error tracking for spikes'] },
  { feature: 'visions', vendor: 'kimi', prompts: ['the thing in my editor is wrong', 'this file is off at src/app.ts:42', 'also in my editor, line 9'] },
  { feature: 'benchmarks', vendor: 'claude', prompts: ['benchmark these two prompts', 'compare claude and codex on this refactor'] },
];

for (const { feature, vendor, prompts } of PROMPT_TRIGGERS) {
  test(`${vendor} prompts alone trip the ${feature} hint`, async () => {
    const clock = { nowMs: START_MS };
    const homes = transcriptHomes();
    const agent = AGENT_BY_VENDOR[vendor](homes, '5d0c2a4e-1f7b-4c33-9a61-0b8e2f4d6c11', clock);
    const { featureHints, broadcastHints } = startHints(tempStatePath(), clock, { homes });
    await settled(featureHints);
    for (const prompt of prompts) agent.submitPrompt(prompt);
    await settled(featureHints);
    assert.deepEqual(broadcastHints.map((hint) => hint.feature), [feature]);
  });
}

test('one first prompt sent to two Claude sessions started after Glimmervoid counts toward Bench', async () => {
  const clock = { nowMs: START_MS };
  const homes = transcriptHomes();
  const { featureHints, broadcastHints } = startHints(tempStatePath(), clock, { homes });
  await settled(featureHints);
  const firstAgent = claudeAgent(homes, 'session-a', clock);
  const secondAgent = claudeAgent(homes, 'session-b', clock);
  for (const prompt of ['Refactor the parser into two modules', 'Add retries to the uploader client']) {
    firstAgent.submitPrompt(prompt);
    clock.nowMs += 1000;
    secondAgent.submitPrompt(prompt);
  }
  await settled(featureHints);
  assert.deepEqual(broadcastHints.map((hint) => hint.feature), ['benchmarks']);
});

async function waitForHints(broadcastHints: readonly FeatureHint[], deadlineMs: number): Promise<void> {
  const startedAt = Date.now();
  while (broadcastHints.length === 0 && Date.now() - startedAt < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('operator shell commands trip a hint with the ingest lane off, and a stopped reader never rewrites state after restart', async () => {
  const historyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-hints-history-'));
  const historyFile = path.join(historyDirectory, '.bash_history');
  fs.writeFileSync(historyFile, 'gh issue view 1\ngh issue view 2\ngh issue view 3\n');
  const statePath = tempStatePath();
  const clock = { nowMs: Date.now() };
  const { featureHints, broadcastHints } = startHints(statePath, clock, {
    shellHistory: {
      env: { HISTFILE: historyFile }, homeDir: historyDirectory, platform: 'linux',
      sourceConfig: { shells: ['bash'], pollMs: 20 }, logger: null,
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(broadcastHints.length, 0);

    fs.appendFileSync(historyFile, 'gh pr view 7\ngh pr diff 8\ngh pr checkout 9\n');
    await waitForHints(broadcastHints, 3000);
    await featureHints.idle();
    assert.deepEqual(broadcastHints.map((hint) => hint.feature), ['teamReview']);
  } finally {
    await featureHints.stop();
  }

  const restarted = startHints(statePath, clock);
  await restarted.featureHints.settle('teamReview', 'dismissed');
  fs.appendFileSync(historyFile, 'gh issue view 4\n');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await restarted.featureHints.idle();
  const afterSecondRestart = startHints(statePath, clock).featureHints;
  await afterSecondRestart.idle();
  assert.equal(afterSecondRestart.pendingHintMessage(), null);
});
