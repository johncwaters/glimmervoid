import { z } from 'zod';
import {
  CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS,
  CONVERSATION_PERMISSION_HOOK_EVENT,
  CONVERSATION_TOOL_RESULT_HOOK_EVENT,
  ConversationQuestion,
} from '../../shared/contracts/session.ts';
import { PLAN_GATE_HOOK_EVENT } from '../../shared/contracts/plan-gate.ts';
import { READ_ONLY_COMMAND } from '../../shared/read-only-command.ts';
import type { ChatApprovalMode, ConversationAnswers, ConversationApproval, PermissionDecision } from '../../shared/contracts/session.ts';

const MAIN_AGENT_KEY = '';
const HOLD_KEEPING_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'agentstate',
  'notification',
  'permissionrequest',
  'permissionrequest-plan',
  'statusline',
  CONVERSATION_PERMISSION_HOOK_EVENT,
  PLAN_GATE_HOOK_EVENT,
]);
export const TOOL_RESULT_HOOK_EVENTS: ReadonlySet<string> = new Set(['posttooluse', 'posttoolusefailure', CONVERSATION_TOOL_RESULT_HOOK_EVENT]);
const PermissionRequestPayload = z.object({
  tool_name: z.string().min(1).max(200),
  tool_input: z.record(z.string(), z.unknown()),
  agent_id: z.string().min(1).nullish(),
}).passthrough();

export interface ClaudePermissionRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
  agentKey: string;
}

export type ClaudeHookReply = { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: Record<string, unknown> } };
type PreToolDecisionReply = { decision: PermissionDecision; reason: string };
type PreToolUseReply = { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: PermissionDecision; permissionDecisionReason: string } };
export type PermissionHookReply = ClaudeHookReply | PreToolDecisionReply | PreToolUseReply;

const DENIED_FROM_CHAT = 'The operator denied this from Chat.';
export const DISMISSED_FROM_CHAT = 'The operator dismissed this question from Chat without answering. Stop and wait for their next message.';
const ALLOWED_FROM_CHAT = 'The operator allowed this from Chat.';
const RELEASE_ON_SAME_CALL_EVENTS: ReadonlySet<string> = new Set([...TOOL_RESULT_HOOK_EVENTS, 'permissionresult']);
const COMMAND_INPUT_KEYS = ['command', 'CommandLine'];

function agentKeyOf(payload: Record<string, unknown>): string {
  const agentId = payload.agent_id;
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : MAIN_AGENT_KEY;
}

export function parseClaudePermissionRequest(payload: unknown): ClaudePermissionRequest | null {
  const parsed = PermissionRequestPayload.safeParse(payload);
  if (!parsed.success) return null;
  return {
    toolName: parsed.data.tool_name,
    toolInput: parsed.data.tool_input,
    agentKey: agentKeyOf(parsed.data),
  };
}

function inputValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function describeToolInput(toolInput: Record<string, unknown>): string {
  return Object.entries(toolInput).map(([key, value]) => `${key}: ${inputValueText(value)}`).join('\n');
}

function boundedSummary(summary: string): { summary: string; isSummaryTruncated: boolean } {
  const trimmed = summary.trim();
  return {
    summary: trimmed.slice(0, CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS),
    isSummaryTruncated: trimmed.length > CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS,
  };
}

export function claudeApprovalFor(request: ClaudePermissionRequest, requestId: string): ConversationApproval {
  const questions = z.array(ConversationQuestion).min(1).max(4).safeParse(request.toolInput.questions);
  if (!questions.success) {
    return { requestId, kind: 'question', ...boundedSummary(describeToolInput(request.toolInput)), isSummaryTruncated: true };
  }
  return { requestId, kind: 'question', summary: questions.data[0].question, isSummaryTruncated: false, questions: questions.data };
}

export function chatApprovalModeFor(
  isChatOn: boolean,
  skipsPermissions: boolean,
  isPermissionHoldPromptOnly = false,
): ChatApprovalMode {
  if (!isChatOn) return 'off';
  return skipsPermissions && !isPermissionHoldPromptOnly ? 'questions' : 'questions-and-permissions';
}

