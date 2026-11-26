import './helpers/isolate-home.ts';
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyAcpPromptError, decideAcpSend, doesUpdateConfirmPrompt } from "../session/core/acp-driver-core.ts";
import { projectSessionCard } from "../session/core/snapshot-projection.ts";
import { SESSION_DRIVER_EVENTS } from "../session/drivers/driver.ts";
import type { SessionDriverEventPayloads } from "../session/drivers/driver.ts";
import { Session } from "../session/sessions.ts";
import { createTraceWiring } from "../server/trace-wiring.ts";
import { CHAT_OUTBOX_FAILURE_MAX_CHARS, ChatOutboxEntry } from "../shared/contracts/session.ts";
import { STATES } from "../shared/states.ts";
import { waitFor } from "./helpers/wait-for.ts";

const ROOT = path.join(import.meta.dirname, "..");
const fixtures = { recordingPath: (folder: string, name: string) => path.join(ROOT, "harness", "acp-spike", "recordings", folder, name) };
const REPLAY_AGENT = path.join(ROOT, "tests", "fixtures", "acp-replay-agent.ts");
const ACCOUNT_EMAIL = "carbon.unit@example.test";
const ACCOUNT_PLAN = "plan-marker-7c1f";

type AgentSpec = { agent: "claude-code" | "codex"; folder: "claude" | "codex" };
const AGENTS: readonly AgentSpec[] = [
  { agent: "claude-code", folder: "claude" },
  { agent: "codex", folder: "codex" },
];

type WireMessage = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: Record<string, unknown> };
type RecordedLine = { elapsedMs?: number; direction: "client->agent" | "agent->client" | "note"; message: WireMessage | string };

function scratchDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRecording(dir: string, name: string, lines: readonly RecordedLine[]): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

