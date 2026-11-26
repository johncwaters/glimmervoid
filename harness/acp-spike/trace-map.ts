import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TraceRecord } from '../../shared/contracts/trace.ts';

type JsonObject = Record<string, unknown>;

const RECORDINGS_DIR = join(import.meta.dirname, 'recordings');

function textOf(content: unknown): string {
  if (Array.isArray(content)) return content.map(textOf).join('');
  if (content === null || typeof content !== 'object') return typeof content === 'string' ? content : '';
  const block = content as JsonObject;
  if (typeof block.text === 'string') return block.text;
  if (block.content !== undefined) return textOf(block.content);
  if (block.type === 'diff') return `diff ${String(block.path)}`;
  if (block.type === 'terminal') return `terminal ${String(block.terminalId)}`;
  return '';
}

const PERMISSION_MODE_BY_ACP_MODE: Record<string, string> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  bypassPermissions: 'bypassPermissions',
  plan: 'plan',
  auto: 'auto',
  dontAsk: 'dontAsk',
};

function candidateRecord(update: JsonObject, sessionId: string): JsonObject | null {
  const base = { ts: 0, uuid: null, parentUuid: null, vendorSessionId: sessionId };
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return { ...base, kind: 'prompt', text: textOf(update.content) };
    case 'agent_message_chunk':
      return { ...base, kind: 'assistant', text: textOf(update.content) };
    case 'agent_thought_chunk':
      return { ...base, kind: 'thinking', text: textOf(update.content) };
    case 'tool_call':
      return { ...base, kind: 'tool_call', toolUseId: update.toolCallId, name: update.title || update.kind, input: update.rawInput ?? null };
    case 'tool_call_update':
      if (update.status !== 'completed' && update.status !== 'failed') return null;
      return {
        ...base,
        kind: 'tool_result',
        toolUseId: update.toolCallId,
        content: textOf(update.content) || JSON.stringify(update.rawOutput ?? ''),
        isError: update.status === 'failed',
        truncated: false,
      };
    case 'current_mode_update': {
      const modeId = String(update.currentModeId);
      return { ...base, kind: 'permission-mode', mode: PERMISSION_MODE_BY_ACP_MODE[modeId] ?? 'other', modeName: modeId };
    }
    case 'config_option_update': {
      const modelOption = ((update.configOptions ?? []) as JsonObject[]).find((option) => option.category === 'model');
      if (modelOption === undefined) return null;
      return { ...base, kind: 'model-change', model: String(modelOption.currentValue) };
    }
    case 'subagent_update': {
      const state = (update.state as JsonObject | undefined)?.state;
      if (state !== 'running' && state !== 'idle') return null;
      return {
        ...base,
        kind: 'subagent',
        phase: state === 'running' ? 'start' : 'stop',
        subagentId: update.sessionId,
        subagentType: typeof update.description === 'string' ? update.description : null,
        task: typeof update.title === 'string' ? update.title : null,
      };
    }
    case 'notice':
      return { ...base, kind: 'notice', text: textOf(update.content ?? update.message ?? update.text) };
    case 'compaction_update':
      return { ...base, kind: 'compaction', tokensBefore: null, tokensAfter: null };
    default:
      return null;
  }
}

type KindReport = { count: number; mappedTo: Set<string>; parsed: number; failed: number; firstFailure: string | null };

const wantedAgents = process.argv.slice(2);
const reportByAgent: Record<string, Record<string, KindReport>> = {};

for (const agentName of readdirSync(RECORDINGS_DIR)) {
  if (wantedAgents.length > 0 && !wantedAgents.includes(agentName)) continue;
  const reportByKind: Record<string, KindReport> = {};
  reportByAgent[agentName] = reportByKind;
  for (const fileName of readdirSync(join(RECORDINGS_DIR, agentName)).filter((name) => name.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(RECORDINGS_DIR, agentName, fileName), 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      const entry = JSON.parse(line) as { direction: string; message: JsonObject };
      if (entry.direction !== 'agent->client' || entry.message?.method !== 'session/update') continue;
      const params = entry.message.params as JsonObject;
      const update = params.update as JsonObject;
      const kind = String(update.sessionUpdate);
      reportByKind[kind] ??= { count: 0, mappedTo: new Set(), parsed: 0, failed: 0, firstFailure: null };
      const report = reportByKind[kind];
      report.count += 1;
      const record = candidateRecord(update, String(params.sessionId));
      if (record === null) continue;
      report.mappedTo.add(String(record.kind));
      const parsed = TraceRecord.safeParse(record);
      if (parsed.success) {
        report.parsed += 1;
        continue;
      }
      report.failed += 1;
      report.firstFailure ??= `${fileName}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`;
    }
  }
}

for (const [agentName, reportByKind] of Object.entries(reportByAgent)) {
  process.stdout.write(`\n### ${agentName}\n| session/update kind | count | TraceRecord kind | parsed | failed |\n|---|---|---|---|---|\n`);
  for (const [kind, report] of Object.entries(reportByKind).sort(([left], [right]) => left.localeCompare(right))) {
    const mapped = report.mappedTo.size === 0 ? 'none' : [...report.mappedTo].join(', ');
    process.stdout.write(`| ${kind} | ${report.count} | ${mapped} | ${report.parsed} | ${report.failed}${report.firstFailure ? ` (${report.firstFailure.slice(0, 160)})` : ''} |\n`);
  }
}
