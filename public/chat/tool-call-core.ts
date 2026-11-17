import type { ChatToolCall, ChatToolOutcome, ToolCategory } from './chat-part.ts';

const MAIN_INPUT_KEYS = ['description', 'command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'skill', 'action', 'prompt'] as const;
const MAX_TARGET_CHARS = 240;
const PATH_START = `(?<![^\\s'"=(])`;
const PATH_END = `(?=[\\s'"]|$)`;
const SCRATCHPAD_PATH = new RegExp(`${PATH_START}/[^\\s'"]*?/\\.glimmervoid/sane-yolo-temp/[^\\s'"]*?/scratchpad/`, 'g');
const OTHER_TEMP_PATH = new RegExp(`${PATH_START}/[^\\s'"]*?/\\.glimmervoid/sane-yolo-temp/(?:[^\\s'"/]+/)*([^\\s'"/]+)`, 'g');
const REGEX_SPECIAL_CHARACTERS = /[.*+?^${}()|[\]\\]/g;
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

export interface PathContext {
  cwd: string | null;
  home: string | null;
}

export interface OutputExcerpt {
  firstLine: string;
  hiddenLineCount: number;
  lastLine: string | null;
}

interface EditToolInput {
  filePath: string;
  oldText: string;
  newText: string;
}

interface ToolSummary {
  category: ToolCategory;
  verb: string;
  target: string;
  filePaths: string[];
}

type InputRecord = Record<string, unknown>;

interface ToolKind {
  category: ToolCategory;
  verb: string;
  targetKeys: readonly string[];
}

const TOOL_KIND_BY_NAME = new Map<string, ToolKind>(Object.entries({
  Bash: { category: 'command', verb: 'Ran', targetKeys: ['description', 'command'] },
  exec_command: { category: 'command', verb: 'Ran', targetKeys: ['description', 'cmd', 'command'] },
  shell: { category: 'command', verb: 'Ran', targetKeys: ['description', 'command', 'cmd'] },
  Read: { category: 'read', verb: 'Read', targetKeys: ['file_path'] },
  read_file: { category: 'read', verb: 'Read', targetKeys: ['path', 'file_path'] },
  Edit: { category: 'edit', verb: 'Edited', targetKeys: ['file_path'] },
  MultiEdit: { category: 'edit', verb: 'Edited', targetKeys: ['file_path'] },
  NotebookEdit: { category: 'edit', verb: 'Edited', targetKeys: ['notebook_path', 'file_path'] },
  Write: { category: 'edit', verb: 'Wrote', targetKeys: ['file_path'] },
  apply_patch: { category: 'edit', verb: 'Patched', targetKeys: ['path', 'input'] },
  Grep: { category: 'search', verb: 'Searched', targetKeys: ['pattern'] },
  Glob: { category: 'search', verb: 'Listed', targetKeys: ['pattern'] },
  WebFetch: { category: 'web', verb: 'Fetched', targetKeys: ['url'] },
  WebSearch: { category: 'web', verb: 'Searched the web', targetKeys: ['query'] },
  Task: { category: 'agent', verb: 'Agent', targetKeys: ['description', 'prompt'] },
  Agent: { category: 'agent', verb: 'Agent', targetKeys: ['description', 'prompt'] },
  TodoWrite: { category: 'other', verb: 'Updated the todo list', targetKeys: [] },
  Skill: { category: 'other', verb: 'Skill', targetKeys: ['skill'] },
} satisfies Record<string, ToolKind>));

interface CategoryCount {
  singular: string;
  plural: string;
  verb: string;
}

const COUNT_WORDS_BY_CATEGORY: Record<ToolCategory, CategoryCount> = {
  command: { verb: 'ran', singular: 'command', plural: 'commands' },
  edit: { verb: 'edited', singular: 'file', plural: 'files' },
  read: { verb: 'read', singular: 'file', plural: 'files' },
  search: { verb: 'ran', singular: 'search', plural: 'searches' },
  web: { verb: 'fetched', singular: 'page', plural: 'pages' },
  agent: { verb: 'ran', singular: 'agent', plural: 'agents' },
  other: { verb: 'used', singular: 'tool', plural: 'tools' },
};

function isRecord(value: unknown): value is InputRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstLineClipped(text: string): string {
  const firstLine = text.trim().split('\n', 1)[0] ?? '';
  return firstLine.length > MAX_TARGET_CHARS ? firstLine.slice(0, MAX_TARGET_CHARS) : firstLine;
}

function firstStringAt(input: InputRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return '';
}

function decodedJsonString(literal: string): string {
  try {
    const decoded: unknown = JSON.parse(`"${literal}"`);
    return typeof decoded === 'string' ? decoded : '';
  } catch {
    return '';
  }
}

function firstStringInTruncatedJson(serializedInput: string, keys: readonly string[]): string {
  for (const key of keys) {
    const keyedString = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(serializedInput);
    const value = keyedString ? decodedJsonString(keyedString[1] ?? '') : '';
    if (value.trim().length > 0) return value;
  }
  return '';
}

function targetTextOf(input: unknown, keys: readonly string[]): string {
  if (isRecord(input)) return firstStringAt(input, keys);
  if (typeof input !== 'string') return '';
  if (input.trimStart().startsWith('{')) return firstStringInTruncatedJson(input, keys);
  return input;
}

function anyStringOf(input: unknown): string {
  const keyed = targetTextOf(input, MAIN_INPUT_KEYS);
  if (keyed || !isRecord(input)) return keyed;
  return Object.values(input).find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? '';
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function replacedPathPrefix(text: string, prefix: string | null, replacement: (isFollowedBySlash: boolean) => string): string {
  if (!prefix) return text;
  const escapedPrefix = withoutTrailingSlash(prefix).replace(REGEX_SPECIAL_CHARACTERS, '\\$&');
  const prefixPattern = new RegExp(`${PATH_START}${escapedPrefix}(/|${PATH_END})`, 'g');
  return text.replace(prefixPattern, (_match, slash: string) => replacement(slash === '/'));
}

export function shortenedPaths(text: string, pathContext: PathContext): string {
  const withoutTemp = text.replace(SCRATCHPAD_PATH, 'scratchpad/').replace(OTHER_TEMP_PATH, 'temp/$1');
  const relativeToCwd = replacedPathPrefix(withoutTemp, pathContext.cwd, (isFollowedBySlash) => (isFollowedBySlash ? '' : '.'));
  return replacedPathPrefix(relativeToCwd, pathContext.home, (isFollowedBySlash) => (isFollowedBySlash ? '~/' : '~'));
}

function patchedPathsOf(input: unknown): string[] {
  return isRecord(input) && isRecord(input.changes) ? Object.keys(input.changes) : [];
}

function humanizedToolName(name: string): string {
  const mcpMatch = MCP_TOOL_NAME.exec(name);
  if (!mcpMatch) return name;
  return `${mcpMatch[1]} ${mcpMatch[2]}`.replaceAll('_', ' ');
}

function shortTarget(rawTarget: string, pathContext: PathContext): string {
  return shortenedPaths(firstLineClipped(rawTarget), pathContext);
}

export function toolSummaryOf(name: string, input: unknown, pathContext: PathContext): ToolSummary {
  const toolKind = TOOL_KIND_BY_NAME.get(name);
  if (!toolKind) return { category: 'other', verb: humanizedToolName(name), target: shortTarget(anyStringOf(input), pathContext), filePaths: [] };
  const patchedPaths = patchedPathsOf(input).map((path) => shortTarget(path, pathContext));
  const target = patchedPaths.length > 0 ? patchedPaths.join(', ') : shortTarget(targetTextOf(input, toolKind.targetKeys), pathContext);
  if (toolKind.category !== 'edit') return { category: toolKind.category, verb: toolKind.verb, target, filePaths: [] };
  return { category: 'edit', verb: toolKind.verb, target, filePaths: patchedPaths.length > 0 ? patchedPaths : [target] };
}

function isJsonOutput(content: string): boolean {
  const trimmed = content.trim();
  if (!/^[[{"]/.test(trimmed)) return false;
  if (/^[[{]\s*["{[\]}]/.test(trimmed)) return true;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function outputExcerptOf(content: string): OutputExcerpt | null {
  if (isJsonOutput(content)) return null;
  const lines = content.replace(/\s+$/, '').split('\n');
  const firstLine = lines[0] ?? '';
  if (lines.length === 1 && firstLine.length === 0) return null;
  if (lines.length === 1) return { firstLine, hiddenLineCount: 0, lastLine: null };
  return { firstLine, hiddenLineCount: lines.length - 2, lastLine: lines[lines.length - 1] ?? '' };
}

function withFinalNewline(text: string): string {
  return text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
}

export function editToolInputOf(toolName: string, input: unknown): EditToolInput | null {
  if (!isRecord(input) || typeof input.file_path !== 'string') return null;
  if (toolName === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return { filePath: input.file_path, oldText: withFinalNewline(input.old_string), newText: withFinalNewline(input.new_string) };
  }
  if (toolName === 'Write' && typeof input.content === 'string') return { filePath: input.file_path, oldText: '', newText: withFinalNewline(input.content) };
  return null;
}

function isFailed(outcome: ChatToolOutcome): boolean {
  return outcome.status === 'done' && outcome.isError;
}

function isSucceeded(outcome: ChatToolOutcome): boolean {
  return outcome.status === 'done' && !outcome.isError;
}

export function isVisibleFailure(calls: readonly ChatToolCall[], callIndex: number): boolean {
  const call = calls[callIndex];
  if (!call || !isFailed(call.outcome)) return false;
  return !calls.slice(callIndex + 1).some((laterCall) => laterCall.name === call.name && isSucceeded(laterCall.outcome));
}

function countedPhrase(category: ToolCategory, calls: readonly ChatToolCall[]): string {
  const callsInCategory = calls.filter((call) => call.category === category);
  const count = category === 'edit' ? new Set(callsInCategory.flatMap((call) => call.filePaths)).size : callsInCategory.length;
  const words = COUNT_WORDS_BY_CATEGORY[category];
  return `${words.verb} ${count} ${count === 1 ? words.singular : words.plural}`;
}

export function groupSummaryOf(calls: readonly ChatToolCall[]): string {
  const categoriesInOrder = [...new Set(calls.map((call) => call.category))];
  const summary = categoriesInOrder.map((category) => countedPhrase(category, calls)).join(', ');
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}
