import './helpers/isolate-home.ts';
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createAcpDriver } from "../session/drivers/acp-driver.ts";
import { execFile } from "../server/child-process-safe.ts";
import { createSessionProcessReaper } from "../session/session-process-reaper.ts";
import type { DriverEvent } from "../session/drivers/driver.ts";

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
