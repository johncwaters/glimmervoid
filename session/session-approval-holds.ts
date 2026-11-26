import { ASK_USER_QUESTION_TOOL_NAME, REQUEST_USER_INPUT_TOOL_NAME } from "../shared/contracts/session.ts";
import type { ChatApprovalMode, ConversationAnswers, ConversationApproval, ConversationQuestion, PermissionDecision } from "../shared/contracts/session.ts";
import { MANAGER_DECISION_AUDIT_KIND, MANAGER_DECISION_EVENT, QUESTION_TOOL_HOLD_HOOK_EVENT } from "../shared/contracts/question-manager.ts";
import type { ManagerAnswer, ManagerDecision, ManagerVerdict } from "../shared/contracts/question-manager.ts";
import type { QuestionDenyReply, QuestionToolDenyResponse } from "../shared/contracts/refocus.ts";
import { operatorAnswerDenyReason, questionToolDenyReason } from "../server/question-manager/core/question-manager-core.ts";
import { areAnswersComplete, claudeAnswerReply, claudeApprovalFor, DISMISSED_FROM_CHAT, claudePermissionApprovalFor, isHoldReleasedByHookEvent, isReadOnlyCommandRequest, permissionReplyFor, parseClaudePermissionRequest, questionDismissedReply, TOOL_RESULT_HOOK_EVENTS } from "./core/claude-approval-core.ts";
import type { ClaudeHookReply, ClaudePermissionRequest, PermissionHookReply } from "./core/claude-approval-core.ts";
import { elicitationApprovalOf, elicitationContentOf, elicitationReply, elicitationRequestOf, isElicitationHoldReleasedBy } from "./core/claude-elicitation-core.ts";
import type { ElicitationHookReply } from "./core/claude-elicitation-core.ts";
import type { ElicitationRequest } from "../shared/contracts/session.ts";
import { clock } from '../shared/clock.ts';
import type { PlanDecision, PlanGate } from "../shared/contracts/plan-gate.ts";
import { claudePlanDecisionReply, isExitPlanModeTool, nextPlanGate, planTextOfToolInput, shouldClearPlanGate } from "./core/plan-gate-core.ts";
import type { PlanGateEvent } from "./core/plan-gate-core.ts";

interface ChatHoldKind<Reply> {
  toAnswers(approval: ConversationApproval, answers: ConversationAnswers): Reply | null;
  toDecision(approval: ConversationApproval, decision: PermissionDecision, denyMessage: string | null): Reply | null;
  isReleasedBy(event: string, payload: Record<string, unknown>): boolean;
  didHold(): void;
  didSettle(): void;
  didDismissQuestion(): void;
}

interface DriverAskReplies<Reply> {
  toAnswers(answers: ConversationAnswers): Reply | null;
  toDecision(decision: PermissionDecision): Reply | null;
}

interface ClaudeApprovalHold {
  request: ClaudePermissionRequest;
  approval: ConversationApproval;
  isReleasedBy(event: string, payload: Record<string, unknown>): boolean;
  settleWithAnswers(answers: ConversationAnswers): boolean;
  settleWithDecision(decision: PermissionDecision, denyMessage: string | null): boolean;
  didDismissQuestion(): void;
  release(): void;
}

interface ApprovalPort<Signal extends QuestionStatusSignal> {
  emit: (event: string, detail: Record<string, unknown>) => void;
  ingestStatus: (signal: Signal) => void;
  noteQuestionDismissed: () => void;
  pushAuditEntry: (entry: Record<string, unknown>) => void;
  noteHeldForChat: (toolName: string, payload: Record<string, unknown>) => void;
  noteAnsweredFromChat: () => void;
  notePassedQuestion: (seq: number) => void;
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
}

interface SettledQuestion {
  request: ClaudePermissionRequest;
  isAnswered: boolean;
}

interface QuestionManagerPort {
  readonly isOn: boolean;
  setOn(isOn: boolean): void;
  mightAnswer(): boolean;
  decide(questions: readonly ConversationQuestion[] | null, context: { taskTitle: string | null; signal: AbortSignal }): Promise<ManagerVerdict | null>;
}

interface SessionApprovalHoldsOptions<Signal extends QuestionStatusSignal> {
  agentId: string;
  questionDenyReply: QuestionDenyReply;
  holdsQuestionsForParent: boolean;
  readChatApprovals: () => ChatApprovalMode;
  questionManager: QuestionManagerPort | null;
  port: ApprovalPort<Signal>;
}

