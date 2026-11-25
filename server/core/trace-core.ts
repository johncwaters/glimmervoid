import type { TraceRecord } from '../../shared/contracts/trace.ts';
import { isImageBlock, pastedImagesRecordOf, traceImagesField, traceImagesIn } from '../trace/core/trace-image-core.ts';
import { MAX_RAW_LINE_CHARS } from '../../shared/contracts/trace.ts';
import { parseJsonRecord } from './json-core.ts';
import { rawTextOr, textOr } from '../../shared/coerce.ts';
import { withoutTerminalEscapes } from '../../shared/terminal-text.ts';

type SpillWrappingAgent = 'claude-code' | 'kimi' | 'pi' | 'antigravity';
type UnwrappedToolOutput = { output: string; isSpilled: boolean };

const CLAUDE_PERSISTED_OUTPUT = /^<persisted-output>\n[^\n]*\n\nPreview \([^)\n]*\):\n([\s\S]*?)(?:\n\.\.\.)?\n<\/persisted-output>$/;
const KIMI_SAVED_OUTPUT_HEADER = /^Tool output exceeded \d+ characters[^\n]*\n(?:[a-z_]+: [^\n]*\n)*\n\[preview: chars \[0, \d+\)\]\n/;
const PI_FULL_OUTPUT_NOTE_STARTS = ['\n\n[Showing ', '\n\n[Output truncated. '];
const PI_FULL_OUTPUT_PATH_MARKER = '. Full output: ';
const PI_STATUS_AFTER_NOTE = /^(?:\n\n(?:Command exited with code -?\d+|Command timed out after \d+ seconds|Command aborted))?$/;
const PI_STATUS_MAX_CHARS = 64;
const KIMI_APPENDED_POINTER_START = '\n[Per-line truncation occurred;';
const ANTIGRAVITY_TRUNCATED_HEADER = /^The tool's output was truncated due to being too long\.[^\n]*\n\nHere is a preview with the middle of the output truncated:\n/;

function withoutMatch(output: string, pattern: RegExp): string | null {
  const match = pattern.exec(output);
  if (!match) return null;
  return output.slice(0, match.index) + output.slice(match.index + match[0].length);
}

function withoutPiFullOutputNote(output: string): string | null {
  const noteStart = Math.max(...PI_FULL_OUTPUT_NOTE_STARTS.map((start) => output.lastIndexOf(start)));
  if (noteStart < 0) return null;
  const noteEnd = output.indexOf(']', noteStart);
  if (noteEnd < 0) return null;
  const note = output.slice(noteStart + 2, noteEnd);
  if (note.includes('\n') || !note.includes(PI_FULL_OUTPUT_PATH_MARKER)) return null;
  const statusAfterNote = output.slice(noteEnd + 1);
  if (statusAfterNote.length > PI_STATUS_MAX_CHARS || !PI_STATUS_AFTER_NOTE.test(statusAfterNote)) return null;
  return output.slice(0, noteStart) + statusAfterNote;
}

function withoutKimiSpill(output: string): string | null {
  const withoutHeader = withoutMatch(output, KIMI_SAVED_OUTPUT_HEADER);
  if (withoutHeader !== null) return withoutHeader;
  const pointerStart = output.lastIndexOf(KIMI_APPENDED_POINTER_START);
  if (pointerStart < 0 || !output.endsWith(']')) return null;
  return output.slice(0, pointerStart);
}

const UNWRAP_BY_AGENT: Record<SpillWrappingAgent, (output: string) => string | null> = {
  'claude-code': (output) => CLAUDE_PERSISTED_OUTPUT.exec(output)?.[1] ?? null,
  kimi: withoutKimiSpill,
  pi: withoutPiFullOutputNote,
  antigravity: (output) => withoutMatch(output, ANTIGRAVITY_TRUNCATED_HEADER),
};

function unwrapSpilledToolOutput(agent: SpillWrappingAgent, output: string): UnwrappedToolOutput {
  const unwrapped = UNWRAP_BY_AGENT[agent](output);
  if (unwrapped === null) return { output, isSpilled: false };
  return { output: unwrapped, isSpilled: true };
}

const MAX_TRACE_BODY_CHARS = 65536;
const MAX_TRACE_CALL_INPUT_CHARS = MAX_TRACE_BODY_CHARS * 2;

