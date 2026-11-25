import { parseJsonOrNull } from '#shared/coerce.ts';

export type TaskState = 'pending' | 'running' | 'done';
export type TaskItem = { text: string; state: TaskState };

const MAX_TASK_ITEMS = 50;
const MAX_TASK_TEXT_CHARS = 300;
const LIST_FIELD_BY_TOOL_NAME: Readonly<Record<string, string>> = { todowrite: 'todos', todolist: 'todos', update_steps: 'steps' };
const TEXT_FIELDS = ['content', 'title', 'step', 'text'];
const STATE_BY_STATUS: Readonly<Record<string, TaskState>> = { pending: 'pending', todo: 'pending', in_progress: 'running', 'in-progress': 'running', running: 'running', completed: 'done', complete: 'done', done: 'done' };

function listOf(input: unknown, field: string): unknown[] | null {
  if (typeof input !== 'object' || input === null) return null;
  const value: unknown = Reflect.get(input, field);
  const parsed: unknown = typeof value === 'string' ? parseJsonOrNull(value) : value;
  return Array.isArray(parsed) ? parsed : null;
}

function taskItemOf(entry: unknown): TaskItem | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const text = TEXT_FIELDS.map((field) => Reflect.get(entry, field)).find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const status: unknown = Reflect.get(entry, 'status');
  if (text === undefined || typeof status !== 'string') return null;
  return { text: text.trim().slice(0, MAX_TASK_TEXT_CHARS), state: STATE_BY_STATUS[status.toLowerCase()] ?? 'pending' };
}

export function taskListOf(toolName: string, input: unknown): TaskItem[] | null {
  const field = LIST_FIELD_BY_TOOL_NAME[toolName.toLowerCase()];
  if (field === undefined) return null;
  const entries = listOf(input, field);
  if (entries === null) return null;
  return entries.slice(0, MAX_TASK_ITEMS).flatMap((entry) => {
    const item = taskItemOf(entry);
    return item === null ? [] : [item];
  });
}
