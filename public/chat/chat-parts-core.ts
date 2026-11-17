import type { TraceRecord } from '#shared/contracts/trace.ts';
import type { ChatPart, ChatToolCall, ChatToolOutcome } from './chat-part.ts';
import { editToolInputOf, outputExcerptOf, type PathContext, shortenedPaths, toolSummaryOf } from './tool-call-core.ts';

type ToolsPart = Extract<ChatPart, { kind: 'tools' }>;
type ToolOutcomeLookup = (toolUseId: string) => ChatToolOutcome | null;

interface ChatPartsState {
  pathContext: PathContext;
  nextPartNumber: number;
  openGroupId: string | null;
  groupById: Map<string, ToolsPart>;
  groupIdByToolUseId: Map<string, string>;
  runningToolUseIds: Set<string>;
  residentPartIds: string[];
}

const MAX_EDIT_PATH_CHARS = 1024;
const RUNNING: ChatToolOutcome = { status: 'running' };
const MAX_RESIDENT_PARTS = 2000;
const TRIM_BATCH_PARTS = 200;

export function createChatPartsState(pathContext: PathContext): ChatPartsState {
  return { pathContext, nextPartNumber: 0, openGroupId: null, groupById: new Map(), groupIdByToolUseId: new Map(), runningToolUseIds: new Set(), residentPartIds: [] };
}

function nextPartId(state: ChatPartsState, kind: string): string {
  state.nextPartNumber += 1;
  const partId = `${kind}-${state.nextPartNumber}`;
  state.residentPartIds.push(partId);
  return partId;
}

function toolCallOf(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'tool_call' }>, outcomeOf: ToolOutcomeLookup): ChatToolCall {
  const summary = toolSummaryOf(record.name, record.input, state.pathContext);
  const editInput = record.truncated ? null : editToolInputOf(record.name, record.input);
  const edit = editInput ? { ...editInput, filePath: shortenedPaths(editInput.filePath.slice(0, MAX_EDIT_PATH_CHARS), state.pathContext) } : null;
  const outcome = outcomeOf(record.toolUseId) ?? RUNNING;
  if (outcome.status === 'running') state.runningToolUseIds.add(record.toolUseId);
  return { toolUseId: record.toolUseId, name: record.name, ...summary, outcome, excerpt: null, edit };
}

function storeGroup(state: ChatPartsState, group: ToolsPart): ToolsPart {
  state.groupById.set(group.id, group);
  for (const call of group.calls) state.groupIdByToolUseId.set(call.toolUseId, group.id);
  return group;
}

function openGroupOf(state: ChatPartsState): ToolsPart | null {
  return state.openGroupId === null ? null : state.groupById.get(state.openGroupId) ?? null;
}

function addToolCall(state: ChatPartsState, call: ChatToolCall): ToolsPart {
  const openGroup = openGroupOf(state);
  if (openGroup) return storeGroup(state, { ...openGroup, calls: [...openGroup.calls, call] });
  const group: ToolsPart = { kind: 'tools', id: nextPartId(state, 'tools'), calls: [call] };
  state.openGroupId = group.id;
  return storeGroup(state, group);
}

function withCallChanged(state: ChatPartsState, toolUseId: string, change: Partial<ChatToolCall>): ToolsPart | null {
  const groupId = state.groupIdByToolUseId.get(toolUseId);
  const group = groupId === undefined ? undefined : state.groupById.get(groupId);
  if (!group) return null;
  if (change.outcome && change.outcome.status !== 'running') state.runningToolUseIds.delete(toolUseId);
  const calls = group.calls.map((call) => (call.toolUseId === toolUseId ? { ...call, ...change } : call));
  return storeGroup(state, { ...group, calls });
}

function withToolResult(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'tool_result' }>): ToolsPart | null {
  const outcome: ChatToolOutcome = { status: 'done', isError: record.isError, truncated: record.truncated };
  return withCallChanged(state, record.toolUseId, { outcome, excerpt: outputExcerptOf(record.content) });
}

function closingGroup(state: ChatPartsState, part: ChatPart): ChatPart {
  state.openGroupId = null;
  return part;
}

function noticeCardPartOf(id: string, text: string): ChatPart {
  return { kind: 'card', id, card: { cardType: 'notice', cardId: id, data: { text }, resolution: null } };
}

function chatPartOf(state: ChatPartsState, record: TraceRecord, outcomeOf: ToolOutcomeLookup): ChatPart | null {
  if (record.kind === 'prompt') return closingGroup(state, { kind: 'prompt', id: nextPartId(state, 'prompt'), text: record.text });
  if (record.kind === 'assistant') return closingGroup(state, { kind: 'reply', id: nextPartId(state, 'reply'), text: record.text });
  if (record.kind === 'thinking' && record.text.trim().length > 0) return closingGroup(state, { kind: 'thinking', id: nextPartId(state, 'thinking'), text: record.text });
  if (record.kind === 'notice') return closingGroup(state, noticeCardPartOf(nextPartId(state, 'notice'), record.text));
  if (record.kind === 'tool_call') return addToolCall(state, toolCallOf(state, record, outcomeOf));
  if (record.kind === 'tool_result') return withToolResult(state, record);
  return null;
}

export function appendChatRecords(state: ChatPartsState, appended: readonly TraceRecord[], outcomeOf: ToolOutcomeLookup): ChatPart[] {
  const changedPartById = new Map<string, ChatPart>();
  for (const record of appended) {
    const part = chatPartOf(state, record, outcomeOf);
    if (part) changedPartById.set(part.id, part);
  }
  for (const part of refreshRunningCalls(state, outcomeOf)) changedPartById.set(part.id, part);
  return [...changedPartById.values()];
}

export function refreshRunningCalls(state: ChatPartsState, outcomeOf: ToolOutcomeLookup): ChatPart[] {
  const changedPartById = new Map<string, ChatPart>();
  for (const toolUseId of [...state.runningToolUseIds]) {
    const outcome = outcomeOf(toolUseId);
    if (outcome === null || outcome.status === 'running') continue;
    const group = withCallChanged(state, toolUseId, { outcome });
    if (group) changedPartById.set(group.id, group);
  }
  return [...changedPartById.values()];
}

function forgetPart(state: ChatPartsState, partId: string): void {
  const group = state.groupById.get(partId);
  if (!group) return;
  state.groupById.delete(partId);
  if (state.openGroupId === partId) state.openGroupId = null;
  for (const call of group.calls) {
    state.groupIdByToolUseId.delete(call.toolUseId);
    state.runningToolUseIds.delete(call.toolUseId);
  }
}

export function trimChatParts(state: ChatPartsState, maxResidentParts = MAX_RESIDENT_PARTS): string[] {
  if (state.residentPartIds.length <= maxResidentParts + TRIM_BATCH_PARTS) return [];
  const droppedPartIds = state.residentPartIds.splice(0, state.residentPartIds.length - maxResidentParts);
  for (const partId of droppedPartIds) forgetPart(state, partId);
  return droppedPartIds;
}
