import './helpers/isolate-home.ts';
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SESSION_DRIVER_EVENTS } from "../session/drivers/driver.ts";
import { Session } from "../session/sessions.ts";
import type { SessionOptions } from "../session/sessions.ts";
import { resolveHookTools } from "../server/hook-tools.ts";
import { HOOK_TOOLS } from "../session/core/hook-tools.ts";
import { waitFor } from "./helpers/wait-for.ts";
import { STATES } from "../shared/states.ts";
import type { ConversationAnswers, ConversationApproval, PermissionDecision } from "../shared/contracts/session.ts";
import { MANAGER_DECISION_EVENT } from "../shared/contracts/question-manager.ts";
import type { ManagerDecision, ManagerVerdict } from "../shared/contracts/question-manager.ts";
import type { QuestionManagerPort } from "../session/session-approval-holds.ts";

const ROOT = path.join(import.meta.dirname, "..");
const RECORDINGS = path.join(ROOT, "harness", "acp-spike", "recordings");
const REPLAY_AGENT = path.join(ROOT, "tests", "fixtures", "acp-replay-agent.ts");
const REDACTED_CODEX_CWD = '"cwd":"~/.cache/glimmervoid-acp-spike/work/wt-codex"';

type AgentId = "claude-code" | "codex";
type WireMessage = { id?: number | string; method?: string; result?: Record<string, unknown> };
type RecordedLine = { direction: string; message: WireMessage | string };
type OperatorAct = (approval: ConversationApproval, session: Session, askNumber: number) => void;

const AGENTS: readonly { agent: AgentId; folder: string }[] = [
  { agent: "claude-code", folder: "claude" },
  { agent: "codex", folder: "codex" },
];

const ALLOW_ALLOW_DENY: readonly PermissionDecision[] = ["allow", "allow", "deny"];

interface OperatorReplay {
  approvals: ConversationApproval[];
  stopReasons: string[];
  answersOnWire: Record<string, unknown>[];
  requestsOnWire: WireMessage[];
  approvalAtEnd: ConversationApproval | null;
  saneYoloWhileLive: boolean;
  saneYoloAfterExit: boolean;
  managerDecisions: ManagerDecision[];
}

function scratchFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acp-approvals-"));
}

function recordedLines(recordingPath: string): RecordedLine[] {
  return fs.readFileSync(recordingPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as RecordedLine);
}

function recordedClientAnswers(recordingPath: string): Record<string, unknown>[] {
  return recordedLines(recordingPath)
    .filter((line) => line.direction === "client->agent" && typeof line.message === "object" && line.message.method === undefined)
    .map((line) => (line.message as WireMessage).result ?? {});
}

function recordedPromptCount(recordingPath: string): number {
  return recordedLines(recordingPath).filter((line) => line.direction === "client->agent" && typeof line.message === "object" && line.message.method === "session/prompt").length;
}

function derivedRecording(recordingPath: string, rewrite: (lines: string[]) => string[]): string {
  const derivedPath = path.join(scratchFolder(), path.basename(recordingPath));
  const lines = fs.readFileSync(recordingPath, "utf8").split("\n").filter(Boolean).map((line) => line.split(REDACTED_CODEX_CWD).join(`"cwd":${JSON.stringify(ROOT)}`));
  fs.writeFileSync(derivedPath, `${rewrite(lines).join("\n")}\n`);
  return derivedPath;
}

function wireMessagesReceivedBy(receivedLogPath: string): WireMessage[] {
  if (!fs.existsSync(receivedLogPath)) return [];
  return fs.readFileSync(receivedLogPath, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as WireMessage);
}

function answersReceivedBy(receivedLogPath: string): Record<string, unknown>[] {
  return wireMessagesReceivedBy(receivedLogPath)
    .flatMap((message) => (message.method === undefined && message.result !== undefined && ("outcome" in message.result || "action" in message.result) ? [message.result] : []));
}

