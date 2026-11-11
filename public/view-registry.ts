import { describeFailure } from './client-error-core.ts';
import { reportToServerLog } from './control-ws.ts';
import { el, queryTag } from './dom-helpers.ts';
import { createPressable } from './ui/pressable.ts';
import { FEATURE_SURFACE_RULES } from './feature-surfaces-core.ts';
import { activateFocusView, deactivateFocusView, mountFocusView, reopenFocusBoard } from './focus-view/focus-view.ts';
import { applyBenchmarkConnectionState } from './benchmark-store.ts';
import { setArenaNavigation } from './arena/race-store.ts';
import { applyIssuesConnectionState } from './github/issues-store.ts';
import { applyMyPrsConnectionState } from './github/my-prs-store.ts';
import { acknowledgeReviewQueueAttention, setReviewQueueActivityCallback, setReviewQueueNavigation } from './github/review-queue-store.ts';
import { acknowledgeRadarAttention, setRadarActivityCallback, setRadarTraceOpener } from './radar/radar-store.ts';
import { acknowledgeCommunityAttention, applyCommunityConnectionState, setCommunityActivityCallback } from './community/community-store.ts';
import { onDebugModeChanged } from './session-card/card-debug.ts';
import { setSettingsRestartHandler } from './settings/settings-store.ts';
import { applyTeamReviewConnectionState } from './github/team-review-store.ts';
import { applyTraceConnectionState, openTraceForSession } from './trace-store.ts';
import { setOpenInReview } from './whiteboard/board-store.ts';
import { BENCH_ICON_PATH, BOARDS_ICON_PATH, COMMUNITY_ICON_PATH, createLineIcon, FOCUS_ICON_PATH, ISSUES_ICON_PATH, RADAR_ICON_PATH, REVIEWS_ICON_PATH, SETTINGS_ICON_PATH, TRACE_ICON_PATH, USAGE_ICON_PATH } from './svg-dom.ts';
import { acknowledgeUsageAttention, applyUsageConnectionState, setUsageActivityCallback } from './usage/usage-store.ts';
import { packPanelModule, packTabIcon } from './packs/pack-views.ts';
import type { PackPanelView } from './packs/pack-views.ts';
import { createViewLoader, shouldReloadAfterPreloadError, viewAttentionState } from './view-registry-core.ts';
import type { PrimaryView, PrimaryViewDefinition, ViewAttention, ViewModule } from './view-registry-core.ts';

interface ViewRegistryActions {
  onRestart: () => void;
  openTerminal: (id: string) => void;
  openReviewFile: (id: string, openPath: string) => void;
  openReviews: () => boolean;
  setPhoneAttention: (view: string, attention: ViewAttention) => void;
}

export type DashboardView = PrimaryView<HTMLElement> & { tab: HTMLButtonElement };

const PRELOAD_RELOAD_KEY = 'glimmervoid:preload-error-reload-at';
const PRELOAD_RELOAD_WINDOW_MS = 30_000;
const PREFETCH_FALLBACK_DELAY_MS = 1000;

const viewLoader = createViewLoader<HTMLElement>();

export function showView(view: DashboardView, onShown: (module: ViewModule<HTMLElement>) => void): void {
  const mountedModule = viewLoader.mountedModuleOf(view.view);
  if (mountedModule) {
    onShown(mountedModule);
    return;
  }
  void viewLoader.show(view).then(onShown).catch((error: unknown) => {
    reportToServerLog('view', `${view.view} failed to show: ${describeFailure(error)}`);
    throw error;
  });
}

export function mountedViewModule(view: string): ViewModule<HTMLElement> | null {
  return viewLoader.mountedModuleOf(view);
}

export function mountEagerViews(views: readonly DashboardView[]): void {
  viewLoader.mountEagerViews(views);
}

export function prefetchViewsWhenIdle(views: readonly DashboardView[]): void {
  const prefetchAvailableViews = () => {
    void viewLoader.prefetch(views.filter((view) => !view.tab.hidden));
  };
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(prefetchAvailableViews);
    return;
  }
  setTimeout(prefetchAvailableViews, PREFETCH_FALLBACK_DELAY_MS);
}

