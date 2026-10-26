import { describeFailure } from './client-error-core.ts';
import { reportToServerLog } from './control-ws.ts';
import { el, queryTag } from './dom-helpers.ts';
import { FEATURE_SURFACE_RULES } from './feature-surfaces-core.ts';
import { activateFocusView, deactivateFocusView, mountFocusView } from './focus-view/focus-view.ts';
import { activateZenView, deactivateZenView, mountZenView } from './zen-view/zen-view.ts';
import { applyBenchmarkConnectionState } from './benchmark-store.ts';
import { applyIssuesConnectionState } from './github/issues-store.ts';
import { applyMyPrsConnectionState } from './github/my-prs-store.ts';
import { acknowledgeReviewQueueAttention, setReviewQueueActivityCallback, setReviewQueueNavigation } from './github/review-queue-store.ts';
import { acknowledgeRadarAttention, setRadarActivityCallback, setRadarTraceOpener } from './radar/radar-store.ts';
import { onDebugModeChanged } from './session-card/card-dom.ts';
import { setSettingsRestartHandler } from './settings/settings-store.ts';
import { applyTeamReviewConnectionState } from './github/team-review-store.ts';
import { applyTraceConnectionState, openTraceForSession } from './trace-store.ts';
import { acknowledgeUsageAttention, applyUsageConnectionState, setUsageActivityCallback } from './usage/usage-store.ts';
import { acknowledgeVisionsAttention, applyVisionsConnectionState, setVisionsActivityCallback } from './visions/visions-store.ts';
import { createViewLoader, shouldReloadAfterPreloadError, viewAttentionState } from './view-registry-core.ts';
import type { PrimaryView, PrimaryViewDefinition, ViewAttention, ViewModule } from './view-registry-core.ts';

interface ViewRegistryActions {
  onRestart: () => void;
  openTerminal: (id: string) => void;
  openPlan: (id: string) => void;
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

export function reloadOnceOnPreloadError(readStorage: () => Storage): void {
  window.addEventListener('vite:preloadError', () => {
    const storage = readStorage();
    const nowMs = Date.now();
    if (!shouldReloadAfterPreloadError(storage.getItem(PRELOAD_RELOAD_KEY), nowMs, PRELOAD_RELOAD_WINDOW_MS)) return;
    storage.setItem(PRELOAD_RELOAD_KEY, String(nowMs));
    location.reload();
  });
}

export function createDashboardViews(actions: ViewRegistryActions): DashboardView[] {
  setReviewQueueNavigation({ openTerminal: actions.openTerminal, openReviews: actions.openReviews });
  setSettingsRestartHandler(actions.onRestart);
  const definitions: PrimaryViewDefinition<HTMLElement>[] = [
    { view: 'focus', label: 'Focus', panelClass: 'focus-view', hasOwnPhoneScreen: true, hasPanelChrome: false, hasReviewSidebar: true, module: { mount: () => mountFocusView({ rail: document.getElementById('focus-rail'), center: document.getElementById('focus-center'), resizer: document.getElementById('focus-rail-resizer') }), activate: activateFocusView, deactivate: deactivateFocusView } },
    { view: 'zen', label: 'Zen', panelClass: 'zen-view', hasOwnPhoneScreen: true, hasPanelChrome: false, gate: { fromSettings: FEATURE_SURFACE_RULES.zenView }, module: { mount: mountZenView, activate: activateZenView, deactivate: deactivateZenView } },
    { view: 'prs', label: 'Reviews', glyph: '\u21c5', panelClass: 'pr-view', gate: { fromSettings: FEATURE_SURFACE_RULES.teamReview }, load: () => import('./github/review-queue-panel.ts').then((panel) => panel.view), attention: { subscribe: setReviewQueueActivityCallback, acknowledge: acknowledgeReviewQueueAttention }, onConnectionChange: (isConnected) => {
      applyMyPrsConnectionState(isConnected);
      applyTeamReviewConnectionState(isConnected);
    } },
    { view: 'issues', label: 'Issues', glyph: '#', panelClass: 'issues-view', load: () => import('./github/issues-panel.ts').then((panel) => panel.view), refreshOn: ['shown'], onConnectionChange: applyIssuesConnectionState },
    { view: 'usage', label: 'Usage', glyph: '\u25d4', panelClass: 'usage-view', gate: { fromSettings: FEATURE_SURFACE_RULES.usage }, load: () => import('./usage/usage-panel.ts').then((panel) => panel.view), attention: { subscribe: setUsageActivityCallback, acknowledge: acknowledgeUsageAttention }, onConnectionChange: applyUsageConnectionState, refreshOn: ['shown', 'connected', 'usage-sessions'] },
    { view: 'radar', label: 'Radar', glyph: '\u25ce', panelClass: 'radar-view', gate: { fromSettings: FEATURE_SURFACE_RULES.posthog }, load: () => import('./radar/radar-panel.ts').then((panel) => panel.view), attention: { subscribe: setRadarActivityCallback, acknowledge: acknowledgeRadarAttention } },
    { view: 'visions', label: 'Visions', glyph: '\u25c7', panelClass: 'visions-view', gate: { fromSettings: FEATURE_SURFACE_RULES.visions }, load: () => import('./visions/visions-panel.ts').then((panel) => panel.view), attention: { subscribe: setVisionsActivityCallback, acknowledge: acknowledgeVisionsAttention }, refreshOn: ['shown'], onConnectionChange: applyVisionsConnectionState },
    { view: 'hooks', label: 'Hooks', glyph: '\u25c8', panelClass: 'hooks-view', load: () => import('./hooks-panel.ts').then((panel) => panel.view), refreshOn: ['shown', 'connected', 'hooks-updated'] },
    { view: 'trace', label: 'Trace', panelClass: 'trace-view', gate: { subscribe: onDebugModeChanged }, load: () => import('./trace-panel.ts').then((panel) => panel.view), refreshOn: ['shown'], onAvailabilityChange: (isAvailable) => setRadarTraceOpener(isAvailable ? openTraceForSession : null), onConnectionChange: applyTraceConnectionState },
    { view: 'benchmarks', label: 'Bench', panelClass: 'bench-view', gate: { fromSettings: FEATURE_SURFACE_RULES.benchmarks }, load: () => import('./benchmark-panel.ts').then((panel) => panel.view), onConnectionChange: applyBenchmarkConnectionState },
    { view: 'settings', label: 'Settings', glyph: '@', panelClass: 'settings-view', hasPanelChrome: false, load: () => import('./settings/settings-panel.ts').then((panel) => panel.view) },
  ];

  const main = queryTag(document, '#app-main', 'main');
  const views = definitions.map((definition) => {
    const tab = el('button', 'header-tab', definition.label);
    tab.id = `tab-${definition.view}`;
    tab.type = 'button';
    tab.draggable = true;
    const panelId = `view-${definition.view}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panelId);
    const isSelected = definition.view === 'focus';
    tab.setAttribute('aria-selected', String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
    if (definition.glyph) tab.dataset.phoneGlyph = definition.glyph;
    const panel = document.getElementById(panelId) ?? el('section');
    panel.classList.add(definition.panelClass);
    panel.id = panelId;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.hidden = true;
    if (!panel.parentElement) main.append(panel);
    tab.hidden = definition.gate !== undefined;
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
        actions.setPhoneAttention(definition.view, attention);
      });
    }
    return { ...definition, tab, el: panel };
  });
  queryTag(document, '#header-tabs', 'div').replaceChildren(...views.map((view) => view.tab));
  return views;
}
