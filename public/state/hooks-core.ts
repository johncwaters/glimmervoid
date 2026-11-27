import { isRecord } from '#shared/coerce.ts';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { cloneValue } from '#shared/settings/registry-core.ts';
import type { HookRecord, HooksReport } from '../hooks-view-core.ts';
import type { CollectionHelpers } from './define-collection.ts';

export const OPTIMISTIC_HOOK_ID_PREFIX = 'optimistic-hook-';

export function isOptimisticHookId(hookId: string): boolean {
  return hookId.startsWith(OPTIMISTIC_HOOK_ID_PREFIX);
}

export interface HooksCollectionState {
  report: HooksReport | null;
  updatedCount: number | null;
  serverRevision: number;
  optimisticRevision: number;
}

export const INITIAL_HOOKS_STATE: HooksCollectionState = {
  report: null,
  updatedCount: null,
  serverRevision: 0,
  optimisticRevision: 0,
};

export function shouldApplyHooksReport(message: unknown, awaitedRequestId: string | null): boolean {
  if (!isRecord(message)) return false;
  const requestId = message.requestId;
  if (typeof requestId !== 'string' || !awaitedRequestId) return true;
  return requestId === awaitedRequestId;
}

function toHookRecord(hookInput: Record<string, unknown>, fallbackId: string): HookRecord {
  const id = typeof hookInput.id === 'string' && hookInput.id.length > 0 ? hookInput.id : fallbackId;
  const record: HookRecord = {
    id,
    name: typeof hookInput.name === 'string' ? hookInput.name : '',
    event: typeof hookInput.event === 'string' ? hookInput.event : '',
    type: typeof hookInput.type === 'string' ? hookInput.type : 'command',
    enabled: hookInput.enabled !== false,
  };
  if (typeof hookInput.matcher === 'string' && hookInput.matcher.length > 0) record.matcher = hookInput.matcher;
  if (typeof hookInput.command === 'string' && hookInput.command.length > 0) record.command = hookInput.command;
  if (typeof hookInput.url === 'string' && hookInput.url.length > 0) record.url = hookInput.url;
  if (typeof hookInput.timeout === 'number' && Number.isInteger(hookInput.timeout) && hookInput.timeout > 0) {
    record.timeout = hookInput.timeout;
  }
  if (Array.isArray(hookInput.projects)) {
    record.projects = hookInput.projects.filter((entry): entry is string => typeof entry === 'string');
  }
  return record;
}

function upsertHookInReport(report: HooksReport, nextHook: HookRecord): void {
  const existingHooks = Array.isArray(report.hooks) ? [...report.hooks] : [];
  const existingIndex = existingHooks.findIndex((entry) => isRecord(entry) && entry.id === nextHook.id);
  if (existingIndex >= 0) {
    existingHooks[existingIndex] = nextHook;
    report.hooks = existingHooks;
    return;
  }
  existingHooks.push(nextHook);
  report.hooks = existingHooks;
}

function removeHookFromReport(report: HooksReport, hookId: string): void {
  if (!Array.isArray(report.hooks)) return;
  report.hooks = report.hooks.filter((entry) => !isRecord(entry) || entry.id !== hookId);
}

export function applyHooksServerMessage(
  draft: HooksCollectionState,
  message: ServerMessage,
  helpers: CollectionHelpers<HooksCollectionState>,
): void {
  if (message.type === 'hooks-updated') {
    draft.updatedCount = message.count;
    draft.serverRevision += 1;
    return;
  }
  if (message.type === 'hooks-report') {
    const clonedReport = cloneValue(message) as HooksReport;
    helpers.replace({
      report: clonedReport,
      updatedCount: Array.isArray(clonedReport.hooks) ? clonedReport.hooks.length : draft.updatedCount,
      serverRevision: draft.serverRevision + 1,
      optimisticRevision: 0,
    });
    return;
  }
  if (message.type === 'save-hook-result') {
    if (!message.ok || !isRecord(message.hook) || typeof message.hook.id !== 'string') return;
    if (!draft.report || typeof draft.report.error === 'string') return;
    upsertHookInReport(draft.report, toHookRecord(cloneValue(message.hook) as Record<string, unknown>, message.hook.id));
    draft.updatedCount = Array.isArray(draft.report.hooks) ? draft.report.hooks.length : draft.updatedCount;
    draft.serverRevision += 1;
    return;
  }
  if (message.type === 'delete-hook-result') {
    if (!message.ok || typeof message.id !== 'string') return;
    if (!draft.report || typeof draft.report.error === 'string') return;
    removeHookFromReport(draft.report, message.id);
    draft.updatedCount = Array.isArray(draft.report.hooks) ? draft.report.hooks.length : draft.updatedCount;
    draft.serverRevision += 1;
  }
}

export function applyOptimisticHookSave(
  draft: HooksCollectionState,
  hookInput: Record<string, unknown>,
  tempId: string,
): void {
  if (!draft.report || typeof draft.report.error === 'string') return;
  upsertHookInReport(draft.report, toHookRecord(cloneValue(hookInput) as Record<string, unknown>, tempId));
  draft.optimisticRevision += 1;
}

export function applyOptimisticHookDelete(
  draft: HooksCollectionState,
  hookId: string,
): void {
  if (!draft.report || typeof draft.report.error === 'string') return;
  removeHookFromReport(draft.report, hookId);
  draft.optimisticRevision += 1;
}