export function claudePermissionApprovalFor(request: ClaudePermissionRequest, requestId: string): ConversationApproval {
  return { requestId, kind: 'permission', toolName: request.toolName, ...boundedSummary(describeToolInput(request.toolInput)) };
}

function reasonFor(decision: PermissionDecision, denyMessage: string | null): string {
  if (decision === 'allow') return ALLOWED_FROM_CHAT;
  return denyMessage ?? DENIED_FROM_CHAT;
}

const PERMISSION_REPLY_BY_AGENT: Record<string, (decision: PermissionDecision, reason: string, denyMessage: string | null) => PermissionHookReply> = {
  antigravity: (decision, reason) => ({ decision, reason }),
  kimi: (decision, reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }),
  opencode: (decision, _reason, denyMessage) => operatorWordedReply(decision, denyMessage),
  pi: (decision, _reason, denyMessage) => operatorWordedReply(decision, denyMessage),
};

function operatorWordedReply(decision: PermissionDecision, denyMessage: string | null): ClaudeHookReply {
  if (decision === 'deny' && denyMessage !== null) return hookReply({ behavior: decision, message: denyMessage });
  return hookReply({ behavior: decision });
}

export function permissionReplyFor(agentId: string, decision: PermissionDecision, denyMessage: string | null = null): PermissionHookReply {
  const replyFor = PERMISSION_REPLY_BY_AGENT[agentId];
  if (replyFor) return replyFor(decision, reasonFor(decision, denyMessage), denyMessage);
  if (decision === 'allow') return hookReply({ behavior: 'allow' });
  return hookReply({ behavior: 'deny', message: reasonFor(decision, denyMessage) });
}

export function questionDismissedReply(): ClaudeHookReply {
  return hookReply({ behavior: 'deny', message: DISMISSED_FROM_CHAT, interrupt: true });
}

export function isReadOnlyCommandRequest(request: ClaudePermissionRequest): boolean {
  const command = COMMAND_INPUT_KEYS.map((key) => request.toolInput[key]).find((value) => typeof value === 'string');
  return typeof command === 'string' && READ_ONLY_COMMAND.test(command.trim());
}

function hookReply(decision: Record<string, unknown>): ClaudeHookReply {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

export function areAnswersComplete(approval: ConversationApproval, answers: ConversationAnswers): boolean {
  const questionTexts = (approval.questions ?? []).map((question) => question.question);
  if (questionTexts.length === 0) return false;
  const answeredTexts = Object.keys(answers);
  if (answeredTexts.length !== questionTexts.length) return false;
  return questionTexts.every((text) => typeof answers[text] === 'string' && answers[text].trim().length > 0);
}

export function claudeAnswerReply(request: ClaudePermissionRequest, approval: ConversationApproval, answers: ConversationAnswers): ClaudeHookReply | null {
  if (approval.isSummaryTruncated || !areAnswersComplete(approval, answers)) return null;
  return hookReply({ behavior: 'allow', updatedInput: { ...request.toolInput, answers } });
}

function isSameToolCall(request: ClaudePermissionRequest, payload: Record<string, unknown>): boolean {
  return payload.tool_name === request.toolName && JSON.stringify(payload.tool_input) === JSON.stringify(request.toolInput);
}

export function isHoldReleasedByHookEvent(request: ClaudePermissionRequest, event: string, payload: Record<string, unknown>): boolean {
  const normalizedEvent = event.toLowerCase();
  if (HOLD_KEEPING_HOOK_EVENTS.has(normalizedEvent)) return false;
  if (normalizedEvent === 'sessionend') return true;
  if (agentKeyOf(payload) !== request.agentKey) return false;
  if (RELEASE_ON_SAME_CALL_EVENTS.has(normalizedEvent)) return isSameToolCall(request, payload);
  return !isSameToolCall(request, payload);
}
