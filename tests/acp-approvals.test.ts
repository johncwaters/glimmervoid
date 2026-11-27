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

test("Codex over ACP does not claim saneYolo active even when Sane YOLO is configured", { timeout: 30_000 }, async () => {
  const replay = await replayWithOperator("codex", CODEX_PERMISSIONS, decideInOrder(ALLOW_ALLOW_DENY), {
    hookTools: resolveHookTools({}),
  });
  assert.equal(replay.saneYoloWhileLive, false);
  assert.equal(replay.saneYoloAfterExit, false);
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
