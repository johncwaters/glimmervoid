import './support/disable-telemetry.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend/backend.ts';
import type { Session } from '../session/sessions.ts';
import type { HookPayload } from '../shared/contracts/index.ts';
import {
  createProbeChecks, delay, HINT_PROBE_PROMPT, hookEventsOf, queueWhiteboardEditFor, screenShowsShowHint, screenShowsWhiteboardAnswer,
  SHOULD_RUN_ONLY_HINT_PROBE, SHOULD_RUN_ONLY_WHITEBOARD_PROBE, waitForState,
  whiteboardWriterIdFor, whiteboardWriterProject, WHITEBOARD_PROBE_PROMPT, writeHookFixture,
} from './support/backend-harness.ts';
import type { ProbeFixtureTarget, ProbeHookRecord } from './support/backend-harness.ts';

const SESSION_ID = 'claude-probe-session';
const BOOT_SETTLE_MS = 10000;
const SHOULD_WRITE_FIXTURES = process.argv.includes('--write-fixtures');

const { check, passed, failed } = createProbeChecks();

function writeProbeConfig(configPath: string, projectDirectory: string): void {
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{
      id: SESSION_ID,
      name: 'claude probe',
      path: projectDirectory,
      agent: 'claude-code',
      dangerouslySkipPermissions: false,
    }, whiteboardWriterProject(SESSION_ID, projectDirectory, 'claude-code')],
    teams: [],
    repoRoots: [],
    autoResume: false,
    worktreeAutoRebase: false,
    planReview: { enabled: false },
    capture: { enabled: true },
  }, null, 2), 'utf8');
}

