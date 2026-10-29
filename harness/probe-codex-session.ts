
import './support/disable-telemetry.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend/backend.ts';
import { spawn } from '../server/child-process-safe.ts';
import type { HookPayload } from '../shared/contracts/index.ts';
import type { Session } from '../session/sessions.ts';
import { createProbeChecks, delay, sanitizeProbeText, waitForState, writeHookFixture } from './support/backend-harness.ts';
import type { ProbeFixtureTarget, ProbeHookRecord } from './support/backend-harness.ts';

interface SpawnCall {
  file: string;
  args: string[];
  cwd: string | undefined;
}

const SESSION_ID = 'codex-probe-session';
const SENTINEL_WORD = 'velvetquartz';
const PROMPT = `reply with the single word ${SENTINEL_WORD} and nothing else`;
const STEP_TIMEOUT_MS = 120000;
const SUBAGENT_TIMEOUT_MS = 240000;
const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'tests', 'fixtures');
const SHOULD_WRITE_FIXTURES = process.argv.includes('--write-fixtures');
const BRIDGE_NOTIFICATIONS_KEPT = new Set(['thread/started', 'turn/started', 'turn/completed', 'turn/plan/updated', 'item/started', 'item/completed', 'serverRequest/resolved', 'thread/compacted']);

interface BridgeLine {
  direction: 'client' | 'server';
  message: unknown;
}

let terminalTail = '';
const { check, passed, failed } = createProbeChecks();

function makeProbeCodexHome(tmpDir: string, projectDir: string): string {
  const codexHome = path.join(tmpDir, 'codex-home');
  fs.mkdirSync(codexHome);
  const realAuth = path.join(os.homedir(), '.codex', 'auth.json');
  if (fs.existsSync(realAuth)) {
    try {
      fs.symlinkSync(realAuth, path.join(codexHome, 'auth.json'));
    } catch (err) {
      console.warn(`  NOTE  could not link ~/.codex/auth.json (${messageOf(err)}); codex may ask you to log in`);
    }
  }
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    `[projects.${JSON.stringify(projectDir)}]\ntrust_level = "trusted"\n`,
    'utf8',
  );
  return codexHome;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function writeProbeConfig(configPath: string, projectDir: string): void {
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{
      id: SESSION_ID,
      name: 'codex probe',
      path: projectDir,
      agent: 'codex',
      dangerouslySkipPermissions: false,
      codexBypassHookTrust: true,
    }],
    teams: [],
    repoRoots: [],
    autoResume: false,
    worktreeAutoRebase: false,
    capture: { enabled: true },
  }, null, 2), 'utf8');
}

function answerFrom(payload: HookPayload | undefined): string | null {
  const answer = payload?.last_assistant_message;
  return typeof answer === 'string' ? answer.trim() : null;
}

function fixtureDestination(fileName: string, keepDir: string): string {
  return path.join(SHOULD_WRITE_FIXTURES ? FIXTURE_DIR : keepDir, fileName);
}

function payloadField(hook: ProbeHookRecord | null, field: string): unknown {
  return hook?.payload ? hook.payload[field] : undefined;
}

function isSentinelEchoHook(hook: ProbeHookRecord): boolean {
  if (hook.event.toLowerCase() !== 'posttooluse') return false;
  if (payloadField(hook, 'tool_name') !== 'Bash') return false;
  const toolInput = payloadField(hook, 'tool_input');
  if (typeof toolInput !== 'object' || toolInput === null || !('command' in toolInput)) return false;
  return typeof toolInput.command === 'string' && toolInput.command.includes(SENTINEL_WORD);
}

function copySanitizedRecording(tmpDir: string, fixtureTarget: ProbeFixtureTarget): string | null {
  const recordingDir = path.join(tmpDir, 'recordings');
  if (!fs.existsSync(recordingDir)) return null;
  const recorded = fs.readdirSync(recordingDir);
  if (recorded.length === 0) return null;
  const source = path.join(recordingDir, recorded[0]);
  const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-codex-probe-out-'));
  const keptRecording = path.join(keepDir, recorded[0]);
  const sanitized = sanitizeProbeText(fs.readFileSync(source, 'utf8'), fixtureTarget);
  fs.writeFileSync(keptRecording, sanitized, { encoding: 'utf8', mode: 0o600 });
  return keptRecording;
}

