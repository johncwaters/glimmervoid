import type { TraceRecord } from '#shared/contracts/trace.ts';
import { twoUnitDurationText } from '#shared/display-text.ts';
import { type ActivityBeat, beatOfRecord, loadedSkillOf } from './chat-activity-core.ts';
import type { ChatPart } from './chat-part.ts';

interface ChatTurn {
  promptAt: number | null;
  hasToolWork: boolean;
  finalReplyPartId: string | null;
  finalReplyAt: number;
}

interface ChatPartsState {
  nextPartNumber: number;
  residentPartIds: string[];
  turn: ChatTurn;
}

export interface TurnMarks {
  supersededPartIds: string[];
  workedFor: { partId: string; text: string | null }[];
}

interface AppendedChat {
  parts: ChatPart[];
  beats: ActivityBeat[];
  marks: TurnMarks;
}

const MAX_RESIDENT_PARTS = 2000;
const TRIM_BATCH_PARTS = 200;

export function createChatPartsState(): ChatPartsState {
  return { nextPartNumber: 0, residentPartIds: [], turn: freshTurn(null) };
}

function freshTurn(promptAt: number | null): ChatTurn {
  return { promptAt, hasToolWork: false, finalReplyPartId: null, finalReplyAt: 0 };
}

function workedForText(workedForMs: number): string {
  const workedForSeconds = Math.max(1, Math.floor(workedForMs / 1000));
  return `Worked for ${twoUnitDurationText(workedForSeconds, { smallestUnit: 's', dropsZeroRemainder: false })}`;
}

export function endChatTurn(state: ChatPartsState): TurnMarks {
  const { promptAt, hasToolWork, finalReplyPartId, finalReplyAt } = state.turn;
  if (finalReplyPartId === null || promptAt === null || !hasToolWork || finalReplyAt <= promptAt) return { supersededPartIds: [], workedFor: [] };
  return { supersededPartIds: [], workedFor: [{ partId: finalReplyPartId, text: workedForText(finalReplyAt - promptAt) }] };
}

function noteTurnRecord(state: ChatPartsState, record: TraceRecord, part: ChatPart | null, marks: TurnMarks): void {
  if (record.agentId !== undefined) return;
  if (record.kind === 'prompt' || (record.kind === 'expansion' && record.toolUseId === undefined)) {
    marks.workedFor.push(...endChatTurn(state).workedFor);
    state.turn = freshTurn(record.ts);
    return;
  }
  if (record.kind === 'tool_call') {
    state.turn.hasToolWork = true;
    return;
  }
  if (part?.kind !== 'reply') return;
  const supersededPartId = state.turn.finalReplyPartId;
  if (supersededPartId !== null) {
    marks.supersededPartIds.push(supersededPartId);
    marks.workedFor.push({ partId: supersededPartId, text: null });
  }
  state.turn.finalReplyPartId = part.id;
  state.turn.finalReplyAt = record.ts;
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
  const marks: TurnMarks = { supersededPartIds: [], workedFor: [] };
  for (const record of appended) {
    const part = chatPartOf(state, record);
    if (part) parts.push(part);
    noteTurnRecord(state, record, part, marks);
    const beat = beatOfRecord(record);
    if (beat) beats.push(beat);
  }
  return { parts, beats, marks };
}

export function trimChatParts(state: ChatPartsState, maxResidentParts = MAX_RESIDENT_PARTS): string[] {
  if (state.residentPartIds.length <= maxResidentParts + TRIM_BATCH_PARTS) return [];
  return state.residentPartIds.splice(0, state.residentPartIds.length - maxResidentParts);
}
