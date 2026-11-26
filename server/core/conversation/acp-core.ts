import type { ContentBlock, SessionConfigOption, SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk';
import type { DriverEvent } from '../../../session/drivers/driver.ts';
import { MAX_RAW_LINE_CHARS, PermissionMode } from '../../../shared/contracts/trace.ts';
import type { TraceRecord } from '../../../shared/contracts/trace.ts';
import { boundedText, boundedToolCallInput } from '../trace-core.ts';
import { textRecords } from './converter-parts.ts';
import type { RecordBase } from './converter-parts.ts';

type ChunkKind = 'prompt' | 'assistant' | 'thinking';

interface OpenChunk {
  kind: ChunkKind;
  messageId: string | null;
  vendorSessionId: string;
  ts: number;
  text: string;
  isTruncated: boolean;
}

interface PendingToolCall {
  toolUseId: string;
  name: string;
  input: unknown;
  vendorSessionId: string;
  ts: number;
}

interface SubagentTracker {
  subagentType: string | null;
  task: string | null;
  lastPhase: 'start' | 'stop' | null;
}

interface AcpTraceState {
  openChunk: OpenChunk | null;
  pendingToolCalls: Map<string, PendingToolCall>;
  subagentById: Map<string, SubagentTracker>;
  lastModel: string | null;
  lastMode: string | null;
  lastVendorSessionId: string | null;
}

interface AcpUpdateContext {
  vendorSessionId: string;
  now: number;
}

const FALLBACK_TOOL_NAME = 'tool';
const MAX_MODEL_NAME_CHARS = 200;
const MAX_MODE_NAME_CHARS = 64;

function createAcpTraceState(): AcpTraceState {
  return {
    openChunk: null,
    pendingToolCalls: new Map(),
    subagentById: new Map(),
    lastModel: null,
    lastMode: null,
    lastVendorSessionId: null,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptyInput(rawInput: unknown): boolean {
  if (rawInput === undefined || rawInput === null) return true;
  if (!isRecord(rawInput)) return false;
  return Object.keys(rawInput).length === 0;
}

function textOfContentBlock(block: ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'resource' && 'text' in block.resource && typeof block.resource.text === 'string') return block.resource.text;
  if (block.type === 'resource_link') return block.name || block.uri;
  return '';
}

function textOfToolCallContent(item: ToolCallContent): string {
  if (item.type === 'content') return textOfContentBlock(item.content);
  if (item.type === 'diff') return `diff ${item.path}`;
  if (item.type === 'terminal') return `terminal ${item.terminalId}`;
  return '';
}

function toolOutputTextOf(content: readonly ToolCallContent[] | null | undefined, rawOutput: unknown): string {
  if (typeof rawOutput === 'string' && rawOutput.length > 0) return rawOutput;
  const contentText = (content ?? []).map(textOfToolCallContent).filter((piece) => piece.length > 0).join('\n');
  if (contentText.length > 0) return contentText;
  if (rawOutput === undefined || rawOutput === null || rawOutput === '') return '';
  const serialized = JSON.stringify(rawOutput);
  return typeof serialized === 'string' ? serialized : '';
}

function claudeMetaToolNameOf(meta: Record<string, unknown> | null | undefined): string | null {
  if (!isRecord(meta)) return null;
  const claudeCode = meta.claudeCode;
  if (!isRecord(claudeCode)) return null;
  return nonEmptyString(claudeCode.toolName);
}

function toolNameOf(update: { _meta?: Record<string, unknown> | null; name?: string | null; title?: string | null; kind?: string | null }): string {
  return claudeMetaToolNameOf(update._meta)
    ?? nonEmptyString(update.name)
    ?? nonEmptyString(update.title)
    ?? nonEmptyString(update.kind)
    ?? FALLBACK_TOOL_NAME;
}

function baseOf(vendorSessionId: string, ts: number, uuid: string | null = null): RecordBase {
  return { ts, uuid, parentUuid: null, vendorSessionId };
}

function flushOpenChunk(state: AcpTraceState): TraceRecord[] {
  const chunk = state.openChunk;
  if (chunk === null) return [];
  state.openChunk = null;
  const records = textRecords(baseOf(chunk.vendorSessionId, chunk.ts, chunk.messageId), chunk.kind, chunk.text);
  if (!chunk.isTruncated) return records;
  return records.map((record) => ({ ...record, truncated: true }));
}

function toolCallRecordOf(pending: PendingToolCall): TraceRecord {
  return {
    ...baseOf(pending.vendorSessionId, pending.ts),
    kind: 'tool_call',
    toolUseId: pending.toolUseId,
    name: pending.name,
    ...boundedToolCallInput(pending.input),
  };
}

function flushPendingToolCall(state: AcpTraceState, toolUseId: string): TraceRecord | null {
  const pending = state.pendingToolCalls.get(toolUseId);
  if (pending === undefined) return null;
  state.pendingToolCalls.delete(toolUseId);
  return toolCallRecordOf(pending);
}

function flushAcpTraceState(state: AcpTraceState): TraceRecord[] {
  const records = flushOpenChunk(state);
  for (const pending of state.pendingToolCalls.values()) records.push(toolCallRecordOf(pending));
  state.pendingToolCalls.clear();
  return records;
}

function appendChunk(
  state: AcpTraceState,
  kind: ChunkKind,
  messageId: string | null,
  text: string,
  context: AcpUpdateContext,
): TraceRecord[] {
  if (text.length === 0) return [];
  const open = state.openChunk;
  if (open !== null && open.kind === kind && open.vendorSessionId === context.vendorSessionId && open.messageId === messageId) {
    if (open.isTruncated) return [];
    const bounded = boundedText(open.text + text);
    open.text = bounded.text;
    open.isTruncated = bounded.truncated;
    return [];
  }
  const flushed = flushOpenChunk(state);
  const bounded = boundedText(text);
  state.openChunk = {
    kind,
    messageId,
    vendorSessionId: context.vendorSessionId,
    ts: context.now,
    text: bounded.text,
    isTruncated: bounded.truncated,
  };
  return flushed;
}

function toolResultRecordOf(
  base: RecordBase,
  toolUseId: string,
  content: readonly ToolCallContent[] | null | undefined,
  rawOutput: unknown,
  isError: boolean,
): TraceRecord {
  const bounded = boundedText(toolOutputTextOf(content, rawOutput));
  return {
    ...base,
    kind: 'tool_result',
    toolUseId,
    content: bounded.text,
    isError,
    truncated: bounded.truncated,
  };
}

function handleToolCall(
  state: AcpTraceState,
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>,
  context: AcpUpdateContext,
): TraceRecord[] {
  const toolUseId = nonEmptyString(update.toolCallId);
  if (toolUseId === null) return [];
  const flushed = flushOpenChunk(state);
  const name = toolNameOf(update);
  const isTerminal = update.status === 'completed' || update.status === 'failed';
  if (!isTerminal && update.status === 'pending' && isEmptyInput(update.rawInput)) {
    state.pendingToolCalls.set(toolUseId, {
      toolUseId,
      name,
      input: update.rawInput ?? null,
      vendorSessionId: context.vendorSessionId,
      ts: context.now,
    });
    return flushed;
  }
  state.pendingToolCalls.delete(toolUseId);
  const base = baseOf(context.vendorSessionId, context.now);
  const callRecord: TraceRecord = {
    ...base,
    kind: 'tool_call',
    toolUseId,
    name,
    ...boundedToolCallInput(update.rawInput ?? null),
  };
  if (!isTerminal) return [...flushed, callRecord];
  const resultRecord = toolResultRecordOf(base, toolUseId, update.content, update.rawOutput, update.status === 'failed');
  return [...flushed, callRecord, resultRecord];
}

function handleToolCallUpdate(
  state: AcpTraceState,
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>,
  context: AcpUpdateContext,
): TraceRecord[] {
  const toolUseId = nonEmptyString(update.toolCallId);
  if (toolUseId === null) return [];
  const pending = state.pendingToolCalls.get(toolUseId);
  if (pending !== undefined) {
    if (!isEmptyInput(update.rawInput)) pending.input = update.rawInput;
    const explicitName = claudeMetaToolNameOf(update._meta) ?? nonEmptyString(update.name);
    if (explicitName !== null) pending.name = explicitName;
  }
  if (update.status !== 'completed' && update.status !== 'failed') return [];
  const flushed = flushOpenChunk(state);
  const emittedCall = flushPendingToolCall(state, toolUseId);
  const base = baseOf(context.vendorSessionId, context.now);
  const resultRecord = toolResultRecordOf(base, toolUseId, update.content, update.rawOutput, update.status === 'failed');
  return emittedCall === null ? [...flushed, resultRecord] : [...flushed, emittedCall, resultRecord];
}

function configOptionValueOf(configOptions: readonly SessionConfigOption[], category: string, maxChars: number): string | null {
  for (const option of configOptions) {
    if (option.category !== category) continue;
    if (!('currentValue' in option)) continue;
    const value = nonEmptyString(option.currentValue);
    if (value !== null) return value.slice(0, maxChars);
  }
  return null;
}

function permissionModeRecordOf(state: AcpTraceState, rawModeId: unknown, context: AcpUpdateContext): TraceRecord | null {
  const modeName = nonEmptyString(rawModeId)?.slice(0, MAX_MODE_NAME_CHARS);
  if (modeName === undefined || state.lastMode === modeName) return null;
  state.lastMode = modeName;
  const parsed = PermissionMode.safeParse(modeName);
  const mode = parsed.success ? parsed.data : 'other';
  return { ...baseOf(context.vendorSessionId, context.now), kind: 'permission-mode', mode, modeName };
}

function handleConfigOptionUpdate(
  state: AcpTraceState,
  update: Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }>,
  context: AcpUpdateContext,
): TraceRecord[] {
  const records: TraceRecord[] = [];
  const model = configOptionValueOf(update.configOptions, 'model', MAX_MODEL_NAME_CHARS);
  if (model !== null && state.lastModel !== model) {
    state.lastModel = model;
    records.push({ ...baseOf(context.vendorSessionId, context.now), kind: 'model-change', model });
  }
  const modeOption = configOptionValueOf(update.configOptions, 'mode', MAX_MODE_NAME_CHARS);
  const modeRecord = permissionModeRecordOf(state, modeOption, context);
  if (modeRecord !== null) records.push(modeRecord);
  if (records.length === 0) return [];
  return [...flushOpenChunk(state), ...records];
}

function handleCurrentModeUpdate(
  state: AcpTraceState,
  update: Extract<SessionUpdate, { sessionUpdate: 'current_mode_update' }>,
  context: AcpUpdateContext,
): TraceRecord[] {
  const modeRecord = permissionModeRecordOf(state, update.currentModeId, context);
  if (modeRecord === null) return [];
  return [...flushOpenChunk(state), modeRecord];
}

function handleSubagentUpdate(
  state: AcpTraceState,
  update: Extract<SessionUpdate, { sessionUpdate: 'subagent_update' }>,
  context: AcpUpdateContext,
): TraceRecord[] {
  const subagentId = nonEmptyString(update.sessionId);
  if (subagentId === null) return [];
  const tracker = state.subagentById.get(subagentId) ?? { subagentType: null, task: null, lastPhase: null };
  if (update.description !== undefined) tracker.subagentType = nonEmptyString(update.description);
  if (update.title !== undefined) tracker.task = nonEmptyString(update.title);
  state.subagentById.set(subagentId, tracker);
  const subagentState = update.state?.state;
  if (subagentState !== 'running' && subagentState !== 'idle') return [];
  const phase = subagentState === 'running' ? 'start' : 'stop';
  if (tracker.lastPhase === phase) return [];
  tracker.lastPhase = phase;
  return [
    ...flushOpenChunk(state),
    {
      ...baseOf(context.vendorSessionId, context.now),
      kind: 'subagent',
      phase,
      subagentId,
      subagentType: tracker.subagentType,
      task: tracker.task,
    },
  ];
}

function handleNotice(
  state: AcpTraceState,
  update: Extract<SessionUpdate, { sessionUpdate: 'notice' }>,
  context: AcpUpdateContext,
): TraceRecord[] {
  const detail = nonEmptyString(update.description);
  const text = (detail === null ? update.title : `${update.title}: ${detail}`).slice(0, MAX_RAW_LINE_CHARS);
  return [...flushOpenChunk(state), { ...baseOf(context.vendorSessionId, context.now), kind: 'notice', text }];
}

function handleCompactionUpdate(
  state: AcpTraceState,
  update: Extract<SessionUpdate, { sessionUpdate: 'compaction_update' }>,
  context: AcpUpdateContext,
): TraceRecord[] {
  if (update.status !== 'completed') return [];
  return [...flushOpenChunk(state), { ...baseOf(context.vendorSessionId, context.now), kind: 'compaction', tokensBefore: null, tokensAfter: null }];
}

function acpRecordsFromUpdate(state: AcpTraceState, update: SessionUpdate, context: AcpUpdateContext): TraceRecord[] {
  const vendorSessionId = nonEmptyString(context.vendorSessionId) ?? state.lastVendorSessionId;
  if (vendorSessionId === null) return [];
  state.lastVendorSessionId = vendorSessionId;
  const resolvedContext: AcpUpdateContext = { vendorSessionId, now: context.now };
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return appendChunk(state, 'prompt', nonEmptyString(update.messageId), textOfContentBlock(update.content), resolvedContext);
    case 'agent_message_chunk':
      return appendChunk(state, 'assistant', nonEmptyString(update.messageId), textOfContentBlock(update.content), resolvedContext);
    case 'agent_thought_chunk':
      return appendChunk(state, 'thinking', nonEmptyString(update.messageId), textOfContentBlock(update.content), resolvedContext);
    case 'tool_call':
      return handleToolCall(state, update, resolvedContext);
    case 'tool_call_update':
      return handleToolCallUpdate(state, update, resolvedContext);
    case 'config_option_update':
      return handleConfigOptionUpdate(state, update, resolvedContext);
    case 'current_mode_update':
      return handleCurrentModeUpdate(state, update, resolvedContext);
    case 'subagent_update':
      return handleSubagentUpdate(state, update, resolvedContext);
    case 'notice':
      return handleNotice(state, update, resolvedContext);
    case 'compaction_update':
      return handleCompactionUpdate(state, update, resolvedContext);
    default:
      return [];
  }
}