const DROPPED_LINE_TYPES = new Set([
  'agent-name',
  'ai-title',
  'atis-latch',
  'attachment',
  'bridge-session',
  'file-history-delta',
  'file-history-snapshot',
  'frame-link',
  'last-prompt',
  'mode',
  'permission-mode',
  'queue-operation',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'cost-state',
  'system',
]);

interface TraceLineContext {
  vendorSessionId: string;
  now: number;
  agentId?: string;
  agentType?: string;
}

interface TranscriptContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface TranscriptLine {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  agentId?: unknown;
  toolUseResult?: unknown;
  isMeta?: unknown;
  turnCompanion?: unknown;
  isCompactSummary?: unknown;
  sourceToolUseID?: unknown;
  subtype?: unknown;
  content?: unknown;
  message?: { content?: unknown };
  apiError?: unknown;
  isApiErrorMessage?: unknown;
  compactMetadata?: { preTokens?: unknown; postTokens?: unknown } | null;
  retryInMs?: unknown;
  retryAttempt?: unknown;
  maxRetries?: unknown;
  error?: unknown;
  apiErrorParams?: { rate_limit_info?: { resetsAt?: unknown; rateLimitType?: unknown } | null } | null;
  origin?: { kind?: unknown } | null;
  turnOrigin?: { kind?: unknown } | string | null;
  attachment?: {
    type?: unknown;
    commandMode?: unknown;
    origin?: { kind?: unknown } | null;
    prompt?: unknown;
    hookName?: unknown;
    hookEvent?: unknown;
    content?: unknown;
    stderr?: unknown;
    stdout?: unknown;
    blockingError?: unknown;
  };
}

type TraceRecordBase = Pick<TraceRecord, 'ts' | 'uuid' | 'parentUuid' | 'vendorSessionId' | 'agentId' | 'agentType'>;


function parseTranscriptLine(rawLine: string): TranscriptLine | null {
  const parsed = parseJsonRecord(rawLine);
  if (!parsed) return null;
  return parsed as TranscriptLine;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0 && value < 1e12) return Math.floor(value * 1000);
    if (value > 0) return Math.floor(value);
    return null;
  }
  const text = textOr(value, null);
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function firstTextBlock(content: TranscriptContentBlock[]): string | null {
  for (const block of content) {
    if (block?.type !== 'text') continue;
    const text = textOr(block.text, null);
    if (text) return text;
  }
  return null;
}

function objectBlocks(content: unknown): TranscriptContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is TranscriptContentBlock => Boolean(block) && typeof block === 'object');
}

function contentBlocks(line: TranscriptLine): TranscriptContentBlock[] {
  return objectBlocks(line.message?.content);
}

function baseRecord(line: TranscriptLine | null, context: TraceLineContext): TraceRecordBase {
  const agentId = rawTextOr(line?.agentId, null) || rawTextOr(context.agentId, null);
  const agentType = rawTextOr(context.agentType, null);
  return {
    ts: parseTimestamp(line?.timestamp) ?? context.now,
    uuid: rawTextOr(line?.uuid, null),
    parentUuid: rawTextOr(line?.parentUuid, null),
    vendorSessionId: rawTextOr(line?.sessionId, null) || context.vendorSessionId,
    ...(agentId ? { agentId } : {}),
    ...(agentType ? { agentType } : {}),
  };
}

function rawRecord(rawLine: string, line: TranscriptLine | null, context: TraceLineContext): TraceRecord {
  const isCut = rawLine.length > MAX_RAW_LINE_CHARS;
  return {
    ...baseRecord(line, context),
    kind: 'raw',
    line: rawLine.slice(0, MAX_RAW_LINE_CHARS),
    ...(isCut ? { truncated: true } : {}),
  };
}

function isDroppedLine(line: TranscriptLine): boolean {
  if (line.isCompactSummary === true) return true;
  if (typeof line.type === 'string' && DROPPED_LINE_TYPES.has(line.type)) return true;
  if (line.type !== 'system') return false;
  return typeof line.subtype === 'string' && line.subtype.includes('compact');
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    const serialized = JSON.stringify(content);
    return typeof serialized === 'string' ? serialized : String(content ?? '');
  }
  return content.filter((part) => !isImageBlock(part)).map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object') {
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.content === 'string') return record.content;
    }
    const serialized = JSON.stringify(part);
    return typeof serialized === 'string' ? serialized : String(part ?? '');
  }).join('\n');
}

