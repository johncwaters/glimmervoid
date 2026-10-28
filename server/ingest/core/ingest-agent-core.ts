import { textOr } from '../../../shared/coerce.ts';
import { parseJsonRecord } from '../../core/json-core.ts';
const SOURCE = 'agentLogs';

const MAX_RAW_CHARS = 4000;

type VendorState = Record<string, string>;

export type AgentIngestEvent = {
  source: string;
  kind: string;
  ts: number;
  scope: { root: string | null; sessionId: string | null };
  summary: string;
  detail: Record<string, unknown>;
}

interface AgentMapResult {
  events: AgentIngestEvent[];
  root: string | null;
  sessionId: string | null;
  vendorState: VendorState | null;
}

type ContentBlock = { type?: unknown; text?: unknown; name?: unknown; input?: unknown };

type GrokUpdate = {
  sessionUpdate?: unknown;
  content?: { text?: unknown };
  stop_reason?: unknown;
  rawInput?: unknown;
  title?: unknown;
  _meta?: Record<string, { name?: unknown }>;
};

type KimiToolCall = { name?: unknown; arguments?: unknown };

type KimiMessage = { role?: unknown; content?: unknown; toolCalls?: unknown };

type KimiMessageMeta = { origin?: { kind?: unknown } };

type TranscriptLine = {
  type?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  time?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown; message?: KimiMessage; meta?: KimiMessageMeta };
  environmentDisclosure?: { cwd?: unknown };
  payload?: Record<string, unknown>;
  params?: { update?: GrokUpdate; sessionId?: unknown };
};

interface MapContext {
  root: string | null;
  sessionId: string | null;
  vendorState: VendorState | null;
  now: number;
}

interface EventBase {
  ts: number;
  root: string | null;
  sessionId: string | null;
  vendor: string;
}

const TOOL_TARGET_KEYS: readonly string[] = Object.freeze([
  'file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'to', 'subagent_type',
  'description', 'prompt',
]);

const DISPATCH_WORKDIR_MARKERS: readonly string[] = Object.freeze([
  'glimmervoid-visions', 'glimmervoid-change-narrative', 'glimmervoid-wt-pr-review', 'glimmervoid-wt-team-review', 'glimmervoid-wt-radar-fix',
]);
const DISPATCH_WORKDIR_PATTERN = new RegExp(`(^|[\\\\/-])(${DISPATCH_WORKDIR_MARKERS.join('|')})-`, 'i');

function isDispatchWorkdir(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (DISPATCH_WORKDIR_PATTERN.test(candidate)) return true;

  try {
    const decoded = decodeURIComponent(candidate);
    if (decoded === candidate) return false;
    return DISPATCH_WORKDIR_PATTERN.test(decoded);
  } catch {
    return false;
  }
}


function boundRaw(value: unknown, max: number = MAX_RAW_CHARS): string {
  const text = String(value == null ? '' : value);
  if (text.length <= max) return text;
  const lastBreak = Math.max(text.lastIndexOf('\n', max), text.lastIndexOf('\r', max));
  if (lastBreak > 0) return text.slice(0, lastBreak).replace(/[\r\n]+$/, '');
  return text;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0 && value < 1e12) return Math.floor(value * 1000);
    if (value > 0) return Math.floor(value);
    return null;
  }
  const text = textOr(value, null);
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}


function toolTarget(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const record = input as Record<string, unknown>;
  for (const key of TOOL_TARGET_KEYS) {
    const value = textOr(record[key], null);
    if (!value) continue;
    return boundRaw(value);
  }
  return '';
}

function turnEvent({ ts, root, sessionId, vendor, text }: EventBase & { text: unknown }): AgentIngestEvent | null {
  const summary = boundRaw(text).trim();
  if (!summary) return null;
  return {
    source: SOURCE,
    kind: 'agent-turn',
    ts,
    scope: { root, sessionId },
    summary: `${vendor}: ${summary}`,
    detail: { vendor },
  };
}

function promptEvent({ ts, root, sessionId, vendor, text }: EventBase & { text: unknown }): AgentIngestEvent | null {
  const prompt = boundRaw(text).trim();
  if (!prompt) return null;
  return {
    source: SOURCE,
    kind: 'agent-prompt',
    ts,
    scope: { root, sessionId },
    summary: `${vendor}: ${prompt}`,
    detail: { vendor },
  };
}

