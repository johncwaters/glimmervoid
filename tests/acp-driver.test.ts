import './helpers/isolate-home.ts';
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAcpDriver } from "../session/drivers/acp-driver.ts";
import { createConfigStore } from "../server/config-store.ts";
import { createSessionEventWiring } from "../server/session/session-event-wiring.ts";
import { pickAutoResume } from "../session/core/auto-resume.ts";
import { ProjectConfig } from "../shared/contracts/config.ts";
import { execFile } from "../server/child-process-safe.ts";
import { createSessionProcessReaper } from "../session/session-process-reaper.ts";
import { SESSION_DRIVER_EVENTS } from "../session/drivers/driver.ts";
import type { DriverEvent, SessionDriverEventPayloads } from "../session/drivers/driver.ts";
import { Session } from "../session/sessions.ts";
import { STATES } from "../shared/states.ts";
import type { SessionState } from "../shared/states.ts";
import { replayThroughSession } from "./helpers/session-replay.ts";

const ROOT = path.join(import.meta.dirname, "..");
const fixtures = { recordingPath: (recording: string) => path.join(ROOT, "harness", "acp-spike", "recordings", recording) };
const REPLAY_AGENT = path.join(ROOT, "tests", "fixtures", "acp-replay-agent.ts");
const ACCOUNT_EMAIL = "carbon.unit@example.test";
const ACCOUNT_PLAN = "plan-marker-7c1f";

interface WireParams {
  sessionId?: string;
  toolCallId?: string;
  update?: { sessionUpdate: string };
  options?: { optionId: string }[];
}

interface WireResult {
  sessionId?: string;
  stopReason?: string;
  outcome?: unknown;
}

type WireMessage = { id?: number; method?: string; params?: WireParams; result?: WireResult };
type RecordedLine = { direction: string; message: WireMessage | string };

interface RecordedScript {
  openedSessionId: string;
  isResumed: boolean;
  promptCount: number;
  updateKinds: string[];
  stopReasons: string[];
  permissionOptionIds: string[][];
  questionToolCallIds: (string | null)[];
  clientReplies: WireResult[];
  updatesBeforeCancel: number | null;
  hasAuthStatusNotification: boolean;
}

function recordedLaunch(recording: string, launchNumber: number): WireMessage[] {
  const lines = fs.readFileSync(fixtures.recordingPath(recording), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as RecordedLine);
  const launchIndexes = lines.flatMap((line, index) => (line.direction === "note" && String(line.message).startsWith("launch ") ? [index] : []));
  return lines
    .slice(launchIndexes[launchNumber - 1], launchIndexes[launchNumber] ?? lines.length)
    .filter((line) => line.direction !== "note")
    .map((line) => ({ ...(line.message as WireMessage), direction: line.direction } as WireMessage & { direction: string }));
}

function scriptOf(recording: string, launchNumber: number): RecordedScript {
  const messages = recordedLaunch(recording, launchNumber) as (WireMessage & { direction: string })[];
  const fromAgent = messages.filter((message) => message.direction === "agent->client");
  const fromClient = messages.filter((message) => message.direction === "client->agent");
  const updates = fromAgent.filter((message) => message.method === "session/update");
  const load = fromClient.find((message) => message.method === "session/load");
  const newSessionId = fromClient.find((message) => message.method === "session/new")?.id;
  const cancelIndex = messages.findIndex((message) => message.method === "session/cancel");
  const questions = fromAgent.filter((message) => message.method === "elicitation/create");
  return {
    openedSessionId: load?.params?.sessionId ?? fromAgent.find((message) => message.method === undefined && message.id === newSessionId)?.result?.sessionId ?? "",
    isResumed: load !== undefined,
    promptCount: fromClient.filter((message) => message.method === "session/prompt").length,
    updateKinds: updates.map((message) => message.params?.update?.sessionUpdate ?? ""),
    stopReasons: fromAgent.flatMap((message) => (message.result?.stopReason === undefined ? [] : [message.result.stopReason])),
    permissionOptionIds: fromAgent.filter((message) => message.method === "session/request_permission").map((message) => (message.params?.options ?? []).map((option) => option.optionId)),
    questionToolCallIds: questions.map((message) => message.params?.toolCallId ?? null),
    clientReplies: fromClient.filter((message) => message.method === undefined).map((message) => message.result ?? {}),
    updatesBeforeCancel: cancelIndex === -1 ? null : messages.slice(0, cancelIndex).filter((message) => message.method === "session/update").length,
    hasAuthStatusNotification: fromAgent.some((message) => message.method === "auth/status_update" || message.method === "_auth/status_update"),
  };
}

