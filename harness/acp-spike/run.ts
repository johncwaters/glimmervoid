import '../support/git-local-env.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { type AgentName, DEPS_DIR, LAUNCH_BY_AGENT, redact } from './acp-client.ts';
import { type AgentSession, type JsonObject, openAgentSession } from './acp-session.ts';

const SCENARIOS = ['setup', 'mcp', 'resume', 'permissions', 'question', 'cancel', 'model', 'subagents', 'hooks', 'updates'] as const;
type Scenario = (typeof SCENARIOS)[number];

const RECORDINGS_DIR = join(import.meta.dirname, 'recordings');
const WORK_DIR = process.env.ACP_SPIKE_WORK ?? join(DEPS_DIR, 'work');
const PROJECT_CANARY = 'PROJECT-CANARY-7731';
const RESUME_CODEWORD = 'ZEBRA-4127';

const { values } = parseArgs({
  options: {
    agent: { type: 'string' },
    scenario: { type: 'string' },
    mode: { type: 'string' },
    board: { type: 'string' },
    authenticate: { type: 'string' },
    label: { type: 'string' },
  },
});

const agent = values.agent as AgentName;
const scenario = values.scenario as Scenario;
if (!(agent in LAUNCH_BY_AGENT) || !SCENARIOS.includes(scenario)) {
  process.stderr.write(`usage: node harness/acp-spike/run.ts --agent ${Object.keys(LAUNCH_BY_AGENT).join('|')} --scenario ${SCENARIOS.join('|')} [--mode <permission mode id>] [--board <board id for mcp>] [--authenticate <auth method id>] [--label <recording suffix>]\n`);
  process.exit(2);
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function ensureWorktree(agentName: AgentName): string {
  const repo = join(WORK_DIR, 'repo');
  if (!existsSync(join(repo, '.git'))) {
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'AGENTS.md'), `# acp spike project\n\nIf anyone asks for the project canary, answer with exactly ${PROJECT_CANARY}.\n`);
    writeFileSync(join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
    writeFileSync(join(repo, 'README.md'), 'Throwaway repository for the Glimmervoid ACP spike.\n');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.name=acp-spike', '-c', 'user.email=acp-spike@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);
  }
  const worktree = join(WORK_DIR, `wt-${agentName}`);
  if (existsSync(join(worktree, '.git'))) return worktree;
  git(repo, ['worktree', 'prune']);
  git(repo, ['worktree', 'add', '-q', '-B', `spike-${agentName}`, worktree]);
  return worktree;
}

function glimmervoidMcpServer(): JsonObject | null {
  const token = process.env.GLIMMERVOID_MCP_TOKEN;
  const agentUrl = process.env.GLIMMERVOID_AGENT_URL;
  if (!token || !agentUrl) return null;
  return {
    type: 'http',
    name: 'glimmervoid',
    url: `${new URL(agentUrl).origin}/mcp`,
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
  };
}