const ELICITATION_TOOL_NAME = "Elicitation";
const DRIVER_ASK_TOOL_NAME = "driver-ask";

function agentKeyOfPayload(payload: unknown): string {
  const agentId = typeof payload === "object" && payload !== null && "agent_id" in payload ? payload.agent_id : null;
  return typeof agentId === "string" ? agentId : "";
}

const QUESTION_TOOL_OWN_HOOK_EVENTS: ReadonlySet<string> = new Set(["pretooluse", QUESTION_TOOL_HOLD_HOOK_EVENT, "elicitation"]);
const QUESTION_TOOL_NAMES: ReadonlySet<string> = new Set([ASK_USER_QUESTION_TOOL_NAME, REQUEST_USER_INPUT_TOOL_NAME]);

function questionCallKey(request: ClaudePermissionRequest): string {
  return `${request.agentKey}:${JSON.stringify(request.toolInput)}`;
}

interface PlanHold {
  request: ClaudePermissionRequest;
  resolve: (reply: ClaudeHookReply | null) => void;
}

interface SessionApprovalHolds<Signal extends QuestionStatusSignal> {
  readonly conversationApproval: ConversationApproval | null;
  readonly planGate: PlanGate | null;
  holdPlan(payload: unknown, abandoned: AbortSignal, isPlanGateOn: boolean): Promise<ClaudeHookReply | null> | null;
  proposePlan(planText: string): void;
  decidePlan(decision: PlanDecision, feedback: string | null): { ok: true; isHeld: boolean } | { ok: false; reason: string };
  readonly latestManagerDecisionSeq: number;
  hold(payload: unknown, abandoned: AbortSignal): Promise<PermissionHookReply | null> | null;
  holdQuestionTool(payload: unknown, abandoned: AbortSignal): Promise<QuestionToolDenyResponse | null> | null;
  holdElicitation(payload: unknown, abandoned: AbortSignal): Promise<ElicitationHookReply | null> | null;
  holdDriverAsk<Reply>(approvalFor: (requestId: string) => ConversationApproval, replies: DriverAskReplies<Reply>, abandoned: AbortSignal): Promise<Reply | null>;
  parksQuestionStatus(signal: Signal): boolean;
  releaseAfterHookEvent(event: string, payload: Record<string, unknown>): void;
  releaseAll(): void;
  yieldManagerDecisions(): void;
  answer(requestId: number | string, answers: ConversationAnswers): boolean;
  decide(requestId: number | string, decision: PermissionDecision, denyMessage: string | null): boolean;
  release(requestId: string): boolean;
}

