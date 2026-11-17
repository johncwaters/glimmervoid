const MAIN_INPUT_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'cmd'] as const;
const MAX_MAIN_INPUT_CHARS = 240;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clipped(text: string): string {
  const firstLine = text.split('\n', 1)[0] ?? '';
  return firstLine.length > MAX_MAIN_INPUT_CHARS ? firstLine.slice(0, MAX_MAIN_INPUT_CHARS) : firstLine;
}

export function mainInputOf(input: unknown): string {
  if (typeof input === 'string') return clipped(input);
  if (!isRecord(input)) return '';
  for (const key of MAIN_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return clipped(value);
  }
  const firstText = Object.values(input).find((value): value is string => typeof value === 'string' && value.length > 0);
  return firstText === undefined ? '' : clipped(firstText);
}

export function outputExcerptOf(content: string): OutputExcerpt | null {
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
