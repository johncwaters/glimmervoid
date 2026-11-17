import { z } from 'zod';

import type { TraceRecord } from '../../../shared/contracts/trace.ts';
import { MAX_RAW_LINE_CHARS } from '../../../shared/contracts/trace.ts';
import { boundedText, boundedToolCallInput, parseTimestamp } from '../trace-core.ts';
import type { TraceLineContext } from '../trace-core.ts';

const ITEM_COMPLETED_MARKER = '"item_completed"';

const TextPart = z.object({ text: z.string().optional() }).passthrough();

const ItemCompletedLine = z.object({
  timestamp: z.string().optional(),
  type: z.literal('event_msg'),
  payload: z.object({
    type: z.literal('item_completed'),
    thread_id: z.string().optional(),
    item: z.object({ type: z.string(), id: z.string().min(1) }).passthrough(),
  }),
});

const MessageItem = z.object({ content: z.array(TextPart) });
const ReasoningItem = z.object({ summary_text: z.array(z.string()).default([]) });
const CommandExecutionItem = z.object({
  command: z.array(z.string()),
  aggregated_output: z.string().default(''),
  status: z.string(),
  exit_code: z.number().nullish(),
});
const McpToolCallItem = z.object({
  server: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.unknown(),
  status: z.string(),
  result: z.object({ content: z.array(TextPart).default([]) }).passthrough().nullish(),
  error: z.unknown(),
});
const FileChangeItem = z.object({
  changes: z.record(z.string(), z.unknown()),
  status: z.string(),
  stdout: z.string().default(''),
  stderr: z.string().default(''),
});

type ItemCompleted = z.infer<typeof ItemCompletedLine>;
type RecordBase = Pick<TraceRecord, 'ts' | 'uuid' | 'parentUuid' | 'vendorSessionId'>;

function parsedJson(rawLine: string): unknown {
  try {
    return JSON.parse(rawLine);
  } catch {
    return null;
  }
}

function joinedText(parts: readonly z.infer<typeof TextPart>[]): string {
  return parts.map((part) => part.text ?? '').join('');
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return JSON.stringify(error ?? null);
}

function toolCallAndResult(base: RecordBase, toolUseId: string, name: string, input: unknown, output: string, isError: boolean): TraceRecord[] {
  const boundedOutput = boundedText(output);
  return [
    { ...base, kind: 'tool_call', toolUseId, name, ...boundedToolCallInput(input) },
    { ...base, kind: 'tool_result', toolUseId, content: boundedOutput.text, isError, truncated: boundedOutput.truncated },
  ];
}

function textRecord(base: RecordBase, kind: 'prompt' | 'assistant' | 'thinking', text: string): TraceRecord[] {
  if (text.length === 0) return [];
  const bounded = boundedText(text);
  return [{ ...base, kind, text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) }];
}

function rawRecord(base: RecordBase, rawLine: string): TraceRecord[] {
  const isCut = rawLine.length > MAX_RAW_LINE_CHARS;
  return [{ ...base, kind: 'raw', line: rawLine.slice(0, MAX_RAW_LINE_CHARS), ...(isCut ? { truncated: true } : {}) }];
}

function recordsOfItem(base: RecordBase, item: ItemCompleted['payload']['item'], rawLine: string): TraceRecord[] {
  switch (item.type) {
    case 'UserMessage':
    case 'AgentMessage': {
      const message = MessageItem.safeParse(item);
      if (!message.success) return rawRecord(base, rawLine);
      return textRecord(base, item.type === 'UserMessage' ? 'prompt' : 'assistant', joinedText(message.data.content));
    }
    case 'Reasoning': {
      const reasoning = ReasoningItem.safeParse(item);
      return reasoning.success ? textRecord(base, 'thinking', reasoning.data.summary_text.join('\n')) : [];
    }
    case 'CommandExecution': {
      const command = CommandExecutionItem.safeParse(item);
      if (!command.success) return rawRecord(base, rawLine);
      const isError = command.data.status !== 'completed' || (command.data.exit_code ?? 0) !== 0;
      return toolCallAndResult(base, item.id, 'shell', { command: command.data.command.at(-1) ?? '' }, command.data.aggregated_output, isError);
    }
    case 'McpToolCall': {
      const toolCall = McpToolCallItem.safeParse(item);
      if (!toolCall.success) return rawRecord(base, rawLine);
      const isError = toolCall.data.status !== 'completed' || toolCall.data.error != null;
      const output = isError && toolCall.data.error != null ? errorText(toolCall.data.error) : joinedText(toolCall.data.result?.content ?? []);
      return toolCallAndResult(base, item.id, `mcp__${toolCall.data.server}__${toolCall.data.tool}`, toolCall.data.arguments ?? {}, output, isError);
    }
    case 'FileChange': {
      const fileChange = FileChangeItem.safeParse(item);
      if (!fileChange.success) return rawRecord(base, rawLine);
      const isError = fileChange.data.status !== 'completed';
      return toolCallAndResult(base, item.id, 'apply_patch', { changes: fileChange.data.changes }, `${fileChange.data.stdout}${fileChange.data.stderr}`, isError);
    }
    case 'ContextCompaction':
      return [];
    default:
      return rawRecord(base, rawLine);
  }
}

function codexRecordsFromLine(rawLine: string, context: TraceLineContext): TraceRecord[] {
  if (!rawLine.includes(ITEM_COMPLETED_MARKER)) return [];
  const itemCompleted = ItemCompletedLine.safeParse(parsedJson(rawLine));
  if (!itemCompleted.success) return [];
  const { item } = itemCompleted.data.payload;
  const base: RecordBase = {
    ts: parseTimestamp(itemCompleted.data.timestamp) ?? context.now,
    uuid: item.id,
    parentUuid: null,
    vendorSessionId: itemCompleted.data.payload.thread_id || context.vendorSessionId,
  };
  return recordsOfItem(base, item, rawLine);
}

export { codexRecordsFromLine };
