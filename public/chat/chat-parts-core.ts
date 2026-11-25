import type { TraceRecord } from '#shared/contracts/trace.ts';
import { twoUnitDurationText } from '#shared/display-text.ts';
import { type ActivityBeat, beatOfRecord, isEditingTool, loadedSkillOf } from './chat-activity-core.ts';
import type { BackgroundTaskPart, ChatCard, ChatPart, CommandPart, TurnPart } from './chat-part.ts';
import { SUBAGENT_TOOL_NAMES } from '#shared/subagent-tools.ts';
import { opensOperatorTurn } from '#shared/trace-turn.ts';
import { glimmervoidLineLabelOf, isRelayNewsLine, taskNotificationLabelOf } from '#shared/glimmervoid-lines.ts';
import { unwrapPastedContent } from '#shared/pasted-content.ts';
import { fileEditsOf } from '#shared/file-edits-core.ts';
import type { FileEdit } from '#shared/file-edits-core.ts';
import { filePatchesOf, outputHeadOf, truncatedFileEditsOf, toolLabelOf } from './turn-digest-core.ts';
import type { FileEditTally, FilePatch, ToolCallEntry, TurnSegment } from './turn-digest-core.ts';

interface ChatTurn {
  promptAt: number | null;
  partId: string | null;
  segments: TurnSegment[];
  droppedSegmentCount: number;
  toolCount: number;
  failedCount: number;
  callByToolUseId: Map<string, ToolCallEntry>;
  editedPaths: Set<string>;
  fileEdits: FileEditTally;
  filePatches: FilePatch[];
  unshownPatchCount: number;
  thinkingMs: number | null;
  thinkingFrom: number | null;
  previousRecordAt: number | null;
  lastAt: number;
  isOver: boolean;
}

type PromptPart = Extract<ChatPart, { kind: 'prompt' }>;
type UsageLimitCard = Extract<ChatCard, { cardType: 'usage-limit' }>;
type SentBoardAnswer = Extract<TraceRecord, { kind: 'board-answer' }>;
type SentAttachments = Pick<Extract<TraceRecord, { kind: 'attachments' }>, 'files' | 'pastedPrefix' | 'fromTranscript'>;

interface TrackedSubagent {
  subagentType: string;
  subagentId: string | null;
  toolUseId: string | null;
  model: string | null;
  isBackground: boolean;
}

type BackgroundTaskLaunch = Pick<BackgroundTaskPart, 'taskType' | 'label' | 'command' | 'startedAt'>;

interface ChatPartsState {
  nextPartNumber: number;
  residentPartIds: string[];
  turn: ChatTurn;
  pendingAttachments: SentAttachments | null;
  pendingBoardAnswer: SentBoardAnswer | null;
  latestPrompt: PromptPart | null;
  newestPrompt: PromptPart | null;
  latestCommand: CommandPart | null;
  openUsageLimitCard: UsageLimitCard | null;
  runningSubagents: Set<TrackedSubagent>;
  subagentByToolUseId: Map<string, TrackedSubagent>;
  subagentById: Map<string, TrackedSubagent>;
  backgroundCallByToolUseId: Map<string, Extract<TraceRecord, { kind: 'tool_call' }>>;
  backgroundLaunchByTaskId: Map<string, BackgroundTaskLaunch>;
  backgroundTaskById: Map<string, BackgroundTaskPart>;
  workingDirectory: string | null;
}

interface AppendedChat {
  parts: ChatPart[];
  beats: ActivityBeat[];
  runningSubagents: RunningSubagent[];
}

const MAX_RESIDENT_PARTS = 2000;
const MAX_TURN_SEGMENTS = 400;
const MAX_RUN_LABELS = 50;
const MAX_TURN_FILE_PATCHES = 50;
const TRIM_BATCH_PARTS = 200;
const MAX_REMEMBERED_SUBAGENTS = 200;
const MAX_REMEMBERED_BACKGROUND_TASKS = 200;
const COARSEST_TRANSCRIPT_STAMP_MS = 1000;
const BACKGROUND_TASK_TYPE_BY_TOOL_NAME: ReadonlyMap<string, string> = new Map([['Bash', 'shell'], ['Monitor', 'monitor'], ['Workflow', 'workflow']]);
const BACKGROUND_TASK_LABEL_BY_TYPE: ReadonlyMap<string, string> = new Map([['shell', 'Shell'], ['monitor', 'Monitor'], ['workflow', 'Workflow']]);

