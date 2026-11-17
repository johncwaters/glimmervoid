import { z } from 'zod';

import type { TraceRecord } from '../../../shared/contracts/trace.ts';
import { boundedToolCallInput } from '../trace-core.ts';
import type { TraceLineContext } from '../trace-core.ts';
import { boundedToolOutput, parsedJson, textRecords } from './converter-parts.ts';

const CONVERSATION_LINE_MARKERS = ['"turn.prompt"', '"context.append_loop_event"'];

const TextPart = z.object({ type: z.string(), text: z.string().optional(), meta: z.unknown().optional() }).passthrough();

const PromptLine = z.object({
  type: z.literal('turn.prompt'),
  promptId: z.string().optional(),
  input: z.array(TextPart),
  origin: z.object({ kind: z.string() }).passthrough().optional(),
  time: z.number().optional(),
});

const LoopEventLine = z.object({
  type: z.literal('context.append_loop_event'),
  event: z.object({ type: z.string() }).passthrough(),
  time: z.number().optional(),
});

const ContentPartEvent = z.object({
  uuid: z.string().optional(),
  part: z.object({ type: z.string(), text: z.string().optional(), think: z.string().optional() }).passthrough(),
});
const ToolCallEvent = z.object({ uuid: z.string().optional(), toolCallId: z.string().min(1), name: z.string().min(1), args: z.unknown() });
const ToolResultEvent = z.object({
  toolCallId: z.string().min(1),
  result: z.object({ output: z.unknown(), isError: z.boolean().optional() }).passthrough(),
});


function outputText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output ?? null);
}

function promptRecords(rawRecord: unknown, context: TraceLineContext): TraceRecord[] {
  const prompt = PromptLine.safeParse(rawRecord);
  if (!prompt.success || prompt.data.origin?.kind !== 'user') return [];
  const base = { ts: prompt.data.time ?? context.now, uuid: prompt.data.promptId ?? null, parentUuid: null, vendorSessionId: context.vendorSessionId };
  const injectedParts = prompt.data.input.filter((part) => part.meta !== undefined);
  const typedParts = prompt.data.input.filter((part) => part.meta === undefined);
  return [
    ...textRecords(base, 'expansion', injectedParts.map((part) => part.text ?? '').join('\n')),
    ...textRecords(base, 'prompt', typedParts.map((part) => part.text ?? '').join('')),
  ];
}

function loopEventRecords(rawRecord: unknown, context: TraceLineContext): TraceRecord[] {
  const loopEvent = LoopEventLine.safeParse(rawRecord);
  if (!loopEvent.success) return [];
  const { event } = loopEvent.data;
  const base = { ts: loopEvent.data.time ?? context.now, uuid: null, parentUuid: null, vendorSessionId: context.vendorSessionId };
  switch (event.type) {
    case 'content.part': {
      const contentPart = ContentPartEvent.safeParse(event);
      if (!contentPart.success) return [];
      const partBase = { ...base, uuid: contentPart.data.uuid ?? null };
      if (contentPart.data.part.type === 'think') return textRecords(partBase, 'thinking', contentPart.data.part.think ?? '');
      if (contentPart.data.part.type === 'text') return textRecords(partBase, 'assistant', contentPart.data.part.text ?? '');
      return [];
    }
    case 'tool.call': {
      const toolCall = ToolCallEvent.safeParse(event);
      if (!toolCall.success) return [];
      return [{ ...base, uuid: toolCall.data.uuid ?? null, kind: 'tool_call', toolUseId: toolCall.data.toolCallId, name: toolCall.data.name, ...boundedToolCallInput(toolCall.data.args ?? {}) }];
    }
    case 'tool.result': {
      const toolResult = ToolResultEvent.safeParse(event);
      if (!toolResult.success) return [];
      return [{ ...base, kind: 'tool_result', toolUseId: toolResult.data.toolCallId, isError: toolResult.data.result.isError === true, ...boundedToolOutput('kimi', outputText(toolResult.data.result.output)) }];
    }
    default:
      return [];
  }
}

function kimiRecordsFromLine(rawLine: string, context: TraceLineContext): TraceRecord[] {
  if (!CONVERSATION_LINE_MARKERS.some((marker) => rawLine.includes(marker))) return [];
  const rawRecord = parsedJson(rawLine);
  return [...promptRecords(rawRecord, context), ...loopEventRecords(rawRecord, context)];
}

export { kimiRecordsFromLine };
