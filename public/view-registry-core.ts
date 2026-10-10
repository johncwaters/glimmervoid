import type { FeatureSurfaceRule, FeatureSurfaceSettings } from './feature-surfaces-core.ts';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';

export type ViewAttention = boolean | string | null;
export type ViewRefreshReason = 'shown' | 'connected' | ServerMessage['type'];

export interface ViewAttentionSource {
  subscribe: (notify: (attention: ViewAttention) => void) => void;
  acknowledge: () => void;
}

export type ViewGate = { fromSettings: FeatureSurfaceRule } | { subscribe: (notify: (isAvailable: boolean) => void) => void };

export interface PrimaryViewDefinition<PanelElement> {
  view: string;
  label: string;
  glyph?: string | null;
  panelClass: string;
  tabOrder?: number;
  gate?: ViewGate;
  attention?: ViewAttentionSource;
  refreshOn?: readonly ViewRefreshReason[];
  refresh?: (reason: ViewRefreshReason) => void;
  mount: (panel: PanelElement) => void;
  activate?: () => void;
  deactivate?: () => void;
  onAvailabilityChange?: (isAvailable: boolean) => void;
  onConnectionChange?: (isConnected: boolean) => void;
  hasOwnPhoneScreen?: boolean;
  hasPanelChrome?: boolean;
  shouldHideReviewSidebar?: boolean;
}

export interface PrimaryView<PanelElement> extends PrimaryViewDefinition<PanelElement> {
  el: PanelElement;
}

export interface VisibleViewState {
  isPhoneShellActive: boolean;
  activeView: string;
  phoneScreen: string | null;
}

export function isPrimaryViewVisible(view: string, state: VisibleViewState): boolean {
  if (state.isPhoneShellActive) return state.phoneScreen === view;
  return state.activeView === view;
}

export function viewAvailabilityFromSettings<View extends { gate?: ViewGate }>(views: readonly View[], settings: FeatureSurfaceSettings) {
  return views.flatMap((view) => {
    if (!view.gate || !('fromSettings' in view.gate)) return [];
    return [{ view, isAvailable: view.gate.fromSettings(settings) }];
  });
}

export function viewAttentionState(attention: ViewAttention) {
  return { isActive: attention === true || typeof attention === 'string', level: typeof attention === 'string' ? attention : null };
}

export function viewsInTabOrder<View extends { tabOrder?: number }>(views: readonly View[]): View[] {
  return views.map((view, index) => ({ view, order: view.tabOrder ?? index }))
    .sort((left, right) => left.order - right.order)
    .map(({ view }) => view);
}

export function refreshViewOnReason(view: Pick<PrimaryViewDefinition<never>, 'refreshOn' | 'refresh'> | undefined, reason: ViewRefreshReason): void {
  if (!view?.refreshOn?.includes(reason)) return;
  view.refresh?.(reason);
}

export function refreshVisibleViews(views: readonly Pick<PrimaryViewDefinition<never>, 'view' | 'refreshOn' | 'refresh'>[], state: VisibleViewState, reason: ViewRefreshReason): void {
  for (const view of views) {
    if (!isPrimaryViewVisible(view.view, state)) continue;
    refreshViewOnReason(view, reason);
  }
}