export function createChatPartsState(workingDirectory: string | null = null): ChatPartsState {
  return { nextPartNumber: 0, residentPartIds: [], turn: freshTurn(null), pendingAttachments: null, pendingBoardAnswer: null, latestPrompt: null, newestPrompt: null, latestCommand: null, openUsageLimitCard: null, runningSubagents: new Set(), subagentByToolUseId: new Map(), subagentById: new Map(), backgroundCallByToolUseId: new Map(), backgroundLaunchByTaskId: new Map(), backgroundTaskById: new Map(), workingDirectory };
}

function freshTurn(promptAt: number | null): ChatTurn {
  return { promptAt, partId: null, segments: [], droppedSegmentCount: 0, toolCount: 0, failedCount: 0, callByToolUseId: new Map(), editedPaths: new Set(), fileEdits: { fileCount: 0, added: 0, removed: 0, hasLineCounts: true }, filePatches: [], unshownPatchCount: 0, thinkingMs: null, thinkingFrom: null, previousRecordAt: null, lastAt: 0, isOver: false };
}

function durationTextOf(turn: ChatTurn): string | null {
  if (turn.promptAt === null || turn.lastAt <= turn.promptAt) return null;
  return secondsTextOf(turn.lastAt - turn.promptAt);
}

function secondsTextOf(durationMs: number): string {
  return twoUnitDurationText(Math.max(1, Math.floor(durationMs / 1000)), { smallestUnit: 's', dropsZeroRemainder: false });
}

function thoughtTextOf(turn: ChatTurn): string | null {
  if (turn.thinkingMs === null) return null;
  const openThinkingMs = turn.thinkingFrom === null ? 0 : Math.max(0, (turn.previousRecordAt ?? turn.thinkingFrom) - turn.thinkingFrom);
  return `thought ${secondsTextOf(turn.thinkingMs + openThinkingMs)}`;
}

function turnPartOf(turn: ChatTurn, partId: string): TurnPart {
  return {
    kind: 'turn',
    id: partId,
    openedAt: turn.promptAt,
    segments: turn.segments,
    droppedSegmentCount: turn.droppedSegmentCount,
    toolCount: turn.toolCount,
    failedCount: turn.failedCount,
    fileEdits: { ...turn.fileEdits },
    filePatches: [...turn.filePatches],
    unshownPatchCount: turn.unshownPatchCount,
    thoughtText: turn.isOver ? thoughtTextOf(turn) : null,
    durationText: turn.isOver ? durationTextOf(turn) : null,
    isOver: turn.isOver,
  };
}

export function endChatTurn(state: ChatPartsState): ChatPart[] {
  const { turn } = state;
  if (turn.partId === null || turn.isOver) return [];
  turn.isOver = true;
  stopUnsettledCalls(turn);
  return [turnPartOf(turn, turn.partId)];
}

function stopUnsettledCalls(turn: ChatTurn): void {
  for (const call of turn.callByToolUseId.values()) {
    if (call.state !== 'running') continue;
    call.state = 'stopped';
    markSegmentChanged(turn, call);
  }
}

function markSegmentChanged(turn: ChatTurn, call: ToolCallEntry): void {
  const changedSegment = turn.segments.findLast((segment) => segment.kind === 'tools' && segment.calls.includes(call));
  if (changedSegment?.kind === 'tools') changedSegment.settledCount += 1;
}

function forgetCalls(turn: ChatTurn, calls: readonly ToolCallEntry[]): void {
  for (const call of calls) turn.callByToolUseId.delete(call.toolUseId);
}