function createSessionApprovalHolds<Signal extends QuestionStatusSignal>({ agentId, questionDenyReply, holdsQuestionsForParent, readChatApprovals, questionManager, port }: SessionApprovalHoldsOptions<Signal>): SessionApprovalHolds<Signal> {
  let conversationApproval: ConversationApproval | null = null;
  let holds: ClaudeApprovalHold[] = [];
  let nextApprovalNumber = 1;
  const decidingCountByCall = new Map<string, number>();
  const parkedStatusByCall = new Map<string, ParkedQuestionStatus<Signal>>();
  const settledQuestionByCall = new Map<string, SettledQuestion>();
  const pendingApprovalByOperatorYield = new Map<AbortController, ConversationApproval>();
  let managerDecisionCount = 0;
  let planGate: PlanGate | null = null;
  let planHold: PlanHold | null = null;

  function applyPlanEvent(event: PlanGateEvent): void {
    const next = nextPlanGate(planGate, event);
    if (next === planGate) return;
    planGate = next;
    port.emit("plan-gate-change", { planGate });
  }

  function releasePlanHold(): void {
    const released = planHold;
    if (released === null) return;
    planHold = null;
    applyPlanEvent({ kind: "cleared" });
    released.resolve(null);
  }

  function holdPlan(payload: unknown, abandoned: AbortSignal, isPlanGateOn: boolean): Promise<ClaudeHookReply | null> | null {
    if (agentId !== "claude-code") return null;
    if (!isPlanGateOn && readChatApprovals() === "off") return null;
    const request = parseClaudePermissionRequest(payload);
    if (!request || !isExitPlanModeTool(request.toolName) || request.agentKey !== "") return null;
    releasePlanHold();
    applyPlanEvent({ kind: "plan-proposed", planText: planTextOfToolInput(request.toolInput) });
    return new Promise((resolve) => {
      const hold: PlanHold = { request, resolve };
      planHold = hold;
      abandoned.addEventListener("abort", () => {
        if (planHold !== hold) return;
        planHold = null;
        applyPlanEvent({ kind: "cleared" });
        resolve(null);
      }, { once: true });
    });
  }

  function proposePlan(planText: string): void {
    applyPlanEvent({ kind: "plan-proposed", planText });
  }

  function decidePlan(decision: PlanDecision, feedback: string | null): { ok: true; isHeld: boolean } | { ok: false; reason: string } {
    if (planGate?.status !== "pending") return { ok: false, reason: "no plan is waiting for a decision" };
    const hold = planHold;
    planHold = null;
    if (decision === "terminal") {
      applyPlanEvent({ kind: "cleared" });
      hold?.resolve(null);
      return { ok: true, isHeld: hold !== null };
    }
    applyPlanEvent({ kind: "decided", decision, feedback });
    hold?.resolve(claudePlanDecisionReply(decision, planGate?.feedback ?? null));
    return { ok: true, isHeld: hold !== null };
  }

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
    parkedStatusByCall.set(callKey, { signal, request });
    return true;
  }

  function discardParkedStatus(callKey: string): ParkedQuestionStatus<Signal> | null {
    const parked = parkedStatusByCall.get(callKey);
    if (!parked) return null;
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

  function settleHoldWithoutManager(request: ClaudePermissionRequest): void {
    const callKey = questionCallKey(request);
    if (questionManager === null || decidingCountByCall.has(callKey)) return;
    if (parkedStatusByCall.has(callKey)) {
      flushParkedStatus(callKey);
      return;
    }
    settledQuestionByCall.set(callKey, { request, isAnswered: false });
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
    return { kind: MANAGER_DECISION_AUDIT_KIND, seq: managerDecisionCount, ts: clock.nowMs() } as const;
  }

  function recordManagerAnswer(verdict: ManagerAnswer): void {
    recordManagerDecision({ ...nextDecisionHeader(), outcome: "answered", by: verdict.by, rule: verdict.ruleName, answers: verdict.answers });
  }

  function recordManagerEscalation(approval: ConversationApproval, reason: string): void {
    const questions = (approval.questions ?? []).map((question) => question.question);
    const decision = { ...nextDecisionHeader(), outcome: "escalated" as const, questions, reason };
    recordManagerDecision(decision);
    port.notePassedQuestion(decision.seq);
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
    return questionToolDenyOf(questionToolDenyReason(verdict));
  }

  function questionToolDenyOf(denyReason: string): QuestionToolDenyResponse {
    if (questionDenyReply === "decision") return { decision: "deny", reason: denyReason };
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyReason } };
  }

  function questionToolHoldKindFor(request: ClaudePermissionRequest): ChatHoldKind<QuestionToolDenyResponse> {
    return {
      toAnswers: (approval, answers) => (areAnswersComplete(approval, answers) ? questionToolDenyOf(operatorAnswerDenyReason(answers)) : null),
      toDecision: (_approval, decision) => (decision === "deny" ? questionToolDenyOf(DISMISSED_FROM_CHAT) : null),
      isReleasedBy: (event, payload) => !QUESTION_TOOL_OWN_HOOK_EVENTS.has(event.toLowerCase()) && isHoldReleasedByHookEvent(request, event, payload),
      didHold: () => port.noteHeldForChat(request.toolName, { tool_name: request.toolName, tool_input: request.toolInput }),
      didSettle: port.noteAnsweredFromChat,
      didDismissQuestion: port.noteQuestionDismissed,
    };
  }

  function holdQuestionTool(payload: unknown, abandoned: AbortSignal): Promise<QuestionToolDenyResponse | null> | null {
    if (agentId === "claude-code") return null;
    const request = parseClaudePermissionRequest(payload);
    if (!request || !QUESTION_TOOL_NAMES.has(request.toolName)) return null;
    const managerReply = questionManager && isManagerHolding() ? holdForManager(questionManager, request, abandoned, denyReplyFromVerdict) : null;
    if (managerReply === null) settleHoldWithoutManager(request);
    if (readChatApprovals() === "off") return managerReply;
    const holdQuestionForChat = () => holdForChat(request, (requestId) => claudeApprovalFor(request, requestId), abandoned, questionToolHoldKindFor(request));
    if (managerReply === null) return holdQuestionForChat();
    return managerReply.then((reply) => (reply !== null || abandoned.aborted ? reply : holdQuestionForChat()));
  }

  function elicitationHoldKindFor(elicitation: ElicitationRequest): ChatHoldKind<ElicitationHookReply> {
    return {
      toAnswers: (_approval, answers) => {
        const content = elicitationContentOf(elicitation, answers);
        return content === null ? null : elicitationReply("accept", content);
      },
      toDecision: (_approval, decision) => {
        if (decision === "deny") return elicitationReply("decline");
        return elicitation.mode === "url" ? elicitationReply("accept") : null;
      },
      isReleasedBy: isElicitationHoldReleasedBy,
      didHold: () => port.noteHeldForChat(ELICITATION_TOOL_NAME, { tool_name: ELICITATION_TOOL_NAME, mcp_server_name: elicitation.serverName }),
      didSettle: port.noteAnsweredFromChat,
      didDismissQuestion: port.noteQuestionDismissed,
    };
  }

  function holdElicitation(payload: unknown, abandoned: AbortSignal): Promise<ElicitationHookReply | null> | null {
    if (agentId !== "claude-code" || readChatApprovals() === "off") return null;
    const elicitation = elicitationRequestOf(payload);
    if (elicitation === null) return null;
    const request: ClaudePermissionRequest = { toolName: `${ELICITATION_TOOL_NAME}:${elicitation.serverName}`, toolInput: {}, agentKey: agentKeyOfPayload(payload) };
    return holdForChat(request, (requestId) => elicitationApprovalOf(elicitation, requestId), abandoned, elicitationHoldKindFor(elicitation));
  }

  function setConversationApproval(approval: ConversationApproval | null): void {
    conversationApproval = approval;
    emitConversationChange();
  }

  function emitConversationChange(): void {
    port.emit("conversation-change", { conversationApproval });
  }

  function hold(payload: unknown, abandoned: AbortSignal): Promise<PermissionHookReply | null> | null {
    const request = parseClaudePermissionRequest(payload);
    if (!request) return null;
    if (request.toolName === ASK_USER_QUESTION_TOOL_NAME) return holdQuestion(request, abandoned);
    if (readChatApprovals() !== "questions-and-permissions" || isExitPlanModeTool(request.toolName) || isReadOnlyCommandRequest(request)) return null;
    return holdForChat(request, (requestId) => claudePermissionApprovalFor(request, requestId), abandoned, claudeRepliesFor(request));
  }


  function holdQuestion(request: ClaudePermissionRequest, abandoned: AbortSignal): Promise<PermissionHookReply | null> | null {
    if (agentId !== "claude-code") return null;
    if (holdsQuestionsForParent) return holdForChat(request, (requestId) => claudeApprovalFor(request, requestId), abandoned, claudeRepliesFor(request));
    const managerReply = questionManager && isManagerHolding() ? holdForManager(questionManager, request, abandoned, (approval, verdict) => replyFromVerdict(request, approval, verdict)) : null;
    if (managerReply === null) settleHoldWithoutManager(request);
    if (readChatApprovals() === "off") return managerReply;
    const holdQuestionForChat = () => holdForChat(request, (requestId) => claudeApprovalFor(request, requestId), abandoned, claudeRepliesFor(request));
    if (managerReply === null) return holdQuestionForChat();
    return managerReply.then((reply) => (reply !== null || abandoned.aborted ? reply : holdQuestionForChat()));
  }

  function claudeRepliesFor(request: ClaudePermissionRequest): ChatHoldKind<PermissionHookReply> {
    return {
      toAnswers: (approval, answers) => claudeAnswerReply(request, approval, answers),
      toDecision: decisionReplyOf,
      isReleasedBy: (event, payload) => isHoldReleasedByHookEvent(request, event, payload),
      didHold: () => {},
      didSettle: () => {},
      didDismissQuestion: port.noteQuestionDismissed,
    };
  }

  function holdDriverAsk<Reply>(approvalFor: (requestId: string) => ConversationApproval, replies: DriverAskReplies<Reply>, abandoned: AbortSignal): Promise<Reply | null> {
    const request: ClaudePermissionRequest = { toolName: DRIVER_ASK_TOOL_NAME, toolInput: {}, agentKey: `${DRIVER_ASK_TOOL_NAME}-${nextApprovalNumber}` };
    return holdForChat(request, approvalFor, abandoned, {
      toAnswers: (_approval, answers) => replies.toAnswers(answers),
      toDecision: (_approval, decision) => replies.toDecision(decision),
      isReleasedBy: () => false,
      didHold: () => {},
      didSettle: () => {},
      didDismissQuestion: () => {},
    });
  }

  function holdForChat<Reply>(request: ClaudePermissionRequest, approvalFor: (requestId: string) => ConversationApproval, abandoned: AbortSignal, replies: ChatHoldKind<Reply>): Promise<Reply | null> {
    releaseHolds((hold) => hold.request.agentKey === request.agentKey);
    const requestId = `claude-${nextApprovalNumber}`;
    nextApprovalNumber += 1;
    return new Promise<Reply | null>((resolve) => {
      const approval = approvalFor(requestId);
      const settleWith = (reply: Reply | null): boolean => {
        if (reply === null) return false;
        resolve(reply);
        replies.didSettle();
        return true;
      };
      const hold: ClaudeApprovalHold = {
        request,
        approval,
        isReleasedBy: replies.isReleasedBy,
        settleWithAnswers: (answers) => settleWith(replies.toAnswers(approval, answers)),
        settleWithDecision: (decision, denyMessage) => settleWith(replies.toDecision(approval, decision, denyMessage)),
        didDismissQuestion: replies.didDismissQuestion,
        release: () => resolve(null),
      };
      holds.push(hold);
      abandoned.addEventListener("abort", () => releaseHolds((candidate) => candidate === hold), { once: true });
      showFirstApproval();
      replies.didHold();
    });
  }

  function releaseAfterHookEvent(event: string, payload: Record<string, unknown>): void {
    forgetPassedQuestions(event, payload);
    const normalizedEvent = event.toLowerCase();
    if (planHold !== null && isHoldReleasedByHookEvent(planHold.request, event, payload)) releasePlanHold();
    if (shouldClearPlanGate(planGate, planHold !== null, normalizedEvent)) applyPlanEvent({ kind: "cleared" });
    if (holds.length === 0) return;
    releaseHolds((hold) => hold.isReleasedBy(event, payload));
  }

  function releaseHolds(isReleased: (hold: ClaudeApprovalHold) => boolean): void {
    const released = holds.filter(isReleased);
    if (released.length === 0) return;
    holds = holds.filter((hold) => !released.includes(hold));
    for (const hold of released) hold.release();
    showFirstApproval();
  }

  function showFirstApproval(): void {
    setConversationApproval(holds[0]?.approval ?? null);
  }

  function answer(requestId: number | string, answers: ConversationAnswers): boolean {
    const hold = holds.find((candidate) => candidate.approval.requestId === requestId);
    if (!hold) return false;
    if (!hold.settleWithAnswers(answers)) return false;
    holds = holds.filter((candidate) => candidate !== hold);
    showFirstApproval();
    return true;
  }

  function decisionReplyOf(approval: ConversationApproval, decision: PermissionDecision, denyMessage: string | null): PermissionHookReply | null {
    if (approval.kind === "permission") return permissionReplyFor(agentId, decision, denyMessage);
    if (decision === "deny") return questionDismissedReply();
    return null;
  }

  function decide(requestId: number | string, decision: PermissionDecision, denyMessage: string | null): boolean {
    const hold = holds.find((candidate) => candidate.approval.requestId === requestId);
    if (!hold) return false;
    if (!hold.settleWithDecision(decision, denyMessage)) return false;
    holds = holds.filter((candidate) => candidate !== hold);
    showFirstApproval();
    if (hold.approval.kind === "question") hold.didDismissQuestion();
    return true;
  }

  function release(requestId: string): boolean {
    const hold = holds.find((candidate) => candidate.approval.requestId === requestId);
    if (!hold || hold.request.toolName === DRIVER_ASK_TOOL_NAME) return false;
    releaseHolds((candidate) => candidate === hold);
    return true;
  }

  function releaseAll(): void {
    releaseHolds(() => true);
    releasePlanHold();
    for (const callKey of [...parkedStatusByCall.keys()]) discardParkedStatus(callKey);
    settledQuestionByCall.clear();
  }

  return {
    get conversationApproval() { return conversationApproval; },
    get latestManagerDecisionSeq() { return managerDecisionCount; },
    get planGate() { return planGate; },
    holdPlan,
    proposePlan,
    decidePlan,
    hold,
    holdQuestionTool,
    holdElicitation,
    holdDriverAsk,
    yieldManagerDecisions,
    parksQuestionStatus,
    releaseAfterHookEvent,
    releaseAll,
    answer,
    decide,
    release,
  };
}

export { createSessionApprovalHolds };
export type { QuestionManagerPort, SessionApprovalHolds };