async function replayWithOperator(
  agent: AgentId,
  recordingPath: string,
  act: OperatorAct,
  {
    promptCount = recordedPromptCount(recordingPath),
    endsOnExit = false,
    wireAnswerCount = 0,
    hookTools = [],
    dangerouslySkipPermissions = false,
    questionManager = null,
    onTurnEnd,
  }: {
    promptCount?: number;
    endsOnExit?: boolean;
    wireAnswerCount?: number;
    hookTools?: SessionOptions["hookTools"];
    dangerouslySkipPermissions?: boolean;
    questionManager?: QuestionManagerPort | null;
    onTurnEnd?: (session: Session, stopReason: string) => void;
  } = {},
): Promise<OperatorReplay> {
  const receivedLogPath = path.join(scratchFolder(), "received.jsonl");
  const session = new Session({
    id: `acp-approvals-${agent}-${path.basename(recordingPath)}`,
    name: path.basename(recordingPath),
    path: ROOT,
    agent,
    hookTools,
    dangerouslySkipPermissions,
    questionManager,
    driver: {
      kind: "acp",
      command: { file: process.execPath, args: [REPLAY_AGENT, recordingPath, "1", "carbon.unit@example.test", "plan-marker-7c1f", receivedLogPath] },
      mcpServers: [],
      clientVersion: "test",
    },
  });
  const approvals: ConversationApproval[] = [];
  const stopReasons: string[] = [];
  const managerDecisions: ManagerDecision[] = [];
  let saneYoloWhileLive = false;
  let promptsSent = 0;
  const sendNextPrompt = () => {
    if (promptsSent >= promptCount) return;
    promptsSent += 1;
    assert.deepEqual(session.deliver(`replayed prompt ${promptsSent}`, { when: "now", submit: true }), { ok: true, kind: "pasted" });
  };
  session.on("error", (error: unknown) => assert.fail(String(error)));
  session.on(MANAGER_DECISION_EVENT, ({ decision }: { decision: ManagerDecision }) => managerDecisions.push(decision));
  session.on("conversation-change", ({ conversationApproval }: { conversationApproval: ConversationApproval | null }) => {
    if (conversationApproval === null || approvals.some((seen) => seen.requestId === conversationApproval.requestId)) return;
    approvals.push(conversationApproval);
    queueMicrotask(() => act(conversationApproval, session, approvals.length));
  });
  const exited = new Promise<void>((resolveExit) => session.once("exit", () => resolveExit()));
  const turnsDone = new Promise<void>((resolveTurns) => {
    session.on(SESSION_DRIVER_EVENTS.agentSession, () => {
      saneYoloWhileLive = session.saneYolo;
      sendNextPrompt();
    });
    session.on(SESSION_DRIVER_EVENTS.turnEnd, ({ stopReason }: { stopReason: string }) => {
      stopReasons.push(stopReason);
      onTurnEnd?.(session, stopReason);
      sendNextPrompt();
      if (stopReasons.length === promptCount) resolveTurns();
    });
  });
  await session.start();
  if (endsOnExit) await exited;
  if (!endsOnExit) await turnsDone;
  await waitFor(() => answersReceivedBy(receivedLogPath).length >= wireAnswerCount, "the replay agent received every answer", 5000);
  const approvalAtEnd = session._conversationApproval;
  session.kill();
  await exited;
  const saneYoloAfterExit = session.saneYolo;
  session.destroy();
  return {
    approvals,
    stopReasons,
    answersOnWire: answersReceivedBy(receivedLogPath),
    requestsOnWire: wireMessagesReceivedBy(receivedLogPath),
    approvalAtEnd,
    saneYoloWhileLive,
    saneYoloAfterExit,
    managerDecisions,
  };
}

function decideInOrder(decisions: readonly PermissionDecision[]): OperatorAct {
  return (approval, session, askNumber) => assert.equal(session.decideConversationApproval(approval.requestId, decisions[askNumber - 1]), true);
}

