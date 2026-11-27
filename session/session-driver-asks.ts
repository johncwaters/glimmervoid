import { CANCELLED_PERMISSION, CANCELLED_QUESTION, DECLINED_QUESTION, canOperatorDecide, doesQuestionSurviveTurnEnd, isPlanExitPermission, permissionApprovalOf, permissionChoicesOf, permissionOutcomeFor, permissionOutcomeOfDecision, questionAnswerOf, questionAnswerOfDecision, questionApprovalOf, questionFormOf, saneYoloDenialOf, saneYoloPayloadsOf } from "./core/acp-ask-core.ts";
import type { AcpPermissionChoices } from "./core/acp-ask-core.ts";
import { CLAUDE_SANE_YOLO_FLAVOR, saneYoloHostFlag } from "./core/sane-yolo.ts";
import { HOOK_TOOLS } from "./core/hook-tools.ts";
import type { ResolvedHookTool } from "./core/hook-tools.ts";
import { withoutGlimmervoidSecrets } from "./core/spawn-env.ts";
import { spawn } from "../server/child-process-safe.ts";
import { scriptLaunch } from "../server/runtime-paths.ts";
import { saneYoloHomeDir } from "../server/hook-tools.ts";
import type { DriverPermissionOutcome, DriverPermissionRequest, DriverQuestion } from "./drivers/driver.ts";
import type { SessionApprovalHolds } from "./session-approval-holds.ts";
import type { ConversationAnswers, PermissionDecision } from "../shared/contracts/session.ts";

interface DriverAsksOptions {
  agentId: string;
  logName: () => string;
  cwd: () => string;
  skipPermissions: () => boolean;
  saneYoloTool: () => ResolvedHookTool | undefined;
  holds: Pick<SessionApprovalHolds<never>, "holdDriverAsk">;
  raisePermission(request: DriverPermissionRequest): DriverPermissionRequest;
  raiseQuestion(question: DriverQuestion): DriverQuestion;
}

interface DriverAsks {
  takePermission(request: DriverPermissionRequest): void;
  takeQuestion(question: DriverQuestion): void;
  cancelTurnAsks(): number;
  cancelOpenAsks(): void;
}

interface OpenAsk<Answer> {
  respond(answer: Answer): void;
  answered: AbortSignal;
  cancelThrough(respond: (answer: Answer) => void): void;
  markHeldForOperator(): void;
}

type SaneYoloJudgement =
  | { kind: "allowed" }
  | { kind: "denied"; reason: string }
  | { kind: "error"; reason: string };

type SaneYoloRunOutcome = { ok: true; stdout: string } | { ok: false; reason: string };

const SANE_YOLO_TIMEOUT_MS = 3000;
const SANE_YOLO_MAX_STDOUT_BYTES = 65536;

function runSaneYoloProcess(binPath: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string): Promise<SaneYoloRunOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const done = (runOutcome: SaneYoloRunOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(runOutcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      const [launcher, ...launchArguments] = scriptLaunch(binPath, "cc-safety-net", process.execPath);
      child = spawn(launcher, [...launchArguments, "hook", saneYoloHostFlag(CLAUDE_SANE_YOLO_FLAVOR)], { env, cwd, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      done({ ok: false, reason: "Sane YOLO failed to spawn" });
      return;
    }
    const childStdout = child.stdout;
    const childStdin = child.stdin;
    if (!childStdout || !childStdin) {
      try { child.kill(); } catch {}
      done({ ok: false, reason: "Sane YOLO had no stdio pipes" });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ ok: false, reason: "Sane YOLO timed out" });
    }, SANE_YOLO_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    childStdout.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > SANE_YOLO_MAX_STDOUT_BYTES) {
        try { child.kill(); } catch {}
        done({ ok: false, reason: "Sane YOLO output exceeded limit" });
        return;
      }
      chunks.push(bytes);
    });
    childStdout.on("error", () => done({ ok: false, reason: "Sane YOLO stdout failed" }));
    child.on("error", () => done({ ok: false, reason: "Sane YOLO process failed" }));
    child.on("close", (code) => {
      if (code !== 0) return done({ ok: false, reason: `Sane YOLO exited with code ${String(code)}` });
      done({ ok: true, stdout: Buffer.concat(chunks).toString("utf8") });
    });
    childStdin.on("error", () => {});
    try {
      childStdin.end(Buffer.from(JSON.stringify(payload), "utf8"));
    } catch {
      done({ ok: false, reason: "Sane YOLO stdin write failed" });
    }
  });
}

async function judgeSaneYolo(tool: ResolvedHookTool, payloads: readonly Record<string, unknown>[], cwd: string): Promise<SaneYoloJudgement> {
  const env = withoutGlimmervoidSecrets({ ...process.env, ...HOOK_TOOLS.saneYolo.env(tool, saneYoloHomeDir()) });
  for (const payload of payloads) {
    const run = await runSaneYoloProcess(tool.binPath, payload, env, cwd);
    if (!run.ok) return { kind: "error", reason: run.reason };
    const denialReason = saneYoloDenialOf(run.stdout);
    if (denialReason !== null) return { kind: "denied", reason: denialReason };
  }
  return { kind: "allowed" };
}