function boundedText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_TRACE_BODY_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_TRACE_BODY_CHARS), truncated: true };
}

function boundedTextFields(value: string): { text: string; truncated?: true } {
  const bounded = boundedText(value);
  if (!bounded.truncated) return { text: bounded.text };
  return { text: bounded.text, truncated: true };
}

function serializedInputText(input: unknown): string {
  const serialized = JSON.stringify(input);
  if (typeof serialized === 'string') return serialized;
  return String(input);
}

function boundedInputProperties(input: Record<string, unknown>): { input: Record<string, unknown>; hasCutProperty: boolean } {
  const boundedEntries = Object.entries(input).map(([propertyName, propertyValue]) => {
    if (typeof propertyValue !== 'string') return { propertyName, boundedValue: propertyValue as unknown, isCut: false };
    const bounded = boundedText(propertyValue);
    return { propertyName, boundedValue: bounded.text as unknown, isCut: bounded.truncated };
  });
  return {
    input: Object.fromEntries(boundedEntries.map((entry) => [entry.propertyName, entry.boundedValue])),
    hasCutProperty: boundedEntries.some((entry) => entry.isCut),
  };
}

const MAX_LEADING_PROPERTY_CHARS = 256;

function isShortScalar(value: unknown): boolean {
  if (typeof value === 'string') return value.length <= MAX_LEADING_PROPERTY_CHARS;
  return value === null || typeof value !== 'object';
}

function withShortScalarPropertiesFirst(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const entries = Object.entries(input);
  return Object.fromEntries([...entries.filter(([, value]) => isShortScalar(value)), ...entries.filter(([, value]) => !isShortScalar(value))]);
}

function boundedToolCallInput(input: unknown): { input: unknown; truncated?: true } {
  if (typeof input === 'string') {
    const bounded = boundedText(input);
    if (!bounded.truncated) return { input };
    return { input: bounded.text, truncated: true };
  }
  if (!input || typeof input !== 'object') return { input };
  const bounded = Array.isArray(input)
    ? { input: input as unknown, hasCutProperty: false }
    : boundedInputProperties(input as Record<string, unknown>);
  const serialized = serializedInputText(bounded.input);
  if (serialized.length > MAX_TRACE_CALL_INPUT_CHARS) {
    return { input: serializedInputText(withShortScalarPropertiesFirst(bounded.input)).slice(0, MAX_TRACE_BODY_CHARS), truncated: true };
  }
  if (!bounded.hasCutProperty) return { input };
  return { input: bounded.input, truncated: true };
}

function everyTextBlockJoined(blocks: TranscriptContentBlock[]): string | null {
  const blockTexts = blocks.flatMap((block) => firstTextBlock([block]) ?? []);
  if (blockTexts.length === 0) return null;
  return blockTexts.join('\n');
}

const CLAUDE_INTERRUPT_MARKERS: ReadonlySet<string> = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);

function isTaskNotificationLine(line: TranscriptLine): boolean {
  const turnOriginKind = typeof line.turnOrigin === 'string' ? line.turnOrigin : line.turnOrigin?.kind;
  return line.origin?.kind === 'task-notification' || turnOriginKind === 'task_notification';
}

function launchedSubagentField(toolUseResult: unknown): { subagentId?: string } {
  if (typeof toolUseResult !== 'object' || toolUseResult === null) return {};
  const subagentId = 'agentId' in toolUseResult ? toolUseResult.agentId : null;
  if (typeof subagentId !== 'string' || subagentId === '') return {};
  return { subagentId };
}

function nonEmptyFieldOf(fields: object, key: string): string | null {
  const value: unknown = Reflect.get(fields, key);
  return typeof value === 'string' && value !== '' ? value : null;
}

function launchedBackgroundTaskField(toolUseResult: unknown): { backgroundTaskId?: string; backgroundTaskName?: string; backgroundTaskSummary?: string } {
  if (typeof toolUseResult !== 'object' || toolUseResult === null) return {};
  const shellTaskId = nonEmptyFieldOf(toolUseResult, 'backgroundTaskId');
  if (shellTaskId !== null) return { backgroundTaskId: shellTaskId };
  const isLaunchedTask = typeof Reflect.get(toolUseResult, 'taskType') === 'string';
  const launchedTaskId = isLaunchedTask ? nonEmptyFieldOf(toolUseResult, 'taskId') : null;
  if (launchedTaskId === null) return {};
  const taskName = nonEmptyFieldOf(toolUseResult, 'workflowName');
  const taskSummary = nonEmptyFieldOf(toolUseResult, 'summary');
  return {
    backgroundTaskId: launchedTaskId,
    ...(taskName === null ? {} : { backgroundTaskName: boundedText(taskName).text }),
    ...(taskSummary === null ? {} : { backgroundTaskSummary: boundedText(taskSummary).text }),
  };
}