function reloadOnceWithinWindow(storage: Storage): void {
  const nowMs = Date.now();
  if (!shouldReloadAfterPreloadError(storage.getItem(PRELOAD_RELOAD_KEY), nowMs, PRELOAD_RELOAD_WINDOW_MS)) return;
  storage.setItem(PRELOAD_RELOAD_KEY, String(nowMs));
  location.reload();
}

export function reloadOnceOnPreloadError(readStorage: () => Storage): void {
  window.addEventListener('vite:preloadError', () => reloadOnceWithinWindow(readStorage()));
}

export function reloadOnceIfBundleRetired(entryChunkUrl: string, readStorage: () => Storage): void {
  fetch(entryChunkUrl, { method: 'HEAD', cache: 'no-store' })
    .then((response) => {
      if (response.status !== 404) return;
      reloadOnceWithinWindow(readStorage());
    })
    .catch(() => {});
}

function buildDashboardView(definition: PrimaryViewDefinition<HTMLElement>, icon: Element, setPhoneAttention: ViewRegistryActions['setPhoneAttention']): DashboardView {
  const main = queryTag(document, '#app-main', 'main');
  const tab = createPressable('header-tab', definition.label);
  tab.prepend(icon);
  tab.id = `tab-${definition.view}`;
  tab.draggable = true;
  const panelId = `view-${definition.view}`;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', panelId);
  const isSelected = definition.view === 'focus';
  tab.setAttribute('aria-selected', String(isSelected));
  tab.tabIndex = isSelected ? 0 : -1;
  const panel = document.getElementById(panelId) ?? el('section');
  panel.classList.add(definition.panelClass);
  panel.id = panelId;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', tab.id);
  panel.hidden = true;
  if (!panel.parentElement) main.append(panel);
  tab.hidden = definition.gate !== undefined || definition.isPhoneOnly === true;
  panel.classList.toggle('view-panel', definition.hasPanelChrome !== false);
  if (definition.attention) {
    const dot = el('span', 'tab-activity');
    dot.id = `tab-${definition.view}-activity`;
    dot.setAttribute('aria-hidden', 'true');
    tab.append(dot);
    definition.attention.subscribe((attention) => {
      const { isActive, level } = viewAttentionState(attention);
      dot.classList.toggle('active', isActive);
      if (level === null) dot.removeAttribute('data-attention');
      if (level !== null) dot.setAttribute('data-attention', level);
      setPhoneAttention(definition.view, attention);
    });
  }
  return { ...definition, tab, el: panel };
}

function packViewIcon(panel: PackPanelView): Element {
  return panel.iconUrl ? packTabIcon(panel.iconUrl) : createLineIcon(BOARDS_ICON_PATH);
}

export function createPackView(panel: PackPanelView): DashboardView {
  return buildDashboardView({ view: panel.viewId, label: panel.label, iconPath: '', panelClass: 'pack-panel-view', hasPanelChrome: false, module: packPanelModule(panel) }, packViewIcon(panel), () => {});
}

export function relabelPackView(viewTab: DashboardView, panel: PackPanelView): void {
  viewTab.tab.replaceChildren(packViewIcon(panel), panel.label);
}

