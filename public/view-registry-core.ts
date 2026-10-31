import type { FeatureSurfaceRule, FeatureSurfaceSettings } from './feature-surfaces-core.ts';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';

export type ViewAttention = boolean | string | null;
export type ViewRefreshReason = 'shown' | 'connected' | ServerMessage['type'];

interface ViewAttentionSource {
  subscribe: (notify: (attention: ViewAttention) => void) => void;
  acknowledge: () => void;
}

type ViewGate = { fromSettings: FeatureSurfaceRule } | { subscribe: (notify: (isAvailable: boolean) => void) => void };

export interface ViewModule<PanelElement> {
  mount(panel: PanelElement): void;
  refresh?(reason: ViewRefreshReason): void;
  activate?(): void;
  deactivate?(): void;
}

type RefreshableViewModule = Pick<ViewModule<never>, 'refresh'>;

type ViewSource<PanelElement> =
  | { module: ViewModule<PanelElement>; load?: never }
  | { load: () => Promise<ViewModule<PanelElement>>; module?: never };

interface ViewDefinitionFields {
  view: string;
  label: string;
  iconPath: string;
  panelClass: string;
  gate?: ViewGate;
  attention?: ViewAttentionSource;
  refreshOn?: readonly ViewRefreshReason[];
  onAvailabilityChange?: (isAvailable: boolean) => void;
  onConnectionChange?: (isConnected: boolean) => void;
  hasOwnPhoneScreen?: boolean;
  isPhoneNavScreen?: boolean;
  hasPanelChrome?: boolean;
  hasReviewSidebar?: boolean;
}

export type PrimaryViewDefinition<PanelElement> = ViewDefinitionFields & ViewSource<PanelElement>;

export type PrimaryView<PanelElement> = PrimaryViewDefinition<PanelElement> & { el: PanelElement };

interface VisibleViewState {
  isPhoneShellActive: boolean;
  activeView: string;
  phoneScreen: string | null;
}

function isPrimaryViewVisible(view: string, state: VisibleViewState): boolean {
  if (state.isPhoneShellActive) return state.phoneScreen === view;
  return state.activeView === view;
}

export function viewAvailabilityFromSettings<View extends { gate?: ViewGate }>(views: readonly View[], settings: FeatureSurfaceSettings) {
  return views.flatMap((view) => {
    if (!view.gate || !('fromSettings' in view.gate)) return [];
    return [{ view, isAvailable: view.gate.fromSettings(settings) }];
  });
}

export function orderViewIds(defaultViewIds: readonly string[], savedViewIds: readonly string[] | null | undefined): string[] {
  const knownViewIds = new Set(defaultViewIds);
  const savedKnownViewIds = [...new Set((savedViewIds ?? []).filter((viewId) => knownViewIds.has(viewId)))];
  return [...savedKnownViewIds, ...defaultViewIds.filter((viewId) => !savedKnownViewIds.includes(viewId))];
}

export function moveViewId(orderedViewIds: readonly string[], movedViewId: string, targetIndex: number): string[] {
  const remainingViewIds = orderedViewIds.filter((viewId) => viewId !== movedViewId);
  if (remainingViewIds.length === orderedViewIds.length) return [...orderedViewIds];
  const insertionIndex = Math.max(0, Math.min(targetIndex, remainingViewIds.length));
  return [...remainingViewIds.slice(0, insertionIndex), movedViewId, ...remainingViewIds.slice(insertionIndex)];
}

export function viewAttentionState(attention: ViewAttention) {
  return { isActive: attention === true || typeof attention === 'string', level: typeof attention === 'string' ? attention : null };
}

export function refreshViewOnReason(view: Pick<ViewDefinitionFields, 'refreshOn'> | undefined, mountedModule: RefreshableViewModule | null, reason: ViewRefreshReason): void {
  if (!mountedModule || !view?.refreshOn?.includes(reason)) return;
  mountedModule.refresh?.(reason);
}

export function refreshVisibleViews(views: readonly Pick<ViewDefinitionFields, 'view' | 'refreshOn'>[], state: VisibleViewState, reason: ViewRefreshReason, mountedModuleOf: (view: string) => RefreshableViewModule | null): void {
  for (const view of views) {
    if (!isPrimaryViewVisible(view.view, state)) continue;
    refreshViewOnReason(view, mountedModuleOf(view.view), reason);
  }
}

type LoadableView<PanelElement> = Pick<ViewDefinitionFields, 'view'> & ViewSource<PanelElement> & { el: PanelElement };

export function createViewLoader<PanelElement>() {
  const mountedModuleByView = new Map<string, ViewModule<PanelElement>>();
  const pendingLoadByView = new Map<string, Promise<ViewModule<PanelElement>>>();

  function loadModule(view: LoadableView<PanelElement>, load: () => Promise<ViewModule<PanelElement>>): Promise<ViewModule<PanelElement>> {
    const pendingLoad = pendingLoadByView.get(view.view);
    if (pendingLoad) return pendingLoad;
    const startedLoad = load().catch((error: unknown) => {
      pendingLoadByView.delete(view.view);
      throw error;
    });
    pendingLoadByView.set(view.view, startedLoad);
    return startedLoad;
  }

  function mountOnce(view: LoadableView<PanelElement>, module: ViewModule<PanelElement>): ViewModule<PanelElement> {
    const mountedModule = mountedModuleByView.get(view.view);
    if (mountedModule) return mountedModule;
    module.mount(view.el);
    mountedModuleByView.set(view.view, module);
    return module;
  }

  function mountedModuleOf(view: string): ViewModule<PanelElement> | null {
    return mountedModuleByView.get(view) ?? null;
  }

  function show(view: LoadableView<PanelElement>): Promise<ViewModule<PanelElement>> {
    const mountedModule = mountedModuleByView.get(view.view);
    if (mountedModule) return Promise.resolve(mountedModule);
    if (view.module) return Promise.resolve(mountOnce(view, view.module));
    return loadModule(view, view.load).then((module) => mountOnce(view, module));
  }

  function mountEagerViews(views: readonly LoadableView<PanelElement>[]): void {
    for (const view of views) {
      if (view.module) mountOnce(view, view.module);
    }
  }

  async function prefetch(views: readonly LoadableView<PanelElement>[]): Promise<void> {
    for (const view of views) {
      if (!view.load || mountedModuleByView.has(view.view)) continue;
      await loadModule(view, view.load);
    }
  }

  return { show, mountedModuleOf, mountEagerViews, prefetch };
}

export function shouldReloadAfterPreloadError(storedReloadAtMs: string | null, nowMs: number, reloadWindowMs: number): boolean {
  const lastReloadAtMs = Number(storedReloadAtMs);
  if (!storedReloadAtMs || !Number.isFinite(lastReloadAtMs)) return true;
  return nowMs - lastReloadAtMs > reloadWindowMs;
}