function captureConsole(): { text: () => string; restore: () => void } {
  const captured: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const level of Object.keys(originals) as (keyof typeof originals)[]) {
    console[level] = (...parts: unknown[]) => { captured.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ")); };
  }
  return { text: () => captured.join("\n"), restore: () => Object.assign(console, originals) };
}

async function replayThroughDriver(recording: string, launchNumber: number, script: RecordedScript): Promise<DriverEvent[]> {
  const reaper = createSessionProcessReaper({
    platform: process.platform,
    killProc: (args, options, callback) => execFile("taskkill", args, options, callback),
    signalProc: (pid, signal) => process.kill(pid, signal),
    stopScope: async () => {},
    port: { isDestroyed: () => false, emitError: (error) => assert.fail(String(error)) },
  });
  const driver = createAcpDriver({ clientName: "glimmervoid", clientVersion: "test", mcpServers: [], killTree: (pid) => reaper.kill(pid) });
  const events: DriverEvent[] = [];
  const pendingReplies = [...script.clientReplies];
  let promptsSent = 0;
  let updatesSeen = 0;
  let turnsEnded = 0;
  const sendNextPrompt = () => {
    if (promptsSent >= script.promptCount) return;
    promptsSent += 1;
    const outcome = driver.send(`replayed prompt ${promptsSent}`, { when: "now", submit: true });
    assert.deepEqual(outcome, { ok: true, kind: "pasted" });
  };
  const exited = new Promise<void>((resolveExit) => {
    const replayDone = new Promise<void>((resolveReplay) => {
      driver.subscribe((event) => {
        events.push(event);
        if (event.kind === "agent-session") sendNextPrompt();
        if (event.kind === "turn-end") {
          turnsEnded += 1;
          sendNextPrompt();
        }
        if (event.kind === "update") updatesSeen += 1;
        if (event.kind === "update" && updatesSeen === script.updatesBeforeCancel) driver.interrupt();
        if (event.kind === "permission") event.request.respond(pendingReplies.shift()?.outcome as never);
        if (event.kind === "question") event.question.respond(pendingReplies.shift() as never);
        if (event.kind === "failure") assert.fail(`driver failure at ${event.stage}: ${event.message}`);
        if (event.kind === "exit") resolveExit();
        if (updatesSeen === script.updateKinds.length && turnsEnded === script.promptCount) resolveReplay();
      });
    });
    driver.start({
      file: process.execPath,
      args: [REPLAY_AGENT, fixtures.recordingPath(recording), String(launchNumber), ACCOUNT_EMAIL, ACCOUNT_PLAN],
      cwd: ROOT,
      env: { ...process.env },
      scopeUnit: null,
      resumeAgentSessionId: script.isResumed ? script.openedSessionId : null,
    });
    void replayDone.then(() => assert.equal(driver.stop(), true));
  });
  await exited;
  return events;
}

const SCENARIOS: { recording: string; launchNumber: number }[] = [
  { recording: "claude/setup.jsonl", launchNumber: 1 },
  { recording: "claude/permissions.jsonl", launchNumber: 1 },
  { recording: "codex/permissions.jsonl", launchNumber: 1 },
  { recording: "antigravity/permissions.jsonl", launchNumber: 1 },
  { recording: "claude/question.jsonl", launchNumber: 1 },
  { recording: "codex/question.jsonl", launchNumber: 1 },
  { recording: "claude/cancel.jsonl", launchNumber: 1 },
  { recording: "claude/resume.jsonl", launchNumber: 2 },
  { recording: "claude/subagents.jsonl", launchNumber: 1 },
];

