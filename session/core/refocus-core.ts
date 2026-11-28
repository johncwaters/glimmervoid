import { QuestionToolDenyResponse, RelayedHookContext, RESUME_NOTE_HOOK_EVENT, ResumeNoteHookResponse, SessionStartHookResponse } from '../../shared/contracts/refocus.ts';
import { QUESTION_TOOL_HOLD_HOOK_EVENT } from '../../shared/question-tool-hold.ts';
import type { ToolHookContextResponse, UserPromptSubmitHookResponse } from '../../shared/contracts/refocus.ts';
import type { CommandHint } from './session-routes.ts';
import type { PromptContextReply } from '../../shared/contracts/refocus.ts';
import type { AgentNote } from '../../shared/contracts/hooks.ts';

interface RefocusContext {
  taskTitle: string | null;
}

interface RefocusReplyInput {
  accepted: boolean;
  event: string;
  payload: Record<string, unknown>;
  readContext: () => RefocusContext;
  takePromptSupervision?: () => UserPromptSubmitHookResponse | null;
  takeResumeNote?: () => string | null;
}

function refocusIntentParts({ taskTitle }: RefocusContext): string[] {
  const intentParts: string[] = [];
  if (taskTitle?.trim()) intentParts.push(`Current task: "${taskTitle}".`);
  return intentParts;
}

function buildRefocusReminder(context: RefocusContext): string | null {
  const intentParts = refocusIntentParts(context);
  if (intentParts.length === 0) return null;
  return compactedReminder(intentParts.join(' '));
}

function compactedReminder(intent: string): string {
  return `Context was just compacted. ${intent} Before your next step, check it still serves this intent and drop work that does not.`;
}

const REFOCUS_NOTE: AgentNote = {
  name: 'Refocus after compaction',
  carriedBy: 'SessionStart',
  firesWhen: 'the agent compacted its context and the session has a task title',
  text: compactedReminder(refocusIntentParts({ taskTitle: '<task title>' }).join(' ')),
  isTemplate: true,
};

const PROMPT_CONTEXT_EVENTS: ReadonlySet<string> = new Set(['userpromptsubmit', 'preinvocation']);

function promptContextReplyOf(shape: PromptContextReply, text: string): UserPromptSubmitHookResponse {
  if (shape === 'message') return { message: text };
  if (shape === 'inject-steps') return { injectSteps: [{ userMessage: text }] };
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
}

function promptSupervisionReply(takePromptSupervision: (() => UserPromptSubmitHookResponse | null) | undefined): UserPromptSubmitHookResponse | null {
  return takePromptSupervision?.() ?? null;
}

function resumeNoteReply(takeResumeNote: (() => string | null) | undefined): ResumeNoteHookResponse | null {
  const resumeNote = takeResumeNote?.() ?? null;
  return resumeNote ? { resumeNote } : null;
}

function isSubagentPayload(payload: Record<string, unknown>): boolean {
  return typeof payload.agent_id === 'string';
}

function refocusReplyFor({ accepted, event, payload, readContext, takePromptSupervision, takeResumeNote }: RefocusReplyInput): SessionStartHookResponse | UserPromptSubmitHookResponse | ResumeNoteHookResponse | null {
  if (!accepted) return null;
  if (PROMPT_CONTEXT_EVENTS.has(event.toLowerCase())) return isSubagentPayload(payload) ? null : promptSupervisionReply(takePromptSupervision);
  if (event.toLowerCase() === RESUME_NOTE_HOOK_EVENT) return resumeNoteReply(takeResumeNote);
  if (event.toLowerCase() !== 'sessionstart') return null;
  if (payload.source !== 'compact') return null;
  const additionalContext = buildRefocusReminder(readContext());
  if (additionalContext === null) return null;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } };
}

function sessionStartContextOutput(body: string | null): string | null {
  if (body === null) return null;
  try {
    const parsedResponse = SessionStartHookResponse.safeParse(JSON.parse(body));
    if (!parsedResponse.success) return null;
    return JSON.stringify(parsedResponse.data);
  } catch {
    return null;
  }
}