function updateKindCounts(session: AgentSession): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const notification of session.updates) {
    const kind = String((notification.update as JsonObject).sessionUpdate);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

function toolCalls(session: AgentSession): JsonObject[] {
  return session.updates
    .map((notification) => notification.update as JsonObject)
    .filter((update) => update.sessionUpdate === 'tool_call')
    .map((update) => ({ toolCallId: update.toolCallId, title: update.title, kind: update.kind, status: update.status, meta: update._meta }));
}

function finalToolStatuses(session: AgentSession): Record<string, unknown> {
  const statusById: Record<string, unknown> = {};
  for (const notification of session.updates) {
    const update = notification.update as JsonObject;
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue;
    if (update.status !== undefined && update.status !== null) statusById[String(update.toolCallId)] = update.status;
  }
  return statusById;
}

async function newSession(session: AgentSession, cwd: string, mcpServers: JsonObject[] = []) {
  const newSessionResponse = await session.request('session/new', { cwd, mcpServers }, 180_000);
  return { sessionId: String(newSessionResponse.sessionId), response: newSessionResponse };
}

function modeIdFor(newSessionResponse: JsonObject, wanted: RegExp): string | null {
  const modes = ((newSessionResponse.modes as JsonObject | undefined)?.availableModes ?? []) as JsonObject[];
  return (modes.find((mode) => wanted.test(String(mode.id))) ?? null)?.id as string | null;
}

async function setModeIfAsked(session: AgentSession, sessionId: string, newSessionResponse: JsonObject) {
  const wanted = values.mode;
  if (!wanted) return null;
  const modeId = modeIdFor(newSessionResponse, new RegExp(`^${wanted}$`));
  if (modeId === null) return { error: `mode ${wanted} not offered` };
  return session.request('session/set_mode', { sessionId, modeId });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runSetup(session: AgentSession, cwd: string) {
  const created = await newSession(session, cwd);
  const outcome = await session.prompt(
    created.sessionId,
    [
      'Answer from what is already in your context; do not run any tool. Reply in exactly four lines:',
      '1. The project canary, if your project instructions name one, else NONE.',
      '2. The term your user-level instructions tell you to use in place of "human" or "developer", else NONE.',
      '3. YES if a skill or slash command named gating-reviews is available to you, else NO.',
      '4. YES if your context contains the exact text "CAVEMAN MODE ACTIVE" (it comes from a SessionStart hook), else NO.',
    ].join('\n'),
  );
  const availableCommands = session.updates
    .map((notification) => notification.update as JsonObject)
    .filter((update) => update.sessionUpdate === 'available_commands_update')
    .flatMap((update) => ((update.availableCommands ?? []) as JsonObject[]).map((command) => command.name));
  return { newSession: created.response, outcome, availableCommandNames: availableCommands };
}

async function runMcp(session: AgentSession, cwd: string) {
  const server = glimmervoidMcpServer();
  if (server === null) return { blocked: 'GLIMMERVOID_MCP_TOKEN or GLIMMERVOID_AGENT_URL not set: run inside a Glimmervoid session' };
  if (!values.board) return { blocked: 'mcp needs --board <id of a board this Glimmervoid session may draw on>' };
  const created = await newSession(session, cwd, [server]);
  const boxId = `acp-spike-${agent}-${Date.now()}`;
  const outcome = await session.prompt(
    created.sessionId,
    [
      'Use only the tools of the MCP server named glimmervoid, and no other tool.',
      `Step 1: call its whiteboard tool with action "put", board "${values.board}", and ops [{"op":"add","element":{"kind":"box","id":"${boxId}","title":"ACP spike probe","place":"aside"}}].`,
      `Step 2: call its whiteboard tool with action "put", board "${values.board}", and ops [{"op":"remove","id":"${boxId}"}].`,
      'Step 3: call its session tool with action "limits".',
      'Step 4: call its session tool with action "spawn", name "acp-spike-probe" and prompt "Reply OK and end."',
      'Then report each step in one line: the tool name you called and the first 200 characters of its result, including any error.',
    ].join('\n'),
  );
  return { boxId, outcome, toolCalls: toolCalls(session), finalToolStatuses: finalToolStatuses(session) };
}

async function runResume(cwd: string, recordingPath: string) {
  const first = await openAgentSession(agent, cwd, recordingPath);
  const created = await newSession(first, cwd);
  const firstTurn = await first.prompt(created.sessionId, `Remember the codeword ${RESUME_CODEWORD}. Reply only OK.`);
  await first.kill();
  const second = await openAgentSession(agent, cwd, recordingPath);
  const capabilities = (second.initializeResult.agentCapabilities ?? {}) as JsonObject;
  const canLoad = capabilities.loadSession === true;
  const canResume = Boolean((capabilities.sessionCapabilities as JsonObject | undefined)?.resume);
  const method = canLoad ? 'session/load' : 'session/resume';
  const reopened = await second
    .request(method, { sessionId: created.sessionId, cwd, mcpServers: [] }, 180_000)
    .then((reopenResponse) => ({ response: reopenResponse, error: null }))
    .catch((error: unknown) => ({ response: null, error: error instanceof Error ? error.message : JSON.stringify(error) }));
  const replayedUpdates = second.updates.length;
  const replayedKinds = updateKindCounts(second);
  const secondTurn = await second.prompt(created.sessionId, 'What codeword did I ask you to remember? Reply with only the codeword.');
  await second.kill();
  return {
    sessionId: created.sessionId,
    canLoad,
    canResume,
    method,
    firstTurn,
    reopened,
    replayedUpdates,
    replayedKinds,
    secondTurn,
    remembered: secondTurn.agentText.includes(RESUME_CODEWORD),
    stderrTail: second.stderrTail(),
  };
}

async function runPermissions(session: AgentSession, cwd: string) {
  rmSync(join(cwd, 'perm-test.txt'), { force: true });
  rmSync(join(cwd, 'perm-shell.txt'), { force: true });
  const created = await newSession(session, cwd);
  const modeChange = await setModeIfAsked(session, created.sessionId, created.response);
  session.setPermissionPolicy('allow_once');
  const allowed = await session.prompt(
    created.sessionId,
    'Create a file named perm-test.txt in the current directory containing the single word hello, using your file edit or write tool. Then run the shell command `touch perm-shell.txt` with your shell tool and report whether it succeeded.',
  );
  const shellFileAfterAllow = existsSync(join(cwd, 'perm-shell.txt'));
  const requestsAfterAllow = session.observedRequests.length;
  session.setPermissionPolicy('reject_once');
  const rejected = await session.prompt(created.sessionId, 'Run the shell command `rm perm-shell.txt` with your shell tool, asking me for approval if your sandbox blocks it. If I deny the approval, do not try any other way; report that it was denied.');
  return {
    availableModes: (created.response.modes as JsonObject | undefined) ?? null,
    modeChange,
    allowed,
    rejected,
    permissionRequests: session.observedRequests,
    requestsAfterAllow,
    fileWritten: existsSync(join(cwd, 'perm-test.txt')),
    shellFileAfterAllow,
    shellFileAfterReject: existsSync(join(cwd, 'perm-shell.txt')),
    toolCalls: toolCalls(session),
  };
}

async function runQuestion(session: AgentSession, cwd: string) {
  const created = await newSession(session, cwd);
  const outcome = await session.prompt(
    created.sessionId,
    'Ask me a multiple-choice question with your built-in tool for asking the user a question (such as AskUserQuestion or request_user_input), not in plain text: the question is "Which color?" with the options Red and Blue, in that order. Wait for my answer, then reply with exactly CHOSEN=<the option I picked>.',
  );
  return { outcome, answerReachedAgent: outcome.agentText.includes('CHOSEN=Blue'), clientRequests: session.observedRequests, toolCalls: toolCalls(session) };
}

async function runCancel(session: AgentSession, cwd: string) {
  const created = await newSession(session, cwd);
  let cancelSentAtMs: number | null = null;
  const sendCancel = () => {
    if (cancelSentAtMs !== null) return;
    cancelSentAtMs = Date.now();
    session.recorder.note('client sends session/cancel');
    void session.notify('session/cancel', { sessionId: created.sessionId });
  };
  const fallbackTimer = setTimeout(sendCancel, 20_000);
  const cancelled = await session.prompt(
    created.sessionId,
    'Run the shell command `sleep 90 && echo finished` with your shell tool and wait for it, then tell me what it printed.',
    {
      onUpdate: (update) => {
        if (update.sessionUpdate === 'tool_call') setTimeout(sendCancel, 3_000);
      },
    },
  );
  clearTimeout(fallbackTimer);
  const after = await session.prompt(created.sessionId, 'Reply with exactly AFTER-CANCEL-OK and nothing else.');
  return { cancelled, after, cancelSent: cancelSentAtMs !== null, followUpWorked: after.agentText.includes('AFTER-CANCEL-OK') };
}

async function runModel(session: AgentSession, cwd: string) {
  const created = await newSession(session, cwd);
  const configOptions = (created.response.configOptions ?? []) as JsonObject[];
  const changes: JsonObject[] = [];
  for (const category of ['model', 'thought_level']) {
    const option = configOptions.find((candidate) => candidate.category === category);
    if (option === undefined) {
      changes.push({ category, error: 'no config option of this category' });
      continue;
    }
    const choices = ((option.options ?? []) as JsonObject[]).flatMap((choice) => (Array.isArray(choice.options) ? (choice.options as JsonObject[]) : [choice]));
    const different = choices.find((choice) => choice.value !== option.currentValue);
    if (different === undefined) {
      changes.push({ category, error: 'only one value offered' });
      continue;
    }
    const changeResponse = await session
      .request('session/set_config_option', { sessionId: created.sessionId, configId: option.id, value: different.value })
      .catch((error: unknown) => ({ error: error instanceof Error ? error.message : JSON.stringify(error) }));
    changes.push({ category, configId: option.id, from: option.currentValue, to: different.value, response: changeResponse });
  }
  const outcome = await session.prompt(created.sessionId, 'Reply with exactly MODEL-OK and the name of the model you are running as, on one line.');
  return { configOptions, models: created.response.models ?? null, changes, outcome };
}

async function runSubagents(session: AgentSession, cwd: string) {
  rmSync(join(cwd, 'bg.txt'), { force: true });
  const created = await newSession(session, cwd);
  const turnStartedAtMs = Date.now();
  const outcome = await session.prompt(
    created.sessionId,
    [
      'Do both of these, then end your turn right away:',
      '1. Start the shell command `sleep 45 && echo bg-done > bg.txt` as a background shell or background task, so it keeps running without you waiting for it.',
      '2. Use a subagent (your Task or Agent tool, or whatever delegates to a child agent) to read AGENTS.md and report its first line back to you.',
      'Do not wait for the background command to finish.',
    ].join('\n'),
  );
  const turnEndedAtMs = Date.now();
  const backgroundFileAtTurnEnd = existsSync(join(cwd, 'bg.txt'));
  const updatesAtTurnEnd = session.updates.length;
  await delay(60_000);
  const lateUpdates = session.updates.slice(updatesAtTurnEnd).map((notification) => notification.update as JsonObject);
  return {
    outcome,
    turnDurationMs: turnEndedAtMs - turnStartedAtMs,
    backgroundFileAtTurnEnd,
    backgroundFileAfterWait: existsSync(join(cwd, 'bg.txt')),
    lateUpdateKinds: lateUpdates.map((update) => update.sessionUpdate),
    toolCalls: toolCalls(session),
    childSessionIds: [...new Set(session.updates.map((notification) => notification.sessionId).filter((id) => id !== created.sessionId))],
  };
}

async function runHooks(session: AgentSession, cwd: string) {
  const probePath = join(cwd, 'hook-probe.ts');
  rmSync(probePath, { force: true });
  const created = await newSession(session, cwd);
  session.setPermissionPolicy('allow_once');
  const outcome = await session.prompt(
    created.sessionId,
    'Write a file named hook-probe.ts in the current directory with your file write tool, containing exactly this one line: `export function pick(flag: boolean) { if (flag) { return 1; } else { return 2; } }`. If a hook or policy refuses the write, do not rewrite it another way; report the refusal message verbatim and end.',
  );
  const written = existsSync(probePath) ? readFileSync(probePath, 'utf8') : null;
  return { outcome, written, hookBlockedElse: written === null || !written.includes('else'), toolCalls: toolCalls(session), permissionRequests: session.observedRequests };
}

async function runUpdates(session: AgentSession, cwd: string) {
  const created = await newSession(session, cwd);
  const outcome = await session.prompt(
    created.sessionId,
    [
      'Think carefully, step by step, before you act.',
      'Then use your todo list or plan tool (such as TodoWrite, update_plan or your task list) to record a three-step plan for adding a greeting.txt file to this directory: 1. pick the greeting, 2. write the file, 3. check it. Mark step 1 completed and leave the others pending.',
      'Do not create or edit any file. Reply PLAN-OK and end.',
    ].join('\n'),
  );
  return { outcome, toolCalls: toolCalls(session) };
}

const RUNNERS: Record<Exclude<Scenario, 'resume'>, (scenarioSession: AgentSession, scenarioCwd: string) => Promise<JsonObject>> = {
  setup: runSetup,
  mcp: runMcp,
  permissions: runPermissions,
  question: runQuestion,
  cancel: runCancel,
  model: runModel,
  subagents: runSubagents,
  hooks: runHooks,
  updates: runUpdates,
};

async function runOneSessionScenario(cwd: string, recordingPath: string): Promise<JsonObject> {
  const session = await openAgentSession(agent, cwd, recordingPath);
  const authenticateResult = values.authenticate
    ? await session
        .request('authenticate', { methodId: values.authenticate })
        .catch((error: unknown) => ({ error: error instanceof Error ? error.message : JSON.stringify(error) }))
    : null;
  const scenarioSummary = await RUNNERS[scenario as Exclude<Scenario, 'resume'>](session, cwd).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : JSON.stringify(error),
  }));
  await session.kill();
  return {
    initialize: session.initializeResult,
    authenticateResult,
    ...scenarioSummary,
    updateKindCounts: updateKindCounts(session),
    clientRequestMethods: session.observedRequests.map((observed) => observed.method),
    stderrTail: session.stderrTail(),
  };
}

async function main() {
  const cwd = ensureWorktree(agent);
  const recordingName = values.label ? `${scenario}-${values.label}` : scenario;
  const recordingPath = join(RECORDINGS_DIR, agent, `${recordingName}.jsonl`);
  rmSync(recordingPath, { force: true });
  mkdirSync(dirname(recordingPath), { recursive: true });
  const startedAtMs = Date.now();
  const scenarioSummary = scenario === 'resume' ? await runResume(cwd, recordingPath) : await runOneSessionScenario(cwd, recordingPath);
  const summaryPath = join(RECORDINGS_DIR, agent, `${recordingName}.summary.json`);
  writeFileSync(summaryPath, `${redact(JSON.stringify({ agent, scenario, durationMs: Date.now() - startedAtMs, ...scenarioSummary }, null, 2))}\n`);
  process.stdout.write(`${readFileSync(summaryPath, 'utf8').slice(0, 8000)}\n`);
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
