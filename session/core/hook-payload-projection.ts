import { isRecord } from "../../shared/coerce.ts";
import type { HookPayload } from '../../shared/contracts/index.ts';

const DROPPED_PAYLOAD_FIELDS = new Set(['last_assistant_message', 'lastAssistantMessage']);
const REDUCED_TASK_LIST_FIELDS = ['background_tasks', 'backgroundTasks'] as const;
const RETAINED_TASK_FIELDS = ['id', 'type', 'status'] as const;

function projectBackgroundTask(task: unknown): Record<string, unknown> {
  if (!isRecord(task)) return {};
  const projectedTask: Record<string, unknown> = {};
  for (const field of RETAINED_TASK_FIELDS) {
    if (!Object.hasOwn(task, field)) continue;
    projectedTask[field] = task[field];
  }
  return projectedTask;
}

function projectHookPayload(payload: HookPayload | null | undefined): HookPayload | null {
  if (!payload) return null;
  const projectedPayload: HookPayload = {};
  for (const [field, value] of Object.entries(payload)) {
    if (DROPPED_PAYLOAD_FIELDS.has(field)) continue;
    projectedPayload[field] = value;
  }
  for (const field of REDUCED_TASK_LIST_FIELDS) {
    const tasks = projectedPayload[field];
    if (!Array.isArray(tasks)) continue;
    projectedPayload[field] = tasks.map(projectBackgroundTask);
  }
  return projectedPayload;
}

export { projectHookPayload };