function resumeNoteOf(body: string | null): string | null {
  if (body === null) return null;
  try {
    const parsedResponse = ResumeNoteHookResponse.safeParse(JSON.parse(body));
    return parsedResponse.success ? parsedResponse.data.resumeNote : null;
  } catch {
    return null;
  }
}

function relayedHookContextOutput(event: string, body: string | null): string | null {
  if (body === null) return null;
  const relayedShape = event === QUESTION_TOOL_HOLD_HOOK_EVENT ? QuestionToolDenyResponse : RelayedHookContext;
  try {
    const parsedResponse = relayedShape.safeParse(JSON.parse(body));
    if (!parsedResponse.success) return null;
    return JSON.stringify(parsedResponse.data);
  } catch {
    return null;
  }
}

const TOOL_HOOK_EVENT_NAMES = { posttooluse: 'PostToolUse', posttoolusefailure: 'PostToolUseFailure' } as const;

type ToolHookEventKey = keyof typeof TOOL_HOOK_EVENT_NAMES;

function isToolHookEventKey(event: string): event is ToolHookEventKey {
  return event === 'posttooluse' || event === 'posttoolusefailure';
}

function toolHookContextReplyOf({ event, text }: CommandHint): ToolHookContextResponse {
  return { hookSpecificOutput: { hookEventName: TOOL_HOOK_EVENT_NAMES[event], additionalContext: text } };
}

interface InTurnNoticeReplyInput {
  event: string;
  payload: Record<string, unknown>;
  hasToolHookContext: boolean;
  promptContextReply: PromptContextReply | null;
  takeNotice: () => string | null;
}

function inTurnNoticeReplyFor({ event, payload, hasToolHookContext, promptContextReply, takeNotice }: InTurnNoticeReplyInput): ToolHookContextResponse | UserPromptSubmitHookResponse | null {
  if (isSubagentPayload(payload)) return null;
  const eventLower = event.toLowerCase();
  if (hasToolHookContext && isToolHookEventKey(eventLower)) {
    const notice = takeNotice();
    if (notice === null) return null;
    return { hookSpecificOutput: { hookEventName: TOOL_HOOK_EVENT_NAMES[eventLower], additionalContext: notice } };
  }
  if (promptContextReply === 'inject-steps' && eventLower === 'preinvocation') {
    const notice = takeNotice();
    if (notice === null) return null;
    return promptContextReplyOf('inject-steps', notice);
  }
  return null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeHookSpecificOutput(existing: unknown, incoming: unknown): unknown {
  if (!isRecordValue(existing) || !isRecordValue(incoming)) return incoming;
  if (existing.hookEventName !== incoming.hookEventName) return incoming;
  if (typeof existing.additionalContext !== 'string' || typeof incoming.additionalContext !== 'string') return incoming;
  return { ...existing, ...incoming, additionalContext: `${existing.additionalContext}\n\n${incoming.additionalContext}` };
}

function mergeHookAgentReplies(replies: readonly (Record<string, unknown> | null | undefined)[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const reply of replies) {
    if (!reply) continue;
    for (const [key, value] of Object.entries(reply)) {
      if (key === 'hookSpecificOutput' && merged.hookSpecificOutput !== undefined) {
        merged.hookSpecificOutput = mergeHookSpecificOutput(merged.hookSpecificOutput, value);
        continue;
      }
      if (key === 'injectSteps' && Array.isArray(merged.injectSteps) && Array.isArray(value)) {
        merged.injectSteps = [...merged.injectSteps, ...value];
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

export { REFOCUS_NOTE, inTurnNoticeReplyFor, mergeHookAgentReplies, toolHookContextReplyOf, promptContextReplyOf, refocusReplyFor, resumeNoteOf, sessionStartContextOutput, relayedHookContextOutput };
export type { RefocusContext };
