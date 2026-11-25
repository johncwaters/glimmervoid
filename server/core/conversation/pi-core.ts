import { z } from 'zod';
import { pastedImagesRecordOf, traceImagesField, traceImagesIn } from '../../trace/core/trace-image-core.ts';

import type { TraceRecord } from '../../../shared/contracts/trace.ts';
import { boundedToolCallInput, parseTimestamp } from '../trace-core.ts';
import type { TraceLineContext } from '../trace-core.ts';
import { boundedToolOutput, parsedJson, textRecords } from './converter-parts.ts';
import type { RecordBase } from './converter-parts.ts';

const CONVERSATION_LINE_MARKERS = ['"type":"message"', '"type":"custom_message"', '"type":"model_change"'];

const ContentBlock = z.object({ type: z.string() }).passthrough();
const MessageContent = z.union([z.string(), z.array(ContentBlock)]);

const SessionEntry = z.object({
  type: z.enum(['message', 'custom_message', 'model_change']),
  id: z.string().min(1),
  parentId: z.string().nullish(),
  timestamp: z.string().optional(),
});

const UserMessage = z.object({ role: z.literal('user'), content: MessageContent });
const AssistantMessage = z.object({ role: z.literal('assistant'), content: z.array(ContentBlock) });
const ToolResultMessage = z.object({ role: z.literal('toolResult'), toolCallId: z.string().min(1), content: MessageContent, isError: z.boolean().optional() });
const BashExecutionMessage = z.object({ role: z.literal('bashExecution'), command: z.string(), output: z.string().default(''), exitCode: z.number().nullish(), cancelled: z.boolean().optional() });
const CustomMessage = z.object({ role: z.literal('custom'), content: MessageContent });
const CustomMessageEntry = z.object({ content: MessageContent });
const MessageEntry = z.object({ message: z.unknown() });
const ModelChangeEntry = z.object({ modelId: z.string().min(1).max(200) });

const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const ThinkingBlock = z.object({ type: z.literal('thinking'), thinking: z.string().default('') });
const ToolCallBlock = z.object({ type: z.literal('toolCall'), id: z.string().min(1), name: z.string().min(1), arguments: z.unknown() });

function contentText(content: z.infer<typeof MessageContent>): string {
  if (typeof content === 'string') return content;
  return content.flatMap((block) => {
    const text = TextBlock.safeParse(block);
    return text.success ? [text.data.text] : [];
  }).join('');
}

function userMessageRecords(base: RecordBase, content: z.infer<typeof MessageContent>): TraceRecord[] {
  const pastedImages = traceImagesIn(content, base.ts);
  const promptText = contentText(content);
  if (pastedImages.length === 0) return textRecords(base, 'prompt', promptText);
  const promptRecords: TraceRecord[] = promptText.length === 0 ? [{ ...base, kind: 'prompt', text: '' }] : textRecords(base, 'prompt', promptText);
  return [...promptRecords, pastedImagesRecordOf(base, pastedImages)];
}

function toolResultRecord(base: RecordBase, toolUseId: string, output: string, isError: boolean): TraceRecord {
  return { ...base, kind: 'tool_result', toolUseId, isError, ...boundedToolOutput('pi', output) };
}

function assistantBlockRecords(base: RecordBase, block: z.infer<typeof ContentBlock>): TraceRecord[] {
  const text = TextBlock.safeParse(block);
  if (text.success) return textRecords(base, 'assistant', text.data.text);
  const thinking = ThinkingBlock.safeParse(block);
  if (thinking.success) return textRecords(base, 'thinking', thinking.data.thinking);
  const toolCall = ToolCallBlock.safeParse(block);
  if (!toolCall.success) return [];
  return [{ ...base, kind: 'tool_call', toolUseId: toolCall.data.id, name: toolCall.data.name, ...boundedToolCallInput(toolCall.data.arguments ?? {}) }];
}

function messageRecords(base: RecordBase, message: unknown): TraceRecord[] {
  const user = UserMessage.safeParse(message);
  if (user.success) return userMessageRecords(base, user.data.content);
  const assistant = AssistantMessage.safeParse(message);
  if (assistant.success) return assistant.data.content.flatMap((block) => assistantBlockRecords(base, block));
  const toolResult = ToolResultMessage.safeParse(message);
  if (toolResult.success) return [{ ...toolResultRecord(base, toolResult.data.toolCallId, contentText(toolResult.data.content), toolResult.data.isError === true), ...traceImagesField(toolResult.data.content, base.ts) }];
  const bashExecution = BashExecutionMessage.safeParse(message);
  if (bashExecution.success) {
    const toolUseId = base.uuid ?? 'bash-execution';
    const isError = bashExecution.data.cancelled === true || (bashExecution.data.exitCode ?? 0) !== 0;
    return [
      { ...base, kind: 'tool_call', toolUseId, name: 'bash', ...boundedToolCallInput({ command: bashExecution.data.command }) },
      toolResultRecord(base, toolUseId, bashExecution.data.output, isError),
    ];
  }
  const custom = CustomMessage.safeParse(message);
  if (custom.success) return textRecords(base, 'expansion', contentText(custom.data.content));
  return [];
}

function piRecordsFromLine(rawLine: string, context: TraceLineContext): TraceRecord[] {
  if (!CONVERSATION_LINE_MARKERS.some((marker) => rawLine.includes(marker))) return [];
  const rawEntry = parsedJson(rawLine);
  const entry = SessionEntry.safeParse(rawEntry);
  if (!entry.success) return [];
  const base: RecordBase = {
    ts: parseTimestamp(entry.data.timestamp) ?? context.now,
    uuid: entry.data.id,
    parentUuid: entry.data.parentId ?? null,
    vendorSessionId: context.vendorSessionId,
  };
  if (entry.data.type === 'model_change') {
    const modelChange = ModelChangeEntry.safeParse(rawEntry);
    const isSessionStartModel = base.parentUuid === null;
    return modelChange.success && !isSessionStartModel ? [{ ...base, kind: 'model-change', model: modelChange.data.modelId }] : [];
  }
  if (entry.data.type === 'custom_message') {
    const customEntry = CustomMessageEntry.safeParse(rawEntry);
    return customEntry.success ? textRecords(base, 'expansion', contentText(customEntry.data.content)) : [];
  }
  const messageEntry = MessageEntry.safeParse(rawEntry);
  return messageEntry.success ? messageRecords(base, messageEntry.data.message) : [];
}

export { piRecordsFromLine };