function pushSegment(turn: ChatTurn, segment: TurnSegment): void {
  turn.segments.push(segment);
  if (turn.segments.length <= MAX_TURN_SEGMENTS) return;
  const droppedSegment = turn.segments.shift();
  if (droppedSegment?.kind === 'tools') forgetCalls(turn, droppedSegment.calls);
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
  const call: ToolCallEntry = { toolUseId: record.toolUseId, label: toolLabelOf(record.name, record.input, state.workingDirectory), state: 'running', startedAt: record.ts, durationMs: null, outputHead: null, imageFileNames: [] };
  turn.callByToolUseId.set(call.toolUseId, call);
  const lastSegment = turn.segments.at(-1);
  if (lastSegment?.kind === 'tools') {
    lastSegment.calls.push(call);
    if (lastSegment.calls.length > MAX_RUN_LABELS) forgetCalls(turn, lastSegment.calls.splice(0, 1));
    lastSegment.callCount += 1;
  }
  if (lastSegment?.kind !== 'tools') pushSegment(turn, { kind: 'tools', calls: [call], callCount: 1, settledCount: 0 });
  if (!isEditingTool(record.name)) return;
  keepFilePatches(turn, record.truncated === true ? [] : filePatchesOf(record.input, state.workingDirectory));
  tallyFileEdits(turn, record.truncated === true ? truncatedFileEditsOf(record.input, state.workingDirectory) : fileEditsOf(record.input, state.workingDirectory));
}

function keepFilePatches(turn: ChatTurn, patches: readonly FilePatch[]): void {
  if (patches.length === 0) turn.unshownPatchCount += 1;
  turn.filePatches.push(...patches);
  if (turn.filePatches.length <= MAX_TURN_FILE_PATCHES) return;
  turn.unshownPatchCount += turn.filePatches.splice(0, turn.filePatches.length - MAX_TURN_FILE_PATCHES).length;
}

function settleToolCall(turn: ChatTurn, record: Extract<TraceRecord, { kind: 'tool_result' }>): boolean {
  const call = turn.callByToolUseId.get(record.toolUseId);
  if (call === undefined) return false;
  turn.callByToolUseId.delete(record.toolUseId);
  call.state = record.isError ? 'failed' : 'done';
  call.durationMs = record.ts > call.startedAt ? record.ts - call.startedAt : null;
  call.outputHead = outputHeadOf(record.content);
  call.imageFileNames = (record.images ?? []).map((image) => image.fileName);
  if (record.isError) turn.failedCount += 1;
  markSegmentChanged(turn, call);
  return true;
}

function noteThinking(turn: ChatTurn, record: TraceRecord): void {
  if (record.kind === 'thinking' && record.text.trim().length > 0) {
    turn.thinkingMs ??= 0;
    turn.thinkingFrom ??= turn.previousRecordAt ?? record.ts;
  }
  if (record.kind !== 'thinking' && turn.thinkingFrom !== null) {
    turn.thinkingMs = (turn.thinkingMs ?? 0) + Math.max(0, record.ts - turn.thinkingFrom);
    turn.thinkingFrom = null;
  }
  turn.previousRecordAt = record.ts;
}

type TurnTouch = 'grew' | 'ran' | 'untouched';

function turnTouchOf(state: ChatPartsState, record: TraceRecord): TurnTouch {
  if (record.kind === 'tool_call' && SUBAGENT_TOOL_NAMES.has(record.name)) return 'ran';
  if (record.kind === 'tool_call') {
    noteToolCall(state, record);
    return 'grew';
  }
  if (record.kind === 'assistant' && record.text.trim().length > 0) {
    pushSegment(state.turn, { kind: 'text', text: record.text });
    return 'grew';
  }
  if (record.kind !== 'tool_result') return 'untouched';
  return settleToolCall(state.turn, record) ? 'grew' : 'ran';
}

function noteTurnRecord(state: ChatPartsState, record: TraceRecord, emit: (part: ChatPart) => void): void {
  if (record.agentId !== undefined) return;
  if (opensOperatorTurn(record)) {
    for (const endedPart of endChatTurn(state)) emit(endedPart);
    state.turn = freshTurn(record.ts);
    return;
  }
  noteThinking(state.turn, record);
  const touch = turnTouchOf(state, record);
  if (touch === 'untouched') return;
  const { turn } = state;
  const wasOver = turn.isOver;
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
  const hasNoPromptToJoin = latestPrompt === null || latestPrompt.attachments.length > 0;
  if (hasNoPromptToJoin && sent.fromTranscript === true) return null;
  if (latestPrompt === null || latestPrompt.attachments.length > 0) {
    state.pendingAttachments = sent;
    return null;
  }
  state.latestPrompt = promptWithAttachments(latestPrompt, sent);
  if (state.newestPrompt?.id === latestPrompt.id) state.newestPrompt = state.latestPrompt;
  return state.latestPrompt;
}

function isPromptAtOrAfterBoardAnswer(promptAt: number, sent: SentBoardAnswer): boolean {
  return Math.floor(promptAt / COARSEST_TRANSCRIPT_STAMP_MS) >= Math.floor(sent.ts / COARSEST_TRANSCRIPT_STAMP_MS);
}