function mapUserLine(
  rawLine: string,
  line: TranscriptLine,
  context: TraceLineContext,
): TraceRecord[] {
  const base = baseRecord(line, context);
  const content = line.message?.content;
  const blocks = contentBlocks(line);
  const toolResult = blocks.find((block) => block.type === 'tool_result');
  if (toolResult) {
    const toolUseId = rawTextOr(toolResult.tool_use_id, null);
    if (!toolUseId) return [rawRecord(rawLine, line, context)];
    const unwrapped = unwrapSpilledToolOutput('claude-code', textContent(toolResult.content));
    const bounded = boundedText(unwrapped.output);
    return [{
      ...base,
      kind: 'tool_result',
      toolUseId,
      content: bounded.text,
      isError: toolResult.is_error === true,
      truncated: bounded.truncated || unwrapped.isSpilled,
      ...traceImagesField(toolResult.content, base.ts),
      ...launchedSubagentField(line.toolUseResult),
      ...launchedBackgroundTaskField(line.toolUseResult),
    }];
  }

  if (line.isMeta === true) {
    const expansionText = typeof content === 'string' ? content : everyTextBlockJoined(blocks);
    if (!expansionText) return [rawRecord(rawLine, line, context)];
    const sourceToolUseId = rawTextOr(line.sourceToolUseID, null);
    if (!sourceToolUseId && line.turnCompanion === true) return [rawRecord(rawLine, line, context)];
    if (!sourceToolUseId) return [{ ...base, kind: 'expansion', ...boundedTextFields(expansionText) }];
    return [{ ...base, kind: 'expansion', toolUseId: sourceToolUseId, ...boundedTextFields(expansionText) }];
  }
  const text = typeof content === 'string' ? content : firstTextBlock(blocks);
  const pastedImages = traceImagesIn(blocks, base.ts);
  if (!text && pastedImages.length > 0) return [{ ...base, kind: 'prompt', text: '' }, pastedImagesRecordOf(base, pastedImages)];
  if (!text) return [rawRecord(rawLine, line, context)];
  if (isTaskNotificationLine(line)) return [{ ...base, kind: 'expansion', ...boundedTextFields(text) }];
  if (CLAUDE_INTERRUPT_MARKERS.has(text.trim())) return [{ ...base, kind: 'notice', text: 'Interrupted' }];
  const commandOutput = typeof content === 'string' ? commandOutputRecord(base, content) : null;
  if (commandOutput) return [commandOutput];
  if (typeof content === 'string' && isTypedCommandText(content)) {
    return [{ ...base, kind: 'expansion', ...boundedTextFields(content) }];
  }
  const promptRecord: TraceRecord = { ...base, kind: 'prompt', ...boundedTextFields(text) };
  if (pastedImages.length === 0) return [promptRecord];
  return [promptRecord, pastedImagesRecordOf(base, pastedImages)];
}

function queuedCommandText(prompt: unknown): string | null {
  if (typeof prompt === 'string') return prompt || null;
  return firstTextBlock(objectBlocks(prompt));
}

function queuedCommandRecords(line: TranscriptLine, context: TraceLineContext): TraceRecord[] | null {
  const attachment = line.attachment;
  if (line.type !== 'attachment' || attachment?.type !== 'queued_command') return null;
  const text = queuedCommandText(attachment.prompt);
  if (!text) return null;
  const isOperatorMessage = attachment.commandMode === 'prompt' && attachment.origin?.kind === 'human';
  if (isOperatorMessage) return [{ ...baseRecord(line, context), kind: 'prompt', ...boundedTextFields(text) }];
  if (attachment.commandMode === 'task-notification') return [{ ...baseRecord(line, context), kind: 'expansion', ...boundedTextFields(text) }];
  return null;
}