export function createDashboardViews(actions: ViewRegistryActions): DashboardView[] {
  setReviewQueueNavigation({ openTerminal: actions.openTerminal, openReviews: actions.openReviews });
  setArenaNavigation({ openTerminal: actions.openTerminal });
  setSettingsRestartHandler(actions.onRestart);
  setOpenInReview(actions.openReviewFile);
  const definitions: PrimaryViewDefinition<HTMLElement>[] = [
    { view: 'focus', label: 'Focus', iconPath: FOCUS_ICON_PATH, panelClass: 'focus-view', hasOwnPhoneScreen: true, hasPanelChrome: false, refreshOn: ['connected'], module: { mount: () => mountFocusView({ rail: document.getElementById('focus-rail'), center: document.getElementById('focus-center'), resizer: document.getElementById('focus-rail-resizer') }), activate: activateFocusView, deactivate: deactivateFocusView, refresh: reopenFocusBoard } },
    { view: 'prs', label: 'Reviews', iconPath: REVIEWS_ICON_PATH, panelClass: 'pr-view', gate: { fromSettings: FEATURE_SURFACE_RULES.teamReview }, load: () => import('./github/review-queue-panel.ts').then((panel) => panel.view), refreshOn: ['shown'], attention: { subscribe: setReviewQueueActivityCallback, acknowledge: acknowledgeReviewQueueAttention }, onConnectionChange: (isConnected) => {
      applyMyPrsConnectionState(isConnected);
      applyTeamReviewConnectionState(isConnected);
    } },
    { view: 'issues', label: 'Issues', iconPath: ISSUES_ICON_PATH, panelClass: 'issues-view', gate: { fromSettings: FEATURE_SURFACE_RULES.issues }, load: () => import('./github/issues-panel.ts').then((panel) => panel.view), refreshOn: ['shown'], onConnectionChange: applyIssuesConnectionState },
    { view: 'usage', label: 'Usage', iconPath: USAGE_ICON_PATH, panelClass: 'usage-view', gate: { fromSettings: FEATURE_SURFACE_RULES.usage }, load: () => import('./usage/usage-panel.ts').then((panel) => panel.view), attention: { subscribe: setUsageActivityCallback, acknowledge: acknowledgeUsageAttention }, onConnectionChange: applyUsageConnectionState, refreshOn: ['shown', 'connected', 'usage-sessions'] },
    { view: 'radar', label: 'Radar', iconPath: RADAR_ICON_PATH, panelClass: 'radar-view', gate: { fromSettings: FEATURE_SURFACE_RULES.posthog }, load: () => import('./radar/radar-panel.ts').then((panel) => panel.view), attention: { subscribe: setRadarActivityCallback, acknowledge: acknowledgeRadarAttention } },
    { view: 'community', label: 'Community', iconPath: COMMUNITY_ICON_PATH, panelClass: 'community-view', gate: { fromSettings: FEATURE_SURFACE_RULES.community }, load: () => import('./community/community-panel.ts').then((panel) => panel.view), refreshOn: ['shown'], attention: { subscribe: setCommunityActivityCallback, acknowledge: acknowledgeCommunityAttention }, onConnectionChange: applyCommunityConnectionState },
    { view: 'boards', label: 'Boards', iconPath: BOARDS_ICON_PATH, isPhoneNavScreen: true, isPhoneOnly: true, panelClass: 'boards-screen', hasPanelChrome: false, load: () => import('./whiteboard/boards-view.ts').then((panel) => panel.view), refreshOn: ['shown', 'connected'] },
    { view: 'trace', label: 'Trace', iconPath: TRACE_ICON_PATH, panelClass: 'trace-view', gate: { subscribe: onDebugModeChanged }, load: () => import('./trace-panel.ts').then((panel) => panel.view), refreshOn: ['shown'], onAvailabilityChange: (isAvailable) => setRadarTraceOpener(isAvailable ? openTraceForSession : null), onConnectionChange: applyTraceConnectionState },
    { view: 'benchmarks', label: 'Arena', iconPath: BENCH_ICON_PATH, panelClass: 'bench-view', load: () => import('./arena/arena-panel.ts').then((panel) => panel.view), onConnectionChange: applyBenchmarkConnectionState },
    { view: 'settings', label: 'Settings', iconPath: SETTINGS_ICON_PATH, panelClass: 'settings-view', hasPanelChrome: false, load: () => import('./settings/settings-panel.ts').then((panel) => panel.view), refreshOn: ['shown', 'connected', 'hooks-updated'] },
  ];

  const views = definitions.map((definition) => buildDashboardView(definition, createLineIcon(definition.iconPath), actions.setPhoneAttention));
  queryTag(document, '#header-tabs', 'div').replaceChildren(...views.map((view) => view.tab));
  return views;
}
