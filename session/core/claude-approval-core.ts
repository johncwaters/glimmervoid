import { z } from 'zod';
import {
  CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS,
  CONVERSATION_PERMISSION_HOOK_EVENT,
  CONVERSATION_TOOL_RESULT_HOOK_EVENT,
  ConversationQuestion,
} from '../../shared/contracts/session.ts';
import type { ConversationAnswers, ConversationApproval } from '../../shared/contracts/session.ts';

const MAIN_AGENT_KEY = '';
const HOLD_KEEPING_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'notification',
  'permissionrequest',
  'permissionrequest-plan',
  'statusline',
  CONVERSATION_PERMISSION_HOOK_EVENT,
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

function hookReply(decision: Record<string, unknown>): ClaudeHookReply {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

function areAnswersComplete(approval: ConversationApproval, answers: ConversationAnswers): boolean {
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
  if (TOOL_RESULT_HOOK_EVENTS.has(normalizedEvent)) return isSameToolCall(request, payload);
  return true;
}