for (const { agent, folder } of AGENTS) {
  const permissions = path.join(RECORDINGS, folder, "permissions.jsonl");
  const question = path.join(RECORDINGS, folder, "question.jsonl");

  test(`${agent} over ACP: Allow and Deny from the approval path pick the recorded options and complete each turn`, { timeout: 30_000 }, async () => {
    const replay = await replayWithOperator(agent, permissions, decideInOrder(ALLOW_ALLOW_DENY));
    assert.deepEqual(replay.approvals.map((approval) => approval.kind), ["permission", "permission", "permission"]);
    assert.deepEqual(replay.answersOnWire, recordedClientAnswers(permissions));
    assert.equal(replay.stopReasons.length, 2);
    assert.equal(replay.approvalAtEnd, null);
  });

  test(`${agent} over ACP: an answered question goes back as the recorded form content and completes the turn`, { timeout: 30_000 }, async () => {
    const answerBlue: OperatorAct = (approval, session) => {
      const answers: ConversationAnswers = Object.fromEntries((approval.questions ?? []).map((asked) => [asked.question, "Blue"]));
      assert.equal(session.answerConversationApproval(approval.requestId, answers), true);
    };
    const replay = await replayWithOperator(agent, question, answerBlue);
    assert.deepEqual(replay.approvals.map((approval) => [approval.kind, approval.questions?.[0]?.question]), [["question", "Which color?"]]);
    assert.deepEqual(replay.answersOnWire, recordedClientAnswers(question));
    assert.equal(replay.stopReasons.length, 1);
    assert.equal(replay.approvalAtEnd, null);
  });

  test(`${agent} over ACP: Sane YOLO denies a blocked command before the operator sees it`, { timeout: 30_000 }, async () => {
    const stashing = derivedRecording(permissions, (lines) => lines.map((line) => (line.includes("session/request_permission") ? line.split("rm perm-shell.txt").join("git stash") : line)));
    const hookTools = resolveHookTools({});
    assert.equal(hookTools.some((tool) => tool.id === "saneYolo"), true);
    const replay = await replayWithOperator(agent, stashing, decideInOrder(["allow", "allow"]), { hookTools });
    assert.equal(replay.approvals.length, 2);
    assert.deepEqual(replay.answersOnWire, recordedClientAnswers(permissions));
    assert.equal(replay.stopReasons.length, 2);
  });
}

const CODEX_PERMISSIONS = path.join(RECORDINGS, "codex", "permissions.jsonl");
const CANCELLED_ON_WIRE = { outcome: { outcome: "cancelled" } };

test("an interrupt answers the open ACP permission request cancelled and clears the approval", { timeout: 30_000 }, async () => {
  const interruptOnThird: OperatorAct = (approval, session, askNumber) => {
    if (askNumber === 3) return session.interrupt();
    assert.equal(session.decideConversationApproval(approval.requestId, "allow"), true);
  };
  const replay = await replayWithOperator("codex", CODEX_PERMISSIONS, interruptOnThird, { wireAnswerCount: 3 });
  assert.deepEqual(replay.answersOnWire.at(-1), CANCELLED_ON_WIRE);
  assert.equal(replay.answersOnWire.length, 3);
  assert.equal(replay.approvalAtEnd, null);
});

test("a turn that ends with an ACP permission request open answers it cancelled and clears the approval", { timeout: 30_000 }, async () => {
  const firstTurnWithSecondAskUnanswered = derivedRecording(CODEX_PERMISSIONS, (lines) => {
    const firstTurnEnd = lines.findIndex((line) => line.includes('"stopReason"'));
    const secondAskReply = lines.findIndex((line) => line.includes('"direction":"client->agent"') && line.includes('"id":1,"result"'));
    return lines.slice(0, firstTurnEnd + 1).filter((_line, index) => index !== secondAskReply);
  });
  const allowFirstOnly: OperatorAct = (approval, session, askNumber) => {
    if (askNumber === 1) assert.equal(session.decideConversationApproval(approval.requestId, "allow"), true);
  };
  const replay = await replayWithOperator("codex", firstTurnWithSecondAskUnanswered, allowFirstOnly, { promptCount: 1, wireAnswerCount: 2 });
  assert.equal(replay.approvals.length, 2);
  assert.deepEqual(replay.answersOnWire, [recordedClientAnswers(CODEX_PERMISSIONS)[0], CANCELLED_ON_WIRE]);
  assert.equal(replay.approvalAtEnd, null);
});