for (const { recording, launchNumber } of SCENARIOS) {
  test(`ACP driver replays ${recording} (launch ${launchNumber}) into driver events and never surfaces the account`, { timeout: 30_000 }, async () => {
    const script = scriptOf(recording, launchNumber);
    const consoleCapture = captureConsole();
    const events = await replayThroughDriver(recording, launchNumber, script).finally(() => consoleCapture.restore());

    const opened = events.filter((event) => event.kind === "agent-session");
    assert.deepEqual(opened.map((event) => [event.agentSessionId, event.isResumed]), [[script.openedSessionId, script.isResumed]]);
    assert.deepEqual(events.flatMap((event) => (event.kind === "update" ? [event.update.sessionUpdate] : [])), script.updateKinds);
    assert.deepEqual(events.flatMap((event) => (event.kind === "turn-end" ? [event.stopReason] : [])), script.stopReasons);
    assert.deepEqual(events.flatMap((event) => (event.kind === "permission" ? [event.request.options.map((option) => option.optionId)] : [])), script.permissionOptionIds);
    assert.deepEqual(events.flatMap((event) => (event.kind === "question" ? [event.question.toolCallId] : [])), script.questionToolCallIds);
    assert.equal(events.at(-1)?.kind, "exit");

    assert.equal(script.hasAuthStatusNotification, !recording.startsWith("antigravity/"));
    const surfaced = `${JSON.stringify(events)}\n${consoleCapture.text()}`;
    assert.equal(surfaced.includes(ACCOUNT_EMAIL), false, "the account email reached a driver event or a log line");
    assert.equal(surfaced.includes(ACCOUNT_PLAN), false, "the account plan reached a driver event or a log line");
  });
}

type StateSequence = SessionState[];

interface StatusScenario {
  recording: string;
  agent: "claude-code" | "codex";
  hookFixture: string;
  acpSequence: StateSequence;
  hookSequence: StateSequence;
  difference: string | null;
  updatesAfterTurnEnd: boolean;
  cancelsInsteadOfAnsweringAsk?: number;
}

const { RUNNING, WAITING, COMPLETE, IDLE, DONE } = STATES;
const TWO_PROMPTS_THREE_ASKS: StateSequence = [RUNNING, WAITING, RUNNING, WAITING, RUNNING, COMPLETE, RUNNING, WAITING, RUNNING, COMPLETE];
const ANSWER_RETURNS_TO_RUNNING = "the recording runs two prompts with three permission asks, and ACP sees each answer leave the client, so WAITING returns to RUNNING at once; the hook fixture has one ask and no hook between the terminal answer and Stop, so it goes WAITING to COMPLETE";
const NO_HOOK_INTERRUPT_FIXTURE = "no hook fixture records an operator interrupt, so each ACP turn, the cancelled one and the prompt after it, is compared with one hook turn-complete";

