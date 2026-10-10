import { SessionStartHookResponse } from '../../shared/contracts/refocus.ts';

interface RefocusContext {
  taskTitle: string | null;
  latestPlanTitle: string | null;
}

interface RefocusReplyInput {
  accepted: boolean;
  event: string;
  payload: Record<string, unknown>;
  readContext: () => RefocusContext;
}

function buildRefocusReminder({ taskTitle, latestPlanTitle }: RefocusContext): string | null {
  const intentParts: string[] = [];
  if (taskTitle?.trim()) intentParts.push(`Current task: "${taskTitle}".`);
  if (latestPlanTitle?.trim()) intentParts.push(`Latest plan: "${latestPlanTitle}".`);
  if (intentParts.length === 0) return null;
  return `Context was just compacted. ${intentParts.join(' ')} Before your next step, check it still serves this intent and drop work that does not.`;
}

function refocusReplyFor({ accepted, event, payload, readContext }: RefocusReplyInput): SessionStartHookResponse | null {
  if (!accepted) return null;
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

export { refocusReplyFor, sessionStartContextOutput };
export type { RefocusContext };