const USAGE_LIMIT_API_ERROR = 'usage_limit_reached';
const USAGE_LIMIT_WINDOW_BY_RATE_LIMIT_TYPE: Readonly<Record<string, string>> = { five_hour: 'session', seven_day: 'weekly' };

function usageLimitRecord(line: TranscriptLine, context: TraceLineContext): TraceRecord | null {
  if (line.apiError !== USAGE_LIMIT_API_ERROR) return null;
  const rateLimitInfo = line.apiErrorParams?.rate_limit_info;
  const resetsAtSeconds = rateLimitInfo?.resetsAt;
  if (typeof resetsAtSeconds !== 'number' || !Number.isFinite(resetsAtSeconds)) return null;
  const rateLimitType = typeof rateLimitInfo?.rateLimitType === 'string' ? rateLimitInfo.rateLimitType : '';
  const text = (firstTextBlock(contentBlocks(line)) ?? '').slice(0, MAX_RAW_LINE_CHARS);
  return { ...baseRecord(line, context), kind: 'usage_limit', text, resetsAtMs: resetsAtSeconds * 1000, window: USAGE_LIMIT_WINDOW_BY_RATE_LIMIT_TYPE[rateLimitType] ?? 'usage' };
}

function mapAssistantLine(rawLine: string, line: TranscriptLine, context: TraceLineContext): TraceRecord[] {
  const usageLimit = usageLimitRecord(line, context);
  if (usageLimit !== null) return [usageLimit];
  const apiErrorMessage = apiErrorMessageRecord(line, context);
  if (apiErrorMessage !== null) return [apiErrorMessage];
  const base = baseRecord(line, context);
  const records: TraceRecord[] = [];
  let hasSkippedThinkingBlock = false;
  for (const block of contentBlocks(line)) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      if (block.thinking.length === 0) {
        hasSkippedThinkingBlock = true;
        continue;
      }
      records.push({ ...base, kind: 'thinking', ...boundedTextFields(block.thinking) });
      continue;
    }
    if (block.type === 'text') {
      const text = firstTextBlock([block]);
      if (text) {
        records.push({ ...base, kind: 'assistant', ...boundedTextFields(text) });
      }
      continue;
    }
    if (block.type !== 'tool_use') continue;
    const toolUseId = rawTextOr(block.id, null);
    const name = rawTextOr(block.name, null);
    if (!toolUseId || !name) return [rawRecord(rawLine, line, context)];
    records.push({ ...base, kind: 'tool_call', toolUseId, name, ...boundedToolCallInput(block.input) });
  }
  if (records.length === 0 && hasSkippedThinkingBlock) return [];
  if (records.length === 0) return [rawRecord(rawLine, line, context)];
  return records;
}

const COMMAND_OUTPUT_PATTERN = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/;

function commandOutputRecord(base: TraceRecordBase & Pick<TraceRecord, 'transcriptOffset'>, content: string): TraceRecord | null {
  const match = COMMAND_OUTPUT_PATTERN.exec(content);
  if (!match) return null;
  const output = withoutTerminalEscapes(match[2] ?? '').trim();
  return { ...base, kind: 'command-output', text: output.slice(0, MAX_RAW_LINE_CHARS), isError: match[1] === 'stderr', ...(output.length > MAX_RAW_LINE_CHARS ? { truncated: true } : {}) };
}

const TYPED_COMMAND_PATTERN = /^\s*(?:<command-message>[\s\S]*?)?<command-name>[^<\r\n]+<\/command-name>/;

function isTypedCommandText(content: string): boolean {
  return TYPED_COMMAND_PATTERN.test(content);
}

function countOrNull(value: unknown, minimum: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum ? value : null;
}

function apiErrorTextOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'API error';
  const formatted = Reflect.get(error, 'formatted');
  const message = Reflect.get(error, 'message');
  return rawTextOr(formatted, null) || rawTextOr(message, null) || 'API error';
}

function systemEventRecords(line: TranscriptLine, context: TraceLineContext): TraceRecord[] | null {
  if (line.type !== 'system') return null;
  if (line.subtype === 'compact_boundary') {
    return [{ ...baseRecord(line, context), kind: 'compaction', tokensBefore: countOrNull(line.compactMetadata?.preTokens, 0), tokensAfter: countOrNull(line.compactMetadata?.postTokens, 0) }];
  }
  if (line.subtype !== 'api_error') return null;
  return [{
    ...baseRecord(line, context),
    kind: 'agent-error',
    text: apiErrorTextOf(line.error).slice(0, MAX_RAW_LINE_CHARS),
    retryInMs: countOrNull(line.retryInMs, 0),
    attempt: countOrNull(line.retryAttempt, 1),
    maxAttempts: countOrNull(line.maxRetries, 1),
  }];
}