const STATUS_SCENARIOS: readonly StatusScenario[] = [
  { recording: "claude/setup.jsonl", agent: "claude-code", hookFixture: "v2-claude-code-turn-complete.jsonl", acpSequence: [RUNNING, COMPLETE], hookSequence: [RUNNING, COMPLETE], difference: null, updatesAfterTurnEnd: false },
  { recording: "codex/setup.jsonl", agent: "codex", hookFixture: "v2-codex-turn-complete.jsonl", acpSequence: [RUNNING, COMPLETE], hookSequence: [RUNNING, COMPLETE], difference: null, updatesAfterTurnEnd: false },
  { recording: "claude/permissions.jsonl", agent: "claude-code", hookFixture: "v2-claude-code-permission-wait.jsonl", acpSequence: TWO_PROMPTS_THREE_ASKS, hookSequence: [RUNNING, WAITING, COMPLETE], difference: ANSWER_RETURNS_TO_RUNNING, updatesAfterTurnEnd: false },
  { recording: "codex/permissions.jsonl", agent: "codex", hookFixture: "v2-codex-permission-wait.jsonl", acpSequence: TWO_PROMPTS_THREE_ASKS, hookSequence: [RUNNING, WAITING, COMPLETE], difference: ANSWER_RETURNS_TO_RUNNING, updatesAfterTurnEnd: false },
  { recording: "codex/permissions.jsonl", agent: "codex", hookFixture: "v2-codex-permission-wait.jsonl", acpSequence: [RUNNING, WAITING, RUNNING, WAITING, RUNNING, COMPLETE, RUNNING, WAITING, COMPLETE], hookSequence: [RUNNING, WAITING, COMPLETE], difference: "the third ask is never answered and the operator cancels instead, so the cancelled turn-end closes the ask and goes WAITING to COMPLETE", updatesAfterTurnEnd: false, cancelsInsteadOfAnsweringAsk: 3 },
  { recording: "claude/question.jsonl", agent: "claude-code", hookFixture: "v2-claude-code-structured-question-answered.jsonl", acpSequence: [RUNNING, WAITING, RUNNING, COMPLETE], hookSequence: [RUNNING, WAITING, RUNNING, COMPLETE], difference: null, updatesAfterTurnEnd: false },
  { recording: "codex/question.jsonl", agent: "codex", hookFixture: "v2-codex-request-user-input.jsonl", acpSequence: [RUNNING, WAITING, RUNNING, COMPLETE], hookSequence: [RUNNING, WAITING, RUNNING, COMPLETE], difference: null, updatesAfterTurnEnd: false },
  { recording: "claude/cancel.jsonl", agent: "claude-code", hookFixture: "v2-claude-code-turn-complete.jsonl", acpSequence: [RUNNING, COMPLETE, RUNNING, COMPLETE], hookSequence: [RUNNING, COMPLETE], difference: NO_HOOK_INTERRUPT_FIXTURE, updatesAfterTurnEnd: false },
  { recording: "codex/cancel.jsonl", agent: "codex", hookFixture: "v2-codex-turn-complete.jsonl", acpSequence: [RUNNING, COMPLETE, RUNNING, COMPLETE], hookSequence: [RUNNING, COMPLETE], difference: NO_HOOK_INTERRUPT_FIXTURE, updatesAfterTurnEnd: false },
  { recording: "claude/subagents.jsonl", agent: "claude-code", hookFixture: "v2-claude-code-subagent-gates-completion.jsonl", acpSequence: [RUNNING, COMPLETE], hookSequence: [RUNNING, COMPLETE], difference: null, updatesAfterTurnEnd: true },
  { recording: "codex/subagents.jsonl", agent: "codex", hookFixture: "v2-codex-subagent.jsonl", acpSequence: [RUNNING, COMPLETE], hookSequence: [RUNNING, COMPLETE], difference: null, updatesAfterTurnEnd: true },
];

interface AcpSessionReplay {
  transitions: StateSequence;
  stopReasons: string[];
  updatesAfterLastTurnEnd: number;
}

async function replayThroughAcpSession(scenario: StatusScenario, script: RecordedScript): Promise<AcpSessionReplay> {
  const session = new Session({
    id: `acp-${scenario.recording}`,
    name: scenario.recording,
    path: ROOT,
    agent: scenario.agent,
    driver: {
      kind: "acp",
      command: { file: process.execPath, args: [REPLAY_AGENT, fixtures.recordingPath(scenario.recording), "1", ACCOUNT_EMAIL, ACCOUNT_PLAN] },
      mcpServers: [],
      clientVersion: "test",
    },
  });
  const transitions: StateSequence = [];
  const stopReasons: string[] = [];
  const pendingReplies = [...script.clientReplies];
  let promptsSent = 0;
  let updatesSeen = 0;
  let updatesAfterLastTurnEnd = 0;
  let asksSeen = 0;
  const sendNextPrompt = () => {
    if (promptsSent >= script.promptCount) return;
    promptsSent += 1;
    assert.deepEqual(session.deliver(`replayed prompt ${promptsSent}`, { when: "now", submit: true }), { ok: true, kind: "pasted" });
  };
  session.on("state-change", ({ to }: { to: SessionState }) => transitions.push(to));
  session.on("error", (error: unknown) => assert.fail(String(error)));
  const exited = new Promise<void>((resolveExit) => session.once("exit", () => resolveExit()));
  const replayDone = new Promise<void>((resolveReplay) => {
    const settleWhenReplayed = () => {
      if (updatesSeen === script.updateKinds.length && stopReasons.length === script.promptCount) resolveReplay();
    };
    session.on(SESSION_DRIVER_EVENTS.agentSession, () => sendNextPrompt());
    session.on(SESSION_DRIVER_EVENTS.turnEnd, ({ stopReason }: SessionDriverEventPayloads["driver-turn-end"]) => {
      stopReasons.push(stopReason);
      updatesAfterLastTurnEnd = 0;
      sendNextPrompt();
      settleWhenReplayed();
    });
    session.on(SESSION_DRIVER_EVENTS.update, ({ isInTurn }: SessionDriverEventPayloads["driver-update"]) => {
      updatesSeen += 1;
      if (!isInTurn && stopReasons.length > 0) updatesAfterLastTurnEnd += 1;
      if (updatesSeen === script.updatesBeforeCancel) session.interrupt();
      settleWhenReplayed();
    });
    session.on(SESSION_DRIVER_EVENTS.permission, ({ request }: SessionDriverEventPayloads["driver-permission"]) => {
      asksSeen += 1;
      const reply = pendingReplies.shift();
      if (asksSeen === scenario.cancelsInsteadOfAnsweringAsk) return session.interrupt();
      request.respond(reply?.outcome as never);
    });
    session.on(SESSION_DRIVER_EVENTS.question, ({ question }: SessionDriverEventPayloads["driver-question"]) => question.respond(pendingReplies.shift() as never));
  });
  await session.start();
  await replayDone;
  session.kill();
  await exited;
  session.destroy();
  return { transitions, stopReasons, updatesAfterLastTurnEnd };
}

