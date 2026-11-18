import type { TraceRecord } from '#shared/contracts/trace.ts';

type WorkKind = 'thinking' | 'reading' | 'editing' | 'running' | 'working';

export interface ActivityBeat {
  workKind: WorkKind;
  glimmervoidTool: string | null;
  toolName: string | null;
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
  bash: 'running',
  shell: 'running',
  exec: 'running',
  exec_command: 'running',
  local_shell: 'running',
  run_command: 'running',
  run_shell_command: 'running',
} satisfies Record<string, WorkKind>));

const VERBS_BY_WORK_KIND: Record<Exclude<WorkKind, 'working'>, readonly string[]> = {
  thinking: ['Thinking, allegedly', 'Staring into the void', 'Overthinking it', 'Having a little think', 'Weighing options it will ignore'],
  reading: ['Reading, regrettably', 'Skimming, mostly', 'Reading quietly', 'Looking things up', 'Reading the fine print'],
  editing: ['Editing a file', 'Moving semicolons around', 'Editing with confidence', 'Changing a file, carefully', 'Typing very fast'],
  running: ['Running a command', 'Poking the shell', 'Waiting on a command', 'Pressing enter, bravely', 'Running a command, nervously'],
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

export const THINKING_BEAT: ActivityBeat = { workKind: 'thinking', glimmervoidTool: null, toolName: null };

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
  const workKind = WORK_KIND_BY_TOOL_NAME.get(name.toLowerCase()) ?? 'working';
  return { workKind, glimmervoidTool, toolName: name };
}

const SKILL_TOOL_NAME = 'skill';
const FILE_READ_TOOL_NAMES: ReadonlySet<string> = new Set(['read', 'read_file', 'view_file']);
const SKILL_FILE_PATH = /(?:^|[\\/\s"'])skills[\\/]+([A-Za-z0-9._:-]+)[\\/]+SKILL\.md/;
const SHELL_SKILL_READ = /(?:^|[\s;&|("'])(?:cat|head|bat|less|more|type|Get-Content|gc)\s+(?:-\S+\s+)*["']?([^\s;&|"']*SKILL\.md)/;

function skillNameFromInput(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const named = input.skill ?? input.name;
  return typeof named === 'string' && named.trim().length > 0 ? named.trim() : null;
}

function inputTextOf(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input ?? null).replaceAll('\\\\', '\\');
}

function skillFileNameOf(pathText: string): string | null {
  return SKILL_FILE_PATH.exec(pathText)?.[1] ?? null;
}

export function loadedSkillOf(record: TraceRecord): string | null {
  if (record.kind !== 'tool_call') return null;
  if (record.name.toLowerCase() === SKILL_TOOL_NAME) return skillNameFromInput(record.input);
  const inputText = inputTextOf(record.input);
  if (FILE_READ_TOOL_NAMES.has(record.name.toLowerCase())) return skillFileNameOf(inputText);
  if (beatOfToolCall(record.name, record.input).workKind !== 'running') return null;
  const shellReadPath = SHELL_SKILL_READ.exec(inputText)?.[1];
  return shellReadPath === undefined ? null : skillFileNameOf(` ${shellReadPath}`);
}

export function beatOfRecord(record: TraceRecord): ActivityBeat | null {
  if (record.kind === 'tool_call') return beatOfToolCall(record.name, record.input);
  if (record.kind === 'thinking' && record.text.trim().length > 0) return THINKING_BEAT;
  return null;
}

export function verbChoicesFor(beat: ActivityBeat): readonly string[] {
  if (beat.glimmervoidTool !== null) return [VERB_BY_GLIMMERVOID_TOOL.get(beat.glimmervoidTool) ?? GLIMMERVOID_FALLBACK_VERB];
  if (beat.workKind === 'working') return [`Using ${beat.toolName ?? 'a tool'}`];
  return VERBS_BY_WORK_KIND[beat.workKind];
}
