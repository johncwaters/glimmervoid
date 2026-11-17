import type { TraceRecord } from '#shared/contracts/trace.ts';
import type { ChatPart, ChatToolCall, ChatToolOutcome } from './chat-part.ts';
import { editToolInputOf, outputExcerptOf, type PathContext, shortenedPaths, toolSummaryOf } from './tool-call-core.ts';

type ToolsPart = Extract<ChatPart, { kind: 'tools' }>;
type ToolOutcomeLookup = ReadonlyMap<string, ChatToolOutcome>;

interface ChatPartsState {
  pathContext: PathContext;
  nextPartNumber: number;
  openGroupId: string | null;
  groupById: Map<string, ToolsPart>;
  groupIdByToolUseId: Map<string, string>;
}

const MAX_EDIT_PATH_CHARS = 1024;
const RUNNING: ChatToolOutcome = { status: 'running' };

export function createChatPartsState(pathContext: PathContext): ChatPartsState {
  return { pathContext, nextPartNumber: 0, openGroupId: null, groupById: new Map(), groupIdByToolUseId: new Map() };
}

function nextPartId(state: ChatPartsState, kind: string): string {
  state.nextPartNumber += 1;
  return `${kind}-${state.nextPartNumber}`;
}

function toolCallOf(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'tool_call' }>, outcomeByToolUseId: ToolOutcomeLookup): ChatToolCall {
  const summary = toolSummaryOf(record.name, record.input, state.pathContext);
  const editInput = record.truncated ? null : editToolInputOf(record.name, record.input);
  const edit = editInput ? { ...editInput, filePath: shortenedPaths(editInput.filePath.slice(0, MAX_EDIT_PATH_CHARS), state.pathContext) } : null;
  const outcome = outcomeByToolUseId.get(record.toolUseId) ?? RUNNING;
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

function withToolResult(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'tool_result' }>, outcomeByToolUseId: ToolOutcomeLookup): ToolsPart | null {
  const groupId = state.groupIdByToolUseId.get(record.toolUseId);
  const group = groupId === undefined ? undefined : state.groupById.get(groupId);
  if (!group) return null;
  const outcome = outcomeByToolUseId.get(record.toolUseId) ?? { status: 'done', isError: record.isError, truncated: record.truncated };
  const calls = group.calls.map((call) => (call.toolUseId === record.toolUseId ? { ...call, outcome, excerpt: outputExcerptOf(record.content) } : call));
  return storeGroup(state, { ...group, calls });
}

function closingGroup(state: ChatPartsState, part: ChatPart): ChatPart {
  state.openGroupId = null;
  return part;
}

function noticeCardPartOf(id: string, text: string): ChatPart {
  return { kind: 'card', id, card: { cardType: 'notice', cardId: id, data: { text }, resolution: null } };
}

function chatPartOf(state: ChatPartsState, record: TraceRecord, outcomeByToolUseId: ToolOutcomeLookup): ChatPart | null {
  if (record.kind === 'prompt') return closingGroup(state, { kind: 'prompt', id: nextPartId(state, 'prompt'), text: record.text });
  if (record.kind === 'assistant') return closingGroup(state, { kind: 'reply', id: nextPartId(state, 'reply'), text: record.text });
  if (record.kind === 'thinking' && record.text.trim().length > 0) return closingGroup(state, { kind: 'thinking', id: nextPartId(state, 'thinking'), text: record.text });
  if (record.kind === 'notice') return closingGroup(state, noticeCardPartOf(nextPartId(state, 'notice'), record.text));
  if (record.kind === 'tool_call') return addToolCall(state, toolCallOf(state, record, outcomeByToolUseId));
  if (record.kind === 'tool_result') return withToolResult(state, record, outcomeByToolUseId);
  return null;
}

export function appendChatRecords(state: ChatPartsState, appended: readonly TraceRecord[], outcomeByToolUseId: ToolOutcomeLookup): ChatPart[] {
  const changedPartById = new Map<string, ChatPart>();
  for (const record of appended) {
    const part = chatPartOf(state, record, outcomeByToolUseId);
    if (part) changedPartById.set(part.id, part);
  }
  return [...changedPartById.values()];
}
