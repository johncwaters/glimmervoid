import type { TraceRecord } from '#shared/contracts/trace.ts';
import { twoUnitDurationText } from '#shared/display-text.ts';
import { type ActivityBeat, beatOfRecord, isEditingTool, loadedSkillOf } from './chat-activity-core.ts';
import type { BackgroundTaskPart, ChatCard, ChatPart, SubagentPart, TurnPart } from './chat-part.ts';
import type { RunningSubagent } from './status-rail-core.ts';
import { SUBAGENT_TOOL_NAMES } from '#shared/subagent-tools.ts';
import { opensOperatorTurn } from '#shared/trace-turn.ts';
import { unwrapPastedContent } from '#shared/pasted-content.ts';
import { fileEditsOf, truncatedFileEditsOf, toolLabelOf } from './turn-digest-core.ts';
import type { FileEdit, FileEditTally, TurnSegment } from './turn-digest-core.ts';

interface ChatTurn {
  promptAt: number | null;
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
type UsageLimitCard = Extract<ChatCard, { cardType: 'usage-limit' }>;
type SentAttachments = Pick<Extract<TraceRecord, { kind: 'attachments' }>, 'files' | 'pastedPrefix'>;

interface TrackedSubagent {
  part: SubagentPart & { steps: string[] };
  subagentId: string | null;
  toolUseId: string | null;
  model: string | null;
  isBackground: boolean;
}

type BackgroundTaskLaunch = Pick<BackgroundTaskPart, 'taskType' | 'label' | 'command' | 'startedAt'>;

type SubagentStart = Pick<SubagentPart, 'subagentType' | 'task' | 'startedAt'>;

interface ChatPartsState {
  nextPartNumber: number;
  residentPartIds: string[];
  turn: ChatTurn;
  pendingAttachments: SentAttachments | null;
  latestPrompt: PromptPart | null;
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
const TRIM_BATCH_PARTS = 200;
const MAX_REMEMBERED_SUBAGENTS = 200;
const MAX_REMEMBERED_BACKGROUND_TASKS = 200;
const BACKGROUND_TASK_TYPE_BY_TOOL_NAME: ReadonlyMap<string, string> = new Map([['Bash', 'shell'], ['Monitor', 'monitor'], ['Workflow', 'workflow']]);
const BACKGROUND_TASK_LABEL_BY_TYPE: ReadonlyMap<string, string> = new Map([['shell', 'Shell'], ['monitor', 'Monitor'], ['workflow', 'Workflow']]);

export function createChatPartsState(workingDirectory: string | null = null): ChatPartsState {
  return { nextPartNumber: 0, residentPartIds: [], turn: freshTurn(null), pendingAttachments: null, latestPrompt: null, openUsageLimitCard: null, runningSubagents: new Set(), subagentByToolUseId: new Map(), subagentById: new Map(), backgroundCallByToolUseId: new Map(), backgroundLaunchByTaskId: new Map(), backgroundTaskById: new Map(), workingDirectory };
}

function freshTurn(promptAt: number | null): ChatTurn {
  return { promptAt, partId: null, segments: [], droppedSegmentCount: 0, toolCount: 0, editedPaths: new Set(), fileEdits: { fileCount: 0, added: 0, removed: 0, hasLineCounts: true }, lastAt: 0, isOver: false };
}

function durationTextOf(turn: ChatTurn): string | null {
  if (turn.promptAt === null || turn.lastAt <= turn.promptAt) return null;
  return twoUnitDurationText(Math.max(1, Math.floor((turn.lastAt - turn.promptAt) / 1000)), { smallestUnit: 's', dropsZeroRemainder: false });
}

function turnPartOf(turn: ChatTurn, partId: string): TurnPart {
  return {
    kind: 'turn',
    id: partId,
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
  if (lastSegment?.kind === 'tools') {
    lastSegment.labels.push(label);
    if (lastSegment.labels.length > MAX_RUN_LABELS) lastSegment.labels.shift();
    lastSegment.callCount += 1;
  }
  if (lastSegment?.kind !== 'tools') pushSegment(turn, { kind: 'tools', labels: [label], callCount: 1 });
  if (!isEditingTool(record.name)) return;
  tallyFileEdits(turn, record.truncated === true ? truncatedFileEditsOf(record.input, state.workingDirectory) : fileEditsOf(record.input, state.workingDirectory));
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
  const prompt = promptWithAttachments({ kind: 'prompt', id: nextPartId(state, 'prompt'), text: unwrapPastedContent(record.text), at: record.ts, attachments: [] }, state.pendingAttachments);
  state.pendingAttachments = null;
  state.latestPrompt = prompt;
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

function nonPromptPartOf(state: ChatPartsState, record: TraceRecord): ChatPart | null {
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

function openSubagentRow(state: ChatPartsState, start: SubagentStart): TrackedSubagent {
  const tracked: TrackedSubagent = {
    part: { kind: 'subagent', id: nextPartId(state, 'subagent'), ...start, endedAt: null, steps: [], stepCount: 0, report: null },
    subagentId: null,
    toolUseId: null,
    model: null,
    isBackground: false,
  };
  state.runningSubagents.add(tracked);
  return tracked;
}

function oldestRunningSubagent(state: ChatPartsState, isCandidate: (tracked: TrackedSubagent) => boolean): TrackedSubagent | null {
  for (const tracked of state.runningSubagents) {
    if (isCandidate(tracked)) return tracked;
  }
  return null;
}

function finishSubagent(state: ChatPartsState, tracked: TrackedSubagent, endedAt: number): void {
  tracked.part.endedAt ??= endedAt;
  state.runningSubagents.delete(tracked);
}

function attachSubagentId(state: ChatPartsState, tracked: TrackedSubagent, subagentId: string): void {
  tracked.subagentId = subagentId;
  rememberSubagent(state.subagentById, subagentId, tracked);
}

function attachCall(state: ChatPartsState, tracked: TrackedSubagent, toolUseId: string): void {
  tracked.toolUseId = toolUseId;
  rememberSubagent(state.subagentByToolUseId, toolUseId, tracked);
}

function startSubagent(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'subagent' }>): TrackedSubagent | null {
  if (state.subagentById.has(record.subagentId)) return null;
  const launchingCall = state.subagentByToolUseId.get(record.subagentId)
    ?? oldestRunningSubagent(state, (tracked) => tracked.toolUseId !== null && tracked.subagentId === null && (record.subagentType === null || tracked.part.subagentType === record.subagentType));
  const tracked = launchingCall ?? openSubagentRow(state, { subagentType: record.subagentType ?? 'Subagent', task: record.task, startedAt: record.ts });
  tracked.part.task ??= record.task;
  attachSubagentId(state, tracked, record.subagentId);
  return tracked;
}

function openSubagentCall(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'tool_call' }>): TrackedSubagent {
  const calledType = textFieldOf(record.input, 'subagent_type');
  const startedSubagent = state.subagentById.get(record.toolUseId)
    ?? oldestRunningSubagent(state, (tracked) => tracked.subagentId !== null && tracked.toolUseId === null && (calledType === null || tracked.part.subagentType === calledType));
  const tracked = startedSubagent ?? openSubagentRow(state, { subagentType: calledType ?? record.name, task: null, startedAt: record.ts });
  tracked.part.subagentType = calledType ?? tracked.part.subagentType;
  tracked.part.task = textFieldOf(record.input, 'description') ?? tracked.part.task;
  tracked.part.startedAt = Math.min(tracked.part.startedAt, record.ts);
  tracked.model = textFieldOf(record.input, 'model');
  tracked.isBackground = typeof record.input === 'object' && record.input !== null && Reflect.get(record.input, 'run_in_background') === true;
  attachCall(state, tracked, record.toolUseId);
  return tracked;
}

function swapCalls(state: ChatPartsState, first: TrackedSubagent, second: TrackedSubagent): void {
  const firstCall = { toolUseId: first.toolUseId, task: first.part.task, model: first.model, isBackground: first.isBackground };
  first.part.task = second.part.task;
  first.model = second.model;
  first.isBackground = second.isBackground;
  second.part.task = firstCall.task;
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

function settleSubagentCall(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'tool_result' }>): TrackedSubagent[] {
  const calledSubagent = state.subagentByToolUseId.get(record.toolUseId);
  if (calledSubagent === undefined) return [];
  const tracked = record.subagentId === undefined ? calledSubagent : launchedSubagentOf(state, calledSubagent, record.subagentId);
  const changed = tracked === calledSubagent ? [tracked] : [tracked, calledSubagent];
  const awaitsStop = tracked.isBackground && record.subagentId !== undefined && !record.isError;
  if (awaitsStop) return changed;
  if (!tracked.isBackground) tracked.part.report ??= record.content.trim() || null;
  finishSubagent(state, tracked, record.ts);
  return changed;
}

function noteSubagentSignal(state: ChatPartsState, record: Extract<TraceRecord, { kind: 'subagent' }>): TrackedSubagent | null {
  if (record.phase === 'start') return startSubagent(state, record);
  const tracked = state.subagentById.get(record.subagentId);
  if (tracked === undefined) return null;
  finishSubagent(state, tracked, record.ts);
  return tracked;
}

function noteSubagentStep(state: ChatPartsState, record: TraceRecord, subagentId: string): TrackedSubagent | null {
  const tracked = state.subagentById.get(subagentId);
  if (tracked === undefined) return null;
  if (record.kind === 'assistant' && record.text.trim().length > 0) {
    tracked.part.report = record.text;
    return tracked;
  }
  if (record.kind !== 'tool_call') return null;
  tracked.part.steps.push(toolLabelOf(record.name, record.input, state.workingDirectory));
  if (tracked.part.steps.length > MAX_RUN_LABELS) tracked.part.steps.shift();
  tracked.part.stepCount += 1;
  return tracked;
}

function changedSubagentsOf(state: ChatPartsState, record: TraceRecord): TrackedSubagent[] {
  if (record.agentId !== undefined) return [noteSubagentStep(state, record, record.agentId)].filter((tracked) => tracked !== null);
  if (record.kind === 'subagent') return [noteSubagentSignal(state, record)].filter((tracked) => tracked !== null);
  if (record.kind === 'tool_result') return settleSubagentCall(state, record);
  if (record.kind !== 'tool_call' || !SUBAGENT_TOOL_NAMES.has(record.name)) return [];
  return [openSubagentCall(state, record)];
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

function backgroundLaunchOf(state: ChatPartsState, call: Extract<TraceRecord, { kind: 'tool_call' }>, launchedAt: number): BackgroundTaskLaunch {
  return {
    taskType: BACKGROUND_TASK_TYPE_BY_TOOL_NAME.get(call.name) ?? null,
    label: textFieldOf(call.input, 'description') ?? toolLabelOf(call.name, call.input, state.workingDirectory),
    command: textFieldOf(call.input, 'command'),
    startedAt: launchedAt,
  };
}

function noteBackgroundLaunch(state: ChatPartsState, record: TraceRecord): void {
  if (record.agentId !== undefined) return;
  if (record.kind === 'tool_call' && BACKGROUND_TASK_TYPE_BY_TOOL_NAME.has(record.name)) {
    rememberBounded(state.backgroundCallByToolUseId, record.toolUseId, record);
    return;
  }
  if (record.kind !== 'tool_result') return;
  const call = state.backgroundCallByToolUseId.get(record.toolUseId);
  state.backgroundCallByToolUseId.delete(record.toolUseId);
  if (call === undefined || record.backgroundTaskId === undefined) return;
  rememberBounded(state.backgroundLaunchByTaskId, record.backgroundTaskId, backgroundLaunchOf(state, call, record.ts));
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
  noteBackgroundLaunch(state, record);
  if (record.kind === 'session') return stopEveryBackgroundTask(state, record.ts);
  if (record.kind !== 'background-task') return [];
  if (record.phase === 'stop') return [stopBackgroundTask(state, record.taskId, record.ts)].filter((stopped) => stopped !== null);
  return [startBackgroundTask(state, record)].filter((started) => started !== null);
}

function runningSubagentsOf(state: ChatPartsState): RunningSubagent[] {
  return [...state.runningSubagents].map((tracked) => ({ type: tracked.part.subagentType, model: tracked.model }));
}

export function runTimeText(startedAt: number, endedAt: number): string {
  return twoUnitDurationText(Math.max(1, Math.round((endedAt - startedAt) / 1000)), { smallestUnit: 's', dropsZeroRemainder: false });
}

export function subagentDurationText(part: SubagentPart): string | null {
  if (part.endedAt === null) return null;
  return runTimeText(part.startedAt, part.endedAt);
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
    for (const changedSubagent of changedSubagentsOf(state, record)) emit({ ...changedSubagent.part, steps: [...changedSubagent.part.steps] });
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
