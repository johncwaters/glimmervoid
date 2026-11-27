import { createOptimisticStore, createRoot, createSignal, flush, runWithOwner, untrack } from 'solid-js';
import type { Store } from 'solid-js';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import type { CollectionName } from '#shared/contracts/control/message-classes.ts';

export type CollectionKey = string | ((item: unknown) => unknown) | null;

export interface CollectionHelpers<State extends object = object> {
  replace(nextState: State): void;
}

export interface CollectionOptions<State extends object> {
  name: CollectionName;
  key?: CollectionKey;
  initial: State;
  apply?: (draft: State, message: ServerMessage, helpers: CollectionHelpers<State>) => void;
  onApplied?: (message: ServerMessage) => void;
}

export type OptimisticDraftUpdater<State extends object> = (draft: State) => void;

const ADD_OPTIMISTIC_OVERLAY = Symbol('addOptimisticOverlay');

export interface CollectionHandle<State extends object> {
  readonly name: CollectionName;
  readonly key: CollectionKey;
  readonly state: Store<State>;
  readonly overlayVersion: () => number;
  readonly [ADD_OPTIMISTIC_OVERLAY]: (updater: OptimisticDraftUpdater<State>) => () => void;
}

interface RegisteredCollection {
  applyServerMessageWithoutNotify(message: ServerMessage): void;
  notifyApplied(message: ServerMessage): void;
  notifyChanged(): void;
  addChangeListener(listener: () => void): () => void;
  dispose(): void;
}

const collectionsByName = new Map<CollectionName, RegisteredCollection>();

export function defineCollection<State extends object>({
  name,
  key = 'id',
  initial,
  apply,
  onApplied,
}: CollectionOptions<State>): CollectionHandle<State> {
  if (collectionsByName.has(name)) {
    throw new Error(`Collection "${name}" is already defined.`);
  }

  let serverState = structuredClone(initial);
  let nextOverlayId = 1;
  let currentVersion = 0;
  let appliedVersion = 0;
  let hasPendingDeferredNotify = false;
  const activeOverlays: Array<{ id: number; updater: OptimisticDraftUpdater<State> }> = [];
  const changeListeners = new Set<() => void>();
  let handle!: CollectionHandle<State>;
  let disposeRoot = (): void => {};
  let bumpVersion = (): void => {};
  let bumpOverlayVersion = (): void => {};

  const notifyChanged = (): void => {
    for (const listener of [...changeListeners]) {
      if (!changeListeners.has(listener)) continue;
      listener();
    }
  };

  const notifyAfterFlush = (): void => {
    if (appliedVersion === currentVersion) {
      notifyChanged();
      return;
    }
    if (hasPendingDeferredNotify) return;
    hasPendingDeferredNotify = true;
    queueMicrotask(() => {
      hasPendingDeferredNotify = false;
      if (!collectionsByName.has(name)) return;
      flush();
      notifyChanged();
    });
  };

  const removeOverlayEntry = (overlayId: number): boolean => {
    const overlayIndex = activeOverlays.findIndex((entry) => entry.id === overlayId);
    if (overlayIndex === -1) return false;
    activeOverlays.splice(overlayIndex, 1);
    bumpOverlayVersion();
    bumpVersion();
    return true;
  };

  runWithOwner(null, () => {
    createRoot((dispose) => {
      disposeRoot = dispose;
      const [version, setVersion] = createSignal(0);
      const [overlayVersion, setOverlayVersion] = createSignal(0);
      bumpVersion = () => {
        currentVersion += 1;
        setVersion(currentVersion);
      };
      bumpOverlayVersion = () => {
        setOverlayVersion((count) => count + 1);
      };
      const seed = structuredClone(initial);
      const [state] = createOptimisticStore<State>(
        () => {
          appliedVersion = version();
          const nextState = structuredClone(serverState);
          for (const overlay of activeOverlays) {
            overlay.updater(nextState);
          }
          return nextState;
        },
        seed as never,
        { key },
      );

      const addOverlay = (updater: OptimisticDraftUpdater<State>): (() => void) => {
        const overlayId = nextOverlayId;
        nextOverlayId += 1;
        activeOverlays.push({ id: overlayId, updater });
        bumpOverlayVersion();
        bumpVersion();
        try {
          flush();
          notifyAfterFlush();
        } catch (error) {
          if (removeOverlayEntry(overlayId)) flush();
          throw error;
        }
        return () => {
          if (!removeOverlayEntry(overlayId)) return;
          flush();
          notifyAfterFlush();
        };
      };

      handle = {
        name,
        key,
        state,
        overlayVersion,
        [ADD_OPTIMISTIC_OVERLAY]: addOverlay,
      };
    });
  });

  collectionsByName.set(name, {
    applyServerMessageWithoutNotify(message: ServerMessage) {
      if (!apply) return;
      const helpers: CollectionHelpers<State> = {
        replace(nextState: State) {
          serverState = structuredClone(nextState);
        },
      };
      apply(serverState, message, helpers);
      bumpVersion();
    },
    notifyApplied(message: ServerMessage) {
      onApplied?.(message);
    },
    notifyChanged: notifyAfterFlush,
    addChangeListener(listener: () => void) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    dispose() {
      changeListeners.clear();
      activeOverlays.length = 0;
      disposeRoot();
    },
  });

  return handle;
}

export function applyCollectionServerMessage(name: CollectionName, message: ServerMessage): boolean {
  const registered = collectionsByName.get(name);
  if (!registered) return false;
  registered.applyServerMessageWithoutNotify(message);
  flush();
  registered.notifyApplied(message);
  registered.notifyChanged();
  return true;
}

export function applyCollectionServerMessages(
  names: readonly CollectionName[],
  message: ServerMessage,
): { appliedCount: number; totalCount: number } {
  const applied: RegisteredCollection[] = [];
  for (const name of names) {
    const registered = collectionsByName.get(name);
    if (!registered) continue;
    registered.applyServerMessageWithoutNotify(message);
    applied.push(registered);
  }
  if (applied.length > 0) flush();
  for (const registered of applied) {
    registered.notifyApplied(message);
    registered.notifyChanged();
  }
  return { appliedCount: applied.length, totalCount: names.length };
}

export function watchCollection<State extends object, Selected>(
  handle: CollectionHandle<State>,
  select: (state: Store<State>) => Selected,
  listener: (value: Selected, previousValue: Selected) => void,
  isEqual: (previous: Selected, next: Selected) => boolean = Object.is,
): () => void {
  const registered = collectionsByName.get(handle.name);
  if (!registered) {
    throw new Error(`Collection "${handle.name}" is not registered.`);
  }
  let previousValue = untrack(() => select(handle.state));
  return registered.addChangeListener(() => {
    const nextValue = untrack(() => select(handle.state));
    if (isEqual(previousValue, nextValue)) return;
    const priorValue = previousValue;
    previousValue = nextValue;
    listener(nextValue, priorValue);
  });
}

export function addCollectionOptimisticOverlay<State extends object>(
  handle: CollectionHandle<State>,
  updater: OptimisticDraftUpdater<State>,
): () => void {
  if (!collectionsByName.has(handle.name)) {
    throw new Error(`Collection "${handle.name}" is not registered.`);
  }
  return handle[ADD_OPTIMISTIC_OVERLAY](updater);
}

export function unregisterCollection(name: CollectionName): void {
  const registered = collectionsByName.get(name);
  if (!registered) return;
  collectionsByName.delete(name);
  registered.dispose();
}
