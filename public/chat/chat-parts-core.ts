import type { TraceRecord } from '#shared/contracts/trace.ts';
import { twoUnitDurationText } from '#shared/display-text.ts';
import { type ActivityBeat, beatOfRecord, isEditingTool, loadedSkillOf } from './chat-activity-core.ts';
import type { ChatPart, TurnPart } from './chat-part.ts';
import type { RunningSubagent } from './status-rail-core.ts';
import { SUBAGENT_TOOL_NAMES } from '#shared/subagent-tools.ts';
import { opensOperatorTurn } from '#shared/trace-turn.ts';
import { fileEditsOf, truncatedFileEditsOf, toolLabelOf } from './turn-digest-core.ts';
import type { FileEdit, FileEditTally, TurnSegment } from './turn-digest-core.ts';

interface ChatTurn {
  promptAt: number | null;
  firstAt: number | null;
  partId: string | null;
  segments: TurnSegment[];
  droppedSegmentCount: number;
  toolCount: number;
  editedPaths: Set<string>;
  fileEdits: FileEditTally;
  lastAt: number;
  isOver: boolean;
}

type PromptPart = Extract<ChatPart, { kind: 'prompt' }>;
type SentAttachments = Pick<Extract<TraceRecord, { kind: 'attachments' }>, 'files' | 'pastedPrefix'>;

interface ChatPartsState {
  nextPartNumber: number;
  residentPartIds: string[];
  turn: ChatTurn;
  pendingAttachments: SentAttachments | null;
  latestPrompt: PromptPart | null;
  runningSubagentByToolUseId: Map<string, RunningSubagent>;
  workingDirectory: string | null;
}

interface AppendedChat {
  parts: ChatPart[];
  beats: ActivityBeat[];
  runningSubagents: RunningSubagent[];
}

const MAX_RESIDENT_PARTS = 2000;
const MAX_TURN_SEGMENTS = 400;
const MAX_TOOL_LABELS_PER_SEGMENT = 50;
const TRIM_BATCH_PARTS = 200;

export function createChatPartsState(workingDirectory: string | null = null): ChatPartsState {
  return { nextPartNumber: 0, residentPartIds: [], turn: freshTurn(null), pendingAttachments: null, latestPrompt: null, runningSubagentByToolUseId: new Map(), workingDirectory };
}

function freshTurn(promptAt: number | null): ChatTurn {
  return { promptAt, firstAt: null, partId: null, segments: [], droppedSegmentCount: 0, toolCount: 0, editedPaths: new Set(), fileEdits: { fileCount: 0, added: 0, removed: 0, hasLineCounts: true }, lastAt: 0, isOver: false };
}

function durationTextOf(turn: ChatTurn): string | null {
  if (turn.promptAt === null || turn.lastAt <= turn.promptAt) return null;
  return twoUnitDurationText(Math.max(1, Math.floor((turn.lastAt - turn.promptAt) / 1000)), { smallestUnit: 's', dropsZeroRemainder: false });
}

function turnPartOf(turn: ChatTurn, partId: string): TurnPart {
  return {
    kind: 'turn',
    id: partId,
    turnKey: turn.promptAt ?? turn.firstAt,
    segments: turn.segments,
    droppedSegmentCount: turn.droppedSegmentCount,
    toolCount: turn.toolCount,
    fileEdits: { ...turn.fileEdits },
    durationText: turn.isOver ? durationTextOf(turn) : null,
    isOver: turn.isOver,
  };
}

export function endChatTurn(state: ChatPartsState): ChatPart[] {
  const { turn } = state;
  if (turn.partId === null || turn.isOver) return [];
  turn.isOver = true;
  return [turnPartOf(turn, turn.partId)];
}

function pushSegment(turn: ChatTurn, segment: TurnSegment): void {
  turn.segments.push(segment);
  if (turn.segments.length <= MAX_TURN_SEGMENTS) return;
  turn.segments.shift();
  turn.droppedSegmentCount += 1;
}

function tallyFileEdits(turn: ChatTurn, edits: readonly FileEdit[]): void {
  for (const edit of edits) {
    turn.editedPaths.add(edit.path);
    turn.fileEdits.added += edit.added;
    turn.fileEdits.removed += edit.removed;
    turn.fileEdits.hasLineCounts &&= edit.hasLineCounts;
  }
  turn.fileEdits.fileCount = turn.editedPaths.size;
}

function noteToolCall(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'tool_call' }>): void {
  const { turn } = state;
  turn.toolCount += 1;
  const label = toolLabelOf(record.name, record.input, state.workingDirectory);
  const lastSegment = turn.segments.at(-1);
  const hasRoomForLabel = lastSegment?.kind === 'tools' && lastSegment.labels.length < MAX_TOOL_LABELS_PER_SEGMENT;
  if (hasRoomForLabel) lastSegment.labels.push(label);
  if (!hasRoomForLabel) pushSegment(turn, { kind: 'tools', labels: [label] });
  if (!isEditingTool(record.name)) return;
  tallyFileEdits(turn, record.truncated === true ? truncatedFileEditsOf(record.input, state.workingDirectory) : fileEditsOf(record.input, state.workingDirectory));
}

