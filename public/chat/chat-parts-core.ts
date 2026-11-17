import type { TraceRecord } from '#shared/contracts/trace.ts';
import type { ChatPart } from './chat-part.ts';

interface ChatPartsState {
  nextPartNumber: number;
}

export function createChatPartsState(): ChatPartsState {
  return { nextPartNumber: 0 };
}

function nextPartId(state: ChatPartsState, kind: string): string {
  state.nextPartNumber += 1;
  return `${kind}-${state.nextPartNumber}`;
}

function chatPartOf(state: ChatPartsState, record: TraceRecord): ChatPart | null {
  if (record.kind === 'prompt') return { kind: 'prompt', id: nextPartId(state, 'prompt'), text: record.text };
  if (record.kind === 'assistant') return { kind: 'reply', id: nextPartId(state, 'reply'), text: record.text };
  if (record.kind === 'thinking') return { kind: 'thinking', id: nextPartId(state, 'thinking'), text: record.text };
  return null;
}

export function appendChatRecords(state: ChatPartsState, appended: readonly TraceRecord[]): ChatPart[] {
  const changedParts: ChatPart[] = [];
  for (const record of appended) {
    const part = chatPartOf(state, record);
    if (part) changedParts.push(part);
  }
  return changedParts;
}

export function replyParagraphsOf(text: string): string[] {
  return text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph.length > 0);
}