function readFixtureRecording(folder: string, name: string): RecordedLine[] {
  return fs.readFileSync(fixtures.recordingPath(folder, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as RecordedLine);
}

function receivedMessagesOf(receivedLogPath: string): WireMessage[] {
  if (!fs.existsSync(receivedLogPath)) return [];
  return fs.readFileSync(receivedLogPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as WireMessage);
}

function promptTextsOf(receivedLogPath: string): string[] {
  return receivedMessagesOf(receivedLogPath)
    .filter((message) => message.method === "session/prompt")
    .map((message) => {
      const blocks = message.params?.prompt as { type?: string; text?: string }[] | undefined;
      return blocks?.[0]?.text ?? "";
    });
}

function acpDriverFor(recordingPath: string, launchNumber: number, receivedLogPath?: string) {
  const args = [REPLAY_AGENT, recordingPath, String(launchNumber), ACCOUNT_EMAIL, ACCOUNT_PLAN];
  if (receivedLogPath !== undefined) args.push(receivedLogPath);
  return {
    kind: "acp" as const,
    command: { file: process.execPath, args },
    mcpServers: [],
    clientVersion: "test",
  };
}

function buildTwoTurnRecording(folder: string, name: string, firstError: { code: number; message: string } | null): RecordedLine[] {
  const source = readFixtureRecording(folder, name);
  const firstPromptIndex = source.findIndex((line) => line.direction === "client->agent" && typeof line.message === "object" && line.message.method === "session/prompt");
  assert.notEqual(firstPromptIndex, -1);
  const firstPrompt = source[firstPromptIndex].message as WireMessage;
  const firstPromptId = firstPrompt.id as number;
  const firstResponseIndex = source.findIndex((line) => line.direction === "agent->client" && typeof line.message === "object" && line.message.id === firstPromptId && line.message.method === undefined);
  assert.notEqual(firstResponseIndex, -1);

  const preamble = source.slice(0, firstPromptIndex);
  const turnBody = source.slice(firstPromptIndex + 1, firstResponseIndex);
  const turnResponse = source[firstResponseIndex];
  const metadataBeforeWork = turnBody.filter((line) => {
    if (line.direction !== "agent->client" || typeof line.message !== "object") return false;
    const updateKind = (line.message.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate;
    return updateKind === "available_commands_update" || updateKind === "session_info_update";
  });

  const firstTurnLines: RecordedLine[] = firstError === null
    ? [source[firstPromptIndex], ...turnBody, turnResponse]
    : [
      source[firstPromptIndex],
      ...metadataBeforeWork.slice(0, 1),
      { elapsedMs: 100, direction: "agent->client", message: { jsonrpc: "2.0", id: firstPromptId, error: firstError } },
    ];

  const secondPromptId = firstPromptId + 1;
  const secondTurnLines: RecordedLine[] = [
    { elapsedMs: 200, direction: "client->agent", message: { ...firstPrompt, id: secondPromptId } },
    ...turnBody,
    { elapsedMs: 300, direction: "agent->client", message: { ...(turnResponse.message as WireMessage), id: secondPromptId } },
  ];

  return [...preamble, ...firstTurnLines, ...secondTurnLines];
}

test("ACP delivery pure cores refuse while opening or open, classify RequestError as end-turn, and ignore metadata updates", () => {
  assert.deepEqual(decideAcpSend({ phase: "opening", isPromptOpen: false }, { when: "ready", submit: true }), {
    action: "refuse",
    outcome: { ok: false, kind: "refused", reason: "not-idle" },
  });
  assert.deepEqual(decideAcpSend({ phase: "ready", isPromptOpen: true }, { when: "ready", submit: true }), {
    action: "refuse",
    outcome: { ok: false, kind: "refused", reason: "not-idle" },
  });
  assert.deepEqual(decideAcpSend({ phase: "ready", isPromptOpen: false }, { when: "ready", submit: true }), {
    action: "prompt",
    outcome: { ok: true, kind: "pasted" },
  });
  assert.deepEqual(classifyAcpPromptError({ isRequestError: true, isConnectionAlive: true, message: "Rate limit exceeded" }), {
    action: "end-turn",
    settlement: "dropped",
    failureMessage: "Rate limit exceeded",
  });
  assert.deepEqual(classifyAcpPromptError({ isRequestError: false, isConnectionAlive: true, message: "ACP connection closed" }), {
    action: "fail-driver",
    settlement: "dropped",
    failureMessage: null,
  });
  assert.deepEqual(classifyAcpPromptError({ isRequestError: true, isConnectionAlive: false, message: "Rate limit exceeded" }), {
    action: "fail-driver",
    settlement: "dropped",
    failureMessage: null,
  });
  assert.equal(doesUpdateConfirmPrompt({ sessionUpdate: "available_commands_update", availableCommands: [] }), false);
  assert.equal(doesUpdateConfirmPrompt({ sessionUpdate: "session_info_update", title: "x" }), false);
  assert.equal(doesUpdateConfirmPrompt({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }), true);
  assert.equal(doesUpdateConfirmPrompt({ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls" }), true);
});

for (const { agent, folder } of AGENTS) {
  test(`${agent} over ACP: idle message submits, mid-turn message queues and sends after turn end, and no terminal affordance exists`, { timeout: 30_000 }, async () => {
    const dir = scratchDir(`acp-queue-${folder}-`);
    const receivedLogPath = path.join(dir, "received.jsonl");
    const recordingPath = writeRecording(dir, "two-turns.jsonl", buildTwoTurnRecording(folder, "setup.jsonl", null));
    const session = new Session({
      id: `acp-queue-${folder}`,
      name: `acp-queue-${folder}`,
      path: ROOT,
      agent,
      driver: acpDriverFor(recordingPath, 1, receivedLogPath),
    });
    const stopReasons: string[] = [];
    session.on("error", (error: unknown) => assert.fail(String(error)));
    session.on(SESSION_DRIVER_EVENTS.turnEnd, ({ stopReason }: SessionDriverEventPayloads["driver-turn-end"]) => {
      stopReasons.push(stopReason);
    });
    const opened = new Promise<void>((resolve) => session.once(SESSION_DRIVER_EVENTS.agentSession, () => resolve()));
    const exited = new Promise<void>((resolve) => session.once("exit", () => resolve()));

    try {
      assert.equal(session.hasTerminal, false);
      assert.equal(session.toSnapshot().hasTerminal, false);
      assert.equal(projectSessionCard(session, { id: session.id, name: session.name }).hasTerminal, false);
      await session.start();
      await opened;
      assert.equal(session.isDeliveryInFlight(), false);

      const firstQueued = session.queueChatMessage("First prompt while idle");
      assert.equal(firstQueued.ok, true);
      assert.equal(session.isDeliveryInFlight(), true);

      const secondQueued = session.queueChatMessage("Second prompt queued mid-turn");
      assert.equal(secondQueued.ok, true);
      assert.ok(session.chatOutboxEntries.some((entry) => entry.text === "Second prompt queued mid-turn" && entry.state === "held"));

      await waitFor(() => stopReasons.length === 2, "both queued turns completed", 10_000);
      assert.equal(session.isDeliveryInFlight(), false);
      assert.deepEqual(session.chatOutboxEntries, []);
      assert.deepEqual(promptTextsOf(receivedLogPath), ["First prompt while idle", "Second prompt queued mid-turn"]);

      session.enterCheckTerminal();
      assert.equal(session.toSnapshot().pendingPromptKind, null);
      assert.equal(session.startSignIn(() => {}), null);

      session.kill();
      await exited;
    } finally {
      session.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${agent} over ACP: Send next cancels the active turn via session/cancel and sends the promoted message after stopReason cancelled`, { timeout: 30_000 }, async () => {
    const dir = scratchDir(`acp-send-next-${folder}-`);
    const receivedLogPath = path.join(dir, "received.jsonl");
    const cancelRecordingPath = fixtures.recordingPath(folder, "cancel.jsonl");
    const session = new Session({
      id: `acp-send-next-${folder}`,
      name: `acp-send-next-${folder}`,
      path: ROOT,
      agent,
      driver: acpDriverFor(cancelRecordingPath, 1, receivedLogPath),
    });
    const stopReasons: string[] = [];
    let hasRequestedSendNext = false;
    session.on("error", (error: unknown) => assert.fail(String(error)));
    session.on(SESSION_DRIVER_EVENTS.turnEnd, ({ stopReason }: SessionDriverEventPayloads["driver-turn-end"]) => {
      stopReasons.push(stopReason);
    });
    const opened = new Promise<void>((resolve) => session.once(SESSION_DRIVER_EVENTS.agentSession, () => resolve()));
    const exited = new Promise<void>((resolve) => session.once("exit", () => resolve()));

    try {
      await session.start();
      await opened;

      const firstQueued = session.queueChatMessage("Long running turn to cancel");
      assert.equal(firstQueued.ok, true);
      const deferredQueued = session.queueChatMessage("Stay behind promoted message");
      assert.equal(deferredQueued.ok, true);
      const promotedQueued = session.queueChatMessage("Send this next after cancel");
      assert.equal(promotedQueued.ok, true);
      if (!promotedQueued.ok) return;

      session.on(SESSION_DRIVER_EVENTS.update, ({ update }: SessionDriverEventPayloads["driver-update"]) => {
        if (hasRequestedSendNext || update.sessionUpdate !== "tool_call") return;
        hasRequestedSendNext = true;
        session.stopFromChat(promotedQueued.entryId);
      });

      await waitFor(() => stopReasons.length === 2, "cancelled turn and promoted turn completed", 10_000);
      assert.deepEqual(stopReasons, ["cancelled", "end_turn"]);

      const wireMessages = receivedMessagesOf(receivedLogPath);
      const cancelIndex = wireMessages.findIndex((message) => message.method === "session/cancel");
      const secondPromptIndex = wireMessages.findIndex((message, index) => index > cancelIndex && message.method === "session/prompt");
      assert.notEqual(cancelIndex, -1, "session/cancel was sent");
      assert.ok(secondPromptIndex > cancelIndex, "promoted prompt went after session/cancel");
      const sentPrompts = promptTextsOf(receivedLogPath);
      assert.deepEqual(sentPrompts.slice(0, 2), ["Long running turn to cancel", "Send this next after cancel"]);
      if (sentPrompts.length > 2) assert.equal(sentPrompts[2], "Stay behind promoted message");

      session.kill();
      await exited;
    } finally {
      session.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${agent} over ACP: a prompt-stage JSON-RPC error settles dropped with the agent message, shows no Open Terminal, and leaves the session usable`, { timeout: 30_000 }, async () => {
    const dir = scratchDir(`acp-prompt-err-${folder}-`);
    const receivedLogPath = path.join(dir, "received.jsonl");
    const rateLimitMessage = "Rate limit exceeded; retry in 30s";
    const recordingPath = writeRecording(
      dir,
      "prompt-error-then-ok.jsonl",
      buildTwoTurnRecording(folder, "setup.jsonl", { code: -32603, message: rateLimitMessage }),
    );
    const traceWiring = createTraceWiring({
      configPath: path.join(dir, "config.json"),
      logger: { log: () => {}, warn: () => {} },
    });
    await traceWiring.start();

    const session = new Session({
      id: `acp-prompt-err-${folder}`,
      name: `acp-prompt-err-${folder}`,
      path: ROOT,
      agent,
      driver: acpDriverFor(recordingPath, 1, receivedLogPath),
    });
    traceWiring.attachSession(session);
    const stopReasons: string[] = [];
    session.on("error", (error: unknown) => assert.fail(String(error)));
    session.on(SESSION_DRIVER_EVENTS.turnEnd, ({ stopReason }: SessionDriverEventPayloads["driver-turn-end"]) => {
      stopReasons.push(stopReason);
    });
    const opened = new Promise<void>((resolve) => session.once(SESSION_DRIVER_EVENTS.agentSession, () => resolve()));
    const exited = new Promise<void>((resolve) => session.once("exit", () => resolve()));

    try {
      await session.start();
      await opened;

      const failedQueued = session.queueChatMessage("This prompt hits a rate limit");
      assert.equal(failedQueued.ok, true);
      if (!failedQueued.ok) return;

      await waitFor(
        () => session.chatOutboxEntries.some((entry) => entry.entryId === failedQueued.entryId && entry.state === "failed"),
        "prompt error settled entry as failed",
        10_000,
      );

      const failedEntry = session.chatOutboxEntries[0];
      assert.equal(failedEntry.state, "failed");
      assert.equal(failedEntry.failure, rateLimitMessage);
      assert.equal(failedEntry.shouldOpenTerminal, false);
      assert.equal(session.hasLivePty, true);
      assert.equal(session.state, STATES.COMPLETE);
      assert.equal(session.isDeliveryInFlight(), false);

      await traceWiring.whenIdle();
      const traceAfterError = await traceWiring.readTracePage(session.id, { after: 0 });
      assert.deepEqual(traceAfterError.records.filter((record) => record.kind === "prompt"), [], "a rejected prompt leaves no phantom prompt in trace");

      const cancelled = session.cancelChatMessage(failedEntry.entryId);
      assert.deepEqual(cancelled.map((entry) => entry.text), ["This prompt hits a rate limit"]);

      const nextQueued = session.queueChatMessage("Follow-up after rate limit clears");
      assert.equal(nextQueued.ok, true);
      await waitFor(() => stopReasons.length === 1, "follow-up prompt completed on the same session", 10_000);
      assert.deepEqual(session.chatOutboxEntries, []);
      assert.deepEqual(promptTextsOf(receivedLogPath), ["This prompt hits a rate limit", "Follow-up after rate limit clears"]);

      await traceWiring.whenIdle();
      const traceAfterRecovery = await traceWiring.readTracePage(session.id, { after: 0 });
      assert.deepEqual(
        traceAfterRecovery.records.filter((record) => record.kind === "prompt").map((record) => record.text),
        ["Follow-up after rate limit clears"],
      );

      session.kill();
      await exited;
    } finally {
      session.destroy();
      await traceWiring.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${agent} over ACP: live prompt appears once in trace for a new session and once for a resumed session`, { timeout: 30_000 }, async () => {
    const dir = scratchDir(`acp-trace-resume-${folder}-`);
    const resumeRecordingPath = fixtures.recordingPath(folder, "resume.jsonl");
    const traceWiring = createTraceWiring({
      configPath: path.join(dir, "config.json"),
      logger: { log: () => {}, warn: () => {} },
    });
    await traceWiring.start();

    const sessionId = `acp-trace-resume-${folder}`;
    const firstSession = new Session({
      id: sessionId,
      name: sessionId,
      path: ROOT,
      agent,
      driver: acpDriverFor(resumeRecordingPath, 1),
    });
    traceWiring.attachSession(firstSession);
    firstSession.on("error", (error: unknown) => assert.fail(String(error)));

    let agentSessionId = "";
    try {
      const firstOpened = new Promise<SessionDriverEventPayloads["driver-agent-session"]>((resolve) => {
        firstSession.once(SESSION_DRIVER_EVENTS.agentSession, resolve);
      });
      const firstTurnEnded = new Promise<void>((resolve) => firstSession.once(SESSION_DRIVER_EVENTS.turnEnd, () => resolve()));
      await firstSession.start();
      const openedEvent = await firstOpened;
      agentSessionId = openedEvent.agentSessionId;
      assert.equal(openedEvent.isResumed, false);

      assert.equal(firstSession.queueChatMessage("Remember the codeword ZEBRA-4127.").ok, true);
      await firstTurnEnded;
      await traceWiring.whenIdle();

      const afterFirst = await traceWiring.readTracePage(sessionId, { after: 0 });
      const firstPrompts = afterFirst.records.filter((record) => record.kind === "prompt");
      assert.deepEqual(firstPrompts.map((record) => record.text), ["Remember the codeword ZEBRA-4127."]);
      const firstAssistantIndex = afterFirst.records.findIndex((record) => record.kind === "assistant");
      const firstPromptIndex = afterFirst.records.findIndex((record) => record.kind === "prompt");
      assert.ok(firstPromptIndex >= 0 && firstPromptIndex < firstAssistantIndex, "prompt precedes assistant reply in trace");

      firstSession.destroy("server_stopped");
      await traceWiring.whenIdle();

      const resumedSession = new Session({
        id: sessionId,
        name: sessionId,
        path: ROOT,
        agent,
        resumeSessionId: agentSessionId,
        driver: acpDriverFor(resumeRecordingPath, 2),
      });
      traceWiring.attachSession(resumedSession);
      resumedSession.on("error", (error: unknown) => assert.fail(String(error)));

      try {
        const secondOpened = new Promise<SessionDriverEventPayloads["driver-agent-session"]>((resolve) => {
          resumedSession.once(SESSION_DRIVER_EVENTS.agentSession, resolve);
        });
        const secondTurnEnded = new Promise<void>((resolve) => resumedSession.once(SESSION_DRIVER_EVENTS.turnEnd, () => resolve()));
        await resumedSession.start();
        const resumedEvent = await secondOpened;
        assert.equal(resumedEvent.isResumed, true);

        assert.equal(resumedSession.queueChatMessage("What was the codeword?").ok, true);
        await secondTurnEnded;
        await traceWiring.whenIdle();

        const afterResume = await traceWiring.readTracePage(sessionId, { after: 0 });
        const allPrompts = afterResume.records.filter((record) => record.kind === "prompt");
        assert.deepEqual(allPrompts.map((record) => record.text), [
          "Remember the codeword ZEBRA-4127.",
          "What was the codeword?",
        ]);

        const exited = new Promise<void>((resolve) => resumedSession.once("exit", () => resolve()));
        resumedSession.kill();
        await exited;
      } finally {
        resumedSession.destroy();
      }
    } finally {
      firstSession.destroy();
      await traceWiring.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("an ACP Session fails and settles the outbox entry dropped without Open Terminal when the agent dies mid-prompt", { timeout: 30_000 }, async () => {
  const dyingAgentScript = `
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "dead-mid-prompt-1" } });
    return;
  }
  if (message.method === "session/prompt") {
    process.exit(1);
  }
});
`;
  const session = new Session({
    id: "acp-dead-mid-prompt",
    name: "acp-dead-mid-prompt",
    path: ROOT,
    agent: "claude-code",
    driver: {
      kind: "acp",
      command: { file: process.execPath, args: ["--input-type=module", "-e", dyingAgentScript] },
      mcpServers: [],
      clientVersion: "test",
    },
  });
  const opened = new Promise<void>((resolve) => session.once(SESSION_DRIVER_EVENTS.agentSession, () => resolve()));
  const exited = new Promise<void>((resolve) => session.once("exit", () => resolve()));

  try {
    await session.start();
    await opened;
    assert.equal(session.queueChatMessage("Kill the agent").ok, true);
    await exited;
    assert.equal(session.state, STATES.FAILED);
    assert.equal(session.chatOutboxEntries.length, 1);
    assert.equal(session.chatOutboxEntries[0].state, "failed");
    assert.equal(session.chatOutboxEntries[0].shouldOpenTerminal, false);
  } finally {
    session.destroy();
  }
});

test("an ACP Session queues initialPrompt through the outbox, caps oversized RequestError failure text, and flushes partial trace chunks on mid-turn RequestError", { timeout: 30_000 }, async () => {
  const dir = scratchDir("acp-review-fixes-");
  const receivedLogPath = path.join(dir, "received.jsonl");
  const traceWiring = createTraceWiring({
    configPath: path.join(dir, "config.json"),
    logger: { log: () => {}, warn: () => {} },
  });
  await traceWiring.start();

  const stubAgentScript = `
import fs from "node:fs";
import readline from "node:readline";
const [logPath] = process.argv.slice(1);
let promptCount = 0;
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
input.on("line", (line) => {
  if (!line.trim()) return;
  fs.appendFileSync(logPath, line.trim() + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stub-review-1" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptCount += 1;
    if (promptCount === 1) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "stub-review-1", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "partial before mid-turn error" } } } });
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "mid-turn upstream error" } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "E".repeat(900) } });
  }
});
`;
  const session = new Session({
    id: "acp-review-fixes",
    name: "acp-review-fixes",
    path: ROOT,
    agent: "claude-code",
    initialPrompt: "Initial prompt queued while opening",
    driver: {
      kind: "acp",
      command: { file: process.execPath, args: ["--input-type=module", "-e", stubAgentScript, "--", receivedLogPath] },
      mcpServers: [],
      clientVersion: "test",
    },
  });
  traceWiring.attachSession(session);
  session.on("error", (error: unknown) => assert.fail(String(error)));

  const promptErrors: string[] = [];
  session.on(SESSION_DRIVER_EVENTS.promptError, ({ message }: SessionDriverEventPayloads["driver-prompt-error"]) => {
    promptErrors.push(message);
  });

  try {
    await session.start();
    await waitFor(() => promptErrors.length === 1, "initialPrompt ran and hit mid-turn error", 10_000);
    assert.deepEqual(promptTextsOf(receivedLogPath), ["Initial prompt queued while opening"]);
    assert.equal(session.state, STATES.COMPLETE);

    await traceWiring.whenIdle();
    const tracePage = await traceWiring.readTracePage(session.id, { after: 0 });
    assert.deepEqual(tracePage.records.map((record) => record.kind), ["prompt", "assistant"]);
    assert.equal(tracePage.records[1].kind === "assistant" ? tracePage.records[1].text : null, "partial before mid-turn error");

    const secondQueued = session.queueChatMessage("Trigger oversized error");
    assert.equal(secondQueued.ok, true);
    await waitFor(() => session.chatOutboxEntries.some((entry) => entry.state === "failed"), "oversized RequestError settled failed", 10_000);

    const failedEntry = session.chatOutboxEntries[0];
    assert.equal(failedEntry.failure?.length, CHAT_OUTBOX_FAILURE_MAX_CHARS);
    assert.equal(failedEntry.shouldOpenTerminal, false);
    assert.equal(ChatOutboxEntry.safeParse(failedEntry).success, true);

    const exited = new Promise<void>((resolve) => session.once("exit", () => resolve()));
    session.kill();
    await exited;
  } finally {
    session.destroy();
    await traceWiring.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
