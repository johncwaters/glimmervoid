import { z } from 'zod';

const PROPOSED_PLAN_TAG = '<proposed_plan>';
const PLAN_COLLABORATION_MODE = 'plan';
const RELEVANT_LINE_MARKERS = ['"task_started"', '"final_answer"'];

const TaskStartedLine = z.object({
  type: z.literal('event_msg'),
  payload: z.object({
    type: z.literal('task_started'),
    turn_id: z.string(),
    collaboration_mode_kind: z.string().optional(),
  }),
});

const AssistantFinalAnswerLine = z.object({
  type: z.literal('response_item'),
  payload: z.object({
    type: z.literal('message'),
    role: z.literal('assistant'),
    phase: z.literal('final_answer'),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    internal_chat_message_metadata_passthrough: z.object({ turn_id: z.string() }),
  }),
});

function parseRolloutLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isRelevantRolloutLine(line: string): boolean {
  return RELEVANT_LINE_MARKERS.some((marker) => line.includes(marker));
}

function isTurnStartLine(line: string, turnId: string): boolean {
  if (!line.includes('"task_started"')) return false;
  const taskStarted = TaskStartedLine.safeParse(parseRolloutLine(line));
  return taskStarted.success && taskStarted.data.payload.turn_id === turnId;
}

function turnEndedWithProposedPlan(rolloutLines: readonly string[], turnId: string): boolean {
  let didTurnRunInPlanMode = false;
  let finalAnswerText = '';
  for (const line of rolloutLines) {
    if (!isRelevantRolloutLine(line)) continue;
    const record = parseRolloutLine(line);
    const taskStarted = TaskStartedLine.safeParse(record);
    if (taskStarted.success && taskStarted.data.payload.turn_id === turnId) {
      didTurnRunInPlanMode = taskStarted.data.payload.collaboration_mode_kind === PLAN_COLLABORATION_MODE;
      continue;
    }
    const finalAnswer = AssistantFinalAnswerLine.safeParse(record);
    if (!finalAnswer.success || finalAnswer.data.payload.internal_chat_message_metadata_passthrough.turn_id !== turnId) continue;
    finalAnswerText = finalAnswer.data.payload.content.map((part) => part.text ?? '').join('');
  }
  return didTurnRunInPlanMode && finalAnswerText.includes(PROPOSED_PLAN_TAG);
}

export { isRelevantRolloutLine, isTurnStartLine, turnEndedWithProposedPlan };
