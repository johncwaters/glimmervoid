import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { TraceRecord } from '#shared/contracts/trace.ts';
import { STATES } from '#shared/states.ts';

type ToolResultRecord = Extract<TraceRecord, { kind: 'tool_result' }>;

const CONVERSATION_AGENTS: ReadonlySet<string> = new Set(['claude-code', 'codex']);

const ESCAPE = String.fromCharCode(27);
const BRACKETED_PASTE_START = `${ESCAPE}[200~`;
const BRACKETED_PASTE_END = `${ESCAPE}[201~`;
const SUBMIT_DELAY_MS = 400;
const MAX_RESIDENT_RECORDS = 4000;
const IMAGE_SOURCE_NOTE_RE = /^\[Image: source: (.+)\]$/;
const UPLOADS_FOLDER_NAME = 'uploads';
const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task']);
const BACKGROUND_AGENT_LAUNCH_RE = /^Async agent launched/;
const LAUNCHED_AGENT_ID_RE = /agentId: ([\w-]+)/;
const TASK_NOTIFICATION_ID_RE = /<task-id>([^<]+)<\/task-id>/;
const TASK_NOTIFICATION_STATUS_RE = /<status>([^<]+)<\/status>/;
const ECHO_LIFETIME_MS = 10 * 60 * 1000;

export interface TimedKeystroke {
  data: string;
  delayBeforeMs: number;
}

interface ConversationToolStep {
  isRunning: boolean;
}

type ConversationAgentState = 'running' | 'done' | 'failed';

export interface ConversationAgentRun {
  key: string;
  description: string;
  state: ConversationAgentState;
}

export interface ConversationWorkGroup {
  kind: 'work';
  key: string;
  steps: ConversationToolStep[];
  agentRuns: ConversationAgentRun[];
  startedAt: number;
  endedAt: number;
}

interface ConversationMessage {
  kind: 'assistant' | 'notice';
  key: string;
  text: string;
  at: number;
}

interface ConversationUserMessage {
  kind: 'user';
  key: string;
  text: string;
  at: number;
  imageUrls: string[];
}

export type ConversationEntry = ConversationUserMessage | ConversationMessage | ConversationWorkGroup;

export interface MessageEcho<Attachment> {
  text: string;
  attachment: Attachment | null;
  sentAt: number;
  userKeysAtSend: ReadonlySet<string>;
}

export interface ConversationFaceController {
  el: HTMLDivElement;
  show: (sessionId: string) => void;
  hide: () => void;
  refresh: () => void;
  applyTraceResponse: (reply: ServerMessageOf<'session-trace-response'>) => boolean;
  applyTraceError: (error: ServerMessageOf<'error'>) => boolean;
  applyTraceChanged: (sessionId: string) => void;
}

export function isConversationAgent(agent: string | null | undefined): boolean {
  return typeof agent === 'string' && CONVERSATION_AGENTS.has(agent);
}

export function composerKeystrokes(agent: string | null | undefined, text: string): readonly TimedKeystroke[] | null {
  if (!isConversationAgent(agent)) return null;
  const message = text.replace(/\r\n?/g, '\n').trim();
  if (!message) return null;
  const typed = message.includes('\n') ? `${BRACKETED_PASTE_START}${message}${BRACKETED_PASTE_END}` : message;
  return [{ data: typed, delayBeforeMs: 0 }, { data: '\r', delayBeforeMs: SUBMIT_DELAY_MS }];
}

export function submitKeystrokes(agent: string | null | undefined): readonly TimedKeystroke[] | null {
  if (!isConversationAgent(agent)) return null;
  return [{ data: '\r', delayBeforeMs: 0 }];
}

export function interruptKeystrokes(agent: string | null | undefined): readonly TimedKeystroke[] | null {
  if (!isConversationAgent(agent)) return null;
  return [{ data: ESCAPE, delayBeforeMs: 0 }];
}

export function isAnyPromptShowing(currentState: string, pendingPromptKind: string | null | undefined): boolean {
  return currentState === STATES.WAITING && typeof pendingPromptKind === 'string' && pendingPromptKind !== '';
}

function recordKey(record: TraceRecord, index: number): string {
  return record.uuid ?? `${record.kind}-${record.ts}-${index}`;
}

function isSubagentRecord(record: TraceRecord): boolean {
  return typeof record.agentId === 'string';
}

function uploadedImageUrl(imageSourceNote: string): string | null {
  const sourceMatch = IMAGE_SOURCE_NOTE_RE.exec(imageSourceNote.trim());
  if (!sourceMatch) return null;
  const pathSegments = sourceMatch[1].split(/[\\/]/);
  const [uploadsFolder, sessionFolder, filename] = pathSegments.slice(-3);
  if (uploadsFolder !== UPLOADS_FOLDER_NAME || !sessionFolder || !filename) return null;
  return `/upload/${encodeURIComponent(sessionFolder)}/${encodeURIComponent(filename)}`;
}

function attachImageToLatestPrompt(entries: ConversationEntry[], imageUrl: string) {
  const latestEntry = entries[entries.length - 1];
  if (latestEntry?.kind !== 'user') return;
  latestEntry.imageUrls.push(imageUrl);
}

function agentDescription(input: unknown): string {
  if (!input || typeof input !== 'object') return 'Agent';
  const description = (input as { description?: unknown }).description;
  return typeof description === 'string' && description.trim() ? description.trim() : 'Agent';
}

