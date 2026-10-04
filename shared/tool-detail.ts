export const TOOL_DETAIL_MAX_CHARS = 160;

const DETAIL_FIELD_BY_TOOL: Readonly<Record<string, string>> = Object.freeze({
  Bash: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'pattern',
  Glob: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  Task: 'description',
  Agent: 'description',
  Skill: 'skill',
});

export function firstDetailLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (line.length <= TOOL_DETAIL_MAX_CHARS) return line;
  return `${line.slice(0, TOOL_DETAIL_MAX_CHARS - 3)}...`;
}

export function toolDetailFieldValue(toolName: string, toolInput: unknown): string | null {
  const field = DETAIL_FIELD_BY_TOOL[toolName];
  if (!field) return null;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;
  const value = (toolInput as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

export function toolDetailLine(toolName: string, toolInput: unknown): string {
  const fieldValue = toolDetailFieldValue(toolName, toolInput);
  return fieldValue === null ? '' : firstDetailLine(fieldValue);
}
