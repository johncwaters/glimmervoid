import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { TraceRecord } from '#shared/contracts/trace.ts';
import { STATES } from '#shared/states.ts';
import { firstDetailLine, toolDetailLine } from '#shared/tool-detail.ts';

type ToolCallRecord = Extract<TraceRecord, { kind: 'tool_call' }>;
type ToolResultRecord = Extract<TraceRecord, { kind: 'tool_result' }>;

const CONVERSATION_AGENTS: ReadonlySet<string> = new Set(['claude-code', 'codex']);

const ESCAPE = String.fromCharCode(27);
const BRACKETED_PASTE_START = `${ESCAPE}[200~`;
const BRACKETED_PASTE_END = `${ESCAPE}[201~`;
const SUBMIT_DELAY_MS = 400;
const MAX_RESIDENT_RECORDS = 4000;

export interface TimedKeystroke {
  data: string;
  delayBeforeMs: number;
}

interface ConversationToolStep {
  toolUseId: string;
  name: string;
  summary: string;
  output: string | null;
  isError: boolean;
  isRunning: boolean;
}

export interface ConversationWorkGroup {
  kind: 'work';
  key: string;
  steps: ConversationToolStep[];
  thinkingCount: number;
  errorCount: number;
  startedAt: number;
  endedAt: number;
}

interface ConversationMessage {
  kind: 'user' | 'assistant' | 'notice';
  key: string;
  text: string;
  at: number;
}

export type ConversationEntry = ConversationMessage | ConversationWorkGroup;

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

function toolSummary(record: ToolCallRecord): string {
  return toolDetailLine(record.name, record.input) || record.name;
}

function openWorkGroup(entries: ConversationEntry[], key: string, at: number): ConversationWorkGroup {
  const last = entries[entries.length - 1];
  if (last?.kind === 'work') return last;
  const group: ConversationWorkGroup = { kind: 'work', key, steps: [], thinkingCount: 0, errorCount: 0, startedAt: at, endedAt: at };
  entries.push(group);
  return group;
}

function attachToolResult(stepsByToolUseId: Map<string, ConversationToolStep>, record: ToolResultRecord): boolean {
  const step = stepsByToolUseId.get(record.toolUseId);
  if (!step) return false;
  step.output = record.content;
  step.isError = record.isError;
  step.isRunning = false;
  return true;
}

export function conversationEntries(records: readonly TraceRecord[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  const stepsByToolUseId = new Map<string, ConversationToolStep>();
  const groupByToolUseId = new Map<string, ConversationWorkGroup>();
  records.forEach((record, index) => {
    const key = recordKey(record, index);
    if (record.kind === 'prompt' && !isSubagentRecord(record)) {
      entries.push({ kind: 'user', key, text: record.text, at: record.ts });
      return;
    }
    if (record.kind === 'assistant' && !isSubagentRecord(record)) {
      if (!record.text.trim()) return;
      entries.push({ kind: 'assistant', key, text: record.text, at: record.ts });
      return;
    }
    if (record.kind === 'notice') {
      entries.push({ kind: 'notice', key, text: record.text, at: record.ts });
      return;
    }
    if (record.kind === 'thinking') {
      const group = openWorkGroup(entries, key, record.ts);
      group.thinkingCount += 1;
      group.endedAt = record.ts;
      return;
    }
    if (record.kind === 'tool_call') {
      const group = openWorkGroup(entries, key, record.ts);
      const step: ConversationToolStep = { toolUseId: record.toolUseId, name: record.name, summary: toolSummary(record), output: null, isError: false, isRunning: true };
      group.steps.push(step);
      group.endedAt = record.ts;
      stepsByToolUseId.set(record.toolUseId, step);
      groupByToolUseId.set(record.toolUseId, group);
      return;
    }
    if (record.kind === 'tool_result') {
      if (!attachToolResult(stepsByToolUseId, record)) return;
      const group = groupByToolUseId.get(record.toolUseId);
      if (!group) return;
      group.endedAt = Math.max(group.endedAt, record.ts);
      if (record.isError) group.errorCount += 1;
    }
  });
  return entries;
}

export function workGroupHeadline(group: ConversationWorkGroup): string {
  const toolCount = group.steps.length;
  const parts: string[] = [];
  if (toolCount > 0) parts.push(`${toolCount} ${toolCount === 1 ? 'step' : 'steps'}`);
  if (group.thinkingCount > 0 && toolCount === 0) parts.push('Thought');
  if (group.errorCount > 0) parts.push(`${group.errorCount} failed`);
  const lastStep = group.steps[group.steps.length - 1];
  if (lastStep) parts.push(firstDetailLine(lastStep.summary));
  return parts.join(' | ');
}

export function isWorkGroupRunning(group: ConversationWorkGroup): boolean {
  return group.steps.some((step) => step.isRunning);
}

export function trimResidentRecords(records: TraceRecord[]): TraceRecord[] {
  if (records.length <= MAX_RESIDENT_RECORDS) return records;
  return records.slice(records.length - MAX_RESIDENT_RECORDS);
}