test("Sane YOLO judges a Codex shell request in the folder the request names, not the session folder", { timeout: 30_000 }, async () => {
  const deletingInHome = derivedRecording(CODEX_PERMISSIONS, (lines) => lines.map((line) => {
    if (!line.includes("session/request_permission") || !line.includes("rm perm-shell.txt")) return line;
    return line.split("rm perm-shell.txt").join("rm -rf Projects").split(`"cwd":${JSON.stringify(ROOT)}`).join(`"cwd":${JSON.stringify(os.homedir())}`);
  }));
  const replay = await replayWithOperator("codex", deletingInHome, decideInOrder(["allow", "allow"]), { hookTools: resolveHookTools({}) });
  assert.equal(replay.approvals.length, 2);
  assert.deepEqual(replay.answersOnWire, recordedClientAnswers(CODEX_PERMISSIONS));
});

test("an ACP permission request the agent withdraws mid-turn clears its approval and no longer keeps the session waiting", { timeout: 30_000 }, async () => {
  const withdrawsFirstAsk = derivedRecording(CODEX_PERMISSIONS, (lines) => {
    const firstTurnEnd = lines.findIndex((line) => line.includes('"stopReason"'));
    const firstAsk = lines.findIndex((line) => line.includes("session/request_permission"));
    const withdrawal = JSON.stringify({ elapsedMs: 0, direction: "agent->client", message: { jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 0 } } });
    const firstAskReply = lines.findIndex((line) => line.includes('"direction":"client->agent"') && line.includes('"id":0,"result"'));
    return [...lines.slice(0, firstAsk + 1), withdrawal, ...lines.slice(firstAsk + 1, firstTurnEnd)].filter((line) => line !== lines[firstAskReply]);
  });
  let stateAfterSecondAsk: string | null = null;
  const allowSecondThenStop: OperatorAct = (approval, session) => {
    if (approval.toolName !== "touch perm-shell.txt") return;
    assert.equal(session.decideConversationApproval(approval.requestId, "allow"), true);
    void waitFor(() => session.state !== STATES.WAITING, "the session left WAITING", 5000).finally(() => {
      stateAfterSecondAsk = session.state;
      session.kill();
    });
  };
  const replay = await replayWithOperator("codex", withdrawsFirstAsk, allowSecondThenStop, { endsOnExit: true, wireAnswerCount: 0 });
  assert.equal(stateAfterSecondAsk, STATES.RUNNING);
  assert.equal(replay.approvalAtEnd, null);
});

for (const ending of ["stop", "agent exit"] as const) {
  test(`an ACP permission request held at ${ending} leaves no approval held`, { timeout: 30_000 }, async () => {
    const endOnThird: OperatorAct = (approval, session, askNumber) => {
      if (askNumber < 3) return assert.equal(session.decideConversationApproval(approval.requestId, "allow"), true);
      if (ending === "stop") return session.kill();
      process.kill(session.pid ?? 0, "SIGKILL");
    };
    const replay = await replayWithOperator("codex", CODEX_PERMISSIONS, endOnThird, { endsOnExit: true });
    assert.equal(replay.approvals.length, 3);
    assert.equal(replay.approvalAtEnd, null);
  });
}

function stubQuestionManager(verdict: ManagerVerdict): QuestionManagerPort {
  let isOn = true;
  return {
    get isOn() { return isOn; },
    setOn(next) { isOn = next; },
    mightAnswer: () => isOn,
    decide: async () => verdict,
  };
}

test("Claude over ACP with Sane YOLO and skip-permissions injects PreToolUse hook, sets default mode, reports saneYolo active, allows safe asks and denies blocked commands", { timeout: 30_000 }, async () => {
  const claudePermissions = path.join(RECORDINGS, "claude", "permissions.jsonl");
  const stashing = derivedRecording(claudePermissions, (lines) => lines.map((line) => (line.includes("session/request_permission") ? line.split("rm perm-shell.txt").join("git stash") : line)));
  const hookTools = resolveHookTools({});
  const replay = await replayWithOperator("claude-code", stashing, () => assert.fail("skip-permissions session should not hold approvals for the operator"), {
    hookTools,
    dangerouslySkipPermissions: true,
    wireAnswerCount: 3,
  });
  assert.equal(replay.saneYoloWhileLive, true);
  assert.equal(replay.saneYoloAfterExit, false);
  assert.equal(replay.approvals.length, 0);
  assert.deepEqual(replay.answersOnWire, recordedClientAnswers(claudePermissions));
  const sessionNew = replay.requestsOnWire.find((message) => message.method === "session/new") as { params?: { _meta?: { claudeCode?: { options?: { settings?: { hooks?: { PreToolUse?: { matcher: string }[] } }; env?: Record<string, string> } } } } } | undefined;
  assert.ok(sessionNew?.params?._meta?.claudeCode?.options?.settings?.hooks?.PreToolUse?.[0]?.matcher.includes("Bash"));
  assert.ok(sessionNew?.params?._meta?.claudeCode?.options?.env?.CC_SAFETY_NET_HOME);
  const setMode = replay.requestsOnWire.find((message) => message.method === "session/set_mode") as { params?: { modeId?: string } } | undefined;
  assert.equal(setMode?.params?.modeId, "default");
});