function answeredPromptOf(state: ChatPartsState, sent: SentBoardAnswer): PromptPart | null {
  const newestPrompt = state.newestPrompt;
  if (newestPrompt === null || newestPrompt.isBoardAnswer || !isPromptAtOrAfterBoardAnswer(newestPrompt.at, sent)) {
    state.pendingBoardAnswer = sent;
    return null;
  }
  const answeredPrompt = { ...newestPrompt, isBoardAnswer: true };
  state.newestPrompt = answeredPrompt;
  if (state.latestPrompt?.id === answeredPrompt.id) state.latestPrompt = answeredPrompt;
  return answeredPrompt;
}

function chatPartOf(state: ChatPartsState, record: TraceRecord): ChatPart | null {
  if (record.agentId !== undefined) return null;
  if (record.kind === 'attachments') return attachedPromptOf(state, record);
  if (record.kind === 'board-answer') return answeredPromptOf(state, record);
  if (COMMAND_ENDING_KINDS.has(record.kind)) state.latestCommand = null;
  const part = nonPromptPartOf(state, record);
  if (part !== null || record.kind === 'assistant') state.latestPrompt = null;
  if (record.kind !== 'prompt' || part !== null) return part;
  const isBoardAnswer = state.pendingBoardAnswer !== null && isPromptAtOrAfterBoardAnswer(record.ts, state.pendingBoardAnswer);
  const prompt = promptWithAttachments({ kind: 'prompt', id: nextPartId(state, 'prompt'), text: unwrapPastedContent(record.text), at: record.ts, attachments: [], isBoardAnswer }, state.pendingAttachments);
  state.pendingAttachments = null;
  if (isBoardAnswer) state.pendingBoardAnswer = null;
  state.latestPrompt = prompt;
  state.newestPrompt = prompt;
  return prompt;
}

function usageLimitCardPartOf(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'usage_limit' }>): ChatPart {
  const cardId = nextPartId(state, 'usage-limit');
  const card: UsageLimitCard = { cardType: 'usage-limit', cardId, data: { resetsAtMs: record.resetsAtMs, window: record.window }, resolution: null };
  state.openUsageLimitCard = card;
  return { kind: 'card', id: cardId, card };
}

function passedUsageLimitPartOf(state: ChatPartsState, record: TraceRecord): ChatPart | null {
  const openCard = state.openUsageLimitCard;
  if (openCard === null || record.kind !== 'prompt' || record.agentId !== undefined) return null;
  state.openUsageLimitCard = null;
  return { kind: 'card', id: openCard.cardId, card: { ...openCard, resolution: { isPassed: true } } };
}

function systemLineLabelOf(record: TraceRecord): string | null {
  if (record.kind === 'prompt') return glimmervoidLineLabelOf(record.text);
  if (record.kind === 'expansion') return taskNotificationLabelOf(record.text);
  return null;
}

function systemLinePartOf(state: ChatPartsState, record: TraceRecord): ChatPart | null {
  const label = systemLineLabelOf(record);
  if (label === null) return null;
  const isRelayNews = record.kind === 'prompt' && isRelayNewsLine(record.text);
  return { kind: 'system-line', id: nextPartId(state, 'system-line'), label, at: record.ts, isRelayNews };
}

const COMMAND_ENDING_KINDS: ReadonlySet<TraceRecord['kind']> = new Set(['prompt', 'assistant', 'tool_call']);
const COMMAND_NAME_PATTERN = /^\s*(?:<command-message>[\s\S]*?)?<command-name>([^<\r\n]+)<\/command-name>/;
const COMMAND_ARGS_PATTERN = /<command-args>([\s\S]*?)<\/command-args>/;

function typedCommandPartOf(state: ChatPartsState, record: TraceRecord): CommandPart | null {
  if (record.kind !== 'expansion' || record.toolUseId !== undefined) return null;
  const name = COMMAND_NAME_PATTERN.exec(record.text)?.[1]?.trim();
  if (!name) return null;
  const args = COMMAND_ARGS_PATTERN.exec(record.text)?.[1]?.trim() ?? '';
  const command: CommandPart = { kind: 'command', id: nextPartId(state, 'command'), name, args, output: null, isOutputError: false, at: record.ts };
  state.latestCommand = command;
  return command;
}