type AskLifecycle = "turn" | "async-pending" | "async-held";

function createDriverAsks(options: DriverAsksOptions): DriverAsks {
  const cancelOfOpenAsk = new Set<{ cancel: () => void; lifecycle: AskLifecycle }>();

  function openAsk<Answer>(respondToAgent: (answer: Answer) => void, cancelAnswer: Answer, withdrawn: AbortSignal, initialLifecycle: AskLifecycle = "turn"): OpenAsk<Answer> {
    const answered = new AbortController();
    const entry = { cancel: () => respond(cancelAnswer), lifecycle: initialLifecycle };
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
      markHeldForOperator: () => { if (entry.lifecycle === "async-pending") entry.lifecycle = "async-held"; },
    };
  }

  function holdPermissionForOperator(request: DriverPermissionRequest, open: OpenAsk<DriverPermissionOutcome>, choices: AcpPermissionChoices): void {
    open.markHeldForOperator();
    const raised = options.raisePermission({ ...request, respond: open.respond });
    open.cancelThrough(raised.respond);
    if (open.answered.aborted) return;
    const replies = { toAnswers: () => null, toDecision: (decision: PermissionDecision) => permissionOutcomeOfDecision(choices, decision) };
    void options.holds.holdDriverAsk((requestId) => permissionApprovalOf(request, requestId), replies, open.answered)
      .then((outcome) => raised.respond(outcome ?? CANCELLED_PERMISSION));
  }

  function settleAllowedPermission(request: DriverPermissionRequest, open: OpenAsk<DriverPermissionOutcome>, choices: AcpPermissionChoices, canAutoAllow: boolean): void {
    if (canAutoAllow && options.skipPermissions() && !isPlanExitPermission(choices)) {
      open.respond(permissionOutcomeFor(choices, "allow"));
      return;
    }
    holdPermissionForOperator(request, open, choices);
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
    if (saneYoloTool === undefined) {
      settleAllowedPermission(request, open, choices, true);
      return;
    }
    const payloads = saneYoloPayloadsOf(request, options.cwd());
    if (payloads.length === 0) {
      settleAllowedPermission(request, open, choices, false);
      return;
    }
    void judgeSaneYolo(saneYoloTool, payloads, options.cwd()).then((judgement) => {
      if (open.answered.aborted) return;
      if (judgement.kind === "allowed") {
        settleAllowedPermission(request, open, choices, true);
        return;
      }
      if (judgement.kind === "error") {
        console.warn(`[session:${options.logName()}] Sane YOLO could not judge ${request.title ?? request.toolCallId} (${judgement.reason}); holding for operator`);
        holdPermissionForOperator(request, open, choices);
        return;
      }
      console.warn(`[session:${options.logName()}] Sane YOLO denied ${request.title ?? request.toolCallId}: ${judgement.reason.split("\n").find((line) => line.startsWith("Reason:")) ?? judgement.reason}`);
      open.respond(permissionOutcomeFor(choices, "deny"));
    });
  }

  function takeQuestion(question: DriverQuestion): void {
    const initialLifecycle: AskLifecycle = doesQuestionSurviveTurnEnd(options.agentId, question.toolCallId) ? "async-pending" : "turn";
    const open = openAsk(question.respond, CANCELLED_QUESTION, question.withdrawn, initialLifecycle);
    if (open.answered.aborted) return;
    const form = questionFormOf(options.agentId, question);
    if (form === null) {
      open.respond(DECLINED_QUESTION);
      return;
    }
    let respondForAsk = open.respond;
    const replies = { toAnswers: (answers: ConversationAnswers) => questionAnswerOf(form, answers), toDecision: questionAnswerOfDecision };
    const onHeldForOperator = (): void => {
      if (open.answered.aborted) return;
      open.markHeldForOperator();
      const raised = options.raiseQuestion({ ...question, respond: open.respond });
      respondForAsk = raised.respond;
      open.cancelThrough(raised.respond);
    };
    void options.holds.holdDriverAsk((requestId) => questionApprovalOf(form, requestId), replies, open.answered, { onHeldForOperator })
      .then((answer) => respondForAsk(answer ?? CANCELLED_QUESTION));
  }

  function cancelTurnAsks(): number {
    let survivingHeldCount = 0;
    for (const entry of [...cancelOfOpenAsk]) {
      if (entry.lifecycle === "turn") {
        entry.cancel();
        continue;
      }
      if (entry.lifecycle === "async-held") survivingHeldCount += 1;
    }
    return survivingHeldCount;
  }

  function cancelOpenAsks(): void {
    for (const entry of [...cancelOfOpenAsk]) entry.cancel();
  }

  return { takePermission, takeQuestion, cancelTurnAsks, cancelOpenAsks };
}

export { createDriverAsks };
export type { DriverAsks };
