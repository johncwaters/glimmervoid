import { z } from 'zod';
import { PLAN_TOOL_NAME } from '../../shared/contracts/plan-review.ts';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS,
  CONVERSATION_PERMISSION_HOOK_EVENT,
  CONVERSATION_TOOL_RESULT_HOOK_EVENT,
  ConversationQuestion,
} from '../../shared/contracts/session.ts';
import type { ConversationAnswers, ConversationApproval, ConversationApprovalDecision } from '../../shared/contracts/session.ts';

const MAIN_AGENT_KEY = '';
const SESSION_DESTINATION = 'session';
const DECLINE_MESSAGE = 'The operator declined this from the Glimmervoid dashboard.';
const HOLD_KEEPING_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'notification',
  'permissionrequest',
  'permissionrequest-plan',
  'statusline',
  CONVERSATION_PERMISSION_HOOK_EVENT,
]);
const TOOL_RESULT_HOOK_EVENTS: ReadonlySet<string> = new Set(['posttooluse', 'posttoolusefailure', CONVERSATION_TOOL_RESULT_HOOK_EVENT]);
const PRIMARY_INPUT_KEYS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  Bash: ['command'],
  Edit: ['file_path', 'old_string', 'new_string'],
  Write: ['file_path', 'content'],
  Read: ['file_path'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query'],
};
const COSMETIC_INPUT_KEYS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  Bash: ['description'],
  Task: ['description'],
  Agent: ['description'],
};

const PermissionRequestPayload = z.object({
  tool_name: z.string().min(1).max(200),
  tool_input: z.record(z.string(), z.unknown()),
  permission_suggestions: z.array(z.unknown()).nullish(),
  agent_id: z.string().min(1).nullish(),
}).passthrough();

const AllowRuleSuggestion = z.object({
  type: z.literal('addRules'),
  behavior: z.literal('allow'),
  rules: z.array(z.object({ toolName: z.string().min(1), ruleContent: z.string().optional() }).strict()).min(1),
}).passthrough();

const AddDirectoriesSuggestion = z.object({
  type: z.literal('addDirectories'),
  directories: z.array(z.string().min(1)).min(1),
}).passthrough();

type SessionPermissionUpdate =
  | { type: 'addRules'; behavior: 'allow'; rules: { toolName: string; ruleContent?: string }[]; destination: typeof SESSION_DESTINATION }
  | { type: 'addDirectories'; directories: string[]; destination: typeof SESSION_DESTINATION };

export interface ClaudePermissionRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
  agentKey: string;
  sessionPermissionUpdates: SessionPermissionUpdate[];
}

export type ClaudeHookReply = { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: Record<string, unknown> } };

function agentKeyOf(payload: Record<string, unknown>): string {
  const agentId = payload.agent_id;
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : MAIN_AGENT_KEY;
}

function sessionPermissionUpdatesFrom(suggestions: readonly unknown[]): SessionPermissionUpdate[] {
  const updates: SessionPermissionUpdate[] = [];
  for (const suggestion of suggestions) {
    const allowRule = AllowRuleSuggestion.safeParse(suggestion);
    if (allowRule.success) {
      updates.push({ type: 'addRules', behavior: 'allow', rules: allowRule.data.rules, destination: SESSION_DESTINATION });
      continue;
    }
    const addDirectories = AddDirectoriesSuggestion.safeParse(suggestion);
    if (addDirectories.success) updates.push({ type: 'addDirectories', directories: addDirectories.data.directories, destination: SESSION_DESTINATION });
  }
  return updates;
}

export function parseClaudePermissionRequest(payload: unknown): ClaudePermissionRequest | null {
  const parsed = PermissionRequestPayload.safeParse(payload);
  if (!parsed.success) return null;
  if (parsed.data.tool_name === PLAN_TOOL_NAME) return null;
  return {
    toolName: parsed.data.tool_name,
    toolInput: parsed.data.tool_input,
    agentKey: agentKeyOf(parsed.data),
    sessionPermissionUpdates: sessionPermissionUpdatesFrom(parsed.data.permission_suggestions ?? []),
  };
}

function inputValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function describeToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  const primaryKeys = PRIMARY_INPUT_KEYS_BY_TOOL[toolName] ?? [];
  const cosmeticKeys = COSMETIC_INPUT_KEYS_BY_TOOL[toolName] ?? [];
  const primaryLines = primaryKeys
    .filter((key) => toolInput[key] !== undefined)
    .map((key) => (primaryKeys.length === 1 ? inputValueText(toolInput[key]) : `${key}:\n${inputValueText(toolInput[key])}`));
  const otherLines = Object.entries(toolInput)
    .filter(([key]) => !primaryKeys.includes(key) && !cosmeticKeys.includes(key))
    .map(([key, value]) => `${key}: ${inputValueText(value)}`);
  return [...primaryLines, ...otherLines].join('\n');
}

function describeSessionPermissionUpdates(updates: readonly SessionPermissionUpdate[]): string {
  return updates.map((update) => {
    if (update.type === 'addDirectories') return `Access to ${update.directories.join(', ')}`;
    return update.rules.map((rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName)).join(', ');
  }).join('; ');
}

function fullAlwaysAllowSummary(request: ClaudePermissionRequest): string | null {
  const summary = describeSessionPermissionUpdates(request.sessionPermissionUpdates);
  if (summary.length === 0 || summary.length > CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS) return null;
  return summary;
}

function boundedSummary(summary: string): { summary: string; isSummaryTruncated: boolean } {
  const trimmed = summary.trim();
  return {
    summary: trimmed.slice(0, CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS),
    isSummaryTruncated: trimmed.length > CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS,
  };
}

function questionApproval(request: ClaudePermissionRequest, requestId: string): ConversationApproval {
  const questions = z.array(ConversationQuestion).min(1).max(4).safeParse(request.toolInput.questions);
  if (!questions.success) {
    return { requestId, kind: 'question', toolName: request.toolName, ...boundedSummary(describeToolInput(request.toolName, request.toolInput)), isSummaryTruncated: true };
  }
  return { requestId, kind: 'question', toolName: request.toolName, summary: questions.data[0].question, isSummaryTruncated: false, questions: questions.data };
}

export function claudeApprovalFor(request: ClaudePermissionRequest, requestId: string): ConversationApproval {
  if (request.toolName === ASK_USER_QUESTION_TOOL_NAME) return questionApproval(request, requestId);
  const alwaysAllowSummary = fullAlwaysAllowSummary(request);
  return {
    requestId,
    kind: 'tool',
    toolName: request.toolName,
    ...boundedSummary(describeToolInput(request.toolName, request.toolInput)),
    ...(alwaysAllowSummary ? { alwaysAllowSummary } : {}),
  };
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

export function claudeDecisionReply(
  request: ClaudePermissionRequest,
  approval: ConversationApproval,
  decision: ConversationApprovalDecision,
  answers: ConversationAnswers | undefined,
): ClaudeHookReply | null {
  if (decision === 'decline') return hookReply({ behavior: 'deny', message: DECLINE_MESSAGE });
  if (approval.isSummaryTruncated) return null;
  if (approval.kind === 'question') {
    if (decision !== 'accept' || !answers || !areAnswersComplete(approval, answers)) return null;
    return hookReply({ behavior: 'allow', updatedInput: { ...request.toolInput, answers } });
  }
  if (decision === 'accept') return hookReply({ behavior: 'allow' });
  if (fullAlwaysAllowSummary(request) === null) return null;
  return hookReply({ behavior: 'allow', updatedPermissions: request.sessionPermissionUpdates });
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
