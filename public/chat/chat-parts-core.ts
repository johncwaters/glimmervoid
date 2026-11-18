import type { TraceRecord } from '#shared/contracts/trace.ts';
import { type ActivityBeat, beatOfRecord, loadedSkillOf } from './chat-activity-core.ts';
import type { ChatPart } from './chat-part.ts';

interface ChatPartsState {
  nextPartNumber: number;
  residentPartIds: string[];
}

interface AppendedChat {
  parts: ChatPart[];
  beats: ActivityBeat[];
}

const MAX_RESIDENT_PARTS = 2000;
const TRIM_BATCH_PARTS = 200;

export function createChatPartsState(): ChatPartsState {
  return { nextPartNumber: 0, residentPartIds: [] };
}

function nextPartId(state: ChatPartsState, kind: string): string {
  state.nextPartNumber += 1;
  const partId = `${kind}-${state.nextPartNumber}`;
  state.residentPartIds.push(partId);
  return partId;
}

function noticeCardPartOf(id: string, text: string): ChatPart {
  return { kind: 'card', id, card: { cardType: 'notice', cardId: id, data: { text }, resolution: null } };
}

function chatPartOf(state: ChatPartsState, record: TraceRecord): ChatPart | null {
  if (record.agentId !== undefined) return null;
  if (record.kind === 'prompt') return { kind: 'prompt', id: nextPartId(state, 'prompt'), text: record.text, at: record.ts };
  if (record.kind === 'assistant') return { kind: 'reply', id: nextPartId(state, 'reply'), text: record.text };
  if (record.kind === 'notice') return noticeCardPartOf(nextPartId(state, 'notice'), record.text);
  const skillName = loadedSkillOf(record);
  if (skillName !== null) return { kind: 'skill', id: nextPartId(state, 'skill'), skillName };
  return null;
}

export function appendChatRecords(state: ChatPartsState, appended: readonly TraceRecord[]): AppendedChat {
  const parts: ChatPart[] = [];
  const beats: ActivityBeat[] = [];
  for (const record of appended) {
    const part = chatPartOf(state, record);
    if (part) parts.push(part);
    const beat = beatOfRecord(record);
    if (beat) beats.push(beat);
  }
  return { parts, beats };
}

export function trimChatParts(state: ChatPartsState, maxResidentParts = MAX_RESIDENT_PARTS): string[] {
  if (state.residentPartIds.length <= maxResidentParts + TRIM_BATCH_PARTS) return [];
  return state.residentPartIds.splice(0, state.residentPartIds.length - maxResidentParts);
}
