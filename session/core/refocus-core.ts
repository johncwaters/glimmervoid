import { RelayedHookContext, SessionStartHookResponse } from '../../shared/contracts/refocus.ts';
import type { ToolHookContextResponse, UserPromptSubmitHookResponse } from '../../shared/contracts/refocus.ts';
import type { CommandHint } from './session-routes.ts';
import type { PromptContextReply } from '../../shared/contracts/refocus.ts';
import type { AgentNote } from '../../shared/contracts/hooks.ts';

interface RefocusContext {
  taskTitle: string | null;
  latestPlanTitle: string | null;
}

interface RefocusReplyInput {
  accepted: boolean;
  event: string;
  payload: Record<string, unknown>;
  readContext: () => RefocusContext;
  takePromptSupervision?: () => UserPromptSubmitHookResponse | null;
}

function refocusIntentParts({ taskTitle, latestPlanTitle }: RefocusContext): string[] {
  const intentParts: string[] = [];
  if (taskTitle?.trim()) intentParts.push(`Current task: "${taskTitle}".`);
  if (latestPlanTitle?.trim()) intentParts.push(`Latest plan: "${latestPlanTitle}".`);
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
  firesWhen: 'the agent compacted its context and the session has a task title or plan',
  text: compactedReminder(refocusIntentParts({ taskTitle: '<task title>', latestPlanTitle: '<latest plan>' }).join(' ')),
  isTemplate: true,
};

function promptContextReplyOf(shape: PromptContextReply, text: string): UserPromptSubmitHookResponse {
  if (shape === 'message') return { message: text };
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
}

function promptSupervisionReply(takePromptSupervision: (() => UserPromptSubmitHookResponse | null) | undefined): UserPromptSubmitHookResponse | null {
  return takePromptSupervision?.() ?? null;
}

function refocusReplyFor({ accepted, event, payload, readContext, takePromptSupervision }: RefocusReplyInput): SessionStartHookResponse | UserPromptSubmitHookResponse | null {
  if (!accepted) return null;
  if (event.toLowerCase() === 'userpromptsubmit') return promptSupervisionReply(takePromptSupervision);
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

function relayedHookContextOutput(body: string | null): string | null {
  if (body === null) return null;
  try {
    const parsedResponse = RelayedHookContext.safeParse(JSON.parse(body));
    if (!parsedResponse.success) return null;
    return JSON.stringify(parsedResponse.data);
  } catch {
    return null;
  }
}

const TOOL_HOOK_EVENT_NAMES = { posttooluse: 'PostToolUse', posttoolusefailure: 'PostToolUseFailure' } as const;

function toolHookContextReplyOf({ event, text }: CommandHint): ToolHookContextResponse {
  return { hookSpecificOutput: { hookEventName: TOOL_HOOK_EVENT_NAMES[event], additionalContext: text } };
}

export { REFOCUS_NOTE, toolHookContextReplyOf, promptContextReplyOf, refocusReplyFor, sessionStartContextOutput, relayedHookContextOutput };
export type { RefocusContext };