function toolEvent({ ts, root, sessionId, vendor, name, target }: EventBase & { name: unknown; target: string }): AgentIngestEvent {
  const tool = boundRaw(textOr(name, null) || 'tool');
  const suffix = target ? ` ${target}` : '';
  return {
    source: SOURCE,
    kind: 'agent-tool',
    ts,
    scope: { root, sessionId },
    summary: `${vendor}: ${tool}${suffix}`,
    detail: { vendor, tool },
  };
}

function result(
  events: AgentIngestEvent[],
  root: string | null,
  sessionId: string | null,
  vendorState: VendorState | null,
): AgentMapResult {
  return { events, root, sessionId, vendorState };
}

function firstTextBlock(content: ContentBlock[]): string | null {
  for (const block of content) {
    if (block?.type !== 'text') continue;
    const text = textOr(block.text, null);
    if (text) return text;
  }
  return null;
}

const SLASH_COMMAND_ENVELOPE = /<command-name>\s*([^<]*?)\s*<\/command-name>/i;
const SLASH_COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/i;
const HARNESS_RECORD = /^\s*(?:<local-command-(?:caveat|stdout|stderr)>|<task-notification>|<bash-(?:input|stdout|stderr)>|\[Request interrupted by user)/i;

function claudePromptText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((block: ContentBlock) => block?.type === 'tool_result')) return null;
  return firstTextBlock(content);
}

function unwrapSlashCommand(text: string): string | null {
  if (HARNESS_RECORD.test(text)) return null;
  const commandName = SLASH_COMMAND_ENVELOPE.exec(text)?.[1];
  if (!commandName) return text;
  const commandArgs = SLASH_COMMAND_ARGS.exec(text)?.[1]?.trim() ?? '';
  return commandArgs ? `${commandName} ${commandArgs}` : commandName;
}

function mapClaudePromptLine(line: TranscriptLine, ctx: MapContext): AgentMapResult | null {
  if (line.isMeta === true || line.isSidechain === true || line.isCompactSummary === true) return null;
  const text = claudePromptText(line.message?.content);
  const prompt = text ? unwrapSlashCommand(text) : null;
  if (!prompt) return null;
  const root = textOr(line.cwd, null) || ctx.root;
  const sessionId = textOr(line.sessionId, null) || ctx.sessionId;
  const event = promptEvent({ ts: parseTimestamp(line.timestamp) || ctx.now, root, sessionId, vendor: 'claude', text: prompt });
  return event ? result([event], root, sessionId, ctx.vendorState) : null;
}

function mapClaudeLine(line: TranscriptLine, ctx: MapContext): AgentMapResult | null {
  if (line.type === 'user') return mapClaudePromptLine(line, ctx);
  if (line.type !== 'assistant') return null;
  const content = line.message?.content;
  if (!Array.isArray(content)) return null;

  const root = textOr(line.cwd, null) || ctx.root;
  const sessionId = textOr(line.sessionId, null) || ctx.sessionId;
  const ts = parseTimestamp(line.timestamp) || ctx.now;
  const events: AgentIngestEvent[] = [];
  const turn = turnEvent({ ts, root, sessionId, vendor: 'claude', text: firstTextBlock(content) });
  if (turn) events.push(turn);
  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    events.push(toolEvent({
      ts, root, sessionId, vendor: 'claude', name: block.name, target: toolTarget(block.input),
    }));
  }
  return result(events, root, sessionId, ctx.vendorState);
}

