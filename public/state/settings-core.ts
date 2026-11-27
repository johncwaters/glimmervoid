import { isRecord } from '#shared/coerce.ts';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { withRepoRootsAdded } from '#shared/repo-roots.ts';
import { cloneValue } from '#shared/settings/registry-core.ts';
import type { SettingsPayload } from '../settings/settings-view-core.ts';
import type { CollectionHelpers } from './define-collection.ts';

export interface SettingsCollectionState {
  payload: SettingsPayload;
  serverRevision: number;
  optimisticRevision: number;
}

export const INITIAL_SETTINGS_STATE: SettingsCollectionState = {
  payload: {},
  serverRevision: 0,
  optimisticRevision: 0,
};

function mergeWorkflowRulesOptimistically(
  existingRules: unknown,
  incomingRules: unknown,
): unknown {
  if (!Array.isArray(existingRules) || !Array.isArray(incomingRules)) {
    return cloneValue(incomingRules);
  }
  const incomingById = new Map<string, Record<string, unknown>>();
  for (const entry of incomingRules) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue;
    incomingById.set(entry.id, entry);
  }
  if (incomingById.size === 0) return cloneValue(incomingRules);
  return existingRules.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return cloneValue(entry);
    const patch = incomingById.get(entry.id);
    if (!patch) return cloneValue(entry);
    return { ...(cloneValue(entry) as Record<string, unknown>), ...(cloneValue(patch) as Record<string, unknown>) };
  });
}

function mergeSettingsBlockOptimistically(
  key: string,
  existingValue: unknown,
  incomingValue: Record<string, unknown>,
): Record<string, unknown> {
  const base = isRecord(existingValue) ? cloneValue(existingValue) as Record<string, unknown> : {};
  const merged: Record<string, unknown> = { ...base, ...(cloneValue(incomingValue) as Record<string, unknown>) };
  if (key === 'workflows' && Object.hasOwn(incomingValue, 'rules')) {
    merged.rules = mergeWorkflowRulesOptimistically(base.rules, incomingValue.rules);
  }
  return merged;
}

export function applySettingsServerMessage(
  draft: SettingsCollectionState,
  message: ServerMessage,
  helpers: CollectionHelpers<SettingsCollectionState>,
): void {
  if (message.type !== 'settings-updated' && message.type !== 'settings') return;
  if (!isRecord(message.settings)) return;
  const nextPayload = cloneValue(message.settings) as SettingsPayload;
  if (
    draft.serverRevision > 0
    && draft.optimisticRevision === 0
    && JSON.stringify(draft.payload) === JSON.stringify(nextPayload)
  ) {
    return;
  }
  helpers.replace({
    payload: nextPayload,
    serverRevision: draft.serverRevision + 1,
    optimisticRevision: 0,
  });
}

export function applyOptimisticSettingsPatch(
  draft: SettingsCollectionState,
  patch: SettingsPayload,
): void {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  for (const [key, value] of entries) {
    if (isRecord(value)) {
      draft.payload[key] = mergeSettingsBlockOptimistically(key, draft.payload[key], value);
      continue;
    }
    draft.payload[key] = cloneValue(value);
  }
  draft.optimisticRevision += 1;
}

export function applyOptimisticAddedRepoRoots(
  draft: SettingsCollectionState,
  addedRoots: readonly string[],
): void {
  const existingRoots = Array.isArray(draft.payload.repoRoots)
    ? draft.payload.repoRoots.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const nextRoots = withRepoRootsAdded(existingRoots, addedRoots);
  if (!nextRoots) return;
  draft.payload.repoRoots = nextRoots;
  draft.optimisticRevision += 1;
}
