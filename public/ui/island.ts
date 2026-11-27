import { render } from '@solidjs/web';
import type { JSX } from '@solidjs/web';

type WatchRoot = Document | ShadowRoot;
type IslandLifecycle = 'pending' | 'connected' | 'disposed';

interface MountedIslandEntry {
  host: HTMLElement;
  lifecycle: IslandLifecycle;
  rootNode: WatchRoot;
  unregister: () => void;
  dispose: () => void;
}

interface RootIslandWatch {
  rootNode: WatchRoot;
  observer: MutationObserver;
  entries: Set<MountedIslandEntry>;
}

const watchesByRoot = new WeakMap<WatchRoot, RootIslandWatch>();

function watchRootOf(host: HTMLElement): WatchRoot {
  const root = host.getRootNode();
  if (root instanceof ShadowRoot || root instanceof Document) return root;
  return host.ownerDocument;
}

function observeTargetOf(rootNode: WatchRoot): Node | null {
  if (rootNode instanceof Document) return rootNode.documentElement ?? rootNode.body;
  return rootNode;
}

function wasHostAddedInRecords(host: HTMLElement, records: readonly MutationRecord[]): boolean {
  for (const record of records) {
    for (const addedNode of record.addedNodes) {
      if (addedNode === host || addedNode.contains(host)) return true;
    }
  }
  return false;
}

function sweepDisconnectedIslands(watch: RootIslandWatch, records: readonly MutationRecord[]): void {
  for (const entry of [...watch.entries]) {
    if (entry.lifecycle === 'disposed') continue;
    if (entry.lifecycle === 'pending' && wasHostAddedInRecords(entry.host, records)) {
      entry.lifecycle = 'connected';
    }
    if (entry.host.isConnected) {
      entry.lifecycle = 'connected';
      const nextRoot = watchRootOf(entry.host);
      if (nextRoot !== entry.rootNode) {
        entry.unregister();
        entry.rootNode = nextRoot;
        entry.unregister = registerIslandWatch(nextRoot, entry);
      }
      continue;
    }
    if (entry.lifecycle === 'connected') entry.dispose();
  }
}

function registerIslandWatch(rootNode: WatchRoot, entry: MountedIslandEntry): () => void {
  let watch = watchesByRoot.get(rootNode);
  if (!watch) {
    const entries = new Set<MountedIslandEntry>();
    const createdWatch: RootIslandWatch = {
      rootNode,
      observer: new MutationObserver((records) => sweepDisconnectedIslands(createdWatch, records)),
      entries,
    };
    const observeTarget = observeTargetOf(rootNode);
    if (observeTarget) createdWatch.observer.observe(observeTarget, { childList: true, subtree: true });
    watchesByRoot.set(rootNode, createdWatch);
    watch = createdWatch;
  }
  watch.entries.add(entry);

  return () => {
    const currentWatch = watchesByRoot.get(rootNode);
    if (!currentWatch) return;
    currentWatch.entries.delete(entry);
    if (currentWatch.entries.size > 0) return;
    currentWatch.observer.disconnect();
    watchesByRoot.delete(rootNode);
  };
}

interface MountIslandOptions {
  lifecycleHost?: HTMLElement;
}

export function mountIsland(
  host: HTMLElement,
  renderRoot: () => JSX.Element,
  options?: MountIslandOptions,
): () => void {
  const watchedHost = options?.lifecycleHost ?? host;
  const initialLifecycle: IslandLifecycle = watchedHost.isConnected ? 'connected' : 'pending';
  const disposeSolid = render(renderRoot, host);

  if (initialLifecycle === 'connected' && !watchedHost.isConnected) {
    disposeSolid();
    return () => {};
  }

  const rootNode = watchRootOf(watchedHost);
  const entry: MountedIslandEntry = {
    host: watchedHost,
    lifecycle: watchedHost.isConnected ? 'connected' : initialLifecycle,
    rootNode,
    unregister: () => {},
    dispose: () => {},
  };

  const dispose = (): void => {
    if (entry.lifecycle === 'disposed') return;
    entry.lifecycle = 'disposed';
    entry.unregister();
    disposeSolid();
  };

  entry.dispose = dispose;
  entry.unregister = registerIslandWatch(rootNode, entry);

  return dispose;
}
