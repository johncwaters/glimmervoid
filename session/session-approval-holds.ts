import { ASK_USER_QUESTION_TOOL_NAME } from "../shared/contracts/session.ts";
import type { ConversationAnswers, ConversationApproval } from "../shared/contracts/session.ts";
import { claudeAnswerReply, claudeApprovalFor, isHoldReleasedByHookEvent, parseClaudePermissionRequest } from "./core/claude-approval-core.ts";
import type { ClaudeHookReply, ClaudePermissionRequest } from "./core/claude-approval-core.ts";

interface ClaudeApprovalHold {
  request: ClaudePermissionRequest;
  approval: ConversationApproval;
  resolve: (reply: ClaudeHookReply | null) => void;
}

interface ApprovalPort {
  emit: (event: string, detail: Record<string, unknown>) => void;
}

interface SessionApprovalHoldsOptions {
  agentId: string;
  holdsQuestionsForParent: boolean;
  port: ApprovalPort;
}

interface SessionApprovalHolds {
  readonly conversationApproval: ConversationApproval | null;
  hold(payload: unknown, abandoned: AbortSignal): Promise<ClaudeHookReply | null> | null;
  releaseAfterHookEvent(event: string, payload: Record<string, unknown>): void;
  releaseAll(): void;
  answer(requestId: number | string, answers: ConversationAnswers): boolean;
  release(requestId: string): boolean;
}

function createSessionApprovalHolds({ agentId, holdsQuestionsForParent, port }: SessionApprovalHoldsOptions): SessionApprovalHolds {
  let conversationApproval: ConversationApproval | null = null;
  let holds: ClaudeApprovalHold[] = [];
  let nextApprovalNumber = 1;

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
    if (!holdsQuestionsForParent || request.toolName !== ASK_USER_QUESTION_TOOL_NAME) return null;
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
  }

  return {
    get conversationApproval() { return conversationApproval; },
    hold,
    releaseAfterHookEvent,
    releaseAll,
    answer,
    release,
  };
}

export { createSessionApprovalHolds };
export type { SessionApprovalHolds };