function turnSequenceOf(transitions: StateSequence): StateSequence {
  const firstIdle = transitions.indexOf(IDLE);
  assert.notEqual(firstIdle, -1, `the session never reached IDLE: ${transitions.join(" ")}`);
  assert.equal(transitions.at(-1), DONE, `the killed session did not end DONE: ${transitions.join(" ")}`);
  return transitions.slice(firstIdle + 1, -1);
}

for (const scenario of STATUS_SCENARIOS) {
  const variant = scenario.cancelsInsteadOfAnsweringAsk === undefined ? "" : ` cancelling ask ${scenario.cancelsInsteadOfAnsweringAsk}`;
  test(`an ACP Session replaying ${scenario.recording}${variant} walks the state machine like the hook-driven ${scenario.hookFixture}`, { timeout: 30_000 }, async (t) => {
    const script = scriptOf(scenario.recording, 1);
    const acp = await replayThroughAcpSession(scenario, script);
    assert.deepEqual(acp.stopReasons, script.stopReasons);
    assert.deepEqual(turnSequenceOf(acp.transitions), scenario.acpSequence);
    assert.equal(acp.updatesAfterLastTurnEnd > 0, scenario.updatesAfterTurnEnd, "updates after the turn ended left the session COMPLETE");

    const hook = replayThroughSession(scenario.hookFixture, t);
    assert.deepEqual(hook.transitions, scenario.hookSequence);
    if (scenario.difference === null) assert.deepEqual(scenario.acpSequence, scenario.hookSequence);
    if (scenario.difference !== null) assert.notDeepEqual(scenario.acpSequence, scenario.hookSequence);
  });
}

function wireSessionToStore(session: Session, store: ReturnType<typeof createConfigStore>): void {
  createSessionEventWiring({
    configStore: store,
    config: store.config,
    recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: () => {},
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: { acknowledge: () => {}, trigger: () => {}, noteOperatorActivity: () => {} },
    attachSessionPrLink: () => {},
    closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  })(session);
}