test("Codex over ACP fails closed with saneYolo false when the adapter does not list or trust the Sane YOLO hook", { timeout: 30_000 }, async () => {
  const replay = await replayWithOperator("codex", CODEX_PERMISSIONS, decideInOrder(ALLOW_ALLOW_DENY), {
    hookTools: resolveHookTools({}),
  });
  assert.equal(replay.saneYoloWhileLive, false);
  assert.equal(replay.saneYoloAfterExit, false);
});

test("Codex over ACP injects only the Sane YOLO PreToolUse hook via CODEX_CONFIG, trusts it via _codex/hooks/trust, reports saneYolo active, and fails closed when trust is denied", { timeout: 30_000 }, async () => {
  const codexSaneYolo = path.join(RECORDINGS, "codex", "sane-yolo.jsonl");
  const hookTools = resolveHookTools({});
  const saneYoloTool = hookTools.find((tool) => tool.id === "saneYolo");
  assert.ok(saneYoloTool);
  const expectedEntry = HOOK_TOOLS.saneYolo.codexEntry(saneYoloTool);
  assert.ok(expectedEntry);
  const expectedCommand = expectedEntry.hooks[0].command;
  const recordedCommand = "node ~/Projects/.glimmervoid-worktrees/glimmervoid-L6n1dR/node_modules/cc-safety-net/dist/bin/cc-safety-net.js hook --codex";
  const escapedExpectedCommand = JSON.stringify(expectedCommand).slice(1, -1);
  const trustedRecording = derivedRecording(codexSaneYolo, (lines) =>
    lines.map((line) => line.split(recordedCommand).join(escapedExpectedCommand)));

  const envReportPath = path.join(scratchFolder(), "codex-env.json");
  const receivedLogPath = path.join(scratchFolder(), "received.jsonl");
  const envCaptureWrapper = `
import fs from "node:fs";
import { spawn } from "node:child_process";
const [reportPath, replayAgent, ...rest] = process.argv.slice(1);
fs.writeFileSync(reportPath, JSON.stringify({
  codexConfig: process.env.CODEX_CONFIG ?? null,
  safetyNetHome: process.env.CC_SAFETY_NET_HOME ?? null,
  saneYoloPath: process.env.GLIMMERVOID_SANE_YOLO_PATH ?? null,
  hookUrl: process.env.GLIMMERVOID_HOOK_URL ?? null,
}), "utf8");
const child = spawn(process.execPath, [replayAgent, ...rest], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
`;
  const session = new Session({
    id: "acp-codex-sane-yolo-trusted",
    name: "codex-sane-yolo",
    path: ROOT,
    agent: "codex",
    hookTools,
    driver: {
      kind: "acp",
      command: {
        file: process.execPath,
        args: ["--input-type=module", "-e", envCaptureWrapper, "--", envReportPath, REPLAY_AGENT, trustedRecording, "1", "carbon.unit@example.test", "plan-marker-7c1f", receivedLogPath],
      },
      mcpServers: [],
      clientVersion: "test",
    },
  });
  let saneYoloWhileLive = false;
  const stopReasons: string[] = [];
  const exited = new Promise<void>((resolveExit) => session.once("exit", () => resolveExit()));
  const turnsDone = new Promise<void>((resolveTurns) => {
    let promptsSent = 0;
    const sendNextPrompt = () => {
      if (promptsSent >= 2) return;
      promptsSent += 1;
      assert.deepEqual(session.deliver(`replayed prompt ${promptsSent}`, { when: "now", submit: true }), { ok: true, kind: "pasted" });
    };
    session.on(SESSION_DRIVER_EVENTS.agentSession, () => {
      saneYoloWhileLive = session.saneYolo;
      sendNextPrompt();
    });
    session.on(SESSION_DRIVER_EVENTS.turnEnd, ({ stopReason }: { stopReason: string }) => {
      stopReasons.push(stopReason);
      sendNextPrompt();
      if (stopReasons.length === 2) resolveTurns();
    });
  });
  await session.start();
  await turnsDone;
  session.kill();
  await exited;
  const saneYoloAfterExit = session.saneYolo;
  session.destroy();

  assert.equal(saneYoloWhileLive, true);
  assert.equal(saneYoloAfterExit, false);
  assert.deepEqual(stopReasons, ["end_turn", "end_turn"]);

  const envReport = JSON.parse(fs.readFileSync(envReportPath, "utf8")) as {
    codexConfig: string | null;
    safetyNetHome: string | null;
    saneYoloPath: string | null;
    hookUrl: string | null;
  };
  assert.ok(envReport.codexConfig !== null);
  const parsedCodexConfig = JSON.parse(envReport.codexConfig) as { hooks?: Record<string, unknown> };
  assert.deepEqual(Object.keys(parsedCodexConfig.hooks ?? {}), ["PreToolUse"]);
  assert.deepEqual(parsedCodexConfig.hooks?.PreToolUse, [expectedEntry]);
  assert.ok(envReport.safetyNetHome !== null && envReport.safetyNetHome.length > 0);
  assert.equal(envReport.saneYoloPath, null);
  assert.equal(envReport.hookUrl, null);

  const wireRequests = wireMessagesReceivedBy(receivedLogPath);
  assert.ok(wireRequests.some((message) => message.method === "_codex/hooks/list"));
  assert.ok(wireRequests.some((message) => message.method === "_codex/hooks/trust"));

  const untrustedRecording = derivedRecording(trustedRecording, (lines) =>
    lines.map((line) => line.split('"trusted":true').join('"trusted":false')));
  const untrustedReplay = await replayWithOperator("codex", untrustedRecording, () => {}, { hookTools });
  assert.equal(untrustedReplay.saneYoloWhileLive, false);
  assert.equal(untrustedReplay.saneYoloAfterExit, false);
});

