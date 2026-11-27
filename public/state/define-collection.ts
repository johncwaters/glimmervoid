import { createOptimisticStore, createRoot, createSignal, flush, runWithOwner } from 'solid-js';
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
  readonly [ADD_OPTIMISTIC_OVERLAY]: (updater: OptimisticDraftUpdater<State>) => () => void;
}

interface RegisteredCollection {
  applyServerMessage(message: ServerMessage): void;
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
  const activeOverlays: Array<{ id: number; updater: OptimisticDraftUpdater<State> }> = [];
  let handle!: CollectionHandle<State>;
  let disposeRoot = (): void => {};
  let bumpVersion = (): void => {};

  runWithOwner(null, () => {
    createRoot((dispose) => {
      disposeRoot = dispose;
      const [version, setVersion] = createSignal(0);
      bumpVersion = () => {
        setVersion((count) => count + 1);
      };
      const seed = structuredClone(initial);
      const [state] = createOptimisticStore<State>(
        () => {
          version();
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
        bumpVersion();
        return () => {
          const overlayIndex = activeOverlays.findIndex((entry) => entry.id === overlayId);
          if (overlayIndex === -1) return;
          activeOverlays.splice(overlayIndex, 1);
          bumpVersion();
        };
      };

      handle = {
        name,
        key,
        state,
        [ADD_OPTIMISTIC_OVERLAY]: addOverlay,
      };
    });
  });

  collectionsByName.set(name, {
    applyServerMessage(message: ServerMessage) {
      if (!apply) return;
      const helpers: CollectionHelpers<State> = {
        replace(nextState: State) {
          serverState = structuredClone(nextState);
        },
      };
      apply(serverState, message, helpers);
      bumpVersion();
      flush();
      onApplied?.(message);
    },
    dispose() {
      activeOverlays.length = 0;
      disposeRoot();
    },
  });

  return handle;
}

export function applyCollectionServerMessage(name: CollectionName, message: ServerMessage): boolean {
  const registered = collectionsByName.get(name);
  if (!registered) return false;
  registered.applyServerMessage(message);
  return true;
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
