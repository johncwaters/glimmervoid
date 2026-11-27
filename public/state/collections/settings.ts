import { createEffect, createRoot, flush, runWithOwner } from 'solid-js';
import { isRecord } from '#shared/coerce.ts';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { cloneValue } from '#shared/settings/registry-core.ts';
import type { SettingsPayload } from '../../settings/settings-view-core.ts';
import { applyCollectionServerMessage, defineCollection } from '../define-collection.ts';
import {
  INITIAL_SETTINGS_STATE,
  applySettingsServerMessage,
} from '../settings-core.ts';
import type { SettingsCollectionState } from '../settings-core.ts';

type SettingsServerMessageListener = (message: ServerMessage) => void;
type SettingsPayloadListener = () => void;

const serverMessageListeners = new Set<SettingsServerMessageListener>();
const payloadListeners = new Set<SettingsPayloadListener>();

function notifyServerMessageListeners(message: ServerMessage): void {
  for (const listener of [...serverMessageListeners]) {
    listener(message);
  }
}

function notifyPayloadListeners(): void {
  for (const listener of [...payloadListeners]) {
    listener();
  }
}

const settingsCollection = defineCollection<SettingsCollectionState>({
  name: 'settings',
  key: null,
  initial: INITIAL_SETTINGS_STATE,
  apply: applySettingsServerMessage,
  onApplied: notifyServerMessageListeners,
});

let hasMountedSettingsEffect = false;

runWithOwner(null, () => {
  createRoot(() => {
    createEffect(
      () => `${settingsCollection.state.serverRevision}:${settingsCollection.state.optimisticRevision}`,
      () => {
        if (!hasMountedSettingsEffect) {
          hasMountedSettingsEffect = true;
          return;
        }
        notifyPayloadListeners();
      },
    );
  });
});
flush();

export function settingsPayloadSnapshot(): SettingsPayload {
  return cloneValue(settingsCollection.state.payload) as SettingsPayload;
}

export function seedSettingsPayload(freshSettings: unknown): void {
  if (!isRecord(freshSettings)) return;
  applyCollectionServerMessage('settings', {
    type: 'settings',
    settings: cloneValue(freshSettings) as SettingsPayload,
  } as ServerMessage);
}

export function patchSettingsPayload(patch: SettingsPayload): SettingsPayload {
  const nextPayload = { ...settingsPayloadSnapshot(), ...(cloneValue(patch) as SettingsPayload) };
  seedSettingsPayload(nextPayload);
  return settingsPayloadSnapshot();
}

export function onSettingsPayloadChanged(listener: SettingsPayloadListener): () => void {
  payloadListeners.add(listener);
  return () => {
    payloadListeners.delete(listener);
  };
}

export function onSettingsServerMessage(listener: SettingsServerMessageListener): () => void {
  serverMessageListeners.add(listener);
  return () => {
    serverMessageListeners.delete(listener);
  };
}

export default settingsCollection;