for (const { agent, folder } of AGENTS) {
  const question = path.join(RECORDINGS, folder, "question.jsonl");

  test(`${agent} over ACP: question manager answers an ACP question directly without holding for the operator`, { timeout: 30_000 }, async () => {
    const manager = stubQuestionManager({ kind: "answer", by: "rule", ruleName: "prefer-blue", answers: { "Which color?": "Blue" } });
    const replay = await replayWithOperator(agent, question, () => assert.fail("question manager should answer without holding for operator"), {
      questionManager: manager,
      wireAnswerCount: 1,
    });
    assert.equal(replay.approvals.length, 0);
    assert.deepEqual(replay.answersOnWire, recordedClientAnswers(question));
    assert.equal(replay.managerDecisions.length, 1);
    assert.equal(replay.managerDecisions[0]?.outcome, "answered");
  });

  test(`${agent} over ACP: question manager escalation hands the ACP question to the operator`, { timeout: 30_000 }, async () => {
    const manager = stubQuestionManager({ kind: "escalate", reason: "needs operator" });
    const answerBlue: OperatorAct = (approval, session) => {
      const answers: ConversationAnswers = Object.fromEntries((approval.questions ?? []).map((asked) => [asked.question, "Blue"]));
      assert.equal(session.answerConversationApproval(approval.requestId, answers), true);
    };
    const replay = await replayWithOperator(agent, question, answerBlue, {
      questionManager: manager,
      wireAnswerCount: 1,
    });
    assert.equal(replay.approvals.length, 1);
    assert.deepEqual(replay.answersOnWire, recordedClientAnswers(question));
    assert.equal(replay.managerDecisions.length, 1);
    assert.equal(replay.managerDecisions[0]?.outcome, "escalated");
  });
}