function commandWithOutputOf(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'command-output' }>): CommandPart | null {
  const command = state.latestCommand;
  if (command === null || record.text.length === 0) return null;
  const output = command.output === null ? record.text : `${command.output}\n${record.text}`;
  state.latestCommand = { ...command, output, isOutputError: command.isOutputError || record.isError };
  return state.latestCommand;
}

function nonPromptPartOf(state: ChatPartsState, record: TraceRecord): ChatPart | null {
  const commandPart = typedCommandPartOf(state, record);
  if (commandPart !== null) return commandPart;
  if (record.kind === 'command-output') return commandWithOutputOf(state, record);
  if (record.kind === 'model-change') return { kind: 'system-line', id: nextPartId(state, 'system-line'), label: `Model set to ${record.model}`, at: record.ts, isRelayNews: false };
  const systemLinePart = systemLinePartOf(state, record);
  if (systemLinePart !== null) return systemLinePart;
  if (record.kind === 'notice') return noticeCardPartOf(nextPartId(state, 'notice'), record.text);
  if (record.kind === 'usage_limit') return usageLimitCardPartOf(state, record);
  const skillName = loadedSkillOf(record);
  if (skillName !== null) return { kind: 'skill', id: nextPartId(state, 'skill'), skillName };
  return null;
}

function textFieldOf(input: unknown, field: string): string | null {
  if (typeof input !== 'object' || input === null || !(field in input)) return null;
  const value: unknown = Reflect.get(input, field);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function rememberSubagent(subagentByKey: Map<string, TrackedSubagent>, key: string, tracked: TrackedSubagent): void {
  subagentByKey.set(key, tracked);
  if (subagentByKey.size <= MAX_REMEMBERED_SUBAGENTS) return;
  const oldestKey = subagentByKey.keys().next().value;
  if (oldestKey !== undefined) subagentByKey.delete(oldestKey);
}

function trackSubagent(state: ChatPartsState, subagentType: string): TrackedSubagent {
  const tracked: TrackedSubagent = { subagentType, subagentId: null, toolUseId: null, model: null, isBackground: false };
  state.runningSubagents.add(tracked);
  return tracked;
}

function oldestRunningSubagent(state: ChatPartsState, isCandidate: (tracked: TrackedSubagent) => boolean): TrackedSubagent | null {
  for (const tracked of state.runningSubagents) {
    if (isCandidate(tracked)) return tracked;
  }
  return null;
}

function attachSubagentId(state: ChatPartsState, tracked: TrackedSubagent, subagentId: string): void {
  tracked.subagentId = subagentId;
  rememberSubagent(state.subagentById, subagentId, tracked);
}

function attachCall(state: ChatPartsState, tracked: TrackedSubagent, toolUseId: string): void {
  tracked.toolUseId = toolUseId;
  rememberSubagent(state.subagentByToolUseId, toolUseId, tracked);
}

function startSubagent(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'subagent' }>): void {
  if (state.subagentById.has(record.subagentId)) return;
  const launchingCall = state.subagentByToolUseId.get(record.subagentId)
    ?? oldestRunningSubagent(state, (tracked) => tracked.toolUseId !== null && tracked.subagentId === null && (record.subagentType === null || tracked.subagentType === record.subagentType));
  attachSubagentId(state, launchingCall ?? trackSubagent(state, record.subagentType ?? 'Subagent'), record.subagentId);
}

function openSubagentCall(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'tool_call' }>): void {
  const calledType = textFieldOf(record.input, 'subagent_type') ?? textFieldOf(record.input, 'TypeName');
  const startedSubagent = state.subagentById.get(record.toolUseId)
    ?? oldestRunningSubagent(state, (tracked) => tracked.subagentId !== null && tracked.toolUseId === null && (calledType === null || tracked.subagentType === calledType));
  const tracked = startedSubagent ?? trackSubagent(state, calledType ?? record.name);
  tracked.subagentType = calledType ?? tracked.subagentType;
  tracked.model = textFieldOf(record.input, 'model');
  tracked.isBackground = record.name === 'invoke_subagent'
    || (typeof record.input === 'object' && record.input !== null && Reflect.get(record.input, 'run_in_background') === true);
  attachCall(state, tracked, record.toolUseId);
}

