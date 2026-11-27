import { createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { getJSON, getString } from '../local-store.ts';
import { subscribeTrace, traceSnapshot } from '../trace-store.ts';
import {
  getActiveView,
  getFocusLayout,
  getSessionView,
  getThemeId,
  isChatBriefOff,
  isNotificationsEnabled,
  isSoundEnabled,
} from '../ui-prefs.ts';

const UI_PREFS_STORAGE_KEY = 'glimmervoid-ui-prefs';
const CONNECTION_STATUS_ID = 'connection-status';
const CONNECTION_LABEL_SELECTOR = '.connection-label';

const UI_PREF_READERS = {
  activeView: getActiveView,
  focusLayout: getFocusLayout,
  isChatBriefOff,
  notificationsEnabled: isNotificationsEnabled,
  sessionView: getSessionView,
  soundEnabled: isSoundEnabled,
  themeId: getThemeId,
} as const;

export type UiPrefKey = keyof typeof UI_PREF_READERS;
type UiPrefValue<Key extends UiPrefKey> = ReturnType<(typeof UI_PREF_READERS)[Key]>;
export type TraceSnapshot = ReturnType<typeof traceSnapshot>;

export interface ControlConnectionState {
  state: string;
  label: string;
  isConnected: boolean;
}

const traceListeners = new Set<() => void>();
let isTraceBridgeAttached = false;

function listenToTraceStore(notify: () => void): () => void {
  if (!isTraceBridgeAttached) {
    isTraceBridgeAttached = true;
    subscribeTrace(() => {
      for (const listener of [...traceListeners]) listener();
    });
  }
  traceListeners.add(notify);
  return () => {
    traceListeners.delete(notify);
  };
}

function listenToStorageKey(storageKey: string, notify: () => void): () => void {
  const handleStorageEvent = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== storageKey) return;
    notify();
  };
  window.addEventListener('storage', handleStorageEvent);
  return () => {
    window.removeEventListener('storage', handleStorageEvent);
  };
}

function readControlConnectionState(): ControlConnectionState {
  const statusEl = document.getElementById(CONNECTION_STATUS_ID);
  const state = statusEl?.dataset.state ?? 'disconnected';
  const label = statusEl?.querySelector(CONNECTION_LABEL_SELECTOR)?.textContent ?? '';
  return {
    state,
    label,
    isConnected: state === 'connected',
  };
}

function listenToControlConnection(notify: () => void): () => void {
  const statusEl = document.getElementById(CONNECTION_STATUS_ID);
  if (!statusEl) return () => {};
  const observer = new MutationObserver(() => notify());
  observer.observe(statusEl, {
    attributes: true,
    attributeFilter: ['data-state'],
    childList: true,
    characterData: true,
    subtree: true,
  });
  return () => {
    observer.disconnect();
  };
}

function createExternalSignal<Value>(readValue: () => Value, attach: (notify: () => void) => () => void): Accessor<Value> {
  const [box, setBox] = createSignal({ current: readValue() });
  const detach = attach(() => {
    const nextValue = readValue();
    setBox((previous) => (Object.is(previous.current, nextValue) ? previous : { current: nextValue }));
  });
  onCleanup(detach);
  return () => box().current;
}

export function localJsonSignal<Value>(key: string, fallback: Value): Accessor<Value> {
  return createExternalSignal(
    () => getJSON(key, fallback),
    (notify) => listenToStorageKey(key, notify),
  );
}

export function localStringSignal(key: string): Accessor<string> {
  return createExternalSignal(
    () => getString(key),
    (notify) => listenToStorageKey(key, notify),
  );
}

export function uiPrefSignal<Key extends UiPrefKey>(key: Key): Accessor<UiPrefValue<Key>> {
  const readPref = UI_PREF_READERS[key] as () => UiPrefValue<Key>;
  return createExternalSignal(
    readPref,
    (notify) => listenToStorageKey(UI_PREFS_STORAGE_KEY, notify),
  );
}

export function traceStateSignal(): Accessor<TraceSnapshot> {
  return createExternalSignal(traceSnapshot, listenToTraceStore);
}

export function controlConnectionSignal(): Accessor<ControlConnectionState> {
  return createExternalSignal(readControlConnectionState, listenToControlConnection);
}