function acpRecordsFromDriverEvent(state: AcpTraceState, event: DriverEvent, now: number): TraceRecord[] {
  if (event.kind === 'agent-session') {
    const vendorSessionId = nonEmptyString(event.agentSessionId);
    if (vendorSessionId !== null) state.lastVendorSessionId = vendorSessionId;
    return [];
  }
  if (event.kind === 'update') {
    return acpRecordsFromUpdate(state, event.update, { vendorSessionId: event.agentSessionId, now });
  }
  if (event.kind === 'permission') {
    const toolUseId = nonEmptyString(event.request.toolCallId);
    if (toolUseId === null) return [];
    const pending = state.pendingToolCalls.get(toolUseId);
    if (pending === undefined) return [];
    if (!isEmptyInput(event.request.rawInput)) pending.input = event.request.rawInput;
    const flushed = flushOpenChunk(state);
    const emittedCall = flushPendingToolCall(state, toolUseId);
    return emittedCall === null ? flushed : [...flushed, emittedCall];
  }
  if (event.kind === 'question') {
    const toolUseId = nonEmptyString(event.question.toolCallId);
    if (toolUseId === null || !state.pendingToolCalls.has(toolUseId)) return [];
    const flushed = flushOpenChunk(state);
    const emittedCall = flushPendingToolCall(state, toolUseId);
    return emittedCall === null ? flushed : [...flushed, emittedCall];
  }
  if (event.kind === 'turn-end' || event.kind === 'exit') {
    return flushAcpTraceState(state);
  }
  return [];
}

export { acpRecordsFromDriverEvent, acpRecordsFromUpdate, createAcpTraceState, flushAcpTraceState };