function apiErrorMessageRecord(line: TranscriptLine, context: TraceLineContext): TraceRecord | null {
  if (line.isApiErrorMessage !== true) return null;
  const text = (firstTextBlock(contentBlocks(line)) ?? 'API error').slice(0, MAX_RAW_LINE_CHARS);
  return { ...baseRecord(line, context), kind: 'agent-error', text, retryInMs: null, attempt: null, maxAttempts: null };
}

const HOOK_MESSAGE_TEXT_BY_ATTACHMENT_TYPE: Readonly<Record<string, { isError: boolean; textOf: (attachment: NonNullable<TranscriptLine['attachment']>) => string | null }>> = {
  hook_system_message: { isError: false, textOf: (attachment) => rawTextOr(attachment.content, null) },
  hook_non_blocking_error: { isError: true, textOf: (attachment) => rawTextOr(attachment.stderr, null) || rawTextOr(attachment.stdout, null) },
  hook_blocking_error: {
    isError: true,
    textOf: (attachment) => {
      const blockingError = attachment.blockingError;
      if (typeof blockingError === 'object' && blockingError !== null) return rawTextOr(Reflect.get(blockingError, 'blockingError'), null);
      return rawTextOr(blockingError, null);
    },
  },
};

function hookMessageRecords(line: TranscriptLine, context: TraceLineContext): TraceRecord[] | null {
  const attachment = line.attachment;
  if (line.type !== 'attachment' || typeof attachment?.type !== 'string') return null;
  const hookMessage = HOOK_MESSAGE_TEXT_BY_ATTACHMENT_TYPE[attachment.type];
  if (hookMessage === undefined) return null;
  const text = withoutTerminalEscapes(hookMessage.textOf(attachment) ?? '').trim();
  const hookName = rawTextOr(attachment.hookName, null) ?? '';
  const hookEvent = rawTextOr(attachment.hookEvent, null) || hookName.split(':')[0] || 'Hook';
  const toolName = hookName.includes(':') ? hookName.slice(hookName.indexOf(':') + 1) || null : null;
  if (!text) return [];
  const isCut = text.length > MAX_RAW_LINE_CHARS;
  return [{ ...baseRecord(line, context), kind: 'hook-message', hookEvent: hookEvent.slice(0, 200), toolName: toolName?.slice(0, 200) ?? null, text: text.slice(0, MAX_RAW_LINE_CHARS), isError: hookMessage.isError, ...(isCut ? { truncated: true } : {}) }];
}

function localCommandRecords(line: TranscriptLine, context: TraceLineContext): TraceRecord[] | null {
  if (line.type !== 'system' || line.subtype !== 'local_command' || typeof line.content !== 'string') return null;
  const base = baseRecord(line, context);
  if (isTypedCommandText(line.content)) return [{ ...base, kind: 'expansion', ...boundedTextFields(line.content) }];
  const record = commandOutputRecord(base, line.content);
  return record ? [record] : [];
}

function traceRecordsFromTranscriptLine(rawLine: string, context: TraceLineContext): TraceRecord[] {
  const line = parseTranscriptLine(rawLine);
  if (!line) return [rawRecord(rawLine, null, context)];
  const queuedRecords = queuedCommandRecords(line, context);
  if (queuedRecords) return queuedRecords;
  const hookMessages = hookMessageRecords(line, context);
  if (hookMessages) return hookMessages;
  const localCommand = localCommandRecords(line, context);
  if (localCommand) return localCommand;
  const systemEvent = systemEventRecords(line, context);
  if (systemEvent) return systemEvent;
  if (isDroppedLine(line)) return [];
  if (line.type === 'user') return mapUserLine(rawLine, line, context);
  if (line.type === 'assistant') return mapAssistantLine(rawLine, line, context);
  return [rawRecord(rawLine, line, context)];
}

export {
  MAX_TRACE_BODY_CHARS,
  boundedText,
  boundedToolCallInput,
  parseTimestamp,
  traceRecordsFromTranscriptLine,
  unwrapSpilledToolOutput,
};
export type { SpillWrappingAgent, TraceLineContext };