type TurnTouch = 'grew' | 'ran' | 'untouched';

function turnTouchOf(state: ChatPartsState, record: TraceRecord): TurnTouch {
  if (record.kind === 'tool_call') {
    noteToolCall(state, record);
    return 'grew';
  }
  if (record.kind === 'assistant' && record.text.trim().length > 0) {
    pushSegment(state.turn, { kind: 'text', text: record.text });
    return 'grew';
  }
  return record.kind === 'tool_result' ? 'ran' : 'untouched';
}

function noteTurnRecord(state: ChatPartsState, record: TraceRecord, emit: (part: ChatPart) => void): void {
  if (record.agentId !== undefined) return;
  if (opensOperatorTurn(record)) {
    for (const endedPart of endChatTurn(state)) emit(endedPart);
    state.turn = freshTurn(record.ts);
    return;
  }
  const touch = turnTouchOf(state, record);
  if (touch === 'untouched') return;
  const { turn } = state;
  const wasOver = turn.isOver;
  turn.firstAt ??= record.ts;
  turn.lastAt = Math.max(turn.lastAt, record.ts);
  turn.isOver = false;
  if (turn.segments.length === 0 || (touch === 'ran' && !wasOver)) return;
  turn.partId ??= nextPartId(state, 'turn');
  emit(turnPartOf(turn, turn.partId));
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

function promptWithAttachments(prompt: PromptPart, sent: SentAttachments | null): PromptPart {
  if (sent === null) return prompt;
  const text = prompt.text.startsWith(sent.pastedPrefix) ? prompt.text.slice(sent.pastedPrefix.length).trimStart() : prompt.text;
  return { ...prompt, text, attachments: sent.files };
}

function attachedPromptOf(state: ChatPartsState, sent: SentAttachments): PromptPart | null {
  const latestPrompt = state.latestPrompt;
  if (latestPrompt === null || latestPrompt.attachments.length > 0) {
    state.pendingAttachments = sent;
    return null;
  }
  state.latestPrompt = promptWithAttachments(latestPrompt, sent);
  return state.latestPrompt;
}

function chatPartOf(state: ChatPartsState, record: TraceRecord): ChatPart | null {
  if (record.agentId !== undefined) return null;
  if (record.kind === 'attachments') return attachedPromptOf(state, record);
  const part = nonPromptPartOf(state, record);
  if (part !== null || record.kind === 'assistant') state.latestPrompt = null;
  if (record.kind !== 'prompt') return part;
  const prompt = promptWithAttachments({ kind: 'prompt', id: nextPartId(state, 'prompt'), text: record.text, at: record.ts, attachments: [] }, state.pendingAttachments);
  state.pendingAttachments = null;
  state.latestPrompt = prompt;
  return prompt;
}

function nonPromptPartOf(state: ChatPartsState, record: TraceRecord): ChatPart | null {
  if (record.kind === 'notice') return noticeCardPartOf(nextPartId(state, 'notice'), record.text);
  const skillName = loadedSkillOf(record);
  if (skillName !== null) return { kind: 'skill', id: nextPartId(state, 'skill'), skillName };
  return null;
}

function textFieldOf(input: unknown, field: string): string | null {
  if (typeof input !== 'object' || input === null || !(field in input)) return null;
  const value: unknown = Reflect.get(input, field);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function noteSubagentRecord(state: ChatPartsState, record: TraceRecord): void {
  if (record.agentId !== undefined) return;
  if (record.kind === 'tool_result') {
    state.runningSubagentByToolUseId.delete(record.toolUseId);
    return;
  }
  if (record.kind !== 'tool_call' || !SUBAGENT_TOOL_NAMES.has(record.name)) return;
  const type = textFieldOf(record.input, 'subagent_type') ?? record.name;
  state.runningSubagentByToolUseId.set(record.toolUseId, { type, model: textFieldOf(record.input, 'model') });
}

export function appendChatRecords(state: ChatPartsState, appended: readonly TraceRecord[]): AppendedChat {
  const parts: ChatPart[] = [];
  const beats: ActivityBeat[] = [];
  const partIndexById = new Map<string, number>();
  const emit = (part: ChatPart) => {
    const existingIndex = partIndexById.get(part.id);
    if (existingIndex !== undefined) {
      parts[existingIndex] = part;
      return;
    }
    partIndexById.set(part.id, parts.length);
    parts.push(part);
  };
  for (const record of appended) {
    const part = chatPartOf(state, record);
    if (part) emit(part);
    noteTurnRecord(state, record, emit);
    noteSubagentRecord(state, record);
    const beat = beatOfRecord(record);
    if (beat) beats.push(beat);
  }
  return { parts, beats, runningSubagents: [...state.runningSubagentByToolUseId.values()] };
}

export function trimChatParts(state: ChatPartsState, maxResidentParts = MAX_RESIDENT_PARTS): string[] {
  if (state.residentPartIds.length <= maxResidentParts + TRIM_BATCH_PARTS) return [];
  return state.residentPartIds.splice(0, state.residentPartIds.length - maxResidentParts);
}
