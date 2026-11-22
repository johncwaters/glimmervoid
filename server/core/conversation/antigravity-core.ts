import { z } from 'zod';

import type { TraceRecord } from '../../../shared/contracts/trace.ts';
import { boundedToolCallInput, parseTimestamp } from '../trace-core.ts';
import type { TraceLineContext } from '../trace-core.ts';
import { boundedToolOutput, parsedJson, textRecords } from './converter-parts.ts';
import type { RecordBase } from './converter-parts.ts';

const STEP_MARKER = '"step_index"';
const STEP_TIMING_LINE = /^(?:Created|Completed) At: .*\n/gm;
const NONZERO_EXIT = /Command exited with code [1-9]\d*/;
const SUBAGENT_CONVERSATION_ID_RE = /Created the following subagent:[\s\S]*?"conversationId"\s*:\s*"([^"]+)"/;

const ToolCall = z.object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) });

const Step = z.object({
  step_index: z.number().int().nonnegative(),
  source: z.string(),
  type: z.string(),
  status: z.string().default(''),
  created_at: z.string().optional(),
  content: z.string().default(''),
  thinking: z.string().default(''),
  tool_calls: z.array(ToolCall).default([]),
});

type Step = z.infer<typeof Step>;

function stepId(vendorSessionId: string, stepIndex: number): string {
  return `${vendorSessionId}:step-${stepIndex}`;
}

function taggedText(content: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(content);
  return match ? match[1] : null;
}

function plannerRecords(base: RecordBase, stepNamespace: string, step: Step): TraceRecord[] {
  const toolCalls: TraceRecord[] = step.tool_calls.map((toolCall, callIndex) => ({
    ...base,
    kind: 'tool_call',
    toolUseId: stepId(stepNamespace, step.step_index + 1 + callIndex),
    name: toolCall.name,
    ...boundedToolCallInput(toolCall.args),
  }));
  return [...textRecords(base, 'thinking', step.thinking), ...textRecords(base, 'assistant', step.content), ...toolCalls];
}

function launchedSubagentIdOf(output: string): string | undefined {
  const match = SUBAGENT_CONVERSATION_ID_RE.exec(output);
  return match?.[1] || undefined;
}

function toolResultRecords(base: RecordBase, stepNamespace: string, step: Step): TraceRecord[] {
  const output = step.content.replace(STEP_TIMING_LINE, '');
  const isError = step.status === 'ERROR' || NONZERO_EXIT.test(output);
  const subagentId = isError ? undefined : launchedSubagentIdOf(output);
  return [{
    ...base,
    kind: 'tool_result',
    toolUseId: stepId(stepNamespace, step.step_index),
    isError,
    ...(subagentId ? { subagentId } : {}),
    ...boundedToolOutput('antigravity', output),
  }];
}

function recordsOfStep(base: RecordBase, stepNamespace: string, step: Step): TraceRecord[] {
  if (step.type === 'PLANNER_RESPONSE') return plannerRecords(base, stepNamespace, step);
  if (step.type === 'GENERIC') return toolResultRecords(base, stepNamespace, step);
  if (step.type === 'SYSTEM_MESSAGE') return textRecords(base, 'expansion', taggedText(step.content, 'SYSTEM_MESSAGE') ?? step.content);
  if (step.type !== 'USER_INPUT') return [];
  const request = taggedText(step.content, 'USER_REQUEST') ?? step.content;
  return textRecords(base, step.source === 'USER_EXPLICIT' ? 'prompt' : 'expansion', request);
}

function antigravityRecordsFromLine(rawLine: string, context: TraceLineContext): TraceRecord[] {
  if (!rawLine.includes(STEP_MARKER)) return [];
  const step = Step.safeParse(parsedJson(rawLine));
  if (!step.success) return [];
  const stepNamespace = context.agentId ?? context.vendorSessionId;
  const base: RecordBase = {
    ts: parseTimestamp(step.data.created_at) ?? context.now,
    uuid: stepId(stepNamespace, step.data.step_index),
    parentUuid: null,
    vendorSessionId: context.vendorSessionId,
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.agentType ? { agentType: context.agentType } : {}),
  };
  return recordsOfStep(base, stepNamespace, step.data);
}

export { antigravityRecordsFromLine };