async function runProbe(tempDirectory: string): Promise<void> {
  const projectDirectory = path.join(tempDirectory, 'project');
  fs.mkdirSync(projectDirectory);
  const configPath = path.join(tempDirectory, 'config.json');
  writeProbeConfig(configPath, projectDirectory);
  process.env.GLIMMERVOID_CONFIG = configPath;
  process.env.GLIMMERVOID_HOME = path.join(tempDirectory, 'glimmervoid-home');

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const registeredSession: Session | null = backend.getSession(SESSION_ID);
  if (!registeredSession) throw new Error(`the probe config did not produce a session named ${SESSION_ID}`);
  const session: Session = registeredSession;
  const fixtureTarget: ProbeFixtureTarget = {
    agentId: 'claude-code',
    tempDirectory,
    keepDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-claude-probe-out-')),
    shouldWriteFixtures: SHOULD_WRITE_FIXTURES,
  };
  const hookRecords: ProbeHookRecord[] = [];
  const completions: number[] = [];
  session.on('state-change', ({ from, to, event }: { from: string; to: string; event: string }) => {
    console.log(`  [state] ${from} -> ${to} (${event})`);
    if (to === 'COMPLETE') completions.push(hookRecords.length);
  });
  session.on('hook-event', ({ event, payload }: { event: string; payload: HookPayload | null }) => {
    hookRecords.push({ event, payload: payload ?? null });
  });

  async function submit(prompt: string): Promise<void> {
    session.write(`\x1b[200~${prompt}\x1b[201~`);
    await delay(1200);
    session.write('\r');
  }

  async function typeCommand(command: string): Promise<void> {
    session.write(command);
    await delay(1200);
    session.write('\r');
  }

  async function pressEnter(): Promise<void> {
    await delay(1500);
    session.write('\r');
  }

  async function pickFirstOptionAndSubmit(): Promise<void> {
    await pressEnter();
    await pressEnter();
  }

  function captureSince(name: string, scenarioStart: number): ProbeHookRecord[] {
    const scenarioHooks = hookRecords.slice(scenarioStart);
    console.log(`  [fixture] ${writeHookFixture(name, scenarioHooks, fixtureTarget)}`);
    console.log(`  [events] ${hookEventsOf(scenarioHooks).join(', ')}`);
    return scenarioHooks;
  }

  async function runScenario(name: string, start: () => Promise<void>, answerWaiting: () => Promise<void>, settleMs = 3000): Promise<ProbeHookRecord[]> {
    console.log(`\n${name}:`);
    const scenarioStart = hookRecords.length;
    await start();
    await waitForState(session, ['RUNNING', 'WAITING'], `${name} to start`);
    while ((await waitForState(session, ['COMPLETE', 'WAITING'], `${name} to finish`)) === 'WAITING') {
      console.log(`  [answer] ${name}`);
      await answerWaiting();
      await waitForState(session, ['RUNNING', 'COMPLETE'], `${name} to resume`);
    }
    await delay(settleMs);
    return captureSince(name, scenarioStart);
  }

  try {
    session._extraClaudeArgs = ['--setting-sources', 'project,local', '--permission-mode', 'default'];
    await session.start();
    if (session.state === 'FAILED') throw new Error('the claude session failed to spawn');
    check('the spawn used the claude-code adapter', session.agentId === 'claude-code');
    await delay(BOOT_SETTLE_MS);
    session.write('\x1b[B');
    await delay(500);
    session.write('\r');
    await delay(3000);

    if (SHOULD_RUN_ONLY_HINT_PROBE) {
      const hintOutputOffset = session.getOutputOffset();
      const hintHooks = await runScenario('command-hint', () => submit(HINT_PROBE_PROMPT), pressEnter);
      check('the Bash PostToolUse reached the hooks', hookEventsOf(hintHooks).includes('posttooluse'));
      check('the show hint reached the model with the tool result', screenShowsShowHint(session.getBufferSince(hintOutputOffset).data));
      return;
    }

    const writer = backend.getSession(whiteboardWriterIdFor(SESSION_ID));
    if (!writer) throw new Error('the probe config did not produce the board writer session');
    await queueWhiteboardEditFor(baseUrl, session, writer);
    const whiteboardOutputOffset = session.getOutputOffset();
    const whiteboardHooks = await runScenario('whiteboard-prompt-context', () => submit(WHITEBOARD_PROBE_PROMPT), pressEnter);
    check('UserPromptSubmit reached the hooks', hookEventsOf(whiteboardHooks).includes('userpromptsubmit'));
    check('the queued board edit reached the model with the prompt', screenShowsWhiteboardAnswer(session.getBufferSince(whiteboardOutputOffset).data));
    if (SHOULD_RUN_ONLY_WHITEBOARD_PROBE) return;

    const turnHooks = await runScenario('turn-complete', () => submit('Reply with the single word copperheron and nothing else.'), pressEnter);
    check('a plain turn ended on Stop', hookEventsOf(turnHooks).includes('stop'));

    const permissionHooks = await runScenario('permission-wait', () => submit('Run the shell command: touch ./claude-probe-approval.txt'), pressEnter);
    check('the turn asked for permission before its Stop', hookEventsOf(permissionHooks).includes('permissionrequest'));

    const enterPlanModeByCyclingPermissionMode = async () => {
      session.write('\x1b[Z');
      await delay(800);
      session.write('\x1b[Z');
      await delay(800);
      await submit('Present a one-line plan to create plan.txt containing ok with the ExitPlanMode tool, then carry it out.');
    };
    const planHooks = await runScenario('plan-wait', enterPlanModeByCyclingPermissionMode, pressEnter);
    check('ExitPlanMode reached the hooks', planHooks.some((hook) => hook.payload?.tool_name === 'ExitPlanMode'));

    const questionHooks = await runScenario('structured-question-answered', () => submit('Use the AskUserQuestion tool to ask me whether I prefer red or blue, then reply with only my answer.'), pickFirstOptionAndSubmit);
    check('AskUserQuestion reached the hooks', questionHooks.some((hook) => hook.payload?.tool_name === 'AskUserQuestion'));

    const completionsBeforeSubagent = completions.length;
    const subagentHooks = await runScenario('subagent-gates-completion', () => submit('Use the Agent tool to start one subagent that runs ls in the current directory and reports the file names. Wait for it, then reply with the single word done.'), pressEnter, 15000);
    check('a SubagentStop fired', hookEventsOf(subagentHooks).includes('subagentstop'));
    check('the subagent turn completed the card exactly once', completions.length - completionsBeforeSubagent === 1);

    const compactionHooks = await runScenario('idle-compaction', () => typeCommand('/compact'), pressEnter, 5000);
    check('PreCompact fired', hookEventsOf(compactionHooks).includes('precompact'));

    console.log('\nsession-clear:');
    const clearStart = hookRecords.length;
    await submit('Reply with the single word copperheron and nothing else.');
    await waitForState(session, ['RUNNING', 'WAITING'], 'the turn before /clear to start');
    await waitForState(session, ['COMPLETE'], 'the turn before /clear');
    await delay(3000);
    await typeCommand('/clear');
    await delay(5000);
    await submit('Reply with the single word copperheron and nothing else.');
    await waitForState(session, ['RUNNING', 'WAITING'], 'the first turn after /clear to start');
    await waitForState(session, ['COMPLETE'], 'the first turn after /clear');
    await delay(3000);
    const clearHooks = captureSince('session-clear', clearStart);
    check('SessionStart fired with source clear', clearHooks.some((hook) => hook.event.toLowerCase() === 'sessionstart' && hook.payload?.source === 'clear'));
  } finally {
    session.kill();
    await delay(1500);
    backend.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
}

async function main(): Promise<void> {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-claude-probe-'));
  try {
    await runProbe(tempDirectory);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
  console.log(`\n${passed()} passed, ${failed()} failed`);
  process.exit(failed() === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
