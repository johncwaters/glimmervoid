import type { TraceRecord } from '#shared/contracts/trace.ts';

type WorkKind = 'thinking' | 'reading' | 'editing' | 'running';

export interface ActivityBeat {
  workKind: WorkKind;
  glimmervoidTool: string | null;
}

const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;
const GLIMMERVOID_SERVER = /glimmervoid/i;
const ANTIGRAVITY_MCP_CALL = 'call_mcp_tool';
const OPENCODE_GLIMMERVOID_TOOL_NAME = /^glimmervoid_(.+)$/;
const TRUNCATED_SERVER_NAME = /"ServerName"\s*:\s*"([^"]*)"/;
const TRUNCATED_TOOL_NAME = /"ToolName"\s*:\s*"([^"]*)"/;

const WORK_KIND_BY_TOOL_NAME = new Map<string, WorkKind>(Object.entries({
  read: 'reading',
  read_file: 'reading',
  readmediafile: 'reading',
  view_file: 'reading',
  grep: 'reading',
  glob: 'reading',
  ls: 'reading',
  list: 'reading',
  find: 'reading',
  webfetch: 'reading',
  websearch: 'reading',
  fetchurl: 'reading',
  edit: 'editing',
  multiedit: 'editing',
  notebookedit: 'editing',
  write: 'editing',
  apply_patch: 'editing',
  patch: 'editing',
} satisfies Record<string, WorkKind>));

const VERBS_BY_WORK_KIND: Record<WorkKind, readonly string[]> = {
  thinking: ['Thinking, allegedly', 'Staring into the void', 'Overthinking it', 'Having a little think', 'Weighing options it will ignore'],
  reading: ['Reading your code, regrettably', 'Skimming, mostly', 'Judging quietly', 'Reading the docs, for once', 'Looking for the bug you made'],
  editing: ['Fixing what it broke', 'Moving semicolons around', 'Improving things, probably', 'Editing with confidence', 'Rewriting it, again'],
  running: ['Pressing buttons', 'Running it to see what happens', 'Hoping the tests pass', 'Poking the shell', 'Waiting on a computer'],
};

const VERB_BY_GLIMMERVOID_TOOL = new Map<string, string>(Object.entries({
  whiteboard: 'Doodling on your board',
  show: 'Sticking it on the fridge',
  session: 'Hiring help it will not thank',
  push: 'Shipping it, bravely',
  attention: 'About to bother you',
  wake: 'Setting an alarm',
  review: 'Judging pull requests',
  why: 'Asking who did this',
  secrets: 'Rummaging for keys',
  settings: 'Fiddling with the dials',
  arena: 'Starting a fight',
  packs: 'Packing a bag',
  memory: 'Writing itself a note',
  claim: 'Calling dibs',
  preview: 'Admiring its own work',
}));

const GLIMMERVOID_FALLBACK_VERB = 'Talking to Glimmervoid, as one does';

export const THINKING_BEAT: ActivityBeat = { workKind: 'thinking', glimmervoidTool: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function antigravityMcpNames(input: unknown): { serverName: unknown; toolName: unknown } {
  if (isRecord(input)) return { serverName: input.ServerName, toolName: input.ToolName };
  if (typeof input !== 'string') return { serverName: null, toolName: null };
  return { serverName: TRUNCATED_SERVER_NAME.exec(input)?.[1] ?? null, toolName: TRUNCATED_TOOL_NAME.exec(input)?.[1] ?? null };
}

function antigravityGlimmervoidTool(input: unknown): string | null {
  const { serverName, toolName } = antigravityMcpNames(input);
  if (typeof serverName !== 'string' || typeof toolName !== 'string') return null;
  return GLIMMERVOID_SERVER.test(serverName) ? toolName : null;
}

function glimmervoidToolOf(name: string, input: unknown): string | null {
  if (name === ANTIGRAVITY_MCP_CALL) return antigravityGlimmervoidTool(input);
  const openCodeMatch = OPENCODE_GLIMMERVOID_TOOL_NAME.exec(name);
  if (openCodeMatch) return openCodeMatch[1] ?? null;
  const mcpMatch = MCP_TOOL_NAME.exec(name);
  if (!mcpMatch || !GLIMMERVOID_SERVER.test(mcpMatch[1] ?? '')) return null;
  return mcpMatch[2] ?? null;
}

function beatOfToolCall(name: string, input: unknown): ActivityBeat {
  const glimmervoidTool = glimmervoidToolOf(name, input);
  const workKind = WORK_KIND_BY_TOOL_NAME.get(name.toLowerCase()) ?? 'running';
  return { workKind, glimmervoidTool };
}

export function beatOfRecord(record: TraceRecord): ActivityBeat | null {
  if (record.kind === 'tool_call') return beatOfToolCall(record.name, record.input);
  if (record.kind === 'thinking' && record.text.trim().length > 0) return THINKING_BEAT;
  return null;
}

export function verbChoicesFor(beat: ActivityBeat): readonly string[] {
  if (beat.glimmervoidTool === null) return VERBS_BY_WORK_KIND[beat.workKind];
  return [VERB_BY_GLIMMERVOID_TOOL.get(beat.glimmervoidTool) ?? GLIMMERVOID_FALLBACK_VERB];
}
