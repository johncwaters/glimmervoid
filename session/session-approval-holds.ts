import { ASK_USER_QUESTION_TOOL_NAME, REQUEST_USER_INPUT_TOOL_NAME } from "../shared/contracts/session.ts";
import type { ConversationAnswers, ConversationApproval, ConversationQuestion } from "../shared/contracts/session.ts";
import { MANAGER_DECISION_AUDIT_KIND, MANAGER_DECISION_EVENT, QUESTION_TOOL_HOLD_HOOK_EVENT } from "../shared/contracts/question-manager.ts";
import type { ManagerAnswer, ManagerDecision, ManagerVerdict } from "../shared/contracts/question-manager.ts";
import type { QuestionToolDenyResponse } from "../shared/contracts/refocus.ts";
import { questionToolDenyReason } from "../server/question-manager/core/question-manager-core.ts";
import { claudeAnswerReply, claudeApprovalFor, isHoldReleasedByHookEvent, parseClaudePermissionRequest, TOOL_RESULT_HOOK_EVENTS } from "./core/claude-approval-core.ts";
import type { ClaudeHookReply, ClaudePermissionRequest } from "./core/claude-approval-core.ts";

interface ClaudeApprovalHold {
  request: ClaudePermissionRequest;
  approval: ConversationApproval;
  resolve: (reply: ClaudeHookReply | null) => void;
}

interface ApprovalPort<Signal extends QuestionStatusSignal> {
  emit: (event: string, detail: Record<string, unknown>) => void;
  ingestStatus: (signal: Signal) => void;
  pushAuditEntry: (entry: Record<string, unknown>) => void;
  taskTitle: () => string | null;
}

interface QuestionStatusSignal {
  signal: string;
  promptToolName?: string;
  payload?: Record<string, unknown>;
}

interface ParkedQuestionStatus<Signal> {
  signal: Signal;
  request: ClaudePermissionRequest;
  timer: NodeJS.Timeout;
}

interface SettledQuestion {
  request: ClaudePermissionRequest;
  isAnswered: boolean;
}

interface QuestionManagerPort {
  mightAnswer(): boolean;
  decide(questions: readonly ConversationQuestion[] | null, context: { taskTitle: string | null; signal: AbortSignal }): Promise<ManagerVerdict | null>;
}

interface SessionApprovalHoldsOptions<Signal extends QuestionStatusSignal> {
  agentId: string;
  holdsQuestionsForParent: boolean;
  questionManager: QuestionManagerPort | null;
  port: ApprovalPort<Signal>;
}

const QUESTION_STATUS_PARK_MS = 2_000;
const QUESTION_TOOL_NAMES: ReadonlySet<string> = new Set([ASK_USER_QUESTION_TOOL_NAME, REQUEST_USER_INPUT_TOOL_NAME]);

function questionCallKey(request: ClaudePermissionRequest): string {
  return `${request.agentKey}:${JSON.stringify(request.toolInput)}`;
}

interface SessionApprovalHolds<Signal extends QuestionStatusSignal> {
  readonly conversationApproval: ConversationApproval | null;
  readonly latestManagerDecisionSeq: number;
  hold(payload: unknown, abandoned: AbortSignal): Promise<ClaudeHookReply | null> | null;
  holdQuestionTool(payload: unknown, abandoned: AbortSignal): Promise<QuestionToolDenyResponse | null> | null;
  parksQuestionStatus(signal: Signal): boolean;
  releaseAfterHookEvent(event: string, payload: Record<string, unknown>): void;
  releaseAll(): void;
  yieldManagerDecisions(): void;
  answer(requestId: number | string, answers: ConversationAnswers): boolean;
  release(requestId: string): boolean;
}