const EXEC_COMMAND_CALL = /exec_command\(/g;
const EXEC_CMD_ARGUMENT = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.)*`)/;

function parsedJsonString(literal: string): string | null {
  try {
    const parsed: unknown = JSON.parse(literal);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function commandLiteralValue(literal: string): string | null {
  if (literal.startsWith('"')) return parsedJsonString(literal);
  return literal.slice(1, -1).replace(/\\(.)/g, '$1');
}

function execCommandsOf(input: unknown): string[] {
  if (typeof input !== 'string') return [];
  const callStarts = [...input.matchAll(EXEC_COMMAND_CALL)].map((match) => match.index);
  return callStarts.map((callStart, callNumber) => {
    const callText = input.slice(callStart, callStarts[callNumber + 1] ?? input.length);
    const literal = EXEC_CMD_ARGUMENT.exec(callText)?.[1];
    const command = literal ? commandLiteralValue(literal) : null;
    return command ? boundRaw(command) : '';
  });
}

function codexPromptText(payload: Record<string, unknown>): string | null {
  if (payload.type === 'user_message') return textOr(payload.message, null);
  if (payload.type !== 'item_completed') return null;
  const item = payload.item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  if (record.type !== 'UserMessage' || !Array.isArray(record.content)) return null;
  return firstTextBlock(record.content);
}

function mapCodexLine(line: TranscriptLine, ctx: MapContext): AgentMapResult | null {
  const payload = line.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const ts = parseTimestamp(line.timestamp) || ctx.now;

  if (line.type === 'session_meta' || line.type === 'turn_context') {
    return result([], textOr(payload.cwd, null) || ctx.root, textOr(payload.session_id, null) || ctx.sessionId, ctx.vendorState);
  }
  const base: EventBase = { ts, root: ctx.root, sessionId: ctx.sessionId, vendor: 'codex' };
  if (line.type === 'event_msg' && payload.type === 'agent_message') {
    const turn = turnEvent({ ...base, text: payload.message });
    if (!turn) return null;
    return result([turn], ctx.root, ctx.sessionId, ctx.vendorState);
  }
  const prompt = line.type === 'event_msg' ? codexPromptText(payload) : null;
  if (prompt) {
    const event = promptEvent({ ...base, text: prompt });
    return event ? result([event], ctx.root, ctx.sessionId, ctx.vendorState) : null;
  }
  if (line.type === 'response_item' && payload.type === 'custom_tool_call' && payload.name === 'exec') {
    const events = execCommandsOf(payload.input).map((command) => toolEvent({ ...base, name: 'exec_command', target: command }));
    return events.length > 0 ? result(events, ctx.root, ctx.sessionId, ctx.vendorState) : null;
  }
  if (line.type === 'response_item' && payload.type === 'function_call') {
    const target = toolTarget(parseJsonRecord(payload.arguments));
    return result([toolEvent({ ...base, name: payload.name, target })], ctx.root, ctx.sessionId, ctx.vendorState);
  }
  return null;
}

const PENDING_TURN_FIELD = 'pendingText';

function appendChunk(vendorState: VendorState | null | undefined, text: unknown, field: string): VendorState {
  const addition = textOr(text, null);
  const held = typeof vendorState?.[field] === 'string' ? vendorState[field] : '';
  if (!addition) return { [field]: held };
  const remaining = MAX_RAW_CHARS - held.length - 1;
  if (remaining <= 0) return { [field]: held };
  const bounded = boundRaw(addition, remaining);

  if (bounded.length > remaining) return { [field]: held };
  return { [field]: `${held} ${bounded}` };
}

const GROK_TURN_BOUNDARIES: readonly string[] = Object.freeze(['user_message_chunk', 'retry_state']);

function grokToolName(update: GrokUpdate): string {
  const meta = update._meta && typeof update._meta === 'object' ? update._meta['x.ai/tool'] : null;
  return textOr(meta?.name, null) || textOr(update.title, null) || 'tool';
}

function mapGrokTurn(
  kind: string | null,
  update: GrokUpdate,
  base: EventBase,
  ctx: { root: string | null; sessionId: string | null; vendorState: VendorState | null },
): AgentMapResult | null {
  if (kind !== null && GROK_TURN_BOUNDARIES.includes(kind)) return result([], ctx.root, ctx.sessionId, null);
  if (kind === 'agent_message_chunk') {
    const next = appendChunk(ctx.vendorState, update.content?.text, PENDING_TURN_FIELD);
    return result([], ctx.root, ctx.sessionId, next);
  }
  if (kind === 'turn_completed') {
    const pending = textOr(ctx.vendorState?.[PENDING_TURN_FIELD], null);
    const stopReason = textOr(update.stop_reason, null);
    const text = pending || `turn complete${stopReason ? ` (${stopReason})` : ''}`;
    const turn = turnEvent({ ...base, text });
    if (!turn) return result([], ctx.root, ctx.sessionId, null);
    return result([turn], ctx.root, ctx.sessionId, null);
  }

  if (kind === 'tool_call') {
    const target = toolTarget(update.rawInput);
    return result([toolEvent({ ...base, name: grokToolName(update), target })], ctx.root, ctx.sessionId, ctx.vendorState);
  }
  return null;
}

function mapGrokLine(line: TranscriptLine, ctx: MapContext): AgentMapResult | null {
  const update = line.params?.update;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const sessionId = textOr(line.params?.sessionId, null) || ctx.sessionId;
  const ts = parseTimestamp(line.timestamp) || ctx.now;
  const base: EventBase = { ts, root: ctx.root, sessionId, vendor: 'grok' };
  const kind = textOr(update.sessionUpdate, null);
  return mapGrokTurn(kind, update, base, { root: ctx.root, sessionId, vendorState: ctx.vendorState });
}

const KIMI_CWD_RECORD = 'profile.bind';

function kimiRootOf(line: TranscriptLine): string | null {
  if (line.type !== KIMI_CWD_RECORD) return null;
  return textOr(line.environmentDisclosure?.cwd, null);
}

function kimiToolEvents(toolCalls: unknown, base: EventBase): AgentIngestEvent[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call: KimiToolCall) => toolEvent({
    ...base, name: call?.name, target: toolTarget(parseJsonRecord(call?.arguments)),
  }));
}

function mapKimiPrompt(line: TranscriptLine, content: ContentBlock[], base: EventBase, ctx: MapContext): AgentMapResult | null {
  const originKind = line.message?.meta?.origin?.kind;
  if (originKind !== undefined && originKind !== 'user') return null;
  const event = promptEvent({ ...base, text: firstTextBlock(content) });
  return event ? result([event], ctx.root, ctx.sessionId, ctx.vendorState) : null;
}

function mapKimiLine(line: TranscriptLine, ctx: MapContext): AgentMapResult | null {
  const announcedRoot = kimiRootOf(line);
  if (announcedRoot) return result([], announcedRoot, ctx.sessionId, ctx.vendorState);
  if (line.type !== 'agent.message.appended') return null;
  const message = line.message?.message;
  const base: EventBase = { ts: parseTimestamp(line.time) || ctx.now, root: ctx.root, sessionId: ctx.sessionId, vendor: 'kimi' };
  const content = Array.isArray(message?.content) ? message.content : [];
  if (message?.role === 'user') return mapKimiPrompt(line, content, base, ctx);
  if (message?.role !== 'assistant') return null;
  const turn = turnEvent({ ...base, text: firstTextBlock(content) });
  const events = [...(turn ? [turn] : []), ...kimiToolEvents(message.toolCalls, base)];
  return result(events, ctx.root, ctx.sessionId, ctx.vendorState);
}

const MAPPERS: Readonly<Record<string, ((line: TranscriptLine, ctx: MapContext) => AgentMapResult | null) | undefined>> =
  Object.freeze({ claude: mapClaudeLine, codex: mapCodexLine, grok: mapGrokLine, kimi: mapKimiLine });

function mapAgentLine({
  vendor = '',
  rawLine = null,
  ctx = {},
  vendorState = null,
}: {
  vendor?: string;
  rawLine?: unknown;
  ctx?: { root?: string | null; sessionId?: string | null; now?: number };
  vendorState?: VendorState | null;
} = {}): AgentMapResult {
  const root = ctx.root == null ? null : ctx.root;
  const sessionId = ctx.sessionId == null ? null : ctx.sessionId;
  const unchanged = result([], root, sessionId, vendorState);
  const mapper = MAPPERS[vendor];
  if (!mapper) return unchanged;
  const line = parseJsonRecord(rawLine);
  if (!line) return unchanged;
  const mapped = mapper(line as TranscriptLine, {
    root, sessionId, vendorState,
    now: typeof ctx.now === 'number' && Number.isFinite(ctx.now) ? ctx.now : 0,
  });
  if (!mapped) return unchanged;
  return mapped;
}

export { isDispatchWorkdir, firstTextBlock, kimiRootOf, mapAgentLine, parseTimestamp };