async function withConfigFile<T>(configObject: Record<string, unknown>, run: (configPath: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glimmervoid-acp-resume-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(configObject, null, 2), "utf8");
  const previous = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  try {
    return await run(configPath);
  } finally {
    if (previous === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previous !== undefined) process.env.GLIMMERVOID_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function acpChoiceFor(recording: string, launchNumber: number) {
  return {
    kind: "acp" as const,
    command: { file: process.execPath, args: [REPLAY_AGENT, fixtures.recordingPath(recording), String(launchNumber), ACCOUNT_EMAIL, ACCOUNT_PLAN] },
    mcpServers: [],
    clientVersion: "test",
  };
}

const STUB_ACP_AGENT_SCRIPT = `
import readline from "node:readline";
const mode = process.argv[1];
const reportedId = process.argv[2] || "stub-session-1234";
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: mode !== "no-load" } } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: reportedId } });
    return;
  }
  if (message.method === "session/load") {
    if (mode === "refuse-load") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "unknown session id" } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
`;

function stubAcpChoice(mode: "new" | "no-load" | "refuse-load", reportedId = "stub-session-1234") {
  return {
    kind: "acp" as const,
    command: { file: process.execPath, args: ["--input-type=module", "-e", STUB_ACP_AGENT_SCRIPT, "--", mode, reportedId] },
    mcpServers: [],
    clientVersion: "test",
  };
}

for (const { agent, recording } of [
  { agent: "claude-code", recording: "claude/resume.jsonl" },
  { agent: "codex", recording: "codex/resume.jsonl" },
] as const) {
  test(`an ACP Session on ${recording} persists its id across a server stop and restores via session/load into IDLE`, { timeout: 30_000 }, async () => {
    const launchOne = scriptOf(recording, 1);
    const launchTwo = scriptOf(recording, 2);
    assert.equal(launchOne.isResumed, false);
    assert.equal(launchTwo.isResumed, true);
    assert.equal(launchTwo.openedSessionId, launchOne.openedSessionId);

    await withConfigFile({ projects: [{ id: "acp-proj", name: "acp-proj", path: ROOT, agent }] }, async (configPath) => {
      const storeBeforeStop = createConfigStore();
      const firstSession = new Session({
        id: "acp-proj",
        name: "acp-proj",
        path: ROOT,
        agent,
        driver: acpChoiceFor(recording, 1),
      });
      wireSessionToStore(firstSession, storeBeforeStop);
      const firstOpened = new Promise<SessionDriverEventPayloads["driver-agent-session"]>((resolve) => {
        firstSession.once(SESSION_DRIVER_EVENTS.agentSession, resolve);
      });
      const firstTurnEnded = new Promise<void>((resolve) => {
        firstSession.once(SESSION_DRIVER_EVENTS.turnEnd, () => resolve());
      });
      await firstSession.start();
      const openedEvent = await firstOpened;
      assert.deepEqual(openedEvent, { agentSessionId: launchOne.openedSessionId, isResumed: false });
      assert.equal(firstSession.resumeSessionId, launchOne.openedSessionId);

      assert.deepEqual(firstSession.deliver("Remember the codeword ZEBRA-4127.", { when: "now", submit: true }), { ok: true, kind: "pasted" });
      await firstTurnEnded;
      await storeBeforeStop.idle();

      const savedBeforeStop = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.equal(savedBeforeStop.projects[0].resumeSessionId, launchOne.openedSessionId);
      assert.equal(savedBeforeStop.projects[0].wasActive, true);

      firstSession.destroy("server_stopped");
      await storeBeforeStop.idle();

      const storeAfterRestart = createConfigStore();
      const reloadedProject = storeAfterRestart.config.projects[0];
      assert.equal(reloadedProject.resumeSessionId, launchOne.openedSessionId);
      assert.deepEqual(pickAutoResume(storeAfterRestart.config.projects, storeAfterRestart.config, Date.now()), ["acp-proj"]);

      const restoredSession = new Session({
        id: reloadedProject.id,
        name: reloadedProject.name,
        path: reloadedProject.path,
        agent: reloadedProject.agent,
        resumeSessionId: reloadedProject.resumeSessionId ?? null,
        driver: acpChoiceFor(recording, 2),
      });
      wireSessionToStore(restoredSession, storeAfterRestart);

      const statesBeforePrompt: SessionState[] = [];
      const replayUpdates: SessionDriverEventPayloads["driver-update"][] = [];
      let hasOpened = false;
      restoredSession.on("state-change", ({ to }: { to: SessionState }) => {
        if (!hasOpened) statesBeforePrompt.push(to);
      });
      restoredSession.on(SESSION_DRIVER_EVENTS.update, (payload: SessionDriverEventPayloads["driver-update"]) => {
        if (!hasOpened) replayUpdates.push(payload);
      });
      const restoredOpened = new Promise<SessionDriverEventPayloads["driver-agent-session"]>((resolve) => {
        restoredSession.once(SESSION_DRIVER_EVENTS.agentSession, (payload) => {
          hasOpened = true;
          resolve(payload);
        });
      });

      await restoredSession.start();
      const resumedEvent = await restoredOpened;
      assert.deepEqual(resumedEvent, { agentSessionId: launchOne.openedSessionId, isResumed: true });
      assert.ok(replayUpdates.length > 0, "session/load replayed conversation updates before opening");
      assert.ok(replayUpdates.every((entry) => entry.isInTurn === false), "every replayed update arrived outside a turn");
      assert.equal(restoredSession.state, STATES.IDLE, "replaying session/load leaves the session IDLE, not RUNNING");
      assert.equal(statesBeforePrompt.includes(STATES.RUNNING), false);

      const secondTurnEnded = new Promise<void>((resolve) => {
        restoredSession.once(SESSION_DRIVER_EVENTS.turnEnd, () => resolve());
      });
      assert.deepEqual(restoredSession.deliver("What was the codeword?", { when: "now", submit: true }), { ok: true, kind: "pasted" });
      await secondTurnEnded;
      assert.equal(restoredSession.state, STATES.COMPLETE);

      const exited = new Promise<void>((resolve) => restoredSession.once("exit", () => resolve()));
      restoredSession.kill();
      await exited;
      restoredSession.destroy();
      await storeAfterRestart.idle();
    });
  });
}

test("an invalid ACP session id is rejected by ProjectConfig, never persisted, and never sent to session/load", { timeout: 30_000 }, async () => {
  assert.equal(ProjectConfig.safeParse({ id: "p1", name: "p1", path: ROOT, resumeSessionId: "--bad-id" }).success, false);
  assert.deepEqual(pickAutoResume([{ id: "p1", wasActive: true, resumeSessionId: "--bad-id" }], { autoResume: true }, Date.now()), []);

  await withConfigFile({ projects: [{ id: "bad-id", name: "bad-id", path: ROOT, agent: "claude-code" }] }, async (configPath) => {
    const store = createConfigStore();
    const session = new Session({
      id: "bad-id",
      name: "bad-id",
      path: ROOT,
      agent: "claude-code",
      resumeSessionId: "--not-a-valid-id",
      driver: stubAcpChoice("new", "--also-invalid"),
    });
    wireSessionToStore(session, store);
    const opened = new Promise<SessionDriverEventPayloads["driver-agent-session"]>((resolve) => {
      session.once(SESSION_DRIVER_EVENTS.agentSession, resolve);
    });
    await session.start();
    const event = await opened;
    assert.equal(event.isResumed, false, "an invalid stored id falls back to session/new instead of sending session/load");
    assert.equal(session.resumeSessionId, "--not-a-valid-id", "the invalid reported id did not overwrite or get adopted");
    await store.idle();
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(onDisk.projects[0].resumeSessionId, undefined, "an invalid reported id is never persisted");

    const exited = new Promise<void>((resolve) => session.once("exit", () => resolve()));
    session.kill();
    await exited;
    session.destroy();
    await store.idle();
  });
});

for (const mode of ["no-load", "refuse-load"] as const) {
  test(`an ACP Session ends FAILED and flips wasActive false when session/load fails (${mode})`, { timeout: 30_000 }, async () => {
    await withConfigFile({
      projects: [{ id: "fail-load", name: "fail-load", path: ROOT, agent: "claude-code", wasActive: true, resumeSessionId: "b06ca19c-bf20-4fbe-915b-ee52c8e8eb6c" }],
    }, async (configPath) => {
      const store = createConfigStore();
      const session = new Session({
        id: "fail-load",
        name: "fail-load",
        path: ROOT,
        agent: "claude-code",
        resumeSessionId: "b06ca19c-bf20-4fbe-915b-ee52c8e8eb6c",
        driver: stubAcpChoice(mode),
      });
      wireSessionToStore(session, store);
      const exited = new Promise<void>((resolve) => session.once("exit", () => resolve()));
      await session.start();
      await exited;
      assert.equal(session.state, STATES.FAILED);
      assert.ok(session.failureReason?.includes("failed at open"), `expected open failure reason, got ${session.failureReason}`);
      await store.idle();
      const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.equal(onDisk.projects[0].wasActive, false, "a failed load flips wasActive false so boot auto-resume never loops");
      session.destroy();
    });
  });
}

test("Session.restart() reuses the same ACP driver instance cleanly after a mid-turn kill and resumes via session/load", { timeout: 30_000 }, async () => {
  const launchCounterDir = fs.mkdtempSync(path.join(os.tmpdir(), "glimmervoid-acp-restart-"));
  const counterFile = path.join(launchCounterDir, "launch-count.txt");
  const recordingPath = fixtures.recordingPath("claude/resume.jsonl");
  const expectedId = scriptOf("claude/resume.jsonl", 1).openedSessionId;
  const sequentialReplayWrapper = `
import fs from "node:fs";
import { spawn } from "node:child_process";
const [counterPath, replayAgent, recording, email, plan] = process.argv.slice(1);
const nextLaunch = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) + 1 : 1;
fs.writeFileSync(counterPath, String(nextLaunch), "utf8");
const child = spawn(process.execPath, [replayAgent, recording, String(nextLaunch), email, plan], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
`;
  const session = new Session({
    id: "acp-restart-reuse",
    name: "acp-restart-reuse",
    path: ROOT,
    agent: "claude-code",
    driver: {
      kind: "acp",
      command: {
        file: process.execPath,
        args: ["--input-type=module", "-e", sequentialReplayWrapper, "--", counterFile, REPLAY_AGENT, recordingPath, ACCOUNT_EMAIL, ACCOUNT_PLAN],
      },
      mcpServers: [],
      clientVersion: "test",
    },
  });
  try {
    const firstOpened = new Promise<SessionDriverEventPayloads["driver-agent-session"]>((resolve) => {
      session.once(SESSION_DRIVER_EVENTS.agentSession, resolve);
    });
    await session.start();
    const firstEvent = await firstOpened;
    assert.deepEqual(firstEvent, { agentSessionId: expectedId, isResumed: false });
    assert.equal(session.resumeSessionId, expectedId);

    assert.deepEqual(session.deliver("Remember the codeword ZEBRA-4127.", { when: "now", submit: true }), { ok: true, kind: "pasted" });
    assert.equal(session.state, STATES.RUNNING);

    const firstExited = new Promise<void>((resolve) => session.once("exit", () => resolve()));
    assert.equal(session.killSession(), true);
    await firstExited;
    assert.equal(session.state, STATES.DONE);

    const replayUpdates: SessionDriverEventPayloads["driver-update"][] = [];
    let secondOpenedDone = false;
    session.on(SESSION_DRIVER_EVENTS.update, (payload: SessionDriverEventPayloads["driver-update"]) => {
      if (!secondOpenedDone) replayUpdates.push(payload);
    });
    const secondOpened = new Promise<SessionDriverEventPayloads["driver-agent-session"]>((resolve) => {
      session.once(SESSION_DRIVER_EVENTS.agentSession, (payload) => {
        secondOpenedDone = true;
        resolve(payload);
      });
    });

    assert.equal(session.restart(), true);
    const secondEvent = await secondOpened;
    assert.deepEqual(secondEvent, { agentSessionId: expectedId, isResumed: true });
    assert.ok(replayUpdates.length > 0, "restarted session replayed conversation updates");
    assert.ok(replayUpdates.every((entry) => entry.isInTurn === false), "replayed updates after a mid-turn kill stay out of turn");
    assert.equal(session.state, STATES.IDLE);

    const secondTurnEnded = new Promise<void>((resolve) => session.once(SESSION_DRIVER_EVENTS.turnEnd, () => resolve()));
    assert.deepEqual(session.deliver("What was the codeword?", { when: "now", submit: true }), { ok: true, kind: "pasted" });
    await secondTurnEnded;
    assert.equal(session.state, STATES.COMPLETE);

    const secondExited = new Promise<void>((resolve) => session.once("exit", () => resolve()));
    session.kill();
    await secondExited;
  } finally {
    session.destroy();
    fs.rmSync(launchCounterDir, { recursive: true, force: true });
  }
});
