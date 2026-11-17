import type { TraceRecord } from '#shared/contracts/trace.ts';
import type { ChatPart, ChatToolOutcome } from './chat-part.ts';
import { editToolInputOf, mainInputOf, outputExcerptOf } from './tool-card-core.ts';

type ToolPart = Extract<ChatPart, { kind: 'tool' | 'edit' }>;
type ToolOutcomeLookup = ReadonlyMap<string, ChatToolOutcome>;

interface ChatPartsState {
  nextPartNumber: number;
  toolPartByUseId: Map<string, ToolPart>;
}

const RUNNING: ChatToolOutcome = { status: 'running' };

export function createChatPartsState(): ChatPartsState {
  return { nextPartNumber: 0, toolPartByUseId: new Map() };
}

function nextPartId(state: ChatPartsState, kind: string): string {
  state.nextPartNumber += 1;
  return `${kind}-${state.nextPartNumber}`;
}

function toolPartOf(record: Extract<TraceRecord, { kind: 'tool_call' }>, outcomeByToolUseId: ToolOutcomeLookup): ToolPart {
  const outcome = outcomeByToolUseId.get(record.toolUseId) ?? RUNNING;
  const editInput = record.truncated ? null : editToolInputOf(record.name, record.input);
  if (editInput) return { kind: 'edit', id: `tool-${record.toolUseId}`, toolUseId: record.toolUseId, name: record.name, ...editInput, outcome };
  return { kind: 'tool', id: `tool-${record.toolUseId}`, toolUseId: record.toolUseId, name: record.name, mainInput: mainInputOf(record.input), outcome, excerpt: null };
}

function withResult(part: ToolPart, record: Extract<TraceRecord, { kind: 'tool_result' }>, outcomeByToolUseId: ToolOutcomeLookup): ToolPart {
  const outcome = outcomeByToolUseId.get(record.toolUseId) ?? { status: 'done', isError: record.isError, truncated: record.truncated };
  if (part.kind === 'edit') return { ...part, outcome };
  return { ...part, outcome, excerpt: outputExcerptOf(record.content) };
}

function storeToolPart(state: ChatPartsState, part: ToolPart): ToolPart {
  state.toolPartByUseId.set(part.toolUseId, part);
  return part;
}

function noticeCardPartOf(id: string, text: string): ChatPart {
  return { kind: 'card', id, card: { cardType: 'notice', cardId: id, data: { text }, resolution: null } };
}

function chatPartOf(state: ChatPartsState, record: TraceRecord, outcomeByToolUseId: ToolOutcomeLookup): ChatPart | null {
  if (record.kind === 'prompt') return { kind: 'prompt', id: nextPartId(state, 'prompt'), text: record.text };
  if (record.kind === 'assistant') return { kind: 'reply', id: nextPartId(state, 'reply'), text: record.text };
  if (record.kind === 'thinking') return { kind: 'thinking', id: nextPartId(state, 'thinking'), text: record.text };
  if (record.kind === 'notice') return noticeCardPartOf(nextPartId(state, 'notice'), record.text);
  if (record.kind === 'tool_call') return storeToolPart(state, toolPartOf(record, outcomeByToolUseId));
  if (record.kind !== 'tool_result') return null;
  const calledPart = state.toolPartByUseId.get(record.toolUseId);
  return calledPart ? storeToolPart(state, withResult(calledPart, record, outcomeByToolUseId)) : null;
}

export function appendChatRecords(state: ChatPartsState, appended: readonly TraceRecord[], outcomeByToolUseId: ToolOutcomeLookup): ChatPart[] {
  const changedParts: ChatPart[] = [];
  for (const record of appended) {
    const part = chatPartOf(state, record, outcomeByToolUseId);
    if (part) changedParts.push(part);
  }
  return changedParts;
}

export function replyParagraphsOf(text: string): string[] {
  return text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph.length > 0);
}