function captureBridgeInPlanMode(projectDir: string): Promise<BridgeLine[]> {
  const transcript: BridgeLine[] = [];
  const child = spawn('codex', ['app-server'], { cwd: projectDir, env: { ...process.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let nextRequestId = 1;
  const pendingById = new Map<number, (result: unknown) => void>();
  let buffered = '';
  let threadId = '';
  let hasFinished = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('timed out waiting for the plan-mode turn to complete')), STEP_TIMEOUT_MS * 2);
    function finish(error: Error | null): void {
      if (hasFinished) return;
      hasFinished = true;
      clearTimeout(timer);
      child.kill();
      if (error) {
        reject(error);
        return;
      }
      resolve(transcript);
    }
    function send(message: Record<string, unknown>): void {
      transcript.push({ direction: 'client', message });
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    }
    function request(method: string, params: unknown): Promise<unknown> {
      const id = nextRequestId++;
      send({ jsonrpc: '2.0', id, method, params });
      return new Promise((resolveRequest) => { pendingById.set(id, resolveRequest); });
    }
    function answerServerRequest(id: unknown, method: string, params: Record<string, unknown>): void {
      if (method === 'item/tool/requestUserInput') {
        const questions = Array.isArray(params.questions) ? params.questions : [];
        const answers: Record<string, { answers: string[] }> = {};
        for (const question of questions) {
          const options = Array.isArray(question?.options) ? question.options : [];
          answers[String(question?.id)] = { answers: [String(options[0]?.label ?? 'short')] };
        }
        send({ jsonrpc: '2.0', id, result: { answers } });
        return;
      }
      send({ jsonrpc: '2.0', id, result: { decision: 'decline' } });
    }
    function handleLine(line: string): void {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      const method = typeof message.method === 'string' ? message.method : null;
      const isResponse = method === null && typeof message.id === 'number';
      if (isResponse) {
        transcript.push({ direction: 'server', message: { id: message.id, hasResult: 'result' in message, error: message.error ?? null } });
        pendingById.get(message.id)?.(message.result ?? null);
        pendingById.delete(message.id);
        return;
      }
      const isServerRequest = method !== null && message.id !== undefined;
      if (isServerRequest || (method !== null && BRIDGE_NOTIFICATIONS_KEPT.has(method))) transcript.push({ direction: 'server', message });
      if (isServerRequest) answerServerRequest(message.id, method, message.params ?? {});
      if (method === 'turn/completed' && message.params?.threadId === threadId) finish(null);
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        try { handleLine(line); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    child.on('error', (error: Error) => finish(error));
    child.on('exit', () => finish(new Error('codex app-server exited before the plan-mode turn completed')));
    void (async () => {
      await request('initialize', { clientInfo: { name: 'glimmervoid-probe', title: null, version: '0.1.0' }, capabilities: { experimentalApi: true } });
      send({ jsonrpc: '2.0', method: 'initialized' });
      const started = await request('thread/start', { cwd: projectDir, approvalPolicy: 'never', sandbox: 'read-only' }) as { thread?: { id?: string }; model?: string } | null;
      threadId = String(started?.thread?.id ?? '');
      await request('turn/start', {
        threadId,
        input: [{ type: 'text', text: `Plan how to add a README.md to this empty project. Before planning, call request_user_input exactly once to ask whether the README should be short or long, with the options short and long. Then present the plan.` }],
        collaborationMode: { mode: 'plan', settings: { model: String(started?.model ?? ''), developer_instructions: null } },
      });
    })().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-codex-probe-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const configPath = path.join(tmpDir, 'config.json');
  writeProbeConfig(configPath, projectDir);
  process.env.GLIMMERVOID_CONFIG = configPath;
  process.env.CODEX_HOME = makeProbeCodexHome(tmpDir, projectDir);

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });

  const session: Session | null = backend.getSession(SESSION_ID);
  if (!session) throw new Error(`the probe config did not produce a session named ${SESSION_ID}`);
  const hookEvents: string[] = [];
  const hookRecords: ProbeHookRecord[] = [];
  const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-codex-probe-out-'));
  const fixtureTarget: ProbeFixtureTarget = { agentId: 'codex', tempDirectory: tmpDir, keepDirectory: keepDir, shouldWriteFixtures: SHOULD_WRITE_FIXTURES };
  const answers: string[] = [];
  const titleSignals: string[] = [];
  const spawnCalls: SpawnCall[] = [];
  const spawnPty = session._ptySpawn;
  session._ptySpawn = (file, args, options) => {
    spawnCalls.push({ file, args: [...args], cwd: options.cwd });
    const spawned = spawnPty(file, args, options);
    spawned.onData((chunk) => { terminalTail = (terminalTail + chunk).slice(-6000); });
    return spawned;
  };
  session.on('state-change', ({ from, to, event }) => console.log(`  [state] ${from} -> ${to} (${event})`));

  const originalIngest = session.ingestHookSignal.bind(session);
  session.ingestHookSignal = (raw) => {
    if (raw?.event) hookEvents.push(raw.event);
    const answer = answerFrom(raw?.payload);
    if (answer) answers.push(answer);
    return originalIngest(raw);
  };
  session.on('hook-event', ({ event, payload }: { event: string; payload: HookPayload | null }) => {
    hookRecords.push({ event, payload: payload ?? null });
  });
  session._titleSource.on('signal', (s: { signal: string }) => titleSignals.push(s.signal));

  try {
    console.log('\nSpawn:');
    await session.start();
    check('the spawn used the codex adapter', session.agentId === 'codex');
    check('hook injection produced a per-session token', typeof session._hooks.token() === 'string');
    await waitForState(session, ['RUNNING', 'IDLE'], 'first output');
    check('the session reached a live state after spawn', session.state !== 'DORMANT');

    console.log('\nFirst turn:');
    await delay(6000);
    const firstTurnStart = hookRecords.length;
    session.write(PROMPT);
    await delay(1500);
    session.write('\r');
    await waitForState(session, ['COMPLETE'], 'the turn to finish');
    await delay(3000);
    writeScenario('turn-complete', firstTurnStart);
    check('the first turn answered with the sentinel', answers.at(-1)?.toLowerCase() === SENTINEL_WORD);
    console.log(`  [answer:first] ${answers.at(-1) || '(none)'}`);

    const runTurn = async (prompt: string, label: string): Promise<void> => {
      session.write(prompt);
      await delay(1500);
      session.write('\r');
      await waitForState(session, ['RUNNING', 'WAITING'], `${label} to start`);
      while ((await waitForState(session, ['COMPLETE', 'WAITING'], `${label} to finish`)) === 'WAITING') {
        console.log(`  [approve] ${label}`);
        await delay(1500);
        session.write('y');
        await waitForState(session, ['RUNNING', 'COMPLETE'], `${label} to resume after approval`);
      }
    };

    async function waitForHook(label: string, since: number, matches: (hook: ProbeHookRecord) => boolean, timeoutMs = STEP_TIMEOUT_MS): Promise<ProbeHookRecord | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = hookRecords.slice(since).find(matches);
        if (found) return found;
        await delay(500);
      }
      console.error(`  [timeout] ${label}`);
      return null;
    }

    function writeScenario(name: string, since: number): void {
      const destination = writeHookFixture(name, hookRecords.slice(since), fixtureTarget);
      console.log(`  [fixture] ${destination}`);
      console.log(`  [events] ${hookRecords.slice(since).map((hook) => hook.event).join(', ')}`);
    }

    console.log('\nBash turn:');
    const bashStart = hookRecords.length;
    await runTurn(`run the shell command \`echo ${SENTINEL_WORD}\` and reply with its output and nothing else`, 'the bash turn');
    const bashHook = await waitForHook('PostToolUse Bash', bashStart, isSentinelEchoHook);
    check('a PostToolUse hook fired for the shell command', !!bashHook);
    check('the PostToolUse payload names the Bash tool', payloadField(bashHook, 'tool_name') === 'Bash');
    writeScenario('posttooluse-bash', bashStart);

    console.log('\nSubagent turn:');
    const subagentStart = hookRecords.length;
    await runTurn(`spawn exactly one subagent with spawn_agent whose task is to reply with the single word ${SENTINEL_WORD}; wait for it to finish, then reply with the single word ${SENTINEL_WORD}`, 'the subagent turn');
    const subagentStarted = await waitForHook('SubagentStart', subagentStart, (hook) => hook.event.toLowerCase() === 'subagentstart', SUBAGENT_TIMEOUT_MS);
    const subagentStopped = await waitForHook('SubagentStop', subagentStart, (hook) => hook.event.toLowerCase() === 'subagentstop', SUBAGENT_TIMEOUT_MS);
    check('a SubagentStart hook fired', !!subagentStarted);
    check('a SubagentStop hook fired', !!subagentStopped);
    check('the subagent hooks share an agent_id', payloadField(subagentStarted, 'agent_id') !== undefined && payloadField(subagentStarted, 'agent_id') === payloadField(subagentStopped, 'agent_id'));
    await delay(3000);
    writeScenario('subagent', subagentStart);

    console.log('\nCompaction:');
    const compactionStart = hookRecords.length;
    session.write('/compact');
    await delay(1500);
    session.write('\r');
    const preCompact = await waitForHook('PreCompact', compactionStart, (hook) => hook.event.toLowerCase() === 'precompact');
    const postCompact = await waitForHook('PostCompact', compactionStart, (hook) => hook.event.toLowerCase() === 'postcompact');
    check('a PreCompact hook fired', !!preCompact);
    check('a PostCompact hook fired', !!postCompact);
    await delay(3000);
    writeScenario('compaction', compactionStart);

    console.log('\nPlan mode request_user_input:');
    const questionStart = hookRecords.length;
    session.write('/plan');
    await delay(1500);
    session.write('\r');
    await delay(2000);
    session.write('Call request_user_input exactly once to ask whether a README should be short or long, with the options short and long. Then reply with only the chosen option and do not present a plan.');
    await delay(1500);
    session.write('\r');
    const questionHook = await waitForHook('PreToolUse request_user_input', questionStart, (hook) => hook.event.toLowerCase() === 'pretooluse');
    check('a PreToolUse hook fired for request_user_input', payloadField(questionHook, 'tool_name') === 'request_user_input');
    await delay(3000);
    session.write('\r');
    const questionStop = await waitForHook('the plan turn Stop', questionStart, (hook) => hook.event.toLowerCase() === 'stop');
    check('the plan-mode turn reached Stop after the answer', !!questionStop);
    writeScenario('request-user-input', questionStart);
    session.write('\x1b');
    await delay(1000);

    console.log('\nPlan approval:');
    const planStart = hookRecords.length;
    session.write('Present a one-step plan to create plan.txt containing ok.');
    await delay(1500);
    session.write('\r');
    const planStop = await waitForHook('the plan Stop', planStart, (hook) => hook.event.toLowerCase() === 'stop');
    check('the plan turn reached Stop', !!planStop);
    await delay(3000);
    check('the proposed plan put the card in WAITING', session.state === 'WAITING');
    session.write('\r');
    const implementationStop = await waitForHook('the implementation Stop', planStart, (hook) => {
      if (session.state === 'WAITING' && hook.event.toLowerCase() === 'permissionrequest') session.write('y');
      return hook !== planStop && hook.event.toLowerCase() === 'stop';
    });
    check('approving the plan ran the implementation turn to Stop', !!implementationStop);
    check('the implementation turn was the plan-mode approval', hookRecords.slice(planStart).some((hook) => payloadField(hook, 'prompt') === 'Implement the plan.'));
    await delay(3000);
    writeScenario('plan-wait', planStart);

    console.log('\nClear:');
    const clearStart = hookRecords.length;
    session.write(PROMPT);
    await delay(1500);
    session.write('\r');
    await waitForState(session, ['RUNNING', 'WAITING'], 'the turn before /clear to start');
    await waitForState(session, ['COMPLETE'], 'the turn before /clear');
    await delay(3000);
    session.write('/clear');
    await delay(1500);
    session.write('\r');
    await delay(3000);
    session.write(PROMPT);
    await delay(1500);
    session.write('\r');
    await waitForState(session, ['RUNNING', 'WAITING'], 'the first turn after /clear to start');
    await waitForState(session, ['COMPLETE'], 'the first turn after /clear');
    const clearedStart = await waitForHook('SessionStart after /clear', clearStart, (hook) => hook.event.toLowerCase() === 'sessionstart');
    check('the first turn after /clear fired SessionStart', !!clearedStart);
    console.log(`  [clear] SessionStart source: ${JSON.stringify(payloadField(clearedStart, 'source') ?? null)}`);
    await delay(3000);
    writeScenario('session-clear', clearStart);

    const capturedId = session._resumeSessionId;
    check('a codex session id was captured from the hook payloads', typeof capturedId === 'string' && capturedId.length > 0);

    console.log('\nResume:');
    session.kill();
    await waitForState(session, ['DONE', 'FAILED'], 'the killed PTY to be reaped');
    hookEvents.length = 0;
    check('restart re-spawned the session', session.restart());
    await waitForState(session, ['RUNNING', 'IDLE'], 'the resumed session');
    await delay(6000);
    session.write(PROMPT);
    await delay(1500);
    session.write('\r');
    await waitForState(session, ['COMPLETE'], 'the resumed turn to finish');
    check('the resumed turn answered with the sentinel', answers.at(-1)?.toLowerCase() === SENTINEL_WORD);
    check('the resume kept the same codex session id', session._resumeSessionId === capturedId);
    console.log(`  [answer:resume] ${answers.at(-1) || '(none)'}`);
    console.log(`  [ids]  captured=${capturedId} after-resume=${session._resumeSessionId}`);
    for (const [index, call] of spawnCalls.entries()) {
      console.log(`  [argv:${index + 1}] ${JSON.stringify([call.file, ...call.args])}`);
    }
    check('the session spawned twice', spawnCalls.length === 2);
    check('the second spawn used codex resume', !!capturedId && !!spawnCalls[1]?.args.includes('resume') && spawnCalls[1].args.includes(capturedId));

    console.log('\nPlan-mode bridge:');
    const bridgeLines = await captureBridgeInPlanMode(projectDir);
    const bridgeFixture = fixtureDestination('v2-codex-plan-mode-bridge.jsonl', keepDir);
    fs.writeFileSync(bridgeFixture, `${sanitizeProbeText(bridgeLines.map((line) => JSON.stringify(line)).join('\n'), fixtureTarget)}\n`, 'utf8');
    const completedItemTypes = bridgeLines.flatMap((line) => {
      const message = line.message as { method?: string; params?: { item?: { type?: string } } };
      return line.direction === 'server' && message.method === 'item/completed' ? [String(message.params?.item?.type)] : [];
    });
    const serverRequestMethods = bridgeLines.flatMap((line) => {
      const message = line.message as { method?: string; id?: unknown };
      return line.direction === 'server' && message.method && message.id !== undefined ? [message.method] : [];
    });
    console.log(`  [fixture] ${bridgeFixture}`);
    console.log(`  [items] ${completedItemTypes.join(', ')}`);
    console.log(`  [server requests] ${serverRequestMethods.join(', ') || '(none)'}`);
    check('the plan-mode turn completed a plan item', completedItemTypes.includes('plan'));

    const keptRecording = copySanitizedRecording(tmpDir, fixtureTarget) || '(none written)';
    console.log(`\nRecording: ${keptRecording}`);
    console.log(`Hook events seen: ${[...new Set(hookEvents)].join(', ') || '(none)'}`);
    console.log(`Title signals seen: ${[...new Set(titleSignals)].join(', ') || '(none)'}`);
  } finally {
    try { session.kill(); } catch {  }
    await delay(1500);
    backend.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed()} passed, ${failed()} failed`);
  process.exit(failed() === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  console.error(`\nLast terminal output:\n${terminalTail.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')}`);
  process.exit(1);
});
