
import './support/disable-telemetry.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend/backend.ts';
import { spawn } from '../server/child-process-safe.ts';
import type { HookPayload } from '../shared/contracts/index.ts';
import { projectHookPayload } from '../session/core/hook-payload-projection.ts';
import type { Session } from '../session/sessions.ts';

interface SpawnCall {
  file: string;
  args: string[];
  cwd: string | undefined;
}

const SESSION_ID = 'codex-probe-session';
const SENTINEL_WORD = 'velvetquartz';
const PROMPT = `reply with the single word ${SENTINEL_WORD} and nothing else`;
const STEP_TIMEOUT_MS = 90000;
const SUBAGENT_TIMEOUT_MS = 240000;
const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'tests', 'fixtures');
const SHOULD_WRITE_FIXTURES = process.argv.includes('--write-fixtures');
const BRIDGE_NOTIFICATIONS_KEPT = new Set(['thread/started', 'turn/started', 'turn/completed', 'turn/plan/updated', 'item/started', 'item/completed', 'serverRequest/resolved', 'thread/compacted']);

interface HookRecord {
  event: string;
  payload: HookPayload | null;
}

interface BridgeLine {
  direction: 'client' | 'server';
  message: unknown;
}

let terminalTail = '';
let passed = 0;
let failed = 0;
function check(label: string, condition: boolean): void {
  if (condition) { console.log(`  PASS  ${label}`); passed += 1; return; }
  console.error(`  FAIL  ${label}`);
  failed += 1;
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function waitForState(session: Session, states: string[], label: string): Promise<string> {
  const wanted = new Set(states);
  if (wanted.has(session.state)) return Promise.resolve(session.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off('state-change', onChange);
      reject(new Error(`timed out waiting for ${label} (still ${session.state})`));
    }, STEP_TIMEOUT_MS);
    function onChange({ to }: { to: string }): void {
      if (!wanted.has(to)) return;
      clearTimeout(timer);
      session.off('state-change', onChange);
      resolve(to);
    }
    session.on('state-change', onChange);
  });
}

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

function sanitize(text: string, tmpDir: string): string {
  return text.split(tmpDir).join('<codex-probe>').split(os.homedir()).join('<home>');
}

function fixtureDestination(fileName: string, keepDir: string): string {
  return path.join(SHOULD_WRITE_FIXTURES ? FIXTURE_DIR : keepDir, fileName);
}

function writeHookFixture(name: string, hooks: HookRecord[], tmpDir: string, keepDir: string): string {
  const header = { type: 'header', version: 2, records: 'signals', session: `fixture-codex-${name}`, agent: 'codex', startedAt: 0, config: { hooksInjected: true } };
  const lines = [header, ...hooks.map((hook, index) => ({ type: 'hook', ts: index + 1, event: hook.event, payload: projectHookPayload(hook.payload) }))];
  const destination = fixtureDestination(`v2-codex-${name}.jsonl`, keepDir);
  fs.writeFileSync(destination, `${sanitize(lines.map((line) => JSON.stringify(line)).join('\n'), tmpDir)}\n`, 'utf8');
  return destination;
}

function payloadField(hook: HookRecord | null, field: string): unknown {
  return hook?.payload ? hook.payload[field] : undefined;
}

function isSentinelEchoHook(hook: HookRecord): boolean {
  if (hook.event.toLowerCase() !== 'posttooluse') return false;
  if (payloadField(hook, 'tool_name') !== 'Bash') return false;
  const toolInput = payloadField(hook, 'tool_input');
  if (typeof toolInput !== 'object' || toolInput === null || !('command' in toolInput)) return false;
  return typeof toolInput.command === 'string' && toolInput.command.includes(SENTINEL_WORD);
}

function copySanitizedRecording(tmpDir: string): string | null {
  const recordingDir = path.join(tmpDir, 'recordings');
  if (!fs.existsSync(recordingDir)) return null;
  const recorded = fs.readdirSync(recordingDir);
  if (recorded.length === 0) return null;
  const source = path.join(recordingDir, recorded[0]);
  const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-codex-probe-out-'));
  const keptRecording = path.join(keepDir, recorded[0]);
  const sanitized = sanitize(fs.readFileSync(source, 'utf8'), tmpDir);
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
  const hookRecords: HookRecord[] = [];
  const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-codex-probe-out-'));
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
    session.write(PROMPT);
    await delay(1500);
    session.write('\r');
    await waitForState(session, ['COMPLETE'], 'the turn to finish');
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

    async function waitForHook(label: string, since: number, matches: (hook: HookRecord) => boolean, timeoutMs = STEP_TIMEOUT_MS): Promise<HookRecord | null> {
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
      const destination = writeHookFixture(name, hookRecords.slice(since), tmpDir, keepDir);
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
    session.write('Before anything else, call request_user_input exactly once to ask whether a README should be short or long, with the options short and long. Then present a one-step plan.');
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
    fs.writeFileSync(bridgeFixture, `${sanitize(bridgeLines.map((line) => JSON.stringify(line)).join('\n'), tmpDir)}\n`, 'utf8');
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

    const keptRecording = copySanitizedRecording(tmpDir) || '(none written)';
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  console.error(`\nLast terminal output:\n${terminalTail.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')}`);
  process.exit(1);
});
