import { CANCELLED_PERMISSION, CANCELLED_QUESTION, DECLINED_QUESTION, canOperatorDecide, permissionApprovalOf, permissionChoicesOf, permissionOutcomeFor, permissionOutcomeOfDecision, questionAnswerOf, questionAnswerOfDecision, questionApprovalOf, questionFormOf, saneYoloDenialOf, saneYoloPayloadsOf } from "./core/acp-ask-core.ts";
import type { AcpPermissionChoices } from "./core/acp-ask-core.ts";
import { CLAUDE_SANE_YOLO_FLAVOR } from "./core/sane-yolo.ts";
import { HOOK_TOOLS } from "./core/hook-tools.ts";
import type { ResolvedHookTool } from "./core/hook-tools.ts";
import { withoutGlimmervoidSecrets } from "./core/spawn-env.ts";
import { runHookTool } from "./hook-tool-relay.ts";
import { saneYoloHomeDir } from "../server/hook-tools.ts";
import type { DriverPermissionOutcome, DriverPermissionRequest, DriverQuestion } from "./drivers/driver.ts";
import type { SessionApprovalHolds } from "./session-approval-holds.ts";
import type { ConversationAnswers, PermissionDecision } from "../shared/contracts/session.ts";

interface DriverAsksOptions {
  agentId: string;
  logName: () => string;
  cwd: () => string;
  saneYoloTool: () => ResolvedHookTool | undefined;
  holds: Pick<SessionApprovalHolds<never>, "holdDriverAsk">;
  raisePermission(request: DriverPermissionRequest): DriverPermissionRequest;
  raiseQuestion(question: DriverQuestion): DriverQuestion;
}

interface DriverAsks {
  takePermission(request: DriverPermissionRequest): void;
  takeQuestion(question: DriverQuestion): void;
  cancelOpenAsks(): void;
}

interface OpenAsk<Answer> {
  respond(answer: Answer): void;
  answered: AbortSignal;
  cancelThrough(respond: (answer: Answer) => void): void;
}

async function saneYoloDenialFor(tool: ResolvedHookTool, payloads: readonly Record<string, unknown>[], cwd: string): Promise<string | null> {
  const env = withoutGlimmervoidSecrets({ ...process.env, ...HOOK_TOOLS.saneYolo.env(tool, saneYoloHomeDir()) });
  for (const payload of payloads) {
    const hookOutput = await runHookTool(tool.binPath, Buffer.from(JSON.stringify(payload), "utf8"), CLAUDE_SANE_YOLO_FLAVOR, { env, cwd });
    const denialReason = saneYoloDenialOf(hookOutput);
    if (denialReason !== null) return denialReason;
  }
  return null;
}

function createDriverAsks(options: DriverAsksOptions): DriverAsks {
  const cancelOfOpenAsk = new Set<{ cancel: () => void }>();

  function openAsk<Answer>(respondToAgent: (answer: Answer) => void, cancelAnswer: Answer, withdrawn: AbortSignal): OpenAsk<Answer> {
    const answered = new AbortController();
    const entry = { cancel: () => respond(cancelAnswer) };
    function respond(answer: Answer): void {
      if (answered.signal.aborted) return;
      answered.abort();
      cancelOfOpenAsk.delete(entry);
      respondToAgent(answer);
    }
    cancelOfOpenAsk.add(entry);
    if (withdrawn.aborted) entry.cancel();
    withdrawn.addEventListener("abort", () => entry.cancel(), { once: true });
    return {
      respond,
      answered: answered.signal,
      cancelThrough: (outermostRespond) => { entry.cancel = () => outermostRespond(cancelAnswer); },
    };
  }

  function holdPermission(request: DriverPermissionRequest, open: OpenAsk<DriverPermissionOutcome>, choices: AcpPermissionChoices): void {
    const raised = options.raisePermission({ ...request, respond: open.respond });
    open.cancelThrough(raised.respond);
    if (open.answered.aborted) return;
    const replies = { toAnswers: () => null, toDecision: (decision: PermissionDecision) => permissionOutcomeOfDecision(choices, decision) };
    void options.holds.holdDriverAsk((requestId) => permissionApprovalOf(request, requestId), replies, open.answered)
      .then((outcome) => raised.respond(outcome ?? CANCELLED_PERMISSION));
  }

  function takePermission(request: DriverPermissionRequest): void {
    const open = openAsk(request.respond, CANCELLED_PERMISSION, request.withdrawn);
    if (open.answered.aborted) return;
    const choices = permissionChoicesOf(options.agentId, request.options);
    if (!canOperatorDecide(choices)) {
      open.respond(permissionOutcomeFor(choices, "deny"));
      return;
    }
    const saneYoloTool = options.saneYoloTool();
    const payloads = saneYoloTool === undefined ? [] : saneYoloPayloadsOf(request, options.cwd());
    if (saneYoloTool === undefined || payloads.length === 0) {
      holdPermission(request, open, choices);
      return;
    }
    void saneYoloDenialFor(saneYoloTool, payloads, options.cwd()).then((denialReason) => {
      if (open.answered.aborted) return;
      if (denialReason === null) {
        holdPermission(request, open, choices);
        return;
      }
      console.warn(`[session:${options.logName()}] Sane YOLO denied ${request.title ?? request.toolCallId}: ${denialReason.split("\n").find((line) => line.startsWith("Reason:")) ?? denialReason}`);
      open.respond(permissionOutcomeFor(choices, "deny"));
    });
  }

  function takeQuestion(question: DriverQuestion): void {
    const open = openAsk(question.respond, CANCELLED_QUESTION, question.withdrawn);
    if (open.answered.aborted) return;
    const form = questionFormOf(options.agentId, question);
    if (form === null) {
      open.respond(DECLINED_QUESTION);
      return;
    }
    const raised = options.raiseQuestion({ ...question, respond: open.respond });
    open.cancelThrough(raised.respond);
    if (open.answered.aborted) return;
    const replies = { toAnswers: (answers: ConversationAnswers) => questionAnswerOf(form, answers), toDecision: questionAnswerOfDecision };
    void options.holds.holdDriverAsk((requestId) => questionApprovalOf(form, requestId), replies, open.answered)
      .then((answer) => raised.respond(answer ?? CANCELLED_QUESTION));
  }

  function cancelOpenAsks(): void {
    for (const entry of [...cancelOfOpenAsk]) entry.cancel();
  }

  return { takePermission, takeQuestion, cancelOpenAsks };
}

export { createDriverAsks };
export type { DriverAsks };