test("a Codex async question still open at turn-end stays held for the operator instead of being cancelled", { timeout: 30_000 }, async () => {
  const codexQuestion = path.join(RECORDINGS, "codex", "question.jsonl");
  const turnEndsBeforeAnswer = derivedRecording(codexQuestion, (lines) => {
    const answerIndex = lines.findIndex((line) => line.includes('"direction":"client->agent"') && line.includes('"action":"accept"'));
    return lines.filter((_line, index) => index !== answerIndex);
  });
  const approvalsAfterTurnEnd: (ConversationApproval | null)[] = [];
  const statesObserved: string[] = [];
  const replay = await replayWithOperator("codex", turnEndsBeforeAnswer, () => {}, {
    wireAnswerCount: 1,
    onTurnEnd: (session) => {
      const held = session._conversationApproval;
      approvalsAfterTurnEnd.push(held);
      statesObserved.push(session.state);
      if (held === null) return;
      const answers: ConversationAnswers = Object.fromEntries((held.questions ?? []).map((asked) => [asked.question, "Blue"]));
      assert.equal(session.answerConversationApproval(held.requestId, answers), true);
      queueMicrotask(() => statesObserved.push(session.state));
    },
  });
  assert.equal(approvalsAfterTurnEnd[0]?.kind, "question");
  assert.deepEqual(statesObserved, [STATES.WAITING, STATES.COMPLETE]);
  assert.deepEqual(replay.answersOnWire, recordedClientAnswers(codexQuestion));
  assert.equal(replay.approvalAtEnd, null);
});

test("Codex over ACP uses a generated ACP CODEX_HOME with zero PTY status hooks and never writes the operator's real config.toml", { timeout: 30_000 }, async () => {
  const scratchDir = scratchFolder();
  const realCodexHome = path.join(scratchDir, "real-codex-home");
  const envCapturePath = path.join(scratchDir, "captured-env.json");
  fs.mkdirSync(realCodexHome, { recursive: true });
  const originalRealConfig = 'model = "gpt-6.1-sol"\n';
  fs.writeFileSync(path.join(realCodexHome, "config.toml"), originalRealConfig, "utf8");
  fs.writeFileSync(path.join(realCodexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "a.b.c", id_token: "d.e.f", refresh_token: "r" } }), "utf8");
  const priorCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = realCodexHome;
  const agentScript = `
import fs from "node:fs";
import readline from "node:readline";
const outPath = process.argv[1];
fs.writeFileSync(outPath, JSON.stringify({
  CODEX_HOME: process.env.CODEX_HOME ?? null,
  CODEX_CONFIG: process.env.CODEX_CONFIG ?? null,
}));
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "codex-home-test-1" } });
  }
});
`;
  const session = new Session({
    id: "acp-codex-generated-home",
    name: "acp-codex-generated-home",
    path: ROOT,
    agent: "codex",
    driver: {
      kind: "acp",
      command: { file: process.execPath, args: ["--input-type=module", "-e", agentScript, "--", envCapturePath] },
      mcpServers: [],
      clientVersion: "test",
    },
  });
  try {
    const opened = new Promise<void>((resolve) => session.once(SESSION_DRIVER_EVENTS.agentSession, () => resolve()));
    await session.start();
    await opened;
    const captured = JSON.parse(fs.readFileSync(envCapturePath, "utf8")) as { CODEX_HOME: string | null };
    assert.ok(captured.CODEX_HOME !== null);
    assert.notEqual(path.resolve(captured.CODEX_HOME), path.resolve(realCodexHome));
    assert.equal(captured.CODEX_HOME.endsWith(path.join("agent-homes", "codex", "acp")), true);
    const generatedConfig = fs.readFileSync(path.join(captured.CODEX_HOME, "config.toml"), "utf8");
    assert.equal(generatedConfig.includes("[[hooks."), false, "ACP CODEX_HOME must not carry PTY status hooks");
    assert.equal(fs.existsSync(path.join(captured.CODEX_HOME, "auth.json")), true);
    assert.equal(fs.readFileSync(path.join(realCodexHome, "config.toml"), "utf8"), originalRealConfig);
  } finally {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    if (priorCodexHome !== undefined) process.env.CODEX_HOME = priorCodexHome;
    session.kill();
    await new Promise<void>((resolve) => session.once("exit", () => resolve()));
    session.destroy();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});