function createSessionApprovalHolds<Signal extends QuestionStatusSignal>({ agentId, holdsQuestionsForParent, questionManager, port }: SessionApprovalHoldsOptions<Signal>): SessionApprovalHolds<Signal> {
  let conversationApproval: ConversationApproval | null = null;
  let holds: ClaudeApprovalHold[] = [];
  let nextApprovalNumber = 1;
  const decidingCountByCall = new Map<string, number>();
  const parkedStatusByCall = new Map<string, ParkedQuestionStatus<Signal>>();
  const settledQuestionByCall = new Map<string, SettledQuestion>();
  const pendingApprovalByOperatorYield = new Map<AbortController, ConversationApproval>();
  let managerDecisionCount = 0;

  function isManagerHolding(): boolean {
    return !holdsQuestionsForParent && questionManager !== null && questionManager.mightAnswer();
  }

  function parksQuestionStatus(signal: Signal): boolean {
    if (signal.signal !== "awaiting-input") return false;
    const request = parseClaudePermissionRequest(signal.payload);
    if (!request || !QUESTION_TOOL_NAMES.has(request.toolName)) return false;
    const callKey = questionCallKey(request);
    const settled = settledQuestionByCall.get(callKey);
    if (settled) {
      settledQuestionByCall.delete(callKey);
      return settled.isAnswered;
    }
    if (!decidingCountByCall.has(callKey) && !isManagerHolding()) return false;
    discardParkedStatus(callKey);
    const timer = setTimeout(() => {
      if (!decidingCountByCall.has(callKey)) flushParkedStatus(callKey);
    }, QUESTION_STATUS_PARK_MS);
    timer.unref();
    parkedStatusByCall.set(callKey, { signal, request, timer });
    return true;
  }

  function discardParkedStatus(callKey: string): ParkedQuestionStatus<Signal> | null {
    const parked = parkedStatusByCall.get(callKey);
    if (!parked) return null;
    clearTimeout(parked.timer);
    parkedStatusByCall.delete(callKey);
    return parked;
  }

  function flushParkedStatus(callKey: string): void {
    const parked = discardParkedStatus(callKey);
    if (parked) port.ingestStatus(parked.signal);
  }

  function startDeciding(callKey: string): void {
    decidingCountByCall.set(callKey, (decidingCountByCall.get(callKey) ?? 0) + 1);
  }

  function finishDeciding(callKey: string): void {
    const remaining = (decidingCountByCall.get(callKey) ?? 1) - 1;
    if (remaining > 0) {
      decidingCountByCall.set(callKey, remaining);
      return;
    }
    decidingCountByCall.delete(callKey);
  }

  function settleQuestionStatus(request: ClaudePermissionRequest, isAnswered: boolean): void {
    const callKey = questionCallKey(request);
    finishDeciding(callKey);
    if (!parkedStatusByCall.has(callKey)) {
      settledQuestionByCall.set(callKey, { request, isAnswered });
      return;
    }
    if (isAnswered) {
      discardParkedStatus(callKey);
      return;
    }
    flushParkedStatus(callKey);
  }

  function isQuestionPassedBy(request: ClaudePermissionRequest, event: string, payload: Record<string, unknown>): boolean {
    const normalizedEvent = event.toLowerCase();
    const eventRequest = parseClaudePermissionRequest(payload);
    const isSameCall = eventRequest !== null && questionCallKey(eventRequest) === questionCallKey(request);
    if (isSameCall && !TOOL_RESULT_HOOK_EVENTS.has(normalizedEvent)) return false;
    return isHoldReleasedByHookEvent(request, normalizedEvent, payload);
  }

  function forgetPassedQuestions(event: string, payload: Record<string, unknown>): void {
    if (event.toLowerCase() === QUESTION_TOOL_HOLD_HOOK_EVENT) return;
    for (const [callKey, parked] of parkedStatusByCall) {
      if (isQuestionPassedBy(parked.request, event, payload)) discardParkedStatus(callKey);
    }
    for (const [callKey, settled] of settledQuestionByCall) {
      if (isQuestionPassedBy(settled.request, event, payload)) settledQuestionByCall.delete(callKey);
    }
  }

  function recordManagerDecision(decision: ManagerDecision): void {
    port.pushAuditEntry(decision);
    port.emit(MANAGER_DECISION_EVENT, { decision });
  }

  function nextDecisionHeader() {
    managerDecisionCount += 1;
    return { kind: MANAGER_DECISION_AUDIT_KIND, seq: managerDecisionCount, ts: Date.now() } as const;
  }

  function recordManagerAnswer(verdict: ManagerAnswer): void {
    recordManagerDecision({ ...nextDecisionHeader(), outcome: "answered", by: verdict.by, rule: verdict.ruleName, answers: verdict.answers });
  }

  function recordManagerEscalation(approval: ConversationApproval, reason: string): void {
    const questions = (approval.questions ?? []).map((question) => question.question);
    recordManagerDecision({ ...nextDecisionHeader(), outcome: "escalated", questions, reason });
  }

  function replyFromVerdict(request: ClaudePermissionRequest, approval: ConversationApproval, verdict: ManagerVerdict | null): ClaudeHookReply | null {
    if (verdict === null) return null;
    if (verdict.kind === "escalate") {
      recordManagerEscalation(approval, verdict.reason);
      return null;
    }
    const reply = claudeAnswerReply(request, approval, verdict.answers);
    if (!reply) {
      recordManagerEscalation(approval, "the answer did not cover every question");
      return null;
    }
    recordManagerAnswer(verdict);
    return reply;
  }

  function holdForManager<Reply>(
    manager: QuestionManagerPort,
    request: ClaudePermissionRequest,
    abandoned: AbortSignal,
    replyFor: (approval: ConversationApproval, verdict: ManagerVerdict | null) => Reply | null,
  ): Promise<Reply | null> {
    const approval = claudeApprovalFor(request, `manager-${nextApprovalNumber}`);
    nextApprovalNumber += 1;
    startDeciding(questionCallKey(request));
    const operatorYield = new AbortController();
    pendingApprovalByOperatorYield.set(operatorYield, approval);
    const decisionSignal = AbortSignal.any([abandoned, operatorYield.signal]);
    const stopped = new Promise<null>((resolve) => {
      if (decisionSignal.aborted) resolve(null);
      decisionSignal.addEventListener("abort", () => resolve(null), { once: true });
    });
    const decided = manager.decide(approval.questions ?? null, { taskTitle: port.taskTitle(), signal: decisionSignal }).catch(() => null);
    return Promise.race([decided, stopped])
      .then((verdict) => (decisionSignal.aborted ? null : replyFor(approval, verdict)))
      .then((reply) => {
        pendingApprovalByOperatorYield.delete(operatorYield);
        settleQuestionStatus(request, reply !== null);
        return reply;
      });
  }

  function yieldManagerDecisions(): void {
    for (const [operatorYield, approval] of pendingApprovalByOperatorYield) {
      recordManagerEscalation(approval, "you typed in the session first");
      operatorYield.abort();
    }
    pendingApprovalByOperatorYield.clear();
  }

  function denyReplyFromVerdict(approval: ConversationApproval, verdict: ManagerVerdict | null): QuestionToolDenyResponse | null {
    if (verdict === null) return null;
    if (verdict.kind === "escalate") {
      recordManagerEscalation(approval, verdict.reason);
      return null;
    }
    const questionTexts = (approval.questions ?? []).map((question) => question.question);
    if (questionTexts.length === 0 || questionTexts.some((question) => verdict.answers[question] === undefined)) {
      recordManagerEscalation(approval, "the answer did not cover every question");
      return null;
    }
    recordManagerAnswer(verdict);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: questionToolDenyReason(verdict) } };
  }

  function holdQuestionTool(payload: unknown, abandoned: AbortSignal): Promise<QuestionToolDenyResponse | null> | null {
    if (agentId === "claude-code") return null;
    const request = parseClaudePermissionRequest(payload);
    if (!request || !QUESTION_TOOL_NAMES.has(request.toolName)) return null;
    if (!questionManager || !isManagerHolding()) return null;
    return holdForManager(questionManager, request, abandoned, denyReplyFromVerdict);
  }

  function setConversationApproval(approval: ConversationApproval | null): void {
    conversationApproval = approval;
    emitConversationChange();
  }

  function emitConversationChange(): void {
    port.emit("conversation-change", { conversationApproval });
  }

  function hold(payload: unknown, abandoned: AbortSignal): Promise<ClaudeHookReply | null> | null {
    if (agentId !== "claude-code") return null;
    const request = parseClaudePermissionRequest(payload);
    if (!request) return null;
    if (request.toolName !== ASK_USER_QUESTION_TOOL_NAME) return null;
    if (!holdsQuestionsForParent) return questionManager && isManagerHolding() ? holdForManager(questionManager, request, abandoned, (approval, verdict) => replyFromVerdict(request, approval, verdict)) : null;
    releaseHolds((hold) => hold.request.agentKey === request.agentKey);
    const requestId = `claude-${nextApprovalNumber}`;
    nextApprovalNumber += 1;
    return new Promise((resolve) => {
      const hold: ClaudeApprovalHold = { request, approval: claudeApprovalFor(request, requestId), resolve };
      holds.push(hold);
      abandoned.addEventListener("abort", () => releaseHolds((candidate) => candidate === hold), { once: true });
      showFirstApproval();
    });
  }

  function releaseAfterHookEvent(event: string, payload: Record<string, unknown>): void {
    forgetPassedQuestions(event, payload);
    if (holds.length === 0) return;
    releaseHolds((hold) => isHoldReleasedByHookEvent(hold.request, event, payload));
  }

  function releaseHolds(isReleased: (hold: ClaudeApprovalHold) => boolean): void {
    const released = holds.filter(isReleased);
    if (released.length === 0) return;
    holds = holds.filter((hold) => !released.includes(hold));
    for (const hold of released) hold.resolve(null);
    showFirstApproval();
  }

  function showFirstApproval(): void {
    setConversationApproval(holds[0]?.approval ?? null);
  }

  function answer(requestId: number | string, answers: ConversationAnswers): boolean {
    const hold = holds.find((candidate) => candidate.approval.requestId === requestId);
    if (!hold) return false;
    const reply = claudeAnswerReply(hold.request, hold.approval, answers);
    if (!reply) return false;
    holds = holds.filter((candidate) => candidate !== hold);
    hold.resolve(reply);
    showFirstApproval();
    return true;
  }

  function release(requestId: string): boolean {
    const hold = holds.find((candidate) => candidate.approval.requestId === requestId);
    if (!hold) return false;
    releaseHolds((candidate) => candidate === hold);
    return true;
  }

  function releaseAll(): void {
    releaseHolds(() => true);
    for (const callKey of [...parkedStatusByCall.keys()]) discardParkedStatus(callKey);
    settledQuestionByCall.clear();
  }

  return {
    get conversationApproval() { return conversationApproval; },
    get latestManagerDecisionSeq() { return managerDecisionCount; },
    hold,
    holdQuestionTool,
    yieldManagerDecisions,
    parksQuestionStatus,
    releaseAfterHookEvent,
    releaseAll,
    answer,
    release,
  };
}

export { createSessionApprovalHolds };
export type { QuestionManagerPort, SessionApprovalHolds };
