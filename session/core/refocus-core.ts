import { SessionStartHookResponse, UserPromptSubmitHookResponse } from '../../shared/contracts/refocus.ts';

interface RefocusContext {
  taskTitle: string | null;
  latestPlanTitle: string | null;
}

interface RefocusReplyInput {
  accepted: boolean;
  event: string;
  payload: Record<string, unknown>;
  readContext: () => RefocusContext;
  takePromptSupervision?: () => string | null;
}

function buildRefocusReminder({ taskTitle, latestPlanTitle }: RefocusContext): string | null {
  const intentParts: string[] = [];
  if (taskTitle?.trim()) intentParts.push(`Current task: "${taskTitle}".`);
  if (latestPlanTitle?.trim()) intentParts.push(`Latest plan: "${latestPlanTitle}".`);
  if (intentParts.length === 0) return null;
  return `Context was just compacted. ${intentParts.join(' ')} Before your next step, check it still serves this intent and drop work that does not.`;
}

function promptSupervisionReply(takePromptSupervision: (() => string | null) | undefined): UserPromptSubmitHookResponse | null {
  const message = takePromptSupervision?.() ?? null;
  return message === null ? null : { message };
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

function promptSupervisionOutput(body: string | null): string | null {
  if (body === null) return null;
  try {
    const parsedResponse = UserPromptSubmitHookResponse.safeParse(JSON.parse(body));
    if (!parsedResponse.success) return null;
    return JSON.stringify(parsedResponse.data);
  } catch {
    return null;
  }
}

export { refocusReplyFor, sessionStartContextOutput, promptSupervisionOutput };
export type { RefocusContext };