function swapCalls(state: ChatPartsState, first: TrackedSubagent, second: TrackedSubagent): void {
  const firstCall = { toolUseId: first.toolUseId, model: first.model, isBackground: first.isBackground };
  first.model = second.model;
  first.isBackground = second.isBackground;
  second.model = firstCall.model;
  second.isBackground = firstCall.isBackground;
  first.toolUseId = second.toolUseId;
  second.toolUseId = firstCall.toolUseId;
  if (first.toolUseId !== null) state.subagentByToolUseId.set(first.toolUseId, first);
  if (second.toolUseId !== null) state.subagentByToolUseId.set(second.toolUseId, second);
}

function launchedSubagentOf(state: ChatPartsState, calledSubagent: TrackedSubagent, launchedSubagentId: string): TrackedSubagent {
  if (calledSubagent.subagentId === launchedSubagentId) return calledSubagent;
  const launchedSubagent = state.subagentById.get(launchedSubagentId);
  if (launchedSubagent === undefined) {
    if (calledSubagent.subagentId === null) attachSubagentId(state, calledSubagent, launchedSubagentId);
    return calledSubagent;
  }
  swapCalls(state, calledSubagent, launchedSubagent);
  return launchedSubagent;
}

function settleSubagentCall(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'tool_result' }>): void {
  const calledSubagent = state.subagentByToolUseId.get(record.toolUseId);
  if (calledSubagent === undefined) return;
  const tracked = record.subagentId === undefined ? calledSubagent : launchedSubagentOf(state, calledSubagent, record.subagentId);
  const awaitsStop = tracked.isBackground && record.subagentId !== undefined && !record.isError;
  if (!awaitsStop) state.runningSubagents.delete(tracked);
}

function noteSubagentSignal(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'subagent' }>): void {
  if (record.phase === 'start') {
    startSubagent(state, record);
    return;
  }
  const tracked = state.subagentById.get(record.subagentId);
  if (tracked !== undefined) state.runningSubagents.delete(tracked);
}

function noteSubagentRecord(state: ChatPartsState, record: TraceRecord): void {
  if (record.agentId !== undefined) return;
  if (record.kind === 'session') {
    state.runningSubagents.clear();
    return;
  }
  if (record.kind === 'subagent') {
    noteSubagentSignal(state, record);
    return;
  }
  if (record.kind === 'tool_result') {
    settleSubagentCall(state, record);
    return;
  }
  if (record.kind === 'tool_call' && SUBAGENT_TOOL_NAMES.has(record.name)) openSubagentCall(state, record);
}

function rememberBounded<Value>(valueByKey: Map<string, Value>, key: string, value: Value): void {
  valueByKey.set(key, value);
  if (valueByKey.size <= MAX_REMEMBERED_BACKGROUND_TASKS) return;
  const oldestKey = valueByKey.keys().next().value;
  if (oldestKey !== undefined) valueByKey.delete(oldestKey);
}

export function backgroundTaskKindText(taskType: string | null): string {
  if (taskType === null) return 'Background';
  return BACKGROUND_TASK_LABEL_BY_TYPE.get(taskType) ?? taskType;
}

function backgroundLaunchOf(state: ChatPartsState, call: Extract<TraceRecord, { kind: 'tool_call' }>, launched: Extract<TraceRecord, { kind: 'tool_result' }>): BackgroundTaskLaunch {
  return {
    taskType: BACKGROUND_TASK_TYPE_BY_TOOL_NAME.get(call.name) ?? null,
    label: launched.backgroundTaskName ?? textFieldOf(call.input, 'description') ?? toolLabelOf(call.name, call.input, state.workingDirectory),
    command: textFieldOf(call.input, 'command') ?? launched.backgroundTaskSummary ?? null,
    startedAt: launched.ts,
  };
}

function relabelStartedBackgroundTask(state: ChatPartsState, taskId: string, launch: BackgroundTaskLaunch): BackgroundTaskPart | null {
  const startedPart = state.backgroundTaskById.get(taskId);
  if (startedPart === undefined) return null;
  const relabeled = { ...startedPart, taskType: startedPart.taskType ?? launch.taskType, label: launch.label, command: launch.command, startedAt: Math.min(startedPart.startedAt, launch.startedAt) };
  state.backgroundTaskById.set(taskId, relabeled);
  return relabeled;
}