function finishAgentRun(run: ConversationAgentRun | undefined, result: ToolResultRecord, agentRunsByAgentId: Map<string, ConversationAgentRun>) {
  if (!run) return;
  if (result.isError) { run.state = 'failed'; return; }
  const launchedAgentId = LAUNCHED_AGENT_ID_RE.exec(result.content)?.[1];
  if (launchedAgentId && BACKGROUND_AGENT_LAUNCH_RE.test(result.content)) {
    agentRunsByAgentId.set(launchedAgentId, run);
    return;
  }
  run.state = 'done';
}

function applyTaskNotification(text: string, agentRunsByAgentId: Map<string, ConversationAgentRun>) {
  const taskId = TASK_NOTIFICATION_ID_RE.exec(text)?.[1];
  const run = taskId ? agentRunsByAgentId.get(taskId) : undefined;
  if (!run) return;
  run.state = TASK_NOTIFICATION_STATUS_RE.exec(text)?.[1] === 'completed' ? 'done' : 'failed';
}

export function conversationEntries(records: readonly TraceRecord[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  const stepsByToolUseId = new Map<string, ConversationToolStep>();
  const groupByToolUseId = new Map<string, ConversationWorkGroup>();
  const agentRunsByToolUseId = new Map<string, ConversationAgentRun>();
  const agentRunsByAgentId = new Map<string, ConversationAgentRun>();
  let turnGroup: ConversationWorkGroup | null = null;

  function closeTurn() {
    if (turnGroup) entries.push(turnGroup);
    turnGroup = null;
  }

  function workGroupAt(key: string, at: number): ConversationWorkGroup {
    turnGroup ??= { kind: 'work', key, steps: [], agentRuns: [], startedAt: at, endedAt: at };
    turnGroup.endedAt = Math.max(turnGroup.endedAt, at);
    return turnGroup;
  }

  records.forEach((record, index) => {
    const key = recordKey(record, index);
    if (isSubagentRecord(record)) return;
    if (record.kind === 'prompt') {
      closeTurn();
      entries.push({ kind: 'user', key, text: record.text, at: record.ts, imageUrls: [] });
      return;
    }
    if (record.kind === 'expansion') {
      applyTaskNotification(record.text, agentRunsByAgentId);
      for (const expansionLine of record.text.split('\n')) {
        const imageUrl = uploadedImageUrl(expansionLine);
        if (imageUrl) attachImageToLatestPrompt(entries, imageUrl);
      }
      return;
    }
    if (record.kind === 'assistant') {
      if (!record.text.trim()) return;
      entries.push({ kind: 'assistant', key, text: record.text, at: record.ts });
      return;
    }
    if (record.kind === 'notice') {
      entries.push({ kind: 'notice', key, text: record.text, at: record.ts });
      return;
    }
    if (record.kind === 'thinking') {
      workGroupAt(key, record.ts);
      return;
    }
    if (record.kind === 'tool_call') {
      const group = workGroupAt(key, record.ts);
      const step: ConversationToolStep = { isRunning: true };
      group.steps.push(step);
      stepsByToolUseId.set(record.toolUseId, step);
      groupByToolUseId.set(record.toolUseId, group);
      if (!AGENT_TOOL_NAMES.has(record.name)) return;
      const agentRun: ConversationAgentRun = { key, description: agentDescription(record.input), state: 'running' };
      group.agentRuns.push(agentRun);
      agentRunsByToolUseId.set(record.toolUseId, agentRun);
      return;
    }
    if (record.kind === 'tool_result') {
      const step = stepsByToolUseId.get(record.toolUseId);
      const group = groupByToolUseId.get(record.toolUseId);
      if (!step || !group) return;
      step.isRunning = false;
      group.endedAt = Math.max(group.endedAt, record.ts);
      finishAgentRun(agentRunsByToolUseId.get(record.toolUseId), record, agentRunsByAgentId);
    }
  });
  closeTurn();
  return entries;
}

export function runningAgentRuns(entries: readonly ConversationEntry[]): ConversationAgentRun[] {
  return entries.flatMap((entry) => (entry.kind === 'work' ? entry.agentRuns.filter((run) => run.state === 'running') : []));
}

export function trailingWorkGroup(entries: readonly ConversationEntry[]): ConversationWorkGroup | null {
  const lastEntry = entries.at(-1);
  return lastEntry?.kind === 'work' ? lastEntry : null;
}

export function userEntryKeys(entries: readonly ConversationEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => (entry.kind === 'user' ? [entry.key] : [])));
}

export function isEchoDelivered(echo: MessageEcho<unknown>, entries: readonly ConversationEntry[], nowMs: number): boolean {
  if (nowMs - echo.sentAt > ECHO_LIFETIME_MS) return true;
  const echoText = echo.text.trim();
  return entries.some((entry) => entry.kind === 'user' && !echo.userKeysAtSend.has(entry.key) && entry.text.includes(echoText));
}

function agentCountText(count: number): string {
  return `${count} ${count === 1 ? 'agent' : 'agents'}`;
}

function formatWorkDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function workGroupHeadline(group: ConversationWorkGroup): string {
  const agentText = group.agentRuns.length > 0 ? `, ${agentCountText(group.agentRuns.length)}` : '';
  return `Worked ${formatWorkDuration(group.endedAt - group.startedAt)}${agentText}`;
}

export function workingHeadline(elapsedMs: number | null, runningAgentCount: number): string {
  const runningText = runningAgentCount > 0 ? `${agentCountText(runningAgentCount)} running` : '';
  if (elapsedMs === null) return runningText;
  return runningText ? `Working ${formatWorkDuration(elapsedMs)}, ${runningText}` : `Working ${formatWorkDuration(elapsedMs)}`;
}

export function trimResidentRecords(records: TraceRecord[]): TraceRecord[] {
  if (records.length <= MAX_RESIDENT_RECORDS) return records;
  return records.slice(records.length - MAX_RESIDENT_RECORDS);
}