function noteBackgroundLaunch(state: ChatPartsState, record: TraceRecord): BackgroundTaskPart | null {
  if (record.agentId !== undefined) return null;
  if (record.kind === 'tool_call' && BACKGROUND_TASK_TYPE_BY_TOOL_NAME.has(record.name)) {
    rememberBounded(state.backgroundCallByToolUseId, record.toolUseId, record);
    return null;
  }
  if (record.kind !== 'tool_result') return null;
  const call = state.backgroundCallByToolUseId.get(record.toolUseId);
  state.backgroundCallByToolUseId.delete(record.toolUseId);
  if (call === undefined || record.backgroundTaskId === undefined) return null;
  const launch = backgroundLaunchOf(state, call, record);
  const relabeled = relabelStartedBackgroundTask(state, record.backgroundTaskId, launch);
  if (relabeled !== null) return relabeled;
  rememberBounded(state.backgroundLaunchByTaskId, record.backgroundTaskId, launch);
  return null;
}

function startBackgroundTask(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'background-task' }>): BackgroundTaskPart | null {
  if (state.backgroundTaskById.has(record.taskId)) return null;
  const launch = state.backgroundLaunchByTaskId.get(record.taskId);
  state.backgroundLaunchByTaskId.delete(record.taskId);
  const taskType = record.taskType ?? launch?.taskType ?? null;
  const part: BackgroundTaskPart = {
    kind: 'background-task',
    id: nextPartId(state, 'background-task'),
    taskType,
    label: launch?.label ?? record.taskId,
    command: launch?.command ?? null,
    startedAt: Math.min(launch?.startedAt ?? record.ts, record.ts),
    endedAt: null,
  };
  rememberBounded(state.backgroundTaskById, record.taskId, part);
  return part;
}

function stopBackgroundTask(state: ChatPartsState, taskId: string, stoppedAt: number): BackgroundTaskPart | null {
  const part = state.backgroundTaskById.get(taskId);
  if (part === undefined || part.endedAt !== null) return null;
  const stopped = { ...part, endedAt: Math.max(stoppedAt, part.startedAt) };
  state.backgroundTaskById.set(taskId, stopped);
  return stopped;
}

function stopEveryBackgroundTask(state: ChatPartsState, stoppedAt: number): BackgroundTaskPart[] {
  return [...state.backgroundTaskById.keys()].map((taskId) => stopBackgroundTask(state, taskId, stoppedAt)).filter((stopped) => stopped !== null);
}

function changedBackgroundTasksOf(state: ChatPartsState, record: TraceRecord): BackgroundTaskPart[] {
  const relabeled = noteBackgroundLaunch(state, record);
  if (relabeled !== null) return [relabeled];
  if (record.kind === 'session') return stopEveryBackgroundTask(state, record.ts);
  if (record.kind !== 'background-task') return [];
  if (record.phase === 'stop') return [stopBackgroundTask(state, record.taskId, record.ts)].filter((stopped) => stopped !== null);
  return [startBackgroundTask(state, record)].filter((started) => started !== null);
}

interface RunningSubagent {
  type: string;
  model: string | null;
}

function runningSubagentsOf(state: ChatPartsState): RunningSubagent[] {
  return [...state.runningSubagents].map((tracked) => ({ type: tracked.subagentType, model: tracked.model }));
}

export function runTimeText(startedAt: number, endedAt: number): string {
  return twoUnitDurationText(Math.max(1, Math.round((endedAt - startedAt) / 1000)), { smallestUnit: 's', dropsZeroRemainder: false });
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
    const passedUsageLimitPart = passedUsageLimitPartOf(state, record);
    if (passedUsageLimitPart) emit(passedUsageLimitPart);
    const part = chatPartOf(state, record);
    if (part) emit(part);
    noteTurnRecord(state, record, emit);
    noteSubagentRecord(state, record);
    for (const changedBackgroundTask of changedBackgroundTasksOf(state, record)) emit(changedBackgroundTask);
    const beat = beatOfRecord(record);
    if (beat) beats.push(beat);
  }
  return { parts, beats, runningSubagents: runningSubagentsOf(state) };
}

export function trimChatParts(state: ChatPartsState, maxResidentParts = MAX_RESIDENT_PARTS): string[] {
  if (state.residentPartIds.length <= maxResidentParts + TRIM_BATCH_PARTS) return [];
  return state.residentPartIds.splice(0, state.residentPartIds.length - maxResidentParts);
}
